/**
 * Tests for the mtime-keyed loader cache (`src/graph/load.ts`) that sits in
 * front of `readGraph`/`readAskIndex` so a long-lived process (the MCP server;
 * `graft ask` invoked repeatedly in one process) doesn't re-parse the wiring
 * graph and ask sidecar on every query.
 */
import "./isolate.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGraphCached,
  loadAskIndexCached,
  doneWithMap,
  keepWorkspaceMaps,
  mcpKeepBytes,
  startMapCommand,
  KEEP_GRAPHS_BYTES,
  __parseCount,
  __resetParseCounts,
} from "../src/graph/load.js";
import { writeGraph, wiringPath } from "../src/graph/write.js";
import { writeAskIndex, askIndexPath } from "../src/ask/index-file.js";
import { callTool } from "../src/mcp/tools.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

function node(id: string): NodeV1 {
  return {
    id,
    name: id,
    kind: "function",
    path: `${id}.ts`,
    span: "L1-L1",
    signature: null,
    exported: true,
    origin: "ast",
    body_hash: id,
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "graft-load-"));
}

/** Force a distinct (mtimeMs, size) from the previous write, even on
 * filesystems with coarse mtime resolution. */
function bump(path: string): void {
  const st = statSync(path);
  const future = new Date(st.mtimeMs + 1000);
  utimesSync(path, future, future);
}

test("loadGraphCached: two loads of an unchanged file return the same parsed object", () => {
  const dir = fixtureDir();
  writeGraph({ version: 1, nodes: [node("a")], edges: [] } as GraphV1, dir);
  __resetParseCounts();

  const g1 = loadGraphCached(dir);
  const g2 = loadGraphCached(dir);
  assert.ok(g1);
  assert.strictEqual(g1, g2, "second load must reuse the cached object, not re-parse");
  assert.equal(__parseCount.graph, 1);
});

test("loadGraphCached: rewriting the wiring file invalidates the cache", () => {
  const dir = fixtureDir();
  writeGraph({ version: 1, nodes: [node("a")], edges: [] } as GraphV1, dir);
  __resetParseCounts();

  const g1 = loadGraphCached(dir);
  assert.equal(g1?.nodes[0]?.id, "a");
  assert.equal(__parseCount.graph, 1);

  // Rewrite with a changed node, then force a distinct mtime so the cache
  // can't coast on a filesystem with coarse mtime granularity.
  writeGraph({ version: 1, nodes: [node("b")], edges: [] } as GraphV1, dir);
  bump(wiringPath(dir));

  const g2 = loadGraphCached(dir);
  assert.equal(g2?.nodes[0]?.id, "b", "reload must see the new content");
  assert.equal(__parseCount.graph, 2, "changed (mtime, size) must trigger a re-parse");
  assert.notStrictEqual(g1, g2);
});

test("loadGraphCached: missing file returns null and a later-created file is picked up", () => {
  const dir = fixtureDir();
  __resetParseCounts();

  const miss = loadGraphCached(dir);
  assert.equal(miss, null);
  assert.equal(__parseCount.graph, 0, "a miss must not count as a parse");

  const missAgain = loadGraphCached(dir);
  assert.equal(missAgain, null, "missing file must not be negatively cached forever");

  writeGraph({ version: 1, nodes: [node("late")], edges: [] } as GraphV1, dir);
  const found = loadGraphCached(dir);
  assert.equal(found?.nodes[0]?.id, "late");
  assert.equal(__parseCount.graph, 1);
});

test("loadAskIndexCached: caches and invalidates the same way as the graph loader", () => {
  const dir = fixtureDir();
  const graph = { version: 1, nodes: [node("a"), node("b")], edges: [] } as GraphV1;
  writeAskIndex(dir, graph);
  __resetParseCounts();

  const i1 = loadAskIndexCached(dir);
  const i2 = loadAskIndexCached(dir);
  assert.ok(i1);
  assert.strictEqual(i1, i2);
  assert.equal(__parseCount.askIndex, 1);

  writeAskIndex(dir, { version: 1, nodes: [node("a")], edges: [] } as GraphV1);
  bump(askIndexPath(dir));

  const i3 = loadAskIndexCached(dir);
  assert.equal(i3?.docCount, 1);
  assert.equal(__parseCount.askIndex, 2);
});

test("doneWithMap: a one-shot command drops each map once used; a budget keeps the most recently used", () => {
  const dirs = ["a", "b", "c"].map((id) => {
    const dir = fixtureDir();
    writeGraph({ version: 1, nodes: [node(id)], edges: [] } as GraphV1, dir);
    return dir;
  });
  const [a, b, c] = dirs;
  const size = statSync(wiringPath(a)).size;
  assert.ok(dirs.every((d) => statSync(wiringPath(d)).size === size), "the fixture maps are the same size");
  // Each use one command: what a command leaves goes least recently used first.
  const use = (dir: string) => {
    startMapCommand();
    const g = loadGraphCached(dir);
    doneWithMap(dir);
    return g;
  };
  try {
    // No budget, as in a one-shot command: every use parses again.
    __resetParseCounts();
    use(a);
    use(a);
    assert.equal(__parseCount.graph, 2, "with no budget a map is dropped once used");

    // Room for two maps: the least recently used goes when a third comes.
    keepWorkspaceMaps(2 * size);
    const ga = use(a);
    use(b);
    __resetParseCounts();
    assert.strictEqual(use(a), ga, "a kept map is not parsed again");
    use(c);
    assert.equal(__parseCount.graph, 1, "c is parsed; a and b fit");
    use(a);
    assert.equal(__parseCount.graph, 1, "a, used last but one, is still kept");
    use(b);
    assert.equal(__parseCount.graph, 2, "b, the least recently used, made room for c");

    // Lowering the budget drops what no longer fits, at once.
    keepWorkspaceMaps(0);
    __resetParseCounts();
    use(a);
    assert.equal(__parseCount.graph, 1);

    // A map bigger than the whole budget is never kept.
    keepWorkspaceMaps(size - 1);
    __resetParseCounts();
    use(a);
    use(a);
    assert.equal(__parseCount.graph, 2);

    // ... and drops nothing else: the maps kept before it stay.
    const big = fixtureDir();
    writeGraph({ version: 1, nodes: ["d", "e", "f"].map(node), edges: [] } as GraphV1, big);
    assert.ok(statSync(wiringPath(big)).size > 2 * size, "the big map outgrows the budget");
    keepWorkspaceMaps(2 * size);
    use(a);
    use(b);
    __resetParseCounts();
    use(big);
    use(big);
    assert.equal(__parseCount.graph, 2, "the big map is parsed for each use");
    use(a);
    use(b);
    assert.equal(__parseCount.graph, 2, "a and b were kept through it");
  } finally {
    keepWorkspaceMaps(0);
  }
});

test("doneWithMap: a command walking more maps than fit keeps the first ones, so the next walk finds them", () => {
  const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => {
    const dir = fixtureDir();
    writeGraph({ version: 1, nodes: [node(id)], edges: [] } as GraphV1, dir);
    return dir;
  });
  const size = statSync(wiringPath(a)).size;
  const walk = (...dirs: string[]) => {
    startMapCommand();
    for (const dir of dirs) {
      loadGraphCached(dir);
      doneWithMap(dir);
    }
  };
  try {
    keepWorkspaceMaps(2 * size);
    walk(a, b, c);
    __resetParseCounts();
    walk(a, b, c);
    assert.equal(__parseCount.graph, 1, "only c is parsed again: a and b were kept through both walks");

    // A later command still makes room for a map it needs, with what the walks left.
    __resetParseCounts();
    walk(d, d);
    assert.equal(__parseCount.graph, 1, "d is kept for its second use");
    walk(b);
    assert.equal(__parseCount.graph, 1, "b is still kept");
    walk(a);
    assert.equal(__parseCount.graph, 2, "a, the least recently used, made room for d");
  } finally {
    keepWorkspaceMaps(0);
  }
});

test("mcpKeepBytes: a quarter of the heap, never less than what is kept anyway", () => {
  assert.equal(mcpKeepBytes(4e9), 1e9);
  assert.equal(mcpKeepBytes(800e6), KEEP_GRAPHS_BYTES);
});

// This file pins the mtime-keyed load cache, so the pre-query auto-refresh —
// which deliberately invalidates that cache after a rebuild — has to stay out of
// the way. `graph-refresh.test.ts` covers the refresh itself.
process.env.GRAFT_NO_REFRESH = "1";

test("callTool: graft_trace_calls on the same dir twice doesn't reparse the graph", async () => {
  const dir = fixtureDir();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "math.ts"), "export function add() { return 1; }\n");
  const graph: GraphV1 = {
    version: 1,
    // A real `buildGraph` always emits a `kind: "file"` node per source file;
    // include one here too so `graft_trace_calls` with depth (a `resolveSymbol` +
    // `edgeWalk` walk, the old `graft impact`) can resolve the filename-shaped
    // query the way it would against a real build.
    nodes: [
      { ...node("src/math.ts#add"), path: "src/math.ts" },
      { ...node("src/math.ts"), kind: "file", path: "src/math.ts", name: "math.ts", signature: null },
    ],
    edges: [],
  } as GraphV1;
  // graft_trace_calls reads through `contextDirFor(root)`, i.e. `<root>/graft`
  // by default — write the graph there directly rather than round-tripping
  // through a real `graft build`.
  const outDir = join(dir, "graft");
  mkdirSync(outDir, { recursive: true });
  writeGraph(graph, outDir);
  __resetParseCounts();

  const r1 = await callTool(dir, "graft_trace_calls", { symbol: "src/math.ts", depth: 2 });
  assert.equal(r1.isError, false);
  assert.equal(__parseCount.graph, 1);

  const r2 = await callTool(dir, "graft_trace_calls", { symbol: "src/math.ts", depth: 2 });
  assert.equal(r2.isError, false);
  assert.equal(__parseCount.graph, 1, "second call on the same dir must not reparse");
});
