/**
 * The profile store: a repo's generated map and its local settings kept in the
 * user's profile instead of inside the checkout, found again from the repo's
 * path.
 *
 *   ~/.graft/repos/<folder-name>-<hash of the repo path>/
 *     repo.json      which checkout this folder belongs to (for a person browsing)
 *     graph/         what `<repo>/graft/` would hold: cards, INDEX.md, .graph/, .cache/
 *     config.json    what `<repo>/.graft/config.json` would hold
 *
 * On by default. `GRAFT_PROFILE_STORE` (`0`/`false`/`off` to turn it off,
 * `1`/`true`/`on`, or an absolute folder to use instead of `~/.graft/repos`)
 * wins over `"profileStore"` (`false`, `true` or a folder) in
 * `~/.graft/settings.json`; with neither set it is on at `~/.graft/repos`.
 *
 * It is a FALLBACK, never a move: a repo that already has its map in
 * `graft/` (or `.trail/cache/`), or its settings in `.graft/config.json`, keeps
 * using those. Only what does not exist in the repo yet goes to the profile.
 *
 * Reads `settings.json` itself rather than through `util/state.ts`, which
 * imports this module (through `map-dir.ts`) and would make a cycle.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Where the store's folders go when no other folder is named. */
export function defaultProfileStoreRoot(home: string = homedir()): string {
  return join(home, ".graft", "repos");
}

/** The map's folder inside a repo's store folder. */
export const PROFILE_MAP_DIR = "graph";
/** The settings file inside a repo's store folder. */
export const PROFILE_CONFIG_FILE = "config.json";
/** The note naming the checkout a store folder belongs to. */
export const PROFILE_REPO_NOTE = "repo.json";

const ON = new Set(["1", "true", "yes", "on"]);
const OFF = new Set(["0", "false", "no", "off"]);

/** What a setting's value says: off, on at the default root, or on at a folder. */
function readSwitch(raw: unknown, home: string): string | false | undefined {
  if (raw === true) return defaultProfileStoreRoot(home);
  if (raw === false) return false;
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (v === "") return undefined;
  if (OFF.has(v.toLowerCase())) return false;
  if (ON.has(v.toLowerCase())) return defaultProfileStoreRoot(home);
  // A folder: only an absolute one, since a relative path has nothing stable to
  // be relative to (every repo would get its own store inside itself).
  return isAbsolute(v) ? resolve(v) : undefined;
}

/**
 * The store's root folder when the profile store is on, else null.
 * `GRAFT_PROFILE_STORE` wins over the setting, both ways; with neither saying
 * anything the store is ON, at `~/.graft/repos`.
 */
export function profileStoreRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  const fromEnv = readSwitch(env.GRAFT_PROFILE_STORE, home);
  if (fromEnv !== undefined) return fromEnv || null;
  let settings: { profileStore?: unknown } | null = null;
  try {
    settings = JSON.parse(readFileSync(join(home, ".graft", "settings.json"), "utf8"));
  } catch {
    // no settings file, or an unreadable one: the default applies
  }
  const fromSettings = readSwitch(settings?.profileStore, home);
  if (fromSettings !== undefined) return fromSettings || null;
  return defaultProfileStoreRoot(home);
}

/**
 * The store root to use for `root`, or null when the store is off, or when the
 * store would sit inside the repo itself (the home folder used as a repo, with
 * the store under `~/.graft/repos`): a map nested in the repo it maps would be
 * indexed into its own graph and written next to the user's files.
 */
function storeFor(root: string, env: NodeJS.ProcessEnv, home: string): string | null {
  const store = profileStoreRoot(env, home);
  if (!store) return null;
  return isOutside(root, store) ? store : null;
}

/**
 * The repo path as the store keys it: the real path when it exists (so a
 * symlink, a junction or an 8.3 short name lands on the same folder as the
 * long name), and lower case where the file system ignores case, so `D:\Repo`
 * and `d:\repo` are one repo.
 */
export function repoKey(root: string): string {
  let p = resolve(root);
  try {
    p = realpathSync.native(p);
  } catch {
    // not there (yet): the resolved spelling is the best there is
  }
  return process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p;
}

/** The repo's own folder in the store: its name for a person, a hash of its path to be unique. */
export function profileRepoDir(root: string, storeRoot: string): string {
  const key = repoKey(root);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const name = basename(key).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40) || "repo";
  return join(storeRoot, `${name}-${hash}`);
}

/** Where `root`'s map goes in the store, or null while the store is off. */
export function profileMapDirFor(root: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  const store = storeFor(root, env, home);
  return store ? join(profileRepoDir(root, store), PROFILE_MAP_DIR) : null;
}

/** Where `root`'s settings go in the store, or null while the store is off. */
export function profileConfigPathFor(root: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  const store = storeFor(root, env, home);
  return store ? join(profileRepoDir(root, store), PROFILE_CONFIG_FILE) : null;
}

/**
 * Where `root`'s store map would be, on or off: the configured root, or the
 * default one. For readers that must find a map made while the store was on
 * (the cross-repo savings list, retraction) even after it was turned off.
 */
export function anyProfileMapDirFor(root: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const store = profileStoreRoot(env, home) ?? defaultProfileStoreRoot(home);
  return join(profileRepoDir(root, store), PROFILE_MAP_DIR);
}

/** Whether `p` is outside `root`: a sibling, a parent, or another drive. */
export function isOutside(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  // On Windows a path on another drive comes back absolute, not as `..\…`.
  return rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);
}

/**
 * Write `repo.json` into a repo's store folder, naming the checkout it belongs
 * to, so a person browsing `~/.graft/repos/` can tell the folders apart and
 * prune the ones whose repo is gone. Once per folder; best-effort.
 */
export function noteProfileRepo(root: string, repoDir: string): void {
  const file = join(repoDir, PROFILE_REPO_NOTE);
  if (existsSync(file)) return;
  try {
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ root: resolve(root), key: repoKey(root), created: new Date().toISOString() }, null, 2)}\n`, { flag: "wx" });
  } catch {
    // another process wrote it first, or the profile is read-only: nothing depends on it
  }
}

/** The store folder `dir` is the map of, when it is one (`<store>/<repo>/graph`). */
export function profileRepoDirOfMap(root: string, dir: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  const map = profileMapDirFor(root, env, home);
  return map && resolve(map) === resolve(dir) ? dirname(map) : null;
}

/** True when `dir` holds something only a graft map has. */
export function looksLikeMap(dir: string): boolean {
  return (
    existsSync(join(dir, "INDEX.md")) ||
    existsSync(join(dir, ".graph")) ||
    existsSync(join(dir, ".cache")) ||
    existsSync(join(dir, "workspace.json"))
  );
}
