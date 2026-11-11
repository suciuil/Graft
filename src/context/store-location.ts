/**
 * `graft files location`: choose the folder every repo's generated files are
 * kept in (the profile store's root, context/profile-store.ts), and move the
 * ones already there.
 *
 *   ~/.graft/repos/<folder>-<hash>/   →   <new folder>/<folder>-<hash>/
 *
 * Each repo's own folder keeps its name, so the new location becomes its
 * parent, and a repo finds its map, its settings and its `repo.json` again
 * from its path, exactly as before. Every graft repo folder found in a known
 * store root moves (the current root, the one named by GRAFT_PROFILE_STORE or
 * `~/.graft/settings.json`, the default `~/.graft/repos`, and `--from`), so
 * all current repos and every new one use the new location.
 *
 * The choice is saved as `"profileStore"` in `~/.graft/settings.json`, which
 * every graft process reads live (hooks, MCP servers, running IDEs), so none
 * of them keeps writing to the old folder. A saved GRAFT_PROFILE_STORE would
 * win over that setting, so it is removed; one set in the current terminal
 * only is reported. `--default` moves everything back to `~/.graft/repos` and
 * removes the setting, so the default applies again.
 *
 * Before anything moves: the destination must have room. Folders on the same
 * drive are renamed, which takes no space; folders on another drive are
 * copied, so their size on disk (plus 5% headroom) must be free there. A build
 * running in any of them, a destination inside the current location, or a
 * destination that cannot be written stops the move with nothing changed.
 *
 * The move is all or nothing (see executeMove): every folder on another drive
 * is copied and checked first, then the ones on the same drive are renamed,
 * and only once every folder is at the new location is it saved and are the
 * copied originals deleted. If any folder cannot be brought over, everything
 * is put back and nothing is deleted from the old location.
 *
 * Maps kept inside a repo (`graft/`, `.trail/cache/`), `--dir` and GRAFT_DIR
 * are not part of the store, are never moved here, and keep winning over it.
 *
 * Pure over the file system, an injected environment and an injected saved
 * environment store; the commander wiring is in cli.ts.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { cmd } from "../brand.js";
import type { UserEnvStore } from "../ai/llm-settings.js";
import { acquireLockIn, lockHeldByOther, patchGlobalSettings, releaseLockIn } from "../util/state.js";
import { renameReplacing } from "../util/rename-replacing.js";
import {
  defaultProfileStoreRoot,
  isOutside,
  PROFILE_CONFIG_FILE,
  PROFILE_MAP_DIR,
  PROFILE_REPO_NOTE,
  profileStoreSetting,
  readSwitch,
  repoKey,
  settingsProfileStore,
} from "./profile-store.js";

const STORE_ENV = "GRAFT_PROFILE_STORE";
/** Headroom on top of the bytes a cross-drive copy needs: 5%, and at least 1 MiB. */
const HEADROOM_RATIO = 0.05;
const HEADROOM_MIN = 1024 * 1024;

/** Free space where a folder is (or would be created), and the drive it is on. */
export interface DiskSpace {
  /** The folder actually asked: the nearest one that exists. */
  at: string;
  /** Bytes free for this user. */
  free: number;
  /** The file system's block size, to round each file up to what it takes on disk. */
  blockSize: number;
  /** The device id, to tell whether two folders are on the same drive. */
  dev: number;
}

export interface LocationDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  /** Where GRAFT_PROFILE_STORE may be saved for new terminals; absent = not checked. */
  store?: UserEnvStore;
  /** Free space at a folder; injected by tests. */
  space?: (dir: string) => DiskSpace | null;
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface LocationOptions {
  default?: boolean;
  dryRun?: boolean;
  /** Extra store roots to move folders from. */
  from?: string[];
}

export interface PlannedFolder {
  name: string;
  from: string;
  to: string;
  /** Same drive as the destination: renamed, no space needed. */
  sameDrive: boolean;
  /** Size on disk at the destination, when it must be copied; 0 when renamed. */
  bytes: number;
  /** Something with this name is already at the destination (or comes from an earlier source). */
  conflict: boolean;
}

export interface MovePlan {
  target: string;
  /** The store roots folders are moved from, that exist. */
  sources: string[];
  folders: PlannedFolder[];
  /** Bytes that must be free at the destination, headroom included. */
  needed: number;
  space: DiskSpace | null;
  /** Reasons the move cannot start; empty when it can. */
  problems: string[];
}

// ── reading ──

/** The nearest folder at or above `dir` that exists. */
function nearestExisting(dir: string): string | null {
  let p = resolve(dir);
  for (;;) {
    if (existsSync(p)) return p;
    const up = dirname(p);
    if (up === p) return null;
    p = up;
  }
}

/** Free space and drive of `dir`, through its nearest existing parent; null when the OS can't say. */
export function diskSpace(dir: string): DiskSpace | null {
  const at = nearestExisting(dir);
  if (!at) return null;
  try {
    const fs = statfsSync(at);
    const blockSize = Number(fs.bsize) > 0 ? Number(fs.bsize) : 4096;
    return { at, free: Number(fs.bavail) * blockSize, blockSize, dev: statSync(at).dev };
  } catch {
    return null;
  }
}

/** Whether `dir` is one repo's folder in a store: it holds a map, settings or the repo note. */
export function isStoreFolder(dir: string): boolean {
  return [PROFILE_MAP_DIR, PROFILE_CONFIG_FILE, PROFILE_REPO_NOTE].some((n) => existsSync(join(dir, n)));
}

/** Every repo folder in the store root `root`, A→Z. */
export function storeFolders(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  return names.sort().filter((n) => isStoreFolder(join(root, n)));
}

/** Bytes `dir` takes on disk, each file rounded up to whole blocks. Links are counted, not followed. */
export function sizeOnDisk(dir: string, blockSize = 4096): number {
  const round = (n: number) => Math.ceil(n / blockSize) * blockSize;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    total += blockSize; // the folder itself
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          total += round(lstatSync(p).size);
        } catch {
          // gone meanwhile
        }
      }
    }
  }
  return total;
}

/** `1.5 GB`, `320 MB`, `12 KB`. */
export function formatBytes(n: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${n} bytes` : `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

const same = (a: string, b: string): boolean => repoKey(a) === repoKey(b);

/** `~`, `~/x`, a relative or an absolute folder, made absolute. */
export function resolveTarget(raw: string, deps: Pick<LocationDeps, "home" | "cwd">): string {
  const v = raw.trim();
  if (v === "~") return resolve(deps.home);
  if (v.startsWith("~/") || v.startsWith("~\\")) return resolve(deps.home, v.slice(2));
  return isAbsolute(v) ? resolve(v) : resolve(deps.cwd, v);
}

/**
 * Every store root graft knows of, that exists: the one in use, the ones the
 * variable (this terminal's and the saved one) and the settings file name, and
 * the default, then `extra`. Deduplicated, in that order.
 */
export function knownStoreRoots(deps: LocationDeps, extra: string[] = []): string[] {
  const out: string[] = [];
  const add = (p: string | null | false | undefined) => {
    if (!p) return;
    const abs = resolve(p);
    if (!existsSync(abs) || out.some((o) => same(o, abs))) return;
    out.push(abs);
  };
  add(profileStoreSetting(deps.env, deps.home).root);
  add(readSwitch(deps.env[STORE_ENV], deps.home));
  if (deps.store) add(readSwitch(savedStoreEnv(deps.store), deps.home));
  add(settingsProfileStore(deps.home));
  add(defaultProfileStoreRoot(deps.home));
  for (const e of extra) add(e);
  return out;
}

// ── planning ──

/** What moving every known store folder to `target` would do, and whether it can start. */
export function planMove(target: string, deps: LocationDeps, extra: string[] = []): MovePlan {
  const problems: string[] = [];
  const spaceOf = deps.space ?? diskSpace;
  const sources = knownStoreRoots(deps, extra).filter((s) => !same(s, target));
  for (const s of sources) {
    if (!isOutside(s, target)) problems.push(`${target} is inside ${s}, a folder being moved from; choose a folder outside it`);
  }
  if (existsSync(target) && !statSync(target).isDirectory()) problems.push(`${target} is a file, not a folder`);
  const space = spaceOf(target);
  if (!space) problems.push(`could not tell how much space is free at ${target}`);

  const folders: PlannedFolder[] = [];
  const taken = new Set<string>();
  const key = (n: string) => (deps.platform === "win32" || deps.platform === "darwin" ? n.toLowerCase() : n);
  for (const s of sources) {
    const sameDrive = space !== null && (() => {
      try {
        return statSync(s).dev === space.dev;
      } catch {
        return false;
      }
    })();
    for (const name of storeFolders(s)) {
      const from = join(s, name);
      const to = join(target, name);
      const conflict = taken.has(key(name)) || (existsSync(to) && !emptyDir(to));
      taken.add(key(name));
      const bytes = conflict || sameDrive ? 0 : sizeOnDisk(from, space?.blockSize);
      folders.push({ name, from, to, sameDrive, bytes, conflict });
      if (!conflict && lockHeldByOther(join(from, PROFILE_MAP_DIR, ".cache"))) {
        problems.push(`a build is running for ${repoOf(from) ?? from}; run this again once it has finished`);
      }
    }
  }
  const copy = folders.reduce((n, f) => n + f.bytes, 0);
  const needed = copy === 0 ? 0 : copy + Math.max(HEADROOM_MIN, Math.ceil(copy * HEADROOM_RATIO));
  if (space && needed > space.free) {
    problems.push(
      `not enough space at ${target}: the folders on other drives take ${formatBytes(copy)} ` +
        `(${formatBytes(needed)} with headroom), and only ${formatBytes(space.free)} is free there`,
    );
  }
  return { target, sources, folders, needed, space, problems };
}

function emptyDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/** The checkout a store folder belongs to, from its `repo.json`. */
function repoOf(folder: string): string | null {
  try {
    const note = JSON.parse(readFileSync(join(folder, PROFILE_REPO_NOTE), "utf8")) as { root?: unknown };
    return typeof note.root === "string" && isAbsolute(note.root) ? note.root : null;
  } catch {
    return null;
  }
}

/** Whether a folder can be created and written at `dir`. Leaves `dir` created. */
function writable(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.graft-write-test-${process.pid}`);
    writeFileSync(probe, "");
    unlinkSync(probe);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ── moving ──

/** Number of files and their total bytes under `dir`, to check a copy is complete. */
export function contentTally(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        files++;
        bytes += lstatSync(p).size;
      }
    }
  }
  return { files, bytes };
}

/** Copy `f` to its destination and check every file arrived; a partial copy is removed. */
function copyFolder(f: PlannedFolder, spaceOf: (dir: string) => DiskSpace | null): string | null {
  const space = spaceOf(dirname(f.to));
  const bytes = f.bytes || sizeOnDisk(f.from, space?.blockSize);
  if (!space || space.free < bytes) return `not enough space left at ${dirname(f.to)} for ${f.from} (${formatBytes(bytes)})`;
  try {
    if (emptyDir(f.to)) rmdirSync(f.to);
    mkdirSync(dirname(f.to), { recursive: true });
    cpSync(f.from, f.to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    const a = contentTally(f.from);
    const b = contentTally(f.to);
    if (a.files !== b.files || a.bytes !== b.bytes) {
      throw new Error(`the copy is incomplete (${b.files} of ${a.files} files, ${formatBytes(b.bytes)} of ${formatBytes(a.bytes)})`);
    }
    return null;
  } catch (e) {
    removeQuietly(f.to);
    return `${f.from}: ${(e as Error).message}`;
  }
}

function removeQuietly(dir: string): string | null {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export interface MoveResult {
  /** Every folder reached the destination and the originals' removal was attempted. */
  ok: boolean;
  renamed: PlannedFolder[];
  copied: PlannedFolder[];
  /** Why the move was undone; empty when it went through. */
  failures: string[];
  /** Things to tell the person that did not stop the move. */
  notes: string[];
}

/**
 * Move every planned folder, all or nothing, in three steps:
 *
 *   1. copy each folder that is on another drive to the destination, and check
 *      every file arrived;
 *   2. only when all of them were copied, rename the folders on the same drive
 *      (a rename moves a folder without copying it, and never loses it);
 *   3. only when every folder is at the destination, `commit` (which saves the
 *      new location) and then delete the originals of the copied folders.
 *
 * If a copy or a rename fails, everything done so far is undone (copies
 * deleted, renamed folders renamed back) and nothing is deleted from the old
 * location. Every folder's build lock is held from start to end, so no build
 * writes to one while it moves.
 */
export function executeMove(
  folders: PlannedFolder[],
  commit: () => void,
  spaceOf: (dir: string) => DiskSpace | null = diskSpace,
): MoveResult {
  const result: MoveResult = { ok: false, renamed: [], copied: [], failures: [], notes: [] };
  const moving = folders.filter((f) => !f.conflict);
  for (const f of folders.filter((f) => f.conflict)) {
    result.notes.push(`${f.to} already exists; the one there is used, ${f.from} was left as it was`);
  }
  const cache = (folder: string) => join(folder, PROFILE_MAP_DIR, ".cache");
  const hasMap = new Set(moving.filter((f) => existsSync(join(f.from, PROFILE_MAP_DIR))));
  const locked: PlannedFolder[] = [];
  const unlockAll = (where: (f: PlannedFolder) => string) => {
    for (const f of locked) releaseLockIn(cache(where(f)));
  };

  // 0. Hold every build lock, or stop before touching anything.
  for (const f of moving) {
    if (!hasMap.has(f)) continue;
    if (!acquireLockIn(cache(f.from))) {
      unlockAll((x) => x.from);
      result.failures.push(`a build started for ${repoOf(f.from) ?? f.from}; run this again once it has finished`);
      return result;
    }
    locked.push(f);
  }

  const undo = () => {
    for (const f of result.copied) removeQuietly(f.to);
    for (const f of [...result.renamed].reverse()) {
      try {
        renameReplacing(f.to, f.from);
      } catch (e) {
        result.failures.push(`could not move ${f.to} back to ${f.from} (${(e as Error).message}); move it back by hand`);
      }
    }
    result.copied = [];
    result.renamed = [];
    unlockAll((x) => x.from);
  };

  // 1. Copy everything that is on another drive.
  const copyFirst = moving.filter((f) => !f.sameDrive);
  for (const f of copyFirst) {
    const problem = copyFolder(f, spaceOf);
    if (problem) {
      result.failures.unshift(problem);
      undo();
      return result;
    }
    result.copied.push(f);
  }

  // 2. Then rename everything on the same drive.
  for (const f of moving.filter((f) => f.sameDrive)) {
    try {
      if (emptyDir(f.to)) rmdirSync(f.to);
      mkdirSync(dirname(f.to), { recursive: true });
      renameReplacing(f.from, f.to);
      result.renamed.push(f);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EXDEV") {
        // Not the same file system after all: copy it instead; its original
        // is deleted with the other copied ones.
        const problem = copyFolder(f, spaceOf);
        if (!problem) {
          result.copied.push(f);
          continue;
        }
        result.failures.unshift(problem);
      } else {
        result.failures.unshift(`${f.from}: ${(e as Error).message}`);
      }
      undo();
      return result;
    }
  }

  // 3. Every folder is at the destination: save the location, then delete the
  // originals of the copies. A copy's lock came along with it.
  try {
    commit();
  } catch (e) {
    result.failures.unshift(`could not save the new location: ${(e as Error).message}`);
    undo();
    return result;
  }
  result.ok = true;
  for (const f of locked) releaseLockIn(cache(f.to));
  for (const f of result.copied) {
    releaseLockIn(cache(f.from));
    const problem = removeQuietly(f.from);
    if (problem) result.notes.push(`copied to ${f.to}, but ${f.from} could not be deleted (${problem}); delete it by hand`);
  }
  return result;
}

// ── the command ──

function describeSource(source: string, root: string | null): string {
  switch (source) {
    case "GRAFT_PROFILE_STORE":
      return "set by GRAFT_PROFILE_STORE";
    case "settings":
      return root ? "set in ~/.graft/settings.json" : "turned off in ~/.graft/settings.json";
    default:
      return "the default";
  }
}

/** `graft files location` with no folder: where the store is and what is in it. */
function show(deps: LocationDeps): number {
  const { root, source } = profileStoreSetting(deps.env, deps.home);
  const command = cmd("graft files location");
  if (!root) {
    deps.out(`location: off (${describeSource(source, root)}): new repos keep graft/ and .graft/ inside them`);
    deps.out(`\`${command} <folder>\` turns it on at that folder and moves the repo folders graft already has there.`);
    return 0;
  }
  const n = storeFolders(root).length;
  const space = (deps.space ?? diskSpace)(root);
  deps.out(`location: ${root}  (${describeSource(source, root)})`);
  deps.out(`  ${n} repo folder${n === 1 ? "" : "s"}${space ? ` · ${formatBytes(space.free)} free on that drive` : ""}`);
  deps.out(
    `Move every repo's files with \`${command} <folder>\`, back to ${defaultProfileStoreRoot(deps.home)} with \`${command} --default\`. ` +
      `\`${cmd("graft where")}\` shows the folder of one repo.`,
  );
  return 0;
}

/**
 * `graft files location [folder] [--default] [--dry-run] [--from <folder>…]`.
 * Returns the exit code.
 */
export function runLocationCommand(value: string | undefined, opts: LocationOptions, deps: LocationDeps): number {
  const command = cmd("graft files location");
  if (value !== undefined && opts.default) {
    deps.err(`✗ ${command}: give a folder or --default, not both`);
    return 1;
  }
  if (value === undefined && !opts.default) return show(deps);
  if (value !== undefined && value.trim() === "") {
    deps.err(`✗ ${command}: the folder is empty`);
    return 1;
  }
  const target = opts.default ? defaultProfileStoreRoot(deps.home) : resolveTarget(value!, deps);
  const extra = (opts.from ?? []).map((f) => resolveTarget(f, deps));
  for (const f of extra) {
    if (!existsSync(f)) {
      deps.err(`✗ ${command}: --from ${f} does not exist`);
      return 1;
    }
  }
  const plan = planMove(target, deps, extra);
  const toMove = plan.folders.filter((f) => !f.conflict);
  const renamed = toMove.filter((f) => f.sameDrive).length;
  const copied = toMove.length - renamed;

  deps.out(`new location: ${target}`);
  if (plan.sources.length) deps.out(`moving from:  ${plan.sources.join(", ")}`);
  deps.out(
    `repo folders: ${toMove.length} to move` +
      (renamed ? ` · ${renamed} renamed on the same drive (no space needed)` : "") +
      (copied ? ` · ${copied} copied from another drive` : "") +
      (plan.folders.length > toMove.length ? ` · ${plan.folders.length - toMove.length} already at the destination, left as they are` : ""),
  );
  if (plan.space) {
    deps.out(
      `space:        ${plan.needed ? `${formatBytes(plan.needed)} needed (with headroom), ` : "no extra space needed, "}` +
        `${formatBytes(plan.space.free)} free at ${plan.space.at}`,
    );
  }
  if (plan.problems.length) {
    for (const p of plan.problems) deps.err(`✗ ${p}`);
    deps.err("Nothing was moved and the location was not changed.");
    return 1;
  }
  if (opts.dryRun) {
    for (const f of plan.folders) deps.out(`  ${f.conflict ? "keep" : f.sameDrive ? "move" : "copy"}  ${f.from}  →  ${f.to}`);
    deps.out("dry run: nothing was moved and the location was not changed.");
    return 0;
  }
  const problem = writable(target);
  if (problem) {
    deps.err(`✗ cannot write to ${target}: ${problem}`);
    deps.err("Nothing was moved and the location was not changed.");
    return 1;
  }

  // Copy, then rename, then save the location and delete the copied originals;
  // undone completely if any folder cannot be brought over.
  let saved: string[] = [];
  const result = executeMove(plan.folders, () => (saved = saveLocation(target, deps)), deps.space ?? diskSpace);
  if (!result.ok) {
    for (const f of result.failures) deps.err(`✗ ${f}`);
    deps.err("Everything was put back: nothing was deleted from the old location and the location was not changed.");
    if (result.failures.some((f) => f.startsWith("could not move"))) {
      deps.err("Except the folders named above, which are still at the new location.");
    }
    return 1;
  }

  // An emptied old root goes too, except the default one, which graft owns.
  for (const s of plan.sources) {
    if (same(s, defaultProfileStoreRoot(deps.home))) continue;
    if (emptyDir(s)) {
      try {
        rmdirSync(s);
      } catch {
        // in use: left behind, empty
      }
    }
  }

  const done = result.renamed.length + result.copied.length;
  deps.out(
    `✓ moved ${done} repo folder${done === 1 ? "" : "s"} to ${target}` +
      (result.copied.length ? ` (${result.copied.length} copied, and their originals deleted once all had arrived)` : ""),
  );
  for (const n of result.notes) deps.out(`  · ${n}`);
  for (const line of saved) deps.out(line);
  for (const f of toMove) {
    const repo = repoOf(f.to);
    if (repo && !isOutside(repo, target)) {
      deps.out(`  ! ${repo} contains ${target}, so it keeps its map inside the repo (graft/) instead of there`);
    }
  }
  if (deps.env.GRAFT_DIR) deps.out(`  ! GRAFT_DIR=${deps.env.GRAFT_DIR} is set in this terminal and wins over the location for the map`);
  return 0;
}

/**
 * Save `target` as the store's root in `~/.graft/settings.json` (or remove the
 * setting for the default), and take GRAFT_PROFILE_STORE out of the way.
 * Returns the lines to report.
 */
function saveLocation(target: string, deps: LocationDeps): string[] {
  const lines: string[] = [];
  const isDefault = same(target, defaultProfileStoreRoot(deps.home));
  patchGlobalSettings({ profileStore: isDefault ? undefined : target }, deps.home);
  lines.push(
    isDefault
      ? `✓ removed "profileStore" from ~/.graft/settings.json: every repo uses the default location again, new ones too`
      : `✓ saved "profileStore": ${JSON.stringify(target)} in ~/.graft/settings.json: every repo uses it from now on, new ones too`,
  );
  if (deps.store) {
    const saved = savedStoreEnv(deps.store);
    if (saved !== undefined) {
      try {
        deps.store.write(STORE_ENV, undefined);
        lines.push(`✓ removed the saved ${STORE_ENV}=${saved} (${deps.store.where}), which would have won over the location`);
      } catch (e) {
        lines.push(`  ! could not remove the saved ${STORE_ENV}=${saved} (${(e as Error).message}); it wins over the location: run \`${cmd("graft files store --unset")}\``);
      }
    }
  }
  const here = deps.env[STORE_ENV];
  if (here !== undefined && here !== "") {
    const unset = deps.platform === "win32" ? `Remove-Item Env:${STORE_ENV}` : `unset ${STORE_ENV}`;
    lines.push(`  ! ${STORE_ENV}=${here} is set in this terminal and wins over the location here; run \`${unset}\` or open a new terminal`);
  }
  return lines;
}

/** The saved GRAFT_PROFILE_STORE, if any; a store that cannot be read has none. */
function savedStoreEnv(store: UserEnvStore): string | undefined {
  try {
    const v = store.read(STORE_ENV);
    return v === undefined || v === "" ? undefined : v;
  } catch {
    return undefined;
  }
}
