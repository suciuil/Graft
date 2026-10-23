/**
 * The `graft/.cache/` sidecar state: the statusline's stats snapshot and the
 * build lock that serializes rebuilds.
 *
 * Lives in `util/` rather than `claude/` because two very different callers need
 * it: the Claude Code hooks (which flip `dirty` on an edit and clear it after a
 * background sync) and the graph's own pre-query auto-refresh
 * (`graph/refresh.ts`), which must take the same lock so the two never rebuild
 * on top of each other. `claude/state.ts` re-exports all of this, so nothing
 * outside had to change when it moved.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, openSync, writeSync, closeSync, fchmodSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join, dirname, isAbsolute } from 'node:path';
import { mapDirFor } from '../context/map-dir.js';
import { renameReplacing } from './rename-replacing.js';
import { isOutside, noteProfileRepo, profileConfigPathFor } from '../context/profile-store.js';

export interface Stats {
  nodeCount: number; edgeCount: number; languages: string[];
  totalCount: number; readyCount: number;
  staleCount: number; dirty: boolean; syncing: boolean;
  syncedAt: string | null; lastFile: string | null;
}

export const LOCK_STALE_MS = 300000;

export function emptyStats(): Stats {
  return { nodeCount: 0, edgeCount: 0, languages: [], totalCount: 0, readyCount: 0,
    staleCount: 0, dirty: false, syncing: false, syncedAt: null, lastFile: null };
}

const LOCK_FILE = '.sync.lock';

/**
 * Where the pieces this module manages (the stats cache, the sync lock,
 * per-session state, the upkeep stamp) actually live when no caller-supplied
 * override is available. The Claude Code hooks, `sync-run`, the statusline,
 * and `upkeep` all resolve a bare project dir and never see an explicit
 * `--dir` — unlike a direct CLI invocation, which threads one through
 * `contextDirFor` (`context/node-file.ts`). This mirrors that same override
 * precedence for those entry points: `GRAFT_DIR` wins over the default
 * `<projectDir>/graft`, the same env var `resolveConfig` already honors for
 * the `--deep` LLM path. A relative `GRAFT_DIR` resolves against `projectDir`
 * so it holds regardless of the caller's cwd.
 */
export function resolveContextDir(projectDir: string): string {
  const override = process.env.GRAFT_DIR;
  if (!override) return mapDirFor(projectDir);
  return isAbsolute(override) ? override : join(projectDir, override);
}

export function cacheDir(projectDir: string): string { return join(resolveContextDir(projectDir), '.cache'); }
function statsPath(d: string): string { return join(cacheDir(d), 'stats.json'); }

export function readJson<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return null; }
}
/**
 * Write JSON to `p` via a scratch file and a rename, so a concurrent reader sees
 * either the whole old file or the whole new one — never a truncated prefix. The
 * pid in the temp name keeps two concurrent writers off each other's scratch file.
 *
 * `compact` drops the indentation, for the caches only a machine ever opens —
 * it's ~30% of the bytes on a big, deep object.
 *
 * A failed write takes its scratch file with it. Every CLI invocation is a new pid,
 * so the names never collide and never get reused: leaving them behind means a repo
 * that fails this write repeatedly (ENOSPC, or a Windows indexer holding the target
 * open) accumulates one full-size file per attempt, and nothing in graft ever lists
 * `.cache/` to clean them up.
 */
export function writeJsonAtomic(p: string, value: unknown, compact = false, mode?: number): void {
  mkdirSync(dirname(p), { recursive: true });
  // A name no one can guess, opened new-only and never through a link: a link
  // planted where the temp file goes is neither written through nor renamed
  // into place (D85).
  const tmp = `${p}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    // `mode` applies to the new file before it's renamed into place, so a
    // secret is never readable by others even for a moment.
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode ?? 0o666);
    try {
      if (mode !== undefined && process.platform !== 'win32') fchmodSync(fd, mode);
      const buf = Buffer.from(compact ? JSON.stringify(value) : JSON.stringify(value, null, 2), 'utf8');
      for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off, buf.length - off);
    } finally {
      closeSync(fd);
    }
    // Retried on Windows while a scanner briefly holds the target (see rename-replacing.ts).
    renameReplacing(tmp, p);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing more we can do */ }
    throw e;
  }
}

export function readStats(d: string): Stats | null { return readJson<Stats>(statsPath(d)); }
export function writeStats(d: string, s: Stats): void { writeJsonAtomic(statsPath(d), s); }

/**
 * Persisted per-repo build configuration. Explicit CLI choices live here so
 * later no-flag builds and automatic refreshes enumerate the same file set.
 * Missing fields always retain backwards-compatible defaults.
 */
export interface BuildConfig {
  /** SKIP_DIRS names to include in this repo's walks, persisted so a LATER
   * no-flag build — and the fingerprint/refresh path, which never sees CLI
   * flags at all — behave identically to the invocation that set it. */
  includeDirs?: string[];
  /** Directory names to drop from this repo's walks, on top of SKIP_DIRS —
   * persisted for the same reason `includeDirs` is. Bare names matched per path
   * segment at any depth, so `"Documents"` skips every `Documents/` in the tree.
   * Takes precedence over {@link includeDirs}: an exclusion is a deliberate
   * statement about this repo, while an inclusion only lifts a built-in default. */
  excludeDirs?: string[];
  /** Whether initialized Git submodules (gitlinks) are folded into this repo's
   * graph. Absent/false keeps the historical boundary at the superproject. */
  followSubmodules?: boolean;
  /** Whether nested Git clones the index does not track — how manifest-driven
   * multi-repo tools check dependencies out, and how an ad-hoc local clone lands
   * in the tree — are folded into this repo's graph. Deliberately SEPARATE from
   * `followSubmodules`: a submodule is a dependency the parent pins, a nested
   * clone is invisible to the parent's index and may equally be a scratch
   * checkout someone parked in the tree. Absent/false keeps the historical
   * boundary. */
  followNestedRepos?: boolean;
  /** Percent (0–100) of node summaries that must be out of date — the code
   * changed, or is new, since the last `graft build --deep` — before queries
   * carry the `--deep` nudge. 0 = anything out of date; 100 = never. Set by
   * `graft deep-threshold`; absent or out of range falls through to the global
   * {@link GlobalSettings.deepStaleThreshold}, then to
   * {@link DEFAULT_DEEP_STALE_THRESHOLD}. */
  deepStaleThreshold?: number;
}

/** Local, Git-ignored repository configuration. Kept outside generated
 * `graft/` output so deleting/replacing that cache, workspace federation, and
 * custom `--dir` builds cannot erase or redirect the persisted choice. */
export const BUILD_CONFIG_DIR = '.graft';

/** `<repo>/.graft/config.json`, where the settings have always lived. */
export function repoBuildConfigPath(d: string): string { return join(d, BUILD_CONFIG_DIR, 'config.json'); }

/**
 * Where repo `d`'s settings are read from and written to: `.graft/config.json`
 * in the repo when that file exists, or when the profile store is off (the
 * historical place). With the store on and no file in the repo, the repo's
 * folder in the profile store (context/profile-store.ts), so the repo is never
 * written to.
 */
export function buildConfigPath(d: string): string {
  const inRepo = repoBuildConfigPath(d);
  if (existsSync(inRepo)) return inRepo;
  return profileConfigPathFor(d) ?? inRepo;
}

/** Keep local build configuration out of Git without coupling it to the
 * generated graph directory. Best-effort, matching graph-cache ignore setup.
 * Nothing to do when the settings live in the profile store, outside the repo. */
function ensureBuildConfigIgnored(d: string): void {
  if (isOutside(d, buildConfigPath(d))) return;
  const noGitignore = process.env.GRAFT_NO_GITIGNORE;
  if (noGitignore && noGitignore !== '0' && noGitignore !== 'false') return;
  const path = join(d, '.gitignore');
  let current = '';
  try { current = readFileSync(path, 'utf8'); } catch { /* no .gitignore yet */ }
  const present = current.split('\n').some((line) => {
    const value = line.trim();
    return value === BUILD_CONFIG_DIR || value === `${BUILD_CONFIG_DIR}/` || value === `/${BUILD_CONFIG_DIR}/`;
  });
  if (present) return;
  const gap = current === '' ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  const block = `${gap}# graft's local repository settings — not committed.\n/${BUILD_CONFIG_DIR}/\n`;
  try { writeFileSync(path, current + block); } catch { /* best-effort */ }
}

/**
 * Every build option at its default, written by `graft init` so the file is
 * discoverable rather than folklore — JSON has no comments and the options are
 * otherwise only visible in `graft build --help`.
 *
 * Typed `Required<...>` deliberately: adding a field to {@link BuildConfig}
 * without adding it here is a compile error, so the scaffold cannot silently fall
 * behind the options it claims to list.
 *
 * `deepStaleThreshold` is the one exclusion: a repo value overrides the global
 * one (`~/.graft/settings.json`), so scaffolding the default into every repo
 * would make `graft deep-threshold --global` a no-op everywhere `init` ran.
 */
const DEFAULT_BUILD_CONFIG: Required<Omit<BuildConfig, 'deepStaleThreshold'>> = {
  includeDirs: [],
  excludeDirs: [],
  followSubmodules: false,
  followNestedRepos: false,
};

/** One-line orientation, since a JSON file cannot carry a comment. Read back as
 * an unknown key and preserved by {@link patchBuildConfig}, which spreads it. */
const BUILD_CONFIG_NOTE =
  "graft repository settings — `graft config list` shows them and what they do; `graft config --help` lists the " +
  "commands that change them. excludeDirs takes a NAME (themes), " +
  "a root-relative PATH (src/themes), or a glob (src/themes*, src/themes/*, *src/themes). " +
  "To have saved tokens priced in $, pass --agent-model <your model id> on graft calls: " +
  "a model named per call cannot go stale the way a value pinned in this file would.";

/**
 * The config `ensureDefaultBuildConfig` would write for repo `d`, or null when
 * the file is already complete. The single source of truth for "would init
 * touch this file?", so the real run and `--dry-run` cannot disagree.
 *
 * A top-up only ever ADDS absent keys and refreshes the `//` note; a value the
 * user set is spread in last and never rewritten.
 */
function pendingBuildConfig(d: string): Record<string, unknown> | null {
  const existing = readBuildConfig(d);
  if (!existing) return { "//": BUILD_CONFIG_NOTE, ...DEFAULT_BUILD_CONFIG };
  const complete = Object.keys(DEFAULT_BUILD_CONFIG).every((k) => k in existing);
  if (complete && (existing as Record<string, unknown>)["//"] === BUILD_CONFIG_NOTE) return null;
  return { ...DEFAULT_BUILD_CONFIG, ...existing, "//": BUILD_CONFIG_NOTE };
}

/**
 * Scaffold `.graft/config.json` with every option at its default, or top up an
 * existing one with the options it predates. Returns the path when it wrote,
 * null when the file was already complete.
 *
 * The top-up only ever adds keys and refreshes the note; a value the user set is
 * spread in last and never rewritten. A stale `model` key left over from an
 * older graft is therefore preserved on disk but ignored by every code path —
 * harmless, and cheaper than rewriting a file the user owns.
 */
export function ensureDefaultBuildConfig(d: string): string | null {
  const next = pendingBuildConfig(d);
  if (!next) return null;
  const path = buildConfigPath(d);
  ensureBuildConfigIgnored(d);
  writeJsonAtomic(path, next);
  if (isOutside(d, path)) noteProfileRepo(d, dirname(path));
  return path;
}

/** The config path `graft init` would write for repo `d` — creating it, or
 * topping up one that predates an option — or null when the file is already
 * complete. Lets `--dry-run` report exactly what the real run would write
 * without duplicating the rule. */
export function missingBuildConfigPath(d: string): string | null {
  return pendingBuildConfig(d) ? buildConfigPath(d) : null;
}

export function readBuildConfig(d: string): BuildConfig | null { return readJson<BuildConfig>(buildConfigPath(d)); }
export function writeBuildConfig(d: string, c: BuildConfig): void {
  ensureBuildConfigIgnored(d);
  const path = buildConfigPath(d);
  writeJsonAtomic(path, c);
  if (isOutside(d, path)) noteProfileRepo(d, dirname(path));
}

/** Merge explicit CLI choices into the existing local config, so updating one
 * persisted build option cannot erase another. */
export function patchBuildConfig(d: string, patch: BuildConfig): void {
  writeBuildConfig(d, { ...(readBuildConfig(d) ?? {}), ...patch });
}

/** The persisted `--include-dir` override for repo `d`, as a Set — `undefined`
 * when nothing was ever persisted (or the persisted list is empty), which every
 * `shouldSkipDir`/`walkDir` caller treats as "today's default behavior". Shared
 * by every walkDir-driven entry point (source-files.ts, scopes.ts) so a build,
 * a later no-flag rebuild, and the hooks/refresh path all agree. */
export function readIncludeDirs(d: string): Set<string> | undefined {
  const dirs = readBuildConfig(d)?.includeDirs;
  return dirs && dirs.length ? new Set(dirs) : undefined;
}

/** The persisted `--exclude-dir` list for repo `d`, as a Set — `undefined` when
 * nothing was persisted (or the list is empty). Read at every walkDir call site
 * alongside {@link readIncludeDirs}, so a build, a later no-flag rebuild and the
 * hooks/refresh path all enumerate the same files. */
export function readExcludeDirs(d: string): Set<string> | undefined {
  const dirs = readBuildConfig(d)?.excludeDirs;
  return dirs && dirs.length ? new Set(dirs) : undefined;
}

/** Missing and explicit false both retain the backwards-compatible default. */
export function readFollowSubmodules(d: string): boolean {
  return readBuildConfig(d)?.followSubmodules === true;
}

/** Missing and explicit false both retain the backwards-compatible default. */
export function readFollowNestedRepos(d: string): boolean {
  return readBuildConfig(d)?.followNestedRepos === true;
}

/** See {@link BuildConfig.deepStaleThreshold}. */
export const DEFAULT_DEEP_STALE_THRESHOLD = 10;

export function isValidDeepStaleThreshold(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
}

/** Machine-wide defaults for settings a repo's `.graft/config.json` can
 * override. Its own file, not `~/.graft/config.json`: with `~` itself used as
 * a repo, that path would be the repo config too. */
export interface GlobalSettings {
  deepStaleThreshold?: number;
  /** Where repos that have no map or settings inside them yet keep them: absent
   * or `true` → `~/.graft/repos` (the default), an absolute folder → there,
   * `false` → in the repo as before. Read by context/profile-store.ts;
   * `GRAFT_PROFILE_STORE` overrides it. */
  profileStore?: boolean | string;
}

export function globalSettingsPath(home: string = homedir()): string {
  return join(home, '.graft', 'settings.json');
}

export function readGlobalSettings(home?: string): GlobalSettings | null {
  return readJson<GlobalSettings>(globalSettingsPath(home));
}

/** Merge into the global settings; an `undefined` value clears that key. */
export function patchGlobalSettings(patch: GlobalSettings, home?: string): void {
  writeJsonAtomic(globalSettingsPath(home), { ...(readGlobalSettings(home) ?? {}), ...patch });
}

export type DeepStaleThresholdSource = 'repo' | 'global' | 'default';

/** The effective `--deep` nudge threshold for repo `d`, in percent, and where it
 * came from: this repo's config, else the global settings, else the default. A
 * hand-edited value that is not a number in 0–100 is skipped rather than
 * silencing (or spamming) the nudge. */
export function resolveDeepStaleThreshold(
  d: string,
  home?: string,
): { value: number; source: DeepStaleThresholdSource } {
  const repo = readBuildConfig(d)?.deepStaleThreshold;
  if (isValidDeepStaleThreshold(repo)) return { value: repo, source: 'repo' };
  const global = readGlobalSettings(home)?.deepStaleThreshold;
  if (isValidDeepStaleThreshold(global)) return { value: global, source: 'global' };
  return { value: DEFAULT_DEEP_STALE_THRESHOLD, source: 'default' };
}

export function readDeepStaleThreshold(d: string, home?: string): number {
  return resolveDeepStaleThreshold(d, home).value;
}

// Best-effort read-modify-write; not atomic across concurrent processes, but acceptable
// for episodic hook writes (worst case is a lost update, not corruption).
export function patchStats(d: string, patch: Partial<Stats>): Stats {
  const next: Stats = { ...(readStats(d) ?? emptyStats()), ...patch };
  writeStats(d, next);
  return next;
}

export function acquireLock(d: string): boolean {
  return acquireLockIn(cacheDir(d));
}
export function releaseLock(d: string): void {
  releaseLockIn(cacheDir(d));
}

/**
 * The lock, addressed by cache dir rather than project dir. For the default layout
 * `<root>/graft/.cache` these are the same file, which is the point: the Claude Code
 * hooks lock by project dir and the graph's auto-refresh locks by the context dir it
 * is actually writing, and the two must collide so they can't rebuild at once.
 */
export function acquireLockIn(cache: string): boolean {
  const p = join(cache, LOCK_FILE);
  mkdirSync(cache, { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  try {
    writeFileSync(p, payload, { flag: 'wx' }); // atomic exclusive create
    return true;
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
    let stale: boolean;
    try { stale = Date.now() - statSync(p).mtimeMs >= LOCK_STALE_MS; } catch { stale = true; }
    if (!stale) return false;
    try { rmSync(p); } catch { /* another process reclaimed it */ }
    try { writeFileSync(p, payload, { flag: 'wx' }); return true; }
    catch (e2: any) { if (e2?.code === 'EEXIST') return false; throw e2; }
  }
}
export function releaseLockIn(cache: string): void {
  try { rmSync(join(cache, LOCK_FILE)); } catch { /* already gone */ }
}
