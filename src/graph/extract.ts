/**
 * Tier-1 extraction: source file â†’ {@link NodeV1}[] + raw edges, via tree-sitter.
 *
 * Deterministic and dependency-only (no LLM, no network). Emits one node per
 * definition (file, class, function, method, interface, type, enum, and TS
 * arrow-function consts) plus unresolved edge intents. Edge *targets* are
 * resolved against the whole-repo node index later, in build.ts.
 */
import { basename } from "node:path";
import { contentHash } from "../util/id.js";
import { collectBindings, goReceiverVarOf, resolveRecvType, type FileBindings } from "./bindings.js";
import { depthReady, parseDepth, type SyntaxNode } from "./depth-parser.js";
import { grammarAvailable } from "./native.js";
import { extractSimulink } from "./simulink.js";
import { isTresosTemplate, tresosViews } from "./tresos.js";
import { erbView, isErbTemplate } from "./erb.js";
// The fork's optional grammars always parse native (depth-parser.ts backendOf), so their extractors take the full node API.
import type Parser from "tree-sitter";
import type { Kind, NodeV1, Relation } from "./types.js";

export { grammarAvailable, grammarSourceOf, optionalGrammarPackages } from "./native.js";

/** Depth-tier languages with a hand-written extractor. The first ones ship as
 * core dependencies; the rest (`c_sharp`â€¦`razor`) are OPTIONAL, locally-built
 * native grammars â€” claimed only when their binding loads (see {@link grammarAvailable}). */
export type Language =
  | "typescript"
  | "tsx"
  | "python"
  | "go"
  | "java"
  | "kotlin"
  | "swift"
  | "php"
  | "r"
  | "c_sharp"
  | "groovy"
  | "plsql"
  | "css"
  | "html"
  | "razor"
  | "xml"
  | "c"
  | "cpp"
  | "json"
  | "yaml"
  | "markdown"
  | "scss"
  | "csv"
  | "cmake"
  | "bash"
  | "perl"
  | "make"
  | "matlab"
  | "simulink";

/** The active SQL dialect, or null when no SQL grammar is built. Only Oracle
 * PL/SQL is wired today, so this is "plsql" exactly when that grammar loads. */
export function sqlDialect(): "plsql" | null {
  return grammarAvailable("plsql") ? "plsql" : null;
}

/** Whether a SQL grammar (Oracle PL/SQL today) is built â€” the `.sql`/DDL tests
 * skip when it isn't. Alias of {@link sqlDialect} as a boolean. */
export function sqlGrammarAvailable(): boolean {
  return sqlDialect() !== null;
}

/**
 * Extension â†’ the tree-sitter grammar that parses it, and the label a human expects
 * to see for it.
 *
 * The two are not the same, and conflating them under-reported coverage: `.mjs` is
 * parsed by the typescript grammar, so a JS repo's build banner read `[typescript]`
 * and a `.jsx` one read `[tsx]`. Both are true about the *parser* and misleading
 * about the repo â€” people went looking for why their JavaScript hadn't been indexed
 * when it had, and could not tell a language that was merely unlabelled from one
 * that really was skipped (see issue #36).
 *
 * One table, both readings derived from it, so adding an extension cannot fix
 * extraction and forget the label. Ordered longest-suffix-first: `.tsx` has to be
 * tested before `.ts` would match it.
 */
const EXTENSIONS: ReadonlyArray<{ ext: string; grammar: Language; label: string }> = [
  { ext: ".tsx", grammar: "tsx", label: "tsx" },
  { ext: ".jsx", grammar: "tsx", label: "jsx" },
  { ext: ".mts", grammar: "typescript", label: "typescript" },
  { ext: ".cts", grammar: "typescript", label: "typescript" },
  { ext: ".ts", grammar: "typescript", label: "typescript" },
  { ext: ".mjs", grammar: "typescript", label: "javascript" },
  { ext: ".cjs", grammar: "typescript", label: "javascript" },
  { ext: ".js", grammar: "typescript", label: "javascript" },
  { ext: ".pyi", grammar: "python", label: "python" },
  { ext: ".py", grammar: "python", label: "python" },
  { ext: ".go", grammar: "go", label: "go" },
  { ext: ".java", grammar: "java", label: "java" },
  { ext: ".kt", grammar: "kotlin", label: "kotlin" },
  { ext: ".kts", grammar: "kotlin", label: "kotlin" },
  { ext: ".swift", grammar: "swift", label: "swift" },
  { ext: ".php", grammar: "php", label: "php" },
  // `entryFor` lower-cases the path before matching, so this one entry covers
  // both `.R` (the conventional case in real R codebases) and `.r`.
  { ext: ".r", grammar: "r", label: "r" },
  // Simulink models and data dictionaries: ZIP packages of XML (a dictionary may also
  // be saved as JSON text). No tree-sitter grammar: readSourceFile unpacks them and
  // simulink.ts reads the parts, so they are always claimed.
  { ext: ".slx", grammar: "simulink", label: "simulink" },
  { ext: ".sldd", grammar: "simulink", label: "simulink" },
  // A model in the text format: the classic `Model { … }` file, or a text package of
  // the same XML/JSON parts an `.slx` holds. Other tools' binary `.mdl` files are
  // skipped by readSourceFile; their text ones are file nodes.
  { ext: ".mdl", grammar: "simulink", label: "simulink" },
];

/** Extensions handled by an OPTIONAL depth grammar. Claimed only when that
 * grammar's binding loads (see {@link grammarAvailable}); otherwise the file
 * falls through to the breadth tier (e.g. `.cs` via the WASM `c_sharp` grammar)
 * or, for markup with no breadth grammar, to a file-only node. Ordered
 * longest-suffix-first, like {@link EXTENSIONS}. */
const OPTIONAL_EXTENSIONS: ReadonlyArray<{ ext: string; grammar: Language; label: string }> = [
  { ext: ".cs", grammar: "c_sharp", label: "c#" },
  { ext: ".groovy", grammar: "groovy", label: "groovy" },
  { ext: ".gradle", grammar: "groovy", label: "groovy" },
  { ext: ".pks", grammar: "plsql", label: "sql" },
  { ext: ".pkb", grammar: "plsql", label: "sql" },
  { ext: ".plsql", grammar: "plsql", label: "sql" },
  { ext: ".sql", grammar: "plsql", label: "sql" },
  { ext: ".cshtml", grammar: "razor", label: "razor" },
  { ext: ".razor", grammar: "razor", label: "razor" },
  { ext: ".css", grammar: "css", label: "css" },
  { ext: ".html", grammar: "html", label: "html" },
  { ext: ".htm", grammar: "html", label: "html" },
  { ext: ".xml", grammar: "xml", label: "xml" },
  // .NET config: Web.config / App.config / packages.config all end in `.config`.
  { ext: ".config", grammar: "xml", label: "xml" },
  { ext: ".csproj", grammar: "xml", label: "xml" },
  { ext: ".vbproj", grammar: "xml", label: "xml" },
  { ext: ".fsproj", grammar: "xml", label: "xml" },
  { ext: ".props", grammar: "xml", label: "xml" },
  { ext: ".targets", grammar: "xml", label: "xml" },
  { ext: ".nuspec", grammar: "xml", label: "xml" },
  { ext: ".resx", grammar: "xml", label: "xml" },
  // XAML is XML; parsed by the same grammar but labelled distinctly.
  { ext: ".xaml", grammar: "xml", label: "xaml" },
  // C / C++ depth (also carried by the breadth tier; depth wins when built).
  { ext: ".c", grammar: "c", label: "c" },
  { ext: ".cpp", grammar: "cpp", label: "cpp" },
  { ext: ".cc", grammar: "cpp", label: "cpp" },
  { ext: ".cxx", grammar: "cpp", label: "cpp" },
  { ext: ".hpp", grammar: "cpp", label: "cpp" },
  { ext: ".hh", grammar: "cpp", label: "cpp" },
  { ext: ".hxx", grammar: "cpp", label: "cpp" },
  // `.h` is claimed by C (the breadth tier does the same); a C++-only header set
  // that uses `.h` is the known ambiguity C tooling also lives with.
  { ext: ".h", grammar: "c", label: "c" },
  // Data / markup â€” breadth-level symbols.
  { ext: ".json", grammar: "json", label: "json" },
  { ext: ".yaml", grammar: "yaml", label: "yaml" },
  { ext: ".yml", grammar: "yaml", label: "yaml" },
  { ext: ".markdown", grammar: "markdown", label: "markdown" },
  { ext: ".md", grammar: "markdown", label: "markdown" },
  { ext: ".scss", grammar: "scss", label: "scss" },
  { ext: ".csv", grammar: "csv", label: "csv" },
  // CMake: `*.cmake` modules, and the build files themselves, which are claimed by
  // their exact NAME (an entry without a leading dot matches a basename, see entryFor)
  // so no other `.txt` file is ever taken for CMake.
  { ext: ".cmake", grammar: "cmake", label: "cmake" },
  { ext: "CMakeLists.txt", grammar: "cmake", label: "cmake" },
  // Shell: bash scripts and the bash start-up files. `.zsh`/`.ksh`/`.csh` are other
  // shells' dialects and stay unclaimed.
  { ext: ".bash_profile", grammar: "bash", label: "bash" },
  { ext: ".bashrc", grammar: "bash", label: "bash" },
  { ext: ".bash", grammar: "bash", label: "bash" },
  { ext: ".sh", grammar: "bash", label: "bash" },
  // Perl: scripts, modules and test files (`.t`, the Test::More convention).
  { ext: ".pl", grammar: "perl", label: "perl" },
  { ext: ".pm", grammar: "perl", label: "perl" },
  { ext: ".t", grammar: "perl", label: "perl" },
  // Make: the makefiles by NAME (`Makefile`, `makefile`, `GNUmakefile`; matched
  // case-insensitively) and included fragments by extension. Automake's
  // `Makefile.am` / `Makefile.in` are a different syntax and stay unclaimed.
  { ext: "GNUmakefile", grammar: "make", label: "make" },
  { ext: "Makefile", grammar: "make", label: "make" },
  { ext: ".mk", grammar: "make", label: "make" },
  { ext: ".mak", grammar: "make", label: "make" },
  // MATLAB: scripts, function files and classdef files. Objective-C also uses `.m`;
  // extractFile recognises those files and keeps them as file nodes only. Simulink
  // models and dictionaries are core entries above.
  { ext: ".m", grammar: "matlab", label: "matlab" },
  // Live scripts and functions saved in the binary format: readSourceFile turns the
  // package into MATLAB source (code as written, prose as comments).
  { ext: ".mlx", grammar: "matlab", label: "matlab" },
];

/** Whether `lowerPath` is claimed by an extension-table entry: a suffix match for an
 * extension (`.ts`), a case-insensitive basename match for a file name
 * (`CMakeLists.txt`), on either path separator. */
function claims(lowerPath: string, ext: string): boolean {
  if (ext.startsWith(".")) return lowerPath.endsWith(ext);
  const name = ext.toLowerCase();
  return lowerPath === name || lowerPath.endsWith(`/${name}`) || lowerPath.endsWith(`\\${name}`);
}

function entryFor(path: string): { ext: string; grammar: Language; label: string } | undefined {
  const p = path.toLowerCase();
  const core = EXTENSIONS.find((e) => claims(p, e.ext));
  if (core) return core;
  const opt = OPTIONAL_EXTENSIONS.find((e) => claims(p, e.ext));
  return opt && grammarAvailable(opt.grammar) ? opt : undefined;
}

/** The depth tier's whole extension table â€” core entries, then the optional ones
 * whether or not their grammar is built â€” for listings (`graft languages`) that have
 * to say what an optional grammar would add. Extraction never reads this. */
export function depthRegistry(): ReadonlyArray<{ ext: string; grammar: Language; label: string; optional: boolean }> {
  return [
    ...EXTENSIONS.map((e) => ({ ...e, optional: false })),
    ...OPTIONAL_EXTENSIONS.map((e) => ({ ...e, optional: true })),
  ];
}

/** Every file extension a depth-tier (hand-written) extractor claims â€” the core
 * grammars always, plus any optional grammar whose binding is currently built. */
export function depthExtensions(): string[] {
  return [...EXTENSIONS.map((e) => e.ext), ...OPTIONAL_EXTENSIONS.filter((e) => grammarAvailable(e.grammar)).map((e) => e.ext)];
}

/** Map a file path to a supported language, or null if unsupported. */
export function languageOf(path: string): Language | null {
  return entryFor(path)?.grammar ?? null;
}

/**
 * What to *call* the language of this file, for a banner or a repo map â€” or null when
 * the file isn't indexed at all, which is the distinction {@link languageOf} shares
 * and the one that matters to a reader checking coverage.
 *
 * Extension-only, so it cannot see through an ambiguous extension: prefer
 * {@link languageLabelOfSource} wherever the file's text is already in hand.
 */
export function languageLabelOf(path: string): string | null {
  return entryFor(path)?.label ?? null;
}

/**
 * Extension routing is a guess wherever two languages share an extension, and `.h`
 * is the case that bites: a C++-only header set uses it, and the C grammar cannot
 * parse a class or a template. Content decides.
 *
 * The extractor and the build banner both read that decision HERE, from one
 * function, because they used to decide separately: the sniff lived inside
 * `extractFile`, so a C++ `.h` extracted correctly as C++ while the banner â€” which
 * only ever looked at the extension â€” still reported the repo as containing `c`.
 *
 * Returns the override, or undefined to keep the extension's own entry. Requires
 * the override's grammar to actually be built; without that guard a repo with the
 * C grammar but not the C++ one would route these headers to a grammar that isn't
 * there and get a symbol-less file node, where parsing them as C at least recovers
 * the plain-C declarations.
 */
function contentOverride(
  path: string,
  grammar: Language,
  source: string,
): { grammar: Language; label: string } | undefined {
  if (grammar === "c" && /\.h$/i.test(path) && looksLikeCpp(source) && grammarAvailable("cpp"))
    return { grammar: "cpp", label: "cpp" };
  // `.config` is XML for .NET (Web.config, App.config), but other tools write JSON
  // under the same extension (pure::variants, Asgard). An XML document starts with
  // `<` after an optional BOM and whitespace, so an object or array start is JSON.
  if (grammar === "xml" && /\.config$/i.test(path) && /^\uFEFF?\s*[{[]/.test(source))
    return { grammar: "json", label: "json" };
  return undefined;
}

/** {@link languageOf}, refined by the file's content where the extension is
 * ambiguous â€” the grammar that will really parse it. */
export function languageOfSource(path: string, source: string): Language | null {
  const entry = entryFor(path);
  if (!entry) return null;
  return (contentOverride(path, entry.grammar, source) ?? entry).grammar;
}

/** {@link languageLabelOf}, refined by content exactly as {@link languageOfSource}
 * is, so a banner names the language that actually parsed the file. */
export function languageLabelOfSource(path: string, source: string): string | null {
  const entry = entryFor(path);
  if (!entry) return null;
  return (contentOverride(path, entry.grammar, source) ?? entry).label;
}

/**
 * An edge whose target isn't resolved yet. build.ts turns these into EdgeV1 by
 * matching `name`/`specifier` against the repo-wide node index.
 */
export interface RawEdge {
  source: string; // resolved node id
  relation: Relation;
  file: string; // the file this edge originates in (scopes name resolution)
  targetId?: string; // already-resolved target (contains)
  specifier?: string; // module path to resolve (imports / imported-symbol references / Gleam calls)
  name?: string; // symbol name to resolve (extends/implements/calls)
  viaMember?: boolean; // calls: was it `obj.foo()` (â†’ prefer method targets)?
  /** calls with viaMember: the receiver's resolved type name (from bindings /
   * self / this / Go receiver), when a confident local clue exists. */
  recvType?: string;
  /** calls without viaMember: which kinds the bare-name match may resolve to.
   * Every other language's bare-name call is always a free function, so this
   * is absent for them (resolve.ts defaults to `["function"]`). R (Phase 4) is
   * the one exception: `obj$method()` with an untyped receiver (not
   * self/private/super, which already resolve precisely via viaMember+recvType)
   * still has a real shot at a correct match if the method name happens to be
   * uniquely defined across the repo â€” R6 methods are kind "method", not
   * "function", so without this override every such call would be
   * unconditionally unresolvable rather than just occasionally ambiguous. */
  kinds?: Kind[];
  /** calls: the number of arguments at the CALL SITE. Only emitted for languages
   * with overloading (Java, Swift), where a same-named sibling on the same class is
   * otherwise indistinguishable â€” and picking wrong turns a delegating overload
   * into a self-loop. */
  argCount?: number;
  /** Swift only: a bare lowercase call inside a type body, which the language
   * resolves member-first (inner scope wins). The edge carries the member
   * reading (viaMember + recvType = the enclosing type); this flag lets
   * resolve.ts fall back to the free-function reading when the owner chain has
   * no such member â€” and ONLY then, so a name defined as both a member and a
   * free function yields the member edge alone, exactly as Swift dispatches it. */
  implicitSelf?: boolean;
}

export interface ExtractResult {
  nodes: NodeV1[];
  rawEdges: RawEdge[];
}

/** Max chars of normalized body stored per symbol for search. Large enough that
 * essentially every real definition is stored whole â€” only a rare giant function
 * is clipped â€” while bounding how much the committed graph can grow. */
const MAX_BODY_CHARS = 5000;

/** Cap for a file node's module-level residual (imports, constants, module
 * docstring â€” everything not inside a symbol). Higher than the per-symbol cap
 * because a data-heavy module (constant tables, big config dicts) is legitimate
 * residual, and it's the recall play â€” but still bounded. */
const MAX_FILE_BODY_CHARS = 16000;

/** The searchable body of a definition: its source text, whitespace-collapsed
 * so every identifier becomes a token, capped at `max`. Search-only â€” the agent
 * still reads verbatim source via `ask --source`, which slices the file from
 * disk, so nothing here reaches the agent's context. */
export function searchBody(text: string, max = MAX_BODY_CHARS): string {
  const norm = text.replace(/\s+/g, " ").trim();
  return norm.length > max ? norm.slice(0, max) : norm;
}

/** A file's module-level residual: the lines NOT covered by any symbol span.
 * Symbol bodies are already indexed on their own nodes, so this captures only
 * what they miss â€” top-of-file imports, module constants, module docstrings â€”
 * making a file findable by a term that lives outside every function/class.
 * `symbols` are the file's emitted nodes (with `Lx-Ly` spans); `source` is the
 * whole file. Far leaner than storing full-file bodies (no symbol duplication). */
function fileResidual(source: string, symbols: NodeV1[]): string {
  const lines = source.split("\n");
  const covered = new Uint8Array(lines.length + 2);
  for (const s of symbols) {
    const m = s.span.match(/^L(\d+)-L(\d+)$/);
    if (!m) continue;
    for (let r = Number(m[1]); r <= Number(m[2]) && r < covered.length; r++) covered[r] = 1;
  }
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) if (!covered[i + 1]) kept.push(lines[i]);
  return searchBody(kept.join(" "), MAX_FILE_BODY_CHARS);
}

const TS_KINDS: Record<string, Kind> = {
  class_declaration: "class",
  abstract_class_declaration: "class",
  function_declaration: "function",
  generator_function_declaration: "function",
  method_definition: "method",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
};

const PY_KINDS: Record<string, Kind> = {
  class_definition: "class",
  function_definition: "function", // â†’ "method" inside a class (resolved in the walk)
};

// Go: `type_spec` is intentionally absent â€” its kind (struct/interface/type) depends on
// the named type's shape, so it's resolved dynamically in describe().
const GO_KINDS: Record<string, Kind> = {
  function_declaration: "function",
  method_declaration: "method",
};

// R: `function_definition` carries no name field at all (unlike every other
// supported language) â€” its identifier always comes from context (an
// assignment's other side), resolved dynamically in describeR(). Empty, like
// Go's own table â€” never consulted, kept only to satisfy KINDS_BY_LANG's type.
const R_KINDS: Record<string, Kind> = {};
// Java: a record is a nominal data carrier, so it takes "struct" â€” the same role
// Go's struct plays â€” rather than "class", which would make a service and a DTO
// indistinguishable in a repo where DTOs are most of the type surface.
const JAVA_KINDS: Record<string, Kind> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "struct",
  annotation_type_declaration: "interface",
  annotation_type_element_declaration: "method",
  method_declaration: "method",
  constructor_declaration: "method",
};

/** Java type declarations: they set `enclosingClass` for the methods nested in them,
 * which "class"-only logic would miss for a record's or interface's members. */
const JAVA_TYPE_KINDS: ReadonlySet<Kind> = new Set<Kind>(["class", "interface", "enum", "struct"]);

const KOTLIN_KINDS: Record<string, Kind> = {
  class_declaration: "class", // â†’ "interface" / "enum" / "interface" (annotation) in describeKotlin
  object_declaration: "class", // a singleton object is class-like (companion objects included)
  function_declaration: "function", // â†’ "method" inside a type (resolved in the walk)
  secondary_constructor: "method", // the class's own secondary constructor
  type_alias: "type",
  property_declaration: "variable", // top-level `val`/`var` only (fields resolved in the walk)
};

/** Kotlin type declarations: they set `enclosingClass` for the members nested in them.
 * "class" also covers object_declaration (it maps to "class"); interface/enum are the
 * same class_declaration node rekinded in describeKotlin, so all three land in the set. */
const KOTLIN_TYPE_KINDS: ReadonlySet<Kind> = new Set<Kind>(["class", "interface", "enum"]);

const SWIFT_KINDS: Record<string, Kind> = {
  class_declaration: "class", // â†’ "struct" / "enum" in describeSwift (one node type covers all five keywords)
  protocol_declaration: "interface",
  function_declaration: "function", // â†’ "method" inside a type (resolved in the walk)
  protocol_function_declaration: "method", // a protocol requirement is always a member
  init_declaration: "method", // the type's own initializer (named after it, like a Java constructor)
  typealias_declaration: "type",
  property_declaration: "variable", // top-level `let`/`var` only (fields resolved in the walk)
};

/** Swift type declarations: they set `enclosingClass` for the members nested in them.
 * class/struct/enum are the same class_declaration node rekinded in describeSwift
 * (an actor takes "class"); protocols are "interface". "module" is an extension
 * body â€” a member-contributing scope named after the extended type, deliberately
 * NOT a type kind in the graph so it can never make the real declaration's name
 * ambiguous (see describeSwift's extension branch) â€” but its members still
 * promote to methods owned by that type, which is why it belongs in this set. */
const SWIFT_TYPE_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  "class",
  "struct",
  "enum",
  "interface",
  "module",
]);

// PHP: definition node types are all distinct (no py-style functionâ†’method
// promotion needed â€” a class body uses `method_declaration`, not
// `function_definition`). `trait_declaration` maps to the PHP-only `trait` kind.
const PHP_KINDS: Record<string, Kind> = {
  function_definition: "function",
  method_declaration: "method",
  class_declaration: "class",
  interface_declaration: "interface",
  trait_declaration: "trait",
  enum_declaration: "enum",
};

// C#: namespace declarations are intentionally absent â€” they're not scope
// segments (ids stay bare, `File.cs#Class.Method`), so the walk recurses through
// them. A record maps to "class": it is a nominal reference type, not the
// data-carrier role Go/Java give "struct". A constructor is a method named after
// its type; a property is surfaced as a "variable" (its accessor body is opaque).
const CSHARP_KINDS: Record<string, Kind> = {
  class_declaration: "class",
  interface_declaration: "interface",
  struct_declaration: "struct",
  record_declaration: "class",
  record_struct_declaration: "struct",
  enum_declaration: "enum",
  method_declaration: "method",
  constructor_declaration: "method",
  property_declaration: "variable",
};

// Groovy: the grammar is loose â€” a class body is a `closure`, a method is a
// `function_definition` whose name is in the `function` field (not `name`), so
// definitions are recognised by describeGroovy rather than this map. Kept only
// so KINDS_BY_LANG is total over Language.
const GROOVY_KINDS: Record<string, Kind> = {
  class_definition: "class",
  function_definition: "function",
  function_declaration: "function",
};

// PL/SQL: a package spec/body is a module of sub-programs; procedures and
// functions are distinct kinds; a CREATE TABLE is a table. The name lives in a
// role-specific field (package_name / prc_name / fnc_name), so describePlSql is
// custom â€” this map only drives the kind and CALL lookups.
const PLSQL_KINDS: Record<string, Kind> = {
  create_package: "package",
  create_package_body: "package",
  create_procedure: "procedure",
  create_function: "function",
  procedure_declaration: "procedure",
  procedure_definition: "procedure",
  function_declaration: "function",
  function_definition: "function",
  create_table: "table",
  create_view: "view",
};

// C: functions and named aggregate types. The name isn't a `name` field for a
// function (it hides under the declarator), so describeC reads it specially.
const C_KINDS: Record<string, Kind> = {
  function_definition: "function",
  // A macro that opens a function body (`COU_TEST(Case_001, "Init") { … }`,
  // `IFX_INTERRUPT(Isr, 0, Prio) { … }`), as the fork's tree-sitter-c parses it.
  macro_function_definition: "function",
  struct_specifier: "struct",
  union_specifier: "struct",
  enum_specifier: "enum",
  type_definition: "type",
};

// C++: adds classes and methods. A `function_definition` is a free function, or a
// method when its declarator is a `Class::name` qualified_identifier (out-of-line
// definition); namespaces are transparent to scope. describeCpp handles both.
const CPP_KINDS: Record<string, Kind> = {
  function_definition: "function",
  class_specifier: "class",
  struct_specifier: "struct",
  union_specifier: "struct",
  enum_specifier: "enum",
};


const KINDS_BY_LANG: Record<Language, Record<string, Kind>> = {
  typescript: TS_KINDS,
  tsx: TS_KINDS,
  python: PY_KINDS,
  go: GO_KINDS,
  r: R_KINDS,
  java: JAVA_KINDS,
  kotlin: KOTLIN_KINDS,
  swift: SWIFT_KINDS,
  php: PHP_KINDS,
  c_sharp: CSHARP_KINDS,
  groovy: GROOVY_KINDS,
  plsql: PLSQL_KINDS,
  css: {},
  html: {},
  razor: {},
  xml: {},
  c: C_KINDS,
  cpp: CPP_KINDS,
  json: {},
  yaml: {},
  markdown: {},
  scss: {},
  csv: {},
  cmake: {},
  bash: {},
  perl: {},
  make: {},
  matlab: {},
  simulink: {},
};

/**
 * The node type(s) that constitute a call site, per language.
 *
 * Java is the reason this is a set rather than a string: `method_invocation` and
 * `object_creation_expression` (`new Foo()`) are separate node types, and a Java
 * codebase's constructor calls are a large share of its real edges. PHP is
 * likewise multi-shape: a call is a function / member / nullsafe-member / scoped
 * call, never a single `call_expression`.
 */
const CALL_TYPES: Record<Language, ReadonlySet<string>> = {
  typescript: new Set(["call_expression"]),
  tsx: new Set(["call_expression"]),
  python: new Set(["call"]),
  go: new Set(["call_expression"]),
  java: new Set(["method_invocation", "object_creation_expression"]),
  kotlin: new Set(["call_expression"]),
  swift: new Set(["call_expression"]),
  php: new Set([
    "function_call_expression",
    "member_call_expression",
    "nullsafe_member_call_expression",
    "scoped_call_expression",
  ]),
  r: new Set(["call"]),
  // C#: `f()` (invocation) and `new T()` (object creation), mirroring Java.
  c_sharp: new Set(["invocation_expression", "object_creation_expression"]),
  // Groovy: `foo(...)` / `obj.foo(...)` are both `function_call`. A call whose only
  // argument is a trailing closure is written without parens â€” `items.collect { it.name }`,
  // `items.each { â€¦ }`, and every bare Jenkins step â€” and parses as `juxt_function_call`.
  // It carries the same `function` field shape, so groovyCallee reads it unchanged; leaving
  // it out drops over half the call edges in closure-heavy Groovy and Jenkinsfiles.
  groovy: new Set(["function_call", "juxt_function_call"]),
  // PL/SQL: a sub-program call is a `ref_call` (a referenced_element with args),
  // or â€” for a procedure called without arguments (`log_it;`) â€” a `statement`
  // holding nothing but a referenced_element. plsqlCallee tells them apart.
  plsql: new Set(["ref_call", "statement"]),
  // Markup/style languages have no call graph â€” extracted by custom walkers.
  css: new Set<string>(),
  html: new Set<string>(),
  razor: new Set<string>(),
  xml: new Set<string>(),
  // C/C++: a call is a `call_expression`.
  c: new Set(["call_expression"]),
  cpp: new Set(["call_expression"]),
  // Data/markup: no call graph (SCSS @include edges are emitted by its extractor).
  json: new Set<string>(),
  yaml: new Set<string>(),
  markdown: new Set<string>(),
  scss: new Set<string>(),
  csv: new Set<string>(),
  // CMake: every command is a `normal_command`; extractCmake emits its call edges.
  cmake: new Set<string>(),
  // Bash and Perl: their own walkers (extractBash / extractPerl) emit the call edges.
  bash: new Set<string>(),
  perl: new Set<string>(),
  make: new Set<string>(),
  // MATLAB: extractMatlab emits the call edges (calls, command syntax, handles).
  matlab: new Set<string>(),
  // Simulink: simulink.ts emits its edges (model references, chart code).
  simulink: new Set<string>(),
};

const FUNCTION_VALUE_TYPES = new Set([
  "arrow_function",
  "function",
  "function_expression",
  "generator_function",
]);

const EMPTY_SET: ReadonlySet<string> = new Set();

export interface WalkCtx {
  rel: string;
  source: string;
  lang: Language;
  kinds: Record<string, Kind>;
  scope: string[]; // enclosing definition names, for id scoping
  enclosingKind: Kind | null; // kind of the nearest enclosing definition
  parentId: string; // nearest enclosing definition id, or the file id
  bindings: FileBindings; // variable/field -> type, for receiver-type lookups
  enclosingClass: string | null; // nearest enclosing class (py/ts `self`/`this`)
  goReceiverVar: string | null; // Go receiver var, e.g. `w` in `func (w *Worker)`
  importedSymbols: ReadonlyMap<string, { name: string; specifier: string }>;
  // R6 (Phase 2): which list we're inside while walking an `R6Class(...)` call's
  // arguments â€” set only for the direct span of a `public =`/`private =`/
  // `active =` `list(...)`'s own entries (see walk()'s special-cased `argument`
  // interception), null everywhere else including inside a method's own body.
  rR6Access: "public" | "private" | "active" | null;
  // R (Phase 2): S3 generics registered in THIS file via a local `UseMethod()`
  // call, precomputed once per file (see collectRGenerics). A `name.Class`
  // assignment only becomes an S3 method if `name` is in this set or the
  // curated base-R generics list â€” see describeR's doc comment for the
  // ambiguity this guards against (`read.csv` is not S3 dispatch).
  rGenerics: ReadonlySet<string>;
  // R6 (Phase 3): the immediate parent class's name (from `inherit =`) for the
  // R6 class we're currently inside, so a `super$method()` call in any of its
  // methods' bodies can resolve directly to the PARENT's method instead of
  // (wrongly) the current class's own same-named override. Unlike rR6Access,
  // this is NOT reset when descending into a method â€” it needs to stay live
  // for the method's whole body, only changing when a genuinely different
  // class is entered. Null outside any class, or for a class with no parent.
  rSuperClass: string | null;
}

/** A definition we're about to emit, normalized across the shapes we handle. */
interface DefDescriptor {
  name: string; // the bare symbol name (used for the node's `name` and call resolution)
  idName?: string; // id-scope segment when it differs from `name` (Go: `Receiver.method`)
  kind: Kind;
  headerEnd: number; // char index where the signature ends (body starts)
  hashNode: SyntaxNode; // node whose text forms body_hash / span
  // A method whose owner can't be read off ctx.enclosingClass because the
  // definition doesn't lexically nest inside its class (R's S3/S4 methods sit
  // at file/top scope, dispatched by name/argument rather than nesting â€” same
  // idea as Go's receiver-qualified methods). R6 methods DO nest (inside the
  // class-defining call's own public=/private=/active= lists) and rely on the
  // ordinary ctx.enclosingClass fallback instead, so they leave this unset.
  owner?: string;
  arity?: number; // declared parameter count â€” overload disambiguation (Java)
  variadic?: boolean; // last parameter is a vararg, so `arity` is a minimum
}

/** Callers check `depthReady` (depth-parser.ts) first and hand a file whose grammar
 * is unavailable to its breadth-tier stand-in. A language with no stand-in (most of
 * the optional grammars) still reaches here, and is indexed as a file-only node. */
export function extractFile(rel: string, source: string, lang: Language): ExtractResult {
  // Simulink packages need no grammar: their unpacked XML/JSON is read directly.
  if (lang === "simulink") return extractSimulink(rel, source);
  // A `.h` header carrying C++ constructs is really C++ â€” the C grammar can't
  // parse classes/templates â€” so route it to the C++ extractor. Shared with the
  // build banner's label so the two can never name different languages.
  const grammar = contentOverride(rel, lang, source)?.grammar ?? lang;
  // An optional grammar that isn't built leaves the file indexed but symbol-less,
  // rather than throwing and marking it a parse error.
  if (!depthReady(grammar)) return { nodes: [fileNodeOf(rel, source)], rawEdges: [] };
  // Objective-C and EB tresos macro files share `.m`: leave them file nodes
  // without spending a MATLAB parse on them.
  if (grammar === "matlab" && (OBJC_MARKERS.test(source) || isTresosTemplate(source)))
    return { nodes: [fileNodeOf(rel, source)], rawEdges: [] };
  if (grammar === "c" || grammar === "cpp") return extractCFamily(rel, source, grammar);
  if (isTresosTemplate(source)) return extractTresosTemplate(rel, source, grammar);
  // A blank file holds no syntax to get wrong, even where the grammar demands a
  // root (an empty `.xml` has no element), so it is not flagged as a parse error.
  const blank = source.trim() === "";
  return parseDepth(grammar, source, (root) =>
    markParseErrors(extractTree(rel, source, grammar, root), blank ? 0 : syntaxErrors(asNative(root)).regions),
  );
}

/**
 * An EB tresos template in another language than C, such as a makefile or an
 * XML file under a plugin's `generate/` folder: its `[! … !]` markup breaks the
 * grammar as it breaks C. The file is parsed as written and, when that has
 * errors, as its template views too (see {@link tresosViews}); the parse whose
 * errors cover the least text is extracted. A view keeps every offset, so its
 * spans hold for the file; the file node still describes the file as written.
 */
function extractTresosTemplate(rel: string, source: string, grammar: Language): ExtractResult {
  const parse = (text: string): CFamilyParse =>
    parseDepth(grammar, text, (root) => ({ result: extractTree(rel, text, grammar, root), ...syntaxErrors(asNative(root)) }));
  let best = parse(source);
  let text = source;
  for (const view of best.errors === 0 ? [] : tresosViews(source)) {
    const p = parse(view);
    if (p.errors < best.errors) {
      best = p;
      text = view;
    }
  }
  if (text !== source) {
    const file = best.result.nodes[0];
    file.body_hash = contentHash(source);
    file.chars = source.length;
    file.body_text = fileResidual(source, best.result.nodes.slice(1));
  }
  return markParseErrors(best.result, best.regions);
}

/** Record on the file node (`nodes[0]`) that its parse had `regions` syntax errors. */
function markParseErrors(result: ExtractResult, regions: number): ExtractResult {
  if (regions > 0 && result.nodes[0]?.kind === "file") result.nodes[0].parse_errors = regions;
  return result;
}

/** One parse of a C/C++ file (or of one of its branch views): what it yields and
 * how much of the tree is syntax errors (see {@link syntaxErrors}). */
interface CFamilyParse {
  result: ExtractResult;
  errors: number;
  regions: number;
  rows: number[];
  hints: number[];
}

/**
 * C and C++ are parsed without a preprocessor, so the grammar sees every branch of
 * every `#if` at once. Where the branches only make sense one at a time (an `if (`
 * whose condition differs per branch, a function head per branch, a brace opened
 * in one branch and closed after the `#endif`), the tree has errors, and the
 * functions caught in them are lost.
 *
 * Such a file is parsed again as two branch views (see {@link pickBranches} and
 * {@link renderConditionalView}):
 * each `#if` chain keeps only its first branch, or only its last. The tree whose
 * errors cover the least text is extracted. A function, type or variable the other
 * parses found and it did not (one defined in a branch that view left out, or one
 * lost in an error) is added, and so are the calls the other parses saw in a function they share, so
 * calls written in a left-out branch still count. When the best view still has
 * errors, other branches (or none) of the chains next to them are tried (see
 * {@link refineConditionalView}): code that cannot compile usually sits in a
 * branch no build turns on. Files that parse without errors, nearly all of
 * them, are parsed once, as before.
 *
 * An EB tresos code template is never parsed as written: its two template views
 * (see {@link tresosViews}) take the original's place, and the branch views are
 * made from the better of them. An ERB template (Ruby in `<% … %>` tags and `%`
 * lines, see {@link erbView}) is parsed as written and as its C view.
 *
 * A C file that has errors and `#ifdef __cplusplus` branches is also parsed as a
 * C compiler sees it, with those branches blanked (see {@link withoutCppBranches}),
 * and that view competes with the original for the base the branch views start from.
 * So does a view that puts back the commas an initializer list leaves out between
 * `#if` blocks that are never on together (see {@link withInitializerCommas}).
 *
 * A `.h` header whose C++ sits only in `#ifdef __cplusplus` branches is routed
 * to C (see {@link looksLikeCpp}); when its C parse has errors, it is parsed as
 * C++ too (C++ code in those branches, or C++ that `looksLikeCpp` does not spot,
 * such as `const T x((T) 0);`), and the parse whose errors cover less text is
 * kept. Only when the C++ grammar reads the file as written better than C does
 * is it extracted, with its branch views, as C++.
 * A file with no C punctuation at all (a list of file names that happens to end
 * in `.h`), or saved grep output (`App.c:#include "App.h"` on every line), is
 * not code: it stays a file node.
 */
function extractCFamily(rel: string, source: string, grammar: Language): ExtractResult {
  if (!/[;{}#()]/.test(source) || looksLikeGrepOutput(source)) return { nodes: [fileNodeOf(rel, source)], rawEdges: [] };
  const texts = isTresosTemplate(source) ? tresosViews(source) : isErbTemplate(source) ? [source, erbView(source)] : [source];
  const asC = extractCFamilyAs(rel, source, grammar, [...texts]);
  if (grammar !== "c" || asC.errors === 0 || !/\.h$/i.test(rel) || !grammarAvailable("cpp")) return asC.result;
  // Extracting again as C++ (branch views and all) only pays when the C++
  // grammar already reads the file better as written; most headers with C
  // errors have C the C++ grammar cannot read either.
  const cppFirst = Math.min(...texts.map((t) => parseDepth("cpp", t, (root) => syntaxErrors(asNative(root)).errors)));
  if (cppFirst >= asC.first) return asC.result;
  const asCpp = extractCFamilyAs(rel, source, "cpp", texts);
  return asCpp.errors < asC.errors ? asCpp.result : asC.result;
}

/** What {@link extractCFamilyAs} extracted, and how much of the text the syntax
 * errors cover (see {@link syntaxErrors}): in the parse the symbols came from,
 * and in the best parse of the file as written, before any branch view. */
interface CFamilyOutcome {
  result: ExtractResult;
  errors: number;
  first: number;
}

/** Whether nearly every line starts with a file name and a colon, as grep
 * prints its hits (`dir/App.c:#include "App.h"`, `App.c:12:int x;`). No C line
 * starts that way: a label or `case` has no `.ext` before its colon. */
function looksLikeGrepOutput(source: string): boolean {
  const lines = source.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 3) return false;
  const hits = lines.filter((l) => /^[\w./\\-]+\.\w+:/.test(l)).length;
  return hits >= lines.length * 0.9;
}

/** `texts` are the file's own text, or its tresos template views; the array is
 * extended with the C-only view. */
function extractCFamilyAs(rel: string, source: string, grammar: Language, texts: string[]): CFamilyOutcome {
  const parse = (text: string): CFamilyParse =>
    parseDepth(grammar, text, (root) => ({ result: extractTree(rel, text, grammar, root), ...syntaxErrors(asNative(root)) }));
  const firsts = texts.map(parse);
  let base = 0;
  for (let k = 1; k < firsts.length; k++) if (firsts[k].errors < firsts[base].errors) base = k;
  // Read as C, a file's `#ifdef __cplusplus` branches are never compiled; one
  // that only closes an `extern "C" {` opened in another header unbalances the
  // braces of the whole file. Parse the file as a C compiler sees it too, unless
  // those branches hold real C++ (classes, templates): that is parsed as C++
  // instead (see extractCFamily), and blanking it would only lose it.
  const cOnly = grammar === "c" && firsts[base].errors > 0 && !cppInGuardedBranches(texts[base]) ? withoutCppBranches(texts[base]) : null;
  if (cOnly !== null) {
    texts.push(cOnly);
    firsts.push(parse(cOnly));
    if (firsts[firsts.length - 1].errors < firsts[base].errors) base = firsts.length - 1;
  }
  // Statement macros on lines of their own, without their semicolon (see
  // withMacroSemicolons).
  const semis = firsts[base].errors > 0 ? withMacroSemicolons(texts[base]) : null;
  if (semis !== null) {
    texts.push(semis);
    firsts.push(parse(semis));
    if (firsts[firsts.length - 1].errors < firsts[base].errors) base = firsts.length - 1;
  }
  // Initializer elements in `#if` blocks that are never on together, each
  // without its comma (see withInitializerCommas).
  const commaOrigin = texts[base];
  const commaLines = firsts[base].errors > 0 ? initializerCommaLines(commaOrigin.split("\n")) : [];
  const commas = withCommaLines(commaOrigin, commaLines);
  if (commas !== null) {
    texts.push(commas);
    firsts.push(parse(commas));
    if (firsts[firsts.length - 1].errors < firsts[base].errors) base = firsts.length - 1;
  }
  const original = firsts[base];
  const first = original.errors;
  if (original.errors === 0 && texts[base] === source) return { result: original.result, errors: 0, first };
  // The `#if` views of the text with the fewest errors, and of the C-only text
  // too: in a header whose `#ifdef __cplusplus` opens an `extern "C" {` it never
  // closes, the C-only text can lose to the file by a few characters of errors
  // in another branch (assembler in `#if OS_ASM`), while only its views close
  // nothing they did not open.
  const viewed = cOnly !== null && texts[base] !== cOnly ? [texts[base], cOnly] : [texts[base]];
  const chainsOf = (text: string): ConditionalSet | null => {
    if (text !== commas) return conditionalChains(text);
    const set = conditionalChains(commaOrigin);
    return set === null ? null : { ...set, commas: commaLines };
  };
  const sets = original.errors === 0 ? [] : viewed.map(chainsOf).filter((s): s is ConditionalSet => s !== null);
  const views = sets.flatMap((set) =>
    (["first", "last"] as const).map((pick) => {
      const keep = pickBranches(set, pick);
      return { set, keep, parse: parse(renderConditionalView(set, keep).text) };
    }),
  );
  if (views.length === 0 && texts.length === 1)
    return { result: markParseErrors(original.result, original.regions), errors: original.errors, first };
  const parses = [original, ...firsts.filter((p) => p !== original), ...views.map((v) => v.parse)];
  let best = original;
  for (const p of parses) if (p.errors < best.errors) best = p;
  // Errors left in the best view: try other branches of the chains next to
  // them (see refineConditionalView). Trials are only counted, not extracted.
  const seed = views.reduce<(typeof views)[number] | null>((a, v) => (a === null || v.parse.errors < a.parse.errors ? v : a), null);
  if (seed !== null && best.errors > 0 && seed.parse.errors > 0) {
    const countErrors = (text: string) => parseDepth(grammar, text, (root) => syntaxErrors(asNative(root)));
    const refined = refineConditionalView(seed.set, seed.keep, seed.parse, countErrors);
    if (refined !== null) {
      const p = parse(refined.text);
      parses.push(p);
      if (p.errors < best.errors) best = p;
    }
  }
  const merged = best.result;
  if (texts[base] !== source || best !== original) {
    // The view's text has the left-out lines blanked; the file node describes
    // the file as it is.
    const file = merged.nodes[0];
    file.body_hash = contentHash(source);
    file.chars = source.length;
  }
  for (const p of parses) if (p !== best) mergeCFamilyParse(merged, p.result, rel);
  merged.nodes[0].body_text = fileResidual(source, merged.nodes.slice(1));
  // The parse the symbols came from still has errors: say so on the file. Symbols
  // merged in from the other views may fill some of its gaps, not all of them.
  return { result: markParseErrors(merged, best.regions), errors: best.errors, first };
}

/**
 * The syntax errors in a tree. `errors` is how much of it they cover: the
 * characters inside ERROR nodes (not counting those nested in another ERROR),
 * plus one for each MISSING node. Sizes, not node counts: when the parser gives
 * up, one ERROR can hold the whole file, which is worse than a few small errors.
 * `regions` is how many places the parser could not read: those ERROR and
 * MISSING nodes, counted once each. `rows` are the 0-based lines they start
 * on (an ERROR's last line too), in order.
 *
 * `hints` are lines that say better where the trouble began, in order: for a
 * MISSING node (a `#endif`, a `}`, a `)`), the line of the `#if` or `#ifdef` it
 * sits in, which is often the branch that opened what was never closed; and for
 * an ERROR spanning several lines (when the parser gives up, the whole file),
 * the same for the ERROR and MISSING nodes inside it, whose lines `rows` does
 * not see. They are not counted in `errors` or `regions`.
 */
function syntaxErrors(root: Parser.SyntaxNode): { errors: number; regions: number; rows: number[]; hints: number[] } {
  if (!root.hasError) return { errors: 0, regions: 0, rows: [], hints: [] };
  let errors = 0;
  let regions = 0;
  const rows: number[] = [];
  const hints = new Set<number>();
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "ERROR") {
      errors += Math.max(1, node.endIndex - node.startIndex);
      regions++;
      rows.push(node.startPosition.row);
      if (node.endPosition.row !== node.startPosition.row) {
        rows.push(node.endPosition.row);
        hintsInside(node, hints);
      }
      continue;
    }
    if (node.isMissing) {
      errors++;
      regions++;
      rows.push(node.startPosition.row);
      const opener = enclosingConditional(node);
      if (opener !== null) hints.add(opener);
      continue;
    }
    for (const child of node.children) if (child.hasError || child.isMissing) stack.push(child);
  }
  return { errors, regions, rows: rows.sort((a, b) => a - b), hints: [...hints].sort((a, b) => a - b) };
}

/** The line of the innermost `#if`/`#ifdef` around `node`, or null. */
function enclosingConditional(node: Parser.SyntaxNode): number | null {
  for (let p = node.parent; p !== null; p = p.parent)
    if (p.type === "preproc_if" || p.type === "preproc_ifdef") return p.startPosition.row;
  return null;
}

/** Add to `hints` the lines of the ERROR and MISSING nodes inside the ERROR
 * `outer` (see {@link syntaxErrors}): for a MISSING node, the line of the
 * `#if` it sits in when there is one. */
function hintsInside(outer: Parser.SyntaxNode, hints: Set<number>): void {
  const stack: Parser.SyntaxNode[] = [...outer.children];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.isMissing) {
      hints.add(enclosingConditional(node) ?? node.startPosition.row);
      continue;
    }
    if (node.type === "ERROR") hints.add(node.startPosition.row);
    for (const child of node.children) if (child.hasError || child.isMissing || child.type === "ERROR") stack.push(child);
  }
}

const symbolKey = (n: NodeV1): string => `${n.kind}:${n.name}@${n.span.slice(0, n.span.indexOf("-"))}`;
const edgeKey = (e: RawEdge): string =>
  `${e.relation}|${e.targetId ?? ""}|${e.specifier ?? ""}|${e.name ?? ""}|${e.viaMember ? 1 : 0}|${e.recvType ?? ""}`;

/**
 * Add to `into` what another parse of the same file found and `into` lacks:
 * top-level symbols (functions with the calls they make, types, variables) with
 * their members, the calls made by functions both found, and the file's imports.
 * Ids are minted again against `into`, so a function defined once per branch gets
 * `~2` like any other repeated name.
 */
function mergeCFamilyParse(into: ExtractResult, other: ExtractResult, rel: string): void {
  const minted = new Set(into.nodes.map((n) => n.id));
  const idByKey = new Map(into.nodes.map((n) => [symbolKey(n), n.id]));
  const seen = new Set(into.rawEdges.map((e) => `${e.source}|${edgeKey(e)}`));
  const add = (edge: RawEdge): void => {
    const key = `${edge.source}|${edgeKey(edge)}`;
    if (seen.has(key)) return;
    seen.add(key);
    into.rawEdges.push(edge);
  };
  const parentOf = new Map<string, string>();
  for (const e of other.rawEdges) if (e.relation === "contains" && e.targetId !== undefined) parentOf.set(e.targetId, e.source);
  // Where each node of `other` lives in `into`: matched, or added now. Nodes come
  // in document order, so a parent is placed before its members.
  const target = new Map<string, string>([[rel, rel]]);
  for (const node of other.nodes.slice(1)) {
    const key = symbolKey(node);
    const known = idByKey.get(key);
    if (known !== undefined) {
      target.set(node.id, known);
      continue;
    }
    // A top-level symbol, or a member of one placed already (a field or method
    // the other parse saw only in its branch).
    const parent = parentOf.get(node.id);
    if (parent === undefined || !target.has(parent)) continue;
    const id = mintId(node.id.replace(/~\d+$/, ""), minted);
    idByKey.set(key, id);
    target.set(node.id, id);
    into.nodes.push({ ...node, id });
    add({ source: target.get(parent)!, relation: "contains", targetId: id, file: rel });
  }
  for (const edge of other.rawEdges) {
    if (edge.relation === "contains") continue;
    const source = target.get(edge.source);
    if (source === undefined) continue;
    if (edge.source === rel && edge.relation !== "imports") continue;
    add({ ...edge, source });
  }
}

const CONDITIONAL_DIRECTIVE = /^[ \t]*#[ \t]*(if|ifdef|ifndef|elif|elifdef|elifndef|else|endif)\b(.*)$/;
const IF_ZERO = /^\s*\(?\s*0\s*\)?\s*(\/[/*].*)?$/;

/** `#error` and `#warning`: a message for the compiler, no code. */
const DIAGNOSTIC_DIRECTIVE = /^[ \t]*#[ \t]*(error|warning)\b/;

interface ConditionalBranch { at: number; end: number; cond: string; kw: string }
/** One `#if` chain: its branches (each opened by the directive at `at`, which
 * goes on to `end`), its `#endif` (-1 when the file never closes the chain),
 * and the chain and branch it sits in (-1 at the top). */
interface ConditionalChain {
  branches: ConditionalBranch[];
  endif: number;
  endifEnd: number;
  parent: number;
  parentBranch: number;
}
/** A text's lines and its `#if` chains, in the order they open. A view says, per
 * chain, which branch it keeps (-1: none). `commas` are directive lines each
 * view turns into a comma (see {@link initializerCommaLines}). */
interface ConditionalSet { lines: string[]; chains: ConditionalChain[]; commas?: number[] }

/** The `#if` chains of a text, or null when none of them is complete. A
 * directive inside a block comment (code commented out with its `#if` and
 * `#endif*\/`) is no directive: blanking it in a view would cut the comment's
 * end away. */
function conditionalChains(source: string): ConditionalSet | null {
  const lines = source.split("\n");
  const commented: boolean[] = [];
  codeOfLines(lines, commented);
  const chains: ConditionalChain[] = [];
  const open: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = commented[i] ? null : CONDITIONAL_DIRECTIVE.exec(lines[i].replace(/\r$/, ""));
    let end = i;
    if (m) end = directiveEnd(lines, i);
    else while (end < lines.length - 1 && /\\\r?$/.test(lines[end])) end++;
    if (m) {
      const kw = m[1];
      if (kw.startsWith("if")) {
        const parent = open.length > 0 ? open[open.length - 1] : -1;
        const parentBranch = parent >= 0 ? chains[parent].branches.length - 1 : -1;
        chains.push({ branches: [{ at: i, end, cond: m[2], kw }], endif: -1, endifEnd: -1, parent, parentBranch });
        open.push(chains.length - 1);
      } else if (kw === "endif") {
        const c = open.pop();
        if (c !== undefined) {
          chains[c].endif = i;
          chains[c].endifEnd = end;
        }
      } else if (open.length > 0) chains[open[open.length - 1]].branches.push({ at: i, end, cond: m[2], kw });
    }
    i = end;
  }
  return chains.some((c) => c.endif >= 0) ? { lines, chains } : null;
}

/** The branch each chain keeps in the first view of a C/C++ file (its first
 * branch, the second for `#if 0`) or the last (its last branch, the `#else`
 * when there is one). A chain without its `#endif` is left as it is (see
 * {@link renderConditionalView}). */
function pickBranches(set: ConditionalSet, pick: "first" | "last"): number[] {
  return set.chains.map(({ branches }) => {
    const zero = IF_ZERO.test(branches[0].cond);
    return pick === "first"
      ? zero ? (branches.length > 1 ? 1 : -1) : 0
      : branches.length > 1 ? branches.length - 1 : zero ? -1 : 0;
  });
}

/**
 * The view of `set` that keeps branch `keep[c]` of each complete chain `c` (none
 * for -1): directive lines and left-out branches are blanked with spaces, and so
 * are `#error` and `#warning` lines, which hold no code but break the grammar
 * where they sit inside an expression (`f(a` `#warning "todo"` `+ b);`).
 * `blanked` counts the lines of code the view leaves out. A comma line in a
 * left-out branch stays blank, with the elements around it.
 */
function renderConditionalView(set: ConditionalSet, keep: number[]): { text: string; blanked: number } {
  const { lines, chains } = set;
  const blank = new Uint8Array(lines.length);
  const dropped = new Uint8Array(lines.length);
  let blanked = 0;
  chains.forEach((chain, c) => {
    if (chain.endif < 0) return;
    const { branches } = chain;
    for (const b of branches) blank.fill(1, b.at, b.end + 1);
    blank.fill(1, chain.endif, chain.endifEnd + 1);
    branches.forEach((b, k) => {
      if (k === keep[c]) return;
      const to = k + 1 < branches.length ? branches[k + 1].at : chain.endif;
      if (to > b.end + 1) {
        blank.fill(1, b.end + 1, to);
        dropped.fill(1, b.end + 1, to);
        blanked += to - b.end - 1;
      }
    });
  });
  for (let i = 0; i < lines.length; i++) {
    if (blank[i] || !DIAGNOSTIC_DIRECTIVE.test(lines[i])) continue;
    const end = directiveEnd(lines, i);
    blank.fill(1, i, end + 1);
    i = end;
  }
  const out = lines.map((line, i) => (blank[i] ? line.replace(/[^\r]/g, " ") : line));
  for (const i of set.commas ?? []) if (!dropped[i]) out[i] = commaLine(lines[i]);
  return { text: out.join("\n"), blanked };
}

/** Whether every branch around chain `c` is one `keep` keeps. */
function chainActive(set: ConditionalSet, keep: number[], c: number): boolean {
  for (let { parent, parentBranch } = set.chains[c]; parent >= 0; { parent, parentBranch } = set.chains[parent])
    if (set.chains[parent].endif >= 0 && keep[parent] !== parentBranch) return false;
  return true;
}

/** How many chains near the errors a refinement round tries, how far before an
 * error a chain may end, and how many trial parses a file gets in all. */
const FLIP_CHAINS = 6;
const FLIP_WINDOW = 400;
const FLIP_BUDGET = 16;

/**
 * When the view `keep` opens more braces than it closes (or closes more than it
 * opens), the chains whose kept branch is unbalanced the same way, ranked
 * before any other candidate (scores below -2): those whose branch alone
 * accounts for the whole difference first, the smaller chain on a tie. A brace
 * opened in a branch and closed after its `#endif` is fine as long as the view
 * stays balanced, so a balanced view has no suspects. A branch no build turns
 * on that leaves out a `}` (`if (a) {` … `}` with the last `}` missing, as
 * nothing compiles it) makes the parser give up on the whole file, and the
 * errors it leaves point nowhere near that branch.
 */
function braceSuspects(set: ConditionalSet, keep: number[]): Map<number, number> {
  const rank = new Map<number, number>();
  const code = codeOfLines(renderConditionalView(set, keep).text.split("\n"));
  const sums = new Int32Array(code.length + 1);
  let directive = false;
  code.forEach((line, i) => {
    // A preprocessor line (a `#define` and its continuation lines) holds no
    // braces of the code around it.
    const skip = directive || /^\s*#/.test(line);
    directive = skip && /\\\s*$/.test(line);
    let d = 0;
    if (!skip) for (const ch of line) d += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    sums[i + 1] = sums[i] + d;
  });
  const total = sums[code.length];
  if (total === 0) return rank;
  set.chains.forEach((chain, c) => {
    const k = keep[c];
    if (chain.endif < 0 || k < 0 || chain.branches.some((b) => /\b__cplusplus\b/.test(b.cond))) return;
    if (!chainActive(set, keep, c)) return;
    const b = chain.branches[k];
    const to = k + 1 < chain.branches.length ? chain.branches[k + 1].at : chain.endif;
    const delta = sums[Math.max(b.end + 1, to)] - sums[b.end + 1];
    if (delta === 0 || Math.sign(delta) !== Math.sign(total)) return;
    const miss = Math.abs(total - delta) / (Math.abs(total) + Math.abs(delta));
    const size = (chain.endifEnd - chain.branches[0].at) / (set.lines.length + 1);
    rank.set(c, -3 + miss / 2 + size / 2);
  });
  return rank;
}

/**
 * Other branch choices for the chains next to the first errors of a view: those
 * the error sits in (innermost first), then those that end shortly before it
 * (nearest first). Chains around the first `hints` (see {@link syntaxErrors})
 * come before all of them, innermost first: when the parser gave up on the whole
 * file, its errors start on the first line and end on the last, and only the
 * hints still point at the branch to blame. Before those still come the chains
 * whose branch leaves the braces of the view unbalanced (see
 * {@link braceSuspects}). Each chain may keep another of its
 * branches, or none when it has no `#else`. A `__cplusplus` chain is left as it
 * is: its branch is code a C++ compiler builds, which the C-only view and the C++
 * parse of a header already deal with (see {@link extractCFamily}).
 */
function flipCandidates(set: ConditionalSet, keep: number[], rows: number[], hints: number[] = []): Array<{ chain: number; branch: number }> {
  const rank = braceSuspects(set, keep);
  const marks = [...hints.slice(0, 3).map((row) => ({ row, hint: true })), ...rows.slice(0, 3).map((row) => ({ row, hint: false }))];
  for (const { row, hint } of marks) {
    set.chains.forEach((chain, c) => {
      if (chain.endif < 0 || chain.branches.some((b) => /\b__cplusplus\b/.test(b.cond))) return;
      const from = chain.branches[0].at;
      const to = chain.endifEnd;
      let score: number;
      if (from <= row && row <= to) score = (to - from) / (set.lines.length + 1) - (hint ? 1 : 0);
      else if (!hint && to < row && row - to <= FLIP_WINDOW) score = row - to;
      else return;
      if (!chainActive(set, keep, c)) return;
      const known = rank.get(c);
      if (known === undefined || score < known) rank.set(c, score);
    });
  }
  const out: Array<{ chain: number; branch: number }> = [];
  for (const [c] of [...rank].sort((a, b) => a[1] - b[1]).slice(0, FLIP_CHAINS)) {
    const { branches } = set.chains[c];
    const options = branches.map((_, k) => k);
    if (branches[branches.length - 1].kw !== "else") options.push(-1);
    for (const branch of options) if (branch !== keep[c]) out.push({ chain: c, branch });
  }
  return out;
}

/**
 * A view with fewer errors than `start`, found by keeping other branches of the
 * chains next to its errors (see {@link flipCandidates}), or null. Code that
 * cannot compile in a branch (a stray brace, a call with one parenthesis too
 * many, a statement list ended with commas) is code no build turns on, so a view
 * without it is closer to the file a compiler sees. Each round keeps the trial
 * with the fewest errors, the one leaving out the fewest lines on a tie.
 */
function refineConditionalView(
  set: ConditionalSet,
  keep: number[],
  start: { errors: number; rows: number[]; hints: number[] },
  countErrors: (text: string) => { errors: number; rows: number[]; hints: number[] },
): { text: string; keep: number[] } | null {
  let current = start;
  let currentKeep = keep;
  let text: string | null = null;
  let budget = FLIP_BUDGET;
  while (current.errors > 0 && budget > 0) {
    let found: { errors: number; rows: number[]; hints: number[]; keep: number[]; text: string; blanked: number } | null = null;
    for (const { chain, branch } of flipCandidates(set, currentKeep, current.rows, current.hints)) {
      if (budget-- <= 0) break;
      const trial = currentKeep.slice();
      trial[chain] = branch;
      const view = renderConditionalView(set, trial);
      const counted = countErrors(view.text);
      if (counted.errors >= current.errors) continue;
      if (found === null || counted.errors < found.errors || (counted.errors === found.errors && view.blanked < found.blanked))
        found = { ...counted, keep: trial, text: view.text, blanked: view.blanked };
    }
    if (found === null) break;
    current = found;
    currentKeep = found.keep;
    text = found.text;
  }
  return text === null ? null : { text, keep: currentKeep };
}

/**
 * The last line of the directive that starts on line `start`: it goes on over a
 * trailing backslash, and over the lines of a block comment it opens
 * (`#endif /* A ||` then `B *\/` on the next line), so blanking the directive
 * does not leave the rest of the comment behind as code.
 */
function directiveEnd(lines: string[], start: number): number {
  let inComment = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    let j = 0;
    while (j < line.length) {
      if (inComment) {
        const close = line.indexOf("*/", j);
        if (close < 0) break;
        inComment = false;
        j = close + 2;
        continue;
      }
      const open = line.indexOf("/*", j);
      const lineComment = line.indexOf("//", j);
      if (open < 0 || (lineComment >= 0 && lineComment < open)) break;
      inComment = true;
      j = open + 2;
    }
    if (!inComment && !line.endsWith("\\")) return i;
  }
  return lines.length - 1;
}

/**
 * An initializer list whose elements sit in `#if` blocks that are never on
 * together, each block written as if it were the only one, so a block's last
 * element has no comma:
 *
 *     #if A
 *        &OBJ_X
 *     #endif
 *     #if B
 *        &OBJ_Y
 *     #endif
 *
 * The same holds for the enumerators of an `enum`. The grammar sees every block
 * at once, and the elements run together. The view
 * returned puts a comma where the first directive line between two such
 * elements was (the rest of that line becomes spaces), so every line, column and
 * offset stays where it was. Null when no gap needs one.
 */
export function withInitializerCommas(source: string): string | null {
  return withCommaLines(source, initializerCommaLines(source.split("\n")));
}

/** `source` with lines `at` turned into commas, or null when there are none. */
function withCommaLines(source: string, at: number[]): string | null {
  if (at.length === 0) return null;
  const lines = source.split("\n");
  for (const i of at) lines[i] = commaLine(lines[i]);
  return lines.join("\n");
}

/** `line` blanked, with a comma where it started. */
const commaLine = (line: string): string => line.replace(/[^\r]/g, " ").replace(/^ /, ",");

/** The directive lines {@link withInitializerCommas} turns into commas. The
 * `#if` views of that text are made from the text without them, with the commas
 * put back on the blanked lines (see {@link renderConditionalView}), so the
 * chain whose `#endif` became a comma still closes. */
function initializerCommaLines(lines: string[]): number[] {
  const code = codeOfLines(lines);
  const directive = (i: number): boolean => CONDITIONAL_DIRECTIVE.test(lines[i].replace(/\r$/, "")) && directiveEnd(lines, i) === i;
  const inList = initializerLines(code);
  const at: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!inList[i] || !directive(i)) continue;
    // The code line before this run of directive lines, and the one after it.
    let prev = i - 1;
    while (prev >= 0 && code[prev].trim() === "") prev--;
    if (prev < 0 || directive(prev)) continue;
    let next = i + 1;
    while (next < lines.length && (code[next].trim() === "" || directive(next))) next++;
    if (next >= lines.length) break;
    const before = code[prev].trim();
    const after = code[next].trim();
    // An `#elif` or `#else` of a chain the element before sits in makes the two
    // elements alternatives, never on together: they need no comma.
    let opened = 0;
    let alternatives = false;
    for (let k = i; k < next && !alternatives; k++) {
      const kw = directive(k) ? CONDITIONAL_DIRECTIVE.exec(lines[k].replace(/\r$/, ""))![1] : "";
      if (kw.startsWith("if")) opened++;
      else if (kw === "endif") opened = Math.max(0, opened - 1);
      else if (kw !== "") alternatives = opened === 0;
    }
    // An element ends in a name, a literal or a closing bracket; the next one
    // starts like an expression, a designator or a nested list.
    if (!alternatives && /[\w)\]}"']$/.test(before) && !before.startsWith("#") && /^[(&\w"'.{-]/.test(after) && !/^(&&|\|\|)/.test(after))
      at.push(i);
    while (i + 1 < next) i++;
  }
  return at;
}

/** For each line, whether it starts inside an initializer list: a `{` after
 * `=`, or after `{` or `,` inside another list. The enumerator list of an
 * `enum` counts as one too. */
function initializerLines(code: string[]): boolean[] {
  const stack: boolean[] = [];
  let last = "";
  // The last code before the current character, to spot `enum Name {`.
  let tail = "";
  return code.map((line) => {
    const inside = stack.length > 0 && stack[stack.length - 1];
    // A preprocessor line holds no braces of the code around it.
    if (/^\s*#/.test(line)) return inside;
    for (const ch of line) {
      if (ch === "{")
        stack.push(
          last === "=" ||
            /\benum(\s+(class|struct)\b)?(\s+\w+)?(\s*:\s*[\w:\s]+)?\s*$/.test(tail) ||
            ((last === "{" || last === ",") && stack.length > 0 && stack[stack.length - 1]),
        );
      else if (ch === "}") stack.pop();
      if (!/\s/.test(ch)) last = ch;
      tail = (tail + ch).slice(-80);
    }
    tail += " ";
    return inside;
  });
}

/** Each line's code: its comments and string contents become spaces. When
 * `startsInComment` is given, it is filled with whether each line starts inside
 * a block comment. */
function codeOfLines(lines: string[], startsInComment?: boolean[]): string[] {
  let inComment = false;
  return lines.map((raw) => {
    startsInComment?.push(inComment);
    const line = raw.replace(/\r$/, "");
    let out = "";
    for (let j = 0; j < line.length; j++) {
      if (inComment) {
        if (line.startsWith("*/", j)) {
          inComment = false;
          out += "  ";
          j++;
        } else out += " ";
        continue;
      }
      if (line.startsWith("/*", j)) {
        inComment = true;
        out += "  ";
        j++;
      } else if (line.startsWith("//", j)) {
        out += " ".repeat(line.length - j);
        break;
      } else if (line[j] === '"' || line[j] === "'") {
        const quote = line[j];
        let k = j + 1;
        while (k < line.length && line[k] !== quote) k += line[k] === "\\" ? 2 : 1;
        out += quote + " ".repeat(Math.max(0, Math.min(k, line.length) - j - 1)) + (k < line.length ? quote : "");
        j = k;
      } else out += line[j];
    }
    return out;
  });
}

/** Words that look like a call on a line of their own but are not one. */
const NOT_A_MACRO = new Set(["if", "while", "for", "switch", "return", "sizeof", "do", "else", "case", "goto", "_Generic", "defined", "__asm", "__asm__", "asm"]);

/**
 * Statement macros written without their semicolon, one per line, as in
 * generated OS code (`COVER(0x0374)`, `osReleaseInternalLock(x)`,
 * `ELSEWITHCOVER(0x0376)`), whose definitions bring the `;` or the
 * `else { … }` along. The grammar reads such lines as macro statements, but
 * where several of them follow each other they can also start a declaration
 * (`M1(a) M2(b) type name;`); with enough alternatives open at once the parser
 * drops the right one, and an `if` after them breaks the whole function, or
 * the whole file. The view returned has a `;` right after each such call: a
 * line that is a single call of a name (nothing before it, a comment at most
 * after it) inside braces but not in an initializer list, after a line that
 * ends a statement or a block, and before one that starts a new statement.
 * Every line stays where it was. Null when no line needs one.
 */
export function withMacroSemicolons(source: string): string | null {
  const lines = source.split("\n");
  const code = codeOfLines(lines);
  const inList = initializerLines(code);
  // Brace depth at each line's start, and which lines are preprocessor lines
  // (with their continuation lines).
  const depth = new Int32Array(lines.length);
  const directive = new Uint8Array(lines.length);
  let level = 0;
  let continued = false;
  code.forEach((line, i) => {
    depth[i] = level;
    const isDirective = continued || /^\s*#/.test(line);
    continued = isDirective && /\\\s*$/.test(line);
    if (isDirective) {
      directive[i] = 1;
      return;
    }
    for (const ch of line) level += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    if (level < 0) level = 0;
  });
  const codeLine = (i: number, step: number): number => {
    for (let k = i + step; k >= 0 && k < lines.length; k += step) if (!directive[k] && code[k].trim() !== "") return k;
    return -1;
  };
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (depth[i] === 0 || inList[i] || directive[i]) continue;
    const m = /^(\s*)([A-Za-z_]\w*)\s*\(/.exec(code[i]);
    if (m === null || NOT_A_MACRO.has(m[2])) continue;
    // The call's parentheses close at the end of the line.
    let open = 0;
    let close = -1;
    for (let j = m[0].length - 1; j < code[i].length; j++) {
      if (code[i][j] === "(") open++;
      else if (code[i][j] === ")" && --open === 0) {
        close = j;
        break;
      }
    }
    if (close < 0 || code[i].slice(close + 1).trim() !== "") continue;
    const prev = codeLine(i, -1);
    const next = codeLine(i, 1);
    if (prev < 0 || next < 0) continue;
    const before = code[prev].trimEnd();
    const after = code[next].trimStart();
    // The line before ends a statement, opens or closes a block, or is a label.
    if (!/[;{}):]$/.test(before)) continue;
    // One ending in `)` must be a call of the same kind, or the head of an
    // `if`, `for` or `while` whose body this line is: not an expression going on.
    if (before.endsWith(")") && !/^\s*(\}\s*)?(else\s+)?([A-Za-z_]\w*\s*\()/.test(code[prev])) continue;
    // The line after starts a statement or closes the block.
    if (!/^([A-Za-z_}(*]|\+\+|--)/.test(after)) continue;
    lines[i] = lines[i].slice(0, close + 1) + ";" + lines[i].slice(close + 1);
    changed = true;
  }
  return changed ? lines.join("\n") : null;
}

/**
 * MATLAB code embedded in another file (a MATLAB Function block or a Stateflow
 * MATLAB function in a Simulink model), extracted as if it were its own `.m` file
 * named `rel`. Null when the MATLAB grammar is not built or the code does not parse;
 * the caller then falls back to reading names out of the text.
 */
export function extractMatlabSnippet(rel: string, code: string): ExtractResult | null {
  if (!depthReady("matlab")) return null;
  try {
    return parseDepth("matlab", code, (root) => extractMatlab(rel, code, root as unknown as Parser.SyntaxNode));
  } catch {
    return null;
  }
}

/** A node of one of the fork's optional languages: always parsed native (depth-parser.ts backendOf), so the full node API is there. */
function asNative(node: SyntaxNode): Parser.SyntaxNode {
  return node as unknown as Parser.SyntaxNode;
}

/** {@link extractFile} over an already-parsed tree. */
function extractTree(rel: string, source: string, lang: Language, root: SyntaxNode): ExtractResult {
  // Markup/style languages carry no call graph, so they bypass the
  // definition/among-calls walk for a dedicated shape (rules, id'd elements) or,
  // for Razor (embedded C# is opaque here), a file node only.
  const n = asNative(root);
  if (lang === "css") return extractCss(rel, source, n);
  if (lang === "html") return extractHtml(rel, source, n);
  if (lang === "xml") return structuralOnly(extractXml(rel, source, n));
  if (lang === "json") return extractJson(rel, source, n);
  if (lang === "yaml") return extractYaml(rel, source, n);
  if (lang === "markdown") return extractMarkdown(rel, source, n);
  if (lang === "scss") return extractScss(rel, source, n);
  if (lang === "csv") return extractCsv(rel, source, n);
  if (lang === "cmake") return extractCmake(rel, source, n);
  if (lang === "bash") return extractBash(rel, source, n);
  if (lang === "perl") return extractPerl(rel, source, n);
  if (lang === "make") return extractMake(rel, source, n);
  if (lang === "matlab") return extractMatlab(rel, source, n);
  if (lang === "razor") return { nodes: [fileNodeOf(rel, source)], rawEdges: [] };
  const bindings = collectBindings(root, lang);
  const importedSymbols = collectImportedSymbols(root, lang);
  const rGenerics = lang === "r" ? collectRGenerics(root) : EMPTY_SET;

  const nodes: NodeV1[] = [
    {
      id: rel,
      name: basename(rel),
      kind: "file",
      path: rel,
      span: `L1-L${root.endPosition.row + 1}`,
      signature: null,
      exported: true,
      origin: "ast",
      body_hash: contentHash(source),
      chars: source.length,
      summary_state: "pending",
      summary: null,
      crux: null,
    },
  ];
  const rawEdges: RawEdge[] = [];

  const ctx: WalkCtx = {
    rel,
    source,
    lang,
    kinds: KINDS_BY_LANG[lang],
    scope: [],
    enclosingKind: null,
    parentId: rel,
    bindings,
    enclosingClass: null,
    goReceiverVar: null,
    importedSymbols,
    rR6Access: null,
    rGenerics,
    rSuperClass: null,
  };
  // Every id minted this file, seeded with the file node's own id (`rel`) so a
  // top-level definition can never collide with it. Threaded as its own
  // parameter rather than living on WalkCtx â€” WalkCtx is spread into every
  // childCtx, so a by-ref Set there would read as ordinary inherited context
  // when it's actually accidental shared mutable state across the whole walk.
  const minted = new Set<string>([rel]);
  walkNamedChildren(root.namedChildren, ctx, nodes, rawEdges, minted);
  // nodes[0] is the file node; the rest are its symbols. Index the module-level
  // residual on the file node so a term outside every symbol still surfaces it.
  nodes[0].body_text = fileResidual(source, nodes.slice(1));
  return { nodes, rawEdges };
}

/** Mint-time uniqueness: a document-order duplicate (same name reopened, or two
 * sibling defs that happen to collide) gets `~2`, `~3`, ... instead of silently
 * shadowing the first. The while-loop (not a single `~2` guess) is what makes
 * this collision-proof: a source name that itself ends in ~N would collide
 * with a single-guess suffix, so this keeps incrementing until it finds a
 * truly free id rather than trusting one candidate suffix is unused. */
export function mintId(base: string, minted: Set<string>): string {
  let id = base;
  let k = 2;
  while (minted.has(id)) id = `${base}~${k++}`;
  minted.add(id);
  return id;
}

/**
 * tree-sitter-php 0.23.x cannot parse a `const` inside an enum body (#145). An
 * array initializer collapses the whole `enum_declaration` into ERROR; the
 * method is recovered as a sibling `function_definition`. 0.24.2 parses this
 * natively but is ABI 15 and cannot load on Graft's tree-sitter 0.21.1.
 *
 * Bound: only an ERROR that already contains `enum_case` + `name` is treated as
 * a collapsed enum. Only `const_declaration` / `function_definition` /
 * `method_declaration` / ERROR siblings are absorbed, stopping at a `}` ERROR.
 * Unknown ERROR nodes are still walked, never mapped to a type. Clean
 * class/enum trees are `class_declaration` / `enum_declaration` and skip this.
 */
function phpCollapsedEnumName(node: SyntaxNode): string | null {
  if (node.type !== "ERROR") return null;
  if (!node.namedChildren.some((c) => c.type === "enum_case")) return null;
  return node.namedChildren.find((c) => c.type === "name")?.text ?? null;
}

function phpCollapsedEnumHold(node: SyntaxNode): boolean {
  return (
    node.type === "const_declaration" ||
    node.type === "function_definition" ||
    node.type === "method_declaration" ||
    node.type === "ERROR"
  );
}

function phpCollapsedEnumClose(node: SyntaxNode): boolean {
  return node.type === "ERROR" && node.text.trim() === "}";
}

function walkNamedChildren(
  children: SyntaxNode[],
  ctx: WalkCtx,
  out: NodeV1[],
  edges: RawEdge[],
  minted: Set<string>,
): void {
  if (ctx.lang !== "php") {
    for (const child of children) walk(child, ctx, out, edges, minted);
    return;
  }
  for (let i = 0; i < children.length; ) {
    const n = children[i]!;
    const enumName = phpCollapsedEnumName(n);
    if (enumName) {
      const group: SyntaxNode[] = [n];
      let j = i + 1;
      while (j < children.length && phpCollapsedEnumHold(children[j]!)) {
        const next = children[j]!;
        group.push(next);
        j++;
        if (phpCollapsedEnumClose(next)) break;
      }
      emitPhpCollapsedEnum(enumName, n, group, ctx, out, edges, minted);
      i = j;
      continue;
    }
    walk(n, ctx, out, edges, minted);
    i++;
  }
}

function emitPhpCollapsedEnum(
  name: string,
  errorNode: SyntaxNode,
  group: SyntaxNode[],
  ctx: WalkCtx,
  out: NodeV1[],
  edges: RawEdge[],
  minted: Set<string>,
): void {
  const last = group[group.length - 1]!;
  const id = mintId(`${ctx.rel}#${[...ctx.scope, name].join(".")}`, minted);
  const body = ctx.source.slice(errorNode.startIndex, last.endIndex);
  out.push({
    id,
    name,
    kind: "enum",
    path: ctx.rel,
    span: `L${errorNode.startPosition.row + 1}-L${last.endPosition.row + 1}`,
    signature: `enum ${name}`,
    exported: true,
    origin: "ast",
    body_hash: contentHash(body),
    body_text: searchBody(body),
    summary_state: "pending",
    summary: null,
    crux: null,
  });
  edges.push({ source: ctx.parentId, relation: "contains", targetId: id, file: ctx.rel });
  const childCtx: WalkCtx = {
    ...ctx,
    scope: [...ctx.scope, name],
    enclosingKind: "enum",
    parentId: id,
  };
  for (const g of group) {
    if (phpCollapsedEnumClose(g)) continue;
    if (phpCollapsedEnumName(g)) {
      walkNamedChildren(g.namedChildren, childCtx, out, edges, minted);
      continue;
    }
    walk(g, childCtx, out, edges, minted);
  }
}

function walk(node: SyntaxNode, ctx: WalkCtx, out: NodeV1[], edges: RawEdge[], minted: Set<string>): void {
  const desc = describe(node, ctx);
  if (desc) {
    // `idName` scopes the id (e.g. a Go method under its receiver: `#DB.Count`) while
    // `name` stays the bare symbol name so member-call resolution matches it.
    const idPart = desc.idName ?? desc.name;
    const base = `${ctx.rel}#${[...ctx.scope, idPart].join(".")}`;
    const id = mintId(base, minted);
    const isGoMethod = ctx.lang === "go" && node.type === "method_declaration";
    // The bare name of this node's OWN immediate enclosing class/receiver â€” for a
    // Go method that's its receiver type (methods aren't nested, so ctx.enclosingClass
    // wouldn't see it); for an R S3/S4 method it's the qualifier/class describeR
    // already resolved (desc.owner â€” these don't lexically nest inside their class
    // either); for every other method it's simply what the nearest ancestor class
    // already set as ctx.enclosingClass. Only method nodes carry it â€” resolve.ts's
    // ownerMethod index is the sole consumer (see NodeV1.owner's doc comment).
    const owner: string | undefined =
      desc.kind === "method"
        ? (isGoMethod ? (goReceiverType(node) ?? undefined) : (desc.owner ?? ctx.enclosingClass ?? undefined))
        : undefined;
    out.push({
      id,
      name: desc.name,
      kind: desc.kind,
      path: ctx.rel,
      span: `L${desc.hashNode.startPosition.row + 1}-L${desc.hashNode.endPosition.row + 1}`,
      signature: clean(ctx.source.slice(desc.hashNode.startIndex, desc.headerEnd)),
      exported:
        ctx.lang === "python"
          ? !desc.name.startsWith("_")
          : ctx.lang === "go"
            ? goExported(desc.name)
            : ctx.lang === "r"
              ? rExported(desc.name, ctx, node)
              : ctx.lang === "java"
                ? javaExported(node)
                : ctx.lang === "kotlin"
                  ? kotlinExported(node)
                  : ctx.lang === "swift"
                    ? swiftExported(node)
                    : ctx.lang === "php"
                      ? phpExported(node)
                      : ctx.lang === "c_sharp"
                        ? csharpExported(asNative(node))
                        : ctx.lang === "groovy"
                          ? groovyExported(asNative(node))
                          : ctx.lang === "plsql"
                            ? true
                            : ctx.lang === "c" || ctx.lang === "cpp"
                              ? cExported(asNative(node))
                              : tsExported(node),
      origin: "ast",
      body_hash: contentHash(desc.hashNode.text),
      body_text: searchBody(desc.hashNode.text),
      summary_state: "pending",
      summary: null,
      crux: null,
      ...(owner !== undefined ? { owner } : {}),
      ...(desc.arity !== undefined ? { arity: desc.arity } : {}),
      ...(desc.variadic ? { variadic: true } : {}),
    });
    // structural containment
    edges.push({ source: ctx.parentId, relation: "contains", targetId: id, file: ctx.rel });
    // class heritage â€” in Java an interface may also `extends`, and a record/enum
    // may `implements`, so every type declaration is a heritage site, not just a class.
    const javaTypeDecl = ctx.lang === "java" && JAVA_TYPE_KINDS.has(desc.kind);
    const kotlinTypeDecl = ctx.lang === "kotlin" && KOTLIN_TYPE_KINDS.has(desc.kind);
    const swiftTypeDecl = ctx.lang === "swift" && SWIFT_TYPE_KINDS.has(desc.kind);
    // C#: `class C : Base, IFace` â€” a base_list hangs off every type declaration
    // (class/struct/interface), so all of them are heritage sites, not just classes.
    const csharpTypeDecl =
      ctx.lang === "c_sharp" && (desc.kind === "class" || desc.kind === "interface" || desc.kind === "struct");
    // C++: a base_class_clause hangs off a class/struct declaration.
    const cppTypeDecl = ctx.lang === "cpp" && (desc.kind === "class" || desc.kind === "struct");
    if (desc.kind === "class" || javaTypeDecl || kotlinTypeDecl || swiftTypeDecl || csharpTypeDecl || cppTypeDecl)
      edges.push(...heritageEdges(node, id, ctx));
    if (ctx.lang === "php") edges.push(...phpAttributeReferenceEdges(node, id, ctx));
    if (ctx.lang === "java") edges.push(...javaAnnotationReferenceEdges(node, id, ctx));

    const enclosingClass =
      desc.kind === "class" || javaTypeDecl || kotlinTypeDecl || swiftTypeDecl || csharpTypeDecl || cppTypeDecl
        ? desc.name
        : isGoMethod
          ? goReceiverType(node)
          : (desc.owner ?? ctx.enclosingClass);
    const childCtx: WalkCtx = {
      ...ctx,
      scope: [...ctx.scope, idPart],
      enclosingKind: desc.kind,
      parentId: id,
      enclosingClass,
      goReceiverVar: isGoMethod ? goReceiverVarOf(node) : ctx.goReceiverVar,
      importedSymbols:
        desc.kind === "function" || desc.kind === "method"
          ? withoutShadowedImports(ctx.importedSymbols, node)
          : ctx.importedSymbols,
      // Reset on every new definition â€” this is a purely local marker for "we're
      // still inside THIS class-defining call's own public=/private=/active=
      // argument chain," not something that should leak into a nested definition
      // (a method's own body, or â€” vanishingly rare but possible â€” another class
      // defined inside one).
      rR6Access: null,
      // Unlike rR6Access, only reset when entering a genuinely new class (so it
      // stays live through a method's whole body, where super$ / super. calls
      // actually happen) â€” inherited unchanged for every other definition kind.
      // Swift reads it off the declaration's own `:` clause, so `super.ping()`
      // resolves against the PARENT type, not the overriding current one.
      rSuperClass:
        desc.kind === "class"
          ? ctx.lang === "r"
            ? rR6ParentClass(node)
            : ctx.lang === "swift"
              ? swiftSuperClassName(node)
              : null
          : ctx.rSuperClass,
    };
    walkNamedChildren(node.namedChildren, childCtx, out, edges, minted);
    return;
  }

  // R6 (Phase 2): `public =`/`private =`/`active =` inside an R6Class(...) call's
  // own arguments is a `list(...)` call whose named entries become methods â€”
  // this is R's version of a class body, but structurally it's several levels of
  // ordinary call/argument nodes rather than a dedicated grammar construct, so it
  // needs its own interception (mirrors how every other stateful/pattern-matched
  // R construct in this walk needs one). `ctx.enclosingKind === "class"` scopes
  // this to the class-defining call's own direct structure â€” once we're inside
  // an actual method's body, enclosingKind has moved on to "method" and an
  // unrelated nested `list(public = list(fn = function() {}))` elsewhere won't
  // be misread as another class body.
  if (
    ctx.lang === "r" &&
    ctx.enclosingKind === "class" &&
    ctx.rR6Access === null &&
    node.type === "argument"
  ) {
    const argName = node.childForFieldName("name");
    const value = node.childForFieldName("value");
    if (
      argName?.type === "identifier" &&
      (argName.text === "public" || argName.text === "private" || argName.text === "active") &&
      value?.type === "call" &&
      rCalleeName(value) === "list"
    ) {
      const access = argName.text;
      for (const entry of rCallArgs(value)) {
        walk(entry, { ...ctx, rR6Access: access }, out, edges, minted);
      }
      return;
    }
  }

  // not a definition â€” capture calls/imports/references, then descend with the same context
  // R's `call` node is also its ONLY vehicle for library()/require()/source() â€”
  // there's no separate import-statement grammar construct to key off, so isImport
  // must be checked before the generic calls path or every import call would be
  // captured as a (harmlessly unresolvable, but wrong) `calls` edge instead.
  const callTypes = CALL_TYPES[ctx.lang];
  if (isImport(node, ctx.lang)) {
    const spec = importSpecifier(node, ctx.lang);
    if (spec) edges.push({ source: ctx.rel, relation: "imports", specifier: spec, file: ctx.rel });
    // Imported identifiers are declarations, not uses. The import-binding pass
    // above already recorded them, so do not descend and emit false references.
    return;
  } else if (callTypes.has(node.type)) {
    // R6Class(...) / a Phase-5 mixin list(...) is already consumed by its
    // enclosing binary_operator as the class definition (see describeR) â€” the
    // walk still reaches this SAME call node again, recursing generically to
    // find its public=/private=/active= arguments (there's no other path to
    // them), and it must not ALSO be treated as an ordinary call to a
    // function literally named "R6Class"/"list".
    const consumedCallee = ctx.lang === "r" && node.type === "call" ? rCalleeName(node) : null;
    const isConsumedRClassCall =
      consumedCallee === "R6Class" || (consumedCallee === "list" && rIsMixinContainer(node));
    const callee = isConsumedRClassCall ? null : calleeName(node, ctx.lang);
    if (callee) {
      const callEdge: RawEdge = {
        source: ctx.parentId,
        relation: "calls",
        name: callee.name,
        viaMember: callee.viaMember,
        file: ctx.rel,
        ...(callee.kinds ? { kinds: callee.kinds } : {}),
      };
      // Overloading languages: the call site's argument count, to pick the right
      // overload (see RawEdge.argCount).
      const argCount =
        ctx.lang === "java" ? javaArgCount(node) : ctx.lang === "swift" ? swiftArgCount(node) : undefined;
      if (argCount !== undefined) callEdge.argCount = argCount;
      // Swift: a bare lowercase call inside a type body may be an implicit-`self`
      // member call (`walk()` for `self.walk()`), syntactically indistinguishable
      // from a free-function call â€” and Swift's own lookup is member-FIRST (inner
      // scope wins). So the edge is emitted as the member reading, typed to the
      // enclosing class â€” resolved through the owner-qualified method index and
      // the class's in-repo ancestor chain (`clearLogs()` in a test subclass
      // finds the base class's method) â€” with `implicitSelf` letting resolve.ts
      // fall back to the free-function reading only when no member exists on the
      // chain. One edge, both readings, language-order precedence. This is
      // deliberately NOT a bare-name kind widening: dogfooding on
      // swift-composable-architecture, a global unique-name match bound
      // `contains(element)` inside `extension Set` â€” a stdlib call â€” to an
      // unrelated type's only in-repo `contains`. And not for an UpperCamelCase
      // callee: that is an initializer call (`Text("hi")`), which takes
      // resolve.ts's class/struct/enum fallback instead â€” extension nodes (kind
      // "module") can never false-match it.
      const swiftImplicitSelf =
        ctx.lang === "swift" &&
        !callee.viaMember &&
        !callee.kinds &&
        ctx.enclosingClass &&
        !/^[A-Z]/.test(callee.name);
      if (swiftImplicitSelf) {
        edges.push({
          ...callEdge,
          viaMember: true,
          recvType: ctx.enclosingClass!,
          implicitSelf: true,
        });
      } else {
        // PL/SQL: the receiver of `pkg.proc()` is already the owning package's
        // name â€” there is no variable to type â€” so it goes through verbatim and
        // resolve.ts matches it against package nodes.
        const recvType = ctx.lang === "plsql" ? callee.receiver : resolveRecvType(callee.receiver, ctx);
        edges.push(recvType ? { ...callEdge, recvType } : callEdge);
      }
    }
  } else if (ctx.lang === "php" && node.type === "use_declaration") {
    // Trait composition inside a class body (`use HasFactory, Notifiable;`).
    // Modelled as `implements`: like an interface, a trait is a contract of
    // behaviour the class mixes in (Graft's Relation set has no `uses`).
    for (const t of node.namedChildren) {
      if (t.type === "name" || t.type === "qualified_name") {
        edges.push({ source: ctx.parentId, relation: "implements", name: t.text.replace(/^.*\\/, ""), file: ctx.rel });
      }
    }
    return;
  } else if (
    node.type === "identifier" &&
    !isDirectCallee(node, callTypes) &&
    !isDeclarationName(node)
  ) {
    const imported = ctx.importedSymbols.get(node.text);
    if (imported) {
      edges.push({
        source: ctx.parentId,
        relation: "references",
        name: imported.name,
        specifier: imported.specifier,
        file: ctx.rel,
      });
    }
  }

  // Java anonymous class (`new Type() { â€¦ }`): tree-sitter-java has no
  // `anonymous_class` node (unlike PHP) â€” the body is an optional `class_body`
  // on `object_creation_expression`. Mint `{anonymous}` (mirroring PHP #144 /
  // `{closure}`) so nested methods take that owner instead of the enclosing
  // type's, which otherwise pollutes `ownerMethod` and steals real call edges
  // (#161). The constructor call edge above still fires for `new Type()`.
  if (ctx.lang === "java" && node.type === "object_creation_expression") {
    const body = node.namedChildren.find((c) => c.type === "class_body");
    if (body) {
      const idPart = "{anonymous}";
      const base = `${ctx.rel}#${[...ctx.scope, idPart].join(".")}`;
      const id = mintId(base, minted);
      out.push({
        id,
        name: "{anonymous}",
        kind: "class",
        path: ctx.rel,
        span: `L${node.startPosition.row + 1}-L${node.endPosition.row + 1}`,
        signature: clean(ctx.source.slice(node.startIndex, body.startIndex)),
        exported: false,
        origin: "ast",
        body_hash: contentHash(node.text),
        body_text: searchBody(node.text),
        summary_state: "pending",
        summary: null,
        crux: null,
      });
      edges.push({ source: ctx.parentId, relation: "contains", targetId: id, file: ctx.rel });
      // Single supertype from `new Type()`: emit `implements` so an interface
      // target resolves (adapters are the common case; a class target drops
      // under resolve's implements kind filter â€” drop-not-guess).
      const superName = javaConstructedTypeName(node.childForFieldName("type"));
      if (superName) {
        edges.push({ source: id, relation: "implements", name: superName, file: ctx.rel });
      }
      const anonCtx: WalkCtx = {
        ...ctx,
        scope: [...ctx.scope, idPart],
        enclosingKind: "class",
        parentId: id,
        enclosingClass: "{anonymous}",
      };
      for (const child of node.namedChildren) {
        walk(child, child.type === "class_body" ? anonCtx : ctx, out, edges, minted);
      }
      return;
    }
  }

  for (const child of node.namedChildren) walk(child, ctx, out, edges, minted);
}

/**
 * Named imports whose local binding can be recognized later as a symbol use.
 * Namespace/default imports are intentionally excluded: they do not tell us
 * the exported symbol name, so wiring them would require guessing.
 */
function collectImportedSymbols(
  root: SyntaxNode,
  lang: Language,
): Map<string, { name: string; specifier: string }> {
  if (lang === "typescript" || lang === "tsx") {
    const out = new Map<string, { name: string; specifier: string }>();
    const visit = (node: SyntaxNode): void => {
      if (node.type === "import_statement") {
        const specifier = importSpecifier(node, lang);
        if (!specifier) return;
        collectTsImportBindings(node, specifier, out);
        return;
      }
      for (const child of node.namedChildren) visit(child);
    };
    visit(root);
    return out;
  }
  if (lang === "php") return collectPhpImportedSymbols(root);
  return new Map();
}

/** PHP `use` bindings: local alias â†’ { exported name, FQN specifier }. */
function collectPhpImportedSymbols(root: SyntaxNode): Map<string, { name: string; specifier: string }> {
  const out = new Map<string, { name: string; specifier: string }>();
  const visit = (node: SyntaxNode): void => {
    if (node.type === "namespace_use_declaration") {
      collectPhpUseDeclaration(node, out);
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return out;
}

function collectPhpUseDeclaration(
  decl: SyntaxNode,
  out: Map<string, { name: string; specifier: string }>,
): void {
  const prefix = decl.namedChildren.find((c) => c.type === "namespace_name")?.text.replace(/\\$/, "") ?? "";
  const clauses: SyntaxNode[] = [];
  for (const child of decl.namedChildren) {
    if (child.type === "namespace_use_clause") clauses.push(child);
    if (child.type === "namespace_use_group") {
      for (const c of child.namedChildren) {
        if (c.type === "namespace_use_clause") clauses.push(c);
      }
    }
  }
  for (const clause of clauses) {
    const binding = phpUseClauseBinding(clause, prefix);
    if (binding) out.set(binding.local, { name: binding.name, specifier: binding.specifier });
  }
}

function phpUseClauseBinding(
  clause: SyntaxNode,
  prefix: string,
): { local: string; name: string; specifier: string } | null {
  const names = clause.namedChildren.filter((c) => c.type === "name");
  const qualified = clause.namedChildren.find((c) => c.type === "qualified_name");
  let fqn: string;
  let importedName: string;
  if (qualified) {
    fqn = qualified.text.replace(/^\\/, "");
    importedName = fqn.replace(/^.*\\/, "");
  } else if (names[0]) {
    importedName = names[0].text;
    fqn = prefix ? `${prefix}\\${importedName}` : importedName;
  } else {
    return null;
  }
  const alias =
    qualified && names.length >= 1
      ? names[names.length - 1].text
      : names.length >= 2
        ? names[1].text
        : undefined;
  const local = alias ?? importedName;
  return { local, name: importedName, specifier: fqn };
}

/** PHP 8 attributes on a definition â†’ `references` edges to the attribute class. */
function phpAttributeReferenceEdges(node: SyntaxNode, sourceId: string, ctx: WalkCtx): RawEdge[] {
  const edges: RawEdge[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== "attribute_list") continue;
    for (const group of child.namedChildren) {
      if (group.type !== "attribute_group") continue;
      for (const attr of group.namedChildren) {
        if (attr.type !== "attribute") continue;
        const ref = phpAttributeClassRef(attr, ctx);
        if (ref) {
          edges.push({
            source: sourceId,
            relation: "references",
            name: ref.name,
            ...(ref.specifier ? { specifier: ref.specifier } : {}),
            file: ctx.rel,
          });
        }
      }
    }
  }
  return edges;
}

function phpAttributeClassRef(
  attr: SyntaxNode,
  ctx: WalkCtx,
): { name: string; specifier?: string } | null {
  const nameNode =
    attr.childForFieldName("name") ??
    attr.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name");
  if (!nameNode) return null;
  if (nameNode.type === "qualified_name") {
    const fqn = nameNode.text.replace(/^\\/, "");
    return { name: fqn.replace(/^.*\\/, ""), specifier: fqn };
  }
  const bare = nameNode.text;
  const imported = ctx.importedSymbols.get(bare);
  if (imported) return { name: imported.name, specifier: imported.specifier };
  return { name: bare };
}

/** Java annotations on a definition â†’ `references` edges to the annotation type. */
function javaAnnotationReferenceEdges(node: SyntaxNode, sourceId: string, ctx: WalkCtx): RawEdge[] {
  const edges: RawEdge[] = [];
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return edges;
  for (const child of mods.namedChildren) {
    if (child.type !== "marker_annotation" && child.type !== "annotation") continue;
    const name = javaAnnotationTypeName(child);
    if (name) {
      edges.push({
        source: sourceId,
        relation: "references",
        name,
        file: ctx.rel,
      });
    }
  }
  return edges;
}

/** The type named by `@Foo` / `@a.b.Foo(...)`. Arguments are ignored (issue #89).
 * A scoped name is kept whole, matching heritage: a bare last segment would
 * false-match an unrelated in-repo type (#103). */
function javaAnnotationTypeName(anno: SyntaxNode): string | null {
  const nameNode = anno.childForFieldName("name");
  if (!nameNode) return null;
  if (nameNode.type === "identifier" || nameNode.type === "scoped_identifier") return nameNode.text;
  return null;
}

function collectTsImportBindings(
  node: SyntaxNode,
  specifier: string,
  out: Map<string, { name: string; specifier: string }>,
): void {
  if (node.type === "import_specifier") {
    const name = node.childForFieldName("name")?.text;
    const local = node.childForFieldName("alias")?.text ?? name;
    if (name && local) out.set(local, { name, specifier });
    return;
  }
  for (const child of node.namedChildren) collectTsImportBindings(child, specifier, out);
}

/**
 * Do these two wrappers stand for the same syntax node? `===` does not answer that:
 * node-tree-sitter materializes `SyntaxNode` objects on demand and caches them
 * weakly, so reaching one node twice can return two different JS objects. Comparing
 * wrappers makes a purely syntactic question depend on collector timing â€” two cold
 * builds of unchanged source then disagree on `references` edges (#116).
 *
 * `id` is the stable identity, unique within one tree, so the tree is compared too.
 * A `Tree` is one object per parse (unlike its nodes), so `===` is right for it.
 */
function sameSyntaxNode(
  a: SyntaxNode | null | undefined,
  b: SyntaxNode | null | undefined,
): boolean {
  return !!a && !!b && a.tree === b.tree && a.id === b.id;
}

/**
 * A parameter or local declaration wins over an import inside that function.
 * Drop that imported binding for the whole function rather than create a false
 * dependency. Nested functions are separate scopes and filter themselves.
 */
function withoutShadowedImports(
  imports: ReadonlyMap<string, { name: string; specifier: string }>,
  definition: SyntaxNode,
): ReadonlyMap<string, { name: string; specifier: string }> {
  if (imports.size === 0) return imports;
  const shadowed = new Set<string>();
  const definitionValue = definition.childForFieldName("value");
  const visit = (node: SyntaxNode): void => {
    if (!sameSyntaxNode(node, definition) && !sameSyntaxNode(node, definitionValue) && isFunctionBoundary(node)) {
      const name = node.childForFieldName("name");
      if (name?.type === "identifier") shadowed.add(name.text);
      return;
    }
    if (node.type === "variable_declarator") {
      const name = node.childForFieldName("name");
      if (name?.type === "identifier") shadowed.add(name.text);
    } else if (node.type === "required_parameter" || node.type === "optional_parameter") {
      const pattern = node.childForFieldName("pattern");
      if (pattern?.type === "identifier") shadowed.add(pattern.text);
    } else if (node.type === "identifier" && node.parent?.type === "formal_parameters") {
      shadowed.add(node.text);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(definition);
  if (![...shadowed].some((name) => imports.has(name))) return imports;
  return new Map([...imports].filter(([local]) => !shadowed.has(local)));
}

function isFunctionBoundary(node: SyntaxNode): boolean {
  return (
    node.type === "function_declaration" ||
    node.type === "generator_function_declaration" ||
    node.type === "method_definition" ||
    node.type === "arrow_function" ||
    node.type === "function_expression" ||
    node.type === "function"
  );
}

/** A direct invocation already emits a stronger `calls` edge. Java names the callee
 * in a `name` field (there is no `function` field on `method_invocation`), so both
 * spellings count. */
function isDirectCallee(node: SyntaxNode, callTypes: ReadonlySet<string>): boolean {
  const parent = node.parent;
  if (!parent || !callTypes.has(parent.type)) return false;
  return (
    sameSyntaxNode(parent.childForFieldName("function"), node) ||
    sameSyntaxNode(parent.childForFieldName("name"), node)
  );
}

/** Definition/declaration identifiers name a new binding; they do not use one. */
function isDeclarationName(node: SyntaxNode): boolean {
  const parent = node.parent;
  return sameSyntaxNode(parent?.childForFieldName("name"), node);
}

/** Recognize the definition shapes: mapped node types, Go's type/method forms, and
 * TS arrow-consts. */
function describe(node: SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  if (ctx.lang === "go") return describeGo(node, ctx);
  if (ctx.lang === "r") return describeR(node, ctx);
  if (ctx.lang === "java") return describeJava(node, ctx);
  if (ctx.lang === "kotlin") return describeKotlin(node, ctx);
  if (ctx.lang === "swift") return describeSwift(node, ctx);
  if (ctx.lang === "groovy") return describeGroovy(asNative(node), ctx);
  if (ctx.lang === "plsql") return describePlSql(asNative(node), ctx);
  if (ctx.lang === "c") return describeC(asNative(node), ctx);
  if (ctx.lang === "cpp") return describeCpp(asNative(node), ctx);

  // PHP closures: `$h = function () {â€¦}` / `fn() => â€¦`, and bare callbacks
  // (`$routes->get('/x', function () {â€¦})`). Captured as function nodes so a
  // closure-only file (a routing table, a DI container) keeps its structure
  // and the calls inside attribute to the closure, not the file.
  if (ctx.lang === "php" && (node.type === "anonymous_function" || node.type === "arrow_function")) {
    const body = node.childForFieldName("body");
    return {
      name: phpClosureName(node),
      kind: "function",
      headerEnd: body ? body.startIndex : node.endIndex,
      hashNode: node,
    };
  }

  // PHP anonymous classes (`new class implements I {â€¦}`): minted as a class
  // node named `{anonymous}` (mirroring `{closure}`, deduplicated per file by
  // mintId). Without this the type vanished â€” no node, no heritage edge â€” and
  // its methods mis-attributed to the enclosing function (issue #144). The
  // class kind makes the walk emit heritageEdges (base_clause /
  // class_interface_clause are direct children) and own the nested methods.
  if (ctx.lang === "php" && node.type === "anonymous_class") {
    const body = node.childForFieldName("body");
    return {
      name: "{anonymous}",
      kind: "class",
      headerEnd: body ? body.startIndex : node.endIndex,
      hashNode: node,
    };
  }

  const mapped = ctx.kinds[node.type];
  if (mapped) {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    let kind = mapped;
    if (ctx.lang === "python" && mapped === "function" && ctx.enclosingKind === "class") {
      kind = "method";
    }
    // tree-sitter-php 0.23.x recovers a collapsed enum method as function_definition
    // at program scope; walkNamedChildren reparents it under the enum, and this
    // promotion is what keeps the kind `method` rather than a leaked `function`.
    if (ctx.lang === "php" && mapped === "function" && ctx.enclosingKind === "enum") {
      kind = "method";
    }
    const body = node.childForFieldName("body");
    return { name, kind, headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
  }

  // TS: `const foo = (â€¦) => â€¦` / `const foo = function () {}`
  if ((ctx.lang === "typescript" || ctx.lang === "tsx") && node.type === "variable_declarator") {
    const value = node.childForFieldName("value");
    if (value && FUNCTION_VALUE_TYPES.has(value.type)) {
      const name = node.childForFieldName("name")?.text;
      if (!name) return null;
      const vbody = value.childForFieldName("body");
      return {
        name,
        kind: "function",
        headerEnd: vbody ? vbody.startIndex : node.endIndex,
        hashNode: node,
      };
    }
  }
  return null;
}

/** Go definition shapes: top-level funcs, receiver methods, and named types
 * (struct / interface / type alias). Methods carry no nesting â€” they're qualified
 * by their receiver type (`User.Save`) so calls can resolve and cards read clearly. */
function describeGo(node: SyntaxNode, _ctx: WalkCtx): DefDescriptor | null {
  if (node.type === "function_declaration") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    const body = node.childForFieldName("body");
    return { name, kind: "function", headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
  }

  if (node.type === "method_declaration") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    const recv = goReceiverType(node);
    const body = node.childForFieldName("body");
    // Bare `name` (so `recv.Method()` calls resolve); receiver-qualified `idName`
    // (so the id is `file.go#Receiver.Method` and stays unique per receiver).
    return {
      name,
      idName: recv ? `${recv}.${name}` : name,
      kind: "method",
      headerEnd: body ? body.startIndex : node.endIndex,
      hashNode: node,
    };
  }

  // `type Name <shape>` â€” one type_spec per name (grouped `type ( â€¦ )` yields several).
  if (node.type === "type_spec") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    const type = node.childForFieldName("type");
    const kind: Kind =
      type?.type === "struct_type" ? "struct" : type?.type === "interface_type" ? "interface" : "type";
    // Header ends where the body opens (`{`) for struct/interface, else the whole node
    // (a one-line alias like `type ID int`).
    const headerEnd = type && (kind === "struct" || kind === "interface") ? type.startIndex : node.endIndex;
    return { name, kind, headerEnd, hashNode: node };
  }

  return null;
}

/**
 * R definition shapes. `function_definition` carries no name field at all, so
 * unlike every other supported language the name always comes from an
 * enclosing assignment, detected here. The plain-function assignment check
 * (op-filtering `binary_operator`, the right-assign body-swap) is duplicated
 * in bindings.ts's own `rDefName` rather than imported â€” same reasoning as
 * this file's Go receiver helpers: bindings.ts can't take a value import back
 * on extract.ts. bindings.ts doesn't need the S3/S4/R6 half of this at all
 * (no handleR binding collector exists â€” see bindings.ts's own doc comment).
 *
 * Phase 1 (flat extraction â€” every named function is a plain `function` node)
 * plus Phase 2 (S3/S4/R6 class awareness, R's class systems being library
 * *convention* rather than grammar syntax, unlike every other language graft
 * supports):
 *   - left-assign (`<-`/`<<-`/`=`) / right-assign (`->`/`->>`) function
 *     assignment â€” Phase 1's shape, see the two `binary_operator`/
 *     `function_definition` branches below. Right-assign's AST shape does NOT
 *     mirror left-assign's the way it looks like it should (confirmed
 *     empirically, not assumed â€” R's `->` has low enough precedence that it's
 *     absorbed into the function's own `body` field as a `binary_operator`
 *     instead of the function sitting inside an outer wrapper); only an
 *     explicitly parenthesized `(function() {}) -> foo` produces the
 *     "expected" outer-wrapping shape, which isn't specially handled (falls
 *     through as an anonymous function).
 *   - `name.Class <- function() {}` â€” an S3 method, IF `name` is a known
 *     generic (registered locally via `UseMethod()` in this file, or one of a
 *     curated set of common base-R generics â€” see `rS3Split`'s doc comment
 *     for the false-positive risk this guards against).
 *   - `Foo <- R6::R6Class("Foo", public = list(...), private = list(...))` â€”
 *     an R6 class; its `public =`/`private =`/`active =` list entries become
 *     methods, handled by walk()'s own `argument`-node interception (this
 *     function only recognizes the class itself; the "a call defines a
 *     symbol" list-walking lives in walk() since it needs to mint several
 *     nodes, not describe a single one).
 *   - `Foo <- list(public = list(...), private = list(...))` (Phase 5) â€” a
 *     plain-list "mixin"/"extension" bundle, NOT wrapped in `R6::R6Class(...)`
 *     at all: a real, deliberate convention found dogfooding against a real
 *     R6-heavy corpus (25 files, 11 of them entirely invisible to the graph
 *     without this) for sharing method bundles across classes via splicing
 *     (`public = c(Foo$public, list(...))`) rather than `inherit =`. Only
 *     recognized when the list actually has a `public =`/`private =` entry
 *     (see `rIsMixinContainer`) â€” an ordinary data/config list never matches.
 *     Reuses kind "class" (nothing better-fitting exists, and everything
 *     downstream â€” the method-list walking, visibility â€” only cares that
 *     ctx.enclosingKind is "class", not how the container was spelled); no
 *     heritage edge, since splicing isn't `inherit =`-based inheritance.
 *   - `setClass("Foo", ...)` / `setMethod("generic", "Foo", function() {})`
 *     â€” S4 class/method calls, recognized as bare top-level `call` nodes
 *     (setClass/setMethod have side effects registering with the S4 system;
 *     they're essentially never assigned to a variable). `setGeneric()` is
 *     NOT specially extracted â€” it doesn't naturally map to a class or method
 *     kind, and the plan flags it as a case not worth the design risk.
 */
function describeR(node: SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  if (node.type === "binary_operator") {
    const op = node.childForFieldName("operator")?.text;
    if (!op || !R_ASSIGN_OPS.has(op)) return null;
    const lhs = node.childForFieldName("lhs");
    const rhs = node.childForFieldName("rhs");
    if (lhs?.type !== "identifier") return null;
    if (rhs?.type === "function_definition") {
      return rFunctionDescriptor(lhs.text, rhs, rhs.childForFieldName("body"), ctx);
    }
    if (rhs?.type === "call" && rCalleeName(rhs) === "R6Class") {
      // The class node itself; its public=/private=/active= method lists are
      // handled by walk()'s own `argument`-node interception, not here.
      return { name: lhs.text, kind: "class", headerEnd: rhs.endIndex, hashNode: rhs };
    }
    if (rhs?.type === "call" && rCalleeName(rhs) === "list" && rIsMixinContainer(rhs)) {
      // Phase 5: a plain-list mixin/extension bundle â€” same treatment as R6Class.
      return { name: lhs.text, kind: "class", headerEnd: rhs.endIndex, hashNode: rhs };
    }
    return null;
  }

  if (node.type === "function_definition") {
    // Right-assign (`function() {} -> foo`): see this function's own doc
    // comment for why this doesn't mirror the binary_operator branch above.
    const body = node.childForFieldName("body");
    if (body?.type !== "binary_operator") return null;
    const op = body.childForFieldName("operator")?.text;
    if (!op || !R_RIGHT_ASSIGN_OPS.has(op)) return null;
    const rhs = body.childForFieldName("rhs");
    if (rhs?.type !== "identifier") return null;
    return rFunctionDescriptor(rhs.text, node, body.childForFieldName("lhs"), ctx);
  }

  if (node.type === "call") {
    return describeRTopLevelCall(node);
  }

  // R6 (Phase 2): reached via walk()'s own `argument`-node interception for a
  // `public =`/`private =`/`active =` list entry â€” see the special case there
  // for why this can't just be a flat kind-table/node-type check like every
  // other definition shape.
  if (node.type === "argument" && ctx.rR6Access !== null) {
    const argName = node.childForFieldName("name");
    const value = node.childForFieldName("value");
    if (argName?.type !== "identifier" || value?.type !== "function_definition") return null;
    const body = value.childForFieldName("body");
    return {
      name: argName.text,
      kind: "method",
      headerEnd: body ? body.startIndex : value.endIndex,
      hashNode: value,
      // owner deliberately unset â€” R6 methods DO lexically nest inside the
      // class-defining call, so ctx.enclosingClass already has it.
    };
  }

  return null;
}

const R_ASSIGN_OPS = new Set(["<-", "<<-", "="]);
const R_RIGHT_ASSIGN_OPS = new Set(["->", "->>"]);

/** A plain function assignment (left- or right-assign), OR â€” if `name` matches
 * a known S3 generic's `generic.Class` pattern â€” an S3 method instead. `body`
 * is the function's REAL content node (already resolved by the caller for
 * either assignment direction), used only for `headerEnd`; `hashNode` is
 * always the `function_definition` itself. */
function rFunctionDescriptor(
  name: string,
  hashNode: SyntaxNode,
  body: SyntaxNode | null | undefined,
  ctx: WalkCtx,
): DefDescriptor {
  const headerEnd = body ? body.startIndex : hashNode.endIndex;
  const s3 = rS3Split(name, ctx.rGenerics);
  if (s3) {
    return {
      name: s3.generic,
      idName: `${s3.className}.${s3.generic}`,
      kind: "method",
      headerEnd,
      hashNode,
      owner: s3.className,
    };
  }
  return { name, kind: "function", headerEnd, hashNode };
}

/**
 * S3 dispatch detection: does `name` split as `generic.Class` for some KNOWN
 * generic? Tries the longest possible generic prefix first (so a dotted
 * generic itself, like `as.character`, is found before a shorter false match)
 * and only ever matches a generic that's either registered locally via
 * `UseMethod()` in this file (see `collectRGenerics`) or in the small curated
 * `R_BASE_GENERICS` set below.
 *
 * This is the genuinely ambiguous part of R support the plan calls out:
 * `read.csv`, `data.frame`, and `as.character` used as an ordinary helper
 * name are NOT S3 dispatch, and nothing in the grammar distinguishes them
 * from `print.MyClass`. Erring toward the curated set staying small â€” a
 * missed S3 method (false negative, falls back to an ordinary `function`
 * node) is a much smaller problem than a false positive misfiling an
 * unrelated dotted-name function as some other class's method.
 */
function rS3Split(name: string, generics: ReadonlySet<string>): { generic: string; className: string } | null {
  const parts = name.split(".");
  if (parts.length < 2) return null;
  for (let i = parts.length - 1; i >= 1; i--) {
    const generic = parts.slice(0, i).join(".");
    if (generics.has(generic) || R_BASE_GENERICS.has(generic)) {
      return { generic, className: parts.slice(i).join(".") };
    }
  }
  return null;
}

/** Common base-R S3 generics worth assuming even without local evidence â€”
 * print.Foo/format.Foo etc. are the single most common real-world S3
 * pattern, and a local `UseMethod()` call will never exist for them (they
 * ship in base/methods/stats, not the user's own repo). Deliberately small
 * and unsurprising rather than exhaustive â€” see `rS3Split`'s doc comment. */
const R_BASE_GENERICS = new Set([
  "print",
  "format",
  "summary",
  "plot",
  "str",
  "toString",
  "as.character",
  "as.list",
  "as.data.frame",
  "as.vector",
  "as.numeric",
  "as.matrix",
  "length",
  "dim",
  "names",
  "rev",
  "sort",
  "unique",
  "predict",
  "coef",
  "residuals",
  "fitted",
  "update",
  "merge",
  "all.equal",
  "anova",
  "confint",
  "vcov",
  "logLik",
]);

/** Every S3 generic THIS file registers via a local `UseMethod()` call, so
 * `rS3Split` can recognize `generic.Class` methods for a repo's own generics,
 * not just the base-R ones. Runs once per file, ahead of the main walk (same
 * pre-pass shape as `collectImportedSymbols`). Cross-file generics â€” a
 * generic defined in one file, dispatched on in another â€” aren't found this
 * way; that would need a whole-repo pass extractFile has no visibility into,
 * the same limitation Go/C++'s per-file bindings already accept. */
function collectRGenerics(root: SyntaxNode): Set<string> {
  const generics = new Set<string>();
  const visit = (node: SyntaxNode): void => {
    let fnDef: SyntaxNode | null = null;
    let ownName: string | null = null;
    if (node.type === "binary_operator") {
      const op = node.childForFieldName("operator")?.text;
      const lhs = node.childForFieldName("lhs");
      const rhs = node.childForFieldName("rhs");
      if (op && R_ASSIGN_OPS.has(op) && lhs?.type === "identifier" && rhs?.type === "function_definition") {
        fnDef = rhs;
        ownName = lhs.text;
      }
    } else if (node.type === "function_definition") {
      const body = node.childForFieldName("body");
      if (body?.type === "binary_operator") {
        const op = body.childForFieldName("operator")?.text;
        const rhs = body.childForFieldName("rhs");
        if (op && R_RIGHT_ASSIGN_OPS.has(op) && rhs?.type === "identifier") {
          fnDef = node;
          ownName = rhs.text;
        }
      }
    }
    if (fnDef && ownName) {
      const arg = findUseMethodArg(fnDef.childForFieldName("body"));
      if (arg !== undefined) generics.add(arg || ownName); // "" means UseMethod() with no args
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return generics;
}

/** Searches a function body for a `UseMethod(...)` call and returns its
 * string-literal generic-name argument, `""` if called with no arguments
 * (defaults to the enclosing function's own name), or `undefined` if no
 * `UseMethod` call is found at all. */
function findUseMethodArg(node: SyntaxNode | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "call" && rCalleeName(node) === "UseMethod") {
    const first = rCallArgs(node)[0]?.childForFieldName("value");
    return first?.type === "string" ? (rStringContent(first) ?? "") : "";
  }
  for (const child of node.namedChildren) {
    const found = findUseMethodArg(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** S4: `setClass("Foo", ...)` â†’ a class; `setMethod("generic", "Foo",
 * function() {})` â†’ a method owned by "Foo". Both are ordinary top-level
 * `call` nodes â€” S4's registration functions have side effects and are
 * essentially never assigned to a variable, unlike R6Class. */
function describeRTopLevelCall(node: SyntaxNode): DefDescriptor | null {
  const callee = rCalleeName(node);
  if (callee === "setClass") {
    const first = rCallArgs(node)[0]?.childForFieldName("value");
    const name = first?.type === "string" ? rStringContent(first) : null;
    if (!name) return null;
    return { name, kind: "class", headerEnd: node.endIndex, hashNode: node };
  }
  if (callee === "setMethod") {
    const args = rCallArgs(node);
    const generic = args[0] ? rStringContent(args[0].childForFieldName("value") ?? null) : null;
    const className = args[1] ? rStringContent(args[1].childForFieldName("value") ?? null) : null;
    const defArg = args.find((a) => a.childForFieldName("name")?.text === "definition") ?? args[2];
    const fnDef = defArg?.childForFieldName("value");
    if (!generic || !className || fnDef?.type !== "function_definition") return null;
    const body = fnDef.childForFieldName("body");
    return {
      name: generic,
      idName: `${className}.${generic}`,
      kind: "method",
      headerEnd: body ? body.startIndex : fnDef.endIndex,
      hashNode: fnDef,
      owner: className,
    };
  }
  return null;
}

/** A call's callee name, whether bare (`R6Class(...)`) or namespace-qualified
 * (`R6::R6Class(...)`). Null if the callee isn't a simple name (e.g. itself a
 * call, or a `$`-based access). */
function rCalleeName(node: SyntaxNode): string | null {
  const fn = node.childForFieldName("function");
  if (fn?.type === "identifier") return fn.text;
  if (fn?.type === "namespace_operator") {
    const rhs = fn.childForFieldName("rhs");
    return rhs?.type === "identifier" ? rhs.text : null;
  }
  return null;
}

/** A call's positional/named `argument` children (skipping the `,`/`(`/`)`
 * punctuation tokens that share the `arguments` node's child list). */
function rCallArgs(node: SyntaxNode): SyntaxNode[] {
  return node.childForFieldName("arguments")?.namedChildren.filter((c) => c.type === "argument") ?? [];
}

/** An R `string` node's unquoted text, or null if `node` isn't a string. */
function rStringContent(node: SyntaxNode | null): string | null {
  if (node?.type !== "string") return null;
  const content = node.namedChildren.find((c) => c.type === "string_content");
  return content?.text ?? null;
}

/** The value of a call's named argument (`setClass("Foo", contains = "Base")`
 * â†’ the `contains` argument), or null if absent. */
function rNamedArg(node: SyntaxNode, argName: string): SyntaxNode | null {
  const arg = rCallArgs(node).find((a) => a.childForFieldName("name")?.text === argName);
  return arg?.childForFieldName("value") ?? null;
}

/** An R6 class-defining node's `inherit =` parent class name (a bare
 * identifier â€” the parent's own generator variable, not a string), for
 * `super$` call resolution (Phase 3). `node` is whatever describeR matched: a
 * binary_operator for R6 (`Foo <- R6::R6Class(...)`) or, for any other kind of
 * class (S4's setClass, which has no `super`), the call itself â€” always null
 * there since `rCalleeName(call) !== "R6Class"`. */
function rR6ParentClass(node: SyntaxNode): string | null {
  const call = node.type === "binary_operator" ? node.childForFieldName("rhs") : node;
  if (call?.type !== "call" || rCalleeName(call) !== "R6Class") return null;
  const value = rNamedArg(call, "inherit");
  return value?.type === "identifier" ? value.text : null;
}

/** Does this `list(...)` call look like a Phase-5 mixin/extension bundle â€”
 * i.e. does it have a `public =` or `private =` entry whose own value is
 * itself a `list(...)` call? This is the one check standing between "class-
 * like container" and an ordinary data/config list (`list(a = 1, b = 2)`,
 * or even one that happens to have a field named "public" holding something
 * else) â€” real code never coincidentally shapes plain data this way, so it's
 * a safe, precise signal without needing a naming-convention heuristic. */
function rIsMixinContainer(node: SyntaxNode): boolean {
  return rCallArgs(node).some((a) => {
    const name = a.childForFieldName("name")?.text;
    if (name !== "public" && name !== "private") return false;
    const value = a.childForFieldName("value");
    return value?.type === "call" && rCalleeName(value) === "list";
  });
}

/** A base-class name list from either a bare string (`contains = "Base"`) or
 * a `c(...)` call of strings (`contains = c("Base1", "Base2")`) â€” S4's
 * multiple-inheritance form. */
function rStringOrCVector(value: SyntaxNode | null): string[] {
  if (!value) return [];
  const single = rStringContent(value);
  if (single) return [single];
  if (value.type === "call" && rCalleeName(value) === "c") {
    return rCallArgs(value)
      .map((a) => rStringContent(a.childForFieldName("value")))
      .filter((s): s is string => !!s);
  }
  return [];
}

/** R6 visibility follows the `public =`/`private =`/`active =` section a
 * method was declared in (see walk()'s `argument`-node interception) â€”
 * `ctx.rR6Access` is only set for that direct span, so a plain function or an
 * S3/S4 method (neither of which has a real visibility concept) checks for a
 * roxygen `@export` tag next (Phase 3), falling back to the leading-dot naming
 * convention only when there's no roxygen evidence to go on at all. `node` is
 * the exact node describeR matched â€” see `rRoxygenExported`'s doc comment for
 * why that's always the right one to check for a preceding comment block. */
function rExported(name: string, ctx: WalkCtx, node: SyntaxNode): boolean {
  if (ctx.rR6Access !== null) return ctx.rR6Access !== "private";
  const roxygen = rRoxygenExported(node);
  if (roxygen !== null) return roxygen;
  return !name.startsWith(".");
}

/**
 * Roxygen `@export` detection (Phase 3): does `node` â€” a top-level definition
 * statement (a `binary_operator` assignment, a right-assigned
 * `function_definition`, or an S4 `setClass`/`setMethod` call) â€” have a
 * roxygen doc block immediately preceding it, and if so, is it tagged
 * `@export`?
 *
 * `comment` is a grammar EXTRA in this grammar (floats loosely between
 * sibling nodes rather than attaching to "the next statement" via a field),
 * so this walks backward through `previousNamedSibling` collecting a
 * contiguous run of `comment` nodes â€” the run ends at the first non-comment
 * sibling, or at the first comment that isn't itself a roxygen (`#'`) line,
 * either of which is roxygen's own "this block documents the next statement"
 * boundary.
 *
 * Returns:
 *  - `true` â€” a roxygen block was found and it contains `@export`.
 *  - `false` â€” a roxygen block was found but it does NOT contain `@export`.
 *    This is deliberately a confident "not exported," not "unknown": roxygen
 *    generates a package's NAMESPACE from exactly its `@export`-tagged items,
 *    so a documented-but-untagged function is an explicit "internal, for
 *    maintainers only" signal, not an absence of evidence.
 *  - `null` â€” no roxygen block at all, so the caller should fall back to the
 *    leading-dot naming convention instead of guessing.
 */
function rRoxygenExported(node: SyntaxNode): boolean | null {
  let sib = node.previousNamedSibling;
  let sawRoxygen = false;
  let exported = false;
  while (sib?.type === "comment") {
    const text = sib.text.trim();
    if (!text.startsWith("#'")) break; // an ordinary # comment ends the roxygen block
    sawRoxygen = true;
    if (/^#'\s*@export\b/.test(text)) exported = true;
    sib = sib.previousNamedSibling;
  }
  return sawRoxygen ? exported : null;
}

/** Java definition shapes. Uniform in a way Go's are not: every declaration carries
 * a `name` field and (for types and most members) a `body`, so one mapped lookup
 * covers classes, interfaces, enums, records, methods, and constructors. Methods are
 * lexically nested in their type, so â€” unlike Go â€” they need no receiver qualification. */
function describeJava(node: SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  const mapped = ctx.kinds[node.type];
  if (!mapped) return null;
  const name = node.childForFieldName("name")?.text;
  if (!name) return null;
  const body = node.childForFieldName("body");
  const desc: DefDescriptor = {
    name,
    kind: mapped,
    headerEnd: body ? body.startIndex : node.endIndex,
    hashNode: node,
  };
  // Only callables carry arity. A record declaration also has a `parameters` node,
  // but its components are not an overload set and must never be filtered against.
  if (node.type === "method_declaration" || node.type === "constructor_declaration") {
    const params = node.childForFieldName("parameters");
    if (params) {
      const declared = params.namedChildren.filter(
        (c) => c.type === "formal_parameter" || c.type === "spread_parameter",
      );
      desc.arity = declared.length;
      if (declared.some((c) => c.type === "spread_parameter")) desc.variadic = true;
    }
  }
  return desc;
}

/** Groovy definition shapes. The grammar is loose: a class body is a `closure`,
 * a method/function is a `function_definition` whose NAME is in the `function`
 * field (not `name`). A `function_definition` inside a class body reads as a
 * method; the same node at file scope is a free function. */
function describeGroovy(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  if (node.type === "class_definition") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    const body = node.childForFieldName("body");
    return { name, kind: "class", headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
  }
  if (node.type === "function_definition" || node.type === "function_declaration") {
    const name = node.childForFieldName("function")?.text;
    if (!name) return null;
    const body = node.childForFieldName("body");
    const kind: Kind = ctx.enclosingKind === "class" ? "method" : "function";
    return { name, kind, headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
  }
  return null;
}

/** PL/SQL definition shapes: a package spec/body (a module of sub-programs), a
 * procedure or function (declared in a spec, defined in a body, or standalone),
 * and a CREATE TABLE. The name lives in a role-specific field; a table's name is
 * the last (schema-stripped) identifier before its column list. Names may be
 * double-quoted â€” the quotes are part of the token, not the identifier. */
const PLSQL_NAME_FIELD: Record<string, string> = {
  create_package: "package_name",
  create_package_body: "package_name",
  create_procedure: "prc_name",
  procedure_declaration: "prc_name",
  procedure_definition: "prc_name",
  create_function: "fnc_name",
  function_declaration: "fnc_name",
  function_definition: "fnc_name",
};

function describePlSql(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  const kind = ctx.kinds[node.type];
  if (!kind) return null;
  let name: string | undefined;
  if (node.type === "create_table") {
    // `CREATE TABLE [schema.]name (â€¦)` â€” the object name is the last identifier
    // before the column list, so a schema qualifier drops off.
    name = node.namedChildren.filter((c) => c.type === "identifier").at(-1)?.text;
  } else if (node.type === "create_view") {
    name = node.namedChildren.find((c) => c.type === "identifier")?.text;
  } else {
    const field = PLSQL_NAME_FIELD[node.type];
    name = field ? node.childForFieldName(field)?.text : undefined;
  }
  name = name?.replace(/^"|"$/g, "");
  if (!name) return null;
  const body = node.childForFieldName("body");
  return { name, kind, headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
}

/** C definition shapes. A function's name is buried under its declarator
 * (`function_declarator â†’ identifier`, possibly wrapped by pointer_declarator);
 * struct/union/enum carry a `name` field. Anonymous aggregates are skipped. */
function describeC(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  const kind = ctx.kinds[node.type];
  if (!kind) return null;
  if (node.type === "function_definition" || node.type === "macro_function_definition") {
    const name =
      node.type === "function_definition"
        ? (declaratorIdent(node.childForFieldName("declarator")) ??
          // A head that is only a macro (`#if …  ISR(Isr)  #endif  { … }`).
          macroHeadName(node.namedChildren.find((c) => c.type === "macro_modifier")))
        : macroHeadName(node);
    if (!name) return null;
    const body = node.childForFieldName("body");
    return { name, kind: "function", headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
  }
  const name = node.childForFieldName("name")?.text;
  if (!name) return null; // anonymous struct/enum (e.g. inside a typedef) â€” skip
  const body = node.childForFieldName("body");
  return { name, kind, headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
}

/** The name of a function a C macro opens: its first argument when that is a
 * plain identifier (the test case in `COU_TEST(Case_001, "Init")`, the handler
 * in `ISR(Isr)`), else the macro's own name (`TEST_SETUP()`). */
function macroHeadName(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  const first = node.childForFieldName("arguments")?.namedChildren.find((c) => c.type !== "comment");
  if (first?.type === "identifier") return first.text;
  return node.childForFieldName("name")?.text ?? null;
}

/** C++ definition shapes: C's set plus classes, and a `function_definition`
 * resolved to a method when its declarator qualifies a type (`int Repo::Save(){â€¦}`
 * â†’ method Save, id-scoped under Repo) or when it sits directly in a class body.
 * Namespaces are transparent (not a scope segment), like C#. In-class method
 * DECLARATIONS (no body) are skipped â€” the out-of-line definition carries the body. */
function describeCpp(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  if (node.type === "function_definition") {
    const decl = node.childForFieldName("declarator");
    const name = declaratorIdent(decl);
    if (!name) return null;
    const owner = qualifiedOwner(decl);
    const body = node.childForFieldName("body");
    const headerEnd = body ? body.startIndex : node.endIndex;
    if (owner) return { name, idName: `${owner}.${name}`, kind: "method", headerEnd, hashNode: node };
    const kind: Kind = ctx.enclosingKind === "class" || ctx.enclosingKind === "struct" ? "method" : "function";
    return { name, kind, headerEnd, hashNode: node };
  }
  const kind = ctx.kinds[node.type];
  if (!kind) return null;
  const name = node.childForFieldName("name")?.text;
  if (!name) return null;
  const body = node.childForFieldName("body");
  return { name, kind, headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
}

/** The identifier a C/C++ declarator ultimately names, unwrapping pointer /
 * reference / array / function / parenthesized declarators. Returns the bare name
 * (`foo`), or the trailing segment of a C++ qualified declarator (`Save` from
 * `Repo::Save`); the qualifier is read separately by {@link qualifiedOwner}. */
function declaratorIdent(node: Parser.SyntaxNode | null | undefined): string | null {
  let n: Parser.SyntaxNode | null | undefined = node;
  while (n) {
    switch (n.type) {
      case "identifier":
      case "field_identifier":
      case "type_identifier":
        return n.text;
      case "qualified_identifier": {
        const name = n.childForFieldName("name") ?? n.namedChildren.at(-1);
        return name && name.id !== n.id ? declaratorIdent(name) : null;
      }
      default:
        if (!n.type.endsWith("declarator")) return null;
        n = n.childForFieldName("declarator") ?? n.namedChildren.find((c) => c.type.endsWith("declarator") || c.type.endsWith("identifier"));
    }
  }
  return null;
}

/** The owning type of a C++ qualified declarator (`Repo::Save` â†’ `Repo`), or null
 * for an unqualified name. */
function qualifiedOwner(node: Parser.SyntaxNode | null | undefined): string | null {
  let n = node;
  while (n) {
    if (n.type === "qualified_identifier") {
      const scope = n.childForFieldName("scope") ?? n.namedChildren[0];
      return scope?.text ?? null;
    }
    if (!n.type.endsWith("declarator")) return null;
    n = n.childForFieldName("declarator") ?? n.namedChildren.find((c) => c.type.endsWith("declarator") || c.type === "qualified_identifier");
  }
  return null;
}

/** C/C++ linkage: a `static` function is file-private; everything else is
 * externally visible (C has no other visibility concept). */
function cExported(node: Parser.SyntaxNode): boolean {
  return !node.namedChildren.some((c) => c.type === "storage_class_specifier" && c.text === "static");
}

/**
 * Constructs only C++ has, matched in a header's code with its comments, strings
 * and character literals blanked, its `#if(def) __cplusplus` branches left out and
 * its C23 attributes (`[[gnu::packed]]`) removed. Each one, measured on ~97,000
 * headers of large C/C++ code bases, parses better as C++ in nearly every header
 * that has it. A lone `class`, `::` or `template` in a comment no longer counts:
 * that sent thousands of C headers to the C++ grammar, which parsed them worse.
 */
const CPP_HEADER_SIGNS: readonly RegExp[] = [
  // class Foo {  /  class Foo : public Bar  /  struct Foo : public Bar
  /\b(?:class|struct)\s+(?:[A-Za-z_]\w*\s+)*[A-Za-z_]\w*\s*(?:final\s*)?:\s*(?:public|private|protected|virtual)\b|\bclass\s+(?:[A-Za-z_]\w*\s+)*[A-Za-z_]\w*\s*(?:final\s*)?\{/,
  /^\s*class\s+[A-Za-z_]\w*\s*;/m,
  /\bnamespace\s+[A-Za-z_][\w:]*\s*\{|\bnamespace\s*\{|\busing\s+namespace\s+[A-Za-z_]/,
  /\btemplate\s*<|\busing\s+[A-Za-z_]\w*\s*=/,
  /^\s*(?:public|private|protected)\s*:/m,
  /(?:\b[A-Za-z_]\w*|>)\s*::\s*~?[A-Za-z_]\w*|(?:^|[\s(,=])::\s*[A-Za-z_]/,
  /\b(?:virtual|constexpr|nullptr|static_cast|reinterpret_cast|const_cast|dynamic_cast|typename|noexcept|decltype)\b|\boperator\s*(?:[=!<>+\-*/%&|^~[(]|new\b|delete\b)/,
  /(?:=|return)\s*new\s+[A-Za-z_][\w:]*\s*[([;]|\bdelete(?:\s*\[\s*\]\s*|\s+)[A-Za-z_]\w*\s*;/,
  /^\s*#\s*include\s*<(?:iostream|ostream|istream|string|string_view|vector|map|set|memory|algorithm|cstdint|cstddef|cstring|cstdlib|cstdio|cmath|cassert|climits|cfloat|cstdarg|array|list|deque|utility|functional|type_traits|limits|sstream|fstream|iomanip|thread|mutex|atomic|chrono|tuple|optional|variant|any|unordered_map|unordered_set|new|exception|stdexcept|initializer_list|iterator|numeric|bitset|queue|stack|regex|random|condition_variable|future)>/m,
  // A declaration of a template type: `Vec<float64> speed;`
  /^\s*(?:(?:static|extern|const|mutable|inline)\s+)*[A-Za-z_]\w*\s*<\s*[A-Za-z_]\w*(?:\s*[*&])?(?:\s*,\s*[A-Za-z_0-9]\w*(?:\s*[*&])?)*\s*>\s*[*&]?\s*[A-Za-z_]\w*\s*[;=(,)[]/m,
];

/** Whether a `.h` header is C++ (so it should be parsed as C++ rather than C):
 * `extern "C++"`, an `extern "C"` outside the `#ifdef __cplusplus` branches
 * (C has no such thing, so a header that writes it unguarded is only ever
 * compiled as C++), or one of {@link CPP_HEADER_SIGNS} in its code. */
function looksLikeCpp(source: string): boolean {
  if (lastCppSniff?.source === source) return lastCppSniff.cpp;
  let cpp = /\bextern\s+"C\+\+"/.test(source);
  if (!cpp) {
    const code = headerCode(source);
    cpp = /\bextern\s+"C"/.test(code) || CPP_HEADER_SIGNS.some((re) => re.test(code));
  }
  lastCppSniff = { source, cpp };
  return cpp;
}
/** The build labels a header and then extracts it: both ask about the same text. */
let lastCppSniff: { source: string; cpp: boolean } | undefined;

/** Whether a header's `#if(def) __cplusplus` branches, which {@link looksLikeCpp}
 * leaves out, hold C++ code (classes, templates, `std::`), not just the
 * `extern "C" {` wrapper. A C parse of such a header fails on those branches. */
export function cppInGuardedBranches(source: string): boolean {
  if (!/\b__cplusplus\b/.test(source)) return false;
  const code = headerCode(source, true);
  return CPP_HEADER_SIGNS.some((re) => re.test(code));
}

/** A header's code as {@link CPP_HEADER_SIGNS} read it; every line stays a line.
 * The `"C"` of a linkage spec stays, every other string is blanked.
 * With `guarded`, only the code of its C++-only branches instead. */
function headerCode(source: string, guarded = false): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  const text = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => (m === '"C"' ? m : blank(m)));
  const lines = text.split("\n");
  const kinds = cppBranchLines(lines);
  for (let i = 0; i < lines.length; i++) if (kinds[i] === "directive" || (kinds[i] === "cpp") !== guarded) lines[i] = "";
  return lines.join("\n").replace(/\[\[[^\]\n]*\]\]/g, blank);
}

/** For each line: an `#if`/`#else`/`#endif` directive, a line of a C++-only
 * branch (`#ifdef __cplusplus`, the `#else` of `#ifndef __cplusplus`), or code
 * any compiler sees. Comments must already be blanked. */
function cppBranchLines(lines: readonly string[]): ("directive" | "cpp" | "code")[] {
  // Each open #if: whether it tests __cplusplus, and whether its current branch is C++-only.
  const open: { cpp: boolean; skip: boolean }[] = [];
  const negated = (cond: string): boolean => /!\s*(?:defined\s*\(?\s*)?__cplusplus/.test(cond);
  return lines.map((line) => {
    const m = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b([^\n]*)/.exec(line);
    if (!m) return open.some((o) => o.skip) ? "cpp" : "code";
    const [, kw, cond] = m;
    if (kw === "if" || kw === "ifdef" || kw === "ifndef") {
      const cpp = /\b__cplusplus\b/.test(cond);
      open.push({ cpp, skip: cpp && kw !== "ifndef" && !negated(cond) });
    } else if (kw === "endif") open.pop();
    else {
      const top = open[open.length - 1];
      if (top?.cpp) top.skip = !top.skip;
      else if (top && kw === "elif" && /\b__cplusplus\b/.test(cond)) {
        top.cpp = true;
        top.skip = !negated(cond);
      }
    }
    return "directive";
  });
}

/** `text` as a C compiler sees it: the lines of its C++-only branches blanked,
 * every line, column and offset kept. Null when it has no such lines. */
export function withoutCppBranches(text: string): string | null {
  if (!/\b__cplusplus\b/.test(text)) return null;
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  // Comments blanked to find the directives, and kept in the view: a comment
  // opened on a blanked line still closes where it did.
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, blank);
  const lines = code.split("\n");
  const kinds = cppBranchLines(lines);
  if (!kinds.includes("cpp")) return null;
  const out = text.split("\n");
  for (let i = 0; i < out.length; i++) {
    if (kinds[i] !== "cpp") continue;
    const kept = lines[i];
    out[i] = out[i].replace(/[^\r]/g, (ch, x: number) => (kept[x] === ch && ch !== " " && ch !== "\t" ? " " : ch));
  }
  return out.join("\n");
}

/** Kotlin definition shapes. Unlike Java's, tree-sitter-kotlin exposes no `name`
 * or `body` fields: a definition's name is an unnamed `simple_identifier` (functions)
 * or `type_identifier` (types) child, and its body is a `class_body` / `function_body`
 * / `statements` child. `class_declaration` also folds classes, interfaces, and enum
 * classes into one node type â€” the kind is read off the declaration's own keywords. */
function describeKotlin(node: SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  // The first direct `type_identifier` is the declared name (type parameters, primary
  // constructor parameters and delegation specifiers are all nested beneath it).
  const typeName = (): string | null =>
    node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
  // The first direct `simple_identifier` is the function name (receiver type, params
  // and type parameters are all nested beneath other child nodes).
  const funcName = (): string | null =>
    node.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? null;
  // `class X : A, B()` heritage lives in `delegation_specifier` children; a nested
  // type parameter's identifier is one of the same node type, so only direct children
  // count as the declared name.
  const headEnd = (type: string): number => {
    const body = node.namedChildren.find((c) => c.type === type);
    return body ? body.startIndex : node.endIndex;
  };

  if (node.type === "class_declaration") {
    const name = typeName();
    if (!name) return null;
    let kind: Kind = "class";
    if (node.namedChildren.some((c) => c.type === "enum_class_body")) kind = "enum";
    else if (node.children.some((c) => c.type === "interface")) kind = "interface";
    else {
      const mods = node.namedChildren.find((c) => c.type === "modifiers");
      // `annotation class` â†’ the interface role Java's annotation_type_declaration plays.
      if (mods?.namedChildren.some((c) => c.type === "class_modifier" && c.text === "annotation"))
        kind = "interface";
    }
    const body = node.namedChildren.find(
      (c) => c.type === "class_body" || c.type === "enum_class_body",
    );
    return { name, kind, headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
  }

  if (node.type === "object_declaration") {
    const name = typeName();
    if (!name) return null;
    return { name, kind: "class", headerEnd: headEnd("class_body"), hashNode: node };
  }

  // A one-line `object Name { â€¦ }` that the grammar misparsed as an infix call (see
  // kotlinMisparsedObjectName). It is still the singleton object: its lambda body
  // holds the members, which the walk then promotes to methods owned by `Name`.
  if (node.type === "infix_expression") {
    const name = kotlinMisparsedObjectName(node);
    if (!name) return null;
    return { name, kind: "class", headerEnd: node.namedChildren[2]!.startIndex, hashNode: node };
  }

  if (node.type === "function_declaration") {
    const name = funcName();
    if (!name) return null;
    const kind: Kind = KOTLIN_TYPE_KINDS.has(ctx.enclosingKind ?? "file") ? "method" : "function";
    return { name, kind, headerEnd: headEnd("function_body"), hashNode: node };
  }

  if (node.type === "secondary_constructor") {
    // Constructors carry no name of their own â€” they are the class's own, so scope the
    // node under the enclosing class the same way Java's constructor_declaration does.
    if (!ctx.enclosingClass) return null;
    return {
      name: ctx.enclosingClass,
      kind: "method",
      headerEnd: headEnd("statements"),
      hashNode: node,
    };
  }

  if (node.type === "type_alias") {
    const name = typeName();
    if (!name) return null;
    return { name, kind: "type", headerEnd: node.endIndex, hashNode: node };
  }

  if (node.type === "property_declaration") {
    // Top-level `val`/`var` only â€” a class property is a field, not a definition node
    // (no depth tier emits fields), so it must not become one.
    if (ctx.enclosingKind !== null) return null;
    const decl = node.namedChildren.find((c) => c.type === "variable_declaration");
    const name = decl?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
    if (!name) return null;
    return { name, kind: "variable", headerEnd: node.endIndex, hashNode: node };
  }

  return null;
}

/**
 * tree-sitter-kotlin 0.4.x parses a statement-level object declaration whose body
 * sits on the same line â€” `object Keys { const val A = "a" }`, `data object Idle {
 * â€¦ }` â€” as `infix_expression(object_literal, simple_identifier, lambda_literal)`:
 * an infix call of `Keys` on a bodiless object literal. The multi-line form, one
 * with modifiers or supertypes, and nested/companion objects all parse as a real
 * `object_declaration`. Left alone, the object vanishes from the graph and its
 * members surface as top-level functions.
 *
 * Bound: an `object_literal` with NO named children (no supertypes, no body) is not
 * valid Kotlin on its own â€” an object expression always has a `{â€¦}` body â€” so this
 * exact three-child shape can only be the misparse. Returns the object's name, or
 * null for every genuine infix call (`a to b`, `x shl 2`, `foo bar { â€¦ }`).
 */
function kotlinMisparsedObjectName(node: SyntaxNode): string | null {
  if (node.type !== "infix_expression" || node.namedChildren.length !== 3) return null;
  const [lit, name, body] = node.namedChildren;
  if (lit?.type !== "object_literal" || lit.namedChildren.length > 0) return null;
  if (name?.type !== "simple_identifier" || body?.type !== "lambda_literal") return null;
  return name.text;
}

/** Swift definition shapes. Like Kotlin's, tree-sitter-swift exposes no `name` or
 * `body` fields: a definition's name is a direct `type_identifier` (types) or
 * `simple_identifier` (functions) child, and its body is a `class_body` /
 * `enum_class_body` / `protocol_body` / `function_body` child. One
 * `class_declaration` node type covers `class`, `struct`, `enum`, `actor` AND
 * `extension` â€” the declaration's own keyword token tells them apart. */
function describeSwift(node: SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  // The first direct `type_identifier` is the declared name (generic parameters and
  // inheritance specifiers are all nested beneath other child nodes).
  const typeName = (): string | null =>
    node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
  // The first direct `simple_identifier` is the function name (parameters and
  // generic parameters are all nested beneath other child nodes).
  const funcName = (): string | null =>
    node.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? null;
  const headEnd = (...types: string[]): number => {
    const body = node.namedChildren.find((c) => types.includes(c.type));
    return body ? body.startIndex : node.endIndex;
  };

  if (node.type === "class_declaration") {
    const kw = node.children.find(
      (c) =>
        c.type === "class" ||
        c.type === "struct" ||
        c.type === "enum" ||
        c.type === "actor" ||
        c.type === "extension",
    )?.type;
    let name: string | null;
    if (kw === "extension") {
      // `extension Point { â€¦ }` has no name of its own â€” the extended type's IS its
      // identity, so the node takes that name: members mint as `Point.method`,
      // `enclosingClass` becomes `Point`, and a member call on a Point receiver
      // resolves to them exactly as if they were declared on the type. A qualified
      // target (`extension Swift.Array`) reduces to its last component, matching
      // how the extended type is itself named in the graph.
      //
      // Its KIND is "module", not "class": the type usually already has a real
      // declaration, and a second same-named "class" node would make the name
      // AMBIGUOUS to resolveName â€” every `Point(...)` initializer call and every
      // `: Point` heritage target would then drop instead of resolving (resolve
      // never guesses between same-named candidates). "module" keeps the node out
      // of type-name resolution entirely while SWIFT_TYPE_KINDS still makes it
      // own its members; typed member calls are untouched either way, since they
      // go through the owner-qualified method index, not the type's own node.
      const ut = node.namedChildren.find((c) => c.type === "user_type");
      const ids = ut?.namedChildren.filter((c) => c.type === "type_identifier") ?? [];
      name = ids.length ? ids[ids.length - 1]!.text : null;
    } else {
      name = typeName();
    }
    if (!name) return null;
    // An actor is class-like (reference semantics, methods) and there is no
    // dedicated actor kind, so it takes "class".
    const kind: Kind =
      kw === "extension" ? "module" : kw === "struct" ? "struct" : kw === "enum" ? "enum" : "class";
    return { name, kind, headerEnd: headEnd("class_body", "enum_class_body"), hashNode: node };
  }

  if (node.type === "protocol_declaration") {
    const name = typeName();
    if (!name) return null;
    return { name, kind: "interface", headerEnd: headEnd("protocol_body"), hashNode: node };
  }

  // A protocol requirement (`protocol_function_declaration`) has no body and is
  // always a member; an ordinary `function_declaration` is a method exactly when
  // it is nested in a type (or an extension of one).
  if (node.type === "function_declaration" || node.type === "protocol_function_declaration") {
    const name = funcName();
    if (!name) return null;
    const kind: Kind =
      node.type === "protocol_function_declaration" ||
      SWIFT_TYPE_KINDS.has(ctx.enclosingKind ?? "file")
        ? "method"
        : "function";
    return {
      name,
      kind,
      headerEnd: headEnd("function_body"),
      hashNode: node,
      ...swiftArity(node),
    };
  }

  if (node.type === "init_declaration") {
    // Initializers carry no name of their own â€” they are the type's own, so scope
    // the node under the enclosing type the same way Java's constructor_declaration
    // does. (A protocol's `init` requirement lands here too, owned by the protocol.)
    if (!ctx.enclosingClass) return null;
    return {
      name: ctx.enclosingClass,
      kind: "method",
      headerEnd: headEnd("function_body"),
      hashNode: node,
      ...swiftArity(node),
    };
  }

  if (node.type === "typealias_declaration") {
    const name = typeName();
    if (!name) return null;
    return { name, kind: "type", headerEnd: node.endIndex, hashNode: node };
  }

  if (node.type === "property_declaration") {
    // Top-level `let`/`var` only â€” a stored/computed property inside a type is a
    // field, not a definition node (no depth tier emits fields), so it must not
    // become one. `deinit` and `subscript` are likewise skipped: neither is ever
    // the target of a resolvable call edge, and neither carries a usable name.
    if (ctx.enclosingKind !== null) return null;
    const name = node.namedChildren
      .find((c) => c.type === "pattern")
      ?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
    if (!name) return null;
    return { name, kind: "variable", headerEnd: node.endIndex, hashNode: node };
  }

  return null;
}

/** Java visibility: `public` (or `protected`) on the declaration's own modifier list.
 * A package-private or private member is not part of the API surface. Read off the
 * `modifiers` child's tokens, ignoring annotations, which live in the same node. */
function javaExported(node: SyntaxNode): boolean {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return false;
  return mods.children.some((c) => c.type === "public" || c.type === "protected");
}

/** Kotlin visibility: exported by default (`public` is implicit); only an explicit
 * `internal` / `private` / `protected` visibility modifier hides a definition. */
function kotlinExported(node: SyntaxNode): boolean {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return true;
  const vis = mods.namedChildren.find((c) => c.type === "visibility_modifier");
  return !vis || vis.text === "public";
}

/** Declared parameter count for a Swift callable, for overload disambiguation
 * (the same role Java's `arity`/`argCount` pair plays). `parameter` nodes are
 * direct children of the declaration; a default value's `=` sits as a SIBLING
 * token after its parameter, and a variadic `...` sits inside its parameter.
 * `arity` is the REQUIRED minimum (parameters minus defaults) and `variadic`
 * marks any default or variadic parameter, so `narrowByArity`'s at-least
 * semantics keeps every overload a call of that shape could reach. */
function swiftArity(node: SyntaxNode): { arity: number; variadic?: boolean } {
  const params = node.children.filter((c) => c.type === "parameter");
  const defaults = node.children.filter((c) => c.type === "=").length;
  const hasVariadic = params.some((p) => p.children.some((c) => c.type === "..."));
  const arity = Math.max(0, params.length - defaults);
  return hasVariadic || defaults > 0 ? { arity, variadic: true } : { arity };
}

/** Argument count at a Swift call site: the `value_argument`s plus one for a
 * trailing closure (`run(x) { â€¦ }` calls a two-parameter function). */
function swiftArgCount(node: SyntaxNode): number | undefined {
  const suffix = node.namedChildren.find((c) => c.type === "call_suffix");
  if (!suffix) return undefined;
  const args =
    suffix.namedChildren
      .find((c) => c.type === "value_arguments")
      ?.namedChildren.filter((c) => c.type === "value_argument").length ?? 0;
  const trailing = suffix.namedChildren.some((c) => c.type === "lambda_literal") ? 1 : 0;
  return args + trailing;
}

/** Swift visibility: the default (`internal`) is module-wide, and a repo is
 * typically one module â€” so `public` / `open` / `package` / `internal` all count
 * as API surface, and only an explicit `private` / `fileprivate` hides a
 * definition. A setter-only restriction (`private(set)`) leaves the getter
 * visible, so it does not hide the symbol either. */
function swiftExported(node: SyntaxNode): boolean {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  const vis = mods?.namedChildren.find((c) => c.type === "visibility_modifier");
  return !vis || (vis.text !== "private" && vis.text !== "fileprivate");
}

/** The superclass a Swift class declaration names: its FIRST inheritance
 * specifier â€” Swift's grammar requires the superclass to precede any protocol
 * in the `:` list, so when a superclass exists it is always this entry. A
 * class conforming only to protocols yields that protocol's name instead, but
 * `super` is illegal in such a class, so no call site ever consults it. Null
 * for a bare `class Foo` (and for an extension, whose declaration carries no
 * heritage for the original type â€” `super` inside one stays unresolved). */
function swiftSuperClassName(node: SyntaxNode): string | null {
  const spec = node.namedChildren.find((c) => c.type === "inheritance_specifier");
  const ids = spec?.namedChildren
    .find((c) => c.type === "user_type")
    ?.namedChildren.filter((c) => c.type === "type_identifier");
  return ids?.length ? ids[ids.length - 1]!.text : null;
}

/** The receiver's base type name for a Go method, unwrapping a pointer receiver
 * (`func (u *User) â€¦` â†’ `User`). Null if it can't be read. */
function goReceiverType(node: SyntaxNode): string | null {
  const recv = node.childForFieldName("receiver"); // parameter_list
  const param = recv?.namedChildren.find((c) => c.type === "parameter_declaration");
  let type = param?.childForFieldName("type");
  if (type?.type === "pointer_type") type = type.namedChildren.at(-1) ?? null;
  return type?.type === "type_identifier" ? type.text : null;
}

/** Go visibility: a symbol is exported iff its own name starts with an uppercase
 * letter. For a receiver-qualified method name, the own name is the part after the dot. */
function goExported(name: string): boolean {
  const own = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  const first = own[0] ?? "";
  return first !== first.toLowerCase() && first === first.toUpperCase();
}

/** PHP visibility: a class member is "exported" unless it is `private`/`protected`.
 * Top-level functions/classes carry no visibility modifier and are always visible. */
function phpExported(node: SyntaxNode): boolean {
  const vis = node.namedChildren.find((c) => c.type === "visibility_modifier");
  return vis ? vis.text === "public" : true;
}

/** Name for a PHP closure / arrow-fn: the variable it's assigned to
 * (`$handler = fn(...)` -> `handler`, mirroring how TS names arrow-consts),
 * else the anonymous `{closure}` (deduplicated per file by mintId).
 *
 * The "is this the assignment's right-hand side" check compares tree-sitter node
 * `.id` (a stable per-tree node identity) rather than `===` on the wrapper
 * objects: the binding does not guarantee that two traversals to the same
 * underlying node hand back the same JS wrapper, so `right === node` can be false
 * even when they are the same node â€” producing a stray `{closure}` name that
 * makes `graft check` report the graph STALE against its own stored output. */
function phpClosureName(node: SyntaxNode): string {
  const parent = node.parent;
  if (parent?.type === "assignment_expression" && parent.childForFieldName("right")?.id === node.id) {
    const left = parent.childForFieldName("left");
    if (left?.type === "variable_name") return left.text.replace(/^\$/, "");
  }
  return "{closure}";
}

function heritageEdges(node: SyntaxNode, classId: string, ctx: WalkCtx): RawEdge[] {
  const edges: RawEdge[] = [];
  if (ctx.lang === "java") {
    // `superclass` holds `extends X`; `super_interfaces` holds `implements A, B`
    // (and, on an interface declaration, `extends A, B` â€” which tree-sitter-java
    // still spells `extends_interfaces`).
    const typeParams = javaTypeParameterNames(node);
    for (const child of node.namedChildren) {
      const relation: Relation | null =
        child.type === "superclass"
          ? "extends"
          : child.type === "super_interfaces" || child.type === "extends_interfaces"
            ? "implements"
            : null;
      if (!relation) continue;
      for (const entry of javaSupertypeEntries(child)) {
        const name = javaSupertypeName(entry);
        // Belt-and-braces. A type VARIABLE is never a supertype, and erasing the
        // arguments already removes every case measured on gson and spring-petclinic
        // (identical output with this filter removed) â€” Java cannot extend or implement
        // a type variable, so a surviving `T` would have to come from a shape neither
        // repo contains. Kept because a wrong supertype is not a cosmetic edge: it
        // feeds `classParents` and from there call resolution.
        if (!name || typeParams.has(name)) continue;
        edges.push({ source: classId, relation, name, file: ctx.rel });
      }
    }
    return edges;
  }
  if (ctx.lang === "kotlin") {
    // The `:` clause is a list of `delegation_specifier`s, each wrapping one of three
    // shapes: a bare `user_type` (an interface: `: Greeter`), a `constructor_invocation`
    // (the superclass: `: Base(1)`), or an `explicit_delegation` (`: Runnable by impl`).
    // The supertype is that shape's `user_type`; reading only a DIRECT user_type (as
    // this once did) dropped every superclass and every delegated interface. Within
    // it, the LAST direct `type_identifier` is the bare name â€” a qualified
    // `com.acme.Base` reduces to `Base` â€” and type arguments / the delegation target
    // live in other nodes, so they never leak in.
    for (const child of node.namedChildren) {
      if (child.type !== "delegation_specifier") continue;
      const head = child.namedChildren[0];
      const userType =
        head?.type === "user_type"
          ? head
          : head?.type === "constructor_invocation" || head?.type === "explicit_delegation"
            ? head.namedChildren.find((c) => c.type === "user_type")
            : undefined;
      const t = userType?.namedChildren.filter((c) => c.type === "type_identifier").at(-1);
      if (t) edges.push({ source: classId, relation: "extends", name: t.text, file: ctx.rel });
    }
    return edges;
  }
  if (ctx.lang === "swift") {
    // `class A: B, C` â€” each `inheritance_specifier` (a direct child of the
    // declaration; protocols and extensions carry them too) wraps a `user_type`
    // whose LAST direct `type_identifier` is the bare supertype name: a
    // module-qualified `Foundation.NSObject` reduces to `NSObject`, and generic
    // arguments live in nested nodes so they never leak in. Swift cannot say
    // syntactically whether a specifier is the superclass or a protocol
    // conformance (that needs the target's kind), so every edge is `extends` â€”
    // the same collapse Kotlin's delegation specifiers make.
    for (const child of node.namedChildren) {
      if (child.type !== "inheritance_specifier") continue;
      const ids = child.namedChildren
        .find((c) => c.type === "user_type")
        ?.namedChildren.filter((c) => c.type === "type_identifier");
      const t = ids?.length ? ids[ids.length - 1] : undefined;
      if (t) edges.push({ source: classId, relation: "extends", name: t.text, file: ctx.rel });
    }
    return edges;
  }
  if (ctx.lang === "python") {
    const supers = node.childForFieldName("superclasses"); // argument_list
    for (const c of supers?.namedChildren ?? []) {
      if (c.type === "identifier") {
        edges.push({ source: classId, relation: "extends", name: c.text, file: ctx.rel });
      }
    }
    return edges;
  }
  if (ctx.lang === "r") {
    // `node` is whatever describeR matched: a binary_operator for R6
    // (`Foo <- R6::R6Class(...)`) or the call itself for S4 (`setClass(...)`
    // is a bare top-level statement, essentially never assigned).
    const call = node.type === "binary_operator" ? node.childForFieldName("rhs") : node;
    if (call?.type !== "call") return edges;
    const callee = rCalleeName(call);
    if (callee === "R6Class") {
      // `inherit = ParentClass` â€” a bare identifier (the parent's own
      // generator variable), not a string; R6 supports single inheritance only.
      const value = rNamedArg(call, "inherit");
      if (value?.type === "identifier") {
        edges.push({ source: classId, relation: "extends", name: value.text, file: ctx.rel });
      }
    } else if (callee === "setClass") {
      // `contains = "Base"` or `contains = c("Base1", "Base2")` â€” S4 supports
      // multiple inheritance.
      for (const name of rStringOrCVector(rNamedArg(call, "contains"))) {
        edges.push({ source: classId, relation: "extends", name, file: ctx.rel });
      }
    }
    return edges;
  }
  if (ctx.lang === "php") {
    // `class C extends B implements I, J` â†’ base_clause (extends) +
    // class_interface_clause (implements); names may be namespace-qualified.
    for (const clause of node.namedChildren) {
      const relation: Relation | null =
        clause.type === "base_clause" ? "extends" : clause.type === "class_interface_clause" ? "implements" : null;
      if (!relation) continue;
      for (const t of clause.namedChildren) {
        if (t.type === "name" || t.type === "qualified_name") {
          edges.push({ source: classId, relation, name: t.text.replace(/^.*\\/, ""), file: ctx.rel });
        }
      }
    }
    return edges;
  }
  if (ctx.lang === "c_sharp") {
    const bases = node.namedChildren.find((c) => c.type === "base_list");
    for (const t of bases?.namedChildren ?? []) {
      if (t.type === "identifier" || t.type === "qualified_name" || t.type === "generic_name") {
        const name = t.text.replace(/<[^]*>$/, "").replace(/^.*\./, "");
        if (!name) continue;
        // C# writes the base class and interfaces in one `:` list with no
        // syntactic split, so classify by the .NET `IPascalCase` interface
        // convention â€” the same heuristic the graph-csharp spec expects.
        const relation: Relation = /^I[A-Z]/.test(name) ? "implements" : "extends";
        edges.push({ source: classId, relation, name, file: ctx.rel });
      }
    }
    return edges;
  }
  if (ctx.lang === "cpp") {
    const bases = node.namedChildren.find((c) => c.type === "base_class_clause");
    for (const t of bases?.namedChildren ?? []) {
      if (t.type === "type_identifier" || t.type === "qualified_identifier" || t.type === "template_type") {
        const name = t.text.replace(/<[^]*>$/, "").replace(/^.*::/, "");
        if (name) edges.push({ source: classId, relation: "extends", name, file: ctx.rel });
      }
    }
    return edges;
  }
  const heritage = node.namedChildren.find((c) => c.type === "class_heritage");
  for (const clause of heritage?.namedChildren ?? []) {
    const relation: Relation | null =
      clause.type === "implements_clause"
        ? "implements"
        : clause.type === "extends_clause"
          ? "extends"
          : null;
    if (!relation) continue;
    for (const t of clause.namedChildren) {
      if (t.type === "identifier" || t.type === "type_identifier") {
        edges.push({ source: classId, relation, name: t.text, file: ctx.rel });
      }
    }
  }
  return edges;
}

/**
 * The supertypes a heritage clause names, one node each â€” NOT every `type_identifier`
 * beneath it.
 *
 * `superclass` wraps a single type; `super_interfaces`/`extends_interfaces` wrap a
 * `type_list` of them. Descending blindly instead walked into `type_arguments`, so
 * `implements Comparable<Item>` reported `Item` as a supertype too.
 */
function javaSupertypeEntries(clause: SyntaxNode): SyntaxNode[] {
  const list = clause.namedChildren.find((c) => c.type === "type_list");
  return list ? [...list.namedChildren] : [...clause.namedChildren];
}

/**
 * What a supertype entry is CALLED, or null when this pass cannot say.
 *
 * Type arguments are erased, because they are not part of the supertype's identity:
 *
 *     Base           |  Base<Item>          -> Base
 *
 * A qualified name is kept WHOLE rather than reduced to its final segment:
 *
 *     Outer.Inner    |  Outer.Inner<K>      -> Outer.Inner
 *
 * Heritage keeps an unresolved base as the edge target by design ("usually an
 * external/imported type â€” keep the name"), so the full string is both truthful and
 * unable to false-match a node id, where a bare `Inner` could collide with an
 * unrelated in-repo type. That differs from construction (#103), which drops a
 * qualified name instead â€” construction has no keep-the-name contract to fall back on.
 */
function javaSupertypeName(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "generic_type") return javaSupertypeName(node.namedChildren[0]);
  if (node.type === "scoped_type_identifier") return node.text;
  return node.type === "type_identifier" ? node.text : null;
}

/** The names a declaration binds as its own type parameters (`class C<T, U>` â†’ T, U),
 * so they can never be mistaken for supertypes. */
function javaTypeParameterNames(decl: SyntaxNode): ReadonlySet<string> {
  const params = decl.childForFieldName("type_parameters");
  if (!params) return new Set();
  const out = new Set<string>();
  const visit = (n: SyntaxNode): void => {
    if (n.type === "type_identifier") out.add(n.text);
    for (const c of n.namedChildren) visit(c);
  };
  visit(params);
  return out;
}

function calleeName(
  node: SyntaxNode,
  lang: Language,
): { name: string; viaMember: boolean; receiver?: string; kinds?: Kind[] } | null {
  // Java first: `method_invocation` has NO `function` field (it splits the callee
  // into `object` + `name`), so the shared lookup below would return null for every
  // Java call site and the language would extract nodes with no call edges at all.
  if (lang === "java") {
    if (node.type === "object_creation_expression") {
      // `new Foo()` â€” the constructed type is the call target, named as the graph
      // names it.
      const name = javaConstructedTypeName(node.childForFieldName("type"));
      return name ? { name, viaMember: false } : null;
    }
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    const obj = node.childForFieldName("object");
    // No `object` means an implicit-`this` call (`decorate(name)`), which in Java is a
    // method call, not a free function â€” Java has none. Reporting it as a plain call
    // would send it to the function-only resolver and drop it, losing the most common
    // intra-class edge there is. Spelling it as a `this` member call routes it through
    // owner-qualified resolution, which also walks the superclass chain and stays
    // conservative: an unmatched name (e.g. a static import) resolves to nothing.
    if (!obj) return { name: nameNode.text, viaMember: true, receiver: "this" };
    return { name: nameNode.text, viaMember: true, receiver: javaReceiver(obj) };
  }

if (lang === "kotlin") {
    // `call_expression` = callee expression + `call_suffix`. A bare `foo()` names a
    // plain call; `obj.foo()` is a `navigation_expression` whose trailing
    // `navigation_suffix` holds the method name and whose object is the receiver.
    const target = node.namedChildren[0];
    if (target?.type === "simple_identifier") return { name: target.text, viaMember: false };
    if (target?.type === "navigation_expression") {
      const suffix = target.namedChildren.find((c) => c.type === "navigation_suffix");
      const name = suffix?.namedChildren.find((c) => c.type === "simple_identifier");
      const receiver = target.namedChildren[0];
      if (!name) return null;
      if (receiver?.type === "simple_identifier")
        return { name: name.text, viaMember: true, receiver: receiver.text };
      if (receiver?.type === "this_expression" || receiver?.type === "super_expression")
        return { name: name.text, viaMember: true, receiver: receiver.type === "this_expression" ? "this" : "super" };
    }
    return null;
  }

  if (lang === "swift") {
    // Same shape as Kotlin's: `call_expression` = callee expression + `call_suffix`.
    // A bare `foo()` names a plain call (this also covers `Animal()` initializer
    // calls, which have no distinguishing syntax); `obj.foo()` is a
    // `navigation_expression` whose trailing `navigation_suffix` holds the member
    // name and whose head is the receiver.
    const target = node.namedChildren[0];
    if (target?.type === "simple_identifier") return { name: target.text, viaMember: false };
    if (target?.type === "navigation_expression") {
      const suffix = target.namedChildren.find((c) => c.type === "navigation_suffix");
      const name = suffix?.namedChildren.find((c) => c.type === "simple_identifier");
      const receiver = target.namedChildren[0];
      if (!name) return null;
      if (receiver?.type === "simple_identifier")
        return { name: name.text, viaMember: true, receiver: receiver.text };
      if (receiver?.type === "self_expression" || receiver?.type === "super_expression")
        return {
          name: name.text,
          viaMember: true,
          receiver: receiver.type === "self_expression" ? "self" : "super",
        };
      if (receiver?.type === "navigation_expression") {
        // `self.repo.save()` â€” one hop off self is a field access and binds like
        // TS's `this.x`. Deeper chains and call-result receivers carry no
        // confident local clue, so those fall through with no receiver.
        const head = receiver.namedChildren[0];
        const field = receiver.namedChildren
          .find((c) => c.type === "navigation_suffix")
          ?.namedChildren.find((c) => c.type === "simple_identifier");
        if (head?.type === "self_expression" && field)
          return { name: name.text, viaMember: true, receiver: `self.${field.text}` };
      }
      // Still a member call even with an unknowable receiver (a chained call, a
      // literal, a subscript): recvType stays unset and resolve drops it rather
      // than guessing â€” same contract as Java's and TS's unknown receivers.
      return { name: name.text, viaMember: true };
    }
    return null;
  }

  if (lang === "php") return phpCallee(node);
  if (lang === "c_sharp") return csharpCallee(asNative(node));
  if (lang === "groovy") return groovyCallee(asNative(node));
  if (lang === "plsql") return plsqlCallee(asNative(node));
  if (lang === "c" || lang === "cpp") return cCallee(asNative(node));

  const fn = node.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier") return { name: fn.text, viaMember: false };
  if (lang === "python" && fn.type === "attribute") {
    const a = fn.childForFieldName("attribute") ?? fn.namedChildren.at(-1);
    return a ? { name: a.text, viaMember: true, receiver: pyReceiver(fn) } : null;
  }
  if (lang === "go" && fn.type === "selector_expression") {
    // `pkg.Fn()` / `recv.Method()` â€” the called name is the trailing field.
    const p = fn.childForFieldName("field") ?? fn.namedChildren.at(-1);
    const operand = fn.childForFieldName("operand");
    const receiver = operand?.type === "identifier" ? operand.text : undefined;
    return p ? { name: p.text, viaMember: true, receiver } : null;
  }
  if ((lang === "typescript" || lang === "tsx") && fn.type === "member_expression") {
    const p = fn.childForFieldName("property") ?? fn.namedChildren.at(-1);
    return p ? { name: p.text, viaMember: true, receiver: tsReceiver(fn) } : null;
  }
  if (lang === "r" && (fn.type === "extract_operator" || fn.type === "namespace_operator")) {
    const rhs = fn.childForFieldName("rhs");
    if (rhs?.type !== "identifier") return null;
    if (fn.type === "extract_operator") {
      const lhs = fn.childForFieldName("lhs");
      if (lhs?.type === "identifier" && (lhs.text === "self" || lhs.text === "private")) {
        // R6 (Phase 2): `self$method()` / `private$method()` â€” resolves directly to
        // the enclosing class via ctx.enclosingClass, same mechanism (and same
        // magic receiver string) as Python/TS's self/cls/this â€” see
        // resolveRecvType, which already special-cases "self" generically.
        return { name: rhs.text, viaMember: true, receiver: "self" };
      }
      if (lhs?.type === "identifier" && lhs.text === "super") {
        // R6 (Phase 3): `super$method()` â€” R6's inheritance-dispatch keyword,
        // resolves directly to the PARENT class via ctx.rSuperClass (NOT
        // ctx.enclosingClass â€” that would wrongly find the current class's own
        // same-named override instead of climbing to the parent).
        return { name: rhs.text, viaMember: true, receiver: "super" };
      }
      // Any other `obj$method()` (Phase 4): still a PLAIN name match, not a
      // typed member call â€” there's no general field-type-binding table for
      // R6 composition (`private$other_obj$method()`), and a real codebase's
      // dominant field-assignment shape (constructor-parameter pass-through,
      // `do.call(class_var$new, ...)` dynamic dispatch) turned out to defeat
      // the simple "field <- SomeClass$new()" pattern every other language's
      // binding table relies on anyway â€” see plan_r_language_support.md's
      // Phase 2 "known gaps" and the follow-up investigation against a real
      // R6-heavy corpus. What DOES help: bare-name resolution must be allowed
      // to match a "method" node here, not just "function" â€” R6 methods are
      // always kind "method", so without `kinds` below, EVERY untyped `$`
      // call would be unconditionally unresolvable rather than just
      // occasionally ambiguous (resolve.ts already drops a genuinely
      // ambiguous bare-name match rather than guessing, so this only adds
      // resolutions for uniquely-named methods, never a wrong-class guess).
      return { name: rhs.text, viaMember: false, kinds: ["function", "method"] };
    }
    // `pkg::fun()` (qualified call) â€” always a real function/exported symbol,
    // never an R6 method (those are only ever reached via `$` on an instance),
    // so no need to widen the match kinds here.
    return { name: rhs.text, viaMember: false };
  }
  return null;
}

/** The number of arguments at a Java call site (`method_invocation` or
 * `object_creation_expression`), read off the `arguments` list. Undefined when the
 * list is absent, which keeps resolution at its previous name-only behavior rather
 * than filtering on a count we never established. */
function javaArgCount(node: SyntaxNode): number | undefined {
  const args = node.childForFieldName("arguments");
  return args ? args.namedChildren.length : undefined;
}

/**
 * The name a `new` CONSTRUCTS, as the graph names it â€” or null when this pass cannot
 * say, in which case the construction resolves to nothing.
 *
 * Erasing type arguments is the only transformation here, because it is the only one
 * that provably does not change which type is being named:
 *
 *     Box            -> Box
 *     Box<String>    -> Box     (the node is `Box`; the arguments are not part of it)
 *     Box<>          -> Box
 *
 * A QUALIFIED name is deliberately dropped rather than reduced to its final segment:
 *
 *     java.io.File   -> null    (not the repo's own `File`)
 *     Beta.Builder   -> null    (not `Alpha.Builder` in the same file)
 *
 * Collapsing those was the first attempt at this fix, and it traded lost edges for
 * WRONG ones â€” `new java.io.File(â€¦)` resolved to an unrelated in-repo `File`, and a
 * nested `Beta.Builder` bound to a sibling `Alpha.Builder` at `extracted` confidence,
 * because the same-file tiebreak takes the first candidate. Dropping keeps this pass
 * on the resolver's own rule: resolve precisely, or not at all.
 *
 * Deliberately NOT shared with bindings.ts's `javaTypeName`. That one answers "what
 * type does this variable HOLD", where reducing `java.util.List` to `List` is a local
 * heuristic with different stakes; this one answers "what type is being constructed",
 * and the two questions do not have the same safe answer. Supporting qualified
 * construction properly needs an import-aware type index, not a longer helper.
 */
function javaConstructedTypeName(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "generic_type") return javaConstructedTypeName(node.namedChildren[0]);
  return node.type === "type_identifier" ? node.text : null;
}

/** A Java call's receiver text: a bare identifier (`repo.save()`), `this`, or
 * `this.x` for a field access (`this.repo.save()`). A chained call or a qualified
 * static reference yields none â€” there is no confident local clue to bind. */
function javaReceiver(obj: SyntaxNode | null | undefined): string | undefined {
  if (!obj) return undefined;
  if (obj.type === "identifier") return obj.text;
  if (obj.type === "this") return "this";
  if (obj.type === "field_access") {
    const inner = obj.childForFieldName("object");
    const field = obj.childForFieldName("field");
    if (inner?.type === "this" && field) return `this.${field.text}`;
  }
  return undefined;
}

/** py `attribute` node's receiver text: bare identifier, or `self.x` for a
 * chained `self.x.y()`. Anything else (e.g. a chained call `f().g()`) â†’ none. */
function pyReceiver(fn: SyntaxNode): string | undefined {
  const obj = fn.childForFieldName("object");
  if (obj?.type === "identifier") return obj.text;
  if (obj?.type === "attribute") {
    const innerObj = obj.childForFieldName("object");
    const innerAttr = obj.childForFieldName("attribute");
    if (innerObj?.type === "identifier" && innerObj.text === "self" && innerAttr) return `self.${innerAttr.text}`;
  }
  return undefined;
}

/**
 * PHP call shapes: `foo()` (function_call_expression), `$obj->m()` /
 * `$obj?->m()` (member/nullsafe_member_call_expression), and `Cls::m()`
 * (scoped_call_expression). The called name is the trailing `name`; the
 * receiver, when locally knowable (`$this`, `self`/`static`/`parent`), feeds
 * receiver-typed resolution the same way Python's `self` and Go's receiver do.
 */
function phpCallee(node: SyntaxNode): { name: string; viaMember: boolean; receiver?: string } | null {
  if (node.type === "function_call_expression") {
    const fn = node.childForFieldName("function");
    const name = fn ? phpName(fn) : null;
    return name ? { name, viaMember: false } : null;
  }
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;
  if (node.type === "scoped_call_expression") {
    return { name: nameNode.text, viaMember: true, receiver: phpScopeReceiver(node.childForFieldName("scope")) };
  }
  // member_call_expression / nullsafe_member_call_expression
  return { name: nameNode.text, viaMember: true, receiver: phpObjReceiver(node.childForFieldName("object")) };
}

/** A PHP callee identifier: bare `name`, or the trailing segment of a
 * `qualified_name` (`\App\helpers\slug` â†’ `slug`). Dynamic calls (`$fn()`) â†’ null. */
function phpName(node: SyntaxNode): string | null {
  if (node.type === "name") return node.text;
  if (node.type === "qualified_name") return node.text.replace(/^.*\\/, "") || null;
  return null;
}

/** `$obj->m()` receiver: `$this` normalizes to `this` (â†’ enclosing class); any
 * other variable is returned verbatim for a bindings lookup. */
function phpObjReceiver(obj: SyntaxNode | null): string | undefined {
  if (obj?.type !== "variable_name") return undefined;
  return obj.text === "$this" ? "this" : obj.text;
}

/** `Cls::m()` receiver: `self`/`static`/`parent` normalize to `self` (â†’ enclosing
 * class); an explicit class name is the trailing segment of its qualified path. */
function phpScopeReceiver(scope: SyntaxNode | null): string | undefined {
  if (!scope) return undefined;
  const text = scope.text;
  if (scope.type === "relative_scope" || text === "self" || text === "static" || text === "parent") return "self";
  if (scope.type === "name") return text;
  if (scope.type === "qualified_name") return text.replace(/^.*\\/, "");
  return undefined;
}

/** ts `member_expression` node's receiver text: `this`, `this.x`, or a bare identifier. */
function tsReceiver(fn: SyntaxNode): string | undefined {
  const obj = fn.childForFieldName("object");
  if (obj?.type === "this") return "this";
  if (obj?.type === "identifier") return obj.text;
  if (obj?.type === "member_expression") {
    const innerObj = obj.childForFieldName("object");
    const innerProp = obj.childForFieldName("property");
    if (innerObj?.type === "this" && innerProp) return `this.${innerProp.text}`;
  }
  return undefined;
}

/** R has no import statement at the grammar level â€” `library(x)`, `require(x)`,
 * and `source("f.R")` are ordinary `call` nodes, indistinguishable from any other
 * call except by their callee name. This is call-SITE pattern matching, a first
 * for this function's normal node-type switch â€” every other language's import
 * shape is a dedicated grammar construct. */
const R_IMPORT_CALLS = new Set(["library", "require", "source"]);

function isImport(node: SyntaxNode, lang: Language): boolean {
  // Go: match the per-import leaf, so single (`import "fmt"`) and grouped
  // (`import ( â€¦ )`) forms each yield one edge as the walk recurses into the list.
  if (lang === "go") return node.type === "import_spec";
  if (lang === "r") {
    if (node.type !== "call") return false;
    const fn = node.childForFieldName("function");
    return fn?.type === "identifier" && R_IMPORT_CALLS.has(fn.text);
  }
  if (lang === "java") return node.type === "import_declaration";
if (lang === "kotlin") return node.type === "import_header";
  if (lang === "swift") return node.type === "import_declaration";
  // PHP: one edge per imported symbol â€” the clause leaf inside a (possibly
  // grouped) `use A\B, C\D;` / `use A\{B, C};` declaration.
  if (lang === "php") return node.type === "namespace_use_clause";
  if (lang === "c_sharp") return node.type === "using_directive";
  if (lang === "groovy") return node.type === "groovy_import";
  if (lang === "c" || lang === "cpp") return node.type === "preproc_include";
  return node.type === "import_statement" || node.type === "import_from_statement";
}

function importSpecifier(node: SyntaxNode, lang: Language): string | null {
  if (lang === "php") {
    // namespace_use_clause â†’ its `qualified_name`/`name`, e.g. `App\Models\Animal`.
    const q = node.namedChildren.find((c) => c.type === "qualified_name" || c.type === "name");
    return q ? q.text.replace(/^\\/, "") : null;
  }
  if (lang === "python") {
    const m =
      node.childForFieldName("module_name") ??
      node.namedChildren.find((c) => c.type === "dotted_name" || c.type === "relative_import");
    return m?.text ?? null;
  }
  if (lang === "go") {
    // import_spec's `path` is an interpreted_string_literal, e.g. `"mymod/pkg/util"`.
    const path = node.childForFieldName("path") ?? node.namedChildren.at(-1);
    return path ? path.text.replace(/^["`]|["`]$/g, "") : null;
  }
  if (lang === "r") {
    // library(pkg) / library("pkg") / require(pkg) / source("f.R") â€” the target is
    // always the first (and normally only) positional argument, bare symbol or string.
    const value = rCallArgs(node)[0]?.childForFieldName("value") ?? null;
    if (value?.type === "identifier") return value.text;
    return rStringContent(value);
  }
  if (lang === "java") {
    // `import a.b.C;` / `import static a.b.C.d;` / `import a.b.*;` â€” the fully
    // qualified name is the scoped_identifier; a wildcard `*` is a separate token
    // and is dropped, leaving the package as the import target.
    const id = node.namedChildren.find(
      (c) => c.type === "scoped_identifier" || c.type === "identifier",
    );
    return id?.text ?? null;
  }
  if (lang === "kotlin") {
    // `import com.example.Foo` â€” the dotted path is the `identifier` child. A
    // wildcard (`import a.b.*`) and an `as` alias are separate children, so the
    // identifier text is already the module path (wildcards dropped, like Java).
    return node.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
  }
  if (lang === "swift") {
    // `import UIKit` / `import struct Foundation.Date` â€” the dotted path is the
    // `identifier` child (an import-kind keyword like `struct` is a separate
    // token). Swift imports name MODULES, not files, so the specifier resolves
    // to a repo file only when a same-named module target exists; external
    // frameworks stay as unresolved (but truthful) import intents.
    return node.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
  }
  if (lang === "c_sharp") {
    // `using System;` / `using Foo.Bar;` â€” the imported namespace is the clause's
    // qualified name (an alias `using A = B;` picks up `A`, close enough here).
    const n = node.namedChildren.find((c) => c.type === "qualified_name" || c.type === "identifier");
    return n?.text ?? null;
  }
  if (lang === "groovy") {
    const n = node.childForFieldName("import") ?? node.namedChildren.find((c) => c.type === "qualified_name" || c.type === "identifier");
    return n?.text ?? null;
  }
  if (lang === "c" || lang === "cpp") {
    // A local `#include "x.h"` is a file dependency; a system `<...>` include is
    // external noise, so it's dropped (no edge).
    const s = node.namedChildren.find((c) => c.type === "string_literal");
    if (!s) return null;
    const frag = s.namedChildren.find((c) => c.type === "string_content");
    return frag?.text ?? s.text.replace(/^"|"$/g, "");
  }
  const str = node.namedChildren.find((c) => c.type === "string");
  if (!str) return null;
  const frag = str.namedChildren.find((c) => c.type === "string_fragment");
  return frag?.text ?? str.text.replace(/^['"]|['"]$/g, "");
}

/** Signature = the definition header, whitespace-collapsed, trailing punctuation stripped. */
function clean(raw: string): string | null {
  const sig = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(=>|[{:=])\s*$/, "")
    .trim();
  return sig || null;
}

/** TS: a definition is exported if any ancestor is an `export` statement. */
function tsExported(node: SyntaxNode): boolean {
  let p = node.parent;
  while (p) {
    if (p.type === "export_statement") return true;
    p = p.parent;
  }
  return false;
}

/** C# call shapes. A bare `Foo()` invocation is an implicit-`this` method call
 * (C# has no free functions), routed â€” like Java's â€” through owner-qualified
 * resolution; `recv.Foo()` / `this.Foo()` carry their receiver; `new T()` targets
 * the constructed type as the graph names it. */
function csharpCallee(node: Parser.SyntaxNode): { name: string; viaMember: boolean; receiver?: string } | null {
  if (node.type === "object_creation_expression") {
    const type = node.childForFieldName("type") ?? node.namedChildren.find((c) => c.type !== "argument_list");
    const name = type ? csharpTypeName(type) : null;
    return name ? { name, viaMember: false } : null;
  }
  const fn = node.childForFieldName("function") ?? node.namedChildren[0];
  if (!fn) return null;
  if (fn.type === "member_access_expression") {
    const nm = fn.childForFieldName("name") ?? fn.namedChildren.at(-1);
    if (!nm) return null;
    const expr = fn.childForFieldName("expression");
    const receiver = !expr || expr.type === "this_expression" ? "this" : expr.type === "identifier" ? expr.text : undefined;
    return { name: nm.text, viaMember: true, receiver };
  }
  if (fn.type === "identifier") return { name: fn.text, viaMember: true, receiver: "this" };
  return null;
}

/** The type a C# `new` constructs, type arguments and namespace qualifier erased
 * (`new Box<int>()` â†’ `Box`). Null when the node isn't a plain named type. */
function csharpTypeName(node: Parser.SyntaxNode): string | null {
  if (node.type === "generic_name") return csharpTypeName(node.namedChildren[0] ?? node);
  if (node.type === "qualified_name") return node.text.replace(/^.*\./, "") || null;
  return node.type === "identifier" ? node.text : null;
}

/** C# visibility: `public`/`protected`/`internal` on the declaration's own
 * modifier list make it API surface; an explicit `private` (or a bare member,
 * which defaults to private) does not. */
function csharpExported(node: Parser.SyntaxNode): boolean {
  const mods = node.namedChildren.filter((c) => c.type === "modifier").map((c) => c.text);
  if (mods.includes("private")) return false;
  return mods.includes("public") || mods.includes("protected") || mods.includes("internal");
}

/** Groovy call shapes: `foo(...)` (function = identifier) is a free/implicit call;
 * `a.b(...)` (function = dotted_identifier) is a member call whose name is the
 * trailing segment and whose receiver, when a bare identifier, types the call. */
function groovyCallee(node: Parser.SyntaxNode): { name: string; viaMember: boolean; receiver?: string } | null {
  const fn = node.childForFieldName("function") ?? node.namedChildren[0];
  if (!fn) return null;
  // A bare `foo(...)` inside a class is an implicit-`this` method call; at file
  // scope `this` types to nothing, so it degrades to a name-only (free) match â€”
  // the same routing C#/Java use for their receiver-less calls.
  if (fn.type === "identifier") return { name: fn.text, viaMember: true, receiver: "this" };
  if (fn.type === "dotted_identifier") {
    const last = fn.namedChildren.at(-1);
    if (last?.type !== "identifier") return null;
    const first = fn.namedChildren[0];
    const receiver = fn.namedChildren.length >= 2 && first?.type === "identifier" ? first.text : undefined;
    return { name: last.text, viaMember: true, receiver };
  }
  return null;
}

/** Groovy visibility: members default to public; only an explicit `private`
 * modifier hides one. */
function groovyExported(node: Parser.SyntaxNode): boolean {
  return !node.namedChildren.some((c) => c.type === "modifier" && c.text === "private");
}

/** C/C++ call shapes: a free `foo()` (function = identifier); a member `obj.m()` /
 * `p->m()` (field_expression, name = trailing field); a qualified `NS::f()`
 * (qualified_identifier, name = trailing segment). Receiver typing isn't wired for
 * C/C++, so member/qualified calls resolve by name only. */
function cCallee(node: Parser.SyntaxNode): { name: string; viaMember: boolean; receiver?: string } | null {
  const fn = node.childForFieldName("function") ?? node.namedChildren[0];
  if (!fn) return null;
  if (fn.type === "identifier") return { name: fn.text, viaMember: false };
  if (fn.type === "field_expression") {
    const field = fn.childForFieldName("field") ?? fn.namedChildren.at(-1);
    return field ? { name: field.text, viaMember: true } : null;
  }
  if (fn.type === "qualified_identifier") {
    const name = fn.childForFieldName("name") ?? fn.namedChildren.at(-1);
    return name ? { name: name.text, viaMember: true } : null;
  }
  return null;
}

/** PL/SQL call. Two shapes reach here (see CALL_TYPES.plsql):
 *   - a `ref_call`: a `referenced_element` plus arguments â€” `log_it('x')`,
 *     `v := pkg.calc(1)`;
 *   - a `statement` whose only child is a `referenced_element` â€” a procedure
 *     called with no arguments (`log_it;`). Any other statement is not a call.
 * The referenced element is a dotted chain of identifiers: the LAST one is the
 * sub-program, the one before it (if any) its package â€” `hr.util_pkg.log_it`
 * names `util_pkg.log_it` in schema `hr`, and the schema adds nothing to an
 * in-repo lookup. The package goes out as the receiver; resolve.ts reads it as
 * the owning package's name, case-insensitively, like Oracle.
 * A call across a database link (`pkg.proc@remote_db(â€¦)`) runs in ANOTHER
 * database, so whatever in-repo code shares its name is not its target: dropped.
 * `kinds`: a sub-program may be a procedure or a function. A bare statement
 * with no arguments can only be a procedure call (a function's result cannot be
 * discarded in PL/SQL), so only that shape narrows to procedures. */
function plsqlCallee(
  node: Parser.SyntaxNode,
): { name: string; viaMember: boolean; receiver?: string; kinds: Kind[] } | null {
  let ref: Parser.SyntaxNode | undefined;
  const asStatement = node.type === "statement";
  if (asStatement) {
    const only = node.namedChildren;
    if (only.length !== 1 || only[0].type !== "referenced_element") return null;
    ref = only[0];
  } else {
    ref = node.childForFieldName("referenced_element") ?? node.namedChildren.find((c) => c.type === "referenced_element");
  }
  if (!ref) return null;
  if (node.namedChildren.some((c) => c.type === "db_link") || ref.namedChildren.some((c) => c.type === "db_link")) {
    return null;
  }
  const parts = ref.namedChildren.filter((c) => c.type === "identifier").map((c) => c.text.replace(/^"|"$/g, ""));
  const name = parts.at(-1);
  if (!name) return null;
  const receiver = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  return {
    name,
    viaMember: receiver !== undefined,
    ...(receiver !== undefined ? { receiver } : {}),
    kinds: asStatement ? ["procedure"] : ["procedure", "function"],
  };
}

/** A bare file node for a language with no symbol structure to extract (Razor)
 * or whose optional grammar isn't built. Mirrors the walk path's file node. */
export function fileNodeOf(rel: string, source: string): NodeV1 {
  return {
    id: rel,
    name: basename(rel),
    kind: "file",
    path: rel,
    span: `L1-L${Math.max(1, source.split("\n").length)}`,
    signature: null,
    exported: true,
    origin: "ast",
    body_hash: contentHash(source),
    chars: source.length,
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

/** CSS: one `rule` node per rule-set, named by its selector text (`.foo`, `#bar`,
 * `div > p.item`), each contained by the file. Style has no call graph. */
function extractCss(rel: string, source: string, root: Parser.SyntaxNode): ExtractResult {
  const nodes: NodeV1[] = [fileNodeOf(rel, source)];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === "rule_set") {
      const sel = node.namedChildren.find((c) => c.type === "selectors");
      const name = sel ? sel.text.replace(/\s+/g, " ").trim() : null;
      if (name) {
        const id = mintId(`${rel}#${name}`, minted);
        nodes.push(markupNode(id, name, "rule", rel, node));
        rawEdges.push({ source: rel, relation: "contains", targetId: id, file: rel });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return { nodes, rawEdges };
}

/** HTML: one `element` node per id'd element, named by its `id`, scoped under the
 * nearest id'd ancestor (`hero.lnk`) and contained by it (else the file). Elements
 * without an id are transparent to the scope path but still recursed into. */
function extractHtml(rel: string, source: string, root: Parser.SyntaxNode): ExtractResult {
  const nodes: NodeV1[] = [fileNodeOf(rel, source)];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  const visit = (node: Parser.SyntaxNode, scope: string[], parentId: string): void => {
    let scopeNext = scope;
    let parentNext = parentId;
    if (node.type === "element") {
      const eid = htmlElementId(node);
      if (eid) {
        const id = mintId(`${rel}#${[...scope, eid].join(".")}`, minted);
        nodes.push(markupNode(id, eid, "element", rel, node));
        rawEdges.push({ source: parentId, relation: "contains", targetId: id, file: rel });
        scopeNext = [...scope, eid];
        parentNext = id;
      }
    }
    for (const child of node.namedChildren) visit(child, scopeNext, parentNext);
  };
  visit(root, [], rel);
  return { nodes, rawEdges };
}

/** The `id` attribute value of an HTML element's (self-closing) start tag, or null. */
function htmlElementId(element: Parser.SyntaxNode): string | null {
  const start = element.namedChildren.find((c) => c.type === "start_tag" || c.type === "self_closing_tag");
  for (const attr of start?.namedChildren ?? []) {
    if (attr.type !== "attribute") continue;
    const nameNode = attr.namedChildren.find((c) => c.type === "attribute_name");
    if (nameNode?.text.toLowerCase() !== "id") continue;
    const val = attr.namedChildren.find((c) => c.type === "quoted_attribute_value" || c.type === "attribute_value");
    if (!val) return null;
    const inner = val.type === "quoted_attribute_value" ? val.namedChildren.find((c) => c.type === "attribute_value") : val;
    const text = (inner ?? val).text.replace(/^["']|["']$/g, "").trim();
    return text || null;
  }
  return null;
}

/** XML, incl. .NET config (Web.config/App.config) and MSBuild files (.csproj/.props/
 * .targets). One `element` node per identifiable element â€” named by its
 * `name`/`key`/`id`/`Include` attribute (config entries like `<add key="ApiUrl"/>`,
 * `<PackageReference Include="X"/>`), or, for a container element with child
 * elements, by its tag (`configuration`, `appSettings`). Leaf elements with
 * neither are transparent; symbols nest under their enclosing element. */
function extractXml(rel: string, source: string, root: Parser.SyntaxNode): ExtractResult {
  const nodes: NodeV1[] = [fileNodeOf(rel, source)];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  const visit = (node: Parser.SyntaxNode, scope: string[], parentId: string): void => {
    let scopeNext = scope;
    let parentNext = parentId;
    if (node.type === "element") {
      const name = xmlElementName(node);
      if (name) {
        const id = mintId(`${rel}#${[...scope, name].join(".")}`, minted);
        nodes.push(markupNode(id, name, "element", rel, node));
        rawEdges.push({ source: parentId, relation: "contains", targetId: id, file: rel });
        scopeNext = [...scope, name];
        parentNext = id;
      }
    }
    for (const child of node.namedChildren) visit(child, scopeNext, parentNext);
  };
  visit(root, [], rel);
  return { nodes, rawEdges };
}

/** Mark every node of a structural-only language (XML) as having no meaning tier
 * (`summary_state: "none"`): the `--deep` pass skips them instead of spending an
 * LLM call per config entry, and `graft check` does not report them as pending. */
function structuralOnly(result: ExtractResult): ExtractResult {
  for (const n of result.nodes) n.summary_state = "none";
  return result;
}

/** An XML element's symbol name: its `name`/`key`/`id`/`Include` attribute value
 * (the identifier a config entry or MSBuild item is keyed by), else its tag name
 * when it contains child elements, else null (a plain leaf carries no symbol). */
function xmlElementName(element: Parser.SyntaxNode): string | null {
  const tag = element.namedChildren.find((c) => c.type === "STag" || c.type === "EmptyElemTag");
  if (!tag) return null;
  for (const want of ["name", "key", "id", "include"]) {
    for (const attr of tag.namedChildren) {
      if (attr.type !== "Attribute") continue;
      const an = attr.namedChildren.find((c) => c.type === "Name");
      // Compare the LOCAL name so XAML's namespaced `x:Name`/`x:Key` still match.
      if (an?.text.toLowerCase().replace(/^[^:]*:/, "") !== want) continue;
      const av = attr.namedChildren.find((c) => c.type === "AttValue");
      const val = av?.text.replace(/^["']|["']$/g, "").trim();
      if (val) return val;
    }
  }
  const content = element.namedChildren.find((c) => c.type === "content");
  if (content?.namedChildren.some((c) => c.type === "element")) {
    return tag.namedChildren.find((c) => c.type === "Name")?.text ?? null;
  }
  return null;
}

/** A markup symbol node (CSS rule / HTML element / XML element): its source span,
 * searchable body, and the selector/id/name as both name and signature. */
function markupNode(id: string, name: string, kind: Kind, rel: string, node: Parser.SyntaxNode): NodeV1 {
  return {
    id,
    name,
    kind,
    path: rel,
    span: `L${node.startPosition.row + 1}-L${node.endPosition.row + 1}`,
    signature: name,
    exported: true,
    origin: "ast",
    body_hash: contentHash(node.text),
    body_text: searchBody(node.text),
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

/** JSON: one node per object member key, scoped by object nesting
 * (`scripts.build`), so a config's structure is queryable. Arrays and scalars
 * carry no key, so they add no symbols; array elements are recursed for nested
 * objects but not indexed. */
function extractJson(rel: string, source: string, root: Parser.SyntaxNode): ExtractResult {
  const nodes: NodeV1[] = [fileNodeOf(rel, source)];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  const visit = (node: Parser.SyntaxNode, scope: string[], parentId: string): void => {
    if (node.type === "object") {
      for (const pair of node.namedChildren) {
        if (pair.type !== "pair") continue;
        const keyNode = pair.childForFieldName("key") ?? pair.namedChildren[0];
        const key = keyNode ? jsonString(keyNode) : null;
        if (!key) continue;
        const id = mintId(`${rel}#${[...scope, key].join(".")}`, minted);
        nodes.push(markupNode(id, key, "variable", rel, pair));
        rawEdges.push({ source: parentId, relation: "contains", targetId: id, file: rel });
        const value = pair.childForFieldName("value") ?? pair.namedChildren.at(-1);
        if (value) visit(value, [...scope, key], id);
      }
      return;
    }
    for (const child of node.namedChildren) visit(child, scope, parentId);
  };
  visit(root, [], rel);
  return { nodes, rawEdges };
}

/** The text of a JSON string node without its surrounding quotes. */
function jsonString(node: Parser.SyntaxNode): string | null {
  if (node.type !== "string") return null;
  const content = node.namedChildren.find((c) => c.type === "string_content");
  return (content?.text ?? node.text.replace(/^"|"$/g, "")) || null;
}

/** YAML: one node per mapping key, scoped by nesting (`services.web.image`). */
function extractYaml(rel: string, source: string, root: Parser.SyntaxNode): ExtractResult {
  const nodes: NodeV1[] = [fileNodeOf(rel, source)];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  const visit = (node: Parser.SyntaxNode, scope: string[], parentId: string): void => {
    if (node.type === "block_mapping_pair" || node.type === "flow_pair") {
      const keyNode = node.childForFieldName("key") ?? node.namedChildren[0];
      const key = keyNode ? yamlScalar(keyNode) : null;
      if (key) {
        const id = mintId(`${rel}#${[...scope, key].join(".")}`, minted);
        nodes.push(markupNode(id, key, "variable", rel, node));
        rawEdges.push({ source: parentId, relation: "contains", targetId: id, file: rel });
        const value = node.childForFieldName("value");
        if (value) visit(value, [...scope, key], id);
        return;
      }
    }
    for (const child of node.namedChildren) visit(child, scope, parentId);
  };
  visit(root, [], rel);
  return { nodes, rawEdges };
}

/** The scalar text of a YAML key/flow node (`flow_node â†’ plain_scalar â†’ â€¦`). */
function yamlScalar(node: Parser.SyntaxNode): string | null {
  let n: Parser.SyntaxNode | null = node;
  const wrappers = new Set(["flow_node", "plain_scalar", "single_quote_scalar", "double_quote_scalar", "block_scalar"]);
  while (n && n.namedChildCount > 0 && wrappers.has(n.type)) n = n.namedChildren[0];
  return n ? n.text.replace(/^["']|["']$/g, "").trim() || null : null;
}

/** Markdown: one `heading` node per ATX/setext heading, named by its text and
 * scoped under its ancestor headings (`Title.Section A.Sub`) via the section tree. */
function extractMarkdown(rel: string, source: string, root: Parser.SyntaxNode): ExtractResult {
  const nodes: NodeV1[] = [fileNodeOf(rel, source)];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  const visit = (node: Parser.SyntaxNode, scope: string[], parentId: string): void => {
    if (node.type === "section") {
      const h = node.namedChildren.find((c) => c.type === "atx_heading" || c.type === "setext_heading");
      const text = h ? markdownHeadingText(h, source) : null;
      if (text) {
        const id = mintId(`${rel}#${[...scope, text].join(".")}`, minted);
        nodes.push(markupNode(id, text, "heading", rel, h!));
        rawEdges.push({ source: parentId, relation: "contains", targetId: id, file: rel });
        for (const child of node.namedChildren) visit(child, [...scope, text], id);
        return;
      }
    }
    for (const child of node.namedChildren) visit(child, scope, parentId);
  };
  visit(root, [], rel);
  return { nodes, rawEdges };
}

/** An ATX/setext heading's text (its `inline` content), whitespace-collapsed. */
function markdownHeadingText(node: Parser.SyntaxNode, source: string): string | null {
  const inline = node.namedChildren.find((c) => c.type === "inline" || c.type === "heading_content");
  const raw = inline ? source.slice(inline.startIndex, inline.endIndex) : "";
  return raw.replace(/\s+/g, " ").trim() || null;
}

/** SCSS: rules (by selector), mixins/functions (by name), top-level variables, and
 * `@include name(...)` as a `calls` edge to the mixin â€” the one call-like relation
 * style has. */
function extractScss(rel: string, source: string, root: Parser.SyntaxNode): ExtractResult {
  const nodes: NodeV1[] = [fileNodeOf(rel, source)];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  const visit = (node: Parser.SyntaxNode, parentId: string): void => {
    const mint = (name: string, kind: Kind, n: Parser.SyntaxNode): string => {
      const id = mintId(`${rel}#${name}`, minted);
      nodes.push(markupNode(id, name, kind, rel, n));
      rawEdges.push({ source: parentId, relation: "contains", targetId: id, file: rel });
      return id;
    };
    let parentNext = parentId;
    if (node.type === "rule_set") {
      const sel = node.namedChildren.find((c) => c.type === "selectors");
      const name = sel ? sel.text.replace(/\s+/g, " ").trim() : null;
      if (name) parentNext = mint(name, "rule", node);
    } else if (node.type === "mixin_statement" || node.type === "function_statement") {
      const name = node.namedChildren.find((c) => c.type === "identifier")?.text;
      if (name) parentNext = mint(name, "function", node);
    } else if (node.type === "declaration" && parentId === rel) {
      const prop = node.namedChildren.find((c) => c.type === "property_name");
      if (prop?.text.startsWith("$")) mint(prop.text, "variable", node);
    } else if (node.type === "include_statement") {
      const name = node.namedChildren.find((c) => c.type === "identifier")?.text;
      if (name) rawEdges.push({ source: parentId, relation: "calls", name, file: rel });
    }
    for (const child of node.namedChildren) visit(child, parentNext);
  };
  visit(root, rel);
  return { nodes, rawEdges };
}

/** CMake commands that define a build target, named by their first argument. */
const CMAKE_TARGET_COMMANDS = new Set(["add_library", "add_executable", "add_custom_target"]);
/** CMake commands whose arguments after the first name other targets it depends on. */
const CMAKE_TARGET_DEP_COMMANDS = new Set(["target_link_libraries", "add_dependencies"]);
/** Keywords inside those argument lists â€” never target names. */
const CMAKE_LINK_KEYWORDS = new Set([
  "PRIVATE", "PUBLIC", "INTERFACE", "LINK_PRIVATE", "LINK_PUBLIC", "LINK_INTERFACE_LIBRARIES",
  "debug", "optimized", "general",
]);
/** Commands that pull in another CMake file: include(<file|module>), add_subdirectory(<dir>).
 * Resolved by resolveCmakeImport (resolve.ts). */
const CMAKE_IMPORT_COMMANDS = new Set(["include", "add_subdirectory"]);
const CMAKE_SIGNATURE_MAX = 160;

/** A CMake argument's value: an unquoted word as written, a quoted string without its
 * quotes, a bracket argument's content. */
function cmakeArgValue(arg: Parser.SyntaxNode): string {
  const inner = arg.namedChildren[0];
  if (!inner) return arg.text;
  if (inner.type === "quoted_argument") return inner.text.replace(/^"|"$/g, "");
  if (inner.type === "bracket_argument") {
    return inner.namedChildren.find((c) => c.type === "bracket_argument_content")?.text ?? "";
  }
  return inner.text;
}

/** The `argument` nodes of a command (`normal_command`, `function_command`, â€¦). */
function cmakeArgs(command: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const list = command.namedChildren.find((c) => c.type === "argument_list");
  return list ? list.namedChildren.filter((c) => c.type === "argument") : [];
}

/** A literal name, or null when it is built from a variable (`${PROJECT_NAME}`) and so
 * cannot be known without evaluating the script. */
function cmakeLiteral(value: string): string | null {
  const v = value.trim();
  return v && !v.includes("${") && !v.includes("$<") ? v : null;
}

/**
 * CMake (CMakeLists.txt, *.cmake). A CMake script is a flat list of commands, so it
 * gets its own walker instead of the definition/call walk:
 * - `function()` / `macro()` definitions become `function` nodes spanning to their
 *   `endfunction()` / `endmacro()`;
 * - `add_library` / `add_executable` / `add_custom_target` become `target` nodes;
 * - every other command invocation is a `calls` edge, from the enclosing function or
 *   macro (else the file), so a call to a project function resolves and a builtin
 *   (`set`, `message`, â€¦) finds nothing and drops;
 * - `target_link_libraries` / `add_dependencies` name the targets a target depends on:
 *   `references` edges from the target (when it is defined in this file) to each one;
 * - `include()` and `add_subdirectory()` are `imports` edges, resolved to the in-repo
 *   file in resolve.ts;
 * - `option()` becomes a `variable` node: the project's own build switches.
 * CMake command names are case-insensitive, so function names and calls are keyed in
 * lower case (`MACRO(My_Helper)` is called as `my_helper()`); signatures keep the source.
 */
function extractCmake(rel: string, source: string, root: Parser.SyntaxNode): ExtractResult {
  const nodes: NodeV1[] = [fileNodeOf(rel, source)];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  // Targets defined in this file, by name: the source of their dependency edges.
  const targets = new Map<string, string>();

  const mint = (name: string, kind: Kind, node: Parser.SyntaxNode, header: Parser.SyntaxNode, parentId: string): string => {
    const id = mintId(`${rel}#${name}`, minted);
    const sig = header.text.replace(/\s+/g, " ").trim();
    nodes.push({
      id,
      name,
      kind,
      path: rel,
      span: `L${node.startPosition.row + 1}-L${node.endPosition.row + 1}`,
      signature: sig.length > CMAKE_SIGNATURE_MAX ? `${sig.slice(0, CMAKE_SIGNATURE_MAX - 1)}â€¦` : sig,
      exported: true, // CMake functions, macros and targets are global once defined
      origin: "ast",
      body_hash: contentHash(node.text),
      body_text: searchBody(node.text),
      summary_state: "pending",
      summary: null,
      crux: null,
    });
    rawEdges.push({ source: parentId, relation: "contains", targetId: id, file: rel });
    return id;
  };

  const command = (node: Parser.SyntaxNode, parentId: string): void => {
    const nameNode = node.namedChildren.find((c) => c.type === "identifier");
    if (!nameNode) return;
    const cmd = nameNode.text.toLowerCase();
    const values = cmakeArgs(node).map(cmakeArgValue);

    if (CMAKE_TARGET_COMMANDS.has(cmd)) {
      const name = cmakeLiteral(values[0] ?? "");
      if (name) {
        const id = mint(name, "target", node, node, parentId);
        if (!targets.has(name)) targets.set(name, id);
        // `add_library(ns::core ALIAS core)`: the alias stands for the real target.
        if (values[1] === "ALIAS" && values[2]) {
          const real = cmakeLiteral(values[2]);
          if (real) rawEdges.push({ source: id, relation: "references", name: real, file: rel });
        }
      }
      return;
    }
    if (CMAKE_TARGET_DEP_COMMANDS.has(cmd)) {
      const owner = cmakeLiteral(values[0] ?? "");
      const from = (owner && targets.get(owner)) ?? parentId;
      for (const v of values.slice(1)) {
        const dep = cmakeLiteral(v);
        // Flags (`-lm`), paths and generator expressions are not targets.
        if (!dep || CMAKE_LINK_KEYWORDS.has(dep) || /^-|[/\\]/.test(dep)) continue;
        rawEdges.push({ source: from, relation: "references", name: dep, file: rel });
      }
      return;
    }
    if (CMAKE_IMPORT_COMMANDS.has(cmd)) {
      const arg = values[0]?.trim().replace(/[/\\]+$/, "");
      // add_subdirectory(src) runs src/CMakeLists.txt: name that file, so the import
      // resolves like any other path.
      const spec = arg && (cmd === "add_subdirectory" ? `${arg}/CMakeLists.txt` : arg);
      if (spec) rawEdges.push({ source: rel, relation: "imports", specifier: spec, file: rel });
      return;
    }
    if (cmd === "option") {
      const name = cmakeLiteral(values[0] ?? "");
      if (name) mint(name, "variable", node, node, parentId);
      return;
    }
    rawEdges.push({ source: parentId, relation: "calls", name: cmd, file: rel });
  };

  const visit = (node: Parser.SyntaxNode, parentId: string): void => {
    if (node.type === "function_def" || node.type === "macro_def") {
      const header = node.namedChildren.find((c) => c.type === "function_command" || c.type === "macro_command");
      const name = header ? cmakeLiteral(cmakeArgValue(cmakeArgs(header)[0] ?? header)) : null;
      if (header && name && cmakeArgs(header).length > 0) {
        const id = mint(name.toLowerCase(), "function", node, header, parentId);
        for (const child of node.namedChildren) if (child.type === "body") visit(child, id);
        return;
      }
    }
    if (node.type === "normal_command") {
      command(node, parentId);
      return;
    }
    for (const child of node.namedChildren) visit(child, parentId);
  };
  visit(root, rel);
  nodes[0].body_text = fileResidual(source, nodes.slice(1));
  return { nodes, rawEdges };
}

/** Shell commands that run another script in the current shell: an import. */
const BASH_SOURCE_COMMANDS = new Set(["source", "."]);

/** A shell word as written, without surrounding quotes when it is a plain string. */
function bashWord(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "word" || node.type === "raw_string") return node.text.replace(/^'|'$/g, "");
  if (node.type === "string") return node.text.replace(/^"|"$/g, "");
  return node.text;
}

/**
 * Bash (`*.sh`, `*.bash`, `.bashrc`, `.bash_profile`). Shell has one kind of
 * definition and one kind of statement, so it gets its own walker:
 * - `function name { â€¦ }` / `name() { â€¦ }` become `function` nodes;
 * - every command invocation is a `calls` edge to its command name, from the
 *   enclosing function (else the file). A call to a function of this project
 *   resolves; an external program (`make`, `grep`) or a builtin finds nothing and
 *   drops;
 * - `source f` / `. f` is an `imports` edge, resolved in resolve.ts relative to the
 *   sourcing script.
 * Command names built from expansions (`$cmd`, `"${tool}"`) are left alone: what they
 * run is only known at run time.
 */
function extractBash(rel: string, source: string, root: Parser.SyntaxNode): ExtractResult {
  const nodes: NodeV1[] = [fileNodeOf(rel, source)];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);

  const visit = (node: Parser.SyntaxNode, parentId: string): void => {
    if (node.type === "function_definition") {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        const id = mintId(`${rel}#${name}`, minted);
        const body = node.childForFieldName("body");
        const header = body ? source.slice(node.startIndex, body.startIndex) : node.text.split("\n")[0]!;
        nodes.push({
          id,
          name,
          kind: "function",
          path: rel,
          span: `L${node.startPosition.row + 1}-L${node.endPosition.row + 1}`,
          signature: clean(header),
          exported: true,
          origin: "ast",
          body_hash: contentHash(node.text),
          body_text: searchBody(node.text),
          summary_state: "pending",
          summary: null,
          crux: null,
        });
        rawEdges.push({ source: parentId, relation: "contains", targetId: id, file: rel });
        for (const child of node.namedChildren) visit(child, id);
        return;
      }
    }
    if (node.type === "command") {
      const nameNode = node.childForFieldName("name");
      const word = nameNode?.namedChildren[0];
      const name = word && word.type === "word" ? word.text : null;
      if (name) {
        if (BASH_SOURCE_COMMANDS.has(name)) {
          const arg = bashWord(node.childrenForFieldName("argument")[0]);
          if (arg) rawEdges.push({ source: rel, relation: "imports", specifier: arg, file: rel });
        } else {
          rawEdges.push({ source: parentId, relation: "calls", name, file: rel });
        }
      }
    }
    for (const child of node.namedChildren) visit(child, parentId);
  };
  visit(root, rel);
  nodes[0].body_text = fileResidual(source, nodes.slice(1));
  return { nodes, rawEdges };
}

/** Perl pragmas: `use strict` and friends configure the compiler and name no module. */
const PERL_PRAGMAS = new Set([
  "strict", "warnings", "utf8", "lib", "vars", "constant", "feature", "integer", "bytes", "overload",
  "subs", "less", "sort", "open", "locale", "bigint", "bignum", "bigrat", "diagnostics", "autodie",
  "re", "if", "experimental", "version", "mro", "base", "parent", "fields", "encoding",
]);

/** A Perl quoted string's text without its quotes (`'a'`, `"a"`). */
function perlString(node: Parser.SyntaxNode): string {
  return node.text.replace(/^(['"])([\s\S]*)\1$/, "$2");
}

/** The package names a `use base` / `use parent` / `@ISA` list names: quoted strings
 * and `qw(...)` items, minus the `-norequire` flag. */
function perlNameList(node: Parser.SyntaxNode): string[] {
  const out: string[] = [];
  const visit = (n: Parser.SyntaxNode): void => {
    if (n.type === "string_single_quoted" || n.type === "string_double_quoted") out.push(perlString(n));
    else if (n.type === "list_item") out.push(n.text);
    else for (const c of n.namedChildren) visit(c);
  };
  visit(node);
  return out.map((s) => s.trim()).filter((s) => /^[A-Za-z_]\w*(?:::\w+)*$/.test(s));
}

/**
 * Perl (`*.pl`, `*.pm`, `*.t`). A package is a namespace, not a lexical block â€” every
 * `package X;` statement switches the current package for what follows â€” so it gets
 * its own walker:
 * - `package X;` and `package X { â€¦ }` become `package` nodes, spanning their block or
 *   up to the next `package` statement;
 * - `sub name { â€¦ }` becomes a `method` owned by the current package (keyed by the full
 *   package name, so `My::Util->new()` resolves to `My::Util`'s `new` and never to
 *   `Other::Util`'s), id'd `file#Pkg::name`; a `function` in a script with no package;
 * - `foo(â€¦)`, `foo â€¦`, `&foo(â€¦)` and `Pkg::foo(â€¦)` are `calls` edges; `Pkg->m(â€¦)` is a
 *   member call typed by `Pkg`; `$obj->m(â€¦)` is too, with the enclosing package as the
 *   type when the receiver is `$self` / `$class`;
 * - `use Module` / `require Module` are `imports` edges (pragmas like `strict` are not),
 *   resolved to the in-repo `.pm` in resolve.ts;
 * - `use parent` / `use base` / `our @ISA = (â€¦)` are `extends` edges from the package.
 * Builtins (`print`, `bless`, `shift`) are calls to names nothing defines, so they drop.
 */
function extractPerl(rel: string, source: string, root: Parser.SyntaxNode): ExtractResult {
  const nodes: NodeV1[] = [fileNodeOf(rel, source)];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  const lines = source.split("\n");

  const mint = (name: string, kind: Kind, node: Parser.SyntaxNode, endRow: number, parentId: string, owner?: string): string => {
    const id = mintId(`${rel}#${owner ? `${owner}::${name}` : name}`, minted);
    const body = node.childForFieldName("body");
    const header = body ? source.slice(node.startIndex, body.startIndex) : lines[node.startPosition.row] ?? node.text;
    const text = lines.slice(node.startPosition.row, endRow + 1).join("\n");
    nodes.push({
      id,
      name,
      kind,
      path: rel,
      span: `L${node.startPosition.row + 1}-L${endRow + 1}`,
      signature: clean(header.replace(/;\s*$/, "")),
      exported: !name.startsWith("_"), // Perl's convention for a private sub
      origin: "ast",
      body_hash: contentHash(text),
      body_text: searchBody(text),
      summary_state: "pending",
      summary: null,
      crux: null,
      ...(owner ? { owner } : {}),
    });
    rawEdges.push({ source: parentId, relation: "contains", targetId: id, file: rel });
    return id;
  };

  /** The package in effect: its node id and its full name (the owner key of its subs). */
  type Pkg = { id: string; name: string };

  const walk = (children: Parser.SyntaxNode[], pkg: Pkg | null, parentId: string): void => {
    let current = pkg;
    let currentParent = parentId;
    children.forEach((node, i) => {
      if (node.type === "package_statement") {
        const name = node.namedChildren.find((c) => c.type === "package_name")?.text;
        if (!name) return;
        const block = node.childForFieldName("body");
        if (block) {
          // `package X { â€¦ }`: scoped to the block.
          const id = mint(name, "package", node, node.endPosition.row, parentId);
          walk(block.namedChildren, { id, name }, id);
          return;
        }
        // `package X;`: runs until the next package statement at this level â€” to the
        // last statement before it, so trailing blank lines are not part of the span.
        const rest = children.slice(i + 1);
        const nextAt = rest.findIndex((c) => c.type === "package_statement");
        const owned = nextAt === -1 ? rest : rest.slice(0, nextAt);
        const end = owned.length > 0 ? owned[owned.length - 1]!.endPosition.row : node.endPosition.row;
        const id = mint(name, "package", node, Math.max(node.startPosition.row, end), parentId);
        current = { id, name };
        currentParent = id;
        return;
      }
      statement(node, current, currentParent);
    });
  };

  const fromOf = (pkg: Pkg | null, parentId: string) => pkg?.id ?? parentId;

  const statement = (node: Parser.SyntaxNode, pkg: Pkg | null, parentId: string): void => {
    switch (node.type) {
      case "function_definition":
      case "function_definition_without_sub": {
        const name = node.childForFieldName("name")?.text;
        if (!name) break;
        const id = pkg
          ? mint(name, "method", node, node.endPosition.row, parentId, pkg.name)
          : mint(name, "function", node, node.endPosition.row, parentId);
        const body = node.childForFieldName("body");
        if (body) for (const c of body.namedChildren) expression(c, pkg, id);
        return;
      }
      case "use_no_statement":
      case "require_statement": {
        if (node.type === "use_no_statement" && node.childForFieldName("no")) break; // `no strict`
        const mod = node.childForFieldName("package_name")?.text;
        if (!mod) break;
        if (mod === "base" || mod === "parent") {
          for (const base of perlNameList(node)) {
            rawEdges.push({ source: fromOf(pkg, parentId), relation: "extends", name: base, file: rel });
            rawEdges.push({ source: rel, relation: "imports", specifier: base, file: rel });
          }
          return;
        }
        if (!PERL_PRAGMAS.has(mod)) rawEdges.push({ source: rel, relation: "imports", specifier: mod, file: rel });
        return;
      }
      case "use_parent_statement": {
        const norequire = node.namedChildren.some((c) => c.type === "no_require");
        for (const base of perlNameList(node)) {
          rawEdges.push({ source: fromOf(pkg, parentId), relation: "extends", name: base, file: rel });
          if (!norequire) rawEdges.push({ source: rel, relation: "imports", specifier: base, file: rel });
        }
        return;
      }
      case "binary_expression": {
        // `our @ISA = ('Base');` / `@ISA = qw(Base)` â€” inheritance by assignment.
        const lhs = node.namedChildren[0];
        if (lhs && /@ISA\b/.test(lhs.text)) {
          for (const base of perlNameList(node.namedChildren[1] ?? node)) {
            rawEdges.push({ source: fromOf(pkg, parentId), relation: "extends", name: base, file: rel });
          }
          return;
        }
        break;
      }
    }
    expression(node, pkg, fromOf(pkg, parentId));
  };

  const expression = (node: Parser.SyntaxNode, pkg: Pkg | null, from: string): void => {
    if (node.type === "function_definition" || node.type === "function_definition_without_sub") {
      statement(node, pkg, from); // a nested named sub
      return;
    }
    if (node.type === "call_expression_with_bareword") {
      const name = node.childForFieldName("function_name")?.text;
      const qualifier = node.childForFieldName("package_name")?.text;
      if (name && qualifier) {
        // `My::Util::log_it(â€¦)`: a sub of a named package â€” typed like `Pkg->m()`.
        rawEdges.push({ source: from, relation: "calls", name, viaMember: true, recvType: qualifier, file: rel });
      } else if (name) {
        // A bare call reaches a sub of the current package or an imported one; both are
        // `method` nodes when they live in a package, so allow either kind.
        rawEdges.push({ source: from, relation: "calls", name, kinds: ["function", "method"], file: rel });
      }
    } else if (node.type === "method_invocation") {
      const name = node.childForFieldName("function_name")?.text;
      const viaPkg = node.childForFieldName("package_name")?.text;
      const obj = (node.childForFieldName("object_return_value") ?? node.childForFieldName("object"))?.text;
      const recvType = viaPkg
        ? viaPkg
        : pkg && (obj === "$self" || obj === "$class" || obj === "__PACKAGE__")
          ? pkg.name
          : undefined;
      if (name) rawEdges.push({ source: from, relation: "calls", name, viaMember: true, recvType, file: rel });
    }
    for (const child of node.namedChildren) expression(child, pkg, from);
  };

  walk(root.namedChildren, null, rel);
  nodes[0].body_text = fileResidual(source, nodes.slice(1));
  return { nodes, rawEdges };
}

/** Make's special targets (`.PHONY`, `.SUFFIXES`, `.DEFAULT_GOAL`, â€¦): directives, not targets. */
const MAKE_SPECIAL_TARGET = /^\.[A-Z_]+$/;
/** `$(MAKE) -C dir â€¦` / `make -C dir`: a recursive make into `dir`'s Makefile. */
const MAKE_RECURSE = /(?:\$[({]MAKE[)}]|\bmake)\s+(?:\S+\s+)*?-C\s*([^\s;|&$()]+)/;

/**
 * Make (`Makefile`, `makefile`, `GNUmakefile`, `*.mk`, `*.mak`):
 * - each literal target of a rule becomes a `target` node spanning its rule (special
 *   targets like `.PHONY` excepted); a target given several rules (`clean::`, or a
 *   rule that only adds prerequisites) is one node, at its first rule;
 * - each literal prerequisite is a `references` edge from the target to the target of
 *   that name, so `graft callers app` lists what depends on `app`;
 * - `NAME = â€¦` / `:=` / `?=` / `+=` define a `variable` node (first assignment), and
 *   `define NAME â€¦ endef` a `function` node â€” what `$(call NAME, â€¦)` invokes;
 * - `$(call NAME)` is a `calls` edge, `$(NAME)` / `${NAME}` a `references` edge, from
 *   the target whose recipe holds it (else the variable being defined, else the file);
 * - `include` / `-include` / `sinclude` and `$(MAKE) -C dir` are `imports` edges,
 *   resolved to the in-repo file in resolve.ts.
 * Rules are never nested in make, so every target is contained by the file â€” even one
 * the grammar parses inside the recipe of the rule before it (a conditional after a
 * recipe lands there).
 */
function extractMake(rel: string, source: string, root: Parser.SyntaxNode): ExtractResult {
  const nodes: NodeV1[] = [fileNodeOf(rel, source)];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  /** Symbols already defined in this file, by kind and name: a re-definition reuses the node. */
  const defined = new Map<string, string>();

  /** The last row `n` really occupies: make's nodes end at the start of the next line,
   * which would put every span one line too long. */
  const lastRow = (n: Parser.SyntaxNode): number =>
    n.endPosition.column === 0 && n.endPosition.row > n.startPosition.row ? n.endPosition.row - 1 : n.endPosition.row;

  const mint = (name: string, kind: Kind, node: Parser.SyntaxNode, header: string, endRow = lastRow(node)): string => {
    const key = `${kind}\0${name}`;
    const known = defined.get(key);
    if (known) return known;
    const id = mintId(`${rel}#${name}`, minted);
    const lines = source.split("\n").slice(node.startPosition.row, endRow + 1).join("\n");
    nodes.push({
      id,
      name,
      kind,
      path: rel,
      span: `L${node.startPosition.row + 1}-L${endRow + 1}`,
      signature: header.replace(/\s+/g, " ").trim() || null,
      exported: true,
      origin: "ast",
      body_hash: contentHash(lines),
      body_text: searchBody(lines),
      summary_state: "pending",
      summary: null,
      crux: null,
    });
    rawEdges.push({ source: rel, relation: "contains", targetId: id, file: rel });
    defined.set(key, id);
    return id;
  };

  /** A literal word (no `$` expansion), or null. */
  const literal = (n: Parser.SyntaxNode): string | null => (n.type === "word" && !n.text.includes("$") ? n.text : null);

  /** `$(call â€¦)`, `$(VAR)` and `$(MAKE) -C dir` anywhere under `node`, attributed to `owner`. */
  const uses = (node: Parser.SyntaxNode, owner: string): void => {
    if (node.type === "rule") {
      rule(node);
      return;
    }
    if (node.type === "function_call" && node.childForFieldName("function")?.text === "call") {
      const first = node.namedChildren.find((c) => c.type === "arguments")?.namedChildren[0];
      const name = first?.text.trim();
      if (name && /^[\w.-]+$/.test(name)) rawEdges.push({ source: owner, relation: "calls", name, file: rel });
    } else if (node.type === "variable_reference") {
      const inner = node.namedChildren[0];
      const name = inner && node.namedChildren.length === 1 ? literal(inner) : null;
      if (name) rawEdges.push({ source: owner, relation: "references", name, kinds: ["variable", "function"], file: rel });
    } else if (node.type === "recipe_line") {
      const dir = MAKE_RECURSE.exec(node.text)?.[1]?.replace(/[/\\]+$/, "");
      if (dir) rawEdges.push({ source: rel, relation: "imports", specifier: `${dir}/Makefile`, file: rel });
    }
    for (const child of node.namedChildren) uses(child, owner);
  };

  const rule = (node: Parser.SyntaxNode): void => {
    const targets = node.namedChildren.find((c) => c.type === "targets");
    const recipe = node.namedChildren.find((c) => c.type === "recipe");
    const header = recipe ? source.slice(node.startIndex, recipe.startIndex) : node.text;
    // The rule ends at its last recipe line â€” not at a conditional (and the rules in it)
    // the grammar nests in the recipe when it follows the rule directly.
    const own = [
      ...node.namedChildren.filter((c) => c.type !== "recipe"),
      ...(recipe?.namedChildren.filter((c) => c.type === "recipe_line") ?? []),
    ];
    const end = Math.max(node.startPosition.row, ...own.map(lastRow));
    const names = (targets?.namedChildren ?? []).map(literal).filter((n): n is string => n !== null);
    const ids = names.filter((n) => !MAKE_SPECIAL_TARGET.test(n)).map((n) => mint(n, "target", node, header, end));
    const owner = ids[0] ?? rel;
    for (const field of ["normal", "order_only"]) {
      for (const prereq of node.childForFieldName(field)?.namedChildren ?? []) {
        const dep = literal(prereq);
        if (dep && !dep.includes("%")) {
          for (const id of ids) rawEdges.push({ source: id, relation: "references", name: dep, kinds: ["target"], file: rel });
        } else {
          uses(prereq, owner); // `$(OBJS)` names a variable
        }
      }
    }
    if (recipe) uses(recipe, owner);
  };

  const visit = (node: Parser.SyntaxNode): void => {
    switch (node.type) {
      case "rule":
        rule(node);
        return;
      case "include_directive":
        for (const f of node.childForFieldName("filenames")?.namedChildren ?? []) {
          const spec = literal(f);
          if (spec) rawEdges.push({ source: rel, relation: "imports", specifier: spec, file: rel });
        }
        return;
      case "define_directive": {
        const name = node.childForFieldName("name")?.text;
        if (!name) break;
        const id = mint(name, "function", node, `define ${name}`);
        const body = node.childForFieldName("value")?.text ?? "";
        // A define body is raw text to the grammar; its `$(call x)` and `$(VAR)` uses
        // are read off it.
        for (const m of body.matchAll(/\$[({]call\s+([\w.-]+)/g)) rawEdges.push({ source: id, relation: "calls", name: m[1]!, file: rel });
        for (const m of body.matchAll(/\$[({]([\w.-]+)[)}]/g)) {
          rawEdges.push({ source: id, relation: "references", name: m[1]!, kinds: ["variable", "function"], file: rel });
        }
        return;
      }
      case "variable_assignment": {
        const name = node.childForFieldName("name")?.text;
        const value = node.childForFieldName("value");
        // `target: VAR = x` is a target-specific value, not a definition of VAR.
        if (!name || name.includes("$") || node.childForFieldName("target_or_pattern")) {
          if (value) uses(value, rel);
          return;
        }
        const id = mint(name, "variable", node, node.text.split("\n")[0]!);
        if (value) uses(value, id);
        return;
      }
    }
    // An expansion at file level (an `ifeq ($(OS),â€¦)` condition, a bare `$(info â€¦)`).
    if (node.type === "variable_reference" || node.type === "function_call" || node.type === "recipe_line") {
      uses(node, rel);
      return;
    }
    // Conditionals, export/override wrappers, â€¦: what they hold is file-level.
    for (const child of node.namedChildren) visit(child);
  };
  for (const child of root.namedChildren) visit(child);
  nodes[0].body_text = fileResidual(source, nodes.slice(1));
  return { nodes, rawEdges };
}

/**
 * The MATLAB namespace a file sits in: the package folders (`+pkg/+sub/`) directly
 * above it, outermost first, and the class folder (`@Cls/`) it belongs to, if any.
 * Package folders only count as one unbroken run up to the file (a plain directory
 * in between starts a new path root), exactly as MATLAB reads them.
 */
export function matlabScope(rel: string): { packages: string[]; classFolder: string | null } {
  const packages: string[] = [];
  let classFolder: string | null = null;
  for (const dir of rel.split(/[/\\]/).slice(0, -1)) {
    if (dir.length > 1 && dir.startsWith("+")) {
      packages.push(dir.slice(1));
      classFolder = null;
    } else if (dir.length > 1 && dir.startsWith("@")) {
      classFolder = dir.slice(1);
    } else {
      packages.length = 0;
      classFolder = null;
    }
  }
  return { packages, classFolder };
}

/** Objective-C shares the `.m` extension; none of these lines can start MATLAB code. */
const OBJC_MARKERS = /^[ \t]*(?:#import|#include|#define|@interface|@implementation|@protocol)\b/m;
/** A `methods`/`properties` block hidden from callers outside the class. */
const MATLAB_PRIVATE_ACCESS = /\bAccess\s*=\s*['"]?(?:private|protected)\b|\bHidden\b(?!\s*=\s*false)/i;
const MATLAB_STATIC = /\bStatic\b(?!\s*=\s*false)/i;
const MATLAB_CONSTANT = /\bConstant\b(?!\s*=\s*false)/i;

/**
 * MATLAB (`*.m`). A MATLAB file is a script, a function file or a classdef file, so it
 * gets its own walker:
 * - `classdef Name < Base & pkg.Other` becomes a `class` node (an `enum` when it has an
 *   `enumeration` block) with `extends` edges to each base, by its last name segment;
 * - functions in its `methods` blocks become `method` nodes owned by the class (not
 *   exported from a private/protected/hidden block); its properties become `variable`
 *   nodes (`constant` in a Constant block) and its enumeration members `constant` nodes;
 * - in a function file the first function is the public one, later ones are local
 *   functions and nested functions are scoped under their parent; in a script file
 *   every function is local. A function file inside a class folder (`@Cls/area.m`)
 *   defines a method of `Cls`;
 * - `f(x)`, `f`, command syntax `f arg` and handles `@f` are `calls` edges, unless `f`
 *   is a variable of that function (a parameter, an output, or assigned in it â€” then
 *   `f(x)` is indexing; nor is the name in a `Name=Value` argument). They resolve by
 *   MATLAB's visibility rules in resolve.ts (resolveMatlabBareCall): this file's own
 *   functions, class and methods, then imported package members, then another file's
 *   own function or class outside a package, else a public method (`m(obj)`);
 * - `obj.m(â€¦)` inside a method, where `obj` is the method's object argument (or the
 *   constructor's output), is a member call typed by the class; `Cls.m(â€¦)` and
 *   `pkg.f(â€¦)` are member calls typed by `Cls` (a static method) that fall back to the
 *   package function `pkg.f`; a call on any other variable has no known type and drops;
 * - `import pkg.f` / `import pkg.*` are `imports` edges, resolved to the in-repo file.
 * MATLAB builtins (`disp`, `zeros`, â€¦) are calls to names nothing defines, so they drop.
 */
function extractMatlab(rel: string, source: string, root: Parser.SyntaxNode): ExtractResult {
  const nodes: NodeV1[] = [fileNodeOf(rel, source)];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  const lines = source.split("\n");
  const { classFolder } = matlabScope(rel);

  /** The last row `n` really occupies (a node ending at column 0 ends on the line before). */
  const lastRow = (n: Parser.SyntaxNode): number =>
    n.endPosition.column === 0 && n.endPosition.row > n.startPosition.row ? n.endPosition.row - 1 : n.endPosition.row;

  const mint = (
    idName: string,
    name: string,
    kind: Kind,
    node: Parser.SyntaxNode,
    signature: string | null,
    exported: boolean,
    parentId: string,
    owner?: string,
  ): string => {
    const id = mintId(`${rel}#${idName}`, minted);
    const end = lastRow(node);
    const text = lines.slice(node.startPosition.row, end + 1).join("\n");
    nodes.push({
      id,
      name,
      kind,
      path: rel,
      span: `L${node.startPosition.row + 1}-L${end + 1}`,
      signature,
      exported,
      origin: "ast",
      body_hash: contentHash(text),
      body_text: searchBody(text),
      summary_state: "pending",
      summary: null,
      crux: null,
      ...(owner ? { owner } : {}),
    });
    rawEdges.push({ source: parentId, relation: "contains", targetId: id, file: rel });
    return id;
  };

  /** Where calls are attributed, which names are variables there, and which of those
   * hold an instance of a known class (a method's object argument). */
  type Scope = { from: string; idName: string | null; locals: Set<string>; typed: Map<string, string> };

  const call = (scope: Scope, name: string): void => {
    rawEdges.push({ source: scope.from, relation: "calls", name, file: rel });
  };
  /** A call through a dotted name: `obj.m()` (typed), `Cls.m()` or `pkg.sub.f()`. */
  const memberCall = (scope: Scope, name: string, qualifier: string[] | null, typed?: string): void => {
    if (typed) {
      rawEdges.push({ source: scope.from, relation: "calls", name, viaMember: true, recvType: typed, file: rel });
    } else if (qualifier && qualifier.length > 0) {
      rawEdges.push({
        source: scope.from,
        relation: "calls",
        name,
        viaMember: true,
        recvType: qualifier[qualifier.length - 1],
        specifier: qualifier.join("."),
        file: rel,
      });
    }
  };
  const importEdge = (spec: string): void => {
    const s = spec.trim().replace(/^['"]|['"]$/g, "");
    if (/^[A-Za-z]\w*(?:\.[A-Za-z]\w*)*(?:\.\*)?$/.test(s)) rawEdges.push({ source: rel, relation: "imports", specifier: s, file: rel });
  };

  /** The variable names an assignment target binds: `x`, `[a, ~, b]`, `x(3)`, `s.f`. */
  const addTarget = (t: Parser.SyntaxNode | null | undefined, into: Set<string>): void => {
    if (!t) return;
    if (t.type === "identifier") into.add(t.text);
    else if (t.type === "multioutput_variable") for (const c of t.namedChildren) addTarget(c, into);
    else if (t.type === "function_call") addTarget(t.childForFieldName("name"), into);
    else if (t.type === "field_expression") addTarget(t.childForFieldName("object"), into);
  };

  /** Every variable a body introduces, nested functions excepted (they get their own). */
  const collectLocals = (node: Parser.SyntaxNode, into: Set<string>): void => {
    switch (node.type) {
      case "function_definition":
      case "class_definition":
        return;
      case "assignment":
        addTarget(node.childForFieldName("left"), into);
        break;
      case "iterator":
        addTarget(node.namedChildren[0], into);
        break;
      case "global_operator":
      case "persistent_operator":
        for (const c of node.namedChildren) addTarget(c, into);
        break;
      case "catch_clause":
        addTarget(node.namedChildren.find((c) => c.type === "identifier"), into);
        break;
      case "lambda":
        for (const c of node.namedChildren.find((c) => c.type === "arguments")?.namedChildren ?? []) addTarget(c, into);
        break;
    }
    for (const c of node.namedChildren) collectLocals(c, into);
  };

  /** `a.b.c(â€¦)`: the call is the first parenthesised field; what precedes it names the
   * receiver. After a call (or an indexed field) the receiver is unknown. */
  const fieldChain = (node: Parser.SyntaxNode, scope: Scope): void => {
    const object = node.childForFieldName("object");
    let qualifier: string[] | null = null;
    let typed: string | undefined;
    if (object?.type === "identifier") {
      const o = object.text;
      if (scope.typed.has(o)) typed = scope.typed.get(o);
      else if (!scope.locals.has(o)) qualifier = [o];
    } else if (object) {
      visit(object, scope);
    }
    for (const field of node.childrenForFieldName("field")) {
      if (field.type === "identifier") {
        qualifier?.push(field.text);
        typed = undefined; // `obj.Prop.m()`: the property's type is unknown
        continue;
      }
      if (field.type === "function_call") {
        const nameNode = field.childForFieldName("name");
        if (nameNode?.type === "identifier") memberCall(scope, nameNode.text, qualifier, typed);
        else if (nameNode) visit(nameNode, scope);
        for (const c of field.namedChildren) if (c.type === "arguments") visit(c, scope);
      } else {
        visit(field, scope); // `s.(name)`: the dynamic field name is an expression
      }
      qualifier = null;
      typed = undefined;
    }
  };

  const visit = (node: Parser.SyntaxNode, scope: Scope): void => {
    switch (node.type) {
      case "comment":
      case "string":
      case "number":
      case "function_output":
      case "function_arguments":
      case "attributes":
      case "global_operator":
      case "persistent_operator":
      case "property_name":
        return;
      case "property": {
        // An `arguments` block entry: its name is a parameter; its type, default value
        // and validators (`{mustBePositive}`) are code.
        const pname = node.childForFieldName("name");
        for (const c of node.namedChildren) if (c !== pname) visit(c, scope);
        return;
      }
      case "function_definition":
        defineFunction(node, { kind: "function", idPrefix: scope.idName, parentId: scope.from, exported: false, outer: scope });
        return;
      case "class_definition":
        defineClass(node);
        return;
      case "lambda": {
        const expr = node.childForFieldName("expression");
        if (expr) visit(expr, scope);
        return;
      }
      case "arguments": {
        // `plot(x, LineWidth=2)`: the option name is the one identifier the grammar
        // leaves out of the `argument` field; it names a parameter, not a function.
        const real = new Set(node.childrenForFieldName("argument").map((c) => c.startIndex));
        for (const c of node.namedChildren) {
          if (c.type === "identifier" && !real.has(c.startIndex)) continue;
          visit(c, scope);
        }
        return;
      }
      case "assignment": {
        // The target binds a variable; only what indexes it (`a(f(1)) = â€¦`) is code.
        const left = node.childForFieldName("left");
        if (left?.type === "function_call") {
          for (const c of left.namedChildren) if (c.type === "arguments") visit(c, scope);
        } else if (left?.type === "field_expression") {
          for (const f of left.childrenForFieldName("field")) {
            for (const c of f.namedChildren) if (c.type === "arguments") visit(c, scope);
          }
        }
        const right = node.childForFieldName("right");
        if (right) visit(right, scope);
        return;
      }
      case "command": {
        const name = node.namedChildren.find((c) => c.type === "command_name")?.text;
        if (!name) return;
        if (name === "import") {
          for (const arg of node.namedChildren) if (arg.type === "command_argument") importEdge(arg.text);
        } else if (!scope.locals.has(name)) {
          call(scope, name);
        }
        return;
      }
      case "function_call": {
        const nameNode = node.childForFieldName("name");
        const args = node.namedChildren.filter((c) => c.type === "arguments");
        if (nameNode?.type === "identifier") {
          const name = nameNode.text;
          if (name === "import") {
            for (const a of args) for (const s of a.namedChildren) if (s.type === "string") importEdge(s.text);
            return;
          }
          // A variable followed by parentheses is indexing, not a call.
          if (!scope.locals.has(name)) call(scope, name);
        } else if (nameNode) {
          visit(nameNode, scope);
        }
        for (const a of args) visit(a, scope);
        return;
      }
      case "field_expression":
        fieldChain(node, scope);
        return;
      case "handle_operator": {
        // `@f` / `@pkg.f`: a function handle, the callback form of a call.
        const parts = node.namedChildren.filter((c) => c.type === "identifier").map((c) => c.text);
        const name = parts.pop();
        if (name && parts.length > 0) memberCall(scope, name, parts);
        else if (name && !scope.locals.has(name)) call(scope, name);
        return;
      }
      case "identifier":
        // A bare name that is not a variable is a call without arguments (`cfg = defaults;`).
        if (!scope.locals.has(node.text)) call(scope, node.text);
        return;
    }
    for (const c of node.namedChildren) visit(c, scope);
  };

  /** A function's header: `function [a, b] = name(x, y)` (not the help comment after it). */
  const fnHeader = (node: Parser.SyntaxNode): string | null => {
    let end = node.startIndex;
    for (const c of node.namedChildren) {
      if (c.type === "function_output" || c.type === "function_arguments" || c === node.childForFieldName("name")) {
        end = Math.max(end, c.endIndex);
      }
    }
    return clean(source.slice(node.startIndex, end));
  };

  type FnOpts = {
    kind: Kind;
    idPrefix: string | null;
    owner?: string;
    parentId: string;
    exported: boolean;
    outer: Scope | null;
    /** The class whose instance the object argument (or a constructor's output) holds. */
    className?: string;
    typedFirstArg?: boolean;
  };

  const defineFunction = (node: Parser.SyntaxNode, o: FnOpts): void => {
    // `function v = get.Prop(obj)`: a property accessor. The grammar's name field holds
    // only `Prop`; keep the `get.`/`set.` prefix so it neither collides with the property
    // node nor resolves a call to `Prop(â€¦)`.
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const accessor = /\b(get|set)\s*\.\s*$/.exec(source.slice(node.startIndex, nameNode.startIndex));
    const name = accessor ? `${accessor[1]}.${nameNode.text}` : nameNode.text.replace(/\s+/g, "");
    if (!name) return;
    const idName = o.idPrefix ? `${o.idPrefix}.${name}` : name;
    const id = mint(idName, name, o.kind, node, fnHeader(node), o.exported, o.parentId, o.owner);
    // Nested functions share their parent's workspace, so its variables stay variables.
    const locals = new Set(o.outer?.locals ?? []);
    const typed = new Map(o.outer?.typed ?? []);
    const params = (node.namedChildren.find((c) => c.type === "function_arguments")?.namedChildren ?? [])
      .filter((c) => c.type === "identifier")
      .map((c) => c.text);
    const outputs = new Set<string>();
    for (const c of node.namedChildren.find((c) => c.type === "function_output")?.namedChildren ?? []) addTarget(c, outputs);
    for (const p of params) locals.add(p);
    for (const out of outputs) locals.add(out);
    if (o.className) {
      if (o.typedFirstArg && params[0]) typed.set(params[0], o.className);
      if (name === o.className) for (const out of outputs) typed.set(out, o.className);
    }
    const block = node.namedChildren.find((c) => c.type === "block");
    if (block) collectLocals(block, locals);
    for (const t of typed.keys()) locals.add(t);
    const scope: Scope = { from: id, idName, locals, typed };
    for (const c of block?.namedChildren ?? []) {
      if (c.type === "function_definition") {
        defineFunction(c, { kind: "function", idPrefix: idName, parentId: id, exported: false, outer: scope });
      } else {
        visit(c, scope);
      }
    }
  };

  const defineClass = (node: Parser.SyntaxNode): void => {
    const nameNode = node.childForFieldName("name");
    const name = nameNode?.text;
    if (!nameNode || !name) return;
    const supers = node.namedChildren.find((c) => c.type === "superclasses");
    const headerEnd = Math.max(nameNode.endIndex, supers?.endIndex ?? 0);
    const kind: Kind = node.namedChildren.some((c) => c.type === "enumeration") ? "enum" : "class";
    const id = mint(name, name, kind, node, clean(source.slice(node.startIndex, headerEnd)), true, rel);
    for (const base of supers?.namedChildren ?? []) {
      const parts = base.namedChildren.filter((c) => c.type === "identifier");
      const baseName = parts[parts.length - 1]?.text;
      if (baseName) rawEdges.push({ source: id, relation: "extends", name: baseName, file: rel });
    }
    const classScope: Scope = { from: id, idName: name, locals: new Set(), typed: new Map() };
    const attrs = (block: Parser.SyntaxNode): string => block.namedChildren.find((c) => c.type === "attributes")?.text ?? "";
    for (const block of node.namedChildren) {
      if (block.type === "properties") {
        const a = attrs(block);
        const kindOf: Kind = MATLAB_CONSTANT.test(a) ? "constant" : "variable";
        for (const prop of block.namedChildren) {
          if (prop.type !== "property") continue;
          const pn = prop.childForFieldName("name");
          if (pn?.type !== "identifier") continue;
          mint(`${name}.${pn.text}`, pn.text, kindOf, prop, clean(prop.text.split("\n")[0]!), !MATLAB_PRIVATE_ACCESS.test(a), id);
          // A default value can call a function: `Tol = defaultTol()`.
          for (const c of prop.namedChildren) if (c.type === "default_value") visit(c, classScope);
        }
      } else if (block.type === "methods") {
        const a = attrs(block);
        for (const fn of block.namedChildren) {
          if (fn.type !== "function_definition") continue; // a bare signature is defined in its own file
          // A constructor's arguments are not yet an instance; its output is (see defineFunction).
          const isCtor = fn.childForFieldName("name")?.text === name;
          defineFunction(fn, {
            kind: "method",
            idPrefix: name,
            owner: name,
            parentId: id,
            exported: !MATLAB_PRIVATE_ACCESS.test(a),
            outer: null,
            className: name,
            typedFirstArg: !MATLAB_STATIC.test(a) && !isCtor,
          });
        }
      } else if (block.type === "enumeration") {
        for (const member of block.namedChildren) {
          const mn = member.type === "enum" ? member.namedChildren.find((c) => c.type === "identifier") : null;
          if (mn) mint(`${name}.${mn.text}`, mn.text, "constant", member, clean(member.text), true, id);
        }
      }
    }
  };

  // A script runs top to bottom; its local functions (if any) come last. A function or
  // classdef file starts with its definition, and what follows is local to the file.
  const top = root.namedChildren.filter((c) => c.type !== "comment");
  const isScript = top.length > 0 && top[0]!.type !== "function_definition" && top[0]!.type !== "class_definition";
  const fileScope: Scope = { from: rel, idName: null, locals: new Set(), typed: new Map() };
  for (const c of top) collectLocals(c, fileScope.locals);
  let primarySeen = false;
  for (const c of top) {
    if (c.type === "class_definition") {
      defineClass(c);
      primarySeen = true;
    } else if (c.type === "function_definition") {
      const primary = !isScript && !primarySeen;
      primarySeen = true;
      const fname = c.childForFieldName("name")?.text;
      if (primary && classFolder) {
        // `@Cls/area.m`: a method of Cls defined in its own file (`@Cls/Cls.m` is the
        // old-style constructor, whose first argument is not yet an instance).
        defineFunction(c, {
          kind: "method",
          idPrefix: classFolder,
          owner: classFolder,
          parentId: rel,
          exported: true,
          outer: null,
          className: classFolder,
          typedFirstArg: fname !== classFolder,
        });
      } else {
        defineFunction(c, { kind: "function", idPrefix: null, parentId: rel, exported: primary, outer: null });
      }
    } else {
      visit(c, fileScope);
    }
  }
  nodes[0].body_text = fileResidual(source, nodes.slice(1));
  return { nodes, rawEdges };
}

/** CSV: the header row's columns become one node each (`data.csv#id`), so a
 * dataset's schema is queryable. Only the first row is treated as the header. */
function extractCsv(rel: string, source: string, root: Parser.SyntaxNode): ExtractResult {
  const nodes: NodeV1[] = [fileNodeOf(rel, source)];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  const header = root.namedChildren.find((c) => c.type === "row");
  for (const field of header?.namedChildren ?? []) {
    if (field.type !== "field") continue;
    const name = field.text.replace(/^["']|["']$/g, "").trim();
    if (!name) continue;
    const id = mintId(`${rel}#${name}`, minted);
    nodes.push(markupNode(id, name, "variable", rel, field));
    rawEdges.push({ source: rel, relation: "contains", targetId: id, file: rel });
  }
  return { nodes, rawEdges };
}
