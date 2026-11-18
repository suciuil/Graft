/**
 * Isolates a test file that was run directly, the way `npm test` isolates the
 * whole suite (see test/isolated-env.mjs for what is set and why).
 *
 * Every test file imports this first (`import "./isolate.js";`), and
 * test/test-isolation.test.ts checks that none forgets. Under `npm test` the
 * runner has already isolated the environment and this does nothing; run
 * directly (`node --import tsx --test test/x.test.ts`), it gives the process its
 * own temp folder, removed at exit, and the same variables, before anything
 * else in the file runs. Without it such a run registered its scratch repos in
 * the developer's real ~/.graft/repos.json and put their maps in the real
 * profile store.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ISOLATED_MARK, isolatedTestEnv } from "./isolated-env.mjs";

if (process.env[ISOLATED_MARK] !== "1") {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const runTmp = mkdtempSync(join(tmpdir(), "trail-test-run-"));
  Object.assign(process.env, isolatedTestEnv(runTmp, repoRoot));
  process.on("exit", () => {
    try {
      rmSync(runTmp, { recursive: true, force: true });
    } catch {
      /* best effort: a locked file on Windows must not fail the run */
    }
  });
}
