/**
 * Trail cloud is permanently off in this version, so a lookup is never reported
 * to a workspace: not its savings, not the learnings it showed, and not by any
 * connection handed in directly. The saving is still computed once from the pack
 * the caller already rendered (formatAskWithSaved), for the local ledger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";
process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "saved-tokens-home-"));

const { formatAsk, formatAskWithSaved, askSavedTokens } = await import("../src/ask/ask.js");
type AskResult = import("../src/ask/ask.js").AskResult;
const { recordLookup } = await import("../src/cloud/lookup-activity.js");
const { repoPlace } = await import("../src/notes/home.js");
type Cloud = import("../src/cloud/workspace.js").Cloud;

const outbox = () => join(process.env.TRAIL_HOME!, "outbox.jsonl");
const queued = (): any[] =>
  existsSync(outbox()) ? readFileSync(outbox(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

function repoAndCloud(): { repo: string; cloud: Cloud } {
  const repo = mkdtempSync(join(tmpdir(), "saved-tokens-repo-"));
  const cloud: Cloud = {
    url: "http://trail.test",
    token: "trl_x",
    user: { name: "Anirudh", email: "a@acme.test" },
    workspace: { id: "w", name: "Acme", slug: "acme", url: "http://trail.test/w/acme", invite_url: "http://trail.test/join/x" },
    repos: [repoPlace(repo).key],
    linkedAt: 0,
  };
  return { repo, cloud };
}

/** A result whose pack saves exactly `tokens` tokens against reading the file whole. */
function resultSaving(tokens: number): AskResult {
  const r: AskResult = {
    query: "retry count",
    mode: "structural",
    hits: [{ id: "n1", title: "Do", kind: "function", pointer: "client.go:L1-L9", score: 1 } as AskResult["hits"][number]],
  };
  const pack = Math.round((formatAsk(r).length - 1) / 4);
  r.saved = { files: 1, baselineChars: 4 * (tokens + pack) };
  return r;
}

function reset(): void {
  rmSync(outbox(), { force: true });
  mkdirSync(process.env.TRAIL_HOME!, { recursive: true });
}

/** A result whose `saved` is counted when read, to prove a refused lookup does no work. */
function countingReads(r: AskResult): { reads: () => number } {
  let n = 0;
  const saved = r.saved;
  Object.defineProperty(r, "saved", { get: () => (n++, saved), configurable: true });
  return { reads: () => n };
}

test("a lookup that saved tokens is never queued, even for a workspace repo", () => {
  reset();
  const { repo, cloud } = repoAndCloud();
  const r = resultSaving(15392);
  assert.equal(askSavedTokens(r), 15392);
  assert.match(formatAsk(r), /tokens saved ≈ 15,392 /, "the number the ask output prints");
  const c = countingReads(r);
  recordLookup(r, repo, cloud);
  assert.equal(c.reads(), 0, "nothing is computed for a lookup that cannot be sent");
  assert.equal(queued().length, 0);
});

test("a learning shown is never queued either", () => {
  reset();
  const { repo, cloud } = repoAndCloud();
  const r = resultSaving(900);
  r.notes = [{ note: { id: "n", path: "/x/.trail/learnings/2026-10-09-jitter-kumar.md", title: "Jitter", author: "Kumar", date: "2026-10-09", touches: [], body: "b" }, score: 1, shared: [] }];
  recordLookup(r, repo, cloud);
  assert.equal(queued().length, 0);
});

test("not connected, connected by `connect`, or a repo outside the workspace: nothing is computed or queued", () => {
  for (const pick of [
    () => null,
    (c: Cloud) => ({ ...c, via: "connect" as const }),
    (c: Cloud) => ({ ...c, repos: ["github.com/acme/other"] }),
  ]) {
    reset();
    const { repo, cloud } = repoAndCloud();
    const r = resultSaving(15392);
    const c = countingReads(r);
    recordLookup(r, repo, pick(cloud));
    assert.equal(c.reads(), 0);
    assert.equal(queued().length, 0);
  }
});

test("a lookup is rendered once: formatAskWithSaved gives the text formatAsk gives and its saving", () => {
  const r = resultSaving(15392);
  const expected = { text: formatAsk(r), saved: askSavedTokens(r) };
  const { text, savedTokens } = formatAskWithSaved(r);
  assert.equal(text, expected.text, "same text formatAsk gives");
  assert.equal(savedTokens, expected.saved);
  assert.equal(savedTokens, 15392);
});
