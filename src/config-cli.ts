/**
 * `graft config`: list and edit the per-repo settings in `.graft/config.json`
 * without hand-editing JSON. Pure functions over the repo dir; the commander
 * wiring lives in cli.ts and the prose in cli-help-graft.ts.
 *
 * The validation here is the same `graft build --include-dir/--exclude-dir`
 * applies, so a value accepted by one is accepted by the other.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cmd } from "./brand.js";
import { SKIP_DIRS, normalizeExcludeEntry } from "./ingest/fs.js";
import { normalizePathPrefix } from "./util/paths.js";
import { claimedByParser } from "./graph/source-files.js";
import { normalizeTextDir, normalizeTextExtension, PLAIN_TEXT_EXTENSIONS, TEXT_EXTENSION_SHAPE } from "./util/plain-text.js";
import {
  DEFAULT_DEEP_STALE_THRESHOLD,
  buildConfigPath,
  patchBuildConfig,
  readBuildConfig,
  resolveAutoDeep,
  resolveDeepStaleThreshold,
} from "./util/state.js";

export type DirListKey = "excludeDirs" | "includeDirs" | "indexTextDirs";
/** Every list setting: the folder lists, and the extensions indexText treats as text. */
export type ListKey = DirListKey | "indexTextExtensions";
export type FlagKey = "followSubmodules" | "followNestedRepos" | "indexText";

/** Why `entry` cannot be an `indexTextExtensions` entry (an extension indexed as
 * plain text on top of `.txt`), or null when it can. One extension; not `.txt`,
 * which is text anyway; and not one graft parses, which stays with its parser. */
export function indexTextExtensionProblem(entry: string): string | null {
  const ext = normalizeTextExtension(entry);
  if (ext === ".") return "expected a file extension, like .log";
  if (!TEXT_EXTENSION_SHAPE.test(ext)) return "expected one file extension, like .log — no path, wildcard or second dot";
  if (PLAIN_TEXT_EXTENSIONS.includes(ext)) return `${ext} files are plain text already — \`${cmd("graft config index-text on")}\` indexes them`;
  if (claimedByParser(ext)) return `graft already parses ${ext} files as code or data, so they cannot be indexed as plain text`;
  return null;
}

/** Why `name` cannot be an `includeDirs` entry, or null when it can. */
export function includeDirProblem(name: string): string | null {
  if (name.trim() === "") return "expected a directory name";
  if (name.startsWith(".")) return "dot-directories are never overridable";
  if (name.includes("/") || name.includes("\\")) return "expected a bare directory name, not a path";
  if (name.includes("*") || name.includes("?")) return "wildcards are not supported here — name one directory";
  return null;
}

/** Why `name` cannot be an `excludeDirs` entry, or null when it can. */
export function excludeDirProblem(name: string): string | null {
  const value = normalizeExcludeEntry(name);
  if (!value) return "empty after normalising — expected a directory name or a root-relative path";
  // An absolute path cannot be compared against a root-relative one, and `..`
  // would reach outside the repo being indexed: user error, not a silent no-match.
  if (/^[a-zA-Z]:/.test(value) || name.startsWith("/") || name.startsWith("\\")) {
    return "expected a path relative to the repo root, not an absolute one";
  }
  if (value.split("/").includes("..")) return '".." cannot appear — the path must stay inside the repo';
  return null;
}

/** Why `path` cannot be an `indexTextDirs` entry (a folder `.txt` files are
 * indexed from), or null when it can. A folder path from the repo root, like
 * `--only-dir`: no globs, nothing absolute, nothing outside the repo. */
export function indexTextDirProblem(path: string): string | null {
  const raw = normalizePathPrefix(path.trim());
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith("/")) return "expected a path relative to the repo root, not an absolute one";
  const value = normalizeTextDir(raw);
  if (!value)
    return "expected a folder path relative to the repo root (the repo root itself is the default: leave index-text-dirs empty to index every folder)";
  if (value.split("/").includes("..")) return '".." cannot appear — the folder must be inside the repo';
  if (value.includes("*") || value.includes("?")) return "wildcards are not supported here — name one folder";
  return null;
}

/** The stored form of an entry: excludes and text folders are normalised (`\` →
 * `/`, no leading `./`, no trailing `/`), text extensions lower-cased with their
 * dot; include names are stored as given. */
export function normalizeDirEntry(key: ListKey, entry: string): string {
  if (key === "excludeDirs") return normalizeExcludeEntry(entry);
  if (key === "indexTextDirs") return normalizeTextDir(entry);
  if (key === "indexTextExtensions") return normalizeTextExtension(entry);
  return entry.trim();
}

export function dirProblem(key: ListKey, entry: string): string | null {
  if (key === "excludeDirs") return excludeDirProblem(entry);
  if (key === "indexTextDirs") return indexTextDirProblem(entry);
  if (key === "indexTextExtensions") return indexTextExtensionProblem(entry);
  return includeDirProblem(entry);
}

/** Why a stored `indexTextExtensions` entry is ignored (a hand edit can store
 * anything), for `list` to show; null for an entry that is used. */
export function textExtensionNote(entry: string): string | null {
  const problem = indexTextExtensionProblem(entry);
  return problem ? `ignored: ${problem}` : null;
}

/** How an entry will match, for `list` and `add` to show; null when there is nothing to add. */
export function dirEntryNote(key: DirListKey, entry: string, repo: string): string | null {
  if (key === "excludeDirs") return describeExcludeEntry(entry);
  if (key === "includeDirs") return includeEntryNote(entry);
  return existsSync(join(repo, entry)) ? "folder, with its subtree" : "no such folder in the repo yet — nothing is indexed from it";
}

export function readDirList(repo: string, key: ListKey): string[] {
  const v = readBuildConfig(repo)?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** A saved entry as it is compared with what the user types. The build reads the
 * text keys normalized (`textDirsOf`, `textExtensionsOf`), so a hand-written
 * `LOG` or `docs/` is in use, and `add`/`remove` must see it as `.log` / `docs`
 * too; the other lists are compared as stored. */
function comparable(key: ListKey, stored: string): string {
  return key === "indexTextDirs" || key === "indexTextExtensions" ? normalizeDirEntry(key, stored) : stored;
}

/** Add entries not already present, in order. Never writes when nothing is new. */
export function addDirEntries(repo: string, key: ListKey, entries: string[]): { added: string[]; present: string[] } {
  const list = readDirList(repo, key);
  const have = list.map((v) => comparable(key, v));
  const added: string[] = [];
  const present: string[] = [];
  for (const raw of entries) {
    const value = normalizeDirEntry(key, raw);
    if (have.includes(value) || added.includes(value)) present.push(value);
    else added.push(value);
  }
  if (added.length) patchBuildConfig(repo, { [key]: [...list, ...added] });
  return { added, present };
}

/** Remove entries, compared in their stored form (the text keys normalized, as
 * the build reads them). Never writes when nothing matched. */
export function removeDirEntries(repo: string, key: ListKey, entries: string[]): { removed: string[]; missing: string[] } {
  const list = readDirList(repo, key);
  const wanted = entries.map((e) => normalizeDirEntry(key, e));
  const removed = list.filter((v) => wanted.includes(comparable(key, v)));
  const missing = wanted.filter((w) => !list.some((v) => comparable(key, v) === w));
  if (removed.length) patchBuildConfig(repo, { [key]: list.filter((v) => !wanted.includes(comparable(key, v))) });
  return { removed, missing };
}

export function clearDirEntries(repo: string, key: ListKey): string[] {
  const list = readDirList(repo, key);
  if (list.length) patchBuildConfig(repo, { [key]: [] });
  return list;
}

/** `on`/`off` and the usual spellings of each, or null for anything else. */
export function parseOnOff(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (["on", "true", "yes", "1", "enable", "enabled"].includes(v)) return true;
  if (["off", "false", "no", "0", "disable", "disabled"].includes(v)) return false;
  return null;
}

export function readFlag(repo: string, key: FlagKey): { value: boolean; set: boolean } {
  const v = readBuildConfig(repo)?.[key];
  return { value: v === true, set: typeof v === "boolean" };
}

export function writeFlag(repo: string, key: FlagKey, value: boolean): void {
  patchBuildConfig(repo, { [key]: value });
}

/** How a dir entry will match, for `list` and `add` to show. */
export function describeExcludeEntry(entry: string): string {
  if (entry.includes("*") || entry.includes("?")) return "glob, from the repo root";
  if (entry.includes("/")) return "path from the repo root, with its subtree";
  return "name, at any depth";
}

/** A short note for an include name that cannot change anything. */
export function includeEntryNote(name: string): string | null {
  return SKIP_DIRS.has(name)
    ? null
    : `not in the built-in skip list, so it is indexed anyway — this entry changes nothing (skipped by default: ${[...SKIP_DIRS].join(", ")})`;
}

export const CONFIG_APPLY_NOTE = () =>
  `· applies to the next build, and to the automatic refresh before each query — run \`${cmd("graft build")}\` to re-index now`;

/** `graft config list`: every setting, its value, its default and what it does. */
export function formatConfigList(repo: string, home?: string): string {
  const path = buildConfigPath(repo);
  const lines: string[] = [];
  lines.push(existsSync(path) ? `settings in ${path}` : `no ${path} yet — every setting is at its default`);
  lines.push("");

  const dirList = (key: ListKey, cmdName: string, meaning: string, detail: (e: string) => string | null) => {
    const list = readDirList(repo, key);
    lines.push(`${key}: ${list.length ? `${list.length} entr${list.length === 1 ? "y" : "ies"}` : "none (default)"}`);
    for (const e of list) {
      const d = detail(e);
      lines.push(`    ${e}${d ? `  — ${d}` : ""}`);
    }
    lines.push(`  ${meaning}`);
    lines.push(`  change: ${cmd(`graft config ${cmdName}`)} add|remove|clear …  ·  syntax: ${cmd(`graft config ${cmdName}`)} --help`);
    lines.push("");
  };
  dirList(
    "excludeDirs",
    "exclude-dirs",
    "Directories left out of the graph, on top of the built-in skip list. Wins over includeDirs.",
    describeExcludeEntry,
  );
  dirList(
    "includeDirs",
    "include-dirs",
    `Built-in skipped directories to index anyway (${[...SKIP_DIRS].join(", ")}).`,
    includeEntryNote,
  );

  const flag = (key: FlagKey, cmdName: string, meaning: string) => {
    const { value, set } = readFlag(repo, key);
    lines.push(`${key}: ${value ? "on" : "off"}${set ? "" : " (default)"}`);
    lines.push(`  ${meaning}`);
    lines.push(`  change: ${cmd(`graft config ${cmdName}`)} on|off`);
    lines.push("");
  };
  flag("followSubmodules", "follow-submodules", "Index initialized Git submodules into this repo's graph.");
  flag(
    "followNestedRepos",
    "follow-nested-repos",
    "Index nested Git clones this repo's index does not track (a multi-repo manifest checkout, a clone parked in the tree).",
  );
  flag(
    "indexText",
    "index-text",
    "Index plain-text files (.txt, plus indexTextExtensions), each cut into chunks with their own line spans, so a query points at the right part of a large text file. Never summarized by --deep.",
  );
  dirList(
    "indexTextDirs",
    "index-text-dirs",
    "Folders indexText takes plain-text files from, each with its subtree; none = the whole repo. No effect while indexText is off.",
    (e) => dirEntryNote("indexTextDirs", e, repo),
  );
  dirList(
    "indexTextExtensions",
    "index-text",
    "Extensions indexText also indexes as plain text, on top of .txt (.log, .out, ...); only ones graft does not parse. No effect while indexText is off.",
    textExtensionNote,
  );

  const t = resolveDeepStaleThreshold(repo, home);
  const from = { repo: "", global: " (from the global setting)", default: " (default)" }[t.source];
  lines.push(`deepStaleThreshold: ${t.value}%${from}`);
  lines.push(
    `  Share of out-of-date summaries above which queries recommend \`${cmd("graft build --deep")}\`. ` +
      `0 = as soon as anything is out of date, 100 = never; default ${DEFAULT_DEEP_STALE_THRESHOLD}.`,
  );
  lines.push(`  change: ${cmd("graft deep-threshold")} <percent> [--global]`);
  lines.push("");

  const a = resolveAutoDeep(repo, home);
  const aFrom = { repo: "", global: " (from the global setting)", default: " (default)" }[a.source];
  lines.push(`autoDeep: ${a.value ? "on" : "off"}${aFrom}`);
  lines.push(
    `  Run \`${cmd("graft build --deep")}\` by itself, in the background, once out-of-date summaries reach deepStaleThreshold. ` +
      `Each run spends AI tokens without asking.`,
  );
  lines.push(`  change: ${cmd("graft auto-deep")} on|off [--global]`);
  return lines.join("\n");
}
