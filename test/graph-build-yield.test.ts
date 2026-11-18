/**
 * The parse loop must give the event loop a turn now and then. Native tree-sitter
 * trees (C, C++, C#, XML, ...) are freed by finalizers Node runs from the event
 * loop, so a loop that never yields keeps every tree of the repo alive until it
 * ends: ~43 GB and a silent crash on a ~77k-file C repo. And when init's build
 * does fail, init says why instead of only "failed".
 */
import "./isolate.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph, PARSE_YIELD_EVERY } from "../src/graph/build.js";
import { buildFailureReason } from "../src/claude/build-progress.js";

function repo(files: number): string {
  const d = mkdtempSync(join(tmpdir(), "graft-yield-"));
  for (let i = 0; i < files; i++) writeFileSync(join(d, `m${i}.ts`), `export function f${i}(): number {\n  return ${i};\n}\n`);
  return d;
}

test("buildGraph yields to the event loop during the parse loop", async () => {
  const d = repo(PARSE_YIELD_EVERY * 2 + 1);
  try {
    let fired = false;
    let firedAt = -1;
    let scheduled = false;
    await buildGraph(d, {
      onProgress: ({ phase, index }) => {
        if (phase !== "parse") return;
        if (!scheduled) {
          scheduled = true;
          setImmediate(() => (fired = true));
        }
        if (fired && firedAt < 0) firedAt = index;
      },
    });
    assert.ok(firedAt > 0, "a setImmediate scheduled at the first file ran before the last file was parsed");
    assert.ok(firedAt <= PARSE_YIELD_EVERY, `the first turn comes within ${PARSE_YIELD_EVERY} files (came at ${firedAt})`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("buildFailureReason: a timeout is not a crash, and a crash names its code", () => {
  assert.match(buildFailureReason({ timedOut: true, code: null, signal: "SIGTERM" }), /^stopped after 5 minutes/);
  assert.equal(buildFailureReason({ timedOut: false, code: -1073740791 }), "crashed with exit code 0xC0000409");
  assert.equal(buildFailureReason({ timedOut: false, code: 1 }), "exited with code 1");
  assert.equal(buildFailureReason({ timedOut: false, code: null, signal: "SIGKILL" }), "stopped by SIGKILL");
  assert.equal(buildFailureReason({ timedOut: false, code: null }), "could not start");
});
