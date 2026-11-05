# Plan: fix model attribution, savings pricing and ledger loss (post-0.28.0 merge)

## Goal
Graft must record and price savings under the model actually running (Kilo Code over MCP, GitHub Copilot via CLI in the VS Code terminal), including Claude Opus 5.5 / Sonnet 5.5 at every thinking level. It must never wipe `savings.json`. Regression tests run under `npm test`.

## Constraints
- Do not touch the unrelated uncommitted work: `src/cli.ts` (empty-build parts only), `src/ingest/fs.ts`, `scripts/pack-bundle.mjs`, `src/graph/empty-build.ts`, `test/empty-build.test.ts`. Edits to `src/cli.ts` are limited to `fileClaim`.
- No-cloud policy: nothing here sends data anywhere. Do not touch telemetry or cloud gates.
- `npm test` already isolates `GRAFT_REPOS_FILE` and `GRAFT_PROFILE_STORE=0` (scripts/run-tests.mjs L117-L122). The polluted `~/.graft/repos.json` and `~/.graft/repos/graft-*` came from running tests outside `npm test`, so no runner change is needed.

## Decisions
- **Stale Claude stamp (user decision):** honour `latestSession(...).model` and `inputCostMicros` only when both hold:
  - the current caller is Claude Code. For the CLI that means `process.env.CLAUDECODE !== undefined`. For MCP it means `mcpClient()` matches `/claude[- ]?code/i`.
  - the session file is younger than `MAX_SESSION_AGE_MS` (6h, src/hosts/kilo-session.ts L79).

  Otherwise the stamp is ignored, and the flag (`--agent-model` / MCP `model`) and the host record decide.
- Reasoning effort / Kilo `variant` never changes the model id or the price. Tests assert this.

## Tasks (in order)

1. **Stamp gate** (src/claude/session-metrics.ts)
   - Add `liveClaudeSession(dir, {now?, env?, client?})`. It returns `latestSession(dir)` only when the session passes the gate above, else `null`. Use the session file's mtime, or the session's own last-activity field if one exists.
   - Use it in all of these places:
     - `sessionPricing` (L214-L221)
     - `fileClaim` (src/cli.ts L306-L315)
     - `callToolScoped` (src/mcp/tools.ts L296-L368, the `latestSession` use near L335)
     - `recordMcpSavings` (src/mcp/tools.ts L385-L398)
   - Leave alone: `recordSavedTokens(dir, currentModel(dir, s.model), …)` at L157 (Claude hook path, the stamp is current) and display-only `graft stats`.
   - Check with `graft callers latestSession` that no other pricing caller remains.

2. **Ledger must not wipe on read errors** (src/claude/ledger.ts)
   - `readLedger`:
     - `ENOENT` → return an empty ledger (as today).
     - Any other read error (`EUNKNOWN` OneDrive placeholder, `EBUSY`, `EPERM`, `EISDIR`) → throw or return a "do not write" sentinel.
     - JSON parse error → rename the file to `savings.json.corrupt-<ts>`, then start empty.
   - `patchBucket` / all writers: skip the write when the read failed (never throw into a tool call). Print one stderr line, and if the error is a cloud-provider error (`EUNKNOWN` or a message containing "cloud file provider"), add the hint: "OneDrive online-only file and the OneDrive client is not running — start OneDrive or mark graft/ 'Always keep on this device'".
   - Display readers (`graft savings`) keep showing an empty ledger plus the warning.

3. **Kilo WAL freshness** (src/hosts/kilo-session.ts L284-L288)
   - Compute freshness as the max mtime of `kilo.db` and `kilo.db-wal` (ignore a missing `-wal`). Recent sessions in an uncheckpointed WAL are no longer rejected as stale.

4. **VS Code junction matching** (src/hosts/vscode-session.ts `covers`, L201-L211)
   - VS Code stores `d:/work/VED-ChAIR` (a junction), while git/Kilo may resolve `D:/OneDrive - Aumovio SE/_D/work/VED-ChAIR`.
   - Export the realpath-aware `dirKeys` from kilo-session.ts (junction resolution, L155-L170). `covers` should match when any key of the folder covers any key of the repo, keeping the lowercase/separator normalisation.

5. **Tests** (extend existing files and follow their fixtures)
   - `test/mcp-client.test.ts` (uses `builtFixture`, `kiloSessionDb`, `XDG_DATA_HOME`, `readLedger`, `dayKey`):
     - For each of `claude-opus-5-5` and `claude-sonnet-5-5`, at each Kilo variant `low|medium|high|max` (and no variant), with and without the MCP `model` arg:
       - the ledger day bucket is keyed to that model;
       - the reply says `for Claude Opus 5.5` / `Claude Sonnet 5.5`;
       - the recorded dollars equal `savedTokens × 4 / 1e6` (Opus) or `× 2 / 1e6` (Sonnet). Read them via whatever per-model $ the ledger/`graft savings` exposes.
     - Provider-prefixed ids `aumovio-databricks/claude-opus-5-5` and `copilot/claude-opus-5.5` must land in the same canonical bucket.
     - Stale stamp: write a Claude session stamp `claude-opus-4-x` with an mtime 60 days old, then make a Kilo MCP call with `model: claude-opus-5-5`. Assert the call is filed under opus-5-5 at $4/Mtok.
     - Fresh stamp with a non-Claude client: still ignored.
     - Fresh stamp with client `claude-code`: still honoured.
     - Kilo DB in WAL mode: `kilo.db` mtime set 7h old via `utimesSync`, `-wal` fresh. The model is still detected.
   - `test/hosts-vscode-session.test.ts`:
     - Fake `workspaceStorage` whose `chatSessions/*.jsonl` carry `modelId: copilot/claude-opus-5.5` / `resolvedModel: claude-opus-5-5`, with `reasoningEffort` in each of `low|medium|high|xhigh|max`. Same for Sonnet. Assert the model.
     - An in-flight first turn (only `modelId`, no `resolvedModel`) still resolves.
     - Windows-only (skip elsewhere): the workspace folder is a junction to the repo and still matches.
   - CLI end-to-end, in `test/mcp-client.test.ts` or a new `test/savings-pricing.test.ts`: spawn `src/cli.ts callers mathAdd1 <repo>` with `TERM_PROGRAM=vscode`, `APPDATA`/`HOME` pointing to the fake storage, and no `CLAUDECODE`. Assert the tally line names Claude Opus 5.5 and the ledger $ matches.
   - `test/ledger*.test.ts` (or a new `test/ledger-read-errors.test.ts`):
     - Make `savings.json` a directory (`EISDIR`) → recording does not throw and does not replace it.
     - Corrupt JSON → backed up as `.corrupt-*`, then a fresh ledger is written.
     - Per-model $ totals are summed correctly across models and days.

6. **Verify**
   - `npm test` is all green, including the existing Kilo, VS Code and JetBrains tests.
   - `npm run build` (rebuild `dist/`, last built 2026-11-03).
   - `graft build` to refresh the graph.

## Out of scope / noted
- VS Code empty-session `inputState.selectedModel`: an empty session never calls graft, so this is not needed.
- Agents copying `claude-opus-5` from the instruction examples: when the host record says `claude-opus-5-5`, `refinesModelId` already lets the host win (src/context/price.ts L207-L215). No change.
- Recovery of the missing VED-ChAIR `savings.json`: user action (OneDrive recycle bin / version history). The cause is unconfirmed, but task 2 prevents the likely mechanism.

## User actions after implementation
1. Start the OneDrive client. Mark `d:\work\VED-ChAIR\graft` as "Always keep on this device". Restore `graft\.cache\savings.json` from the recycle bin or version history if possible.
2. Restart VS Code, so the Kilo MCP server and terminals load the rebuilt `dist`.
3. Live check in `d:\work\VED-ChAIR`:
   - In a Kilo chat, ask a code question with Opus 5.5 at low and at max effort, then Sonnet 5.5.
   - In a Copilot agent chat, ask the same with Opus 5.5 / Sonnet 5.5 at different reasoning levels.
   - Then run `graft savings` and share the output. Each model should appear with $ = tokens × 4 or 2 per Mtok.
4. Optionally run `graft build --deep` (21% of summaries stale; needs an API key and costs tokens).
