/**
 * When `graft init` or `graft build` (including `--deep`) fails, one closing
 * line on stderr points at this fork's issue tracker, so the user knows where
 * to report it and what to include.
 *
 * Nothing is sent: the line only prints an address (`ISSUES_URL`, the same one
 * `graft issues` opens).
 *
 * The line is printed once, by the outermost graft process. A build that
 * re-runs itself with a bigger heap, or the builds `init` runs as children,
 * inherit `REPORT_HINT_ENV` and stay quiet: the parent reports their failure.
 */
import { writeSync } from "node:fs";
import { ISSUES_URL } from "./about.js";
import { cmd } from "./brand.js";
import { GRAPH_TOO_LARGE_EXIT } from "./graph/size-guard.js";

/** Set in the environment by the process that will print the line, so its graft children don't. */
export const REPORT_HINT_ENV = "GRAFT_REPORT_HINT_PARENT";

/**
 * Exit codes that are not errors to report: success, an interrupt (Ctrl+C is
 * 130, a SIGTERM 143), and a repository too big for one map, whose own message
 * already names the way out.
 */
const NOT_REPORTED = new Set([0, 130, 143, GRAPH_TOO_LARGE_EXIT]);

/** Whether the line is due: a reportable exit code, or a failure the command recorded while still exiting 0. */
export function reportHintDue(code: number | undefined, failedQuietly: boolean): boolean {
  if (failedQuietly) return true;
  return typeof code === "number" && !NOT_REPORTED.has(code);
}

/** The text printed at the end of a failed `init` / `build`. */
export function reportHintText(version: string = cmd("graft --version")): string {
  return [
    "",
    "ℹ If this looks like a bug in graft, report it at the issue tracker of this fork, with all the details",
    `  (the command you ran, its full output, \`${version}\`):`,
    `  ${ISSUES_URL}`,
  ].join("\n");
}

/** Whether a command run is one the line is for: `init`, or `build` other than its `--check` (a stale map is a CI verdict, not an error). */
export function reportHintApplies(command: string, opts: { check?: boolean }): boolean {
  if (command === "init") return true;
  return command === "build" && !opts.check;
}

let armed = false;
let failedQuietly = false;

/**
 * Prints the line when this process exits with a reportable code. A no-op when
 * a parent graft process already took that job (see `REPORT_HINT_ENV`).
 */
export function armReportHint(env: NodeJS.ProcessEnv = process.env): boolean {
  if (armed || env[REPORT_HINT_ENV]) return false;
  armed = true;
  env[REPORT_HINT_ENV] = "1";
  process.on("exit", (code) => {
    if (!reportHintDue(code, failedQuietly)) return;
    try {
      // Synchronous: an `exit` handler cannot wait for an asynchronous stderr write.
      writeSync(2, reportHintText() + "\n");
    } catch {
      /* stderr closed: nothing to tell */
    }
  });
  return true;
}

/** Records a failure the command reports but still exits 0 for (a graph build `init` could not finish). */
export function noteFailureForReport(): void {
  failedQuietly = true;
}

/**
 * A child `graft build` that ended with `status` (null when a signal or a
 * timeout stopped it): recorded as a failure when that status is one the line
 * is for. The child itself stays quiet (it inherits `REPORT_HINT_ENV`).
 * Returns whether it was recorded.
 */
export function noteChildBuildFailure(status: number | null | undefined): boolean {
  if (!reportHintDue(status ?? undefined, false)) return false;
  noteFailureForReport();
  return true;
}
