/**
 * Where a repo's code map lives.
 *
 * In a repo on trail, `.trail/cache/`: inside the one folder a team commits,
 * and kept out of git by `.trail/.gitignore`, so neither the repo's own
 * `.gitignore` nor a root `.ignore` has to name it. Everywhere else `graft/`,
 * as before. Being a hidden folder, `.trail/cache/` is skipped by a grep from
 * the repo root; the agent reaches it through `trail ask` and the path the
 * session-start hook names, and a grep given that path searches it.
 *
 * A map still in `graft/` from before the repo moved to trail is renamed into
 * place the first time anyone asks where the map is, so a session never
 * rebuilds what's already on disk.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { repoWiredForTrail } from "../brand.js";
import { ignoreInTrailDir } from "../notes/repo-trail.js";
import { looksLikeMap, profileMapDirFor } from "./profile-store.js";

/** The map's folder in a repo on trail, relative to the repo. */
export const TRAIL_MAP_DIR = join(".trail", "cache");
/** The map's folder everywhere else. */
export const GRAFT_MAP_DIR = "graft";

/**
 * Absolute path of `root`'s code map folder. A repo is on trail once its
 * hooks say so or it has `.trail/learnings/`, which `trail init` makes before
 * anything else, so nothing it writes lands in `graft/` first.
 *
 * With the profile store on (context/profile-store.ts, the default), a repo
 * that has no map inside it yet gets one in the user's profile instead, keyed
 * by the repo's path. A map already in the repo always wins, so the store never
 * moves or hides one.
 */
export function mapDirFor(root: string): string {
  const trail = join(root, TRAIL_MAP_DIR);
  if (existsSync(trail)) return trail;
  const graft = join(root, GRAFT_MAP_DIR);
  if (!existsSync(join(root, ".trail", "learnings")) && !repoWiredForTrail(root)) {
    if (looksLikeMap(graft)) return graft;
    return profileMapDirFor(root) ?? graft;
  }
  // On trail: an old in-repo `graft/` map moves to `.trail/cache/` as before.
  // With nothing in the repo to keep, the profile store takes the map.
  if (!hasOldMap(root)) {
    const profile = profileMapDirFor(root);
    if (profile) return profile;
  }
  moveOldMap(root, trail);
  return trail;
}

/** Whether `root` holds a map in `graft/` from before the repo was on trail. */
function hasOldMap(root: string): boolean {
  const from = join(root, GRAFT_MAP_DIR);
  return existsSync(join(from, "INDEX.md")) || existsSync(join(from, ".graph"));
}

/** Whether `dir` is a repo's trail map folder, which `.trail/.gitignore` keeps out of git. */
export function isTrailMapDir(root: string, dir: string): boolean {
  return join(root, TRAIL_MAP_DIR) === join(dir);
}

/**
 * `graft/` holding a map from before the repo moved to trail: renamed to
 * `.trail/cache/`. Left alone when git tracks it (a map committed back when
 * it was shared), since moving it would delete committed files.
 */
function moveOldMap(root: string, to: string): void {
  const from = join(root, GRAFT_MAP_DIR);
  if (!hasOldMap(root)) return;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", "graft/INDEX.md"], { cwd: root, stdio: "ignore", timeout: 3000 });
    return;
  } catch {
    // untracked, or not a git checkout: ours to move
  }
  try {
    mkdirSync(join(root, ".trail"), { recursive: true });
    ignoreInTrailDir(root, "cache/");
    renameSync(from, to);
  } catch {
    // Another process moved it first, or it can't move: the next build makes a new one.
  }
}
