/**
 * Runs the test suite without depending on shell glob expansion.
 *
 * `node --test test/*.test.ts` needs the *shell* to expand that glob, and on
 * Windows nothing does: npm runs scripts through `cmd.exe` regardless of the
 * shell that invoked npm, and Node's `--test` only accepts glob patterns itself
 * from Node 21 (this package supports >=20). The literal pattern reaches Node as
 * a filename and it exits with `Could not find '…\test\*.test.ts'` — so the
 * Windows CI leg reported failure while actually running zero tests.
 *
 * Enumerating the files here instead means `npm test` behaves identically in
 * cmd.exe, PowerShell, bash and CI, on any supported Node.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedTestEnv } from "../test/isolated-env.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(repoRoot, "test");

// This fork sends nothing to any cloud: Trail cloud, telemetry and any other
// upload are disabled (see "No cloud uploads" in AGENTS.md). A test file whose
// tests need data to go up, or a server to answer, can only fail here, and some
// wait forever for a connection that never comes, stalling the whole run. Such
// a file is skipped by default, found two ways:
//   - the marker `@cloud-sending-test` in a comment in the file, which is how
//     every new one is tagged (it moves with the file, so a rename keeps it);
//   - the names below, for files that came from upstream before the marker.
// CLOUD_TESTS=1 runs them anyway. A test that checks that sending stays OFF
// (trail-cloud.test.ts, telemetry-gate.test.ts) is not tagged: it must run.
const CLOUD_MARKER = "@cloud-sending-test";
const CLOUD_TESTS = new Set([
  "trail-other-repos.test.ts",
  "trail-pair.test.ts",
  "trail-prompt-activity.test.ts",
  "trail-upload-names.test.ts",
  "trail-upload-parts.test.ts",
  "trail-upload-safety.test.ts",
]);
const withCloud = process.env.CLOUD_TESTS === "1";
const isCloudTest = (f) => {
  if (CLOUD_TESTS.has(f)) return true;
  try {
    return readFileSync(join(testDir, f), "utf8").includes(CLOUD_MARKER);
  } catch {
    return false;
  }
};

// Sorted so a failure is reported in the same order on every platform and run.
const all = readdirSync(testDir).filter((f) => f.endsWith(".test.ts")).sort();
const skipped = withCloud ? [] : all.filter(isCloudTest);
// Relative to `cwd: repoRoot`: absolute paths for ~500 files overflow Windows' 32,767-char command line.
const files = all.filter((f) => !skipped.includes(f)).map((f) => join("test", f));
if (skipped.length) {
  console.error(`(skipping ${skipped.length} test files that need data sent to a cloud, which this fork disables; CLOUD_TESTS=1 runs them: ${skipped.join(", ")})`);
}

if (files.length === 0) {
  console.error(`✗ no test files found in ${testDir}`);
  process.exit(1);
}

// The run gets its own temp folder, removed at the end whatever the outcome, and
// an environment kept apart from the developer's profile and git config
// (test/isolated-env.mjs, shared with test/isolate.ts for files run directly).
const runTmp = mkdtempSync(join(tmpdir(), "trail-test-run-"));
const testEnv = isolatedTestEnv(runTmp, repoRoot);

// Still split into batches when the list outgrows the Windows limit, with room left for the node path.
const MAX_ARGS_CHARS = 24_000;
const batches = [];
for (const f of files) {
  const last = batches.at(-1);
  if (last && last.reduce((n, x) => n + x.length + 1, 0) + f.length < MAX_ARGS_CHARS) last.push(f);
  else batches.push([f]);
}

const run = (batch) => spawnSync(process.execPath, ["--import", "tsx", "--test", ...batch], {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env, ...testEnv },
});
const results = batches.map(run);
const result = results.find((r) => r.error) ?? results.find((r) => r.status !== 0) ?? results[0];
try {
  rmSync(runTmp, { recursive: true, force: true });
} catch {
  /* best effort: a locked file on Windows must not fail the run */
}

if (result.error) {
  console.error(`✗ could not start the test runner: ${result.error.message}`);
  process.exit(1);
}
// A signal-killed run reports null status; treat anything non-zero as failure.
process.exit(result.status ?? 1);
