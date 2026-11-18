/**
 * A repo whose map could never be written (wiring.json is one string, and V8 caps
 * strings at ~536.8M characters) stops early with a list of its parts to build with
 * --only-dir, instead of parsing for half an hour and dying on "Invalid string length".
 */
import "./isolate.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import {
  estimateFileChars,
  formatTooLarge,
  GRAPH_TOO_LARGE_EXIT,
  GraphTooLargeError,
  SizeGuard,
  suggestScopes,
  TOO_LARGE_HEADLINE,
} from "../src/graph/size-guard.js";
import { buildFailureReason, buildMessages } from "../src/claude/build-progress.js";
import { bigHeapMb, hasHeapFlag, heapArgs } from "../src/util/heap.js";
import type { NodeV1 } from "../src/graph/types.js";

const MB = 1e6;

test("estimateFileChars leaves out body_text, which wiring.json never holds", () => {
  const node = { id: "a.c#f", kind: "function", name: "f", path: "a.c", body_text: "x".repeat(1000) } as unknown as NodeV1;
  const bare = { ...node, body_text: "" } as NodeV1;
  assert.equal(estimateFileChars([node], []), estimateFileChars([bare], []));
  assert.equal(estimateFileChars([], []), 0);
});

/** A tree shaped like IntegrationStream2020: everything under Src/EBS/<component>. */
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
  files.push({ rel: "Flavors/x.xml", size: 1 * MB, chars: 1 * MB });
  files.push({ rel: "readme.txt", size: 1000, chars: 1000 });
  return files;
}

test("suggestScopes steps down to Src/EBS and splits a component too big for one map", () => {
  const s = suggestScopes(ebsFiles(), 480 * MB);
  assert.equal(s.parent, "Src/EBS");
  const byPath = new Map(s.parts.map((p) => [p.path, p]));
  assert.deepEqual(
    s.parts.filter((p) => p.depth === 0).map((p) => p.path),
    ["Src/EBS/ActP", "Src/EBS/SigP", "Src/EBS/VehComP"],
  );
  assert.equal(byPath.get("Src/EBS/ActP")!.fits, true, "50 MB of source at 6× is a 300 MB map");
  assert.equal(byPath.get("Src/EBS/VehComP")!.fits, false, "170 MB at 6× is over 480 MB");
  // The too-big component is followed by its own folders, and ComStack (720 MB) by its own.
  assert.equal(byPath.get("Src/EBS/VehComP/ComAsw")!.depth, 1);
  assert.equal(byPath.get("Src/EBS/VehComP/ComStack")!.fits, false);
  assert.equal(byPath.get("Src/EBS/VehComP/ComStack/Can")!.depth, 2);
  assert.equal(byPath.get("Src/EBS/VehComP/ComStack/Can")!.fits, true);
});

test("formatTooLarge numbers each part and suggests --only-dir commands", () => {
  const files = ebsFiles();
  const report = {
    estimatedChars: 1300 * MB,
    projected: true,
    budget: 480 * MB,
    filesSeen: 10,
    totalFiles: files.length,
    bytesSeen: 30 * MB,
    totalBytes: files.reduce((s, f) => s + f.size, 0),
    ...suggestScopes(files, 480 * MB),
  };
  const { lines, choices } = formatTooLarge(report, "graft build");
  const text = lines.join("\n");
  assert.ok(lines[0]!.startsWith(TOO_LARGE_HEADLINE));
  assert.match(text, /Parts of Src\/EBS/);
  assert.match(text, /For example: graft build --only-dir Src\/EBS\/ActP/);
  assert.match(text, /graft config exclude-dirs add <path>/);
  assert.equal(choices[0], "Src/EBS/ActP");
  const k = choices.indexOf("Src/EBS/VehComP/ComAsw") + 1;
  assert.ok(lines.some((l) => new RegExp(`^\\s+${k}\\s+Src/EBS/VehComP/ComAsw`).test(l)), "line numbers match choices");
});

test("parts not parsed yet are sized by their extension's ratio and marked as guesses", () => {
  // Parsed: 10 MB of .c (2 chars a byte) and 10 MB of .arxml (0.1 a byte). Not parsed: b/ and c/.
  const files = [
    ...Array.from({ length: 10 }, (_, i) => ({ rel: `a/f${i}.c`, size: 1 * MB })),
    ...Array.from({ length: 10 }, (_, i) => ({ rel: `a/g${i}.arxml`, size: 1 * MB })),
    ...Array.from({ length: 10 }, (_, i) => ({ rel: `b/f${i}.c`, size: 1 * MB })),
    ...Array.from({ length: 10 }, (_, i) => ({ rel: `c/g${i}.arxml`, size: 1 * MB })),
  ];
  const guard = new SizeGuard(files, 1e12);
  const big = (chars: number) => [{ id: "x", kind: "file", name: "", path: "x", body_text: "", pad: "y".repeat(chars - 60) }] as unknown as NodeV1[];
  for (let i = 0; i < 20; i++) guard.add(i, big(i < 10 ? 2 * MB : 0.1 * MB), []);
  const r = guard.tooLarge(true).report;
  const part = (p: string) => r.parts.find((x) => x.path === p)!;
  assert.ok(Math.abs(part("b").chars - 20 * MB) < 0.1 * MB, `b/ (.c) is sized at the .c ratio: ${part("b").chars}`);
  assert.ok(Math.abs(part("c").chars - 1 * MB) < 0.1 * MB, `c/ (.arxml) at the .arxml ratio: ${part("c").chars}`);
  assert.equal(part("a").measured, 1);
  assert.equal(part("b").measured, 0);
  const { lines } = formatTooLarge(r, "graft build");
  assert.ok(lines.some((l) => /\ba\s.*\bfits$/.test(l)), "a measured part just fits");
  assert.ok(lines.some((l) => /\bb\s.*likely fits$/.test(l)), "a guessed part likely fits");
  assert.ok(lines.some((l) => l.includes('"likely": a guess')));
});

test("SizeGuard stops once the map is over budget, and early on a clear overshoot", () => {
  const files = Array.from({ length: 100 }, (_, i) => ({ rel: `d${i % 4}/f${i}.ts`, size: 1000 }));
  const node = (i: number) => ({ id: `f${i}`, kind: "function", name: "x".repeat(400), path: `f${i}` }) as unknown as NodeV1;
  // ~450 chars a file: 45k for the whole set.
  const roomy = new SizeGuard(files, 100_000);
  for (let i = 0; i < files.length; i++) roomy.add(i, [node(i)], []);
  const tight = new SizeGuard(files, 20_000);
  let stoppedAt = -1;
  try {
    for (let i = 0; i < files.length; i++) {
      stoppedAt = i;
      tight.add(i, [node(i)], []);
    }
  } catch (err) {
    assert.ok(err instanceof GraphTooLargeError);
    assert.equal(err.report.projected, true);
    assert.ok(err.report.estimatedChars > 40_000);
  }
  assert.equal(stoppedAt, 9, "stops at 10% of the source: 45k projected is over 1.5 × 20k");
});

test("buildGraph stops with GraphTooLargeError instead of writing a map over the limit", async () => {
  const d = mkdtempSync(join(tmpdir(), "graft-size-"));
  try {
    for (const dir of ["src/a", "src/b"]) {
      mkdirSync(join(d, dir), { recursive: true });
      for (let i = 0; i < 20; i++) writeFileSync(join(d, dir, `m${i}.ts`), `export function f${i}(): number {\n  return ${i};\n}\n`);
    }
    await assert.rejects(
      buildGraph(d, { contextDir: join(d, "graft"), maxGraphChars: 2000 }),
      (err: unknown) => err instanceof GraphTooLargeError && err.report.parent === "src" && err.report.parts.length === 2,
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("init passes the whole too-big report on, list of parts included", () => {
  const stderr = `parsing 3/9: x\r\n${TOO_LARGE_HEADLINE}: its map would be about 900 MB\n\n  Parts of Src/EBS:\n     1  Src/EBS/ActP  fits\n`;
  const messages = buildMessages("", stderr, GRAPH_TOO_LARGE_EXIT);
  assert.equal(messages[0]!.startsWith(TOO_LARGE_HEADLINE), true);
  assert.deepEqual(messages.slice(1), ["  Parts of Src/EBS:", "     1  Src/EBS/ActP  fits"]);
  // Any other failure keeps only warning and error lines.
  assert.deepEqual(buildMessages("", "  Parts of x\n⚠ odd\n", 1), ["⚠ odd"]);
  assert.equal(buildFailureReason({ timedOut: false, code: GRAPH_TOO_LARGE_EXIT }), "stopped: the repository is too big for one map");
});

test("heapArgs asks for half the RAM (at most 16 GB) unless a limit was chosen", () => {
  const gb = 2 ** 30;
  assert.equal(bigHeapMb(32 * gb), 16_384);
  assert.equal(bigHeapMb(8 * gb), 4096);
  assert.deepEqual(heapArgs([], "", 4192, 32 * gb), ["--max-old-space-size=16384"]);
  assert.deepEqual(heapArgs(["--max-old-space-size=2048"], "", 2048, 32 * gb), []);
  assert.deepEqual(heapArgs([], "--max-old-space-size=8000", 8000, 32 * gb), []);
  assert.deepEqual(heapArgs([], "", 4192, 8 * gb), [], "no gain on an 8 GB machine");
  assert.equal(hasHeapFlag(["--inspect"], ""), false);
});
