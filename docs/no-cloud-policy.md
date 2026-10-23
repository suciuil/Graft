# No cloud uploads: policy for this fork

This fork of Graft (upstream: `https://github.com/NanoNets/Graft`) sends **nothing**
to any cloud. Every AI coding agent working in this repository (Kilo Code, GitHub
Copilot, Claude Code, Cursor, Windsurf, Cline, Roo, Gemini, Codex, Kiro, Aider or
any other) and every human contributor must follow the rules below. They apply to
new code, to changes, and above all to code merged or cherry-picked from upstream.

## What counts as "sending data to a cloud"

Any code path that transmits data from this machine to a remote service, whether or
not the data looks sensitive. For example:

- Trail cloud / Trail workspace: `team.trailhq.com`, `trail login`, `trail init
  --connect` / `--pair`, workspace sync, learnings upload, activity outbox, brains
  over MCP (`src/cloud/`, `src/mcp/brains.ts`).
- Telemetry and analytics: PostHog, usage stats, crash or error reporting
  (`src/telemetry/`).
- Any new upload, sync, share, backup, pairing, "connect your account",
  remote logging, webhook or feedback feature, whatever the service is called.

Not covered: fetching data *in* that the user asked for and that carries nothing
about the user, the machine or the repo beyond the request itself (for example
`graft prices update` downloading the public LiteLLM price list, `npm view` for
the version check, LLM calls for `graft build --deep` to the endpoint the user
configured). If unsure whether something sends data out, treat it as covered and
ask the user.

## Trail features off by default, even without a cloud

Two Trail features reach past this machine without any Trail cloud account. This
fork turns them off unless the person opts in. Both are read only through
`src/util/privacy-switches.ts`; do not read the variables anywhere else.

| Variable | Off when | On only with | What it does when on |
|---|---|---|---|
| `TRAIL_NO_LOOK_BACK` | unset, empty, `1`, anything but `0` | `TRAIL_NO_LOOK_BACK=0` | `trail init` reads past Claude Code sessions and sends what it finds to Claude to be named |
| `TRAIL_NO_FETCH` | unset, empty, `1`, anything but `0` | `TRAIL_NO_FETCH=0` | `git fetch origin`, `gh pr list`, and `trail init`'s read of merged PRs' review comments, which go to Claude |

An upstream change that reads either variable directly, or makes either feature
run by default again, must be routed through those helpers so the default stays
off. `test/privacy-switches.test.ts` fails if a source file reads them directly.

## Rule 1: cloud-sending features are disabled by default

When adding code, or integrating anything from upstream (merge, rebase,
cherry-pick, copy) that sends data to a cloud:

1. It must be **off by default**: with no configuration and no environment
   variable set, nothing is sent and no network connection is opened for it.
2. Follow the existing pattern: the feature's gate returns "off"
   unconditionally, like `cloudEnabled()` / `readCloud()` in
   `src/cloud/workspace.ts` (always `false` / `null`) and `offReason()` in
   `src/telemetry/gate.ts` (always `'unavailable'`). Commands that would send
   refuse with a clear message (see `CLOUD_DISABLED`, `trail login`,
   `graft telemetry enable`).
3. Do not add an environment variable, config key, flag or file that turns it
   back on unless the user explicitly asks for one in this conversation. An
   upstream switch that re-enables sending (for example `TRAIL_CLOUD=1`,
   `TRAIL_URL`, a hand-written `cloud.json`) must stay ignored.
4. Never re-enable a gate that is already off here, even if upstream changed
   it. When an upstream change touches `src/cloud/`, `src/telemetry/`,
   `src/mcp/brains.ts` or any file with `fetch(` / `https.request(` to a remote
   host, keep this fork's "off" behaviour in the merge result and say so in
   your reply.
5. Keep the code compiling and the rest of the product working: disable at the
   gate, do not rip out callers.
6. Record the change in `CHANGELOG.md` under "Change request", as was done for
   Trail cloud and telemetry.

## Rule 2: tests of cloud-sending features are skipped

A test file whose tests need data to be sent to a cloud, or a (fake) cloud server
to answer, can only fail or hang in this fork. Such a file must be skipped by
default:

1. Put this marker line at the top of the file:

   ```ts
   // @cloud-sending-test: needs data sent to a cloud, which this fork disables. Skipped by scripts/run-tests.mjs unless CLOUD_TESTS=1.
   ```

   `scripts/run-tests.mjs` (what `npm test` runs) skips every `test/*.test.ts`
   file containing `@cloud-sending-test`. `CLOUD_TESTS=1 npm test` runs them.
2. Tag new test files from upstream the same way when they test uploading,
   syncing, pairing, connecting, telemetry sending, or call a fake Trail server
   (`test/fake-trail-server.ts`, `fakeTrail(`, `TRAIL_TEST_SERVER`).
3. Do **not** tag tests that check that sending stays **off** (for example
   `test/trail-cloud.test.ts`, `test/telemetry-gate.test.ts`): they guard this
   policy and must keep running.
4. If only some tests in a file need the cloud, move them into their own file
   and tag that one, or wrap them with `{ skip: process.env.CLOUD_TESTS !== "1"
   && "cloud sending is disabled in this fork" }`. Do not tag a whole file
   whose other tests still matter.
5. Do not "fix" such a test by turning the feature back on.

## Checklist when integrating from upstream

- [ ] `git diff` the incoming change for `src/cloud/`, `src/telemetry/`,
      `src/mcp/brains.ts`, `fetch(`, `https.request(`, `trailhq`, `posthog`,
      `upload`, `sync`, `connect`, `pair`, `login`.
- [ ] Every gate for sending still returns "off"; no new switch turns it on.
- [ ] New test files that need a cloud carry `@cloud-sending-test`.
- [ ] `npm test` runs with no cloud test files and no hang.
- [ ] `CHANGELOG.md` notes anything that was disabled.
