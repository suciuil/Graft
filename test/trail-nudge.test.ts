/**
 * Connecting a workspace, offered by the agent, is PERMANENTLY OFF.
 *
 * Neither TRAIL_CLOUD=1 nor a `~/.trail/cloud.json` (left by an older trail or
 * written by hand) turns it on: no link is offered, no background wait
 * registers anything with Trail, no connection is stored, and a connected
 * machine is never asked to add a repo. Every case below hands the code a fake
 * Trail that records each request, so "nothing was sent" is checked, not assumed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";
import { writeNote } from "../src/notes/notes.js";
import { cloudLines, waitForConnect } from "../src/cloud/nudge.js";
import { cloudEnabled, readCloud, writeCloud, type Cloud } from "../src/cloud/workspace.js";
import { tmpRepo } from "./helpers.js";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";
// The test-only stand-in address: real sign-ins only go where `trail login --server` says, or to Trail cloud.
process.env.TRAIL_TEST_SERVER = "http://trail.test";
process.env.TRAIL_NO_FETCH = "1";
process.env.TRAIL_CLOUD = "1";

/** A fresh ~/.trail for each test, so links, sessions and connections never leak between them. */
function freshHome(): NodeJS.ProcessEnv {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "nudge-trail-home-"));
  return process.env;
}

function git(d: string, args: string[]) {
  spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: d });
}

let n = 0;
/** A GitHub-backed repo with a learning in its .trail/: everything the nudge used to need. */
function repo(): { dir: string; key: string } {
  const dir = tmpRepo("nudge");
  const name = `acme/extract-${++n}`;
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Priya Raman"]);
  git(dir, ["remote", "add", "origin", `https://github.com/${name}.git`]);
  writeNote(dir, { title: "Retries trip the rate limit", body: "## Decided\nThree retries.", author: "Priya", date: "2026-10-07", touches: [] });
  return { dir, key: `github.com/${name}` };
}

/** A Trail that would answer every route, and records whatever reaches it. */
function fakeTrail() {
  const sent: string[] = [];
  const fetchImpl = (async (url: string) => {
    sent.push(new URL(url).pathname);
    return new Response(JSON.stringify({ pending: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, sent };
}

/** A connection as an older trail wrote it, straight to disk. */
function handWrittenCloud(repos: string[]): void {
  const c: Cloud = {
    url: "http://trail.test",
    token: "trl_test",
    user: { name: "Priya", email: "priya@acme.test" },
    workspace: { id: "w1", name: "Acme", slug: "acme", url: "http://trail.test/w/acme", invite_url: "http://trail.test/join/abc" },
    repos,
    linkedAt: Date.now(),
  };
  mkdirSync(process.env.TRAIL_HOME!, { recursive: true });
  writeFileSync(join(process.env.TRAIL_HOME!, "cloud.json"), JSON.stringify(c));
}

test("TRAIL_CLOUD=1 does not turn Trail cloud on", () => {
  freshHome();
  assert.equal(cloudEnabled({ ...process.env, TRAIL_CLOUD: "1" }), false);
});

test("a cloud.json on disk is ignored: not read, and it does not turn Trail cloud on", () => {
  freshHome();
  handWrittenCloud(["github.com/acme/x"]);
  assert.equal(readCloud(), null);
  assert.equal(cloudEnabled(), false);
});

test("writeCloud stores no connection and no token", () => {
  freshHome();
  writeCloud({
    url: "http://trail.test",
    token: "trl_test",
    user: { name: "", email: "" },
    workspace: { id: "w", name: "Acme", slug: "acme", url: "", invite_url: "" },
    repos: [],
    linkedAt: 0,
  });
  assert.equal(existsSync(join(process.env.TRAIL_HOME!, "cloud.json")), false);
  assert.equal(readCloud(), null);
});

test("with TRAIL_CLOUD=1 and learnings to share, nobody is offered a link and no wait starts", () => {
  freshHome();
  const { dir } = repo();
  let waits = 0;
  const out = cloudLines(dir, { command: "ask", agent: true, env: { ...process.env, CLAUDE_CODE_SESSION_ID: "s1" }, startWait: () => waits++ });
  assert.deepEqual(out, []);
  assert.equal(waits, 0);
  assert.equal(existsSync(join(process.env.TRAIL_HOME!, "cloud-nudge.json")), false, "no link minted");
});

test("a hand-written connection is never asked about adding a repo", () => {
  freshHome();
  const { dir } = repo();
  handWrittenCloud([]);
  assert.deepEqual(cloudLines(dir, { command: "ask", agent: true, env: { ...process.env, CLAUDE_CODE_SESSION_ID: "s1" }, startWait: () => {} }), []);
});

test("the background wait registers nothing with Trail, connects nothing, and uploads nothing", async () => {
  freshHome();
  const { key } = repo();
  // A link left out by an older trail, which the wait used to pick up.
  writeFileSync(join(process.env.TRAIL_HOME!, "cloud-nudge.json"), JSON.stringify({ pending: { state: "s".repeat(32), createdAt: Date.now(), repo: key } }));
  const trail = fakeTrail();
  const got = await waitForConnect({ fetchImpl: trail.fetchImpl, sleep: async () => {} });
  assert.equal(got, null);
  assert.deepEqual(trail.sent, [], "no request reached Trail");
  assert.equal(readCloud(), null);
  assert.equal(existsSync(join(process.env.TRAIL_HOME!, "cloud.json")), false);
});
