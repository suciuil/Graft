/**
 * Tests for the C/C++ depth extractors and the JSON/YAML/Markdown/SCSS breadth
 * extractors. Each grammar is an optional, locally-built native dependency; the
 * per-language tests skip when its binding isn't built.
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
function hasEdge(graph: GraphV1, rel: string, source: string, target: string): boolean {
  return graph.edges.some((e) => e.relation === rel && e.source === source && e.target === target);
}
async function build(files: Record<string, string>): Promise<GraphV1> {
  const dir = mkdtempSync(join(tmpdir(), "graft-lang-"));
  try {
    for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
    await buildGraph(dir);
    return readGraph(wiringPath(join(dir, "graft")))!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("C depth: functions, structs, resolved calls, local include", { skip: grammarAvailable("c") ? false : "c grammar not built" }, async () => {
  const graph = await build({
    "app.c": `#include "util.h"\nstruct Point { int x; };\nint helper(int x){ return x+1; }\nint run(void){ return helper(2); }\n`,
  });
  assert.ok(graph.meta.languages.includes("c"), "languages include c");
  assert.equal(nodeById(graph, "app.c#helper")?.kind, "function");
  assert.equal(nodeById(graph, "app.c#run")?.kind, "function");
  assert.equal(nodeById(graph, "app.c#Point")?.kind, "struct");
  assert.ok(hasEdge(graph, "calls", "app.c#run", "app.c#helper"), "run() → helper() resolves");
  assert.ok(hasEdge(graph, "imports", "app.c", "util.h"), '#include "util.h" is an import edge');
});

test("C++ depth: classes, out-of-line methods, inheritance, calls", { skip: grammarAvailable("cpp") ? false : "cpp grammar not built" }, async () => {
  const graph = await build({
    "app.cpp": `namespace app {\nclass Base {};\nclass Repo : public Base {\npublic:\n  int Save(int x);\n};\nint helper(int x){ return x+1; }\nint Repo::Save(int x){ return helper(x); }\n}\n`,
  });
  assert.ok(graph.meta.languages.includes("cpp"), "languages include cpp");
  assert.equal(nodeById(graph, "app.cpp#Base")?.kind, "class");
  assert.equal(nodeById(graph, "app.cpp#Repo")?.kind, "class");
  assert.equal(nodeById(graph, "app.cpp#Repo.Save")?.kind, "method");
  assert.ok(hasEdge(graph, "extends", "app.cpp#Repo", "app.cpp#Base"), "Repo extends Base");
  assert.ok(hasEdge(graph, "calls", "app.cpp#Repo.Save", "app.cpp#helper"), "Repo::Save → helper resolves");
});

test("JSON breadth: object keys become scoped variable nodes", { skip: grammarAvailable("json") ? false : "json grammar not built" }, async () => {
  const graph = await build({ "pkg.json": '{"name":"app","scripts":{"build":"tsc"}}' });
  assert.ok(graph.meta.languages.includes("json"), "languages include json");
  assert.equal(nodeById(graph, "pkg.json#name")?.kind, "variable");
  assert.equal(nodeById(graph, "pkg.json#scripts")?.kind, "variable");
  assert.equal(nodeById(graph, "pkg.json#scripts.build")?.kind, "variable");
});

test("YAML breadth: mapping keys become scoped variable nodes", { skip: grammarAvailable("yaml") ? false : "yaml grammar not built" }, async () => {
  const graph = await build({ "conf.yaml": "name: app\nservices:\n  web:\n    image: nginx\n" });
  assert.ok(graph.meta.languages.includes("yaml"), "languages include yaml");
  assert.equal(nodeById(graph, "conf.yaml#name")?.kind, "variable");
  assert.equal(nodeById(graph, "conf.yaml#services.web")?.kind, "variable");
  assert.equal(nodeById(graph, "conf.yaml#services.web.image")?.kind, "variable");
});

test("Markdown breadth: headings become scoped heading nodes", { skip: grammarAvailable("markdown") ? false : "markdown grammar not built" }, async () => {
  const graph = await build({ "doc.md": "# Title\n\nintro\n\n## Section A\n\ntext\n\n### Sub\n" });
  assert.ok(graph.meta.languages.includes("markdown"), "languages include markdown");
  assert.equal(nodeById(graph, "doc.md#Title")?.kind, "heading");
  assert.equal(nodeById(graph, "doc.md#Title.Section A")?.kind, "heading");
  assert.equal(nodeById(graph, "doc.md#Title.Section A.Sub")?.kind, "heading");
});

test("SCSS breadth: rules/mixins/variables + @include call edge", { skip: grammarAvailable("scss") ? false : "scss grammar not built" }, async () => {
  const graph = await build({ "a.scss": "$c: red;\n@mixin box($p){ padding: $p; }\n.foo { @include box(1px); color: $c; }\n" });
  assert.ok(graph.meta.languages.includes("scss"), "languages include scss");
  assert.equal(nodeById(graph, "a.scss#$c")?.kind, "variable");
  assert.equal(nodeById(graph, "a.scss#box")?.kind, "function");
  assert.equal(nodeById(graph, "a.scss#.foo")?.kind, "rule");
  assert.ok(hasEdge(graph, "calls", "a.scss#.foo", "a.scss#box"), "@include box → mixin box resolves");
});

test("CSV breadth: header columns become variable nodes", { skip: grammarAvailable("csv") ? false : "csv grammar not built" }, async () => {
  const graph = await build({ "data.csv": "id,name,age\n1,ann,30\n2,bob,25\n" });
  assert.ok(graph.meta.languages.includes("csv"), "languages include csv");
  assert.equal(nodeById(graph, "data.csv#id")?.kind, "variable");
  assert.equal(nodeById(graph, "data.csv#name")?.kind, "variable");
  assert.equal(nodeById(graph, "data.csv#age")?.kind, "variable");
});

test("C++ header: a .h with a class is parsed as C++, not C", { skip: grammarAvailable("cpp") ? false : "cpp grammar not built" }, async () => {
  const graph = await build({ "widget.h": "class Widget {\npublic:\n  int area();\n};\n" });
  assert.equal(nodeById(graph, "widget.h#Widget")?.kind, "class");
});

