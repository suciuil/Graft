/**
 * Tests for the optional markup/style grammars (CSS, HTML, Razor). Each grammar
 * is an optional, locally-built native dependency; the per-language tests skip
 * when its binding isn't available.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { grammarAvailable } from "../src/graph/extract.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

async function build(files: Record<string, string>): Promise<GraphV1> {
  const dir = mkdtempSync(join(tmpdir(), "graft-mk-"));
  try {
    for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
    await buildGraph(dir);
    return readGraph(wiringPath(join(dir, "graft")))!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CSS extraction: one rule node per selector", { skip: grammarAvailable("css") ? false : "css grammar not built" }, async () => {
  const graph = await build({ "styles.css": ".foo { color: red; }\n#bar { margin: 0; }\ndiv > p.item { padding: 1px; }" });
  assert.equal(nodeById(graph, "styles.css#.foo")?.kind, "rule");
  assert.equal(nodeById(graph, "styles.css##bar")?.kind, "rule");
  assert.equal(nodeById(graph, "styles.css#div > p.item")?.kind, "rule");
});

test("HTML extraction: id'd elements become element nodes", { skip: grammarAvailable("html") ? false : "html grammar not built" }, async () => {
  const graph = await build({ "page.html": '<section id="hero"><a id="lnk">x</a><div>no id</div></section>' });
  assert.equal(nodeById(graph, "page.html#hero")?.kind, "element");
  assert.equal(nodeById(graph, "page.html#hero.lnk")?.kind, "element"); // nested under its id'd ancestor
});

test("Razor extraction: file parses and indexes (C# is opaque)", { skip: grammarAvailable("razor") ? false : "razor grammar not built" }, async () => {
  const graph = await build({ "Counter.razor": '@page "/counter"\n@code {\n  private int count = 0;\n}\n<h1>Counter</h1>' });
  assert.equal(nodeById(graph, "Counter.razor")?.kind, "file");
});
