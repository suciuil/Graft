/**
 * `graft languages`: every language graft indexes, the level of support it gets on
 * THIS install, and what that level extracts.
 *
 * The rows are derived from the same registries the build dispatches on — the depth
 * tier's extension table (extract.ts), the breadth registry (generic.ts), the
 * container registry (container.ts) and the LSP registry — and the level is decided
 * the way `tierOf` (build.ts) decides it: an optional grammar that is not built, or a
 * native grammar that will not load, shows the level the build would really fall
 * back to. Only the per-language feature list of the depth tier is written out by
 * hand below, because it lives in extractor code, not in a table; it is typed over
 * {@link Language} so a new depth language cannot be added without an entry.
 */
import { depthRegistry, grammarAvailable, type Language } from "./extract.js";
import { GENERIC_IMPORT_LANGS, GENERIC_LANGS, fallbackLangOf, genericSupport, wasmInstalled, type GenericLang } from "./generic.js";
import { CONTAINER_LANGS } from "./container.js";
import { missingNativePackages, nativeReady, optionalGrammarPackages } from "./native.js";
import { LSP_SERVERS } from "./lsp/registry.js";

/**
 * How much graft extracts from a language, best first:
 * - `full`: a hand-written extractor (the depth tier).
 * - `broad`: the generic tree-sitter tags extractor (the breadth tier): symbols and calls.
 * - `symbols`: the breadth tier with no tags query: symbols only.
 * - `structural`: data and markup: keys, elements, headings or rules, no call graph.
 * - `file-only`: one node per file, no symbols.
 * - `skipped`: an optional grammar that is not built here; these files are not indexed.
 */
export type SupportLevel = "full" | "broad" | "symbols" | "structural" | "file-only" | "skipped";

export const SUPPORT_LEVELS: readonly SupportLevel[] = ["full", "broad", "symbols", "structural", "file-only", "skipped"];

export interface LanguageFeatures {
  /** Functions, classes, methods, types … as nodes with exact spans. */
  symbols: boolean;
  /** Call edges. */
  calls: boolean;
  /** File/module import edges. */
  imports: boolean;
  /** extends / implements edges. */
  inherits: boolean;
  /** Member calls resolved through variable types (`x.save()` → `Repo.save`). */
  types: boolean;
}

export interface LanguageSupport {
  name: string;
  level: SupportLevel;
  /** The tier that extracts it here: `depth`, `breadth`, `container`, or null when skipped. */
  tier: "depth" | "breadth" | "container" | null;
  extensions: string[];
  features: LanguageFeatures;
  /** The language server `graft build --lsp` would use for it, or null. */
  lsp: string | null;
  /** Why the level is below what the language can get, and how to raise it. */
  note?: string;
}

type DepthSpec = { level: SupportLevel } & LanguageFeatures;

const code = (calls: boolean, imports: boolean, inherits: boolean, types: boolean): DepthSpec => ({
  level: "full",
  symbols: true,
  calls,
  imports,
  inherits,
  types,
});
const data = (calls = false): DepthSpec => ({ level: "structural", symbols: true, calls, imports: false, inherits: false, types: false });

/**
 * What each depth-tier extractor emits (extract.ts `extractFile`/`walk`, and the
 * receiver-binding pass in bindings.ts, which covers TS/TSX, Python, Go, Java, Swift
 * and PHP). Go and C have no inheritance to extract; SCSS's one call is `@include`.
 */
const DEPTH: Record<Language, DepthSpec> = {
  typescript: code(true, true, true, true),
  tsx: code(true, true, true, true),
  python: code(true, true, true, true),
  go: code(true, true, false, true),
  java: code(true, true, true, true),
  kotlin: code(true, true, true, false),
  swift: code(true, true, true, true),
  php: code(true, true, true, true),
  r: code(true, true, true, false),
  c_sharp: code(true, true, true, false),
  groovy: code(true, true, false, false),
  plsql: code(true, false, false, false),
  c: code(true, true, false, false),
  cpp: code(true, true, true, false),
  css: data(),
  html: data(),
  xml: data(),
  json: data(),
  yaml: data(),
  markdown: data(),
  scss: data(true),
  csv: data(),
  // Functions, macros and targets; calls between them; include()/add_subdirectory()
  // imports; target_link_libraries is a reference, not inheritance.
  cmake: code(true, true, false, false),
  razor: { level: "file-only", symbols: false, calls: false, imports: false, inherits: false, types: false },
};

/** Display names, keyed by the label the build banner uses (or the breadth/container name). */
const DISPLAY: Record<string, string> = {
  typescript: "TypeScript",
  tsx: "TypeScript",
  javascript: "JavaScript",
  jsx: "JavaScript",
  python: "Python",
  go: "Go",
  java: "Java",
  kotlin: "Kotlin",
  swift: "Swift",
  php: "PHP",
  r: "R",
  "c#": "C#",
  c_sharp: "C#",
  groovy: "Groovy",
  sql: "PL/SQL",
  razor: "Razor",
  css: "CSS",
  html: "HTML",
  xml: "XML",
  xaml: "XML",
  c: "C",
  cpp: "C++",
  json: "JSON",
  yaml: "YAML",
  markdown: "Markdown",
  scss: "SCSS",
  csv: "CSV",
  cmake: "CMake",
  rust: "Rust",
  ruby: "Ruby",
  scala: "Scala",
  elixir: "Elixir",
  solidity: "Solidity",
  ocaml: "OCaml",
  zig: "Zig",
  dart: "Dart",
  clojure: "Clojure",
  nix: "Nix",
  lua: "Lua",
  vue: "Vue",
};

const display = (key: string): string => DISPLAY[key] ?? key.charAt(0).toUpperCase() + key.slice(1);

const NONE: LanguageFeatures = { symbols: false, calls: false, imports: false, inherits: false, types: false };

function lspFor(keys: Iterable<string>): string | null {
  const set = new Set(keys);
  return LSP_SERVERS.find((s) => s.languages.some((l) => set.has(l)))?.command ?? null;
}

/** What the breadth tier gives a file of `row`'s language here. */
function breadth(row: GenericLang): { level: SupportLevel; features: LanguageFeatures } {
  const s = genericSupport(row.name);
  if (!s.grammar) return { level: "file-only", features: NONE };
  return {
    level: s.calls ? "broad" : "symbols",
    features: { symbols: true, calls: s.calls, imports: GENERIC_IMPORT_LANGS.has(row.name), inherits: false, types: false },
  };
}

function pkgOf(grammar: string): string {
  return optionalGrammarPackages()[grammar] ?? `tree-sitter-${grammar}`;
}

/**
 * Every language graft can index, with the level it gets on this install.
 * `packageName` (the installed npm package) goes into the fix for a native parser
 * that did not build.
 */
export function languageSupport(packageName = "@nanonets/graft"): LanguageSupport[] {
  const rows: LanguageSupport[] = [];

  // Depth tier, one row per display name (TypeScript = .ts/.mts/.cts/.tsx, …).
  const groups = new Map<string, { grammar: Language; optional: boolean; labels: Set<string>; exts: string[] }>();
  for (const e of depthRegistry()) {
    const name = display(e.label);
    const g = groups.get(name);
    if (g) {
      g.labels.add(e.label);
      g.exts.push(e.ext);
    } else groups.set(name, { grammar: e.grammar, optional: e.optional, labels: new Set([e.label]), exts: [e.ext] });
  }

  for (const [name, g] of groups) {
    const spec = DEPTH[g.grammar];
    const depthFeatures: LanguageFeatures = { ...spec };
    const claimed = !g.optional || grammarAvailable(g.grammar);
    let row: LanguageSupport;
    if (claimed && nativeReady(g.grammar)) {
      row = { name, level: spec.level, tier: "depth", extensions: g.exts, features: depthFeatures, lsp: null };
    } else if (claimed) {
      // The grammar is there but its native parser will not load: the build hands
      // these files to the breadth-tier stand-in (or keeps a file node).
      const standIn = fallbackLangOf(g.grammar);
      const b = standIn ? breadth(standIn) : { level: "file-only" as SupportLevel, features: NONE };
      const pkgs = missingNativePackages([g.grammar]);
      const fix = pkgs.length ? `: npm install -g --allow-scripts=${pkgs.join(",")} ${packageName}` : "";
      row = {
        name,
        level: b.level,
        tier: standIn && b.level !== "file-only" ? "breadth" : null,
        extensions: g.exts,
        features: b.features,
        lsp: null,
        note: `native parser missing, ${spec.level} support needs it${fix}`,
      };
    } else {
      // An optional grammar that is not built: its extensions go to the breadth
      // tier when a breadth row claims them (C, C++, C#), else nowhere.
      const b = GENERIC_LANGS.find((l) => l.name === g.grammar);
      const raise = `build the optional ${pkgOf(g.grammar)} grammar (npm run build:grammars) for ${spec.level} support`;
      row = b
        ? { name, ...breadth(b), tier: "breadth", extensions: [...b.exts], lsp: null, note: raise }
        : { name, level: "skipped", tier: null, extensions: g.exts, features: NONE, lsp: null, note: raise };
    }
    if (row.level !== "skipped") row.lsp = lspFor([...g.labels, g.grammar]);
    rows.push(row);
  }

  // Breadth tier: the languages no depth extractor claims (Java, C, C++, C# have
  // both, and were reported above with whichever tier really parses them).
  const depthGrammars = new Set<string>(depthRegistry().map((e) => e.grammar));
  for (const l of GENERIC_LANGS) {
    if (depthGrammars.has(l.name)) continue;
    const b = breadth(l);
    rows.push({
      name: display(l.name),
      ...b,
      tier: b.level === "file-only" ? null : "breadth",
      extensions: [...l.exts],
      lsp: lspFor([l.name]),
      ...(b.level === "file-only" ? { note: `the ${l.wasm} WASM grammar is missing from tree-sitter-wasm` } : {}),
    });
  }

  // Containers: the embedded block goes to the depth extractor of its language.
  for (const c of CONTAINER_LANGS) {
    const inner = rows.find((r) => r.name === display(c.inner));
    const ok = wasmInstalled(c.wasm) && inner !== undefined && inner.level !== "skipped";
    rows.push({
      name: display(c.name),
      level: ok ? inner!.level : "file-only",
      tier: ok ? "container" : null,
      extensions: [...c.exts],
      features: ok ? inner!.features : NONE,
      lsp: null,
      note: ok
        ? `<script> blocks are extracted as ${display(c.inner)}`
        : `the ${c.wasm} WASM grammar is missing from tree-sitter-wasm`,
    });
  }

  const rank = (l: SupportLevel) => SUPPORT_LEVELS.indexOf(l);
  return rows.sort((a, b) => rank(a.level) - rank(b.level) || a.name.localeCompare(b.name));
}

const LEVEL_TEXT: Record<SupportLevel, string> = {
  full: "hand-written extractor (depth tier): symbols and calls, plus imports and inheritance where the language has them, resolved with scope and imports",
  broad: "generic tree-sitter tags extractor (breadth tier): symbols, plus calls resolved by name",
  symbols: "breadth tier with no tags query for the language: symbols only, no call edges",
  structural: "data and markup: keys, elements, headings or rules become queryable nodes; no call graph",
  "file-only": "one node per file, no symbols",
  skipped: "an optional grammar that is not built on this install: these files are not indexed",
};

const COLUMN_TEXT: [string, string][] = [
  ["Symbols", "functions, classes, methods, types … as nodes with exact file:line spans"],
  ["Calls", "call edges (what `graft callers` walks)"],
  ["Imports", "file/module import edges"],
  ["Inherits", "extends / implements edges"],
  ["Types", "member calls resolved through variable types (x.save() → Repo.save)"],
  ["LSP", "the server `graft build --lsp` uses for precise call edges, when it is on your PATH"],
];

/** The table `graft languages` prints. `name` is the program name. */
export function formatLanguageSupport(rows: LanguageSupport[], name = "graft"): string {
  const mark = (b: boolean) => (b ? "✓" : "·");
  const head = ["Language", "Level", "Symbols", "Calls", "Imports", "Inherits", "Types", "LSP", "Extensions"];
  const body = rows.map((r) => [
    r.name,
    r.level,
    mark(r.features.symbols),
    mark(r.features.calls),
    mark(r.features.imports),
    mark(r.features.inherits),
    mark(r.features.types),
    r.lsp ?? "·",
    r.extensions.join(" "),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((cells) => cells[i]!.length)));
  const line = (cells: string[]) =>
    "  " + cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]! + 2))).join("").trimEnd();

  const out = [
    `Languages ${name} indexes, and what it extracts from each on this install.`,
    "All of it is tree-sitter parsing: $0, deterministic, no LLM and no key.",
    "",
    line(head),
    ...body.map(line),
  ];

  const notes = rows.filter((r) => r.note);
  if (notes.length) {
    out.push("", "Notes:");
    const w = Math.max(...notes.map((r) => r.name.length));
    for (const r of notes) out.push(`  ${r.name.padEnd(w + 2)}${r.note}`);
  }

  const levelW = Math.max(...SUPPORT_LEVELS.map((l) => l.length));
  out.push("", "Levels:");
  for (const l of SUPPORT_LEVELS) out.push(`  ${l.padEnd(levelW + 2)}${LEVEL_TEXT[l]}`);

  const colW = Math.max(...COLUMN_TEXT.map(([c]) => c.length));
  out.push("", "Columns (✓ extracted, · not):");
  for (const [c, text] of COLUMN_TEXT) out.push(`  ${c.padEnd(colW + 2)}${text}`);
  out.push(
    "",
    `A file whose extension is not listed is skipped. \`${name} build -e <ext>\` warns about an extension no parser claims.`,
  );
  return out.join("\n") + "\n";
}
