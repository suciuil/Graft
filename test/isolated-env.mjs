/**
 * The environment every test runs in, kept apart from the developer's real
 * profile, git config and temp folder.
 *
 * One definition for both ways a test is run:
 *   - `npm test` (scripts/run-tests.mjs) passes it to every batch it spawns;
 *   - a single file run directly (`node --import tsx --test test/x.test.ts`)
 *     gets it from test/isolate.ts, which every test file imports first.
 * Before the second existed, a file run directly wrote its scratch repos into
 * the real ~/.graft/repos.json (`graft savings --all` then listed hundreds of
 * deleted temp folders) and its maps into the real profile store.
 *
 * Plain JS so the runner can import it without tsx.
 */
import { join } from "node:path";

/** Set in the environment once it is isolated, so it is applied only once. */
export const ISOLATED_MARK = "GRAFT_TEST_ISOLATED";

/**
 * @param {string} runTmp the run's own temp folder, removed when the run ends
 * @param {string} repoRoot the graft checkout
 * @returns {Record<string, string>}
 */
export function isolatedTestEnv(runTmp, repoRoot) {
  return {
    // Several tests `git init` a scratch repo and `git commit` into it to exercise the
    // incremental/submodule/ingest git paths. Those commits inherit the developer's
    // global git config — so a contributor who signs commits (gpg, or gitsign, whose
    // x509 flow opens a browser for OIDC on EVERY commit) gets a signing storm from a
    // run that has nothing to do with their identity. Inject config via GIT_CONFIG_*
    // (git merges these over the user's config for this process tree only) so test
    // commits never sign, without touching anyone's global settings.
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "tag.gpgsign", GIT_CONFIG_VALUE_1: "false",
    // Tests make thousands of scratch repos and homes under the temp folder and
    // don't all remove them: a day of runs left over 50,000 folders (6 GB). The
    // run gets its own temp folder, removed at the end whatever the outcome.
    TMPDIR: runTmp,
    TEMP: runTmp,
    TMP: runTmp,
    // A graft repo moves to trail when a session opens on a machine with the trail
    // command, so a contributor who has trail installed would see test repos move.
    // Off for the run; the tests of the move turn it back on.
    GRAFT_NO_TRAIL_SWITCH: "1",
    // A query in a scratch repo with outdated instructions would otherwise
    // rewrite them, and with no stamp replay `init`'s writes outside the repo
    // (~/.codex, ~/.claude) into the developer's real home. Its own tests turn
    // it back on (test/auto-init.test.ts).
    GRAFT_NO_AUTO_INIT: "1",
    // A `graft prices update` on the developer's machine must not price models in
    // tests, so the local price catalog points at a file that never exists.
    GRAFT_PRICES_FILE: join(repoRoot, "test", ".no-such-prices.json"),
    // Likewise the LiteLLM snapshot shipped with graft: regenerating it must not
    // change which models the tests see priced. Its own tests turn it back on.
    GRAFT_BUNDLED_PRICES: "0",
    // A developer who said "yes" to the installer's price list question would
    // otherwise have every test that names an unpriced model download LiteLLM's
    // catalog. Its own tests turn it back on with a fake fetch.
    GRAFT_PRICES_AUTO_UPDATE: "0",
    // Every saving a test files registers its scratch repo in the user's cross-repo
    // list (`graft savings --all`), so the list points at a scratch file inside the
    // run's own temp folder rather than the developer's real ~/.graft/repos.json.
    GRAFT_REPOS_FILE: join(runTmp, "graft-test-repos.json"),
    // The opt-in savings report keeps its switch and queue in a scratch home,
    // so a developer who enabled it never queues (or sends) a test's savings.
    GRAFT_REPORTING_HOME: join(runTmp, "reporting-home"),
    GRAFT_REPORTING_NO_FLUSH: "1",
    // The profile store is on by default, which would put every scratch repo's
    // map and settings in the developer's real ~/.graft/repos (or the folder they
    // moved it to) and break the tests that expect `<repo>/graft/`. Off for the
    // run; its own tests turn it back on.
    GRAFT_PROFILE_STORE: "0",
    // The developer's saved `graft model` / `graft api key` (HKCU\Environment,
    // ~/.graft/env.sh) must not change what a spawned CLI resolves.
    GRAFT_NO_SAVED_SETTINGS: "1",
    // The skills' ready probes get 300 ms for every git spawn together, and the
    // prompt hook 400 ms in all. With many test files running at once, a loaded
    // machine (a Windows runner especially) can't fit that, and the hook answers
    // nothing. Honoured only in a test home, only with the real git and clock
    // (src/skills/probes.ts testScale, testTimeScale), so the time-cap tests
    // still check the real limits.
    TRAIL_TEST_PROBE_SCALE: "5",
    // This fork turns the look-back and fetching OFF unless the variable is "0"
    // (src/util/privacy-switches.ts). The suite tests those features, so it
    // opts in here, as upstream's default did; a test that wants either off
    // still sets "1", and test/privacy-switches.test.ts checks the default.
    TRAIL_NO_LOOK_BACK: "0",
    TRAIL_NO_FETCH: "0",
    [ISOLATED_MARK]: "1",
  };
}
