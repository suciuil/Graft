/**
 * Upstream's `trail init --connect <CODE>` claims a code against Trail and
 * sends a repo summary. Trail cloud is permanently off in this version, so
 * `--connect`, `--pair` and `--server` refuse before anything is claimed,
 * sent or set up; this runs them against a fake Trail over real HTTP to prove
 * nothing reaches it. Without them, init sends nothing anywhere, as always.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOOD_CODE, startFakeTrail, type FakeTrail } from "./fake-trail-server.js";
import { writeNote } from "../src/notes/notes.js";
import { BRAND_ENV } from "../src/brand.js";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";

let trail: FakeTrail | null = null;
after(async () => {
  await trail?.close();
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A distinctive line of code, so the test can tell if any code went up. */
const CODE_MARK = "return attempts * 7919";

/** A "GitHub" remote with a hub file, me with history on it, and Kumar's fresh branch changing it. */
function repoWithTeam(): string {
  const root = mkdtempSync(join(tmpdir(), "connect-cli-"));
  const bare = join(root, "retry.git");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", seed);
  const filler = Array.from({ length: 300 }, (_, i) => `export function helper${i}(x: number): number {\n  return x * ${i} + ${i};\n}\n`).join("\n");
  writeFileSync(join(seed, "client.ts"), `export function retryDo(attempts: number): number {\n  ${CODE_MARK};\n}\n\n${filler}`);
  for (const f of ["a", "b", "c"]) writeFileSync(join(seed, `${f}.ts`), `import { retryDo } from "./client";\nexport function use${f}() {\n  return retryDo(4);\n}\n`);
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=Seed", "-c", "user.email=s@x", "commit", "-qm", "init");
  git(seed, "push", "-q", bare, "main");
  const clone = (who: string, name: string) => {
    const d = join(root, who);
    git(root, "clone", "-q", bare, d);
    git(d, "remote", "set-url", "origin", "https://github.com/acme/retry.git");
    git(d, "config", `url.${bare}.insteadOf`, "https://github.com/acme/retry.git");
    git(d, "config", "user.name", name);
    git(d, "config", "user.email", `${who}@acme.test`);
    git(d, "remote", "set-head", "origin", "main");
    return d;
  };
  const me = clone("rushabh", "Rushabh Nagda");
  writeFileSync(join(me, "client.ts"), readFileSync(join(me, "client.ts"), "utf8").replace("attempts * 7919", "attempts * 7907"));
  writeNote(me, { title: "Keep retryDo() at 4 attempts", body: "## Decided\n- Keep retryDo() at 4 attempts.\n\n_Told to Claude in 3 past sessions here, most recently on Oct 9._", author: "Rushabh", date: "2026-10-09", touches: ["client.ts"] });
  git(me, "add", "-A");
  git(me, "commit", "-qm", "Tune retryDo");

  const kumar = clone("kumar", "Kumar S");
  git(kumar, "checkout", "-q", "-b", "kumar/retry");
  writeFileSync(join(kumar, "client.ts"), readFileSync(join(kumar, "client.ts"), "utf8").replace("retryDo(attempts: number)", "retryDo(attempts: number, cap = 10)"));
  git(kumar, "commit", "-qam", "Raise the retry count to 10");
  git(kumar, "push", "-q", "origin", "kumar/retry");
  git(me, "fetch", "-q", "origin");
  return me;
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function envFor(url: string): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "connect-cli-home-"));
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TRAIL_HOME: join(home, ".trail"),
    TRAIL_TEST_SERVER: url,
    // No past-session or PR-review read (those ask Claude and GitHub), and no git fetch.
    TRAIL_NO_FETCH: "1",
    DO_NOT_TRACK: "1",
    TRAIL_INVOKED_AS: "trail",
  };
}

// Trail cloud is permanently off in this version: --connect, --pair and
// --server refuse up front, before anything is claimed, sent or set up.

test("init --connect refuses: nothing is claimed or sent, no token is saved, the repo is left alone", async () => {
  trail = await startFakeTrail();
  const repo = repoWithTeam();
  const env = envFor(trail.url);
  const r = await run(["init", repo, "--connect", GOOD_CODE, "--agents", "claude", "--no-global", "--no-build"], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /✗ Trail cloud is permanently disabled in this version; nothing is sent to a Trail workspace/);
  assert.equal(trail.log.filter((l) => l.path.startsWith("/api/")).length, 0, "nothing reaches Trail");
  assert.equal(existsSync(join(env.TRAIL_HOME!, "cloud.json")), false);
  assert.equal(existsSync(join(repo, ".claude", "settings.json")), false, "refused before init set anything up");
  // Whatever is in it: no "isn't a Trail code", no code ever claimed.
  for (const code of ["TRL-USED-C0DE", "nope"]) {
    const bad = await run(["init", repo, "--connect", code], env);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /permanently disabled/);
  }
  assert.equal(trail.log.filter((l) => l.path.startsWith("/api/")).length, 0);
});

test("--pair and --server refuse the same way", async () => {
  trail ??= await startFakeTrail();
  const before = trail.log.length;
  const repo = repoWithTeam();
  const env = envFor(trail.url);
  for (const args of [["--pair", "ABCD-1234"], ["--server", `${trail.url}/`], ["--connect", GOOD_CODE, "--server", `${trail.url}/`]]) {
    const r = await run(["init", repo, ...args, "--agents", "claude", "--no-global", "--no-build"], env);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /permanently disabled/, args.join(" "));
  }
  assert.equal(trail.log.length, before);
  assert.equal(existsSync(join(env.TRAIL_HOME!, "cloud.json")), false);
});

test("--connect and --pair together still says to pick one", async () => {
  const repo = repoWithTeam();
  const r = await run(["init", repo, "--connect", GOOD_CODE, "--pair", "ABCD-1234"], envFor("http://127.0.0.1:9"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--connect and --pair are two ways in/);
});

test("without --connect, init sends nothing anywhere and prints what it always did", async () => {
  trail ??= await startFakeTrail();
  const before = trail.log.length;
  const repo = repoWithTeam();
  const env = envFor(trail.url);
  const r = await run(["init", repo, "--agents", "claude", "--no-global", "--no-build"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(trail.log.length, before);
  assert.doesNotMatch(r.stderr, /connected to workspace|summary/);
  assert.equal(existsSync(join(env.TRAIL_HOME!, "cloud.json")), false);
});
