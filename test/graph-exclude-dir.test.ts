/**
 * `graft build --exclude-dir` drops named directories from the walk. Persisted
 * in the build config, it must take effect for the wiring graph the same way
 * `--include-dir` does — verified here by building a repo with an excluded folder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { writeBuildConfig } from "../src/util/state.js";

test("--exclude-dir: a persisted excludeDirs entry drops that folder from the graph", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-excl-"));
  try {
    mkdirSync(join(dir, "keep"), { recursive: true });
    mkdirSync(join(dir, "skip"), { recursive: true });
    writeFileSync(join(dir, "keep", "a.ts"), "export function kept() {}\n");
    writeFileSync(join(dir, "skip", "b.ts"), "export function dropped() {}\n");

    writeBuildConfig(dir, { excludeDirs: ["skip"] });
    await buildGraph(dir);

    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const paths = graph.nodes.map((n) => n.path);
    assert.ok(paths.some((p) => p.includes("keep/a.ts")), "keep/ should be indexed");
    assert.ok(!paths.some((p) => p.includes("skip/")), "skip/ should be excluded from the graph");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--exclude-dir takes precedence over --include-dir for the same name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-excl2-"));
  try {
    // `build` is normally a SKIP_DIRS name; include re-admits it, exclude wins.
    mkdirSync(join(dir, "build"), { recursive: true });
    writeFileSync(join(dir, "build", "gen.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "main.ts"), "export const y = 2;\n");

    writeBuildConfig(dir, { includeDirs: ["build"], excludeDirs: ["build"] });
    await buildGraph(dir);

    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const paths = graph.nodes.map((n) => n.path);
    assert.ok(paths.some((p) => p.includes("main.ts")), "main.ts should be indexed");
    assert.ok(!paths.some((p) => p.includes("build/")), "excluded build/ wins over include");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
