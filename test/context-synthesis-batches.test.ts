/**
 * The synthesis phase (`writing concepts N/M: batch N`) must survive a failing
 * batch. The reported case: a relay answered batch 6 of 16 with
 * `403 Insufficient account balance`, the error threw out of the loop, the whole
 * `graft build --deep` aborted, and the 5 batches already paid for were bought
 * again on the re-run. Each batch is now caught, every successful batch is
 * checkpointed to the cache, and an incomplete synthesis leaves the concept nodes
 * already on disk alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildContext } from "../src/context/build.js";
import { BracketSynthesizer, PassthroughSummarizer } from "./helpers.js";
import type { FileSummary, SynthNode, Synthesizer } from "../src/ai/synthesize.js";

const rmDir = (dir: string): void => rmSync(dir, { recursive: true, force: true });
const cachePath = (dir: string): string => join(dir, "graft", ".cache", "summaries.json");

/** `n` files, each large enough (> half the 48k synthesis budget) to be its own batch. */
function fixture(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "synthbatch-"));
  const pad = `// ${"x".repeat(30_000)}\n`;
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, `f${i}.ts`), `// [[Node ${i}]]\n${pad}export const v${i} = ${i};\n`);
  }
  return dir;
}

function diskSynthBatches(dir: string): number {
  const p = cachePath(dir);
  if (!existsSync(p)) return 0;
  const parsed = JSON.parse(readFileSync(p, "utf8")) as { synth?: Record<string, unknown> };
  return Object.keys(parsed.synth ?? {}).length;
}

function conceptFiles(dir: string): string[] {
  return readdirSync(join(dir, "graft")).filter((f) => f.startsWith("node-") && f.endsWith(".md")).sort();
}

/** Bracket synthesis, but batch numbers listed in `failOn` (1-based call order) throw. */
class FlakySynthesizer implements Synthesizer {
  calls = 0;
  diskAtCall: number[] = [];
  private inner = new BracketSynthesizer();
  constructor(
    private failOn: Set<number>,
    private message = "403 Insufficient account balance",
    private dir?: string,
  ) {}
  async synthesize(files: FileSummary[]): Promise<SynthNode[]> {
    this.calls++;
    if (this.dir) this.diskAtCall.push(diskSynthBatches(this.dir));
    if (this.failOn.has(this.calls)) throw new Error(this.message);
    return this.inner.synthesize(files);
  }
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
}

test("each successful synthesis batch is checkpointed before the next one runs", async () => {
  const dir = fixture(3);
  try {
    const synth = new FlakySynthesizer(new Set(), undefined, dir);
    const r = await quiet(() =>
      buildContext(dir, { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer: synth }),
    );
    assert.equal(r.batches, 3);
    // Before batch 2 runs, batch 1 is on disk; before batch 3, batches 1-2.
    assert.deepEqual(synth.diskAtCall, [0, 1, 2]);
    assert.equal(r.failedBatches, 0);
    assert.equal(r.nodes, 3);
  } finally {
    rmDir(dir);
  }
});

test("a failing batch is caught: the build returns, reports it, and keeps the finished batches cached", async () => {
  const dir = fixture(4);
  try {
    // A non-terminal failure on batch 2 only: the pass continues past it.
    const synth = new FlakySynthesizer(new Set([2]), "500 upstream hiccup");
    const r = await quiet(() =>
      buildContext(dir, { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer: synth }),
    );
    assert.equal(synth.calls, 4, "every batch is attempted after a non-terminal failure");
    assert.equal(r.failedBatches, 1);
    assert.equal(r.skippedBatches, 0);
    assert.deepEqual(r.errors, ["synthesis batch 2/4: 500 upstream hiccup"]);
    assert.match(r.fatal ?? "", /synthesis incomplete — 3\/4 batches done/);
    assert.equal(diskSynthBatches(dir), 3, "the three successful batches are cached");

    // The re-run pays only for the batch that failed.
    const rerun = new FlakySynthesizer(new Set());
    const second = await quiet(() =>
      buildContext(dir, { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer: rerun }),
    );
    assert.equal(rerun.calls, 1, "only the missing batch is synthesized again");
    assert.equal(second.failedBatches, 0);
    assert.equal(second.fatal, undefined);
    assert.equal(second.nodes, 4);
  } finally {
    rmDir(dir);
  }
});

test("a relay balance error that outlived its backoff stops the pass; remaining batches are not attempted", async () => {
  const dir = fixture(4);
  try {
    const synth = new FlakySynthesizer(new Set([2]));
    const r = await quiet(() =>
      buildContext(dir, { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer: synth }),
    );
    assert.equal(synth.calls, 2, "no calls after the relay reports no balance");
    assert.equal(r.failedBatches, 1);
    assert.equal(r.skippedBatches, 2);
    assert.match(r.fatal ?? "", /insufficient account balance after backing off/);
    assert.doesNotMatch(r.fatal ?? "", /rejected the API key/);
    assert.equal(diskSynthBatches(dir), 1);
  } finally {
    rmDir(dir);
  }
});

test("an incomplete synthesis leaves the concept nodes already on disk untouched", async () => {
  const dir = fixture(3);
  try {
    await quiet(() =>
      buildContext(dir, { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer: new BracketSynthesizer() }),
    );
    const before = conceptFiles(dir);
    assert.equal(before.length, 3);

    // Change every file so no batch is a cache hit, then fail the first batch hard.
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(dir, `f${i}.ts`), `// [[Node ${i}]]\n// ${"y".repeat(30_000)}\nexport const v${i} = ${i + 1};\n`);
    }
    const r = await quiet(() =>
      buildContext(dir, {
        model: "fake",
        summarizer: new PassthroughSummarizer(),
        synthesizer: new FlakySynthesizer(new Set([1])),
      }),
    );
    assert.equal(r.failedBatches, 1);
    assert.deepEqual(conceptFiles(dir), before, "a partial node set must not delete the missing concepts");
  } finally {
    rmDir(dir);
  }
});
