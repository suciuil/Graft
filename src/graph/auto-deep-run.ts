/**
 * `node auto-deep-run.js '<json>'`: one automatic `graft build --deep`
 * (`./auto-deep.ts`), detached from the query that started it. It runs the real
 * CLI, so the build is exactly the one the user would run by hand, writes its
 * output to `.cache/auto-deep.log`, and records how it ended in
 * `.cache/auto-deep.json`, which the next query reports — a failure loudly.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { constants, setPriority } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AUTO_DEEP_CHILD_ENV,
  claimAutoDeepLock,
  failureSummary,
  readAutoDeepStatus,
  releaseAutoDeepLock,
  writeAutoDeepStatus,
  type AutoDeepJob,
  type AutoDeepStatus,
} from "./auto-deep.js";
import { deepStalenessFor } from "./refresh.js";

/** graft's own CLI, next to this module once compiled. `GRAFT_TEST_CLI` points it at a stub. */
function cliPath(): string {
  return process.env.GRAFT_TEST_CLI ?? fileURLToPath(new URL("../cli.js", import.meta.url));
}

function readLog(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** How the build ended, as the record the next query reports. */
export function outcome(job: AutoDeepJob, base: AutoDeepStatus, r: Pick<SpawnSyncReturns<unknown>, "status" | "signal" | "error">, log: string): AutoDeepStatus {
  const finishedAt = new Date().toISOString();
  const err = r.error as (Error & { code?: string }) | undefined;
  if (err?.code === "ETIMEDOUT") {
    return { ...base, state: "failed", finishedAt, exitCode: null, error: `it was stopped after running for ${Math.round(job.timeoutMs / 60_000)} minutes, its time limit` };
  }
  if (err) return { ...base, state: "failed", finishedAt, exitCode: null, error: `couldn't run graft: ${err.message}` };
  if (r.status !== 0) {
    const why = failureSummary(log) || (r.signal ? `it was ended by ${r.signal}` : `graft exited with code ${r.status}`);
    return { ...base, state: "failed", finishedAt, exitCode: r.status, error: why };
  }
  const after = deepStalenessFor(job.root, { contextDir: job.contextDir, children: job.children });
  return {
    ...base,
    state: "succeeded",
    finishedAt,
    exitCode: 0,
    ...(after ? { after: { outdated: after.staleness.stale + after.staleness.unsummarized, total: after.staleness.total } } : {}),
  };
}

export function main(arg: string): void {
  const job = JSON.parse(arg) as AutoDeepJob;
  const p = job.paths;
  // The person's own work goes first; the build inherits the priority.
  try {
    setPriority(constants.priority.PRIORITY_LOW);
  } catch {
    /* runs at normal priority */
  }
  claimAutoDeepLock(p);
  const base: AutoDeepStatus = {
    ...(readAutoDeepStatus(p) ?? { state: "running", startedAt: new Date().toISOString(), log: p.log }),
    state: "running",
    pid: process.pid,
    log: p.log,
  };
  writeAutoDeepStatus(p, base);
  let status: AutoDeepStatus = base;
  try {
    const args = [cliPath(), "build", job.root, "--deep", ...(job.contextDir ? ["--dir", job.contextDir] : [])];
    let fd: number | null = null;
    try {
      fd = openSync(p.log, "w");
      writeSync(fd, `graft auto-deep: ${new Date().toISOString()} — graft build --deep ${job.root}\n\n`);
    } catch {
      fd = null;
    }
    let r: Pick<SpawnSyncReturns<unknown>, "status" | "signal" | "error">;
    try {
      r = spawnSync(process.execPath, args, {
        cwd: job.root,
        stdio: ["ignore", fd ?? "ignore", fd ?? "ignore"],
        timeout: job.timeoutMs,
        killSignal: "SIGTERM",
        windowsHide: true,
        env: { ...process.env, [AUTO_DEEP_CHILD_ENV]: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      });
    } finally {
      if (fd !== null) closeSync(fd);
    }
    status = outcome(job, base, r, readLog(p.log));
  } catch (e) {
    status = { ...base, state: "failed", finishedAt: new Date().toISOString(), exitCode: null, error: `the background run broke: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    writeAutoDeepStatus(p, status);
    releaseAutoDeepLock(p);
  }
}

// Run only when executed directly, not on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv[2] ?? "{}");
  } catch {
    /* nothing to report to: the next query finds the lock abandoned and says so */
  }
}
