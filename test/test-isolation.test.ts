/**
 * A test file run on its own (`node --import tsx --test test/x.test.ts`) must be
 * as isolated as one run by `npm test`: before test/isolate.ts, such runs filled
 * the developer's real ~/.graft/repos.json with hundreds of deleted temp folders
 * and the real profile store with their maps.
 */
import "./isolate.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ISOLATED_MARK } from "./isolated-env.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..");

test("every test file imports ./isolate.js before anything else", () => {
  const missing: string[] = [];
  for (const f of readdirSync(testDir).filter((f) => f.endsWith(".test.ts"))) {
    const first = readFileSync(join(testDir, f), "utf8").split(/\r?\n/).find((l) => /^import[\s{"'*]/.test(l));
    if (first !== 'import "./isolate.js";') missing.push(f);
  }
  assert.deepEqual(missing, [], `add \`import "./isolate.js";\` as the first import of: ${missing.join(", ")}`);
});

test("run directly, a test gets its own temp folder, registry and no profile store, removed at exit", () => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [ISOLATED_MARK, "GRAFT_REPOS_FILE", "GRAFT_PROFILE_STORE", "GRAFT_REPORTING_HOME"]) delete env[k];
  const script = 'import "./test/isolate.ts"; import { tmpdir } from "node:os"; console.log(JSON.stringify({ tmp: tmpdir(), env: process.env }));';
  const res = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: repoRoot, env, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const { tmp, env: seen } = JSON.parse(res.stdout.trim().split(/\r?\n/).at(-1)!) as { tmp: string; env: Record<string, string> };
  assert.equal(seen[ISOLATED_MARK], "1");
  assert.match(tmp, /trail-test-run-/);
  assert.equal(seen.GRAFT_REPOS_FILE, join(tmp, "graft-test-repos.json"));
  assert.equal(seen.GRAFT_PROFILE_STORE, "0");
  assert.equal(existsSync(tmp), false, "the process's temp folder is removed when it exits");
});

test("already isolated (npm test), importing it again changes nothing", () => {
  const before = process.env.GRAFT_REPOS_FILE;
  const script = 'import "./test/isolate.ts"; console.log(process.env.GRAFT_REPOS_FILE);';
  const res = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: repoRoot, env: process.env, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), before);
});
