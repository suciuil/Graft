/**
 * Before `graft build` writes a map into the folder graft keeps generated files
 * in (the profile store, context/profile-store.ts), check that folder's drive
 * has room, and when it may not, suggest moving the folder with
 * `graft files location <folder>` (context/store-location.ts).
 *
 * The suggestion is made when:
 *
 *   - the location is on drive C: and less than {@link C_DRIVE_MIN_FREE} is
 *     free there: C: is usually the system drive, and a map growing on it
 *     takes the room Windows, the page file and every program need; or
 *   - on any drive, C: included, the maps this build writes there may not fit
 *     with a safe margin: their estimated size, doubled, plus
 *     {@link MIN_LEFT_FREE} left over, is more than what is free there plus
 *     what the maps being rebuilt already take.
 *
 * The estimate is the larger of {@link MAP_BYTES_PER_SOURCE_BYTE} times the
 * source bytes the build indexes and {@link MAP_BYTES_PER_FILE} per source
 * file. Measured on 90 maps built with --deep: the map (cards, concept nodes,
 * graph, extraction and LLM caches) came to 1.2 to 83 times the source, about 5
 * in the middle and 10 or less for nine in ten; a structural build of XML-heavy
 * folders reached 10 to 40 times. The doubling covers what the estimate misses
 * and the scratch files a build writes before renaming them into place.
 *
 * Only maps kept in the store count: a map inside the repo (`graft/`,
 * `.trail/cache/`), or one named by --dir or GRAFT_DIR, is not moved by
 * `graft files location`, so suggesting it would not help.
 *
 * A suggestion only: the build goes on either way.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cmd } from "../brand.js";
import { readFingerprint } from "../graph/fingerprint.js";
import { listSourceStats } from "../graph/source-files.js";
import { profileRepoDirOfMap, profileStoreRoot } from "./profile-store.js";
import { diskSpace, formatBytes, sizeOnDisk, type DiskSpace } from "./store-location.js";

const GIB = 1024 * 1024 * 1024;

/** Least free space on drive C: before graft suggests keeping its files elsewhere. */
export const C_DRIVE_MIN_FREE = 20 * GIB;
/** Map bytes estimated per byte of indexed source. */
export const MAP_BYTES_PER_SOURCE_BYTE = 10;
/** Least map bytes estimated per indexed source file. */
export const MAP_BYTES_PER_FILE = 128 * 1024;
/** How many times the estimate must fit, for what it misses and for scratch files. */
export const SAFETY_FACTOR = 2;
/** Space to leave free on the drive after the build. */
export const MIN_LEFT_FREE = GIB;

/** What a build indexes: its source files, and their bytes. */
export interface SourceSize {
  files: number;
  bytes: number;
}

/** One map the build is about to write. */
export interface PlannedMap extends SourceSize {
  /** Bytes the map already takes there, which the build replaces. */
  existing: number;
}

export interface StoreSpaceCheck {
  /** The store's root: the location `graft files location` shows. */
  root: string;
  space: DiskSpace;
  /** Estimated size of the maps the build writes there. */
  estimate: number;
  /** What those maps already take there. */
  existing: number;
  /** What must be free there for the build to be safe. */
  needed: number;
  /** Why to suggest moving the location; null when there is room. */
  reason: "c-drive" | "space" | null;
}

/** Estimated size on disk of the map of `files` source files of `bytes` bytes in all. */
export function estimateMapBytes(files: number, bytes: number): number {
  return Math.max(bytes * MAP_BYTES_PER_SOURCE_BYTE, files * MAP_BYTES_PER_FILE);
}

/** Whether `path` is on drive C: (Windows only: elsewhere there is no drive C:). */
export function onDriveC(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && /^c:/i.test(path);
}

/** Whether the store at `root`, with `space` free, has room for `maps`. */
export function checkStoreSpace(
  root: string,
  space: DiskSpace,
  maps: readonly PlannedMap[],
  platform: NodeJS.Platform = process.platform,
): StoreSpaceCheck {
  const estimate = maps.reduce((n, m) => n + estimateMapBytes(m.files, m.bytes), 0);
  const existing = maps.reduce((n, m) => n + m.existing, 0);
  const needed = Math.max(0, estimate * SAFETY_FACTOR + MIN_LEFT_FREE - existing);
  const reason =
    onDriveC(space.at, platform) && space.free < C_DRIVE_MIN_FREE ? "c-drive" : maps.length > 0 && space.free < needed ? "space" : null;
  return { root, space, estimate, existing, needed, reason };
}

/** The lines suggesting `graft files location`, or none when there is room. */
export function storeSpaceAdvice(check: StoreSpaceCheck): string[] {
  if (!check.reason) return [];
  const location = cmd("graft files location");
  const free = formatBytes(check.space.free);
  const move = `move them to a drive with more room with \`${location} <folder>\``;
  const head =
    check.reason === "c-drive"
      ? `⚠ graft keeps its generated files in ${check.root}, on drive C:, where only ${free} is free ` +
        `(less than ${formatBytes(C_DRIVE_MIN_FREE)}): to keep drive C: from filling up, ${move}`
      : `⚠ graft keeps its generated files in ${check.root}, where ${free} is free, which may not be enough ` +
        `for this build: ${move}`;
  const size =
    check.estimate > 0
      ? `  This build's map is estimated at about ${formatBytes(check.estimate)}` +
        (check.existing > 0 ? ` (the map it replaces takes ${formatBytes(check.existing)})` : "") +
        (check.reason === "space" ? `; ${formatBytes(check.needed)} free would leave a safe margin.` : ".")
      : "";
  return [
    head,
    ...(size ? [size] : []),
    `  \`${location} <folder> --dry-run\` shows what would move and whether it fits. The build goes on where it is now.`,
  ];
}

/** A root the build is about to build, and the folder its map goes to. */
export interface BuildTarget {
  root: string;
  mapDir: string;
}

export interface StoreLocationDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** Free space at a folder; injected by tests. */
  space?: (dir: string) => DiskSpace | null;
  /** What a target's build indexes; injected by tests. */
  plan?: (target: BuildTarget) => SourceSize;
  /** What a target's map already takes; injected by tests. */
  existing?: (target: BuildTarget) => number;
}

/** Whether a map built for `recorded` (`--only-dir` prefixes; none = the whole repo) indexed what `wanted` asks for. */
function sameScope(recorded: readonly string[] | undefined, wanted: ReadonlySet<string> | undefined): boolean {
  const a = new Set(recorded ?? []);
  const b = wanted ?? new Set<string>();
  return a.size === b.size && [...a].every((d) => b.has(d));
}

/**
 * {@link SourceSize} of a target: from the prints its last build recorded
 * (graph/fingerprint.ts) when that build indexed the same folders, which reads
 * one file; else from the files a build of it indexes, which walks the repo and
 * stats every file. The estimate is doubled anyway, so a few files added or
 * changed since that build do not matter.
 */
function sourceSize(target: BuildTarget, onlyDirs: ReadonlySet<string> | undefined): SourceSize {
  let files = 0;
  let bytes = 0;
  try {
    const printed = readFingerprint(target.mapDir);
    if (printed && sameScope(printed.onlyDirs, onlyDirs)) {
      for (const p of Object.values(printed.files)) {
        files++;
        bytes += typeof p?.[0] === "number" ? p[0] : 0;
      }
      return { files, bytes };
    }
  } catch {
    // no usable prints: walk the repo below
    files = 0;
    bytes = 0;
  }
  try {
    for (const f of listSourceStats(target.root, target.mapDir, undefined, onlyDirs)) {
      files++;
      bytes += f.size;
    }
  } catch {
    // unreadable folder: the build itself reports it
  }
  return { files, bytes };
}

/**
 * The lines to print before a build of `targets`: a suggestion to move the
 * store with `graft files location` when its drive may be short of space, or
 * none. Targets whose map is not in the store are left out.
 */
export function storeLocationAdvice(
  targets: readonly BuildTarget[],
  onlyDirs?: readonly string[],
  deps: StoreLocationDeps = {},
): string[] {
  const env = deps.env ?? process.env;
  // An undefined `home` falls back to the real one (the parameters' default).
  const root = profileStoreRoot(env, deps.home);
  if (!root) return [];
  const inStore = targets.filter((t) => profileRepoDirOfMap(t.root, t.mapDir, env, deps.home));
  if (inStore.length === 0) return [];
  const space = (deps.space ?? diskSpace)(resolve(root));
  if (!space) return [];
  const platform = deps.platform ?? process.platform;
  // Drive C: short of room: said without sizing the repo, which can take a while.
  const quick = checkStoreSpace(root, space, [], platform);
  if (quick.reason) return storeSpaceAdvice(quick);
  const only = onlyDirs && onlyDirs.length > 0 ? new Set(onlyDirs) : undefined;
  const sizes = inStore.map((t) => (deps.plan ? deps.plan(t) : sourceSize(t, only)));
  // First as if nothing were there yet, the most room a build can need: when that
  // fits, as on most builds, the old maps (a file per source file and more) are
  // never walked. Only a build that may be short sizes them, for the room they free.
  const fresh = checkStoreSpace(root, space, sizes.map((s) => ({ ...s, existing: 0 })), platform);
  if (!fresh.reason) return [];
  const existing = deps.existing ?? ((t: BuildTarget) => (existsSync(t.mapDir) ? sizeOnDisk(t.mapDir, space.blockSize) : 0));
  const maps = sizes.map((s, i) => ({ ...s, existing: existing(inStore[i]!) }));
  return storeSpaceAdvice(checkStoreSpace(root, space, maps, platform));
}
