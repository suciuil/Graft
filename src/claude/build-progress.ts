/**
 * `graft build`, run from `graft init` as one line that redraws in place.
 *
 * `buildGraphIfMissing` hands the child the terminal, which prints a `parsing
 * N/M: path` line and four more after it. That is the right output for someone
 * who ran `graft build`, and five lines of someone else's output in the middle
 * of init. Here the child's output is read instead: its progress becomes the
 * spinner's `1,204 of 1,942 files`, its totals become init's one summary line,
 * and any warning or error it printed is passed on whole.
 */
import { spawn } from "node:child_process";
import { hasGraftIndex } from "../graph/root.js";
import { startSpinner } from "../util/spinner.js";
import { heapArgs } from "../util/heap.js";
import { GRAPH_TOO_LARGE_EXIT, TOO_LARGE_HEADLINE } from "../graph/size-guard.js";

export interface BuiltGraph {
  nodes: number;
  edges: number;
  files: number;
}

const n = (s: string | undefined) => Number((s ?? "0").replace(/,/g, "")) || 0;

/** The totals out of `graft build`'s stdout, or null when it printed none. */
export function parseBuildSummary(stdout: string): BuiltGraph | null {
  const wiring = /✓ wiring: ([\d,]+) nodes.*?, ([\d,]+) edges/.exec(stdout);
  if (!wiring) return null;
  const parsed = /parsed: [\d,]+ of ([\d,]+) files/.exec(stdout);
  return { nodes: n(wiring[1]), edges: n(wiring[2]), files: n(parsed?.[1]) };
}

/** The last `parsing N/M` in a chunk of the child's stderr. */
export function parseProgress(chunk: string): { index: number; total: number } | null {
  let last: { index: number; total: number } | null = null;
  for (const m of chunk.matchAll(/(?:parsing|summarizing) (\d+)\/(\d+)/g)) last = { index: n(m[1]), total: n(m[2]) };
  return last;
}

/** How long init waits for its build before stopping it. */
export const INIT_BUILD_TIMEOUT_MS = 300_000;

/**
 * Why the child build failed, in words for init's one line: a build init stopped
 * for taking too long says so (it is not broken; `graft build` will finish it), and
 * a crash names its exit code or signal instead of leaving "failed" unexplained.
 */
export function buildFailureReason(r: { timedOut: boolean; code: number | null; signal?: NodeJS.Signals | null }): string {
  if (r.timedOut) return `stopped after ${Math.round(INIT_BUILD_TIMEOUT_MS / 60_000)} minutes, too long for init`;
  if (r.code === null) return r.signal ? `stopped by ${r.signal}` : "could not start";
  if (r.code === GRAPH_TOO_LARGE_EXIT) return "stopped: the repository is too big for one map";
  // Windows NTSTATUS crash codes arrive as negative 32-bit ints (0xC0000409 → -1073740791):
  // the process died without exiting (out of memory, an abort), so it may have printed nothing.
  if (r.code < 0) return `crashed with exit code 0x${(r.code >>> 0).toString(16).toUpperCase()}`;
  return `exited with code ${r.code}`;
}

/**
 * The lines of a child build's output that init prints: its warnings and errors, and
 * for a repo too big for one map the whole report, the list of parts to build included.
 */
export function buildMessages(stdout: string, stderr: string, code: number | null): string[] {
  const lines = `${stdout}\n${stderr.replace(/\r[^\n]*/g, "\n")}`.split("\n").map((l) => l.trimEnd());
  const head = code === GRAPH_TOO_LARGE_EXIT ? lines.findIndex((l) => l.startsWith(TOO_LARGE_HEADLINE)) : -1;
  return [
    ...(head >= 0 ? lines.slice(0, head) : lines).filter((l) => /^\s*[⚠✗]/.test(l)),
    ...(head >= 0 ? lines.slice(head).filter((l) => l !== "") : []),
  ];
}

/**
 * Build the graph for `dir` unless it has one, showing progress on a spinner.
 *
 * `built: false` with no `failed` means there was nothing to do (`--no-build`,
 * or a graph already there). Warning and error lines the build printed come
 * back in `messages`, for the caller to print in full; `reason` says why a failed
 * build failed.
 */
export async function buildGraphWithProgress(
  dir: string,
  opts: { build?: boolean; cliPath?: string },
): Promise<{ built: boolean; graph?: BuiltGraph; failed?: boolean; timedOut?: boolean; tooLarge?: boolean; reason?: string; messages: string[] }> {
  if (opts.build === false || !opts.cliPath || hasGraftIndex(dir)) return { built: false, messages: [] };
  const spinner = startSpinner("building the graph");
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let signal: NodeJS.Signals | null = null;
  const fmt = (x: number) => x.toLocaleString("en-US");
  const code = await new Promise<number | null>((resolve) => {
    // The bigger heap a large repo needs (util/heap.ts): a child can be given it as it starts.
    const child = spawn(process.execPath, [...process.execArgv, ...heapArgs(), opts.cliPath!, "build", ".", "--no-workspace"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, INIT_BUILD_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => {
      stderr += d;
      const p = parseProgress(d);
      if (p) spinner.update(`building the graph · ${fmt(p.index)} of ${fmt(p.total)} files`);
    });
    child.on("error", () => resolve(null));
    child.on("close", (c, s) => {
      clearTimeout(timer);
      signal = s;
      resolve(c);
    });
  });
  spinner.stop();
  const tooLarge = code === GRAPH_TOO_LARGE_EXIT;
  const messages = buildMessages(stdout, stderr, code);
  const graph = parseBuildSummary(stdout) ?? undefined;
  if (code !== 0) {
    return { built: false, failed: true, timedOut, ...(tooLarge ? { tooLarge } : {}), reason: buildFailureReason({ timedOut, code, signal }), messages };
  }
  return { built: true, graph, messages };
}
