/**
 * The depth tier's native grammars, loaded on first use and never fatally.
 *
 * Every depth-tier grammar is a native addon, and so is `tree-sitter` itself. Most
 * ship prebuilt binaries that load with no install step, but not all of them:
 * `tree-sitter-kotlin` ships none at all, and `tree-sitter` and
 * `tree-sitter-python` have no linux-arm64 build. Those work only if npm ran their
 * install script, which compiles one. npm 12 stopped running dependency install
 * scripts by default, so after a plain `npm install -g` the binary is not there.
 *
 * These used to be static imports at the top of extract.ts. One missing binary
 * then threw while the module graph loaded and took every command down with it,
 * the MCP server and the hooks included, even in a repo with no Kotlin in it.
 * Now each is required the first time a file of its language is parsed, and a
 * failure is remembered: that language's files go to its WASM stand-in in the
 * breadth tier instead (`fallbackLangOf` in generic.ts), and the build says which
 * languages and how to get the native parser back ({@link nativeFallbackNotice}).
 */
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Parser from "tree-sitter";
import type { Language } from "./extract.js";

const nodeRequire = createRequire(import.meta.url);

const CORE = "tree-sitter";

/** The module each core depth-tier grammar comes from, and the export that is the
 * grammar when the module ships more than one (typescript+tsx, php+php_only). The
 * other depth languages have only an optional, locally-built grammar (below). */
const GRAMMAR_MODULES: Partial<Record<Language, { module: string; pick?: string }>> = {
  typescript: { module: "tree-sitter-typescript", pick: "typescript" },
  tsx: { module: "tree-sitter-typescript", pick: "tsx" },
  python: { module: "tree-sitter-python" },
  go: { module: "tree-sitter-go" },
  r: { module: "tree-sitter-r" },
  java: { module: "tree-sitter-java" },
  kotlin: { module: "tree-sitter-kotlin" },
  swift: { module: "tree-sitter-swift" },
  php: { module: "tree-sitter-php", pick: "php" },
};

/** The name `npm --allow-scripts` needs, where it differs from the module name.
 * `tree-sitter-r` is an npm alias, and npm matches an allow entry against the real
 * package only: an alias as the key matches nothing. */
const NPM_NAME: Record<string, string> = {
  "tree-sitter-r": "@davisvaughan/tree-sitter-r",
};

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
  // C and C++ get a hand-written depth extractor (they already have a breadth row
  // too; buildGraph prefers depth for .c/.cpp/.h once the native grammar loads).
  c: { pkg: "tree-sitter-c" },
  cpp: { pkg: "tree-sitter-cpp" },
  // Data/markup: symbol-only custom extractors. markdown's binding default export
  // is the block grammar (its `inline` grammar is a separate property we don't use).
  json: { pkg: "tree-sitter-json" },
  yaml: { pkg: "@tree-sitter-grammars/tree-sitter-yaml" },
  markdown: { pkg: "@tree-sitter-grammars/tree-sitter-markdown" },
  scss: { pkg: "tree-sitter-scss" },
  // Monorepo grammar exporting { csv, psv, tsv } — pick CSV.
  csv: { pkg: "tree-sitter-csv", prop: "csv" },
  // Kotlin is a CORE language (the registry `tree-sitter-kotlin` is a dependency),
  // but a locally-built grammar, when present, is newer and parses more real Kotlin
  // (e.g. `receiver_type`, destructuring, guard conditions, multi-dollar strings), so
  // {@link grammarOf} prefers it. The dependency key differs from the package's own
  // name (`tree-sitter-kotlin`) so the two can be installed side by side; without the
  // local build the registry grammar is the fallback and Kotlin stays fully indexed.
  kotlin: { pkg: "tree-sitter-kotlin-local" },
};

const optionalGrammarCache = new Map<string, unknown | null>();

/** Graft's own package root. `src/graph/` while developing and `dist/graph/` once
 * compiled both sit two levels below it, so one expression serves both layouts. */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Grammar key → the npm package that ships its binding. For tooling that has to
 * bridge the two namings — the bundle packer keys its vendored directories by grammar
 * key, because the package name is not a stable handle (the groovy grammar's package
 * calls itself `@bootswithdefer/tree-sitter-groovy` while graft asks for `tree-sitter-groovy`). */
export function optionalGrammarPackages(): Record<string, string> {
  return Object.fromEntries(Object.entries(OPTIONAL_GRAMMAR_PKG).map(([k, v]) => [k, v.pkg]));
}

/** The package root for an optional grammar, or null when it isn't installed. */
function installedRoot(pkg: string): string | null {
  try {
    // Resolve `package.json` rather than the package main: it works even when the main
    // is an ESM/top-level-await wrapper, which C#'s binding uses.
    return dirname(nodeRequire.resolve(`${pkg}/package.json`));
  } catch {
    return null;
  }
}

/** Pull a grammar out of one candidate root: node-gyp-build first, since it knows the
 * package's own layout, then a direct scan of the two places a built `.node` can sit.
 * The scan is what makes a bundle work — it ships bare `.node` files with no
 * package.json and no node-gyp-build to consult. */
function grammarFromRoot(root: string, prop?: string): unknown | null {
  try {
    const ngb = createRequire(join(root, "package.json"))("node-gyp-build") as (r: string) => unknown;
    const g = pickGrammar(ngb(root), prop);
    if (g) return g;
  } catch {
    /* not an installed package (or no node-gyp-build) — fall through to the scan */
  }
  for (const dir of [join(root, "build", "Release"), join(root, "prebuilds", `${process.platform}-${process.arch}`)]) {
    try {
      const file = readdirSync(dir).find((f) => f.endsWith(".node"));
      if (file) {
        const g = pickGrammar(nodeRequire(join(dir, file)), prop);
        if (g) return g;
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/** Load an optional native grammar synchronously, bypassing any ESM/top-level-await
 * index wrapper by loading the built `.node` directly. Two roots are tried in turn:
 * the installed package, then `vendor/<key>/` inside graft itself — which is all a
 * machine that installed the self-contained bundle has, the sibling grammar repos
 * being local to the machine that built it. Cached, including the null (unavailable)
 * result, so it probes the filesystem once. */
function loadOptionalGrammar(key: string): unknown | null {
  if (optionalGrammarCache.has(key)) return optionalGrammarCache.get(key) ?? null;
  const spec = OPTIONAL_GRAMMAR_PKG[key];
  let grammar: unknown | null = null;
  if (spec) {
    for (const root of [installedRoot(spec.pkg), join(PKG_ROOT, "vendor", key)]) {
      if (!root) continue;
      grammar = grammarFromRoot(root, spec.prop);
      if (grammar) break;
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
 * `html`, `razor`, …, and the locally-built `kotlin`) is installed and loads.
 * Synchronous; drives the per-language test skips and the extension-claiming below.
 * For Kotlin it only reports the local grammar — `.kt`/`.kts` are claimed either way. */
export function grammarAvailable(key: string): boolean {
  return loadOptionalGrammar(key) !== null;
}

type Loaded = { ok: true; value: unknown } | { ok: false; error: string };

let requireModule: (id: string) => unknown = (id) => nodeRequire(id);
const modules = new Map<string, Loaded>();
const ready = new Map<Language, boolean>();
/** undefined: not tried yet. null: tried, and the core binding is unusable. */
let parser: Parser | null | undefined;
/** Whether a locally-built grammar may stand in for a core one (Kotlin). Off while
 * a test require is installed: the seam simulates a stock install, which has only
 * the registry grammar, so a vendored build must not mask the binary it removes. */
let optionalOverridesCore = true;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function load(id: string): Loaded {
  let hit = modules.get(id);
  if (!hit) {
    try {
      hit = { ok: true, value: requireModule(id) };
    } catch (err) {
      hit = { ok: false, error: message(err) };
    }
    modules.set(id, hit);
  }
  return hit;
}

function coreParser(): Parser | null {
  if (parser === undefined) {
    const core = load(CORE);
    parser = null;
    if (core.ok) {
      try {
        parser = new (core.value as typeof Parser)();
      } catch (err) {
        modules.set(CORE, { ok: false, error: message(err) });
      }
    }
  }
  return parser;
}

/** The core module's grammar for `lang`, or null when it has none or it won't load. */
function coreGrammarOf(lang: Language): unknown {
  const spec = GRAMMAR_MODULES[lang];
  if (!spec) return null;
  const { module, pick } = spec;
  const m = load(module);
  if (!m.ok) return null;
  return pick ? ((m.value as Record<string, unknown>)[pick] ?? null) : m.value;
}

/** The grammar that parses `lang`: a locally-built optional grammar when one loads
 * (it wins over the registry one where a language has both, so building it upgrades
 * the parser without removing the fallback), else the core module's. */
function grammarOf(lang: Language): unknown {
  const optional = optionalOverridesCore || !GRAMMAR_MODULES[lang] ? loadOptionalGrammar(lang) : null;
  return optional ?? coreGrammarOf(lang);
}

/** Where a language's grammar comes from right now: `"optional"` for a locally
 * built native grammar (see {@link OPTIONAL_GRAMMAR_PKG}), `"core"` for the
 * registry grammar, or null when neither is available. Lets tests and
 * diagnostics tell which Kotlin grammar is really parsing. */
export function grammarSourceOf(lang: Language): "optional" | "core" | null {
  if (loadOptionalGrammar(lang)) return "optional";
  return coreGrammarOf(lang) ? "core" : null;
}

/**
 * True when `lang`'s native grammar loads and the parser accepts it. The first call
 * per language does the loading; the answer is cached for the life of the process.
 * Never throws.
 */
export function nativeReady(lang: Language): boolean {
  let ok = ready.get(lang);
  if (ok === undefined) {
    ok = false;
    // Load the grammar even when the core binding failed, so the notice can name
    // every package that is missing its binary, not only the first.
    const grammar = grammarOf(lang);
    const p = coreParser();
    if (p && grammar) {
      try {
        p.setLanguage(grammar as never);
        ok = true;
      } catch {
        /* an addon built for another tree-sitter ABI: unusable, though it loaded */
      }
    }
    ready.set(lang, ok);
  }
  return ok;
}

/** The shared native parser, set to `lang`. Throws when that grammar is not
 * available; callers ask {@link nativeReady} first and send the file elsewhere. */
export function nativeParser(lang: Language): Parser {
  if (!nativeReady(lang)) {
    const module = GRAMMAR_MODULES[lang]?.module;
    const why = [CORE, ...(module ? [module] : [])].map((id) => modules.get(id)).find((m) => m && !m.ok);
    throw new Error(`the native ${lang} parser is not available${why && !why.ok ? `: ${why.error}` : ""}`);
  }
  const p = parser as Parser;
  p.setLanguage(grammarOf(lang) as never);
  return p;
}

/**
 * The npm packages whose missing binary keeps these languages off the native
 * parser: what `npm install --allow-scripts=…` has to name. Empty when every one
 * loaded, or when the ones that failed did load and were rejected by the parser
 * (an ABI mismatch, which no install flag fixes).
 */
export function missingNativePackages(langs: Iterable<Language>): string[] {
  const out = new Set<string>();
  for (const lang of langs) {
    if (nativeReady(lang)) continue;
    const module = GRAMMAR_MODULES[lang]?.module;
    for (const id of [CORE, ...(module ? [module] : [])]) {
      const m = modules.get(id);
      if (m && !m.ok) out.add(NPM_NAME[id] ?? id);
    }
  }
  return [...out].sort();
}

/** The languages a build parsed with a WASM stand-in instead of their native
 * grammar, and the packages to allow so the next install builds them. */
export interface NativeFallback {
  /** Display labels (`javascript`, not the `typescript` grammar that parses it). */
  languages: string[];
  packages: string[];
}

/**
 * The one line a build prints when some languages fell back, or null when none did.
 * One line on purpose: `graft init` passes on only the `⚠`/`✗` lines of the build
 * it runs, so a second line holding the fix would be dropped there.
 */
export function nativeFallbackNotice(fallback: NativeFallback | undefined, packageName: string): string | null {
  if (!fallback || fallback.languages.length === 0) return null;
  const langs = fallback.languages.join(", ");
  const what = fallback.languages.length === 1 ? "the native parser is" : "the native parsers are";
  const head = `⚠ ${langs}: basic parsing only, ${what} missing.`;
  if (fallback.packages.length === 0) return head;
  return `${head} To fix: npm install -g --allow-scripts=${fallback.packages.join(",")} ${packageName}`;
}

/** Test seam: replace how native modules are required (null restores the real
 * `require`), and forget everything loaded so far. A missing binary is simulated by
 * a function that throws for that module id, the way node-gyp-build does. */
export function setNativeRequireForTest(fn: ((id: string) => unknown) | null): void {
  requireModule = fn ?? ((id) => nodeRequire(id));
  optionalOverridesCore = fn === null;
  modules.clear();
  ready.clear();
  parser = undefined;
}

/** The real `require` the seam above wraps, for a test's pass-through. */
export function realNativeRequire(id: string): unknown {
  return nodeRequire(id);
}
