/**
 * Filesystem walking used by `init`/`check` to enumerate a repo's source files.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Directories that are dependency/build output, never source. */
export const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  "__pycache__",
  "venv",
]);

/** Files above this size are generated/vendored in practice, not hand-written code. */
export const MAX_FILE_BYTES = 1_000_000;

/**
 * Whether a directory named `name` should be skipped when walking a repo tree:
 * any dot-prefixed directory (`.git`, `.github`, `.vscode`, ...) or one of
 * {@link SKIP_DIRS} not named in `includes`. The single source of truth for
 * "is this dir source" — `skippedPath` and `walkFilesystem` below and the
 * git-child discovery in `graph/scopes.ts` share it, so they can never
 * independently drift on what counts as skippable.
 *
 * `includes` is the explicit, per-repo `graft build --include-dir` override
 * (persisted via `util/state.ts`'s `readIncludeDirs`, threaded in by each
 * caller) — a name in it is removed from the effective skip set for THIS
 * repo's walks. Absent/empty ≡ today's default behavior. It lifts only
 * graft's own skip list: in a Git repo, Git's ignore rules stay authoritative
 * (see {@link walkDir}).
 *
 * `excludes` is its mirror image, `graft build --exclude-dir` (persisted via
 * `readExcludeDirs`): names skipped ON TOP of SKIP_DIRS, for the vendored
 * asset trees and generated folders that are real source to Git but noise in a
 * graph. It is tested FIRST because it must beat `includes`: an exclusion names
 * this repo specifically, while an inclusion only lifts a built-in default, so
 * the more specific instruction wins rather than the order of two flags.
 *
 * KNOWN LIMITATION: a dot-directory is skipped WHOLESALE and is NEVER
 * overridable, even via `includes` — unlike `SKIP_DIRS`, there is no path to
 * un-skip one. A repo that keeps real, hand-written source under a
 * dot-prefixed directory is out of scope.
 */
export function shouldSkipDir(
  name: string,
  includes?: ReadonlySet<string>,
  excludes?: ReadonlySet<string>,
): boolean {
  if (name.startsWith(".")) return true;
  if (excludes?.has(name)) return true;
  if (includes?.has(name)) return false;
  return SKIP_DIRS.has(name);
}

/**
 * Recursively list all files under a directory. Skips dot-directories,
 * dependency/build directories (node_modules, dist, …) not named in
 * `includes`, and files over 1 MB.
 * In a Git worktree, tracked files plus untracked, non-ignored files come from
 * `git ls-files`; this gives indexing exactly Git's nested `.gitignore`,
 * negation, and global-exclude semantics. Initialized submodules are enumerated
 * recursively only when `followSubmodules` is true; the default preserves the
 * historical superproject boundary. Each child keeps its own ignore rules, and
 * uninitialized submodules remain absent. Non-Git directories retain the plain
 * filesystem walk. `includes` lifts only the built-in skip list — it never
 * overrides Git's ignore rules (un-ignore or `git add -f` a directory to
 * index it, the same contract as tracked-but-ignored files).
 */
export interface WalkOptions {
  /** Include initialized Git submodules recursively. Default false. */
  followSubmodules?: boolean;
  /** Directory names to skip on top of SKIP_DIRS — the persisted
   * `--exclude-dir` list. Beats `includes`; see {@link shouldSkipDir}. Unlike
   * `includes`, this one DOES bite in a Git repo: it removes files Git happily
   * reports, which is the whole point of asking for them to be excluded. */
  excludes?: ReadonlySet<string>;
}

export function walkDir(
  dir: string,
  includes?: ReadonlySet<string>,
  opts: WalkOptions = {},
): string[] {
  const filter: DirFilter = { includes, excludes: partitionExcludes(opts.excludes) };
  return gitVisibleFiles(dir, filter, opts.followSubmodules === true) ?? walkFilesystem(dir, filter);
}

/** The per-repo directory overrides, carried together because every layer of
 * the walk needs all of them to answer "is this dir source". */
interface DirFilter {
  includes?: ReadonlySet<string>;
  excludes: Excludes;
}

/**
 * `--exclude-dir` accepts two shapes, and they mean different things.
 *
 * A BARE NAME (`themes`) matches that segment at any depth, like SKIP_DIRS — the
 * right tool for a name that is noise wherever it appears (a vendored `Charts`
 * copied into six places, say).
 *
 * A RELATIVE PATH (`src/themes`) matches only that directory and its subtree,
 * anchored at the repo root. The two are not interchangeable: excluding every
 * `themes/` in a tree is a far larger claim than excluding one, and a user who
 * means the second should not have to accept the first.
 *
 * A GLOB (`src/themes*`, `src/themes/*`, `*src/themes`) is a path with wildcards,
 * matched against the same root-relative path. `*` and `?` stop at a separator and
 * a doubled `*` crosses them, the convention every ignore file already uses.
 */
interface Excludes {
  /** Bare names: matched per path segment, at any depth. */
  names: ReadonlySet<string>;
  /** Root-relative paths, normalised to forward slashes with no trailing slash. */
  paths: readonly string[];
  /** Root-relative glob patterns, compiled once per build. */
  globs: readonly RegExp[];
}

/**
 * Compile a glob to an anchored RegExp over a root-relative path.
 *
 * Everything is escaped except the wildcards, so a directory called `c++` or
 * `a.b` cannot smuggle regex syntax in. `**` is consumed before `*` because the
 * two differ only in whether they cross a separator, and matching `*` first
 * would silently turn every `**` into two single-segment wildcards.
 */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + out + "$");
}

/** Whether an entry carries glob syntax at all. */
function isGlob(value: string): boolean {
  return value.includes("*") || value.includes("?");
}

/** Normalise one user-supplied exclude entry, so either separator and any
 * leading `./` or `/` a hand-edited config might carry resolve to the same
 * thing. Returns "" for an entry that normalises away to nothing. */
export function normalizeExcludeEntry(entry: string): string {
  return entry
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/** Split a raw exclude list into the two matching modes above. */
function partitionExcludes(raw?: ReadonlySet<string>): Excludes {
  const names = new Set<string>();
  const paths: string[] = [];
  const globs: RegExp[] = [];
  for (const entry of raw ?? []) {
    const value = normalizeExcludeEntry(entry);
    if (!value) continue;
    if (isGlob(value)) globs.push(globToRegExp(value));
    else if (value.includes("/")) paths.push(value);
    else names.add(value);
  }
  return { names, paths, globs };
}

/**
 * Whether a root-relative path is, or sits under, a path- or glob-form exclusion.
 *
 * Every ancestor prefix is tested, not just the path itself, which is what gives
 * both forms their subtree semantics: `src/themes` excludes `src/themes/dark/a.ts`
 * because the prefix `src/themes` matches. Doing it by prefix rather than by
 * `startsWith` also makes globs behave: `src/*` should swallow `src/a/b.ts`, and a
 * raw `startsWith` test against a wildcard pattern could never see that.
 */
function underExcludedPath(rel: string, excludes: Excludes): boolean {
  if (excludes.paths.length === 0 && excludes.globs.length === 0) return false;
  const value = normalizeExcludeEntry(rel);
  if (!value) return false;
  const segments = value.split("/");
  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join("/");
    if (excludes.paths.includes(prefix)) return true;
    if (excludes.globs.some((re) => re.test(prefix))) return true;
  }
  return false;
}

/** Git's canonical working-tree file set, relative to `dir`. Tracked files are
 * deliberately included even when a later ignore rule matches them; `.gitignore`
 * only controls untracked files in Git, and graft follows the same contract. */
function gitVisibleFiles(
  dir: string,
  filter: DirFilter,
  followSubmodules = false,
  traversal?: { topRoot: string; activeRoots: Set<string> },
): string[] | null {
  const root = resolve(dir);
  if (!followSubmodules) return gitVisibleFilesShallow(root, filter);

  const state = traversal ?? { topRoot: root, activeRoots: new Set<string>() };
  const rootKey = process.platform === "win32" ? root.toLowerCase() : root;
  if (state.activeRoots.has(rootKey)) return [];
  state.activeRoots.add(rootKey);

  // Following uses `-t --stage` so one process can distinguish gitlinks from
  // tracked and untracked files. `-z` keeps either form safe for unusual paths.
  const result = spawnSync(
    "git",
    ["ls-files", "-t", "--stage", "--cached", "--others", "--exclude-standard", "-z", "--"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || result.error || typeof result.stdout !== "string") {
    state.activeRoots.delete(rootKey);
    return null;
  }

  // A path can have multiple stage records during a merge. Collapse those
  // records and remember if any of them identifies the path as a gitlink.
  const entries = new Map<string, { gitlink: boolean }>();
  for (const record of result.stdout.split("\0")) {
    if (!record) continue;
    if (record.length < 2 || record[1] !== " ") continue;

    const tag = record[0];
    const body = record.slice(2);
    let rel: string;
    let gitlink = false;
    if (tag === "?") {
      rel = body;
    } else {
      const tab = body.indexOf("\t");
      if (tab === -1) continue;
      gitlink = body.startsWith("160000 ");
      rel = body.slice(tab + 1);
    }
    if (!rel) continue;
    const prior = entries.get(rel);
    entries.set(rel, { gitlink: gitlink || prior?.gitlink === true });
  }

  const out = new Set<string>();
  for (const [rel, entry] of entries) {
    const abs = resolve(root, rel);
    // Filter against the original superproject path. Otherwise a submodule
    // mounted at vendor/ or build/ would bypass the parent's skip policy when
    // recursion resets its relative root.
    if (skippedPath(relative(state.topRoot, abs), filter)) continue;

    if (entry.gitlink) {
      // A deinitialized gitlink can resolve upward to the superproject when Git
      // runs inside it. Requiring the child's own .git prevents duplicate,
      // mis-prefixed parent files and recursive loops.
      if (!existsSync(join(abs, ".git"))) continue;
      let childFiles = gitVisibleFiles(abs, filter, true, state);
      if (childFiles === null) {
        // Do not let one broken child recreate a "healthy but incomplete"
        // graph. Match the top-level fail-soft contract locally: fall back to
        // the filesystem for this child only, preserving the parent repo's Git
        // visibility and every built-in skip/size guard. Child Git ignore rules
        // are unavailable in this exceptional path, just as they are when the
        // top-level Git command fails and walkDir uses its filesystem fallback.
        // Let an unreadable filesystem fallback surface rather than claiming a
        // healthy graph that silently omitted the child again.
        childFiles = walkFilesystem(abs, filter);
      }
      for (const file of childFiles) out.add(file);
      continue;
    }

    try {
      const stat = lstatSync(abs);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    } catch {
      // A tracked file deleted from the working tree is still printed by
      // `--cached`; absence means it is not part of the current source set.
      continue;
    }
    out.add(abs);
  }

  state.activeRoots.delete(rootKey);
  return [...out].sort();
}

/** The historical, non-recursive Git path. Kept separate so the default does
 * exactly the same command, filtering, ordering, and duplicate handling as it
 * did before submodule support existed. */
function gitVisibleFilesShallow(root: string, filter: DirFilter): string[] | null {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || result.error || typeof result.stdout !== "string") return null;

  const out: string[] = [];
  for (const rel of result.stdout.split("\0")) {
    if (!rel || skippedPath(rel, filter)) continue;
    const abs = resolve(root, rel);
    try {
      const stat = lstatSync(abs);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    } catch {
      // A tracked file deleted from the working tree is still printed by
      // `--cached`; absence means it is not part of the current source set.
      continue;
    }
    out.push(abs);
  }
  return out;
}

/** A path (root-relative, either separator) is skipped when it sits under a
 * path-form exclusion, or when any of its segments is a skippable directory
 * name — the final segment doubles as the dot-FILE check (`.eslintrc.js` and
 * friends are not source either). */
function skippedPath(path: string, filter: DirFilter): boolean {
  if (underExcludedPath(path, filter.excludes)) return true;
  return path
    .replace(/\\/g, "/")
    .split("/")
    .some((segment) => shouldSkipDir(segment, filter.includes, filter.excludes.names));
}

/** `rel` is the path of `dir` relative to the walk root ("" at the root),
 * threaded down so a path-form exclusion has something to match against. The
 * git walker gets the same value for free out of `git ls-files`. */
function walkFilesystem(dir: string, filter: DirFilter, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const childRel = rel ? rel + "/" + entry.name : entry.name;
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name, filter.includes, filter.excludes.names)) continue;
      if (underExcludedPath(childRel, filter.excludes)) continue;
      out.push(...walkFilesystem(full, filter, childRel));
    } else if (entry.isFile()) {
      if (entry.name.startsWith(".")) continue; // dot-files are not source either
      // Files, not just directories: a glob like `src/themes/*` names the entries
      // inside a directory rather than the directory itself, so pruning the walk
      // alone would let every file directly under it through. The Git walker runs
      // skippedPath over every path it lists, and the two must not disagree.
      if (underExcludedPath(childRel, filter.excludes)) continue;
      try {
        if (statSync(full).size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }
      out.push(full);
    }
  }
  return out;
}
