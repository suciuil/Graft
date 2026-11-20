/**
 * `graft parts`: the parts a repository too big for one map was built in, by
 * the paths `--in <part>/` and a prompt name them with, found from the root or
 * from inside a part, without loading any part's graph.
 */
import "./isolate.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { buildAllParts } from "../src/graph/parts-build.js";
import { formatPartsReport, partsReport, partsRootFor, type PartsReport } from "../src/graph/parts-list.js";
import { writeWorkspace } from "../src/graph/workspace.js";
import { runCli, tmpRepo } from "./helpers.js";

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

test("graft parts lists every part by its path from the root, built or not, from the root or inside a part", async () => {
  const root = tmpRepo("parts-list");
  try {
    write(root, {
      "Src/A/a.ts": "export function alpha() { return beta(); }\nexport function beta() { return 1; }\n",
      "Src/A/sub/s.ts": "export function sub() { return 2; }\n",
      "Src/B/b.ts": "export function gamma() { return 3; }\n",
      "Src/C/c.ts": "export function delta() { return 4; }\n",
    });
    await buildAllParts(root, ["Src/A", "Src/B"], { buildPart: async (dir) => { await buildGraph(dir, { boundary: true }); } });

    const built = partsReport(root);
    assert.equal(built.kind, "parts");
    assert.deepEqual(built.parts.map((p) => [p.part, p.state, p.files]), [["Src/A", "built", 2], ["Src/B", "built", 1]]);
    assert.ok(built.parts.every((p) => (p.bytes ?? 0) > 0 && typeof p.builtAt === "string" && p.map));
    assert.equal(built.links, "current");

    // A part whose build failed (still listed, to retry) and one whose folder is gone.
    writeWorkspace(root, { version: 1, kind: "parts", children: ["Src/A", "Src/B", "Src/C", "Src/Gone"] });
    const r = partsReport(root);
    assert.deepEqual(r.parts.map((p) => [p.part, p.state]), [["Src/A", "built"], ["Src/B", "built"], ["Src/C", "not-built"], ["Src/Gone", "gone"]]);
    assert.equal(r.links, "stale", "the links were made for two parts, the index lists four");

    // From inside a part, or a folder inside one: the repository's parts, and the one we are in.
    assert.deepEqual(partsRootFor(root), { root });
    assert.deepEqual(partsRootFor(join(root, "Src", "A")), { root, here: "Src/A" });
    assert.deepEqual(partsRootFor(join(root, "Src", "A", "sub")), { root, here: "Src/A" });
    assert.deepEqual(partsRootFor(join(root, "Src")), { root }, "a folder above the parts is not in one");

    const text = formatPartsReport(partsReport(root, undefined, "Src/A"));
    assert.match(text, /^ {2}PART\s+FILES\s+MAP SIZE\s+BUILT$/m);
    assert.match(text, /^ {2}Src\/A\/ {2}\(you are here\)\s+2\s+\d+(\.\d)? [KMG]B\s+\d{4}-\d\d-\d\d \d\d:\d\d$/m);
    assert.match(text, /^ {2}Src\/C\/.*not built: the next `graft build` here tries it again$/m);
    assert.match(text, /^ {2}Src\/Gone\/.*folder gone/m);
    assert.match(text, /Links between the parts: out of date; the next `graft callers`/);
    assert.match(text, /graft ask "<question>" --in Src\/A\//);
    assert.match(text, /in a prompt to your AI assistant: "In the Src\/A part/);
    assert.match(text, /You are inside the Src\/A\/ part: a query run here searches that part alone/);

    const cli = runCli(["parts", join(root, "Src", "A", "sub")]);
    assert.equal(cli.status, 0, cli.describe());
    assert.match(cli.stdout, /Built in parts, as it is too big for one map: 4 parts, one map each\./);
    assert.match(cli.stdout, /Src\/A\/ {2}\(you are here\)/);
    assert.match(cli.stdout, /Src\/B\//);

    const json = runCli(["parts", root, "--json"]);
    assert.equal(json.status, 0, json.describe());
    const parsed = JSON.parse(json.stdout) as PartsReport;
    assert.equal(parsed.kind, "parts");
    assert.equal(parsed.here, undefined);
    assert.deepEqual(parsed.parts.map((p) => p.part), ["Src/A", "Src/B", "Src/C", "Src/Gone"]);
    assert.ok(parsed.parts.every((p) => typeof p.map === "string" && p.map.length > 0), "each part's map folder");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graft parts on a repository with one map, a folder of repos, or no map", async () => {
  const one = tmpRepo("parts-one");
  const none = tmpRepo("parts-none");
  const repos = tmpRepo("parts-repos");
  try {
    write(one, { "src/a.ts": "export function a() { return 1; }\n" });
    await buildGraph(one);
    const single = partsReport(one);
    assert.equal(single.kind, "single");
    assert.equal(single.files, 1);
    const cli = runCli(["parts", one]);
    assert.equal(cli.status, 0, cli.describe());
    assert.match(cli.stdout, /Not built in parts: one map holds the whole repository \(1 file\), so queries search all of it\./);

    const limited = formatPartsReport({ root: one, kind: "single", parts: [], files: 3, onlyDirs: ["Src/A"] });
    assert.match(limited, /limited to the folders `--only-dir` named:\n {2}Src\/A\/\n/);

    write(repos, { "x/x.ts": "export function x() { return 1; }\n" });
    mkdirSync(join(repos, "y"));
    await buildGraph(join(repos, "x"));
    writeWorkspace(repos, { version: 1, children: ["x", "y"] });
    const ws = partsReport(repos);
    assert.equal(ws.kind, "repos");
    assert.equal(ws.links, undefined, "repos are not linked");
    assert.deepEqual(ws.parts.map((p) => [p.part, p.state]), [["x", "built"], ["y", "not-built"]]);
    assert.match(formatPartsReport(ws), /^ {2}REPO\s+FILES/m);

    const empty = runCli(["parts", none]);
    assert.equal(empty.status, 1, empty.describe());
    assert.equal(empty.stdout, "");
    assert.match(empty.stderr, /No map here yet: run `graft build` first\./);
  } finally {
    for (const d of [one, none, repos]) rmSync(d, { recursive: true, force: true });
  }
});
