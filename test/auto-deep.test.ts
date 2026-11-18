/**
 * Auto-deep (`graph/auto-deep.ts`): `graft build --deep` started by itself once
 * out-of-date summaries reach the deep-threshold — off by default, one run at a
 * time, no retry after a failure, and failures reported on every query.
 */
import "./isolate.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import {
  acquireAutoDeepLock,
  autoDeepDue,
  autoDeepLockHeld,
  autoDeepPaths,
  clearAutoDeepFailure,
  deepNoticeFor,
  failureSummary,
  readAutoDeepStatus,
  releaseAutoDeepLock,
  writeAutoDeepStatus,
  type AutoDeepJob,
} from "../src/graph/auto-deep.js";
import { deepDueFor } from "../src/graph/refresh.js";
import { formatConfigList } from "../src/config-cli.js";
import { patchBuildConfig, patchGlobalSettings, readBuildConfig, resolveAutoDeep } from "../src/util/state.js";
import { runCli } from "./helpers.js";

const MATH = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "graft-autodeep-"));
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "math.ts"), MATH);
  return d;
}

/** A scratch `~`, so a real `~/.graft/settings.json` can never steer these tests. */
const scratchHome = (): string => mkdtempSync(join(tmpdir(), "graft-home-"));

const counts = (stale: number, unsummarized: number, total: number, summarized = total - unsummarized) => ({
  stale,
  unsummarized,
  total,
  summarized,
});

/** A repo built with plain `graft build`: every summary is pending (100% out of date). */
async function builtRepo(): Promise<{ d: string; home: string }> {
  const d = repo();
  await buildGraph(d);
  return { d, home: scratchHome() };
}

/** A starter that records its jobs instead of spawning anything. */
function recorder(): { jobs: AutoDeepJob[]; start: (j: AutoDeepJob) => void } {
  const jobs: AutoDeepJob[] = [];
  return { jobs, start: (j) => void jobs.push(j) };
}

test("resolveAutoDeep: off by default, the global value, then the repo's own — only real booleans count", () => {
  const d = repo();
  const home = scratchHome();
  assert.deepEqual(resolveAutoDeep(d, home), { value: false, source: "default" });
  patchGlobalSettings({ autoDeep: true }, home);
  assert.deepEqual(resolveAutoDeep(d, home), { value: true, source: "global" });
  patchBuildConfig(d, { autoDeep: false });
  assert.deepEqual(resolveAutoDeep(d, home), { value: false, source: "repo" });
  patchBuildConfig(d, { autoDeep: "yes" as unknown as boolean });
  assert.deepEqual(resolveAutoDeep(d, home), { value: true, source: "global" }, "a hand-edited non-boolean falls through");
  patchGlobalSettings({ autoDeep: 1 as unknown as boolean }, home);
  assert.deepEqual(resolveAutoDeep(d, home), { value: false, source: "default" });
});

test("autoDeepDue: at or above the threshold, never at 100, never with nothing out of date", () => {
  assert.equal(autoDeepDue(counts(1, 0, 10), 10), true, "exactly the threshold starts it (the nudge waits for above)");
  assert.equal(autoDeepDue(counts(0, 0, 10), 0), false, "nothing out of date");
  assert.equal(autoDeepDue(counts(0, 1, 1000), 0), true);
  assert.equal(autoDeepDue(counts(5, 5, 10), 100), false, "100 = never");
  assert.equal(autoDeepDue(counts(0, 10, 10, 0), 100), false);
  assert.equal(autoDeepDue(counts(2, 2, 10), 50), false);
  assert.equal(autoDeepDue(counts(0, 0, 0), 0), false, "no graph");
});

test("auto-deep off: the notice is exactly the manual nudge, and nothing starts", async () => {
  const { d, home } = await builtRepo();
  const r = recorder();
  const n = deepNoticeFor(d, { home, start: r.start });
  assert.deepEqual(n, deepDueFor(d, { home }));
  assert.match(n?.note ?? "", /recommended/);
  assert.equal(r.jobs.length, 0);
});

test("auto-deep on: a due query starts one run, hides the manual nudge, and later queries see it running", async () => {
  const { d, home } = await builtRepo();
  patchBuildConfig(d, { autoDeep: true });
  const r = recorder();

  const first = deepNoticeFor(d, { home, start: r.start });
  assert.equal(r.jobs.length, 1, "one run started");
  assert.equal(r.jobs[0]!.root, resolve(d));
  assert.match(first?.note ?? "", /auto-deep: started `graft build --deep` in the background — \d+ of \d+ node summaries \(100%\) out of date, at or above the 10% deep-threshold/);
  assert.match(first?.note ?? "", /costs tokens/);
  assert.equal(first?.reason, undefined, "nothing for the user to run: the tally gets no build --deep line");
  assert.doesNotMatch(first?.note ?? "", /is recommended/);

  const p = autoDeepPaths(d);
  assert.equal(readAutoDeepStatus(p)?.state, "running");
  assert.ok(autoDeepLockHeld(p), "the query took the lock for the runner");

  const again = deepNoticeFor(d, { home, start: r.start });
  assert.equal(r.jobs.length, 1, "no second run while one holds the lock");
  assert.match(again?.note ?? "", /auto-deep: the `graft build --deep` started automatically at .* is still running/);
  assert.equal(again?.reason, undefined);
  releaseAutoDeepLock(p);
});

test("a run that died without reporting, or failed, is reported on every query and never retried by itself", async () => {
  const { d, home } = await builtRepo();
  patchBuildConfig(d, { autoDeep: true });
  const r = recorder();
  deepNoticeFor(d, { home, start: r.start });
  const p = autoDeepPaths(d);
  // The runner is gone: its lock is released but the record still says running.
  releaseAutoDeepLock(p);

  const died = deepNoticeFor(d, { home, start: r.start });
  assert.match(died?.note ?? "", /auto-deep: the automatic `graft build --deep` FAILED .*ended without reporting a result/);
  assert.match(died?.note ?? "", /Tell the user/);
  assert.match(died?.reason ?? "", /^the automatic deep build failed: .*; full output in /);
  assert.equal(readAutoDeepStatus(p)?.state, "failed");

  for (let i = 0; i < 3; i++) {
    const still = deepNoticeFor(d, { home, start: r.start });
    assert.match(still?.note ?? "", /FAILED/);
  }
  assert.equal(r.jobs.length, 1, "no automatic retry after a failure");

  // A recorded error with parentheses still makes a tally reason without them.
  writeAutoDeepStatus(p, { ...readAutoDeepStatus(p)!, error: "⚠ no API key set (GRAFT_API_KEY) — falling back", exitCode: 1 });
  const keyless = deepNoticeFor(d, { home, start: r.start });
  assert.match(keyless?.note ?? "", /exit code 1\): ⚠ no API key set \(GRAFT_API_KEY\)/);
  assert.doesNotMatch(keyless?.reason ?? "", /[()]/, "the tally wraps the reason in parentheses already");

  assert.equal(clearAutoDeepFailure(d), true);
  deepNoticeFor(d, { home, start: r.start });
  assert.equal(r.jobs.length, 2, "cleared: the next due query starts a run again");
  releaseAutoDeepLock(p);
});

test("a runner that can't start is reported as a failure, and the lock is let go", async () => {
  const { d, home } = await builtRepo();
  patchBuildConfig(d, { autoDeep: true });
  const n = deepNoticeFor(d, {
    home,
    start: () => {
      throw new Error("no runner here");
    },
  });
  assert.match(n?.note ?? "", /FAILED .*couldn't start the background run: no runner here/);
  assert.match(n?.reason ?? "", /couldn't start the background run/);
  assert.equal(autoDeepLockHeld(autoDeepPaths(d)), false);
});

test("--no-refresh, a lock held elsewhere, and what a successful run left behind start nothing", async () => {
  const { d, home } = await builtRepo();
  patchBuildConfig(d, { autoDeep: true });
  const r = recorder();

  const ro = deepNoticeFor(d, { home, start: r.start, mayStart: false });
  assert.deepEqual(ro, deepDueFor(d, { home }), "a query that must not write gets the manual nudge");
  assert.equal(r.jobs.length, 0);

  const p = autoDeepPaths(d);
  assert.ok(acquireAutoDeepLock(p));
  assert.equal(deepNoticeFor(d, { home, start: r.start }), null, "another query is starting one");
  assert.equal(r.jobs.length, 0);
  releaseAutoDeepLock(p);

  // A run that succeeded but left as many summaries out of date as there are now.
  writeAutoDeepStatus(p, {
    state: "succeeded",
    startedAt: new Date().toISOString(),
    after: { outdated: 1_000_000, total: 1_000_000 },
    log: p.log,
  });
  const left = deepNoticeFor(d, { home, start: r.start });
  assert.equal(r.jobs.length, 0, "not paid for again");
  assert.match(left?.note ?? "", /recommended/, "said the way it was before auto-deep");

  patchBuildConfig(d, { deepStaleThreshold: 100 });
  writeAutoDeepStatus(p, { state: "succeeded", startedAt: new Date().toISOString(), log: p.log });
  assert.equal(deepNoticeFor(d, { home, start: r.start }), null, "100 = never, also for auto-deep");
  assert.equal(r.jobs.length, 0);
});

test("failureSummary keeps the build's ✗/⚠ lines and their details, else error lines, else the tail", () => {
  const out = [
    "graft auto-deep: 2026-01-01 — graft build --deep /r",
    "",
    "\x1b[33m⚠ no API key set, so falling back to the structural build (no LLM summaries).\x1b[0m",
    "  Set GRAFT_API_KEY (`graft api key`), then re-run.",
    "✗ the automatic deep build stopped: it can't write summaries until the cause above is fixed.",
  ].join("\n");
  assert.equal(
    failureSummary(out),
    "⚠ no API key set, so falling back to the structural build (no LLM summaries). · Set GRAFT_API_KEY (`graft api key`), then re-run. · ✗ the automatic deep build stopped: it can't write summaries until the cause above is fixed.",
  );
  assert.equal(failureSummary("building\nError: 401 Unauthorized\ndone"), "Error: 401 Unauthorized");
  assert.equal(failureSummary("a\nb\nc\nd\ne"), "b · c · d · e");
  assert.ok(failureSummary("✗ " + "x".repeat(2000)).length <= 600);
});

test("the runner records a failed build with its reason and lets the lock go", () => {
  const d = repo();
  const p = autoDeepPaths(d);
  mkdirSync(p.cache, { recursive: true });
  const stub = join(d, "cli-stub.mjs");
  writeFileSync(
    stub,
    "console.log('argv:' + JSON.stringify(process.argv.slice(2)) + ' child=' + process.env.GRAFT_AUTO_DEEP_RUN);\n" +
      "console.error('⚠ no API key set, so falling back to the structural build (no LLM summaries).');\n" +
      "process.exit(1);\n",
  );
  assert.ok(acquireAutoDeepLock(p));
  writeAutoDeepStatus(p, { state: "running", startedAt: new Date().toISOString(), log: p.log });
  const job: AutoDeepJob = { root: d, timeoutMs: 240_000, paths: p };
  const run = spawnSync(process.execPath, ["--import", "tsx", "src/graph/auto-deep-run.ts", JSON.stringify(job)], {
    encoding: "utf8",
    timeout: 240_000,
    env: { ...process.env, GRAFT_TEST_CLI: stub },
  });
  assert.equal(run.status, 0, run.stderr);
  const s = readAutoDeepStatus(p);
  assert.equal(s?.state, "failed");
  assert.equal(s?.exitCode, 1);
  assert.match(s?.error ?? "", /^⚠ no API key set/);
  assert.ok(s?.finishedAt);
  assert.equal(autoDeepLockHeld(p), false, "the lock is released however it ends");
  const log = readFileSync(p.log, "utf8");
  assert.match(log, /argv:\["build",".*","--deep"\] child=1/, "the real build, marked as an automatic run");
});

test("the runner records a successful build with what it left out of date", async () => {
  const d = repo();
  await buildGraph(d);
  const p = autoDeepPaths(d);
  const stub = join(d, "cli-stub.mjs");
  writeFileSync(stub, "console.log('deep build done');\n");
  writeAutoDeepStatus(p, { state: "running", startedAt: new Date().toISOString(), log: p.log });
  const job: AutoDeepJob = { root: d, timeoutMs: 240_000, paths: p };
  const run = spawnSync(process.execPath, ["--import", "tsx", "src/graph/auto-deep-run.ts", JSON.stringify(job)], {
    encoding: "utf8",
    timeout: 240_000,
    env: { ...process.env, GRAFT_TEST_CLI: stub },
  });
  assert.equal(run.status, 0, run.stderr);
  const s = readAutoDeepStatus(p);
  assert.equal(s?.state, "succeeded");
  assert.equal(s?.exitCode, 0);
  assert.ok(s?.after && s.after.total > 0 && s.after.outdated === s.after.total, "the stub wrote no summaries");
});

test("graft auto-deep: warns about the cost, refuses without a terminal or --yes, sets, shows and resets", async () => {
  const { d, home } = await builtRepo();
  const cli = (...args: string[]) => runCli(["auto-deep", ...args], { home });

  const shown = cli(d);
  assert.equal(shown.status, 0, shown.describe());
  assert.match(shown.stdout, /^auto-deep: off \(default\)/);

  const refused = cli("on", d);
  assert.equal(refused.status, 1, refused.describe());
  assert.match(refused.stderr, /⚠ auto-deep runs `graft build --deep` by itself/);
  assert.match(refused.stderr, /spends AI tokens/);
  assert.match(refused.stderr, /the next graft query starts a run/);
  assert.match(refused.stderr, /✗ auto-deep was not turned on: confirm with `graft auto-deep on --yes`/);
  assert.equal(readBuildConfig(d)?.autoDeep, undefined, "nothing written");

  const on = cli("on", d, "--yes");
  assert.equal(on.status, 0, on.describe());
  assert.match(on.stderr, /spends AI tokens/, "the warning is printed even with --yes");
  assert.match(on.stdout, /^auto-deep: on \(this repo, /);
  assert.equal(readBuildConfig(d)?.autoDeep, true);
  assert.match(formatConfigList(d, home), /autoDeep: on\n/);

  const bad = cli("maybe", d);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /"maybe" is not on or off/);

  const off = cli("off", d);
  assert.equal(off.status, 0, off.describe());
  assert.doesNotMatch(off.stderr, /spends AI tokens/, "turning it off needs no warning");
  assert.equal(readBuildConfig(d)?.autoDeep, false);

  const reset = cli("--reset", d);
  assert.equal(reset.status, 0, reset.describe());
  assert.equal(readBuildConfig(d)?.autoDeep, undefined);
  assert.match(formatConfigList(d, home), /autoDeep: off \(default\)/);
});

test("over MCP: no deep-build line in the tally while a run is under way; a failure rides in it", async () => {
  const home = scratchHome();
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, RUN: process.env.GRAFT_TEST_AUTO_DEEP_RUN };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const d = repo();
    // Big enough that the answer is smaller than the file, so a tally is printed.
    writeFileSync(join(d, "src", "big.ts"), "// padding line for the savings baseline\n".repeat(1500) + "export function mul(a: number, b: number): number {\n  return a * b;\n}\n");
    await buildGraph(d);
    patchBuildConfig(d, { autoDeep: true });
    // A runner that never finishes on its own: it leaves the lock and the record as they are.
    const stub = join(d, "runner-stub.mjs");
    writeFileSync(stub, "process.exit(0);\n");
    process.env.GRAFT_TEST_AUTO_DEEP_RUN = stub;
    const { callTool } = await import("../src/mcp/tools.js");

    const started = await callTool(d, "graft_find_code", { query: "mul" });
    assert.ok(started.text.includes("\u{1F331}"), `fixture: a saving was claimed\n${started.text}`);
    assert.match(started.text, /auto-deep: started `graft build --deep` in the background/);
    assert.doesNotMatch(started.text, /Run the 'graft build --deep' command/);

    const running = await callTool(d, "graft_find_code", { query: "mul" });
    assert.match(running.text, /is still running in the background/);
    assert.doesNotMatch(running.text, /Run the 'graft build --deep' command/);

    const p = autoDeepPaths(d);
    releaseAutoDeepLock(p);
    writeAutoDeepStatus(p, { ...readAutoDeepStatus(p)!, state: "failed", exitCode: 1, error: "✗ the deep pass did not complete · summaries: 401 Unauthorized" });
    const failed = await callTool(d, "graft_find_code", { query: "mul" });
    assert.match(failed.text, /auto-deep: the automatic `graft build --deep` FAILED .*401 Unauthorized/);
    assert.match(failed.text, /⚠️ Run the 'graft build --deep' command — recommended \(the automatic deep build failed: .*401 Unauthorized; full output in /);
  } finally {
    for (const [k, v] of Object.entries({ HOME: saved.HOME, USERPROFILE: saved.USERPROFILE, GRAFT_TEST_AUTO_DEEP_RUN: saved.RUN })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("a CLI query with auto-deep on starts the runner instead of printing the recommendation", async () => {
  const { d, home } = await builtRepo();
  patchBuildConfig(d, { autoDeep: true });
  const marker = join(d, "runner-started.json");
  const stub = join(d, "runner-stub.mjs");
  writeFileSync(
    stub,
    "import { writeFileSync, rmSync } from 'node:fs';\n" +
      "const job = JSON.parse(process.argv[2]);\n" +
      `writeFileSync(${JSON.stringify(marker)}, JSON.stringify(job));\n` +
      "writeFileSync(job.paths.status, JSON.stringify({ state: 'succeeded', startedAt: new Date().toISOString(), log: job.paths.log }));\n" +
      "rmSync(job.paths.lock, { force: true });\n",
  );
  const q = runCli(["skeleton", "src/math.ts", d], { home, env: { GRAFT_TEST_AUTO_DEEP_RUN: stub } });
  assert.equal(q.status, 0, q.describe());
  assert.match(q.stderr, /auto-deep: started `graft build --deep` in the background/);
  assert.doesNotMatch(q.stderr + q.stdout, /is recommended/);
  assert.doesNotMatch(q.stdout + q.stderr, /Run the 'graft build --deep' command/);
  const deadline = Date.now() + 15_000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(existsSync(marker), "the detached runner ran");
  assert.equal(JSON.parse(readFileSync(marker, "utf8")).root, resolve(d));
});
