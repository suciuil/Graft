/**
 * The two Trail features that reach past this machine without a cloud account,
 * and which this fork keeps OFF unless the person turns them on (see
 * docs/no-cloud-policy.md):
 *
 *  - the look-back at `trail init`: reads past Claude Code sessions here and
 *    sends what it finds (and, with fetching on, merged PRs' review comments
 *    and the code they were left on) to Claude to be named;
 *  - fetching: `git fetch origin`, `gh pr list` and the PR-review read, which
 *    keep Trail's view of teammates' branches current.
 *
 * Each has one variable. Unset or empty means off, as if `TRAIL_NO_LOOK_BACK=1`
 * / `TRAIL_NO_FETCH=1` were set: the fork's default. `0` turns the feature on.
 * Any other value keeps it off. Every caller reads the same answer for the same
 * environment, which the scattered `=== "1"` and truthiness checks before this
 * did not (`TRAIL_NO_FETCH=0` used to stop some fetches and not others).
 *
 * Imports nothing: the session-start hook loads this through notes/branches.ts.
 */

/** Whether the look-back at `trail init` is off: unless `TRAIL_NO_LOOK_BACK=0`. */
export function lookBackDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TRAIL_NO_LOOK_BACK !== '0';
}

/** Whether fetching (`git fetch origin`, `gh pr list`, the PR-review read) is off: unless `TRAIL_NO_FETCH=0`. */
export function fetchDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TRAIL_NO_FETCH !== '0';
}
