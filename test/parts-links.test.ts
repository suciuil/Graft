/**
 * Cross-part links for a repository built in parts: the resolver's collector
 * (what a part could not settle by itself), the boundary each part writes, and
 * the link step that resolves the collected edges against every part.
 */
import "./isolate.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readExtractCache } from "../src/graph/extract-cache.js";
import { boundaryDataPath, boundaryHash, boundaryPath, hasBoundary, readBoundary, readBoundaryData, writeBoundary } from "../src/graph/boundary.js";
import { contextDirFor } from "../src/context/node-file.js";
import { resolveEdges, type ResolveCollector } from "../src/graph/resolve.js";
import { buildAllParts } from "../src/graph/parts-build.js";
import { linkParts, linksPath, linksState, readLinks, type LinksV1 } from "../src/graph/parts-link.js";
import { refreshLinks } from "../src/graph/refresh.js";
import { invalidateGraphCaches, loadGraphCached } from "../src/graph/load.js";
import { childFor, federateAsk, federateCallers, federateGrep, federateMap } from "../src/graph/workspace.js";
import { ask, type AskResult } from "../src/ask/ask.js";
import { grepGraph, type GrepGroup, type GrepResult } from "../src/search/grep.js";
import { callTool } from "../src/mcp/tools.js";
import { dayKey, ledgerPath, readLedger, savingsRoot } from "../src/claude/ledger.js";
import { sumSavingsFooters } from "../src/context/savings.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";
import type { RawEdge } from "../src/graph/extract.js";

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
}

function n(id: string, kind: NodeV1["kind"], extra: Partial<NodeV1> = {}): NodeV1 {
  const post = id.includes("#") ? id.split("#")[1] : id;
  const segs = post.split(".");
  const name = segs[segs.length - 1];
  const owner = kind === "method" && segs.length >= 2 ? segs[segs.length - 2] : undefined;
  return {
    id, name, kind, owner, path: id.split("#")[0], span: "L1-L1", signature: null,
    exported: true, origin: "ast", body_hash: "h", summary_state: "pending", summary: null, crux: null,
    ...extra,
  } as NodeV1;
}

/** A collector that records what it is told. */
function recorder(): ResolveCollector & { unresolvedEdges: RawEdge[]; inferredEdges: { e: RawEdge; target: string }[] } {
  const unresolvedEdges: RawEdge[] = [];
  const inferredEdges: { e: RawEdge; target: string }[] = [];
  return {
    unresolvedEdges,
    inferredEdges,
    unresolved: (e) => unresolvedEdges.push(e),
    inferred: (e, target) => inferredEdges.push({ e, target }),
  };
}

test("collector: resolving with a collector gives exactly the edges resolving without one gives", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-collect-"));
  try {
    writeTree(root, {
      "web/app.ts": [
        "import { render } from './view';",
        "import { missing } from './gone';",
        "import lodash from 'lodash';",
        "export class App extends Base implements Shape {",
        "  run(v: View) { render(); v.paint(); helper(); unknownFn(); }",
        "}",
      ].join("\n"),
      "web/view.ts": "export function render() {}\nexport class View { paint() {} }\nexport function helper() {}\n",
      "py/main.py": "from py.util import tool\n\ndef go():\n    tool()\n    Widget()\n    print('x')\n",
      "py/util.py": "def tool():\n    pass\n\nclass Widget:\n    pass\n",
      "c/a.c": '#include "a.h"\n#include "other/none.h"\nvoid f(void) { g(); printf("x"); }\n',
      "c/a.h": "void g(void);\n",
      "c/b.c": "void g(void) {}\n",
    });
    const built = await buildGraph(root);
    const cache = readExtractCache(built.contextDir);
    const nodes: NodeV1[] = [];
    const raw: RawEdge[] = [];
    for (const entry of Object.values(cache.files)) {
      nodes.push(...entry.nodes);
      raw.push(...entry.rawEdges);
    }
    assert.ok(raw.length > 10, "the fixture has edges to resolve");
    const plain = resolveEdges(nodes, raw);
    const rec = recorder();
    const collected = resolveEdges(nodes, raw, { collect: rec });
    assert.equal(JSON.stringify(collected), JSON.stringify(plain));
    assert.equal(collected.length, built.edges);
    // It was told something: the unresolved import and calls, at least.
    assert.ok(rec.unresolvedEdges.some((e) => e.relation === "imports" && e.specifier === "./gone"));
    assert.ok(rec.unresolvedEdges.some((e) => e.relation === "calls" && e.name === "unknownFn"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collector: reports what found nothing and what a unique name guessed, never what was ambiguous", () => {
  const nodes = [
    n("a/app.ts", "file"),
    n("a/app.ts#main", "function"),
    n("a/app.ts#Child", "class"),
    n("a/app.ts#Child.run", "method"),
    n("a/lib.ts", "file"),
    n("a/lib.ts#unique", "function"),
    n("a/x.ts", "file"),
    n("a/x.ts#twice", "function"),
    n("a/y.ts", "file"),
    n("a/y.ts#twice", "function"),
    n("a/z.py", "file"),
    n("a/z.py#onlyPython", "function"),
  ];
  const f = "a/app.ts";
  const raw: RawEdge[] = [
    { source: f, relation: "imports", specifier: "./nowhere", file: f },
    { source: f, relation: "imports", specifier: "./lib", file: f },
    { source: `${f}#Child`, relation: "extends", name: "ParentElsewhere", file: f },
    { source: `${f}#main`, relation: "calls", name: "unique", file: f },
    { source: `${f}#main`, relation: "calls", name: "twice", file: f },
    { source: `${f}#main`, relation: "calls", name: "nothingLikeIt", file: f },
    // A Python definition is no candidate for a TypeScript call.
    { source: `${f}#main`, relation: "calls", name: "onlyPython", file: f },
    { source: `${f}#main`, relation: "calls", name: "run", viaMember: true, recvType: "Foreign", file: f },
    { source: `${f}#main`, relation: "calls", name: "run", viaMember: true, recvType: "Child", file: f },
    // No receiver type: no map resolves it, so it is not reported.
    { source: `${f}#main`, relation: "calls", name: "whatever", viaMember: true, file: f },
  ];
  const rec = recorder();
  const edges = resolveEdges(nodes, raw, { collect: rec });
  const desc = (e: RawEdge) => `${e.relation}:${e.specifier ?? e.name}${e.recvType ? `@${e.recvType}` : ""}`;
  assert.deepEqual(rec.unresolvedEdges.map(desc).sort(), [
    "calls:nothingLikeIt",
    "calls:onlyPython",
    "calls:run@Foreign",
    "extends:ParentElsewhere",
    "imports:./nowhere",
  ]);
  assert.deepEqual(rec.inferredEdges.map((x) => `${desc(x.e)}->${x.target}`), ["calls:unique->a/lib.ts#unique"]);
  // The edges themselves are what they always were.
  assert.deepEqual(resolveEdges(nodes, raw), edges);
});

/** Two parts of one repository: a library, and an app that imports and calls it. */
function twoParts(root: string): void {
  writeTree(root, {
    "Src/Lib/lib.ts": [
      "export function sharedUtil(): number { return 1; }",
      "export class Base { hello(): void {} }",
      "export function libOnly(): void { sharedUtil(); }",
    ].join("\n"),
    "Src/App/app.ts": [
      "import { sharedUtil, Base } from '../Lib/lib';",
      "export class Widget extends Base { draw(): void { this.hello(); } }",
      "export function useIt(): number { return sharedUtil() + local(); }",
      "function local(): number { return 2; }",
    ].join("\n"),
  });
}

test("boundary: a part's build writes what it could not settle, and a refresh keeps it current", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-boundary-"));
  try {
    twoParts(root);
    const app = join(root, "Src/App");
    const map = contextDirFor(app);
    await buildGraph(app, { boundary: true });
    assert.ok(hasBoundary(map));
    assert.ok(boundaryPath(map)?.includes("boundary."));
    const b = readBoundary(map)!;
    assert.ok(b, "the boundary reads back");
    assert.equal(b.hash, boundaryHash(map), "the hash reads from the head of the file");
    assert.ok(b.nodes.some((n) => n.id === "app.ts#useIt" && n.kind === "function"));
    assert.ok(!("body_text" in b.nodes[0]!), "nodes are stubs");
    const pend = (rel: string, what: string) =>
      b.pending.some((p) => p.edge.relation === rel && (p.edge.specifier ?? p.edge.name) === what);
    assert.ok(pend("imports", "../Lib/lib"), "the import of the other part");
    assert.ok(pend("calls", "sharedUtil"), "the call into the other part");
    assert.ok(pend("extends", "Base"), "the base class in the other part");
    assert.ok(!pend("calls", "local"), "a call settled inside the part is not pending");
    assert.ok(!b.heritage.some((e) => e.name === "Base"), "a base type already pending is not in heritage again");
    assert.equal(b.pending.find((p) => p.edge.relation === "imports")?.kept, "../Lib/lib");

    // A rebuild that does not ask for it (the refresh before a query) keeps it, unchanged.
    await buildGraph(app, { graphOnly: true });
    assert.equal(boundaryHash(map), b.hash, "same code, same boundary");
    writeFileSync(join(app, "more.ts"), "export function more(): void { sharedUtil(); }\n");
    await buildGraph(app, { graphOnly: true });
    assert.notEqual(boundaryHash(map), b.hash, "an edit moves the hash");

    // A map that is no part gets none.
    const lib = join(root, "Src/Lib");
    await buildGraph(lib);
    assert.equal(hasBoundary(contextDirFor(lib)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A repository of several languages whose parts call, import and extend each other. */
const MIXED: Record<string, string> = {
  "Src/Lib/lib.ts": [
    "export function sharedUtil(): number { return 1; }",
    "export class Base { hello(): void {} }",
    "export function helper(): void {}",
  ].join("\n"),
  "Src/App/app.ts": [
    "import { sharedUtil, Base } from '../Lib/lib';",
    "export class Widget extends Base { draw(): void { this.hello(); } }",
    "export function useIt(): number { helper(); return sharedUtil() + local(); }",
    "function local(): number { return 2; }",
  ].join("\n"),
  // `helper` again: unique inside the app part, ambiguous across the repository.
  "Src/App/more.ts": "export function helper(): void {}\n",
  "Src/Lib/clib.h": "int lib_add(int a, int b);\n",
  "Src/Lib/clib.c": "#include \"clib.h\"\nint lib_add(int a, int b) { return a + b; }\n",
  "Src/App/main.c": "#include \"clib.h\"\nint run(void) { return lib_add(1, 2); }\n",
  "Src/Lib/base.py": "class Animal:\n    def speak(self):\n        return 1\n",
  "Src/App/dog.py": "from base import Animal\n\nclass Dog(Animal):\n    def bark(self):\n        return self.speak()\n",
};

const PARTS = ["Src/App", "Src/Lib"];

async function buildInParts(root: string): Promise<void> {
  const res = await buildAllParts(root, PARTS, {
    buildPart: async (dir) => {
      await buildGraph(dir, { boundary: true });
    },
  });
  assert.deepEqual(res.failed, []);
}

function graphOf(dir: string): GraphV1 {
  const map = contextDirFor(dir);
  invalidateGraphCaches(map);
  const g = loadGraphCached(map);
  assert.ok(g, `a map at ${dir}`);
  return g;
}

/**
 * The edges of the repository built as one map, against the parts' maps with
 * their links, less the edges the links void: the same, edge for edge.
 */
function compareWithOneMap(single: GraphV1, root: string, links: LinksV1, opts: { dangling?: false } = {}): void {
  const ids = new Set(single.nodes.map((x) => x.id));
  // `dangling: false`: leave out the edges to no node (a bare name or specifier a
  // map keeps). A guess the other parts make ambiguous is void in its part, but
  // the bare specifier one map keeps instead is not added back.
  const keep = (target: string, partIds?: Set<string>) => opts.dangling !== false || (partIds ? partIds.has(target) : ids.has(target));
  const part = (id: string) => childFor(PARTS, id.split("#")[0])?.child;
  const cut = (p: string, id: string) => id.slice(p.length + 1);
  const wantCross: string[] = [];
  const wantLocal: string[] = [];
  for (const e of single.edges) {
    const from = part(e.source)!;
    const to = ids.has(e.target) ? part(e.target) : undefined;
    if (to !== undefined && to !== from) {
      wantCross.push(`${from}|${cut(from, e.source)}|${e.relation}|${to}|${cut(to, e.target)}`);
    } else if (keep(e.target)) {
      wantLocal.push(`${from}|${cut(from, e.source)}|${e.relation}|${to === undefined ? e.target : cut(to, e.target)}`);
    }
  }
  const voids = new Set(links.voids.map((v) => `${v.part}|${v.source}|${v.relation}|${v.target}`));
  const gotLocal: string[] = [];
  for (const p of PARTS) {
    const g = graphOf(join(root, p));
    const partIds = new Set(g.nodes.map((x) => x.id));
    for (const e of g.edges) {
      const key = `${p}|${e.source}|${e.relation}|${e.target}`;
      if (!voids.has(key) && keep(e.target, partIds)) gotLocal.push(key);
    }
  }
  // A link inside one part: an edge its part could not settle alone.
  for (const l of links.links) if (l.from === l.to) gotLocal.push(`${l.from}|${l.source}|${l.relation}|${l.target}`);
  const gotCross = links.links.filter((l) => l.from !== l.to).map((l) => `${l.from}|${l.source}|${l.relation}|${l.to}|${l.target}`);
  assert.deepEqual(gotCross.sort(), wantCross.sort(), "the links are the edges between the parts");
  assert.deepEqual(gotLocal.sort(), wantLocal.sort(), "the parts' edges, less the voids, are the edges inside them");
}

test("links: the parts with their links have the edges one map of the repository has", async () => {
  const one = mkdtempSync(join(tmpdir(), "graft-links-one-"));
  const split = mkdtempSync(join(tmpdir(), "graft-links-parts-"));
  try {
    writeTree(one, MIXED);
    writeTree(split, MIXED);
    await buildGraph(one);
    const single = graphOf(one);
    await buildInParts(split);
    const links = readLinks(split);
    assert.ok(links, "the build made links, current with the parts");
    assert.deepEqual(links.missing, []);
    const has = (from: string, rel: string, to: string) =>
      links.links.some((l) => `${l.from}/${l.source}` === from && l.relation === rel && `${l.to}/${l.target}` === to);
    assert.ok(has("Src/App/app.ts#useIt", "calls", "Src/Lib/lib.ts#sharedUtil"), "a call into the other part");
    assert.ok(has("Src/App/app.ts#Widget", "extends", "Src/Lib/lib.ts#Base"), "a base class in the other part");
    assert.ok(has("Src/App/app.ts#Widget.draw", "calls", "Src/Lib/lib.ts#Base.hello"), "a member up a class chain across parts");
    assert.ok(links.voids.some((v) => v.source === "app.ts#Widget" && v.target === "Base"), "the bare base name is void");
    compareWithOneMap(single, split, links);
  } finally {
    rmSync(one, { recursive: true, force: true });
    rmSync(split, { recursive: true, force: true });
  }
});

/** Build `files` as one map and in {@link PARTS}; the one map and the parts' links. */
async function bothWays(
  files: Record<string, string>,
  body: (single: GraphV1, root: string, links: LinksV1, oneRoot: string) => void | Promise<void>,
): Promise<void> {
  const one = mkdtempSync(join(tmpdir(), "graft-links-one-"));
  const split = mkdtempSync(join(tmpdir(), "graft-links-parts-"));
  try {
    writeTree(one, files);
    writeTree(split, files);
    await buildGraph(one);
    await buildInParts(split);
    const links = readLinks(split);
    assert.ok(links, "the build made links, current with the parts");
    await body(graphOf(one), split, links, one);
  } finally {
    rmSync(one, { recursive: true, force: true });
    rmSync(split, { recursive: true, force: true });
  }
}

test("links: a PHP trait used from another part, and one from the same part, each counted once", async () => {
  await bothWays(
    {
      "Src/Lib/Greets.php": "<?php\ntrait Greets {\n  public function greet() { return 1; }\n}\n",
      "Src/App/Helps.php": "<?php\ntrait Helps {\n  public function help() { return 2; }\n}\n",
      "Src/App/Widget.php": [
        "<?php",
        "class Widget {",
        "  use Greets;",
        "  use Helps;",
        "  public function run() { $this->greet(); return $this->help(); }",
        "}",
        "",
      ].join("\n"),
    },
    (single, root, links) => {
      const call = (s: string, t: string) => single.edges.some((e) => e.relation === "calls" && e.source.endsWith(s) && e.target.endsWith(t));
      assert.ok(call("Widget.run", "Greets.greet") && call("Widget.run", "Helps.help"), "one map resolves both trait calls");
      assert.ok(
        links.links.some((l) => l.relation === "calls" && l.source.endsWith("Widget.run") && l.target.endsWith("Greets.greet")),
        "the trait method in the other part is linked",
      );
      assert.ok(!links.voids.some((v) => v.target.endsWith("Helps.help")), "the same part's trait call is kept");
      compareWithOneMap(single, root, links);
    },
  );
});

test("links: an edge its part could not settle alone that leads back into the same part is linked there", async () => {
  await bothWays(
    {
      "Src/App/util.ts": "export function helper(): number {\n  return 1;\n}\n",
      "Src/App/app.ts": 'import { helper } from "../App/util";\nexport function useIt(): number {\n  return helper();\n}\n',
      "Src/Lib/lib.ts": "export function other(): number {\n  return 2;\n}\n",
    },
    (single, root, links, one) => {
      assert.ok(
        single.edges.some((e) => e.relation === "imports" && e.source === "Src/App/app.ts" && e.target === "Src/App/util.ts"),
        "one map follows the import out of the folder and back into it",
      );
      const view = (r: AskResult) => ({ mode: r.mode, hits: r.hits.map((h) => `${h.relation} ${h.title} ${h.pointer}`).sort() });
      const want = view(ask(one, "what does app.ts import", { limit: 20 }));
      assert.deepEqual(want, { mode: "structural", hits: ["imports util.ts Src/App/util.ts:L1-L4"] }, "one map answers");
      assert.deepEqual(view(federateAsk(root, undefined, "what does app.ts import", { limit: 20 })), want, "the parts answer the same");
      assert.ok(
        links.links.some((l) => l.from === "Src/App" && l.to === "Src/App" && l.relation === "imports" && l.source === "app.ts" && l.target === "util.ts"),
        "the part's import is linked inside the part",
      );
      assert.ok(links.voids.some((v) => v.part === "Src/App" && v.relation === "imports" && v.target === "../App/util"), "the bare specifier is void");
      compareWithOneMap(single, root, links);

      // Its importer is listed with the part's own, as one map lists it.
      const into = federateCallers(root, undefined, "util.ts");
      assert.match(into.text, /## Src\/App\/\n[^\n]+\n\s+imports ← app\.ts \(app\.ts:/, into.text);
      assert.doesNotMatch(into.text, /across parts/, "the link stays inside the part");
      const out = federateCallers(root, undefined, "app.ts", { direction: "out" });
      assert.match(out.text, /imports → util\.ts \(util\.ts:/, out.text);
      assert.doesNotMatch(out.text, /unresolved import/, "the void specifier is not listed");
    },
  );
});

test("links: a header found by its name in its part alone is void when another part has one of that name", async () => {
  await bothWays(
    {
      "Src/App/inc/config.h": "int app_cfg(void);\n",
      "Src/App/src/main.c": "#include \"config.h\"\nint run(void) { return app_cfg(); }\n",
      "Src/Lib/inc/config.h": "int lib_cfg(void);\n",
      "Src/Lib/src/lib.c": "#include \"../inc/config.h\"\nint lib_cfg(void) { return 1; }\n",
    },
    (single, root, links) => {
      assert.ok(
        !single.edges.some((e) => e.relation === "imports" && e.source.endsWith("main.c") && e.target.endsWith("inc/config.h")),
        "one map finds two config.h and keeps the bare name",
      );
      assert.ok(
        links.voids.some((v) => v.part === "Src/App" && v.relation === "imports" && v.target === "inc/config.h"),
        "the part's guess is void",
      );
      assert.ok(links.voids.every((v) => v.part !== "Src/Lib"), "a path relative to the file is no guess");
      compareWithOneMap(single, root, links, { dangling: false });
    },
  );
});

test("links: a Python call whose functions are ambiguous in its part reaches a class in another part", async () => {
  await bothWays(
    {
      "Src/App/f1.py": "def Foo():\n    return 1\n",
      "Src/App/f2.py": "def Foo():\n    return 2\n",
      "Src/App/use.py": "def make():\n    return Foo()\n",
      "Src/Lib/foo.py": "class Foo:\n    pass\n",
    },
    (single, root, links) => {
      // One map drops the ambiguous functions too, then finds the one class.
      const want = single.edges.some((e) => e.relation === "calls" && e.source.endsWith("use.py#make") && e.target === "Src/Lib/foo.py#Foo");
      const got = links.links.some((l) => l.source === "use.py#make" && l.to === "Src/Lib" && l.target === "foo.py#Foo");
      assert.ok(want, "one map reaches the class");
      assert.ok(got, "so do the parts, through a link");
      compareWithOneMap(single, root, links);
    },
  );
});

test("links: data nodes are kept out of the boundary, and read for a file another part imports by name", async () => {
  await bothWays(
    {
      "Src/Lib/package.json": '{\n  "libVersion": "1.0.0",\n  "nested": { "deep": 1 }\n}\n',
      "Src/Lib/lib.ts": "export function libOnly(): void {}\n",
      "Src/App/cfg.ts": "import { libVersion } from '../Lib/package.json';\nexport function showVersion(): string { return libVersion; }\n",
    },
    async (single, root, links) => {
      assert.ok(
        single.edges.some((e) => e.source === "Src/App/cfg.ts#showVersion" && e.target === "Src/Lib/package.json#libVersion"),
        "one map links the named import to the key",
      );
      const lib = contextDirFor(join(root, "Src/Lib"));
      const b = readBoundary(lib)!;
      assert.ok(b.nodes.some((x) => x.id === "package.json"), "the data file itself stays in");
      assert.ok(b.nodes.some((x) => x.id === "lib.ts#libOnly"), "and so does the code");
      assert.ok(!b.nodes.some((x) => x.path === "package.json" && x.kind !== "file"), "its keys are kept apart");
      assert.deepEqual(b.data?.files, ["package.json"]);
      const data = readBoundaryData(lib, b.data!.hash);
      assert.ok(data?.some((x) => x.id === "package.json#nested.deep"));
      assert.equal(readBoundaryData(lib, "0000000000000000"), null, "data nodes of another hash are not read");
      const app = contextDirFor(join(root, "Src/App"));
      assert.equal(readBoundary(app)?.data, null, "a part without data has none");
      assert.equal(existsSync(boundaryDataPath(app)!), false);
      assert.ok(
        links.links.some((l) => l.source === "cfg.ts#showVersion" && l.to === "Src/Lib" && l.target === "package.json#libVersion"),
        "the named import of the other part's key is linked",
      );
      compareWithOneMap(single, root, links);

      // A data edit moves the boundary's hash, so the links go stale.
      writeFileSync(join(root, "Src/Lib/package.json"), '{\n  "libVersion": "2.0.0",\n  "other": 1\n}\n');
      await buildGraph(join(root, "Src/Lib"), { graphOnly: true });
      assert.notEqual(boundaryHash(lib), b.hash);
      assert.equal(linksState(root).state, "stale");
    },
  );
});

test("grep and map: a part's in-degree counts the links into it, less the edges they void, as one map does", async () => {
  const one = mkdtempSync(join(tmpdir(), "graft-links-one-"));
  const split = mkdtempSync(join(tmpdir(), "graft-links-parts-"));
  try {
    writeTree(one, MIXED);
    writeTree(split, MIXED);
    await buildGraph(one);
    await buildInParts(split);
    const pattern = "sharedUtil|helper|hello|lib_add|speak";
    const key = (g: GrepGroup) => `${g.symbol!.path}#${g.symbol!.id.slice(g.symbol!.id.indexOf("#") + 1)}`;
    const degrees = (r: GrepResult) => Object.fromEntries(r.groups.filter((g) => g.symbol).map((g) => [key(g), g.inDegree]));
    const want = degrees(grepGraph(graphOf(one), one, pattern));
    const got = degrees(federateGrep(split, undefined, pattern).result);
    assert.equal(want["Src/Lib/lib.ts#sharedUtil"], 1, "one map: the call from the other part");
    assert.equal(want["Src/App/more.ts#helper"], 0, "one map: an ambiguous name is no edge");
    assert.deepEqual(got, want);

    const map = federateMap(split, undefined);
    const lib = map.slice(map.indexOf("## Src/Lib/"));
    assert.match(lib, /sharedUtil/, "a function called only from another part is a hub of its own part");
  } finally {
    rmSync(one, { recursive: true, force: true });
    rmSync(split, { recursive: true, force: true });
  }
});

test("ask: a structural question across parts has the answer one map has", async () => {
  await bothWays(MIXED, (_single, root, _links, one) => {
    const view = (r: AskResult) => ({ mode: r.mode, hits: r.hits.map((h) => `${h.relation} ${h.title} ${h.pointer}`).sort() });
    for (const q of ["who calls sharedUtil", "who calls Base.hello", "who calls lib_add", "callers of speak", "what does useIt call"]) {
      const want = view(ask(one, q, { limit: 20 }));
      assert.equal(want.mode, "structural", `one map answers ${q}`);
      assert.deepEqual(view(federateAsk(root, undefined, q, { limit: 20 })), want, q);
    }
    const shared = federateAsk(root, undefined, "who calls sharedUtil", { limit: 20, source: true });
    const useIt = shared.hits.find((h) => h.title === "useIt");
    assert.match(useIt?.code ?? "", /sharedUtil\(\)/, "the code of a caller in another part is inlined");

    // A name the other parts make ambiguous has no edge in one map: ranked matches, with the note.
    const amb = federateAsk(root, undefined, "who calls helper", { limit: 20 });
    assert.notEqual(amb.mode, "structural");
    assert.match(amb.note ?? "", /structural index: no entries for 'helper'/);
    assert.notEqual(ask(one, "who calls helper", { limit: 20 }).mode, "structural");
  });
});

/** {@link MIXED} with TypeScript files long enough that reading one whole costs more than an answer. */
const LONG: Record<string, string> = Object.fromEntries(
  Object.entries(MIXED).map(([rel, text]) => [
    rel,
    rel.endsWith(".ts")
      ? `${text}\n${Array.from({ length: 300 }, (_, i) => `// a long comment, so that reading this file whole costs tokens: line ${i}`).join("\n")}\n`
      : text,
  ]),
);

test("savings: a repository built in parts reports what graft saved, as one map does", async () => {
  await bothWays(LONG, async (_single, root, _links, one) => {
    // ask: the same files read whole as one map's answer, only with the code inlined.
    for (const q of ["who calls sharedUtil", "who calls Base.hello", "what does useIt call"]) {
      const want = ask(one, q, { limit: 20, source: true }).saved;
      assert.ok(want && want.files > 0, `one map estimates ${q}`);
      assert.deepEqual(federateAsk(root, undefined, q, { limit: 20, source: true }).saved, want, q);
      assert.equal(federateAsk(root, undefined, q, { limit: 20 }).saved, undefined, "no estimate without the code");
    }
    const ranked = federateAsk(root, undefined, "Widget draw hello", { limit: 5, source: true });
    assert.notEqual(ranked.mode, "structural");
    assert.ok(ranked.saved && ranked.saved.files > 0, "a ranked answer across parts is estimated too");
    assert.ok(ranked.saved.files <= new Set(ranked.hits.map((h) => h.pointer.split(":")[0])).size);

    // Over MCP: priced, and filed in the repository's ledger.
    const found = await callTool(root, "graft_find_code", { query: "who calls sharedUtil", model: "claude-opus-5" });
    assert.equal(found.isError, false, found.text);
    assert.match(found.text, /tokens saved ≈ [\d,]+/);
    assert.match(found.text, /worth \$\d/);
    assert.ok(readLedger(root).days[dayKey()]["claude-opus-5"]?.savedTokens > 0);

    // callers: one line for the whole answer, over the same files as one map's.
    const files = (text: string) => [...text.matchAll(/reading the (\d+) file\(s\) it covers whole ≈ ([\d,]+) tok/g)].map((m) => `${m[1]} ${m[2]}`);
    const trace = await callTool(root, "graft_trace_calls", { symbol: "sharedUtil", model: "claude-opus-5" });
    assert.equal(files(trace.text).length, 1, trace.text);
    assert.deepEqual(files(trace.text), files((await callTool(one, "graft_trace_calls", { symbol: "sharedUtil", model: "claude-opus-5" })).text));

    // map: one line for every part together.
    const map = federateMap(root, undefined);
    assert.equal(map.match(/^\[graft\] tokens saved ≈/gm)?.length, 1, map);
    assert.match(map, /## Src\/App\/[\s\S]*## Src\/Lib\//);
  });
});

test("savings: what graft saved inside a part is filed in the repository's ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-links-ledger-"));
  try {
    writeTree(root, LONG);
    await buildInParts(root);
    const app = join(root, "Src/App");
    assert.equal(savingsRoot(app), resolve(root));
    assert.equal(savingsRoot(join(app, "deeper", "still")), resolve(root), "a folder inside a part");
    assert.equal(savingsRoot(root), resolve(root));
    assert.equal(savingsRoot(join(root, "Src")), resolve(join(root, "Src")), "a folder holding parts is no part");
    assert.equal(ledgerPath(app), ledgerPath(root));

    const before = readLedger(root).days[dayKey()]?.["claude-opus-5"]?.savedTokens ?? 0;
    const res = await callTool(app, "graft_find_code", { query: "who calls sharedUtil", model: "claude-opus-5" });
    assert.equal(res.isError, false, res.text);
    const claimed = sumSavingsFooters(res.text);
    assert.ok(claimed > 0, "the part's own answer is estimated");
    assert.equal(readLedger(root).days[dayKey()]["claude-opus-5"].savedTokens, before + claimed);
    assert.ok(!existsSync(join(contextDirFor(app), ".cache", "savings.json")), "no ledger of the part's own");

    // GRAFT_DIR names one map for every folder: nothing above can be told apart.
    process.env.GRAFT_DIR = join(root, "elsewhere");
    try {
      assert.equal(savingsRoot(app), resolve(app));
    } finally {
      delete process.env.GRAFT_DIR;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("links: a part rebuilt makes the links stale, and the refresh makes them again", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-links-stale-"));
  try {
    writeTree(root, MIXED);
    await buildInParts(root);
    assert.equal(linksState(root).state, "current");
    const first = readLinks(root)!;
    assert.strictEqual(readLinks(root)!.links, first.links, "links read again are not parsed again");
    const before = statSync(linksPath(root)).mtimeMs;
    await refreshLinks(root);
    assert.equal(statSync(linksPath(root)).mtimeMs, before, "current links are left alone");
    // The library loses `sharedUtil`; its map is rebuilt (as the refresh before a query does).
    writeFileSync(join(root, "Src/Lib/lib.ts"), "export class Base { hello(): void {} }\n");
    await buildGraph(join(root, "Src/Lib"), { graphOnly: true });
    assert.equal(linksState(root).state, "stale");
    assert.equal(readLinks(root), null, "stale links are not used");
    await refreshLinks(root, { disabled: true });
    assert.equal(linksState(root).state, "stale", "--no-refresh leaves them as they are");
    await refreshLinks(root);
    assert.equal(linksState(root).state, "current");
    assert.ok(!existsSync(join(contextDirFor(root), ".cache", ".sync.lock")), "the lock is given back");
    const links = readLinks(root)!;
    assert.notStrictEqual(links.links, first.links, "links made again are read again");
    assert.ok(!links.links.some((l) => l.target === "lib.ts#sharedUtil"), "the link to what is gone is gone");
    assert.ok(links.links.some((l) => l.target === "lib.ts#Base"));

    // A failed link step says why, once: it is not tried again until a part changes.
    writeFileSync(join(root, "Src/Lib/lib.ts"), "export class Base { hello(): void {} }\nexport function more(): void {}\n");
    await buildGraph(join(root, "Src/Lib"), { graphOnly: true });
    const stub = join(root, "link-fails.mjs");
    writeFileSync(stub, 'process.stderr.write("out of memory\\n"); process.exit(1);\n');
    process.env.GRAFT_TEST_REFRESH_RUN = stub;
    try {
      assert.match((await refreshLinks(root)) ?? "", /links between the parts could not be made \(out of memory\)/);
      assert.equal(await refreshLinks(root), null, "not tried again for the same parts");
      assert.equal(linksState(root).state, "stale");
    } finally {
      delete process.env.GRAFT_TEST_REFRESH_RUN;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("links: parts with no boundary are named, and no links are made from none", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-links-none-"));
  try {
    writeTree(root, MIXED);
    await buildAllParts(root, PARTS, { buildPart: async (dir) => void (await buildGraph(dir)) });
    assert.equal(linksState(root).state, "none");
    assert.deepEqual(linkParts(root), { linked: 0, missing: PARTS, links: 0, voids: 0 });
    // One part with a boundary: links are made, the other part is named as not linked.
    await buildGraph(join(root, "Src/App"), { boundary: true, graphOnly: true });
    const l = linkParts(root)!;
    assert.equal(l.linked, 1);
    assert.deepEqual(l.missing, ["Src/Lib"]);
    const s = linksState(root);
    assert.equal(s.state, "current");
    assert.deepEqual(s.state === "current" && s.missing, ["Src/Lib"]);

    // No boundary could be made for a map just written: the one there goes, so
    // the part is left out rather than linked as it was.
    const app = contextDirFor(join(root, "Src/App"));
    assert.equal(writeBoundary(app, null), false);
    assert.equal(existsSync(boundaryPath(app)!), false);
    assert.equal(linksState(root).state, "stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("callers: a walk carries on through the links into the other parts", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-links-callers-"));
  try {
    writeTree(root, MIXED);
    await buildInParts(root);
    const into = federateCallers(root, undefined, "sharedUtil");
    assert.ok(into.found);
    assert.match(into.text, /## Src\/Lib\//);
    assert.match(into.text, /across parts:\n\s+calls ← useIt \(Src\/App\/app\.ts:L\d+-L\d+\)/);
    assert.doesNotMatch(into.text, /not tracked/, "every part is linked");
    assert.doesNotMatch(into.text, /possible callers/, "no text guesses with links");

    const out = federateCallers(root, undefined, "useIt", { direction: "out" });
    assert.match(out.text, /calls → sharedUtil \(Src\/Lib\/lib\.ts:/);
    assert.match(out.text, /calls → local \(app\.ts:/, "its own part's callee, as before");
    assert.doesNotMatch(out.text, /helper/, "a name the other parts make ambiguous is void, as in one map");

    const up = federateCallers(root, undefined, "Base.hello");
    assert.match(up.text, /calls ← draw \(Src\/App\/app\.ts:/, "a member called up a class chain from another part");
    const c = federateCallers(root, undefined, "lib_add");
    assert.match(c.text, /calls ← run \(Src\/App\/main\.c:/);

    const deep = federateCallers(root, undefined, "sharedUtil", { depth: 2 });
    assert.match(deep.text, /calls ← useIt \(Src\/App\/app\.ts:L\d+-L\d+\) \[depth 1\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("callers: parts without links are named, with text matches only for them", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-links-partial-"));
  try {
    writeTree(root, MIXED);
    await buildAllParts(root, PARTS, { buildPart: async (dir) => void (await buildGraph(dir)) });
    const none = federateCallers(root, undefined, "sharedUtil");
    assert.match(none.text, /callers in other parts are not tracked \(graft build --all-parts links the parts\)/);
    assert.match(none.text, /possible callers in other parts \(text match, unverified\):[\s\S]*~ useIt \(Src\/App\/app\.ts:/);
    // A file's importers name its module, not its extension.
    const file = federateCallers(root, undefined, "lib.ts");
    assert.ok(file.found, file.text);
    assert.match(file.text, /possible callers in other parts \(text match, unverified\):\n\s+~ Src\/App\/app\.ts:1 \(module level\)/, file.text);


    // The library gets a boundary, the app does not: links are made, and the app named.
    await buildGraph(join(root, "Src/Lib"), { boundary: true, graphOnly: true });
    linkParts(root);
    const some = federateCallers(root, undefined, "sharedUtil");
    assert.match(some.text, /callers in Src\/App\/ are not tracked: not linked/);
    assert.match(some.text, /~ useIt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("callers: a deeper walk goes out of a part and back, each node once, over MCP too", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-links-deep-"));
  try {
    writeTree(root, {
      "Src/Lib/leaf.ts": "export function leaf() { return 1; }\n",
      "Src/App/mid.ts": "import { leaf } from '../Lib/leaf';\nexport function mid() { return leaf(); }\n",
      "Src/Lib/top.ts": "import { mid } from '../App/mid';\nexport function top() { return mid(); }\nexport function outer() { return top(); }\n",
    });
    await buildInParts(root);
    const r = federateCallers(root, undefined, "leaf", { depth: 3 });
    assert.match(r.text, /across parts:\n\s+calls ← mid \(Src\/App\/mid\.ts:L\d+-L\d+\) \[depth 1\]/);
    // Back in the symbol's own part: listed with that part's own nodes, before
    // the nodes of the other parts.
    assert.match(r.text, /## Src\/Lib\/\n[^\n]+\n\s+calls ← top \(top\.ts:L\d+-L\d+\) \[depth 2\]\n\s+calls ← outer \(top\.ts:L\d+-L\d+\) \[depth 3\]\n\s+across parts:/);
    assert.equal(r.text.match(/← top /g)?.length, 1, "each node once");

    const one = federateCallers(root, undefined, "leaf");
    assert.doesNotMatch(one.text, /top/, "depth 1 stops at the first hop");

    const out = federateCallers(root, undefined, "outer", { direction: "out", depth: Infinity });
    assert.match(out.text, /calls → leaf \(leaf\.ts:/);

    const mcp = await callTool(root, "graft_trace_calls", { symbol: "leaf", depth: "all" });
    assert.equal(mcp.isError, false, mcp.text);
    assert.match(mcp.text, /outer \(top\.ts:L\d+-L\d+\) \[depth 3\]/);
    assert.doesNotMatch(mcp.text, /not tracked/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
