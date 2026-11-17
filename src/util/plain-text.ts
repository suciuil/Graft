/**
 * Plain-text files (`.txt`, plus the extensions a repository adds with
 * `graft config index-text add`), which graph/text.ts cuts into line chunks when
 * the repository opts in (`BuildConfig.indexText`).
 *
 * The one place that says which paths are plain text. The extractor's table
 * (graph/extract.ts), the walker's size limit (ingest/fs.ts), the binary check
 * (util/source.ts), the card's table of contents (graph/cards.ts) and the concept
 * pass (context/build.ts) all read it, so adding an extension here reaches every
 * one of them. Kept free of imports so the walker can use it without loading the
 * extractor.
 */

/** The extensions that are always plain text, lower case with their dot. */
export const PLAIN_TEXT_EXTENSIONS: readonly string[] = [".txt"];

/**
 * The extensions the repository being indexed adds (`BuildConfig.indexTextExtensions`),
 * already checked: well formed, not `.txt`, and claimed by no parser. Set by
 * graph/source-files.ts `useTextExtensions` wherever a repo's file set is
 * enumerated (the build, `check`, the refresh fingerprint, the concept pass), so
 * everything below answers for that repo.
 *
 * Process state, like which optional grammars are built: graft indexes one
 * repository at a time, and each enumeration sets it again before it walks, so a
 * second repo indexed later in the same process (a workspace, the MCP server)
 * gets its own list, not the first one's.
 */
let extraExtensions: readonly string[] = [];

/** Make `exts` the extra plain-text extensions (see {@link extraExtensions}). */
export function setExtraTextExtensions(exts: readonly string[]): void {
  extraExtensions = [...new Set(exts)];
}

/** Every extension that is plain text right now: `.txt`, then the repo's extras. */
export function plainTextExtensions(): readonly string[] {
  return extraExtensions.length ? [...PLAIN_TEXT_EXTENSIONS, ...extraExtensions] : PLAIN_TEXT_EXTENSIONS;
}

/** The stored form of an `indexTextExtensions` entry: trimmed, lower case, with
 * its leading dot (`LOG`, `*.log` and `.log` are all `.log`). */
export function normalizeTextExtension(entry: string): string {
  const t = entry.trim().toLowerCase().replace(/^\*/, "");
  return t.startsWith(".") ? t : `.${t}`;
}

/** What an `indexTextExtensions` entry may look like once normalized: one
 * extension (`.log`, `.out`, `.c++x`), no path, no wildcard, no second dot. */
export const TEXT_EXTENSION_SHAPE = /^\.[a-z0-9][a-z0-9_+~-]*$/;

/** The limit for a plain-text file. Large on purpose: a big log, spec or dump is
 * the file the opt-in is for, and graph/text.ts caps its chunks, so the graph
 * stays bounded however big the file is. */
export const MAX_TEXT_FILE_BYTES = 50_000_000;

/** `CMakeLists.txt` is CMake (claimed by name in graph/extract.ts), never text. */
const CMAKE_LISTS = /(^|[/\\])cmakelists\.txt$/;

/** Whether `path` (either separator, any case) is a plain-text file. */
export function isPlainTextPath(path: string): boolean {
  const p = path.toLowerCase();
  if (PLAIN_TEXT_EXTENSIONS.some((e) => p.endsWith(e))) return !CMAKE_LISTS.test(p);
  return extraExtensions.some((e) => p.endsWith(e));
}

/**
 * Whether the repo-relative, posix path `rel` lies in the folders plain text is
 * indexed from (`BuildConfig.indexTextDirs`): under one of `dirs`, or anywhere
 * when `dirs` is empty. Each folder covers its whole subtree; matching is
 * case-sensitive, like `--only-dir`.
 */
export function inTextScope(rel: string, dirs: readonly string[]): boolean {
  return dirs.length === 0 || dirs.some((d) => rel === d || rel.startsWith(`${d}/`));
}

/**
 * The stored form of an `indexTextDirs` entry, the one {@link inTextScope}
 * compares against: posix separators, and no empty or `.` segments (so `./docs/`,
 * `docs\specs` and `docs/./specs` match like `docs`, `docs/specs`). An entry that
 * reduces to nothing (`.`, `./`) comes back empty. Every reader of the setting
 * (state.ts `readTextScope`, the parts re-rooting, `graft config`) uses this, so
 * a hand-edited entry means the same to all of them.
 */
export function normalizeTextDir(entry: string): string {
  return entry
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .join("/");
}
