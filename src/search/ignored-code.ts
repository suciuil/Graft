/**
 * Code the map leaves out because git ignores it, named when a search comes up
 * empty. A migration repo kept the old app's code in git-ignored dumps (they
 * held credentials); `trail grep` found nothing, said all indexed code was
 * searched, and the agent's own grep then found the file. After that the agent
 * stopped trusting trail for the session.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { supportedExtensions, useTextExtensions } from "../graph/source-files.js";
import { shouldSkipDir } from "../ingest/fs.js";
import { inTextScope, isPlainTextPath, plainTextExtensions } from "../util/plain-text.js";
import { readTextScope } from "../util/state.js";

/** Most entries one ignored folder's walk looks at before giving up on it. */
const WALK_CAP = 2000;

function holdsCode(dir: string, exts: Set<string>): boolean {
  const stack = [dir];
  let seen = 0;
  while (stack.length && seen < WALK_CAP) {
    const at = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > WALK_CAP) break;
      if (e.isDirectory()) {
        if (!shouldSkipDir(e.name)) stack.push(join(at, e.name));
      } else if (exts.has(extname(e.name).toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * Git-ignored folders and files under `root` holding code the map would
 * otherwise index, repo-relative, folders ending in `/`. Dependency, build and
 * dot folders are left out. Empty outside git, or when git can't say.
 */
export function ignoredCode(root: string, limit = 20): string[] {
  const r = spawnSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"], {
    cwd: root,
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return [];
  // Plain text counts only where the map would index it: with `indexText` on, and
  // under its `indexTextDirs` when it lists any. Otherwise an ignored folder of
  // logs or dumps is not code the map would index. Plain text is `.txt` plus the
  // extensions the repo added (`graft config index-text add`).
  const scope = readTextScope(root);
  useTextExtensions(scope.exts);
  const textExts = new Set(plainTextExtensions());
  const exts = new Set(supportedExtensions().filter((e) => !textExts.has(e)));
  const codeOrText = new Set([...exts, ...textExts]);
  /** The folders under an ignored entry whose plain-text files would be indexed. */
  const textUnder = (rel: string): string[] => {
    if (!scope.on) return [];
    if (inTextScope(rel, scope.dirs)) return [rel];
    return scope.dirs.filter((d) => d.startsWith(`${rel}/`));
  };
  const out: string[] = [];
  for (const entry of r.stdout.split("\n")) {
    if (!entry) continue;
    const rel = entry.replace(/\/$/, "");
    if (rel.split("/").some((p) => shouldSkipDir(p))) continue;
    let code: boolean;
    if (entry.endsWith("/")) {
      // Text counts in the whole folder: one walk for both. Otherwise only in the
      // text folders under it, walked for text alone.
      const under = textUnder(rel);
      code =
        under.length === 1 && under[0] === rel
          ? holdsCode(join(root, entry), codeOrText)
          : holdsCode(join(root, entry), exts) || under.some((d) => holdsCode(join(root, d), textExts));
    } else {
      code = exts.has(extname(entry).toLowerCase()) || (isPlainTextPath(entry) && textUnder(rel).length > 0);
    }
    if (code) out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

/** `a/, b/ and 3 more`. */
export function ignoredLabel(paths: string[], shown = 3): string {
  const head = paths.slice(0, shown).join(", ");
  return paths.length > shown ? `${head} and ${paths.length - shown} more` : head;
}
