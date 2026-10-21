/**
 * The pre-query freshness gate. Two things matter: it notices working-tree edits
 * that nobody committed (or even made through the agent), and it never turns a
 * working query into a failing one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import {
  deepDueFor,
  deepDueReason,
  deepNoteFor,
  deepRebuildDue,
  deepRebuildNote,
  ensureFreshChildren,
  ensureFreshGraph,
  formatStalenessReport,
  outdatedPercent,
  refreshNote,
  stalenessReport,
  summaryStaleness,
} from "../src/graph/refresh.js";
import { extractCachePath } from "../src/graph/extract-cache.js";
import { fingerprintPath, isClean, probeDrift } from "../src/graph/fingerprint.js";
import { readGraph, wiringPath, writeGraph } from "../src/graph/write.js";
import {
  acquireLock,
  emptyStats,
  ensureDefaultBuildConfig,
  patchBuildConfig,
  patchGlobalSettings,
  readBuildConfig,
  readGlobalSettings,
  readStats,
  releaseLock,
  resolveDeepStaleThreshold,
  writeStats,
} from "../src/util/state.js";
import { callTool } from "../src/mcp/tools.js";
import type { GraphV1 } from "../src/graph/types.js";
import { chmodDenialUnavailable, runCli } from "./helpers.js";

const MATH = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
/** A *function*, because a plain `export const` is not extracted as a symbol node. */
const MUL = "export function mul(a: number, b: number): number {\n  return a * b;\n}\n";

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "graft-refresh-"));
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "math.ts"), MATH);
  return d;
}

const outOf = (d: string): string => join(d, "graft");
const graphOf = (d: string): GraphV1 => readGraph(wiringPath(outOf(d))) as GraphV1;
const hasSymbol = (d: string, id: string): boolean => graphOf(d).nodes.some((n) => n.id === id);

/** Each test owns the env switch; `graph-load.test.ts` sets it process-wide for
 * its own file, and these run in a separate process. */
function withRefreshDisabled<T>(fn: () => T): T {
  process.env.GRAFT_NO_REFRESH = "1";
  try {
    return fn();
  } finally {
    delete process.env.GRAFT_NO_REFRESH;
  }
}

test("probeDrift: clean after a build, then reports what moved", async () => {
  const d = repo();
  await buildGraph(d);
  const clean = probeDrift(d, outOf(d));
  assert.ok(clean && isClean(clean));

  writeFileSync(join(d, "src", "math.ts"), `${MATH}export const X = 1;\n`);
  writeFileSync(join(d, "src", "new.ts"), "export const N = 2;\n");
  const drift = probeDrift(d, outOf(d));
  assert.deepEqual(drift, { changed: ["src/math.ts"], added: ["src/new.ts"], removed: [] });

  rmSync(join(d, "src", "new.ts"));
  rmSync(join(d, "src", "math.ts"));
  assert.deepEqual(probeDrift(d, outOf(d)), { changed: [], added: [], removed: ["src/math.ts"] });
});

test("probeDrift returns null when no fingerprint was ever written", () => {
  const d = repo();
  mkdirSync(outOf(d), { recursive: true });
  assert.equal(probeDrift(d, outOf(d)), null);
});

test("ensureFreshGraph picks up an uncommitted edit before the query sees the graph", async () => {
  const d = repo();
  await buildGraph(d);
  assert.equal(hasSymbol(d, "src/math.ts#mul"), false);

  // Exactly the state that used to answer stale: a file edited in the working
  // tree, nothing committed, no hook having flagged anything.
  writeFileSync(join(d, "src", "math.ts"), `${MATH}export function mul(a: number, b: number): number {\n  return a * b;\n}\n`);

  const r = await ensureFreshGraph(d);
  assert.equal(r.refreshed, true);
  assert.deepEqual(r.drift?.changed, ["src/math.ts"]);
  assert.equal(hasSymbol(d, "src/math.ts#mul"), true);
  assert.match(refreshNote(r) ?? "", /^\[graft\] refreshed the graph \(1 file changed\)/);
});

test("ensureFreshGraph is a no-op on a clean tree", async () => {
  const d = repo();
  await buildGraph(d);
  const before = readFileSync(wiringPath(outOf(d)), "utf8");
  const r = await ensureFreshGraph(d);
  assert.equal(r.refreshed, false);
  assert.equal(refreshNote(r), null, "silence when there is nothing to say");
  assert.equal(readFileSync(wiringPath(outOf(d)), "utf8"), before, "the graph is not even rewritten");
});

test("ensureFreshGraph rebuilds once when the graph predates the fingerprint", async () => {
  const d = repo();
  await buildGraph(d);
  rmSync(fingerprintPath(outOf(d)));

  const first = await ensureFreshGraph(d);
  assert.equal(first.refreshed, true, "no fingerprint = unknown state, so rebuild");
  assert.equal(first.drift, undefined);
  // ...and that rebuild lays one down, so it costs one build, not one per query.
  const second = await ensureFreshGraph(d);
  assert.equal(second.refreshed, false);
});

test("ensureFreshGraph does nothing when there is no graph at all", async () => {
  const d = repo();
  const r = await ensureFreshGraph(d);
  assert.equal(r.refreshed, false);
  assert.equal(probeDrift(d, outOf(d)), null, "and it did not build one behind the user's back");
});

test("GRAFT_NO_REFRESH and { disabled } both short-circuit", async () => {
  const d = repo();
  await buildGraph(d);
  writeFileSync(join(d, "src", "math.ts"), `${MATH}export const X = 1;\n`);

  const off = await withRefreshDisabled(() => ensureFreshGraph(d));
  assert.equal(off.refreshed, false);
  const flagged = await ensureFreshGraph(d, { disabled: true });
  assert.equal(flagged.refreshed, false);
  assert.equal(hasSymbol(d, "src/math.ts#X"), false, "the graph must be untouched");

  const on = await ensureFreshGraph(d);
  assert.equal(on.refreshed, true);
});

test("a rebuild already in flight is waited out, then reported — never a hang", async () => {
  const d = repo();
  await buildGraph(d);
  writeFileSync(join(d, "src", "math.ts"), `${MATH}export const X = 1;\n`);

  assert.equal(acquireLock(d), true, "hold the lock the way a background sync would");
  const started = Date.now();
  const r = await ensureFreshGraph(d);
  const waited = Date.now() - started;
  releaseLock(d);

  assert.equal(r.refreshed, false);
  assert.match(r.note ?? "", /already in flight/);
  assert.ok(waited >= 1000 && waited < 10000, `should wait out the lock briefly, waited ${waited}ms`);
});

/**
 * The gate must leave `stats.json` completely alone, and this is load-bearing rather
 * than merely tidy. `handleStop` only spawns the end-of-turn `graft build` when
 * `stats.dirty` is set. A refresh writes the graph but deliberately not the markdown
 * projections, so if it cleared `dirty` — which is exactly what "flip the statusline
 * to ✓ synced mid-turn" would mean — the one thing that rebuilds `graft/`'s cards
 * and INDEX.md would stop running, and the passive surface an agent greps would
 * never catch up.
 */
test("a refresh leaves the statusline stats alone, so the Stop hook still fires", async () => {
  const d = repo();
  await buildGraph(d);
  writeFileSync(join(d, "src", "math.ts"), `${MATH}export const X = 1;\n`);

  // No stats file (a repo with no Claude Code wiring): nothing is created.
  await ensureFreshGraph(d);
  assert.equal(readStats(d), null);

  writeStats(d, { ...emptyStats(), dirty: true, staleCount: 3 });
  writeFileSync(join(d, "src", "math.ts"), `${MATH}export const Y = 2;\n`);
  const r = await ensureFreshGraph(d);
  assert.equal(r.refreshed, true, "the graph itself was rebuilt");

  const s = readStats(d);
  assert.equal(s?.dirty, true, "still dirty — the passive surface has not been rebuilt");
  assert.equal(s?.staleCount, 3, "and the edit hook's count is not overwritten");
  assert.equal(s?.syncedAt, null);
});

test("a failed rebuild still answers from the graph on disk", async (t) => {
  // Windows lands here too, not just root: the denial below is a directory mode, and
  // Windows ignores those outright (see the helper). Before writeGraph became atomic
  // this test denied by chmod-ing the FILE, which Windows *does* honour — so the
  // Windows leg used to pass, and silently started replacing the read-only graph
  // through the rename instead. Skipping says so rather than asserting vacuously.
  const why = chmodDenialUnavailable();
  if (why) return t.skip(why);
  const d = repo();
  await buildGraph(d);
  const before = readFileSync(wiringPath(outOf(d)), "utf8");
  writeFileSync(join(d, "src", "math.ts"), `${MATH}export const X = 1;\n`);

  // Make the graph write itself fail: the query must degrade to the old graph, not
  // start erroring because a rebuild couldn't happen. writeGraph is atomic (temp +
  // rename), and a rename can replace a read-only FILE, so the unwritable target has
  // to be the DIRECTORY — which is also the realistic "can't write here" case.
  const graphDir = dirname(wiringPath(outOf(d)));
  chmodSync(graphDir, 0o500); // r-x: the temp write fails, old wiring.json stays put
  const r = await ensureFreshGraph(d);
  chmodSync(graphDir, 0o700);

  assert.equal(r.refreshed, false);
  assert.match(r.note ?? "", /refresh skipped/);
  assert.equal(readFileSync(wiringPath(outOf(d)), "utf8"), before, "the old graph is intact");
  assert.match(refreshNote(r) ?? "", /^\[graft\] graph refresh skipped/);

  // The lock must have been released, or every later query would report a
  // rebuild-in-flight that will never finish.
  assert.equal(acquireLock(d), true);
  releaseLock(d);
});

/**
 * The probe and the builder must agree on what "unchanged" means, in both
 * directions. Each of the next three tests is a case where they didn't, and the
 * graph went permanently stale while every surface reported healthy.
 */
test("GRAFT_REFRESH=hash: drift the probe reports is drift the rebuild repairs", async () => {
  const d = repo();
  await buildGraph(d);
  const f = join(d, "src", "math.ts");

  // The state mtime-preserving tooling leaves behind: new bytes, but both sidecars
  // recording the file's current `(size, mtimeMs)` against its *old* hash. Written
  // out directly rather than via `utimesSync`, which takes float seconds and can't
  // put a millisecond mtime back exactly.
  const swapped = MATH.replace("add", "sum");
  assert.equal(swapped.length, MATH.length, "fixture must be a same-size rewrite");
  writeFileSync(f, swapped);
  const now = statSync(f);
  const fp = JSON.parse(readFileSync(fingerprintPath(outOf(d)), "utf8"));
  const staleHash = fp.files["src/math.ts"][2];
  fp.files["src/math.ts"] = [now.size, now.mtimeMs, staleHash];
  writeFileSync(fingerprintPath(outOf(d)), JSON.stringify(fp));
  const memo = JSON.parse(readFileSync(extractCachePath(outOf(d)), "utf8"));
  Object.assign(memo.files["src/math.ts"], { size: now.size, mtimeMs: now.mtimeMs });
  writeFileSync(extractCachePath(outOf(d)), JSON.stringify(memo));

  // Nobody notices without the flag — that's the documented trade-off, and the
  // whole reason the flag exists.
  assert.ok(isClean(probeDrift(d, outOf(d))!));

  process.env.GRAFT_REFRESH = "hash";
  try {
    assert.deepEqual(probeDrift(d, outOf(d)), { changed: ["src/math.ts"], added: [], removed: [] });
    const r = await ensureFreshGraph(d);
    assert.equal(r.refreshed, true);
    // The bug: the probe hashed, the builder trusted the stat, so the rebuild
    // replayed the old parse and the next probe reported the same drift forever.
    assert.equal(hasSymbol(d, "src/math.ts#sum"), true, "the rebuild must actually re-parse it");
    assert.equal(hasSymbol(d, "src/math.ts#add"), false);
    assert.ok(isClean(probeDrift(d, outOf(d))!), "and the drift is now gone, not permanent");
  } finally {
    delete process.env.GRAFT_REFRESH;
  }
});

test("a file that becomes readable again is picked up through the probe", async (t) => {
  const why = chmodDenialUnavailable();
  if (why) return t.skip(why);
  const d = repo();
  const hidden = join(d, "src", "hidden.ts");
  writeFileSync(hidden, "export function reachable(): number {\n  return 1;\n}\n");
  chmodSync(hidden, 0o000);
  await buildGraph(d);
  assert.equal(hasSymbol(d, "src/hidden.ts#reachable"), false);

  // Recorded-but-unreadable must not read as new on every query...
  assert.ok(isClean(probeDrift(d, outOf(d))!), "an unreadable file doesn't churn the probe");

  // ...but a chmod changes neither size nor mtime, so trusting the stat here left
  // the file permanently missing from the graph.
  chmodSync(hidden, 0o644);
  assert.deepEqual(probeDrift(d, outOf(d)), { changed: ["src/hidden.ts"], added: [], removed: [] });
  const r = await ensureFreshGraph(d);
  assert.equal(r.refreshed, true);
  assert.equal(hasSymbol(d, "src/hidden.ts#reachable"), true);
});

test("an unwritable cache costs reuse, not correctness", async (t) => {
  // A mode on a *directory* is the one denial Windows ignores completely, so unlike
  // the read-only-file case below there is no portable way to run this there.
  const why = chmodDenialUnavailable();
  if (why) return t.skip(why);
  const d = repo();
  await buildGraph(d);

  // The write has to be made to fail for real. An earlier version of this test
  // chmod'd extract.json itself — useless, because the sidecars go out through
  // `writeJsonAtomic`, and rename(2) needs write permission on the *directory*, not
  // on the file. It returned true, the test passed, and it would have passed against
  // the pre-fix code too.
  const cache = join(outOf(d), ".cache");
  const memo = extractCachePath(outOf(d))!;
  assert.ok(existsSync(memo), "a memo exists to begin with");
  const before = readFileSync(memo, "utf8");

  writeFileSync(join(d, "src", "math.ts"), `${MATH}${MUL}`);
  chmodSync(cache, 0o500);
  await buildGraph(d);
  chmodSync(cache, 0o700);

  assert.equal(readFileSync(memo, "utf8"), before, "the memo really could not be written");
  assert.ok(hasSymbol(d, "src/math.ts#mul"), "but the graph itself was rebuilt");

  // Losing the memo and the fingerprint is a performance failure, not a correctness
  // one: the next query rebuilds because it can't prove it doesn't need to. Once the
  // directory is writable again the fast path comes back on its own.
  await buildGraph(d);
  const drift = probeDrift(d, outOf(d));
  assert.ok(drift, "a fingerprint exists, so the probe has a fast path");
  assert.ok(isClean(drift), "and it says the graph matches the tree");
  assert.deepEqual((await ensureFreshGraph(d)).refreshed, false, "so a query stops rebuilding");
});

/**
 * The query path writes the graph, the ask sidecar and the fingerprint — and stops.
 * Cards and INDEX.md are what a human reads and what the agent greps; they are
 * rebuilt by an explicit `graft build`, which is what the `Stop` hook runs at the
 * end of a turn. Keeping them off the query path is what makes a refresh cheap, and
 * it means a read-only card or an unparseable hand-written concept node can never be
 * reached — let alone made permanent — by a retrieval call.
 */
test("a refresh rebuilds the graph but not the markdown projections", async () => {
  const d = repo();
  await buildGraph(d);

  const index = join(outOf(d), "INDEX.md");
  const card = join(outOf(d), "src", "math.md");
  const newCard = join(outOf(d), "src", "extra.md");
  assert.ok(existsSync(index) && existsSync(card), "an explicit build wrote both");
  const indexBefore = readFileSync(index, "utf8");
  const cardBefore = readFileSync(card, "utf8");

  writeFileSync(join(d, "src", "extra.ts"), MUL);
  const r = await ensureFreshGraph(d);

  assert.equal(r.refreshed, true);
  assert.equal(hasSymbol(d, "src/extra.ts#mul"), true, "the graph is current");
  assert.equal(existsSync(newCard), false, "no card for it yet");
  assert.equal(readFileSync(index, "utf8"), indexBefore, "INDEX.md untouched");
  assert.equal(readFileSync(card, "utf8"), cardBefore, "existing cards untouched");

  // An explicit build — the Stop hook's job — is what catches the surface up.
  await buildGraph(d);
  assert.equal(existsSync(newCard), true);
});

test("a refresh never writes the repo's .gitignore", async () => {
  const d = repo();
  await buildGraph(d); // an explicit build DOES self-ignore — that part is unchanged
  const ignore = join(d, ".gitignore");
  assert.match(readFileSync(ignore, "utf8"), /graft\//);

  // A repo that excludes graft/ some other way (.git/info/exclude, a global
  // core.excludesfile) and deliberately has no line here. A query is a read; it must
  // not hand the user an unexplained modification to a tracked file.
  rmSync(ignore);
  writeFileSync(join(d, "src", "math.ts"), `${MATH}${MUL}`);
  const r = await ensureFreshGraph(d);

  assert.equal(r.refreshed, true, "the refresh still happened");
  assert.equal(existsSync(ignore), false, "and it left .gitignore alone");
});

test("after waiting out another process's rebuild, the waiter does not rebuild too", async () => {
  const d = repo();
  await buildGraph(d);
  writeFileSync(join(d, "src", "math.ts"), `${MATH}${MUL}`);

  // Stand in for the process that got there first: take the lock, do the rebuild it
  // would have done, then release while our caller is still waiting.
  assert.equal(acquireLock(d), true);
  setTimeout(() => {
    void buildGraph(d).then(() => releaseLock(d));
  }, 150);

  const r = await ensureFreshGraph(d);
  assert.equal(r.refreshed, false, "the work was already done — re-probe, don't redo it");
  assert.equal(refreshNote(r), null, "and nothing to report");
  assert.equal(hasSymbol(d, "src/math.ts#mul"), true, "the edit is in the graph either way");
});

test("a fingerprint from a different extractor is not trusted", async () => {
  const d = repo();
  await buildGraph(d);
  assert.ok(isClean(probeDrift(d, outOf(d))!));

  // Same bytes on disk, different extractor: the memo drops its entries, so the
  // prints describe nodes nothing would rebuild. "Unknown" is the only safe answer.
  const fp = JSON.parse(readFileSync(fingerprintPath(outOf(d)), "utf8"));
  writeFileSync(fingerprintPath(outOf(d)), JSON.stringify({ ...fp, extractor: "0:0" }));
  assert.equal(probeDrift(d, outOf(d)), null);
});

test("a workspace refreshes its children even under a --dir override", async () => {
  const d = mkdtempSync(join(tmpdir(), "graft-refresh-ws-"));
  const child = join(d, "api");
  mkdirSync(join(child, "src"), { recursive: true });
  writeFileSync(join(child, "src", "math.ts"), MATH);
  await buildGraph(child);

  const shared = join(d, "shared-context");
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, "workspace.json"), JSON.stringify({ version: 1, children: ["api"] }));

  writeFileSync(join(child, "src", "math.ts"), `${MATH}export function mul(a: number, b: number): number {\n  return a * b;\n}\n`);
  // `contextDirFor` returns an override verbatim, so forwarding this to the child
  // resolved it to the parent's dir — no wiring.json there, so every child was
  // silently skipped and the query answered from a stale child graph.
  const r = await ensureFreshChildren(d, ["api"], { contextDir: shared });
  assert.equal(r.refreshed, true);
  assert.match(r.note ?? "", /api/);
  assert.equal(hasSymbol(child, "src/math.ts#mul"), true);
});

test("callTool refreshes before answering — except for graft_check_freshness", async () => {
  const d = repo();
  await buildGraph(d);
  writeFileSync(join(d, "src", "math.ts"), `${MATH}export function mul(a: number, b: number): number {\n  return a * b;\n}\n`);

  // graft_check_freshness is the drift report: refreshing first would make it always say OK.
  const check = await callTool(d, "graft_check_freshness", {});
  assert.equal(check.isError, false);
  assert.ok(!check.text.startsWith("[graft] refreshed"));
  assert.equal(hasSymbol(d, "src/math.ts#mul"), false, "check must not rebuild");

  const ask = await callTool(d, "graft_find_code", { query: "multiply two numbers" });
  assert.equal(ask.isError, false);
  assert.match(ask.text, /^\[graft\] refreshed the graph/);
  assert.equal(hasSymbol(d, "src/math.ts#mul"), true);
  assert.match(ask.text, /mul/, "and the answer knows about the symbol that was never committed");

  const again = await callTool(d, "graft_find_code", { query: "multiply two numbers" });
  assert.ok(!again.text.startsWith("[graft] refreshed"), "nothing moved — no note, no rebuild");
});

test("a process killed while holding the lock releases it", async (t) => {
  // Windows has no SIGTERM: `child.kill()` there calls TerminateProcess, so no
  // handler runs and nothing can release the lock on the way out. The safety net on
  // that platform is the stale-lock reclaim (`LOCK_STALE_MS`), covered above.
  if (process.platform === "win32") {
    return t.skip("no SIGTERM on Windows — kill() terminates without unwinding, so a handler cannot run");
  }
  const d = repo();
  const cache = join(outOf(d), ".cache");
  mkdirSync(cache, { recursive: true });
  const lock = join(cache, ".sync.lock");

  // `execFileSync(..., { timeout })` — which is how the Claude Code prompt hook runs
  // `graft ask` — enforces its timeout with SIGTERM, and node's default disposition
  // for that is to exit without unwinding. So the `finally` that releases the lock
  // never ran, and the abandoned lock then blocked the background sync and made every
  // query wait-then-answer-stale until it aged out.
  // `file://` URLs, not native paths: a dynamic `import("D:\\…\\state.ts")` fails on
  // Windows, where ESM reads the drive letter as a URL scheme.
  const mod = (rel: string) => JSON.stringify(new URL(rel, import.meta.url).href);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "-e",
      `const { acquireLockIn } = await import(${mod("../src/util/state.ts")});
       const { releaseOnSignal } = await import(${mod("../src/graph/refresh.ts")});
       const cache = process.argv[1];
       if (!acquireLockIn(cache)) { process.exit(9); }
       releaseOnSignal(cache);
       process.stdout.write("held\\n");
       setInterval(() => {}, 1000);`,
      cache],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((done, fail) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => { if (c.includes("held")) done(); });
    child.on("exit", (code) => fail(new Error(`child exited early (${code})`)));
  });
  assert.ok(existsSync(lock), "the child holds the lock");

  child.kill("SIGTERM");
  const [code, signal] = await new Promise<[number | null, string | null]>((done) =>
    child.on("exit", (c, s) => done([c, s])),
  );

  assert.ok(!existsSync(lock), "the lock must not outlive the process that took it");
  assert.equal(signal, "SIGTERM", "and the exit still reports the signal, for whoever is waiting on us");
  assert.equal(code, null);
});

const node = (id: string, summary_state: GraphV1["nodes"][number]["summary_state"]) =>
  ({ id, summary_state }) as GraphV1["nodes"][number];
const graphWith = (...nodes: GraphV1["nodes"]): GraphV1 => ({ nodes }) as unknown as GraphV1;

test("summaryStaleness counts changed and never-summarized nodes, deep-built or not", () => {
  const g = graphWith(node("a", "stale"), node("b", "ready"), node("c", "pending"), node("d", "none"));
  assert.deepEqual(summaryStaleness(g), { stale: 1, unsummarized: 1, total: 3, summarized: 2 }, "`none` nodes are not summarizable");
  assert.deepEqual(summaryStaleness(null), { stale: 0, unsummarized: 0, total: 0, summarized: 0 });
  // Only `graft init` / plain `graft build` so far: everything is out of date.
  const keyless = graphWith(node("a", "pending"), node("b", "pending"), node("c", "none"));
  assert.deepEqual(summaryStaleness(keyless), { stale: 0, unsummarized: 2, total: 2, summarized: 0 });
});

const counts = (stale: number, unsummarized: number, total: number, summarized = total - unsummarized) =>
  ({ stale, unsummarized, total, summarized });

test("deepRebuildNote fires only above the threshold, including for a never-deep-built graph", () => {
  assert.equal(deepRebuildNote(counts(0, 0, 0)), null);
  assert.equal(deepRebuildNote(counts(1, 0, 10)), null, "exactly 10% is not above it");
  assert.match(
    deepRebuildNote(counts(1, 1, 10)) ?? "",
    /^\[graft\] 2 of 10 node summaries \(20%\) are out of date .*\(1 changed, 1 new\).*graft build --deep/,
  );
  assert.match(deepRebuildNote(counts(0, 2, 10)) ?? "", /\(0 changed, 2 new\)/, "new code alone counts");
  const keyless = summaryStaleness(graphWith(node("a", "pending"), node("b", "pending")));
  assert.match(
    deepRebuildNote(keyless) ?? "",
    /^\[graft\] no `graft build --deep` has run yet: none of the 2 nodes has a prose summary.*recommended/,
  );
  assert.equal(deepRebuildNote(keyless, 100), null, "100 opts a repo out of the nudge");
});

test("deepRebuildNote honors a custom threshold: 0 = anything out of date, 100 = never", () => {
  assert.match(deepRebuildNote(counts(0, 1, 1000), 0) ?? "", /Shown above 0% out of date/);
  assert.equal(deepRebuildNote(counts(0, 0, 1000), 0), null, "nothing out of date is never worth a nudge");
  assert.equal(deepRebuildNote(counts(500, 500, 1000), 100), null);
  assert.equal(deepRebuildNote(counts(2, 1, 10), 50), null);
  assert.match(deepRebuildNote(counts(3, 3, 10), 50) ?? "", /change with `graft deep-threshold <percent>` \(100 = never\)/);
});

/** A scratch `~`, so a real `~/.graft/settings.json` can never steer these tests. */
const scratchHome = (): string => mkdtempSync(join(tmpdir(), "graft-home-"));

/** For in-process code that resolves the home dir itself (the MCP path). */
async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("deepNoteFor: repo value, else global value, else default — skipping bad values", async () => {
  const d = repo();
  const home = scratchHome();
  await buildGraph(d);
  const g = graphOf(d);
  const [first] = g.nodes.filter((n) => n.summary_state !== "none");
  first.summary_state = "stale";
  first.summary = "old";
  writeGraph(g, outOf(d));
  const pct = (1 / summaryStaleness(g).total) * 100;
  assert.ok(pct > 10, "fixture: one stale node is above the default");

  assert.match(deepNoteFor(d, { home }) ?? "", /Shown above 10% out of date/);
  patchGlobalSettings({ deepStaleThreshold: 100 }, home);
  assert.equal(deepNoteFor(d, { home }), null, "the global value applies to a repo with none of its own");
  assert.deepEqual(resolveDeepStaleThreshold(d, home), { value: 100, source: "global" });

  patchBuildConfig(d, { deepStaleThreshold: 0 });
  assert.match(deepNoteFor(d, { home }) ?? "", /Shown above 0% out of date/, "the repo's own value wins");
  assert.deepEqual(resolveDeepStaleThreshold(d, home), { value: 0, source: "repo" });

  patchBuildConfig(d, { deepStaleThreshold: 250 });
  assert.equal(deepNoteFor(d, { home }), null, "an out-of-range repo value falls through to the global one");
  patchGlobalSettings({ deepStaleThreshold: -5 }, home);
  assert.deepEqual(resolveDeepStaleThreshold(d, home), { value: 10, source: "default" });
});

test("graft init never scaffolds deepStaleThreshold, so it cannot shadow the global value", () => {
  const d = repo();
  ensureDefaultBuildConfig(d);
  assert.ok(readBuildConfig(d), "the scaffold was written");
  assert.equal("deepStaleThreshold" in (readBuildConfig(d) ?? {}), false);
});

test("graft deep-threshold shows, sets, validates and resets the threshold, per repo and --global", () => {
  const d = repo();
  const home = scratchHome();
  const cli = (...args: string[]) => runCli(["deep-threshold", ...args], { home });

  const show = cli(d);
  assert.equal(show.status, 0, show.describe());
  assert.match(show.stdout, /deep-threshold: 10% \(default\)/);

  const global = cli("30", "--global", d);
  assert.equal(global.status, 0, global.describe());
  assert.match(global.stdout, /deep-threshold: 30% \(global, /);
  assert.equal(readGlobalSettings(home)?.deepStaleThreshold, 30);
  assert.equal(readBuildConfig(d)?.deepStaleThreshold, undefined, "--global leaves the repo alone");

  const set = cli("25", d);
  assert.equal(set.status, 0, set.describe());
  assert.match(set.stdout, /deep-threshold: 25% \(this repo, /);
  assert.match(set.stdout, /global: {4}30%/);
  assert.equal(readBuildConfig(d)?.deepStaleThreshold, 25);

  const shadowed = cli("40", "-g", d);
  assert.match(shadowed.stdout, /note: this repo keeps its own 25%/, "say why the new global value is not in effect here");

  const bad = cli("150", d);
  assert.equal(bad.status, 1, bad.describe());
  assert.match(bad.stderr, /not a percent between 0 and 100/);
  assert.equal(readBuildConfig(d)?.deepStaleThreshold, 25, "a rejected value changes nothing");

  const reset = cli("--reset", d);
  assert.equal(reset.status, 0, reset.describe());
  assert.match(reset.stdout, /deep-threshold: 40% \(global, /, "the repo falls back to the global value");
  assert.equal(readBuildConfig(d)?.deepStaleThreshold, undefined);

  const resetGlobal = cli("--reset", "--global", d);
  assert.match(resetGlobal.stdout, /deep-threshold: 10% \(default\)/);
  assert.equal(readGlobalSettings(home)?.deepStaleThreshold, undefined);

  const help = runCli(["--help"]);
  assert.match(help.stdout, /^\s+deep-threshold \[percent\] \[dir\] \[options\]/m, "listed among the graft commands");
});

test("an edit after a deep build surfaces the --deep nudge on MCP and stays silent before it", () =>
  withHome(scratchHome(), async () => {
  const d = repo();
  await buildGraph(d);
  // Simulate a finished `--deep`: every summarizable node gets a ready summary.
  const g = graphOf(d);
  for (const n of g.nodes) {
    if (n.summary_state === "none") continue;
    n.summary_state = "ready";
    n.summary = `summary of ${n.id}`;
  }
  writeGraph(g, outOf(d));

  const clean = await callTool(d, "graft_find_code", { query: "add" });
  assert.doesNotMatch(clean.text, /graft build --deep/, "nothing stale, nothing to say");
  assert.equal(deepNoteFor(d), null);

  writeFileSync(join(d, "src", "math.ts"), MATH.replace("a + b", "b + a"));
  const after = await callTool(d, "graft_find_code", { query: "add" });
  assert.ok(graphOf(d).nodes.some((n) => n.summary_state === "stale"), "the refresh marked the edited node stale");
  assert.match(after.text, /node summaries \(\d+%\) are out of date .*\(\d+ changed, 0 new\).*graft build --deep/);

  const check = await callTool(d, "graft_check_freshness", {});
  assert.doesNotMatch(check.text, /node summaries \(\d+%\)/, "the freshness report already names stale summaries");
  }));

test("new code added after a deep build counts toward the --deep nudge on its own", () =>
  withHome(scratchHome(), async () => {
    const d = repo();
    await buildGraph(d);
    const g = graphOf(d);
    for (const n of g.nodes) {
      if (n.summary_state === "none") continue;
      n.summary_state = "ready";
      n.summary = `summary of ${n.id}`;
    }
    writeGraph(g, outOf(d));

    // Nothing existing changes: only a new file with a new function appears.
    writeFileSync(join(d, "src", "mul.ts"), MUL);
    const after = await callTool(d, "graft_find_code", { query: "mul" });
    assert.ok(hasSymbol(d, "src/mul.ts#mul"), "fixture: the refresh indexed the new function");
    assert.equal(graphOf(d).nodes.some((n) => n.summary_state === "stale"), false, "nothing was changed");
    assert.match(after.text, /are out of date .*\(0 changed, [1-9]\d* new\).*graft build --deep/);
  }));

test("a graph only ever built by `graft build` gets the nudge too — unless the threshold is 100", () =>
  withHome(scratchHome(), async () => {
    const d = repo();
    await buildGraph(d);
    const first = await callTool(d, "graft_find_code", { query: "add" });
    assert.match(first.text, /no `graft build --deep` has run yet: none of the \d+ nodes has a prose summary/);

    patchBuildConfig(d, { deepStaleThreshold: 100 });
    const optedOut = await callTool(d, "graft_find_code", { query: "add" });
    assert.doesNotMatch(optedOut.text, /graft build --deep/);
  }));

/** Every summarizable node `ready`, then the first `n` of them `stale`. */
function deepBuiltWithStale(d: string, n: number): GraphV1 {
  const g = graphOf(d);
  let left = n;
  for (const node of g.nodes) {
    if (node.summary_state === "none") continue;
    node.summary = `summary of ${node.id}`;
    node.summary_state = left-- > 0 ? "stale" : "ready";
  }
  writeGraph(g, outOf(d));
  return g;
}

test("deepRebuildDue is the nudge's rule: strictly above the threshold, never for nothing out of date", () => {
  for (const [s, t] of [[counts(1, 0, 10), 10], [counts(1, 1, 10), 10], [counts(0, 0, 10), 0], [counts(5, 5, 10), 100], [counts(0, 0, 0), 0]] as const) {
    assert.equal(deepRebuildDue(s, t), deepRebuildNote(s, t) !== null, JSON.stringify([s, t]));
  }
  assert.equal(outdatedPercent(counts(1, 1, 8)), 25);
  assert.equal(outdatedPercent(counts(0, 0, 0)), 0);
});

test("stalenessReport: share, threshold and verdict match the nudge, worst files first", async () => {
  const d = repo();
  const home = scratchHome();
  writeFileSync(join(d, "src", "mul.ts"), MUL);
  await buildGraph(d);
  const g = deepBuiltWithStale(d, 1);
  const total = summaryStaleness(g).total;

  const r = stalenessReport(d, { home });
  assert.equal(r.indexed, true);
  assert.deepEqual(r.totals, { stale: 1, unsummarized: 0, total, summarized: total });
  assert.equal(r.pct, (1 / total) * 100);
  assert.deepEqual([r.threshold, r.thresholdSource], [10, "default"]);
  assert.equal(r.recommended, deepNoteFor(d, { home }) !== null, "the report and the query nudge agree");
  assert.equal(r.files.length, 1, "only files holding an out-of-date summary are listed");
  assert.equal(r.files[0].outdated, 1);
  assert.deepEqual(r.repos, [], "a single repo has no per-repo split");
  assert.equal(stalenessReport(d, { home, top: 0 }).files.length, 0);

  patchBuildConfig(d, { deepStaleThreshold: 100 });
  const off = stalenessReport(d, { home });
  assert.deepEqual([off.threshold, off.thresholdSource, off.recommended], [100, "repo", false]);
  assert.match(formatStalenessReport(off), /threshold: 100% \(this repo\) → the nudge is off here/);
});

test("stalenessReport: no graph yet is reported as unindexed, not as 0% out of date", () => {
  const r = stalenessReport(repo(), { home: scratchHome() });
  assert.equal(r.indexed, false);
  assert.equal(r.recommended, false);
  assert.match(formatStalenessReport(r), /no graft index here yet — run `graft build` first/);
});

test("stalenessReport: a workspace sums its child repos and names each one", async () => {
  const parent = mkdtempSync(join(tmpdir(), "graft-ws-"));
  for (const child of ["a", "b"]) {
    mkdirSync(join(parent, child, "src"), { recursive: true });
    writeFileSync(join(parent, child, "src", "math.ts"), MATH);
    await buildGraph(join(parent, child));
  }
  deepBuiltWithStale(join(parent, "a"), 0);
  const r = stalenessReport(parent, { children: ["a", "b"], home: scratchHome() });
  assert.deepEqual(r.repos.map((x) => [x.name, x.pct]), [["a", 0], ["b", 100]]);
  assert.equal(r.totals.total, r.repos[0].totals.total + r.repos[1].totals.total);
  assert.ok(r.files.every((f) => f.path.startsWith("b/")), "file paths carry their repo");
  assert.match(formatStalenessReport(r), /by repo:\n\s+0%  a .*\n\s+100%  b /);
});

test("formatStalenessReport keeps a decimal where rounding would hide the threshold side", () => {
  const base = { indexed: true, threshold: 10, thresholdSource: "default" as const, repos: [], files: [] };
  const s = counts(52, 0, 500);
  const near = formatStalenessReport({ ...base, totals: s, pct: outdatedPercent(s), recommended: deepRebuildDue(s, 10) });
  assert.match(near, /staleness: 10\.4% of node summaries out of date — 52 of 500 \(52 changed, 0 new\)/);
  assert.match(near, /above it — `graft build --deep` is recommended/);

  const clean = counts(0, 0, 40);
  const none = formatStalenessReport({ ...base, totals: clean, pct: 0, recommended: false });
  assert.match(none, /staleness: 0% — all 40 node summaries are current/);
  assert.match(none, /nothing for a deep build to do/);

  const never = counts(0, 7, 7, 0);
  assert.match(formatStalenessReport({ ...base, totals: never, pct: 100, recommended: true }), /staleness: 100% — no `graft build --deep` has run yet/);
});

test("graft staleness prints the report, or JSON, and rejects a bad --top", async () => {
  const d = repo();
  const home = scratchHome();
  await buildGraph(d);
  deepBuiltWithStale(d, 1);

  const text = runCli(["staleness", d], { home });
  assert.equal(text.status, 0, text.describe());
  assert.match(text.stdout, /staleness: \d+(\.\d)?% of node summaries out of date/);
  assert.match(text.stdout, /threshold: 10% \(default\) → above it/);
  assert.match(text.stdout, /most out-of-date files:\n\s+1 of \s*\d+\s+src\/math\.ts/);

  const json = runCli(["staleness", d, "--json", "--no-refresh"], { home });
  assert.equal(json.status, 0, json.describe());
  const r = JSON.parse(json.stdout);
  assert.equal(r.recommended, true);
  assert.equal(r.totals.stale, 1);

  const bad = runCli(["staleness", d, "--top", "lots"], { home });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--top "lots" is not a whole number/);
});

test("deepDueReason: 'no summaries yet' before any deep build, else the rounded share — each with its scope and cost", () => {
  assert.equal(
    deepDueReason(counts(0, 7, 7, 0)),
    "no summaries yet — none of the 7 nodes has a prose summary; it writes them in an LLM pass that needs an API key and costs tokens",
  );
  assert.equal(
    deepDueReason(counts(687, 866, 5353)),
    "29% of summaries out of date — 1,553 of 5,353 nodes: 687 changed, 866 new; it refreshes their prose summaries in an LLM pass that needs an API key and costs tokens",
  );
  assert.doesNotMatch(deepDueReason(counts(687, 866, 5353)), /[()]/, "the tally wraps the reason in parentheses already");
});

test("deepDueFor pairs the note with its reason, and is null whenever the note is", async () => {
  const d = repo();
  const home = scratchHome();
  await buildGraph(d);
  const due = deepDueFor(d, { home });
  assert.equal(due?.note, deepNoteFor(d, { home }));
  assert.match(due?.reason ?? "", /^no summaries yet — none of the \d+ nodes has a prose summary/);
  patchBuildConfig(d, { deepStaleThreshold: 100 });
  assert.equal(deepDueFor(d, { home }), null);
});

test("over MCP the savings tally carries the deep-build recommendation, until it is opted out", () =>
  withHome(scratchHome(), async () => {
    const d = repo();
    // Big enough that the answer is smaller than the file: only then is a saving
    // (and so a tally) printed at all.
    writeFileSync(join(d, "src", "big.ts"), "// padding line for the savings baseline\n".repeat(1500) + MUL);
    await buildGraph(d);
    const tallyOf = (text: string) => text.slice(text.indexOf("\u{1F331}")).split("\n").slice(0, 5).join("\n");

    const due = await callTool(d, "graft_find_code", { query: "mul" });
    assert.ok(due.text.includes("\u{1F331}"), `fixture: a saving was claimed\n${due.text}`);
    // Unpriced (no model sent), so the price-update line sits between the tally
    // and the deep-build line.
    assert.match(
      tallyOf(due.text),
      /this turn  \n⚠️ Run the 'graft prices update' command — recommended \(no known price for the model used[^\n]*  \n⚠️ Run the 'graft build --deep' command — recommended \(no summaries yet — /,
    );

    patchBuildConfig(d, { deepStaleThreshold: 100 });
    const off = await callTool(d, "graft_find_code", { query: "mul" });
    assert.ok(off.text.includes("\u{1F331}"));
    assert.doesNotMatch(tallyOf(off.text), /build --deep/, "no stale carry-over from the previous call");
  }));
