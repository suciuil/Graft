import { test } from "node:test";
import assert from "node:assert/strict";
import type { CruxSummarizer, FileCruxInput, NodeCrux } from "../src/ai/crux.js";
import { enrichGraph } from "../src/graph/enrich.js";
import type { NodeV1 } from "../src/graph/types.js";

function node(index: number): NodeV1 {
  return {
    id: `src/large.kt#value${index}`,
    name: `value${index}`,
    kind: "constant",
    path: "src/large.kt",
    span: `L${index + 1}-L${index + 1}`,
    signature: `const val value${index} = ${index}`,
    exported: false,
    origin: "generic",
    body_hash: `hash-${index}`,
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

function result(input: FileCruxInput): NodeCrux[] {
  return input.nodes.map((n) => ({
    id: n.id,
    summary: `Summary for ${n.id}`,
    crux_start: 0,
    crux_end: 0,
  }));
}

test("meaning enrichment splits large files into bounded target batches", async () => {
  const nodes = Array.from({ length: 95 }, (_, i) => node(i));
  const batchSizes: number[] = [];
  const summarizer: CruxSummarizer = {
    async describeFile(input) {
      batchSizes.push(input.nodes.length);
      return result(input);
    },
  };

  const stats = await enrichGraph(nodes, new Map(), new Map([["src/large.kt", "\n".repeat(100)]]), {
    summarizer,
    concurrency: 1,
  });

  assert.deepEqual(batchSizes, [40, 40, 15]);
  assert.deepEqual(stats, {
    cached: 0,
    computed: 95,
    stale: 0,
    pending: 0,
    errors: [],
    failedFiles: 0,
    skippedFiles: 0,
    fatal: undefined,
  });
  assert.ok(nodes.every((n) => n.summary_state === "ready"));
});

test("meaning enrichment isolates file summaries from symbol batches", async () => {
  const file = { ...node(0), id: "src/large.kt", name: "large.kt", kind: "file" as const, span: "L1-L100", signature: null };
  const nodes = [file, ...Array.from({ length: 41 }, (_, i) => node(i + 1))];
  const batches: string[][] = [];
  const summarizer: CruxSummarizer = {
    async describeFile(input) {
      batches.push(input.nodes.map((n) => n.kind));
      return result(input);
    },
  };

  const stats = await enrichGraph(nodes, new Map(), new Map([["src/large.kt", "\n".repeat(100)]]), {
    summarizer,
    concurrency: 1,
  });

  assert.deepEqual(batches.map((batch) => batch.length), [1, 40, 1]);
  assert.deepEqual(batches[0], ["file"]);
  assert.equal(stats.pending, 0);
  assert.equal(stats.computed, nodes.length);
});
test("meaning enrichment retries only symbols omitted from a batch", async () => {
  const nodes = Array.from({ length: 3 }, (_, i) => node(i));
  const calls: string[][] = [];
  const summarizer: CruxSummarizer = {
    async describeFile(input) {
      calls.push(input.nodes.map((n) => n.id));
      return calls.length === 1 ? result({ ...input, nodes: input.nodes.slice(0, 1) }) : result(input);
    },
  };

  const stats = await enrichGraph(nodes, new Map(), new Map([["src/large.kt", "\n".repeat(10)]]), {
    summarizer,
    concurrency: 1,
  });

  assert.deepEqual(calls, [nodes.map((n) => n.id), nodes.slice(1).map((n) => n.id)]);
  assert.deepEqual(stats, {
    cached: 0,
    computed: 3,
    stale: 0,
    pending: 0,
    errors: [],
    failedFiles: 0,
    skippedFiles: 0,
    fatal: undefined,
  });
});
test("meaning enrichment keeps successful batches when one batch fails", async () => {
  const nodes = Array.from({ length: 85 }, (_, i) => node(i));
  let call = 0;
  const summarizer: CruxSummarizer = {
    async describeFile(input) {
      call++;
      if (call === 2) throw new Error("408 status code (no body)");
      return result(input);
    },
  };

  const stats = await enrichGraph(nodes, new Map(), new Map([["src/large.kt", "\n".repeat(100)]]), {
    summarizer,
    concurrency: 1,
  });

  assert.equal(stats.computed, 45);
  assert.equal(stats.pending, 40);
  assert.deepEqual(stats.errors, ["src/large.kt: batch 2/3: 408 status code (no body)"]);
  assert.equal(nodes.filter((n) => n.summary_state === "ready").length, 45);
});
