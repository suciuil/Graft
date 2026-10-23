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
const files = all.filter((f) => !skipped.includes(f)).map((f) => join(testDir, f));
if (skipped.length) {
  console.error(`(skipping ${skipped.length} test files that need data sent to a cloud, which this fork disables; CLOUD_TESTS=1 runs them: ${skipped.join(", ")})`);
}

if (files.length === 0) {
  console.error(`✗ no test files found in ${testDir}`);
  process.exit(1);
}

// Several tests `git init` a scratch repo and `git commit` into it to exercise the
// incremental/submodule/ingest git paths. Those commits inherit the developer's
// global git config — so a contributor who signs commits (gpg, or gitsign, whose
// x509 flow opens a browser for OIDC on EVERY commit) gets a signing storm from a
// run that has nothing to do with their identity. Inject config via GIT_CONFIG_*
// (git merges these over the user's config for this process tree only) so test
// commits never sign, without touching anyone's global settings.
const gitEnv = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "tag.gpgsign", GIT_CONFIG_VALUE_1: "false",
};

// Tests make thousands of scratch repos and homes under the temp folder and
// don't all remove them: a day of runs left over 50,000 folders (6 GB). Give the
// run its own temp folder and remove it at the end, whatever the outcome.
const runTmp = mkdtempSync(join(tmpdir(), "trail-test-run-"));
const tmpEnv = { TMPDIR: runTmp, TEMP: runTmp, TMP: runTmp };

// A graft repo moves to trail when a session opens on a machine with the trail
// command, so a contributor who has trail installed would see test repos move.
// Off for the run; the tests of the move turn it back on.
// A `graft prices update` on the developer's machine must not price models in
// tests, so the local price catalog points at a file that never exists, and the
// bundled snapshot is off.
// Every saving a test files registers its scratch repo in the user's cross-repo
// list (`graft savings --all`), so the list points at a scratch file inside the
// run's own temp folder rather than the developer's real ~/.graft/repos.json.
const reposFile = join(runTmp, "graft-test-repos.json");
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    ...gitEnv,
    ...tmpEnv,
    GRAFT_NO_TRAIL_SWITCH: "1",
    GRAFT_PRICES_FILE: join(repoRoot, "test", ".no-such-prices.json"),
    // Likewise the LiteLLM snapshot shipped with graft: regenerating it must not
    // change which models the tests see priced. Its own tests turn it back on.
    GRAFT_BUNDLED_PRICES: "0",
    GRAFT_REPOS_FILE: reposFile,
    // The profile store is on by default, which would put every scratch repo's
    // map and settings in the developer's real ~/.graft/repos and break the
    // tests that expect `<repo>/graft/`. Off for the run; its own tests turn it
    // back on.
    GRAFT_PROFILE_STORE: "0",
    // The developer's saved `graft model` / `graft api key` (HKCU\Environment,
    // ~/.graft/env.sh) must not change what a spawned CLI resolves.
    GRAFT_NO_SAVED_SETTINGS: "1",
    // The skills' ready probes get 300 ms for every git spawn together. With
    // many test files running at once, a loaded machine (a Windows runner
    // especially) can't fit that, and the probes answer nothing. Honoured only
    // in a test home and only with the real git (src/skills/probes.ts
    // testScale), so the time-cap test still checks the real limits.
    TRAIL_TEST_PROBE_SCALE: "5",
    // This fork turns the look-back and fetching OFF unless the variable is "0"
    // (src/util/privacy-switches.ts). The suite tests those features, so it
    // opts in here, as upstream's default did; a test that wants either off
    // still sets "1", and test/privacy-switches.test.ts checks the default.
    TRAIL_NO_LOOK_BACK: "0",
    TRAIL_NO_FETCH: "0",
  },
});
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
