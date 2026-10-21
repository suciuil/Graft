/**
 * `graft config`: list and edit the per-repo settings in `.graft/config.json`
 * without hand-editing JSON. Pure functions over the repo dir; the commander
 * wiring lives in cli.ts and the prose in cli-help-graft.ts.
 *
 * The validation here is the same `graft build --include-dir/--exclude-dir`
 * applies, so a value accepted by one is accepted by the other.
 */
import { existsSync } from "node:fs";
import { cmd } from "./brand.js";
import { SKIP_DIRS, normalizeExcludeEntry } from "./ingest/fs.js";
import {
  DEFAULT_DEEP_STALE_THRESHOLD,
  buildConfigPath,
  patchBuildConfig,
  readBuildConfig,
  resolveDeepStaleThreshold,
} from "./util/state.js";

export type DirListKey = "excludeDirs" | "includeDirs";
export type FlagKey = "followSubmodules" | "followNestedRepos";

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

/** The stored form of an entry: excludes are normalised (`\` → `/`, no leading
 * `./`, no trailing `/`); include names are stored as given. */
export function normalizeDirEntry(key: DirListKey, entry: string): string {
  return key === "excludeDirs" ? normalizeExcludeEntry(entry) : entry.trim();
}

export function dirProblem(key: DirListKey, entry: string): string | null {
  return key === "excludeDirs" ? excludeDirProblem(entry) : includeDirProblem(entry);
}

export function readDirList(repo: string, key: DirListKey): string[] {
  const v = readBuildConfig(repo)?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Add entries not already present, in order. Never writes when nothing is new. */
export function addDirEntries(repo: string, key: DirListKey, entries: string[]): { added: string[]; present: string[] } {
  const list = readDirList(repo, key);
  const added: string[] = [];
  const present: string[] = [];
  for (const raw of entries) {
    const value = normalizeDirEntry(key, raw);
    if (list.includes(value) || added.includes(value)) present.push(value);
    else added.push(value);
  }
  if (added.length) patchBuildConfig(repo, { [key]: [...list, ...added] });
  return { added, present };
}

/** Remove entries, compared in their stored form. Never writes when nothing matched. */
export function removeDirEntries(repo: string, key: DirListKey, entries: string[]): { removed: string[]; missing: string[] } {
  const list = readDirList(repo, key);
  const wanted = entries.map((e) => normalizeDirEntry(key, e));
  const removed = list.filter((v) => wanted.includes(v));
  const missing = wanted.filter((v) => !list.includes(v));
  if (removed.length) patchBuildConfig(repo, { [key]: list.filter((v) => !wanted.includes(v)) });
  return { removed, missing };
}

export function clearDirEntries(repo: string, key: DirListKey): string[] {
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

  const dirList = (key: DirListKey, cmdName: string, meaning: string, detail: (e: string) => string | null) => {
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

  const t = resolveDeepStaleThreshold(repo, home);
  const from = { repo: "", global: " (from the global setting)", default: " (default)" }[t.source];
  lines.push(`deepStaleThreshold: ${t.value}%${from}`);
  lines.push(
    `  Share of out-of-date summaries above which queries recommend \`${cmd("graft build --deep")}\`. ` +
      `0 = as soon as anything is out of date, 100 = never; default ${DEFAULT_DEEP_STALE_THRESHOLD}.`,
  );
  lines.push(`  change: ${cmd("graft deep-threshold")} <percent> [--global]`);
  return lines.join("\n");
}
