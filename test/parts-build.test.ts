/**
 * "all": a repository too big for one map built as one map per part, with an
 * index at the repository's map so queries from its root search every part.
 */
import "./isolate.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { allPartsPlan, formatTooLarge, GraphTooLargeError, suggestScopes } from "../src/graph/size-guard.js";
import { buildAllParts, partConfig } from "../src/graph/parts-build.js";
import { tooBigToKeep } from "../src/graph/load.js";
import {
  childFor,
  federateAsk,
  federateCallers,
  federateSkeleton,
  isWorkspaceBuildRoot,
  loadWorkspaceGraphs,
  readWorkspace,
} from "../src/graph/workspace.js";

const MB = 1e6;

/** Shaped like IntegrationStream2020: everything under Src/EBS/<component>. */
function ebsFiles(): { rel: string; size: number; chars: number }[] {
  const files: { rel: string; size: number; chars: number }[] = [];
  const add = (dir: string, count: number, bytes: number) => {
    for (let i = 0; i < count; i++) files.push({ rel: `${dir}/f${i}.c`, size: bytes / count, chars: (bytes / count) * 6 });
  };
  add("Src/EBS/ActP/HydAct", 10, 30 * MB);
  add("Src/EBS/ActP/ActSrv", 10, 20 * MB);
  add("Src/EBS/SigP", 10, 40 * MB);
  add("Src/EBS/VehComP/ComAsw", 10, 50 * MB);
  add("Src/EBS/VehComP/ComStack/Can", 10, 60 * MB);
  add("Src/EBS/VehComP/ComStack/Lin", 10, 60 * MB);
  add("Src/EBS/VehComP/ComStack", 1, 1 * MB); // loose in a too-big part
  files.push({ rel: "Flavors/x.xml", size: 1 * MB, chars: 1 * MB });
  files.push({ rel: "readme.txt", size: 1000, chars: 1000 });
  return files;
}

function report(files = ebsFiles()) {
  return {
    estimatedChars: 1300 * MB,
    projected: true,
    budget: 480 * MB,
    filesSeen: 10,
    totalFiles: files.length,
    bytesSeen: 30 * MB,
    totalBytes: files.reduce((s, f) => s + f.size, 0),
    ...suggestScopes(files, 480 * MB),
  };
}

test("all builds the parts that fit, the parts of those too big, and the folders beside the way down", () => {
  const plan = allPartsPlan(report());
  assert.deepEqual(plan.parts, [
    "Flavors",
    "Src/EBS/ActP",
    "Src/EBS/SigP",
    "Src/EBS/VehComP/ComAsw",
    "Src/EBS/VehComP/ComStack/Can",
    "Src/EBS/VehComP/ComStack/Lin",
  ]);
  // readme.txt at the root, and the file directly in ComStack.
  assert.equal(plan.uncovered, 2);
});

test("the list of parts offers all as 0, and --all-parts outside a terminal", () => {
  const r = report();
  const { lines, choices, all } = formatTooLarge(r, "graft build");
  assert.deepEqual(all, allPartsPlan(r).parts);
  assert.ok(lines.some((l) => /^\s+0\s+all\s+6 maps, one per part/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("1 folder(s) outside Src/EBS (Flavors)")));
  assert.ok(lines.some((l) => l.includes("graft build --all-parts")));
  assert.equal(choices[0], "Src/EBS/ActP", "numbered parts still start at 1");
});

test("a part's build settings come from the repository's, paths made relative to the part", () => {
  const cfg = partConfig(
    { includeDirs: ["vendor"], excludeDirs: ["Documents", "Src/EBS/ActP/Gen", "Src/EBS/SigP/x", "*.bak"], followSubmodules: true },
    "Src/EBS/ActP",
  );
  assert.deepEqual(cfg, { includeDirs: ["vendor"], excludeDirs: ["Documents", "Gen", "*.bak"], followSubmodules: true });
  assert.deepEqual(partConfig(null, "a"), {});
});

test("buildAllParts splits a part too big for one map, and indexes the parts built", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-parts-"));
  const ctx = join(root, "ctx");
  try {
    for (const d of ["a", "b/x", "b/y"]) mkdirSync(join(root, d), { recursive: true });
    mkdirSync(join(ctx, ".graph"), { recursive: true });
    writeFileSync(join(ctx, ".graph", "wiring.json"), "{}");
    const tooBigB = new GraphTooLargeError({
      ...report([
        { rel: "x/f.c", size: 10, chars: 10 },
        { rel: "y/f.c", size: 10, chars: 10 },
      ]),
      budget: 5,
    });
    const built: string[] = [];
    const r = await buildAllParts(
      root,
      ["a", "b", "gone"],
      {
        buildPart: async (_dir, name) => {
          if (name === "b") throw tooBigB;
          built.push(name);
        },
      },
      { override: ctx },
    );
    assert.deepEqual(built, ["a", "b/x", "b/y"]);
    assert.deepEqual(r.listed, ["a", "b/x", "b/y"]);
    assert.deepEqual(r.gone, ["gone"]);
    assert.deepEqual(readWorkspace(root, ctx), { version: 1, kind: "parts", children: ["a", "b/x", "b/y"] });
    assert.equal(existsSync(join(ctx, ".graph", "wiring.json")), false, "the repository's own map is replaced by the index");

    // A rebuild keeps a part that fails listed, to retry it, and the others as they were.
    const again = await buildAllParts(
      root,
      ["a", "b/x"],
      { buildPart: async (_dir, name) => { if (name === "a") throw new Error("boom"); } },
      { override: ctx, keep: r.listed },
    );
    assert.deepEqual(again.failed.map((f) => f.part), ["a"]);
    assert.deepEqual(readWorkspace(root, ctx)!.children, ["a", "b/x", "b/y"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildAllParts leaves the repository's map alone when no part could be built", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-parts-"));
  const ctx = join(root, "ctx");
  try {
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(ctx, ".graph"), { recursive: true });
    writeFileSync(join(ctx, ".graph", "wiring.json"), "{}");
    const r = await buildAllParts(root, ["a"], { buildPart: async () => { throw new Error("boom"); } }, { override: ctx });
    assert.equal(r.index, undefined);
    assert.equal(readFileSync(join(ctx, ".graph", "wiring.json"), "utf8"), "{}");
    assert.equal(readWorkspace(root, ctx), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a part that points outside the repository is never built, and an index naming one drops it", async () => {
  const outer = mkdtempSync(join(tmpdir(), "graft-parts-out-"));
  const root = join(outer, "repo");
  const ctx = join(root, "ctx");
  try {
    for (const d of ["repo/a", "victim"]) mkdirSync(join(outer, d), { recursive: true });
    const built: string[] = [];
    const r = await buildAllParts(
      root,
      ["../victim", join(outer, "victim"), "a/../../victim", "a"],
      { buildPart: async (_dir, name) => { built.push(name); } },
      { override: ctx, keep: ["../victim"] },
    );
    assert.deepEqual(built, ["a"]);
    assert.equal(r.failed.length, 3);
    assert.deepEqual(r.listed, ["a"]);

    // A committed index can hold anything: what reaches outside is left out.
    mkdirSync(ctx, { recursive: true });
    writeFileSync(join(ctx, "workspace.json"), JSON.stringify({ version: 2, kind: "parts", children: ["a", "../victim", "/etc", "C:\\x", "b/./c"] }));
    assert.deepEqual(readWorkspace(root, ctx), { version: 1, kind: "parts", children: ["a"] });
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("a parts index is written as version 2, which a graft from before parts indexes ignores", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-parts-v2-"));
  const ctx = join(root, "ctx");
  try {
    mkdirSync(join(root, "a"), { recursive: true });
    await buildAllParts(root, ["a"], { buildPart: async () => {} }, { override: ctx });
    const raw = JSON.parse(readFileSync(join(ctx, "workspace.json"), "utf8")) as { version: number; kind: string };
    assert.equal(raw.version, 2);
    assert.equal(raw.kind, "parts");
    // A version-1 parts index (written before) is still read.
    writeFileSync(join(ctx, "workspace.json"), JSON.stringify({ version: 1, kind: "parts", children: ["a"] }));
    assert.deepEqual(readWorkspace(root, ctx), { version: 1, kind: "parts", children: ["a"] });
    // Version 2 without kind "parts" is no index this graft knows.
    writeFileSync(join(ctx, "workspace.json"), JSON.stringify({ version: 2, children: ["a"] }));
    assert.equal(readWorkspace(root, ctx), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("childFor picks the longest part holding a path", () => {
  const kids = ["Src/EBS/StateP", "Src/EBS/StateP/CoDeg", "Src/EBS/ActP"];
  assert.deepEqual(childFor(kids, "Src/EBS/StateP/CoDeg/a.c"), { child: "Src/EBS/StateP/CoDeg", rest: "a.c" });
  assert.deepEqual(childFor(kids, "Src\\EBS\\ActP\\"), { child: "Src/EBS/ActP", rest: "" });
  assert.equal(childFor(kids, "Src/EBS"), null);
});

test("maps too big to hold together are flagged to be loaded one at a time", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-keep-"));
  try {
    for (const [name, bytes] of [["a", 600], ["b", 500]] as const) {
      mkdirSync(join(d, name, ".graph"), { recursive: true });
      writeFileSync(join(d, name, ".graph", "wiring.json"), "x".repeat(bytes));
    }
    const dirs = [join(d, "a"), join(d, "b"), join(d, "missing")];
    assert.equal(tooBigToKeep(dirs, 1000), true);
    assert.equal(tooBigToKeep(dirs, 1100), false);
    assert.equal(tooBigToKeep([join(d, "a")]), false, "the default limit is far above a small map");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("queries from the repository root search every part's map", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-parts-fed-"));
  try {
    const files: Record<string, string> = {
      "Src/A/a.ts": "export function alphaHandler() { return helperThing(); }\nexport function helperThing() { return 1; }\n",
      "Src/B/b.ts": "export function betaHandler() { return helperThing(); }\nfunction helperThing() { return 2; }\n",
      "Src/B/sub/c.ts": "export function gammaHandler() { return 3; }\n",
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const r = await buildAllParts(root, ["Src/A", "Src/B"], { buildPart: async (dir) => { await buildGraph(dir); } });
    assert.deepEqual(r.listed, ["Src/A", "Src/B"]);
    assert.equal(isWorkspaceBuildRoot(root), false, "parts are folders, not repos to split into");
    assert.equal(loadWorkspaceGraphs(root).unit, "part");

    const all = federateAsk(root, undefined, "handler", { limit: 8 });
    const scopes = new Set(all.hits.map((h) => h.scope!.split("/").slice(0, 2).join("/")));
    assert.ok(scopes.has("Src/A") && scopes.has("Src/B"), [...scopes].join(", "));

    const onlyA = federateAsk(root, undefined, "handler", { limit: 8, in: "Src/A" });
    assert.ok(onlyA.hits.length > 0 && onlyA.hits.every((h) => h.pointer.startsWith("Src/A/")));
    const inSub = federateAsk(root, undefined, "handler", { limit: 8, in: "Src/B/sub" });
    assert.ok(inSub.hits.length > 0 && inSub.hits.every((h) => h.pointer.startsWith("Src/B/sub/")), inSub.hits.map((h) => h.pointer).join(", "));
    assert.ok(federateAsk(root, undefined, "handler", { in: "Src" }).hits.length > 0, "a folder above parts searches those");
    assert.throws(() => federateAsk(root, undefined, "handler", { in: "Nope" }), /no workspace part "Nope"/);

    const callers = federateCallers(root, undefined, "helperThing", { in: "Src/A" });
    assert.equal(callers.found, true);
    assert.match(callers.text, /## Src\/A\//);
    assert.doesNotMatch(callers.text, /## Src\/B\//);

    const sk = federateSkeleton(root, undefined, "Src/B/sub/c.ts");
    assert.equal(sk.file, "Src/B/sub/c.ts");
    assert.deepEqual(sk.entries.map((e) => e.name), ["gammaHandler"]);
    assert.equal(federateSkeleton(root, undefined, "c.ts").file, "Src/B/sub/c.ts", "a unique basename is found in its part");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
