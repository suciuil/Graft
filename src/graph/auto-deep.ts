/**
 * Auto-deep: `graft build --deep` started by itself, in the background, once the
 * share of out-of-date node summaries reaches the repo's deep-threshold
 * (`graft deep-threshold`). Off unless the user turns it on (`graft auto-deep
 * on`, per repo or `--global`), because every run is an LLM pass that spends AI
 * tokens without asking — the opposite of the query-time refresh's money guard
 * (`./refresh.ts`), which stays $0 and is untouched by this.
 *
 * The rules that keep it from spending more than asked:
 *
 * - **One run at a time** per map, under its own lock (`.cache/auto-deep.lock`),
 *   not the structural build's `.sync.lock`, whose 15-minute age limit a deep
 *   build outlasts on any real repo.
 * - **No retry after a failure.** A failed run (bad key, quota, endpoint down) is
 *   reported on every query until the user fixes it: a successful manual
 *   `graft build --deep` or `graft auto-deep on` clears it. Retrying by itself
 *   would charge the same failing calls again and again.
 * - **No re-run for what a run left behind.** A run that ended with summaries
 *   still out of date past the threshold is not repeated until more go out of
 *   date than it left.
 *
 * While it is on and working, the manual "run `graft build --deep`" nudge is not
 * shown: there is nothing for the user to run. What is shown instead is a short
 * note when a run starts and while it runs, and a loud one when it failed.
 *
 * Only queries start a run (the CLI's `refreshBefore`, the MCP tools), never
 * `graft build` itself, and never a run started by a run (`AUTO_DEEP_CHILD_ENV`).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cmd, tag } from "../brand.js";
import { CACHE_DIR, contextDirFor } from "../context/node-file.js";
import { resolveAutoDeep } from "../util/state.js";
import { deepDueFor, deepStalenessFor, outdatedPercent, type SummaryStaleness } from "./refresh.js";

/** Set on the `graft build --deep` an automatic run starts: that build never
 * starts another one, and fails instead of quietly building without summaries. */
export const AUTO_DEEP_CHILD_ENV = "GRAFT_AUTO_DEEP_RUN";

/** How long one automatic run may take before it is stopped and reported failed. */
export const AUTO_DEEP_TIMEOUT_MS = 3 * 60 * 60_000;
/** Past this a lock is taken over whoever holds it: its run is long past its own limit. */
const LOCK_MAX_MS = AUTO_DEEP_TIMEOUT_MS + 15 * 60_000;
/** A lock this young is never taken over: the query that took it may already have
 * exited, before the runner it started has put its own pid in. */
const LOCK_GRACE_MS = 60_000;

const STATUS_FILE = "auto-deep.json";
const LOG_FILE = "auto-deep.log";
const LOCK_FILE = "auto-deep.lock";

/** Where an automatic run of this map keeps its record, output and lock. */
export interface AutoDeepPaths {
  cache: string;
  status: string;
  log: string;
  lock: string;
}

export function autoDeepPaths(root: string, contextDir?: string): AutoDeepPaths {
  const cache = join(contextDirFor(resolve(root), contextDir), CACHE_DIR);
  return { cache, status: join(cache, STATUS_FILE), log: join(cache, LOG_FILE), lock: join(cache, LOCK_FILE) };
}

export interface AutoDeepCounts {
  outdated: number;
  total: number;
  percent: number;
  threshold: number;
}

/** The record of the last automatic run of a map (`.cache/auto-deep.json`). */
export interface AutoDeepStatus {
  state: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  /** The runner's pid, once it has started. */
  pid?: number;
  /** What made it start. */
  trigger?: AutoDeepCounts;
  /** Out-of-date summaries the run left behind, when it succeeded. */
  after?: { outdated: number; total: number };
  exitCode?: number | null;
  /** Why it failed, short enough for a note; the full output is in `log`. */
  error?: string;
  log: string;
}

/** What one run needs to know, handed from the query to the runner (`./auto-deep-run.ts`). */
export interface AutoDeepJob {
  root: string;
  contextDir?: string;
  children?: string[];
  timeoutMs: number;
  paths: AutoDeepPaths;
}

/** Starts a run in the background, or throws when it can't. Tests pass their own. */
export type AutoDeepStarter = (job: AutoDeepJob) => void;

export function readAutoDeepStatus(p: AutoDeepPaths): AutoDeepStatus | null {
  try {
    const s = JSON.parse(readFileSync(p.status, "utf8")) as AutoDeepStatus;
    return s && typeof s === "object" && typeof s.state === "string" ? s : null;
  } catch {
    return null;
  }
}

export function writeAutoDeepStatus(p: AutoDeepPaths, s: AutoDeepStatus): void {
  try {
    mkdirSync(p.cache, { recursive: true });
    writeFileSync(p.status, JSON.stringify(s, null, 2) + "\n");
  } catch {
    /* the note still says what happened this time */
  }
}

/** Forget a failed automatic run, so the next query may start one again: after a
 * manual `graft build --deep` succeeded, or `graft auto-deep on`. A running or
 * successful run's record is kept. Returns whether a failure was cleared. */
export function clearAutoDeepFailure(root: string, contextDir?: string): boolean {
  const p = autoDeepPaths(root, contextDir);
  const s = readAutoDeepStatus(p);
  if (!s || s.state === "running" && autoDeepLockHeld(p)) return false;
  if (s.state === "succeeded") return false;
  try {
    rmSync(p.status);
  } catch {
    return false;
  }
  return true;
}

// ── lock ──────────────────────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

function lockStale(file: string): boolean {
  let age: number;
  try {
    age = Date.now() - statSync(file).mtimeMs;
  } catch {
    return true;
  }
  if (age >= LOCK_MAX_MS) return true;
  if (age < LOCK_GRACE_MS) return false;
  let pid: unknown;
  try {
    pid = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid;
  } catch {
    return true;
  }
  return !(typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pidAlive(pid));
}

function lockPayload(): string {
  return JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
}

/** Take the lock for one automatic run; false when a run already holds it. */
export function acquireAutoDeepLock(p: AutoDeepPaths): boolean {
  try {
    mkdirSync(p.cache, { recursive: true });
    writeFileSync(p.lock, lockPayload(), { flag: "wx" });
    return true;
  } catch (e: any) {
    if (e?.code !== "EEXIST" || !lockStale(p.lock)) return false;
    try {
      rmSync(p.lock);
    } catch {
      /* another process took it over */
    }
    try {
      writeFileSync(p.lock, lockPayload(), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }
}

/** The runner puts its own pid in the lock the query took for it. */
export function claimAutoDeepLock(p: AutoDeepPaths): void {
  try {
    writeFileSync(p.lock, lockPayload());
  } catch {
    /* the age rule still covers it */
  }
}

export function releaseAutoDeepLock(p: AutoDeepPaths): void {
  try {
    rmSync(p.lock);
  } catch {
    /* already gone */
  }
}

export function autoDeepLockHeld(p: AutoDeepPaths): boolean {
  return existsSync(p.lock) && !lockStale(p.lock);
}

// ── the rule ──────────────────────────────────────────────────────────────────

/** Whether an automatic run is due: something is out of date and the share has
 * reached `thresholdPct` (at or above, where the manual nudge waits for strictly
 * above). 100 still means never, as for the nudge. */
export function autoDeepDue(s: SummaryStaleness, thresholdPct: number): boolean {
  return thresholdPct < 100 && s.total > 0 && s.stale + s.unsummarized > 0 && outdatedPercent(s) >= thresholdPct;
}

function countsOf(s: SummaryStaleness, threshold: number): AutoDeepCounts {
  return { outdated: s.stale + s.unsummarized, total: s.total, percent: Math.round(outdatedPercent(s)), threshold };
}

const n = (x: number) => x.toLocaleString("en-US");

function clock(iso: string | undefined): string {
  if (!iso) return "?";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function what(c: AutoDeepCounts): string {
  return `${n(c.outdated)} of ${n(c.total)} node summaries (${c.percent}%) out of date, at or above the ${c.threshold}% deep-threshold`;
}

// ── the notes ─────────────────────────────────────────────────────────────────

export function startedNote(c: AutoDeepCounts, p: AutoDeepPaths): string {
  return (
    `${tag()} auto-deep: started \`${cmd("graft build --deep")}\` in the background — ${what(c)}. ` +
    `It is an LLM pass that costs tokens; the prose summaries refresh when it ends, there is nothing to run by hand. ` +
    `Output: ${p.log} (\`${cmd("graft auto-deep")}\` shows how it went, \`${cmd("graft auto-deep off")}\` stops future runs).`
  );
}

export function runningNote(s: AutoDeepStatus): string {
  return (
    `${tag()} auto-deep: the \`${cmd("graft build --deep")}\` started automatically at ${clock(s.startedAt)} is still running in the background — ` +
    `file:line answers are current, the prose summaries refresh when it ends; there is nothing to run by hand.`
  );
}

/** A failure's short form for the savings tally, which puts it in parentheses itself. */
function failedReason(s: AutoDeepStatus): string {
  const err = (s.error ?? "it ended with an error").replace(/[()]/g, "").replace(/\s+/g, " ").trim();
  const short = err.length > 160 ? `${err.slice(0, 157)}…` : err;
  return `the automatic deep build failed: ${short}; full output in ${s.log}`;
}

export function failedNote(s: AutoDeepStatus, now?: SummaryStaleness): string {
  const lag = now && now.total > 0 ? ` (${Math.round(outdatedPercent(now))}% of them out of date now)` : "";
  const how = s.exitCode !== undefined && s.exitCode !== null ? `, exit code ${s.exitCode}` : "";
  return (
    `${tag()} auto-deep: the automatic \`${cmd("graft build --deep")}\` FAILED (started ${clock(s.startedAt)}${how}): ` +
    `${s.error ?? "it ended with an error"}. ` +
    `Tell the user: automatic deep builds are paused until this is fixed, so the prose summaries stay out of date${lag}; file:line answers are current. ` +
    `Full output: ${s.log}. Once the cause is fixed, run \`${cmd("graft build --deep")}\` once, or \`${cmd("graft auto-deep on")}\` to let it retry by itself; ` +
    `\`${cmd("graft auto-deep off")}\` turns automatic runs off.`
  );
}

/** The detached runner, `./auto-deep-run.js` next to this module once compiled.
 * `GRAFT_TEST_AUTO_DEEP_RUN` points it at a stub. */
export function spawnAutoDeepRunner(job: AutoDeepJob): void {
  const run = process.env.GRAFT_TEST_AUTO_DEEP_RUN ?? fileURLToPath(new URL("./auto-deep-run.js", import.meta.url));
  if (!existsSync(run)) throw new Error(`graft's background runner is missing (${run}): reinstall graft`);
  const child = spawn(process.execPath, [run, JSON.stringify(job)], {
    cwd: job.root,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {
    /* the runner never wrote its pid: the next query finds the lock abandoned and reports it */
  });
  child.unref();
}

export interface DeepNotice {
  /** The line to print or append to a tool's answer. */
  note: string;
  /** Short reason for the savings tally's "Run graft build --deep" line, or
   * absent when the user has nothing to run (a run is under way). */
  reason?: string;
}

export interface DeepNoticeOptions {
  contextDir?: string;
  children?: string[];
  home?: string;
  /** False when this query must not write (`--no-refresh`, `GRAFT_NO_REFRESH`):
   * a due run is not started, and the manual nudge is shown instead. */
  mayStart?: boolean;
  /** Starts the runner; default {@link spawnAutoDeepRunner}. */
  start?: AutoDeepStarter;
}

/**
 * What a query says about the deep build: the manual nudge when auto-deep is off
 * (exactly as before), else the automatic run's state — started now, running,
 * failed — or nothing when it is on and has nothing to report. Never throws.
 */
export function deepNoticeFor(root: string, opts: DeepNoticeOptions = {}): DeepNotice | null {
  try {
    return notice(root, opts);
  } catch {
    return null;
  }
}

/** `GRAFT_NO_REFRESH`, the env kill switch for queries that write (`./refresh.ts`). */
function noRefreshEnv(): boolean {
  const v = process.env.GRAFT_NO_REFRESH;
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

function notice(root: string, opts: DeepNoticeOptions): DeepNotice | null {
  const manual = (): DeepNotice | null => deepDueFor(root, opts);
  if (!resolveAutoDeep(resolve(root), opts.home).value) return manual();
  if (process.env[AUTO_DEEP_CHILD_ENV]) return null;

  const p = autoDeepPaths(root, opts.contextDir);
  let status = readAutoDeepStatus(p);
  const st = deepStalenessFor(root, opts);

  if (status?.state === "running") {
    if (autoDeepLockHeld(p)) return { note: runningNote(status) };
    // The runner is gone and never said how it ended.
    status = {
      ...status,
      state: "failed",
      finishedAt: new Date().toISOString(),
      error: "the background run ended without reporting a result (it was stopped, or the machine restarted)",
    };
    writeAutoDeepStatus(p, status);
  }
  if (status?.state === "failed") return { note: failedNote(status, st?.staleness), reason: failedReason(status) };

  if (!st || !autoDeepDue(st.staleness, st.threshold)) return null;
  const s = st.staleness;
  // The last run left this much behind already: paying again for the same won't
  // change it. Say so the way it was said before auto-deep, by the manual nudge.
  if (status?.state === "succeeded" && status.after && s.stale + s.unsummarized <= status.after.outdated) return manual();
  if (opts.mayStart === false || noRefreshEnv()) return manual();

  if (!acquireAutoDeepLock(p)) {
    // Another query started one a moment ago and its record is not written yet.
    const other = readAutoDeepStatus(p);
    return other?.state === "running" ? { note: runningNote(other) } : null;
  }
  const counts = countsOf(s, st.threshold);
  const started: AutoDeepStatus = { state: "running", startedAt: new Date().toISOString(), trigger: counts, log: p.log };
  writeAutoDeepStatus(p, started);
  const job: AutoDeepJob = {
    root: resolve(root),
    ...(opts.contextDir ? { contextDir: opts.contextDir } : {}),
    ...(opts.children ? { children: opts.children } : {}),
    timeoutMs: AUTO_DEEP_TIMEOUT_MS,
    paths: p,
  };
  try {
    (opts.start ?? spawnAutoDeepRunner)(job);
  } catch (e) {
    releaseAutoDeepLock(p);
    const failed: AutoDeepStatus = {
      ...started,
      state: "failed",
      finishedAt: new Date().toISOString(),
      error: `couldn't start the background run: ${e instanceof Error ? e.message : String(e)}`,
    };
    writeAutoDeepStatus(p, failed);
    return { note: failedNote(failed, s), reason: failedReason(failed) };
  }
  return { note: startedNote(counts, p) };
}

// ── what a finished run reports ────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * The lines of a failed build's output that say why: its `✗`/`⚠` lines and their
 * indented details, else lines naming an error, else its last lines. Kept short
 * for a note; the log holds the rest.
 */
export function failureSummary(output: string, max = 600): string {
  const lines = output
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
  const picked: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (!/^[✗⚠]/.test(l)) continue;
    picked.push(l);
    // Its indented details, up to a few.
    for (let j = i + 1, k = 0; j < lines.length && k < 3 && /^\s+\S/.test(lines[j]!) && !/^\s*[✗⚠·✓]/.test(lines[j]!); j++, k++) {
      picked.push(lines[j]!.trim());
    }
  }
  const fromErrors = picked.length > 0 ? picked : lines.filter((l) => /\berror\b|\bfailed\b|\b4\d\d\b|\b5\d\d\b/i.test(l)).map((l) => l.trim());
  const chosen = fromErrors.length > 0 ? fromErrors : lines.slice(-4).map((l) => l.trim());
  const unique = [...new Set(chosen)];
  let text = unique.join(" · ");
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text;
}
