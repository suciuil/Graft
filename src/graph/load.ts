/**
 * mtime-keyed in-process cache over the two readers `ask()` calls on every
 * query: the wiring graph (`readGraph`) and the ask sidecar (`readAskIndex`).
 * `graft ask` re-parses these from disk on every invocation; in a long-lived
 * process — the MCP server, or `graft ask` invoked repeatedly in one process —
 * that means re-parsing the same ~tens-of-MB JSON on every tool call.
 *
 * Keyed by `(path, mtimeMs, size)` from `statSync`, so a rebuild (`graft
 * build`) is picked up on the very next call with no polling and no TTL: the
 * stat is cheap relative to the parse it guards, and a changed mtime or size
 * invalidates the entry. A missing file returns null and is never cached — the
 * next call re-stats, so a file created after a prior miss is picked up
 * immediately (no negative caching).
 *
 * **Cache invalidation assumption:** This strategy assumes filesystem mtime
 * resolution is finer than build cadence. This is safe because `graft build`
 * rewrites the entire output file atomically, so same-size rewrites within a
 * single mtime tick (which would serve stale data) are infeasible in practice.
 * On APFS (macOS) mtime is nanosecond-granular and a build takes milliseconds,
 * so invalidation is immediate and reliable.
 *
 * Dependency-free by design: this module imports only Node built-ins,
 * `./write.js` and `../ask/index-file.js`, so it can be imported from both
 * `ask.ts` and `mcp/tools.ts` without creating an import cycle.
 */
import { statSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import { readGraph, wiringPath } from "./write.js";
import { readAskIndex, askIndexPath, type AskIndex } from "../ask/index-file.js";
import type { GraphV1 } from "./types.js";

interface CacheEntry<T> {
  mtimeMs: number;
  size: number;
  value: T | null;
}

const graphCache = new Map<string, CacheEntry<GraphV1>>();
const askIndexCache = new Map<string, CacheEntry<AskIndex>>();

/** Real parses performed (cache misses), not cache hits — exported for tests
 * so the invalidation contract can be pinned down without spying on `fs`. */
export const __parseCount = { graph: 0, askIndex: 0 };

/** Test-only: zero the counters (module state persists across a test file). */
export function __resetParseCounts(): void {
  __parseCount.graph = 0;
  __parseCount.askIndex = 0;
}

function statOf(path: string): { mtimeMs: number; size: number } | null {
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

function loadCached<T>(
  cache: Map<string, CacheEntry<T>>,
  path: string,
  parse: () => T | null,
  onParse: () => void,
): T | null {
  const st = statOf(path);
  if (!st) {
    // Missing file: don't negatively cache, and drop any stale entry so a
    // subsequently-created file at the same path is re-parsed, not served
    // from a cache keyed to the old (mtime, size).
    cache.delete(path);
    return null;
  }
  const cached = cache.get(path);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.value;
  }
  onParse();
  const value = parse();
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

/** Cached `readGraph(wiringPath(outDir))` — same null-on-missing/unparseable
 * semantics, re-reads only when the wiring file's `(mtimeMs, size)` changed.
 * Returns a shared cached reference; callers must not mutate the returned graph. */
export function loadGraphCached(outDir: string): GraphV1 | null {
  const path = wiringPath(outDir);
  return loadCached(graphCache, path, () => readGraph(path), () => {
    __parseCount.graph++;
  });
}

/** Cached `readAskIndex(outDir)` — same semantics, keyed on the sidecar file.
 * Returns a shared cached reference; callers must not mutate the returned index. */
export function loadAskIndexCached(outDir: string): AskIndex | null {
  const path = askIndexPath(outDir);
  return loadCached(askIndexCache, path, () => readAskIndex(outDir), () => {
    __parseCount.askIndex++;
  });
}

/** wiring.json bytes, summed over several maps, above which a command that walks
 * them all (a workspace's children, a repository built as one map per part) loads
 * them one at a time instead of keeping each cached. A parsed graph takes about
 * as much heap as its file, plus the file's text while it is parsed, so a few
 * parts of ~480 MB each overflow the default heap. */
export const KEEP_GRAPHS_BYTES = 300e6;

/** The limit {@link tooBigToKeep} applies when given none. */
let keepLimit = KEEP_GRAPHS_BYTES;

/** For tests: make {@link tooBigToKeep} apply `bytes` when given no limit, so a
 * small workspace is walked as a big one is; no argument restores the default. */
export function __setKeepLimit(bytes: number = KEEP_GRAPHS_BYTES): void {
  keepLimit = bytes;
}

/** Whether the maps in `outDirs` are together too big to keep cached while a
 * command walks them (see {@link KEEP_GRAPHS_BYTES}). Missing maps count 0. */
export function tooBigToKeep(outDirs: readonly string[], limit = keepLimit): boolean {
  let bytes = 0;
  for (const d of outDirs) bytes += statOf(wiringPath(d))?.size ?? 0;
  return bytes > limit;
}

/** Bytes of the cached files of each workspace map a command was done with
 * (see {@link doneWithMap}), and the command that last used it, the least
 * recently used first. */
const kept = new Map<string, { bytes: number; command: number }>();

/** How many bytes of those files may stay cached; 0 drops each map once used. */
let keepBytes = 0;

/** The command walking a workspace's maps now (see {@link startMapCommand}). */
let command = 0;

/**
 * Let a long-lived process keep the maps of a workspace too big to keep whole
 * (see {@link tooBigToKeep}) cached between commands, up to `bytes` of their
 * files (which go as {@link doneWithMap} says). The MCP server keeps a quarter
 * of its heap's worth ({@link mcpKeepBytes}); a one-shot command keeps none, so
 * it holds one map at a time.
 */
export function keepWorkspaceMaps(bytes: number): void {
  keepBytes = Math.max(0, bytes);
  trimKept();
}

/** What the MCP server keeps: a parsed map takes about as much heap as its
 * file (a 323 MB map, 289 MB), so a quarter of the heap, which leaves room for
 * the map in use and the text of the next one being parsed, and never less than
 * {@link KEEP_GRAPHS_BYTES}, below which a workspace's maps are all kept anyway. */
export function mcpKeepBytes(heapLimit: number = getHeapStatistics().heap_size_limit): number {
  return Math.max(KEEP_GRAPHS_BYTES, Math.floor(heapLimit / 4));
}

/** A command that walks the maps of a workspace too big to keep whole begins:
 * the maps it is done with from now on are its own (see {@link doneWithMap}). */
export function startMapCommand(): void {
  command++;
}

/**
 * A command of a workspace too big to keep whole is done with `outDir`'s map:
 * kept, as the most recently used, while the kept maps' files come to at most
 * the bytes {@link keepWorkspaceMaps} allows, and dropped at once when it alone
 * is bigger. Room is made with the maps the commands before left, the least
 * recently used first, then with this command's own, the most recently used
 * first: a command walking more maps than fit keeps the first ones, so the next
 * walk in the same order finds them, where dropping the least recently used
 * would drop each just before that walk came back to it.
 */
export function doneWithMap(outDir: string): void {
  kept.delete(outDir);
  const bytes = (graphCache.get(wiringPath(outDir))?.size ?? 0) + (askIndexCache.get(askIndexPath(outDir))?.size ?? 0);
  // Bigger than all that may be kept: dropped alone, the others kept.
  if (bytes > keepBytes) return invalidateGraphCaches(outDir);
  if (bytes > 0) kept.set(outDir, { bytes, command });
  trimKept();
}

function trimKept(): void {
  let total = 0;
  for (const k of kept.values()) total += k.bytes;
  for (const [dir, k] of kept) {
    if (total <= keepBytes) return;
    if (k.command === command) continue;
    total -= k.bytes;
    invalidateGraphCaches(dir);
  }
  for (const [dir, k] of [...kept].reverse()) {
    if (total <= keepBytes) return;
    total -= k.bytes;
    invalidateGraphCaches(dir);
  }
}

/**
 * Drop the cached graph + sidecar for `outDir`, forcing the next load to re-read.
 *
 * The `(mtimeMs, size)` key above is a good invalidator for a build that happened
 * in *another* process, but not for one this process just performed: the
 * pre-query auto-refresh (`refresh.ts`) rewrites the graph and then immediately
 * queries it, and on a filesystem with coarse mtime resolution a same-tick rewrite
 * of the same size would be served from the stale entry. Callers that rebuild must
 * therefore invalidate explicitly rather than trust the clock.
 */
export function invalidateGraphCaches(outDir: string): void {
  graphCache.delete(wiringPath(outDir));
  askIndexCache.delete(askIndexPath(outDir));
  kept.delete(outDir);
}
