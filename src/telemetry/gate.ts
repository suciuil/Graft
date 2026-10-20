/**
 * The single "may we send?" predicate, checked before every append and again
 * before every send.
 *
 * Telemetry is PERMANENTLY OFF in this version of graft: the answer is always
 * "no", whatever key was stamped at publish time, whatever the user's saved
 * setting, and whatever the environment says. There is no switch, flag or
 * environment variable that turns it on — `graft telemetry enable` refuses, and
 * `graft init` never offers it. Every call site still asks this one predicate,
 * so nothing is ever recorded to the local queue or sent.
 *
 * `doNotTrack` and `inCi` are kept for the callers and tests that read them.
 */

/**
 * Why telemetry is off. Only `unavailable` is ever returned now; the others are
 * kept so status output written by an older graft still has a sentence.
 */
export type OffReason = 'unavailable' | 'no-key' | 'do-not-track' | 'ci' | 'disabled' | 'not-enabled';

/** The `DO_NOT_TRACK` convention: set and not `0`/empty means "off". */
export function doNotTrack(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.DO_NOT_TRACK;
  return v !== undefined && v !== '' && v !== '0';
}

/**
 * Every variable {@link inCi} reads, named once.
 *
 * Exported because a test that needs telemetry actually ON has to clear all of
 * them, and clearing a hand-copied subset is how this list silently drifts: the
 * `cursor-session-end` test cleared `CI` alone, so it passed on a laptop and failed
 * on GitHub Actions — where `GITHUB_ACTIONS` is set — for every run until someone
 * read the log. One list, both callers.
 */
export const CI_ENV_VARS = [
  'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI',
  'TEAMCITY_VERSION', 'JENKINS_URL', 'TF_BUILD', 'BUILD_NUMBER',
] as const;

/**
 * CI detection. `CI` covers essentially every provider; the rest are the ones
 * that historically did not set it. Deliberately generous — a false positive
 * costs one uncounted user, a false negative pollutes the dataset.
 *
 * `CI` is the one read with a value test: `CI=false` is a real thing a user sets
 * to mean "not CI", while the provider-specific vars are presence-only — none of
 * them is ever deliberately set to a falsy string.
 */
export function inCi(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CI !== undefined && env.CI !== '' && env.CI !== '0' && env.CI !== 'false') return true;
  return CI_ENV_VARS.some((name) => name !== 'CI' && Boolean(env[name]));
}

/** Always `unavailable`: telemetry is permanently off. The parameters are kept for existing callers. */
export function offReason(_home?: string, _env: NodeJS.ProcessEnv = process.env): OffReason | null {
  return 'unavailable';
}

/** Always false: nothing is ever recorded or sent. */
export function telemetryOn(home?: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return offReason(home, env) === null;
}

/** One line for `graft telemetry status`. */
export function explainOff(reason: OffReason): string {
  switch (reason) {
    case 'unavailable':   return 'off — telemetry is permanently disabled in this version of graft and cannot be turned on; nothing is recorded or sent';
    case 'no-key':        return 'off — this build has no telemetry key (a fork, or a local `npm run build`); nothing can be sent';
    case 'do-not-track':  return 'off — DO_NOT_TRACK is set in this environment';
    case 'ci':            return 'off — this looks like CI';
    case 'disabled':      return 'off — you disabled it';
    case 'not-enabled':   return 'off — off by default';
  }
}

/** Never: no user action can turn telemetry on. */
export function userCanEnable(_reason: OffReason | null): boolean {
  return false;
}
