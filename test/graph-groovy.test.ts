/**
 * Tests for Groovy extraction in the Tier-1 code graph. The Groovy grammar is an
 * optional, locally-built native dependency; these tests skip when its binding
 * isn't built. They assert classes, methods (with owner), free functions, import
 * edges, and same-class call resolution off the loose Groovy grammar shapes.
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

const skip = grammarAvailable("groovy") ? false : "tree-sitter-groovy grammar not built";

const GROOVY = `package com.acme

import java.util.List

class Service {
  def process(items) { return transform(items) }
  int transform(x) { helper(x) }
}

def free(a) { return a + 1 }
`;

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

test("Groovy extraction: classes, methods, free functions, imports, calls", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-groovy-"));
  try {
    writeFileSync(join(dir, "Service.groovy"), GROOVY);
    const result = await buildGraph(dir); // $0, Tier-1 only
    assert.ok(result.languages.includes("groovy"), "languages should include groovy");

    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    assert.ok(graph, "wiring graph should be written");

    // class + its methods, scoped under the class with owner stamped
    assert.equal(nodeById(graph, "Service.groovy#Service")?.kind, "class");
    const process = nodeById(graph, "Service.groovy#Service.process");
    assert.equal(process?.kind, "method");
    assert.equal(process?.owner, "Service");

    // a top-level def is a free function, not a method
    assert.equal(nodeById(graph, "Service.groovy#free")?.kind, "function");

    // same-class call resolves: process() → transform()
    assert.ok(
      graph.edges.find(
        (e) =>
          e.relation === "calls" &&
          e.source === "Service.groovy#Service.process" &&
          e.target === "Service.groovy#Service.transform",
      ),
      "process should have a resolved calls edge to transform",
    );

    // `import java.util.List` is an external import string
    assert.ok(
      graph.edges.find((e) => e.relation === "imports" && e.source === "Service.groovy" && e.target === "java.util.List"),
      "import java.util.List should remain an external import string",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
