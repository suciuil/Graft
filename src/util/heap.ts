/**
 * A bigger V8 heap for builds of large repos.
 *
 * Node's default old-space limit is ~4 GB on a 64-bit machine whatever its RAM, and
 * a build holds every node and edge of the repo at once: on ~67k C files that ran
 * out ("Ineffective mark-compacts near heap limit") well before the map was too big
 * to write. The limit can only be set when a process starts, so a large build is
 * run in a child Node with `--max-old-space-size` (init's build always is a child).
 */
import { spawnSync } from "node:child_process";
import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";

/** Set in a build relaunched with a bigger heap, so it never relaunches again. */
export const HEAP_RAISED_ENV = "GRAFT_HEAP_RAISED";

/** Indexable files above which `graft build` relaunches itself with a bigger heap. */
export const BIG_REPO_FILES = 20_000;

/** The heap to ask for, in MB: half the RAM, at most 16 GB. */
export function bigHeapMb(total: number = totalmem()): number {
  return Math.min(16_384, Math.floor(total / 2 / 2 ** 20));
}

/** Whether a heap limit was already chosen, on the command line or in NODE_OPTIONS. */
export function hasHeapFlag(execArgv: readonly string[] = process.execArgv, nodeOptions = process.env.NODE_OPTIONS ?? ""): boolean {
  return [...execArgv, nodeOptions].some((a) => /--max-old-space-size\b/.test(a));
}

/**
 * Node flags that give a build child the bigger heap: none when a limit was
 * already chosen, or when the current one is already as big.
 */
export function heapArgs(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions = process.env.NODE_OPTIONS ?? "",
  currentMb: number = getHeapStatistics().heap_size_limit / 2 ** 20,
  total: number = totalmem(),
): string[] {
  if (hasHeapFlag(execArgv, nodeOptions)) return [];
  const mb = bigHeapMb(total);
  return mb > currentMb * 1.1 ? [`--max-old-space-size=${mb}`] : [];
}

/**
 * Run this same command again in a Node with the bigger heap, wait for it and
 * return its exit code; null when there is nothing to gain (already relaunched,
 * a limit was chosen, or the heap is big enough), and the caller carries on.
 */
export function relaunchWithBigHeap(): number | null {
  if (process.env[HEAP_RAISED_ENV]) return null;
  const flags = heapArgs();
  if (flags.length === 0 || !process.argv[1]) return null;
  const r = spawnSync(process.execPath, [...process.execArgv, ...flags, process.argv[1], ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, [HEAP_RAISED_ENV]: "1" },
    windowsHide: true,
  });
  if (r.error) return null;
  return r.status ?? 1;
}
