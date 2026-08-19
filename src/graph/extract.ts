/**
 * Tier-1 extraction: source file → {@link NodeV1}[] + raw edges, via tree-sitter.
 *
 * Deterministic and dependency-only (no LLM, no network). Emits one node per
 * definition (file, class, function, method, interface, type, enum, and TS
 * arrow-function consts) plus unresolved edge intents. Edge *targets* are
 * resolved against the whole-repo node index later, in build.ts.
 */
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import Python from "tree-sitter-python";
import Go from "tree-sitter-go";
import Java from "tree-sitter-java";
import PHP from "tree-sitter-php";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { contentHash } from "../util/id.js";
import { collectBindings, goReceiverVarOf, resolveRecvType, type FileBindings } from "./bindings.js";
import type { Kind, NodeV1, Relation } from "./types.js";

/** Depth-tier languages with a hand-written extractor. The first six ship as
 * core dependencies; the rest (`c_sharp`…`razor`) are OPTIONAL, locally-built
 * native grammars — claimed only when their binding loads (see {@link grammarAvailable}). */
export type Language =
  | "typescript"
  | "tsx"
  | "python"
  | "go"
  | "java"
  | "php"
  | "c_sharp"
  | "groovy"
  | "plsql"
  | "css"
  | "html"
  | "razor"
  | "xml";

/** Optional grammar key → the package that ships its native binding (and, when the
 * package exports several grammars, the property to pick). Loaded best-effort and
 * cached: a missing/unbuildable binding leaves the language unclaimed, so its files
 * fall through to the breadth tier (or file-only) instead of crashing the build. */
const OPTIONAL_GRAMMAR_PKG: Record<string, { pkg: string; prop?: string }> = {
  c_sharp: { pkg: "tree-sitter-c-sharp" },
  groovy: { pkg: "tree-sitter-groovy" },
  plsql: { pkg: "tree-sitter-plsql" },
  css: { pkg: "tree-sitter-css-in-js" },
  html: { pkg: "tree-sitter-html" },
  razor: { pkg: "tree-sitter-razor" },
  // Monorepo grammar: its node binding exports { xml, dtd } — pick the XML one.
  xml: { pkg: "@tree-sitter-grammars/tree-sitter-xml", prop: "xml" },
};

const require = createRequire(import.meta.url);
const optionalGrammarCache = new Map<string, unknown | null>();

/** Load an optional native grammar synchronously, bypassing any ESM/top-level-await
 * index wrapper (C#'s binding uses one) by loading the built `.node` directly via
 * node-gyp-build, then falling back to scanning build/Release and prebuilds. Cached,
 * including the null (unavailable) result, so it probes the filesystem once. */
function loadOptionalGrammar(key: string): unknown | null {
  if (optionalGrammarCache.has(key)) return optionalGrammarCache.get(key) ?? null;
  const spec = OPTIONAL_GRAMMAR_PKG[key];
  let grammar: unknown | null = null;
  if (spec) {
    let root: string | null = null;
    try {
      root = dirname(require.resolve(`${spec.pkg}/package.json`));
    } catch {
      root = null;
    }
    if (root) {
      try {
        const ngb = createRequire(join(root, "package.json"))("node-gyp-build") as (r: string) => unknown;
        grammar = pickGrammar(ngb(root), spec.prop);
      } catch {
        grammar = null;
      }
      if (!grammar) {
        for (const dir of [join(root, "build", "Release"), join(root, "prebuilds", `${process.platform}-${process.arch}`)]) {
          try {
            const file = readdirSync(dir).find((f) => f.endsWith(".node"));
            if (file) {
              grammar = pickGrammar(require(join(dir, file)), spec.prop);
              if (grammar) break;
            }
          } catch {
            /* try next candidate */
          }
        }
      }
    }
  }
  optionalGrammarCache.set(key, grammar);
  return grammar;
}

function pickGrammar(mod: unknown, prop?: string): unknown | null {
  if (!mod) return null;
  const m = mod as Record<string, unknown> & { default?: unknown };
  if (prop) return m[prop] ?? null;
  return m.default ?? mod;
}

/** Whether an optional depth-tier grammar (`c_sharp`, `groovy`, `plsql`, `css`,
 * `html`, `razor`) is installed and loads. Synchronous; drives the per-language
 * test skips and the extension-claiming below. */
export function grammarAvailable(key: string): boolean {
  return loadOptionalGrammar(key) !== null;
}

/** The active SQL dialect, or null when no SQL grammar is built. Only Oracle
 * PL/SQL is wired today, so this is "plsql" exactly when that grammar loads. */
export function sqlDialect(): "plsql" | null {
  return grammarAvailable("plsql") ? "plsql" : null;
}

/** Whether a SQL grammar (Oracle PL/SQL today) is built — the `.sql`/DDL tests
 * skip when it isn't. Alias of {@link sqlDialect} as a boolean. */
export function sqlGrammarAvailable(): boolean {
  return sqlDialect() !== null;
}

/**
 * Extension → the tree-sitter grammar that parses it, and the label a human expects
 * to see for it.
 *
 * The two are not the same, and conflating them under-reported coverage: `.mjs` is
 * parsed by the typescript grammar, so a JS repo's build banner read `[typescript]`
 * and a `.jsx` one read `[tsx]`. Both are true about the *parser* and misleading
 * about the repo — people went looking for why their JavaScript hadn't been indexed
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
  { ext: ".php", grammar: "php", label: "php" },
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
];

function entryFor(path: string): { ext: string; grammar: Language; label: string } | undefined {
  const p = path.toLowerCase();
  const core = EXTENSIONS.find((e) => p.endsWith(e.ext));
  if (core) return core;
  const opt = OPTIONAL_EXTENSIONS.find((e) => p.endsWith(e.ext));
  return opt && grammarAvailable(opt.grammar) ? opt : undefined;
}

/** Every file extension a depth-tier (hand-written) extractor claims — the core
 * grammars always, plus any optional grammar whose binding is currently built. */
export function depthExtensions(): string[] {
  return [...EXTENSIONS.map((e) => e.ext), ...OPTIONAL_EXTENSIONS.filter((e) => grammarAvailable(e.grammar)).map((e) => e.ext)];
}

/** Map a file path to a supported language, or null if unsupported. */
export function languageOf(path: string): Language | null {
  return entryFor(path)?.grammar ?? null;
}

/**
 * What to *call* the language of this file, for a banner or a repo map — or null when
 * the file isn't indexed at all, which is the distinction {@link languageOf} shares
 * and the one that matters to a reader checking coverage.
 */
export function languageLabelOf(path: string): string | null {
  return entryFor(path)?.label ?? null;
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
  specifier?: string; // module path to resolve (imports / imported-symbol references)
  name?: string; // symbol name to resolve (extends/implements/calls)
  viaMember?: boolean; // calls: was it `obj.foo()` (→ prefer method targets)?
  /** calls with viaMember: the receiver's resolved type name (from bindings /
   * self / this / Go receiver), when a confident local clue exists. */
  recvType?: string;
  /** calls: the number of arguments at the CALL SITE. Only emitted for languages
   * with overloading (Java), where a same-named sibling on the same class is
   * otherwise indistinguishable — and picking wrong turns a delegating overload
   * into a self-loop. */
  argCount?: number;
}

export interface ExtractResult {
  nodes: NodeV1[];
  rawEdges: RawEdge[];
}

/** Max chars of normalized body stored per symbol for search. Large enough that
 * essentially every real definition is stored whole — only a rare giant function
 * is clipped — while bounding how much the committed graph can grow. */
const MAX_BODY_CHARS = 5000;

/** Cap for a file node's module-level residual (imports, constants, module
 * docstring — everything not inside a symbol). Higher than the per-symbol cap
 * because a data-heavy module (constant tables, big config dicts) is legitimate
 * residual, and it's the recall play — but still bounded. */
const MAX_FILE_BODY_CHARS = 16000;

/** The searchable body of a definition: its source text, whitespace-collapsed
 * so every identifier becomes a token, capped at `max`. Search-only — the agent
 * still reads verbatim source via `ask --source`, which slices the file from
 * disk, so nothing here reaches the agent's context. */
function searchBody(text: string, max = MAX_BODY_CHARS): string {
  const norm = text.replace(/\s+/g, " ").trim();
  return norm.length > max ? norm.slice(0, max) : norm;
}

/** A file's module-level residual: the lines NOT covered by any symbol span.
 * Symbol bodies are already indexed on their own nodes, so this captures only
 * what they miss — top-of-file imports, module constants, module docstrings —
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
  function_definition: "function", // → "method" inside a class (resolved in the walk)
};

// Go: `type_spec` is intentionally absent — its kind (struct/interface/type) depends on
// the named type's shape, so it's resolved dynamically in describe().
const GO_KINDS: Record<string, Kind> = {
  function_declaration: "function",
  method_declaration: "method",
};

// Java: a record is a nominal data carrier, so it takes "struct" — the same role
// Go's struct plays — rather than "class", which would make a service and a DTO
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

// PHP: definition node types are all distinct (no py-style function→method
// promotion needed — a class body uses `method_declaration`, not
// `function_definition`). `trait_declaration` maps to the PHP-only `trait` kind.
const PHP_KINDS: Record<string, Kind> = {
  function_definition: "function",
  method_declaration: "method",
  class_declaration: "class",
  interface_declaration: "interface",
  trait_declaration: "trait",
  enum_declaration: "enum",
};

// C#: namespace declarations are intentionally absent — they're not scope
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

// Groovy: the grammar is loose — a class body is a `closure`, a method is a
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
// custom — this map only drives the kind and CALL lookups.
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


const KINDS_BY_LANG: Record<Language, Record<string, Kind>> = {
  typescript: TS_KINDS,
  tsx: TS_KINDS,
  python: PY_KINDS,
  go: GO_KINDS,
  java: JAVA_KINDS,
  php: PHP_KINDS,
  c_sharp: CSHARP_KINDS,
  groovy: GROOVY_KINDS,
  plsql: PLSQL_KINDS,
  css: {},
  html: {},
  razor: {},
  xml: {},
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
  php: new Set([
    "function_call_expression",
    "member_call_expression",
    "nullsafe_member_call_expression",
    "scoped_call_expression",
  ]),
  // C#: `f()` (invocation) and `new T()` (object creation), mirroring Java.
  c_sharp: new Set(["invocation_expression", "object_creation_expression"]),
  // Groovy: `foo(...)` / `obj.foo(...)` are both `function_call`.
  groovy: new Set(["function_call"]),
  // PL/SQL: a sub-program call is a `ref_call` (a referenced_element with args).
  plsql: new Set(["ref_call"]),
  // Markup/style languages have no call graph — extracted by custom walkers.
  css: new Set<string>(),
  html: new Set<string>(),
  razor: new Set<string>(),
  xml: new Set<string>(),
};

const FUNCTION_VALUE_TYPES = new Set([
  "arrow_function",
  "function",
  "function_expression",
  "generator_function",
]);

const parser = new Parser();
const CORE_GRAMMARS: Partial<Record<Language, unknown>> = {
  typescript: TypeScript.typescript,
  tsx: TypeScript.tsx,
  python: Python,
  go: Go,
  java: Java,
  php: PHP.php,
};

/** The tree-sitter grammar for a language: a statically-imported core grammar,
 * or an optional native grammar loaded on demand. Null when an optional
 * grammar's binding isn't built — the caller then degrades to a file-only node. */
function grammarFor(lang: Language): unknown | null {
  return CORE_GRAMMARS[lang] ?? loadOptionalGrammar(lang);
}

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
}

/** A definition we're about to emit, normalized across the shapes we handle. */
interface DefDescriptor {
  name: string; // the bare symbol name (used for the node's `name` and call resolution)
  idName?: string; // id-scope segment when it differs from `name` (Go: `Receiver.method`)
  kind: Kind;
  headerEnd: number; // char index where the signature ends (body starts)
  hashNode: Parser.SyntaxNode; // node whose text forms body_hash / span
  arity?: number; // declared parameter count — overload disambiguation (Java)
  variadic?: boolean; // last parameter is a vararg, so `arity` is a minimum
}

/** tree-sitter's string `parse()` fails with "Invalid argument" on any input
 * ≥ 32 KB, which silently drops large files — often the most important ones (a
 * 2000-line command module, a core tab implementation). The callback form has
 * no such limit as long as each returned chunk is under 32 KB, so we always feed
 * the source in <32 KB slices. Code-unit indexing matches `String.slice`. */
const PARSE_CHUNK = 16384;
function parseSource(source: string): Parser.SyntaxNode {
  return parser.parse((index: number) => source.slice(index, index + PARSE_CHUNK)).rootNode;
}

export function extractFile(rel: string, source: string, lang: Language): ExtractResult {
  const grammar = grammarFor(lang);
  // An optional grammar that isn't built leaves the file indexed but symbol-less,
  // rather than throwing and marking it a parse error.
  if (!grammar) return { nodes: [fileNodeOf(rel, source)], rawEdges: [] };
  parser.setLanguage(grammar as never);
  const root = parseSource(source);
  // Markup/style languages carry no call graph, so they bypass the
  // definition/among-calls walk for a dedicated shape (rules, id'd elements) or,
  // for Razor (embedded C# is opaque here), a file node only.
  if (lang === "css") return extractCss(rel, source, root);
  if (lang === "html") return extractHtml(rel, source, root);
  if (lang === "xml") return extractXml(rel, source, root);
  if (lang === "razor") return { nodes: [fileNodeOf(rel, source)], rawEdges: [] };
  const bindings = collectBindings(root, lang);
  const importedSymbols = collectImportedSymbols(root, lang);

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
  };
  // Every id minted this file, seeded with the file node's own id (`rel`) so a
  // top-level definition can never collide with it. Threaded as its own
  // parameter rather than living on WalkCtx — WalkCtx is spread into every
  // childCtx, so a by-ref Set there would read as ordinary inherited context
  // when it's actually accidental shared mutable state across the whole walk.
  const minted = new Set<string>([rel]);
  for (const child of root.namedChildren) walk(child, ctx, nodes, rawEdges, minted);
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

function walk(node: Parser.SyntaxNode, ctx: WalkCtx, out: NodeV1[], edges: RawEdge[], minted: Set<string>): void {
  const desc = describe(node, ctx);
  if (desc) {
    // `idName` scopes the id (e.g. a Go method under its receiver: `#DB.Count`) while
    // `name` stays the bare symbol name so member-call resolution matches it.
    const idPart = desc.idName ?? desc.name;
    const base = `${ctx.rel}#${[...ctx.scope, idPart].join(".")}`;
    const id = mintId(base, minted);
    const isGoMethod = ctx.lang === "go" && node.type === "method_declaration";
    // The bare name of this node's OWN immediate enclosing class/receiver — for a
    // Go method that's its receiver type (methods aren't nested, so ctx.enclosingClass
    // wouldn't see it); for every other method it's simply what the nearest ancestor
    // class already set as ctx.enclosingClass. Only method nodes carry it — resolve.ts's
    // ownerMethod index is the sole consumer (see NodeV1.owner's doc comment).
    const owner: string | undefined =
      desc.kind === "method" ? (isGoMethod ? (goReceiverType(node) ?? undefined) : (ctx.enclosingClass ?? undefined)) : undefined;
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
            : ctx.lang === "java"
              ? javaExported(node)
              : ctx.lang === "php"
                ? phpExported(node)
                : ctx.lang === "c_sharp"
                  ? csharpExported(node)
                  : ctx.lang === "groovy"
                    ? groovyExported(node)
                    : ctx.lang === "plsql"
                      ? true
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
    // class heritage — in Java an interface may also `extends`, and a record/enum
    // may `implements`, so every type declaration is a heritage site, not just a class.
    const javaTypeDecl = ctx.lang === "java" && JAVA_TYPE_KINDS.has(desc.kind);
    // C#: `class C : Base, IFace` — a base_list hangs off every type declaration
    // (class/struct/interface), so all of them are heritage sites, not just classes.
    const csharpTypeDecl =
      ctx.lang === "c_sharp" && (desc.kind === "class" || desc.kind === "interface" || desc.kind === "struct");
    if (desc.kind === "class" || javaTypeDecl || csharpTypeDecl) edges.push(...heritageEdges(node, id, ctx));

    const enclosingClass =
      desc.kind === "class" || javaTypeDecl || csharpTypeDecl
        ? desc.name
        : isGoMethod
          ? goReceiverType(node)
          : ctx.enclosingClass;
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
    };
    for (const child of node.namedChildren) walk(child, childCtx, out, edges, minted);
    return;
  }

  // not a definition — capture calls/imports/references, then descend with the same context
  const callTypes = CALL_TYPES[ctx.lang];
  if (callTypes.has(node.type)) {
    const callee = calleeName(node, ctx.lang);
    if (callee) {
      const callEdge: RawEdge = {
        source: ctx.parentId,
        relation: "calls",
        name: callee.name,
        viaMember: callee.viaMember,
        file: ctx.rel,
      };
      // Java only: the call site's argument count, to pick the right overload.
      const argCount = ctx.lang === "java" ? javaArgCount(node) : undefined;
      if (argCount !== undefined) callEdge.argCount = argCount;
      const recvType = resolveRecvType(callee.receiver, ctx);
      edges.push(recvType ? { ...callEdge, recvType } : callEdge);
    }
  } else if (isImport(node, ctx.lang)) {
    const spec = importSpecifier(node, ctx.lang);
    if (spec) edges.push({ source: ctx.rel, relation: "imports", specifier: spec, file: ctx.rel });
    // Imported identifiers are declarations, not uses. The import-binding pass
    // above already recorded them, so do not descend and emit false references.
    return;
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

  for (const child of node.namedChildren) walk(child, ctx, out, edges, minted);
}

/**
 * Named imports whose local binding can be recognized later as a symbol use.
 * Namespace/default imports are intentionally excluded: they do not tell us
 * the exported symbol name, so wiring them would require guessing.
 */
function collectImportedSymbols(
  root: Parser.SyntaxNode,
  lang: Language,
): Map<string, { name: string; specifier: string }> {
  const out = new Map<string, { name: string; specifier: string }>();
  if (lang !== "typescript" && lang !== "tsx") return out;

  const visit = (node: Parser.SyntaxNode): void => {
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

function collectTsImportBindings(
  node: Parser.SyntaxNode,
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
 * wrappers makes a purely syntactic question depend on collector timing — two cold
 * builds of unchanged source then disagree on `references` edges (#116).
 *
 * `id` is the stable identity, unique within one tree, so the tree is compared too.
 * A `Tree` is one object per parse (unlike its nodes), so `===` is right for it.
 */
function sameSyntaxNode(
  a: Parser.SyntaxNode | null | undefined,
  b: Parser.SyntaxNode | null | undefined,
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
  definition: Parser.SyntaxNode,
): ReadonlyMap<string, { name: string; specifier: string }> {
  if (imports.size === 0) return imports;
  const shadowed = new Set<string>();
  const definitionValue = definition.childForFieldName("value");
  const visit = (node: Parser.SyntaxNode): void => {
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

function isFunctionBoundary(node: Parser.SyntaxNode): boolean {
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
function isDirectCallee(node: Parser.SyntaxNode, callTypes: ReadonlySet<string>): boolean {
  const parent = node.parent;
  if (!parent || !callTypes.has(parent.type)) return false;
  return (
    sameSyntaxNode(parent.childForFieldName("function"), node) ||
    sameSyntaxNode(parent.childForFieldName("name"), node)
  );
}

/** Definition/declaration identifiers name a new binding; they do not use one. */
function isDeclarationName(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  return sameSyntaxNode(parent?.childForFieldName("name"), node);
}

/** Recognize the definition shapes: mapped node types, Go's type/method forms, and
 * TS arrow-consts. */
function describe(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  if (ctx.lang === "go") return describeGo(node, ctx);
  if (ctx.lang === "java") return describeJava(node, ctx);
  if (ctx.lang === "groovy") return describeGroovy(node, ctx);
  if (ctx.lang === "plsql") return describePlSql(node, ctx);

  // PHP closures: `$h = function () {…}` / `fn() => …`, and bare callbacks
  // (`$routes->get('/x', function () {…})`). Captured as function nodes so a
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

  const mapped = ctx.kinds[node.type];
  if (mapped) {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    let kind = mapped;
    if (ctx.lang === "python" && mapped === "function" && ctx.enclosingKind === "class") {
      kind = "method";
    }
    const body = node.childForFieldName("body");
    return { name, kind, headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
  }

  // TS: `const foo = (…) => …` / `const foo = function () {}`
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
 * (struct / interface / type alias). Methods carry no nesting — they're qualified
 * by their receiver type (`User.Save`) so calls can resolve and cards read clearly. */
function describeGo(node: Parser.SyntaxNode, _ctx: WalkCtx): DefDescriptor | null {
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

  // `type Name <shape>` — one type_spec per name (grouped `type ( … )` yields several).
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

/** Java definition shapes. Uniform in a way Go's are not: every declaration carries
 * a `name` field and (for types and most members) a `body`, so one mapped lookup
 * covers classes, interfaces, enums, records, methods, and constructors. Methods are
 * lexically nested in their type, so — unlike Go — they need no receiver qualification. */
function describeJava(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
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
 * double-quoted — the quotes are part of the token, not the identifier. */
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
    // `CREATE TABLE [schema.]name (…)` — the object name is the last identifier
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

/** Java visibility: `public` (or `protected`) on the declaration's own modifier list.
 * A package-private or private member is not part of the API surface. Read off the
 * `modifiers` child's tokens, ignoring annotations, which live in the same node. */
function javaExported(node: Parser.SyntaxNode): boolean {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return false;
  return mods.children.some((c) => c.type === "public" || c.type === "protected");
}

/** The receiver's base type name for a Go method, unwrapping a pointer receiver
 * (`func (u *User) …` → `User`). Null if it can't be read. */
function goReceiverType(node: Parser.SyntaxNode): string | null {
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
function phpExported(node: Parser.SyntaxNode): boolean {
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
 * even when they are the same node — producing a stray `{closure}` name that
 * makes `graft check` report the graph STALE against its own stored output. */
function phpClosureName(node: Parser.SyntaxNode): string {
  const parent = node.parent;
  if (parent?.type === "assignment_expression" && parent.childForFieldName("right")?.id === node.id) {
    const left = parent.childForFieldName("left");
    if (left?.type === "variable_name") return left.text.replace(/^\$/, "");
  }
  return "{closure}";
}

function heritageEdges(node: Parser.SyntaxNode, classId: string, ctx: WalkCtx): RawEdge[] {
  const edges: RawEdge[] = [];
  if (ctx.lang === "java") {
    // `superclass` holds `extends X`; `super_interfaces` holds `implements A, B`
    // (and, on an interface declaration, `extends A, B` — which tree-sitter-java
    // still spells `extends_interfaces`).
    for (const child of node.namedChildren) {
      const relation: Relation | null =
        child.type === "superclass"
          ? "extends"
          : child.type === "super_interfaces" || child.type === "extends_interfaces"
            ? "implements"
            : null;
      if (!relation) continue;
      for (const t of typeIdentifiersIn(child)) {
        edges.push({ source: classId, relation, name: t, file: ctx.rel });
      }
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
  if (ctx.lang === "php") {
    // `class C extends B implements I, J` → base_clause (extends) +
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
        // convention — the same heuristic the graph-csharp spec expects.
        const relation: Relation = /^I[A-Z]/.test(name) ? "implements" : "extends";
        edges.push({ source: classId, relation, name, file: ctx.rel });
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

/** Every `type_identifier` under a heritage clause, so `implements A, B<C>` yields
 * each named type rather than the clause's raw text. */
function typeIdentifiersIn(node: Parser.SyntaxNode): string[] {
  const out: string[] = [];
  const visit = (n: Parser.SyntaxNode): void => {
    if (n.type === "type_identifier") out.push(n.text);
    for (const c of n.namedChildren) visit(c);
  };
  visit(node);
  return out;
}

function calleeName(
  node: Parser.SyntaxNode,
  lang: Language,
): { name: string; viaMember: boolean; receiver?: string } | null {
  // Java first: `method_invocation` has NO `function` field (it splits the callee
  // into `object` + `name`), so the shared lookup below would return null for every
  // Java call site and the language would extract nodes with no call edges at all.
  if (lang === "java") {
    if (node.type === "object_creation_expression") {
      // `new Foo()` — the constructed type is the call target, named as the graph
      // names it.
      const name = javaConstructedTypeName(node.childForFieldName("type"));
      return name ? { name, viaMember: false } : null;
    }
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    const obj = node.childForFieldName("object");
    // No `object` means an implicit-`this` call (`decorate(name)`), which in Java is a
    // method call, not a free function — Java has none. Reporting it as a plain call
    // would send it to the function-only resolver and drop it, losing the most common
    // intra-class edge there is. Spelling it as a `this` member call routes it through
    // owner-qualified resolution, which also walks the superclass chain and stays
    // conservative: an unmatched name (e.g. a static import) resolves to nothing.
    if (!obj) return { name: nameNode.text, viaMember: true, receiver: "this" };
    return { name: nameNode.text, viaMember: true, receiver: javaReceiver(obj) };
  }

  if (lang === "php") return phpCallee(node);
  if (lang === "c_sharp") return csharpCallee(node);
  if (lang === "groovy") return groovyCallee(node);
  if (lang === "plsql") return plsqlCallee(node);

  const fn = node.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier") return { name: fn.text, viaMember: false };
  if (lang === "python" && fn.type === "attribute") {
    const a = fn.childForFieldName("attribute") ?? fn.namedChildren.at(-1);
    return a ? { name: a.text, viaMember: true, receiver: pyReceiver(fn) } : null;
  }
  if (lang === "go" && fn.type === "selector_expression") {
    // `pkg.Fn()` / `recv.Method()` — the called name is the trailing field.
    const p = fn.childForFieldName("field") ?? fn.namedChildren.at(-1);
    const operand = fn.childForFieldName("operand");
    const receiver = operand?.type === "identifier" ? operand.text : undefined;
    return p ? { name: p.text, viaMember: true, receiver } : null;
  }
  if ((lang === "typescript" || lang === "tsx") && fn.type === "member_expression") {
    const p = fn.childForFieldName("property") ?? fn.namedChildren.at(-1);
    return p ? { name: p.text, viaMember: true, receiver: tsReceiver(fn) } : null;
  }
  return null;
}

/** The number of arguments at a Java call site (`method_invocation` or
 * `object_creation_expression`), read off the `arguments` list. Undefined when the
 * list is absent, which keeps resolution at its previous name-only behavior rather
 * than filtering on a count we never established. */
function javaArgCount(node: Parser.SyntaxNode): number | undefined {
  const args = node.childForFieldName("arguments");
  return args ? args.namedChildren.length : undefined;
}

/**
 * The name a `new` CONSTRUCTS, as the graph names it — or null when this pass cannot
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
 * WRONG ones — `new java.io.File(…)` resolved to an unrelated in-repo `File`, and a
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
function javaConstructedTypeName(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "generic_type") return javaConstructedTypeName(node.namedChildren[0]);
  return node.type === "type_identifier" ? node.text : null;
}

/** A Java call's receiver text: a bare identifier (`repo.save()`), `this`, or
 * `this.x` for a field access (`this.repo.save()`). A chained call or a qualified
 * static reference yields none — there is no confident local clue to bind. */
function javaReceiver(obj: Parser.SyntaxNode | null | undefined): string | undefined {
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
 * chained `self.x.y()`. Anything else (e.g. a chained call `f().g()`) → none. */
function pyReceiver(fn: Parser.SyntaxNode): string | undefined {
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
function phpCallee(node: Parser.SyntaxNode): { name: string; viaMember: boolean; receiver?: string } | null {
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
 * `qualified_name` (`\App\helpers\slug` → `slug`). Dynamic calls (`$fn()`) → null. */
function phpName(node: Parser.SyntaxNode): string | null {
  if (node.type === "name") return node.text;
  if (node.type === "qualified_name") return node.text.replace(/^.*\\/, "") || null;
  return null;
}

/** `$obj->m()` receiver: `$this` normalizes to `this` (→ enclosing class); any
 * other variable is returned verbatim for a bindings lookup. */
function phpObjReceiver(obj: Parser.SyntaxNode | null): string | undefined {
  if (obj?.type !== "variable_name") return undefined;
  return obj.text === "$this" ? "this" : obj.text;
}

/** `Cls::m()` receiver: `self`/`static`/`parent` normalize to `self` (→ enclosing
 * class); an explicit class name is the trailing segment of its qualified path. */
function phpScopeReceiver(scope: Parser.SyntaxNode | null): string | undefined {
  if (!scope) return undefined;
  const text = scope.text;
  if (scope.type === "relative_scope" || text === "self" || text === "static" || text === "parent") return "self";
  if (scope.type === "name") return text;
  if (scope.type === "qualified_name") return text.replace(/^.*\\/, "");
  return undefined;
}

/** ts `member_expression` node's receiver text: `this`, `this.x`, or a bare identifier. */
function tsReceiver(fn: Parser.SyntaxNode): string | undefined {
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

function isImport(node: Parser.SyntaxNode, lang: Language): boolean {
  // Go: match the per-import leaf, so single (`import "fmt"`) and grouped
  // (`import ( … )`) forms each yield one edge as the walk recurses into the list.
  if (lang === "go") return node.type === "import_spec";
  if (lang === "java") return node.type === "import_declaration";
  // PHP: one edge per imported symbol — the clause leaf inside a (possibly
  // grouped) `use A\B, C\D;` / `use A\{B, C};` declaration.
  if (lang === "php") return node.type === "namespace_use_clause";
  if (lang === "c_sharp") return node.type === "using_directive";
  if (lang === "groovy") return node.type === "groovy_import";
  return node.type === "import_statement" || node.type === "import_from_statement";
}

function importSpecifier(node: Parser.SyntaxNode, lang: Language): string | null {
  if (lang === "php") {
    // namespace_use_clause → its `qualified_name`/`name`, e.g. `App\Models\Animal`.
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
  if (lang === "java") {
    // `import a.b.C;` / `import static a.b.C.d;` / `import a.b.*;` — the fully
    // qualified name is the scoped_identifier; a wildcard `*` is a separate token
    // and is dropped, leaving the package as the import target.
    const id = node.namedChildren.find(
      (c) => c.type === "scoped_identifier" || c.type === "identifier",
    );
    return id?.text ?? null;
  }
  if (lang === "c_sharp") {
    // `using System;` / `using Foo.Bar;` — the imported namespace is the clause's
    // qualified name (an alias `using A = B;` picks up `A`, close enough here).
    const n = node.namedChildren.find((c) => c.type === "qualified_name" || c.type === "identifier");
    return n?.text ?? null;
  }
  if (lang === "groovy") {
    const n = node.childForFieldName("import") ?? node.namedChildren.find((c) => c.type === "qualified_name" || c.type === "identifier");
    return n?.text ?? null;
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
function tsExported(node: Parser.SyntaxNode): boolean {
  let p = node.parent;
  while (p) {
    if (p.type === "export_statement") return true;
    p = p.parent;
  }
  return false;
}

/** C# call shapes. A bare `Foo()` invocation is an implicit-`this` method call
 * (C# has no free functions), routed — like Java's — through owner-qualified
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
 * (`new Box<int>()` → `Box`). Null when the node isn't a plain named type. */
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
  // scope `this` types to nothing, so it degrades to a name-only (free) match —
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

/** PL/SQL call: a `ref_call` wraps a `referenced_element` whose `ref_name` is the
 * sub-program called and whose optional `ref_name_parent` is the owning package
 * (`pkg.proc()`), passed as the receiver so resolution can qualify the target. */
function plsqlCallee(node: Parser.SyntaxNode): { name: string; viaMember: boolean; receiver?: string } | null {
  const ref = node.childForFieldName("referenced_element") ?? node.namedChildren.find((c) => c.type === "referenced_element");
  if (!ref) return null;
  const nameNode = ref.childForFieldName("ref_name");
  if (!nameNode) return null;
  const parent = ref.childForFieldName("ref_name_parent");
  return { name: nameNode.text.replace(/^"|"$/g, ""), viaMember: !!parent, receiver: parent?.text };
}

/** A bare file node for a language with no symbol structure to extract (Razor)
 * or whose optional grammar isn't built. Mirrors the walk path's file node. */
function fileNodeOf(rel: string, source: string): NodeV1 {
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
 * .targets). One `element` node per identifiable element — named by its
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
