/**
 * Every child process graft starts says whether Windows may show its window.
 *
 * A graft that has no console of its own (a detached background job such as
 * the branch refresh after `graft ask`, or a hook started by an agent without
 * a console) makes Windows open a new console window for each console program
 * it starts, unless the spawn passes `windowsHide: true`. So every
 * spawn/exec/fork call in src/ has to name `windowsHide`: `true` for git, gh,
 * npm, node and the like, `false` only where the window is the point (opening
 * the browser or a file the person asked for).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CALL = /(^|[^.\w])(spawn|spawnSync|execSync|execFileSync|execFile|exec|fork)\(/g;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(name)) out.push(path);
  }
  return out;
}

/** The text of the call starting at `start`, up to its matching close paren. */
function callText(text: string, start: number, open: number): string {
  let i = open;
  let depth = 1;
  while (i < text.length && depth > 0) {
    const c = text[i++];
    if (c === "(") depth++;
    else if (c === ")") depth--;
  }
  return text.slice(start, i);
}

/** Calls in `text` that never mention windowsHide, as `line: source`. */
function unhiddenCalls(text: string): string[] {
  const lines = text.split("\n");
  const found: string[] = [];
  for (const m of text.matchAll(CALL)) {
    const start = m.index!;
    const line = text.slice(0, start).split("\n").length;
    const src = lines[line - 1]!.trim();
    if (src.startsWith("*") || src.startsWith("//")) continue;
    if (!/windowsHide/.test(callText(text, start, start + m[0].length))) found.push(`${line}: ${src.slice(0, 120)}`);
  }
  return found;
}

test("the scan catches a spawn without windowsHide and accepts one with it", () => {
  assert.deepEqual(unhiddenCalls('execFileSync("git", ["status"], { encoding: "utf8" });'), ['1: execFileSync("git", ["status"], { encoding: "utf8" });']);
  assert.deepEqual(unhiddenCalls('spawnSync("git", args, {\n  cwd,\n  windowsHide: true,\n});'), []);
  assert.deepEqual(unhiddenCalls("child.exec(x); // a method, not child_process"), []);
});

test("every child_process call in src/ names windowsHide", () => {
  const missing: string[] = [];
  for (const file of sources(join(ROOT, "src"))) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("child_process")) continue;
    for (const hit of unhiddenCalls(text)) missing.push(`${relative(ROOT, file)}:${hit}`);
  }
  assert.deepEqual(missing, [], "pass windowsHide: true (or false where a window is wanted) so no console window flashes on Windows");
});

test("only the openers of a browser or file leave the window visible", () => {
  const visible: string[] = [];
  for (const file of sources(join(ROOT, "src"))) {
    if (/windowsHide:\s*false/.test(readFileSync(file, "utf8"))) visible.push(relative(ROOT, file).replace(/\\/g, "/"));
  }
  assert.deepEqual(visible.sort(), ["src/about.ts", "src/cli.ts", "src/util/browser.ts"]);
});
