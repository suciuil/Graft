/**
 * Why a build found no files to index, and what the user can do about it.
 *
 * A build that finds nothing used to print `✓ wiring: 0 nodes`, `parsed: 0 of 0
 * files` and exit as if it had worked. That reads as "graft is broken", not "your
 * folder is hidden from graft". Usually the folder sits inside a git repository
 * that ignores it: graft lists files the way git does (`walkDir`), so git returns
 * an empty list, exits 0, and graft takes that as the full answer.
 *
 * This runs only after a build found zero files, so the extra git calls and the
 * second filesystem walk cost nothing on a normal build.
 */
import { spawnSync } from "node:child_process";
import { extname, isAbsolute, join, resolve } from "node:path";
import { cmd } from "../brand.js";
import { SKIP_DIRS, walkDir, walkDirIgnoringGit } from "../ingest/fs.js";
import { relPosix } from "../util/paths.js";
import { readExcludeDirs, readFollowNestedRepos, readFollowSubmodules, readIncludeDirs } from "../util/state.js";
import { listSourceFiles } from "./source-files.js";

/** One git ignore rule, as `git check-ignore -v` reports it. */
export interface IgnoreRule {
  /** The pattern as written, e.g. `sub/` or `*.py`. */
  pattern: string;
  /** The file the pattern is in, resolved to an absolute path where git gave a
   * repo-relative one; with its line number. */
  source: string;
  line: number;
}

export type EmptyBuildCause =
  /** The folder itself is git-ignored by the repository that contains it. */
  | { kind: "ignored-by-enclosing-repo"; repoRoot: string; rule: IgnoreRule | null }
  /** Inside a git repo, there are files on disk, but git ignore rules hide every one of them. */
  | { kind: "hidden-by-gitignore"; repoRoot: string; hidden: number; example: string; rule: IgnoreRule | null }
  /** There are source files, but none under the `--only-dir` paths. */
  | { kind: "only-dir"; onlyDirs: string[]; sourceFiles: number }
  /** There are files, but no parser claims any of them (spreadsheets, PDFs, ...). */
  | { kind: "no-supported-files"; files: number; extensions: Array<[string, number]> }
  /** Nothing to see: an empty folder, or everything is in skipped folders or over the size cap. */
  | { kind: "empty"; repoRoot: string | null };

/** `git rev-parse --show-toplevel` from `dir`, or null outside a repo (or when git can't run). */
function gitTopLevel(dir: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0 || r.error || typeof r.stdout !== "string") return null;
  const top = r.stdout.trim();
  return top ? resolve(top) : null;
}

/**
 * Whether git ignores `path` (relative to `dir`). Returns the rule that ignores
 * it, `null` when it is ignored but git printed no rule we could read, and
 * `undefined` when it is not ignored (or git could not answer).
 */
export function ignoringRule(dir: string, path: string, repoRoot: string): IgnoreRule | null | undefined {
  const r = spawnSync("git", ["check-ignore", "-v", "--", path], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  // 0 = ignored, 1 = not ignored, anything else = git could not say.
  if (r.status !== 0 || r.error || typeof r.stdout !== "string") return undefined;
  // `<source>:<line>:<pattern>\t<path>`. The source may itself contain a colon
  // (a Windows drive letter, never followed by digits and a colon), and so may
  // the pattern, so take the FIRST `:<digits>:` as the separator.
  const head = r.stdout.split("\t")[0]?.trim() ?? "";
  const m = /^(.*?):(\d+):(.*)$/.exec(head);
  if (!m) return null;
  const [, src, line, pattern] = m;
  // In-tree .gitignore files and .git/info/exclude come back repo-relative;
  // core.excludesFile comes back absolute.
  const source = isAbsolute(src) ? resolve(src) : resolve(join(repoRoot, src));
  return { pattern, source, line: Number(line) };
}

/** The most common extensions among `files`, for "here is what we did find". */
function topExtensions(files: string[], limit = 5): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const f of files) {
    const ext = extname(f).toLowerCase() || "(no extension)";
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

/**
 * Work out why a build of `root` found no files. `outDir` is the map folder (its
 * own files never count as source); `onlyDirs` is the build's `--only-dir` list.
 * Returns null when files ARE there to index, so the caller has nothing to explain.
 */
export function diagnoseEmptyBuild(
  root: string,
  outDir: string,
  onlyDirs?: readonly string[],
): EmptyBuildCause | null {
  const abs = resolve(root);
  const includes = readIncludeDirs(abs);
  const excludes = readExcludeDirs(abs);
  const notMap = (f: string) => !f.startsWith(outDir);

  const visible = walkDir(abs, includes, {
    followSubmodules: readFollowSubmodules(abs),
    followNestedRepos: readFollowNestedRepos(abs),
    excludes,
  }).filter(notMap);

  if (visible.length > 0) {
    const source = listSourceFiles(abs, outDir, visible);
    if (source.length === 0) {
      return { kind: "no-supported-files", files: visible.length, extensions: topExtensions(visible) };
    }
    if (onlyDirs && onlyDirs.length > 0) {
      const under = source.filter((f) => {
        const rel = relPosix(abs, f);
        return onlyDirs.some((d) => rel === d || rel.startsWith(`${d}/`));
      });
      if (under.length === 0) return { kind: "only-dir", onlyDirs: [...onlyDirs], sourceFiles: source.length };
    }
    return null;
  }

  const repoRoot = gitTopLevel(abs);
  if (repoRoot) {
    // The folder itself ignored (`sub/` in a parent's .gitignore). Git's own
    // top level can never be ignored, so this only fires for a folder inside it.
    const folderRule = ignoringRule(abs, ".", repoRoot);
    if (folderRule !== undefined) return { kind: "ignored-by-enclosing-repo", repoRoot, rule: folderRule };

    // The folder is visible, but every file in it is ignored (`*`, `*.py`, ...).
    const onDisk = walkDirIgnoringGit(abs, includes, excludes).filter(notMap);
    if (onDisk.length > 0) {
      const sourceOnDisk = listSourceFiles(abs, outDir, onDisk);
      const example = relPosix(abs, (sourceOnDisk[0] ?? onDisk[0]) as string);
      return {
        kind: "hidden-by-gitignore",
        repoRoot,
        hidden: onDisk.length,
        example,
        rule: ignoringRule(abs, example, repoRoot) ?? null,
      };
    }
  }
  return { kind: "empty", repoRoot };
}

function ruleLine(rule: IgnoreRule | null): string {
  return rule ? `\`${rule.pattern}\` (${rule.source}, line ${rule.line})` : "(git did not report which rule)";
}

/**
 * The warning for `cause`, one string per line. `rerun` is the build command the
 * user ran (`graft build` or `graft build --deep`), so the fix ends with the
 * exact command to run next.
 */
export function formatEmptyBuild(cause: EmptyBuildCause, root: string, rerun: string): string[] {
  const again = `\`${cmd(rerun)}\``;
  switch (cause.kind) {
    case "ignored-by-enclosing-repo":
      return [
        `⚠ nothing was indexed: this folder is git-ignored by the repository it is inside.`,
        `  folder:         ${resolve(root)}`,
        `  enclosing repo: ${cause.repoRoot}`,
        `  ignored by:     ${ruleLine(cause.rule)}`,
        `  graft lists files the way git does, so git hides every file in an ignored folder from graft.`,
        `  Fix it in one of these ways, then run ${again} again:`,
        `    • make this folder a repository of its own: run \`git init\` in it;`,
        `    • or delete that ignore rule (or add a \`!\` rule that un-ignores this folder) in the enclosing repo.`,
      ];
    case "hidden-by-gitignore":
      return [
        `⚠ nothing was indexed: git ignore rules hide all ${cause.hidden} file(s) in this folder.`,
        `  repo:       ${cause.repoRoot}`,
        `  example:    ${cause.example} is ignored by ${ruleLine(cause.rule)}`,
        `  graft indexes only the files git shows: tracked files, and untracked files no rule ignores.`,
        `  Fix it in one of these ways, then run ${again} again:`,
        `    • delete or narrow that ignore rule;`,
        `    • or track the files anyway: \`git add -f <files>\`.`,
      ];
    case "only-dir":
      return [
        `⚠ nothing was indexed: the folder has ${cause.sourceFiles} source file(s), but none under --only-dir ${cause.onlyDirs.join(", ")}.`,
        `  --only-dir takes paths relative to ${resolve(root)}: check the spelling, or leave --only-dir out.`,
      ];
    case "no-supported-files":
      return [
        `⚠ nothing was indexed: found ${cause.files} file(s), but none in a language graft can parse.`,
        `  most common here: ${cause.extensions.map(([e, n]) => `${e} (${n})`).join(", ")}`,
        `  \`${cmd("graft languages")}\` lists what graft parses. Binary documents (spreadsheets, PDFs, Word files) are not indexed.`,
      ];
    case "empty":
      return [
        `⚠ nothing was indexed: there are no files here graft would read.`,
        `  folder: ${resolve(root)}${cause.repoRoot ? ` (in the git repo ${cause.repoRoot})` : ""}`,
        `  graft skips dot-folders, ${[...SKIP_DIRS].slice(0, 6).join(", ")}, … and files over 1 MB.`,
        `  Check that you ran it in the right folder; \`${cmd("graft build --include-dir <name>")}\` indexes a skipped folder.`,
      ];
  }
}
