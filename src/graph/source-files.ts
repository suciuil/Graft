/**
 * The file set a graph build parses, and its stat metadata.
 *
 * Split out of `build.ts` so the freshness probe (`fingerprint.ts`) can enumerate
 * exactly the same files without importing the builder (which would be an import
 * cycle: build → fingerprint → build). `build.ts` re-exports
 * {@link listSourceFiles} so its existing importers are unaffected.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { walkDir } from "../ingest/fs.js";
import { relPosix } from "../util/paths.js";
import { inTextScope, setExtraTextExtensions } from "../util/plain-text.js";
import { readExcludeDirs, readFollowNestedRepos, readFollowSubmodules, readIncludeDirs, readTextScope, type TextScope } from "../util/state.js";
import { languageOf, depthExtensions, depthRegistry } from "./extract.js";
import { genericLangOf, genericExtensions } from "./generic.js";
import { containerLangOf, containerExtensions } from "./container.js";

/** Every extension graft has a parser for (depth + breadth + container), sorted
 * and de-duped — the authoritative answer to "what does `-e` actually support". */
export function supportedExtensions(): string[] {
  return [...new Set([...depthExtensions(), ...genericExtensions(), ...containerExtensions()])].sort();
}

/**
 * Whether a parser claims extension `ext` (lower case, with its dot): a depth
 * grammar, whether or not an optional one is built, a breadth grammar or a
 * container. Such an extension can never be made plain text
 * (`indexTextExtensions`): text is checked after the parsers, so it would take
 * nothing from them where the grammar loads, and would take files from a
 * grammar that merely failed to load.
 */
export function claimedByParser(ext: string): boolean {
  const e = ext.toLowerCase();
  if (depthRegistry().some((r) => r.grammar !== "text" && r.ext.toLowerCase() === e)) return true;
  return [...genericExtensions(), ...containerExtensions()].some((x) => x.toLowerCase() === e);
}

/**
 * Make the repo's added plain-text extensions (`TextScope.exts`) the ones every
 * text check answers with (util/plain-text.ts), minus any a parser claims — a
 * hand-edited `.graft/config.json` cannot turn code into text. Called before each
 * enumeration of a repo's files (the build, {@link listSourceFiles}, the concept
 * pass), so the walker's size limit, the extractor and the cards all agree on
 * which files are text for the repo being indexed.
 */
export function useTextExtensions(exts: readonly string[]): void {
  setExtraTextExtensions(exts.filter((e) => !claimedByParser(e)));
}

/** Normalize a user-supplied extension: ensure a leading dot, lower-case. */
function normExt(e: string): string {
  const t = e.trim().toLowerCase();
  return t.startsWith(".") ? t : `.${t}`;
}

/**
 * The subset of user-supplied `-e` extensions that no parser claims (depth or breadth).
 * `graft build -e ".vue"` used to accept these silently and index nothing; the CLI warns
 * on whatever this returns so an unsupported extension is never a quiet no-op.
 */
export function unsupportedExtensions(exts: string[]): string[] {
  const supported = new Set(supportedExtensions().map((e) => e.toLowerCase()));
  // A whole file name (`CMakeLists.txt`) is matched as written, case-insensitively.
  return exts.filter((e) => !supported.has(normExt(e)) && !supported.has(e.trim().toLowerCase()));
}

/**
 * The source files a graph build parses: supported languages, minus the
 * output dir. When no pre-enumerated `repoFiles` is passed, the walk reads
 * `root`'s persisted file-walk choices directly from state, so every caller
 * that enumerates through here (the fingerprint probe and hooks/refresh path,
 * none of which ever see a CLI flag) behaves identically to the build that
 * saved those choices.
 */
/** Keep only files whose repo-relative path is at or under one of `onlyDirs`.
 * No-op when `onlyDirs` is empty/absent. The whitelist is carried in the graph
 * itself (the fingerprint records it at build time), never in the source repo,
 * so a build and the query-path freshness probe read the identical set. */
export function filterByOnlyDirs(
  files: string[],
  root: string,
  onlyDirs?: ReadonlySet<string>,
): string[] {
  if (!onlyDirs || onlyDirs.size === 0) return files;
  return files.filter((abs) => {
    const rel = relPosix(root, abs);
    return [...onlyDirs].some((d) => rel === d || rel.startsWith(`${d}/`));
  });
}

export function listSourceFiles(
  root: string,
  outDir: string,
  repoFiles?: string[],
  onlyDirs?: ReadonlySet<string>,
  /** Which plain-text files are kept; defaults to the repo's saved choice. Passed
   * only by a caller that knows a choice not saved yet (`graft build
   * --index-text` sizing its heap before it writes the setting). */
  textScope: TextScope = readTextScope(resolve(root)),
): string[] {
  // The repo's added text extensions first, so the walk below keeps a big `.log`
  // under the plain-text size limit rather than the code one.
  useTextExtensions(textScope.exts);
  const walked =
    repoFiles ??
    walkDir(root, readIncludeDirs(resolve(root)), {
      followSubmodules: readFollowSubmodules(resolve(root)),
      excludes: readExcludeDirs(resolve(root)),
      followNestedRepos: readFollowNestedRepos(resolve(root)),
    });
  // A file is a source file if a depth-tier grammar (languageOf), a breadth-tier
  // grammar (genericLangOf) or a container (containerLangOf) claims its extension.
  // All three must agree here or `build` and `check` would enumerate different sets.
  // Plain text is claimed by languageOf but kept only when the repo opted in
  // (`indexText`), and only under its `indexTextDirs` when it lists any; read from
  // state, like the walk choices above, so a build, `check` and the refresh
  // fingerprint all see the same set.
  return filterByOnlyDirs(
    walked.filter((f) => {
      if (f.startsWith(outDir)) return false;
      const lang = languageOf(f);
      if (lang === "text") return textScope.on && inTextScope(relPosix(root, f), textScope.dirs);
      return lang !== null || genericLangOf(f) !== null || containerLangOf(f) !== null;
    }),
    root,
    onlyDirs,
  );
}

export interface SourceStat {
  /** Absolute path. */
  abs: string;
  /** Repo-relative, posix (`relPosix`) — exactly the form `buildGraph` uses for
   * node ids and `checkGraph` diffs against, so cache keys and ids can never
   * disagree. Posix on every platform: see `../util/paths.ts`. */
  rel: string;
  size: number;
  mtimeMs: number;
}

/**
 * {@link listSourceFiles} plus each file's `(size, mtimeMs)` — the currency of
 * both the freshness probe and the extraction cache. Files that vanish between
 * the walk and the stat are dropped (same fail-soft posture as `walkDir`).
 */
export function listSourceStats(
  root: string,
  outDir: string,
  repoFiles?: string[],
  onlyDirs?: ReadonlySet<string>,
): SourceStat[] {
  const out: SourceStat[] = [];
  for (const abs of listSourceFiles(root, outDir, repoFiles, onlyDirs)) {
    let s: { size: number; mtimeMs: number };
    try {
      s = statSync(abs);
    } catch {
      continue;
    }
    out.push({ abs, rel: relPosix(root, abs), size: s.size, mtimeMs: s.mtimeMs });
  }
  return out;
}
