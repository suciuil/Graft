#!/usr/bin/env node
/**
 * The `trail` CLI, also run as `graft`, its old name. Commands: build, ask,
 * check, viz, mcp, callers, skeleton, grep, map, init. Git is the sync: commit
 * graft/ and a clone has the graph. A workspace parent (≥2 git children)
 * federates query commands across children.
 *
 * Both names run this file. Under `graft` every command keeps its old name and
 * meaning; under `trail` the layout changes (see `TRAIL` below and brand.ts).
 */
import { spawnSync } from "node:child_process";
import "dotenv/config";
import { Command } from "commander";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Graft } from "./engine.js";
import { resolveConfig, type EngineConfig } from "./ai/providers.js";
import { printLlmFailureHints } from "./ai/llm-hints.js";
import { runSettingCommand, terminalPrompter, userEnvStore, type SettingDeps, type SettingOptions } from "./ai/llm-settings.js";
import { chooseDatabricksDeepModel } from "./ai/databricks-setup.js";
import type { ProviderKind } from "./ai/llm/factory.js";
import { formatCheckReport } from "./context/check.js";
import { formatGraphCheckReport } from "./graph/check.js";
import { buildGraphIfMissing, runInit } from "./claude/init.js";
import { statuslineWanted } from "./claude/settings-merge.js";
import { runHostsInit } from "./hosts/init.js";
import { kiloRuleRel } from "./hosts/kilo.js";
import { formatModelPrices, readHostModels } from "./hosts/models.js";
import { listRate } from "./context/price.js";
import {
  catalogPrice,
  priceCatalogPath,
  priceCatalogStatus,
  updatePriceCatalog,
} from "./context/price-catalog.js";
import { hostModelFor } from "./hosts/host-model.js";
import { hostIds, hostWiringName } from "./hosts/registry.js";
import { checkoutRoot, ensureRepoHome, keepsNotes, noteCount, rememberRepo, repoName, repoPlace, shownPath } from "./notes/home.js";
import { brand, cmd, graftNotice, strandedRepoNotice, tag } from "./brand.js";
import { branchDiff } from "./cloud/diff.js";
import { openBrowser } from "./util/browser.js";
import { learningsAtBase, teammateEdits, withBaseLearnings } from "./check/learning-edits.js";
import { contextDirFor } from "./context/node-file.js";
import { loadGraphCached } from "./graph/load.js";
import { deepDueFor, ensureFreshChildren, ensureFreshGraph, formatStalenessReport, refreshNote, stalenessReport, summaryStaleness } from "./graph/refresh.js";
import { isWorkspaceBuildRoot, readWorkspace } from "./graph/workspace.js";
import { hasGraftIndex, nearestGraftRoot } from "./graph/root.js";
import { unsupportedExtensions, supportedExtensions } from "./graph/source-files.js";
import { normalizeExcludeEntry } from "./ingest/fs.js";
import {
  CONFIG_APPLY_NOTE,
  addDirEntries,
  clearDirEntries,
  describeExcludeEntry,
  dirProblem,
  excludeDirProblem,
  formatConfigList,
  includeDirProblem,
  includeEntryNote,
  parseOnOff,
  readDirList,
  readFlag,
  removeDirEntries,
  writeFlag,
  type DirListKey,
  type FlagKey,
} from "./config-cli.js";
import { discoverWorkspaceChildren } from "./graph/scopes.js";
import {
  runWorkspaceAsk,
  runWorkspaceBuild,
  runWorkspaceCallers,
  runWorkspaceCheck,
  runWorkspaceGrep,
  runWorkspaceMap,
} from "./graph/workspace-cli.js";
import { formatInitEpilogue } from "./cli-epilogue.js";
import { planInit, selectedWrites } from "./hosts/plan.js";
import { planRetract, runRetract, changed, type Retraction } from "./hosts/retract.js";
import { compactWrites, formatNonInteractiveHelp, formatPlan, pickLearnings, runPicker } from "./cli-picker.js";
import { describeCodeWorkspaces, findCodeWorkspaces, promptCodeWorkspace, readCodeWorkspaceFolders } from "./hosts/code-workspace.js";
import { buildGraphWithProgress } from "./claude/build-progress.js";
import { homedir } from "node:os";
import { formatUpgradeReport, formatVersionReport, getNpmViewVersion, readCurrentVersion, readPackageName, runUpgrade } from "./cli-meta.js";
import { nativeFallbackNotice } from "./graph/native.js";
import {
  DEFAULT_DEEP_STALE_THRESHOLD,
  ensureDefaultBuildConfig,
  globalSettingsPath,
  isValidDeepStaleThreshold,
  missingBuildConfigPath,
  patchBuildConfig,
  patchGlobalSettings,
  readBuildConfig,
  readGlobalSettings,
  resolveDeepStaleThreshold,
  type BuildConfig,
} from "./util/state.js";
import { normalizePathPrefix } from "./util/paths.js";
import { latestSession, formatSessionStats, sessionInputRate, sessionPricing } from "./claude/session-metrics.js";
import { readRepoRegistry, registerDiscovered, repoRegistryPath } from "./claude/repo-registry.js";
import { knownFolders } from "./hosts/known-folders.js";
import { aggregateAllSavings, aggregateSavings, currentModel, formatAllSavingsReport, formatSavingsReport, isPeriod, readLedger, recordSavedTokens, registerExistingLedger, setAgentModel, setHostModel } from "./claude/ledger.js";
import { listSessionIds, readSession, sessionDir } from "./claude/state.js";
import { costLabel, listNotes, noteName, notePlace, noteTargets, readingTokens, savedByNote, commitLines, PERSONAL_SAVED_LINE, PR_SPEEDUP, SECTIONS, tokensWorthSaying, sectionLead, shortDate, tokensLabel, writeNote, type Note, mentionedFiles } from "./notes/notes.js";
import { aboutTerms, currentSessionCost } from "./notes/session-cost.js";
import { beginPastRead, finishPastRead, type Finding } from "./notes/cold-start.js";
import { beginReviewRead, finishReviewRead, type ReviewFinding } from "./notes/pr-reviews.js";
import { currentBranch, noteAuthor, teammatesOn } from "./notes/git-facts.js";
import { confirm, fold, getSkill, learn, listSkills, publish, skillForAgent, skillName, skillStatus, type LearnResult } from "./skills/skills.js";
import { clearPending, cloudLines, loginLink, sessionKey, waitForConnect } from "./cloud/nudge.js";
import { addRepo, clearCloud, CLOUD_DISABLED, cloudEnabled, fetchMe, fetchTeam, isError, readCloud, writeCloud, type Cloud } from "./cloud/workspace.js";
import { inWorkspace, maybeSyncInBackground, recordActivity, runSyncChild, syncRepo } from "./cloud/workspace-sync.js";
import type { CheckResult } from "./check/types.js";
import { checkLocally } from "./check/local-check.js";
import { formatOverlap, maybeRefreshBranches, overlapsWith, pushedWhen, readBranchCache, refreshBranches } from "./notes/branches.js";
import { ensureRepoTrail, LEARNINGS_DIR } from "./notes/repo-trail.js";
import type { AskResult } from "./ask/ask.js";
import { claimedSavings, setDeepDue, setInitDue, setModelTable, setPricing, setRepoRoot } from "./context/savings.js";
import { initDueReason } from "./hosts/drift.js";
import { formatUpdateNudge, maybeRefreshInBackground, readStamp, readUpdateCache, refreshUpdateCache, wiredHostIds, wiringOpts, writeStamp } from "./upkeep.js";
import { shouldMoveToTrail } from "./upkeep-run.js";
import {
  countBucket,
  savedTokensBucket,
  errorCode,
  filesBucket,
  durationBucket,
  formatDebug,
  formatStatus,
  firstRunNotice,
  isTrackedCommand,
  langsValue,
  offReason,
  userCanEnable,
  maybeFlushInBackground,
  patchState,
  runFlush,
  track,
  trackFirstRunIfNew,
} from "./telemetry/index.js";
import { installSystemCaFetch } from "./util/system-ca.js";
import { helpExamples, missingCommandHint } from "./cli-help.js";
import { installGraftHelp } from "./cli-help-graft.js";

// Before any command builds an LLM client: they capture globalThis.fetch when created.
installSystemCaFetch();

const program = new Command();
const currentVersion = readCurrentVersion(import.meta.url);

/**
 * Started as `trail` rather than `graft`. Decided once, before any command is
 * registered, because it changes which commands exist: under trail the old
 * `graft trail …` group moves to the top level, `check` hands its name to the
 * team check (the freshness check is `build --check`), and `stats` and
 * `trail status` become one `status`. Under graft nothing moves.
 */
const TRAIL = brand() === "trail";

/** Help-screen groups under trail; graft keeps its one flat list. */
const GROUP = {
  find: "Find code · your agent runs these:",
  memory: "Team memory:",
  setup: "Setup:",
  cloud: "Workspace · your team's view, across repos:",
  ci: "CI:",
} as const;

/** Put a command in a help group, under trail only. */
function grouped(c: Command, heading: string): Command {
  if (TRAIL) c.helpGroup(heading);
  return c;
}

/**
 * What the `query` telemetry event will say, filled in by the command as it runs
 * and emitted once from the `postAction` hook below.
 *
 * A module-level slot rather than a threaded parameter because the repo root is
 * resolved deep inside each action (`queryRoot`) while the event is emitted
 * centrally — and because a command that calls `process.exit` should simply
 * report nothing, which falls out of never emitting until postAction.
 */
let queryNote: { repo?: string; hit?: "yes" | "no"; command?: string; notes?: string } = {};

/** Record the repo a query ran against, and pass it straight through so call
 *  sites stay one line. */
function noteQuery(dir: string): string {
  queryNote.repo = dir;
  // The backstop for a terminal-driven agent that passed no `--agent-model`,
  // which in practice is most of them. GitHub Copilot is the case that needs it:
  // graft registers no MCP server for it, so it drives the CLI from a VS Code
  // terminal, and with no hook surface either there was nothing left to name the
  // model — every Copilot session reported tokens and no dollars. VS Code writes
  // the running model into its own chat session files; `hostModelFor` reads it
  // and owns the per-host gating. Set BEFORE `sessionPricing`, which resolves
  // the model through the call scope this writes to.
  //
  // Ranked below `--agent-model` (see `resolveModel`), so an agent that names
  // itself is unaffected — with one exception, which is why this is read even
  // when the flag WAS passed: an agent behind a router ("Auto") reports the
  // family it belongs to rather than the model, and the host's record is the
  // same claim one decimal place better. See `refinesModelId`.
  setHostModel(hostModelFor(dir));
  // Every retrieval command funnels through here, which makes it the one place
  // that can price this session's tokens before a formatter needs the number.
  setPricing(sessionPricing(dir));
  setRepoRoot(dir);
  // Deliberately NO per-model table here. That table is only correct for a host
  // whose model list graft can read, which today means Kilo — and Kilo reaches
  // graft over MCP, never through this CLI. Wiring it unconditionally meant any
  // terminal-driven agent on a machine that merely HAS Kilo installed was shown
  // Kilo's price list. Every caller on this path can pass `--agent-model` and
  // get one exact figure instead, which is the better answer anyway.
  setModelTable(null);
  return dir;
}

/** Whether a query found anything. Only the commands that have a result count in
 *  hand call this; the property is simply absent for the others. */
function noteHit(found: boolean): void {
  queryNote.hit = found ? "yes" : "no";
}

const GLOBAL_OPTIONS_HEADING = "Global options (before or after the command):";

program
  .name(brand())
  .usage("[global options] <command> [command options]")
  .description(
    TRAIL
      ? "Memory for your coding agents: a code map, and the learnings each session\n" +
          "leaves in your repo's .trail/, so your whole team's Claude starts from them."
      : "Build a repo's context graph as linked markdown, and keep it in sync with the code.",
  )
  .optionsGroup(GLOBAL_OPTIONS_HEADING)
  .version(currentVersion, "-v, --version")
  .option("--dir <path>", "context graph directory (default: <repo>/graft)")
  .option(
    "--agent-model <id>",
    "model YOU are running, to price saved tokens — not --model",
  )
  .optionsGroup("LLM options (used by `build --deep`; or set the env vars once):")
  .option("--provider <name>", "LLM wire format: openai | anthropic | litellm | orcarouter | llm-incubator (env GRAFT_PROVIDER)")
  .option("--model <id>", "model id for the LLM pass (env GRAFT_MODEL)")
  .option("--api-key <key>", "provider API key (env GRAFT_API_KEY, then ANTHROPIC_AUTH_TOKEN)")
  .option("--base-url <url>", "LLM endpoint URL (env GRAFT_BASE_URL, then ANTHROPIC_BASE_URL; default: the Databricks AI Gateway)")
  // graft's own help (installGraftHelp, below) carries examples on every command.
  .addHelpText("after", TRAIL ? helpExamples(brand(), false) : "");
// -v/--version still works; it is just not listed among the global options.
program.options.find((o) => o.long === "--version")?.hideHelp();

interface GlobalOpts {
  dir?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  agentModel?: string;
}

/** Key and model picked for this run by an interactive step (the Databricks model choice of `build --deep`). */
let llmOverride: Pick<EngineConfig, "apiKey" | "model"> = {};

/** Config drawn from the global CLI flags (env + defaults fill the rest). */
function cliConfig(): EngineConfig {
  const o = program.opts<GlobalOpts>();
  return {
    contextDir: o.dir,
    provider: o.provider as ProviderKind | undefined,
    model: llmOverride.model ?? o.model,
    apiKey: llmOverride.apiKey ?? o.apiKey,
    baseUrl: o.baseUrl,
  };
}

const engineFrom = (): Graft => new Graft(cliConfig());

/**
 * Warn (never fail) when a user's `-e` extension has no parser, so it is never a silent
 * no-op — `graft build -e ".vue"` used to accept it, index nothing, and exit 0. The
 * supported set is listed so `-e` also answers "what is actually supported".
 */
function warnUnsupportedExtensions(exts?: string[]): void {
  if (!exts?.length) return;
  const bad = unsupportedExtensions(exts);
  if (bad.length === 0) return;
  for (const e of bad) {
    const shown = e.trim().startsWith(".") ? e.trim() : `.${e.trim()}`;
    console.error(`⚠ -e "${shown}": no parser registered for this extension — ignoring it.`);
  }
  console.error(`  supported: ${supportedExtensions().join(" ")}`);
}

/** Text for the omitted-`[dir]` case, shared by every query command's help. */
const DIR_ARG = ["[dir]", "repository root (default: nearest ancestor with a graft/ index)"] as const;

/**
 * The root a query runs against: the dir the user named, else the nearest
 * ancestor holding a graft index (`graph/root.ts`) so a shell or agent session
 * in a subdirectory still finds the graph. The walk is announced on stderr —
 * answering from an ancestor's graph must never be silent.
 */
function queryRoot(dir?: string): string {
  if (dir !== undefined) return resolve(dir);
  const { root, levels } = nearestGraftRoot(process.cwd(), program.opts<GlobalOpts>().dir);
  if (levels > 0) console.error(`${tag()} no code map here — answering from ${contextDirFor(root, program.opts<GlobalOpts>().dir)}`);
  return root;
}

/**
 * Bring the graph up to date with the working tree before a query answers from it
 * — the same gate the MCP tools run (see `graph/refresh.ts`). Cheap when nothing
 * moved; a structural, $0 rebuild when it did. The note goes to stderr so `--json`
 * stdout stays machine-readable.
 */
async function refreshBefore(dir: string, opts: { refresh?: boolean }): Promise<void> {
  const globalDir = program.opts<GlobalOpts>().dir;
  const root = resolve(dir);
  const disabled = opts.refresh === false;
  const ws = readWorkspace(root, globalDir);
  const r = ws
    ? await ensureFreshChildren(root, ws.children, { contextDir: globalDir, disabled })
    : await ensureFreshGraph(root, { contextDir: globalDir, disabled });
  const note = refreshNote(r);
  if (note) console.error(note);
  const deep = deepDueFor(root, { contextDir: globalDir, children: ws?.children });
  if (deep) console.error(deep.note);
  setDeepDue(deep?.reason ?? null);
  setInitDue(initDueReason(root, { children: ws?.children }));
}

/** Attached to every query command: `--no-refresh` answers from the graph exactly
 * as it is on disk, no rebuild. */
const NO_REFRESH_FLAG = ["--no-refresh", "skip the freshness check — answer from the graph as-is"] as const;

const VIZ_TABS = ["context", "code", "outline"] as const;
type VizTab = (typeof VIZ_TABS)[number];

/**
 * `--tabs context,code` → the tabs to write into an exported page.
 *
 * An unknown name is a caller mistake worth failing on rather than silently
 * dropping: a page exported with a typo'd tab list would be missing a tab and
 * nothing would say why. Undefined means "all of them", which is the default the
 * exporter already applies.
 */
function parseTabs(raw: string | undefined): VizTab[] | undefined {
  if (raw === undefined) return undefined;
  const want = raw.split(",").map((t) => t.trim()).filter(Boolean);
  const bad = want.filter((t) => !VIZ_TABS.includes(t as VizTab));
  if (bad.length > 0 || want.length === 0) {
    console.error(`✗ --tabs takes a comma-separated subset of ${VIZ_TABS.join(", ")}${bad.length ? ` — got "${bad.join('", "')}"` : ""}`);
    process.exit(1);
  }
  return want as VizTab[];
}

/**
 * Commands that own the upgrade story themselves (`version`, `upgrade`) or must
 * not editorialize on stderr at startup (`mcp` runs its own upkeep at boot, and
 * `_update-check` IS the fetch).
 */
const UPKEEP_SKIP = new Set(["version", "upgrade", "_update-check", "_trail-past-read", "mcp", "/h", "/help"]);

/**
 * Every other command: top up the cached registry answer in the background and,
 * if a newer graft is out, say so once on stderr. This is what makes the CLI the
 * cache filler for the hooks, which are not allowed to touch the network.
 */
program.hook("preAction", (_parent, action) => {
  // Ahead of the skip check: `mcp` is skipped here but is exactly the command
  // that needs this. Its process is long-lived, so one `--agent-model` in the
  // host's .mcp.json args prices every tool call the server goes on to serve.
  setAgentModel(program.opts<GlobalOpts>().agentModel);
  if (UPKEEP_SKIP.has(action.name())) return;
  // Someone typing graft by hand learns its new name, once a day. Agents,
  // hooks, CI and pipes never see it (see graftNotice).
  const renamed = graftNotice({ ran: spelling(action), tty: Boolean(process.stderr.isTTY) });
  if (renamed) console.error(renamed);
  // Someone typing trail in a repo whose graft-era hooks can't reach it learns
  // the one command that moves it (init itself is that command).
  const stranded = action.name() === "init" ? null : strandedRepoNotice({ cwd: process.cwd(), tty: Boolean(process.stderr.isTTY) });
  if (stranded) console.error(stranded);
  maybeRefreshInBackground();
  const nudge = formatUpdateNudge(currentVersion, readUpdateCache()?.latest);
  if (nudge) console.error(nudge);
  // Telemetry, in the order a user should experience it: disclose first, then
  // record, then (at most once a day, detached) send. Every step is a no-op in a
  // fork, in CI, under DO_NOT_TRACK, or after `graft telemetry disable`.
  const notice = firstRunNotice();
  if (notice) console.error(notice);
  trackFirstRunIfNew();
  maybeFlushInBackground();
});

/**
 * The `query` event, emitted after the command rather than before it, so it can
 * carry what the query actually did. A command that exits early via
 * `process.exit` never reaches here and is simply not counted — under-reporting
 * is the right failure mode for a metric.
 */
program.hook("postAction", (_parent, action) => {
  // The ledger's third writer, alongside the Claude hooks and the MCP server.
  // Without it a host that drives graft from a TERMINAL — Copilot, Kilo and
  // anything else with neither a hook surface nor the MCP server wired — prints
  // every saving and files none, leaving `graft savings` permanently empty.
  // `mcp` is excluded because that server files each call as it serves it.
  if (action.name() !== "mcp" && queryNote.repo) {
    const claimed = claimedSavings();
    if (claimed > 0) {
      const repo = queryNote.repo;
      recordSavedTokens(repo, currentModel(repo, latestSession(repo)?.model), claimed);
    }
  }
  // `trail build --check` is graft's `check`, and counts as it always has.
  const name = queryNote.command ?? action.name();
  if (!isTrackedCommand(name)) return;
  track("query", { command: name, surface: "cli", hit: queryNote.hit, notes: queryNote.notes }, { repo: queryNote.repo });
});

/** `graft ask`, `graft build`: a command as graft spells it, whatever ran it. */
function spelling(action: Command): string {
  const words: string[] = [];
  for (let c: Command | null = action; c && c.parent; c = c.parent) words.unshift(c.name());
  return ["graft", ...words].join(" ");
}

// Hidden: spawned detached by maybeSyncInBackground when a workspace repo's
// learnings changed, or uses are waiting to go. Running it by hand syncs now.
// A repo that moved from graft to trail at session start reads its past
// sessions and PR reviews here, detached, so the session doesn't wait on it.
program
  .command("_trail-past-read", { hidden: true })
  .argument("<dir>")
  .action(async (dir: string) => {
    const repo = resolve(dir);
    const read = beginPastRead(repo);
    const reviews = beginReviewRead(repo);
    if (read) await finishPastRead(repo, read);
    if (reviews) await finishReviewRead(repo, reviews);
  });

program
  .command("_trail-sync", { hidden: true })
  .description("internal: send this repo's learnings and the waiting uses to the Trail workspace")
  .argument("[dir]", "target repo directory", ".")
  .action(async (dir: string) => {
    await runSyncChild(resolve(dir));
  });

// Hidden: spawned detached by maybeRefreshBranches.
program
  .command("_trail-branches", { hidden: true })
  .description("internal: fetch, then note which files teammates' open branches change and the learnings they carry")
  .argument("[dir]", "target repo directory", ".")
  .action((dir: string) => {
    refreshBranches(resolve(dir), { prs: true });
  });

program
  .command("_trail-claim", { hidden: true })
  .description("internal: wait for a sign-in through the link trail handed the agent, then connect the workspace")
  .action(async () => {
    await waitForConnect();
  });

program
  .command("_update-check", { hidden: true })
  .description("internal: refresh the cached latest-version answer")
  .action(() => {
    refreshUpdateCache();
  });

// Hidden for the same reason as _update-check: only ever spawned detached, by
// maybeFlushInBackground. Running it by hand is harmless — it drains the queue.
program
  .command("_telemetry-flush", { hidden: true })
  .description("internal: POST the queued anonymous usage events")
  .action(async () => {
    await runFlush();
  });

// Hidden from the help list: telemetry is permanently off, so there is nothing to
// configure. The command still runs, and `graft telemetry --help` still explains it.
grouped(program.command("telemetry", { hidden: true }), GROUP.setup)
  .description("Show the anonymous usage stats status — permanently off in this version; `debug` shows that nothing is queued")
  .argument("[action]", "status (default) | enable | disable | debug", "status")
  .action((action: string) => {
    switch (action) {
      case "status":
        console.log(formatStatus());
        return;
      case "enable":
        // Permanently off: there is nothing to turn on, and no setting is written.
        console.error("✗ telemetry cannot be enabled: it is permanently disabled in this version of graft. Nothing is recorded or sent.");
        process.exit(1);
        return;
      case "disable":
        console.log("telemetry: off. It is permanently disabled in this version of graft; nothing is recorded or sent.");
        return;
      case "debug":
        console.log(formatDebug());
        return;
      default:
        console.error(`✗ unknown action "${action}" — expected status, enable, disable, or debug`);
        process.exit(1);
    }
  });

// Hidden under trail, where -v says the same; listed under graft as it was.
program
  .command("version", { hidden: TRAIL })
  .description("Print the installed version and the latest published on npm")
  .action(() => {
    const latest = getNpmViewVersion();
    console.log(formatVersionReport(currentVersion, latest));
  });

grouped(program.command("upgrade"), GROUP.setup)
  .description(`Upgrade the globally installed ${brand()} to the latest version on npm`)
  .action(() => {
    const result = runUpgrade(import.meta.url);
    console.log(formatUpgradeReport(result));
    if (result.ran && !result.ok) process.exit(1);
    if (!TRAIL && result.ok && result.trailVersion) moveHereToTrail(process.cwd());
  });

/**
 * After `graft upgrade` brought the trail command along, the repo it ran in
 * moves to trail now, with the agents and flags its last init chose, and its
 * past sessions are read for learnings. Every other repo wired as graft moves
 * the next time a session opens in it (upkeep-run.ts).
 */
function moveHereToTrail(dir: string): void {
  const root = checkoutRoot(dir);
  if (!root || !shouldMoveToTrail(root)) return;
  const stamp = readStamp(root);
  const hosts = [...new Set([...(stamp?.hosts ?? []), ...wiredHostIds(root)])];
  const o = wiringOpts(stamp);
  const flags = [o.global ? null : "--no-global", o.mcp ? null : "--no-mcp", o.hooks ? null : "--no-hooks", o.statusline ? null : "--no-statusline"].filter(
    (f): f is string => f !== null,
  );
  console.log(`· moving this repo to trail: trail init ${hosts.length ? `--agents ${hosts.join(" ")} ` : ""}${flags.join(" ")}`.trimEnd());
  spawnSync("trail", ["init", root, "--agents", ...hosts, ...flags], { stdio: "inherit" });
}

grouped(program.command("build"), GROUP.setup)
  .description(
    TRAIL
      ? "Rebuild the code map in .trail/cache/ ($0, no key). --check fails if it's stale; --deep adds LLM summaries."
      : "Build graft/ from your code — wiring graph + per-file cards ($0, no key). " +
          "Add --deep for the LLM concept map + per-symbol summaries/crux.",
  )
  .argument("[dir]", "repository root", ".")
  .option("--check", "build nothing: fail if graft/ is stale relative to the code (for CI)")
  .option("--json", "with --check: output the drift as JSON")
  .option("--deep", "run the LLM pass: concept nodes (graft/*.md) + per-symbol summary/crux")
  .option("-e, --extensions <exts...>", 'code extensions to include (e.g. ".ts" ".py"); an extension with no parser is ignored with a warning that lists the supported set')
  .option("-j, --concurrency <n>", "files summarized in parallel during --deep (default 5)")
  .option("--no-reuse", "re-parse every file instead of replaying unchanged ones from the extraction cache")
  .option("--lsp", "add compiler-grade call edges via a language server if one is installed (opt-in, slower; e.g. rust-analyzer, clangd)")
  .option("--allow-partial", "with --deep: exit 0 even when some files' summaries failed (default: a degraded meaning tier exits 1)")
  .option(
    "--follow-submodules",
    "include initialized Git submodules recursively; persisted for later builds and automatic refreshes",
  )
  .option(
    "--no-follow-submodules",
    "exclude Git submodules; persisted for later builds and automatic refreshes (default)",
  )
  .option(
    "--follow-nested-repos",
    "include nested Git clones the index does not track (a multi-repo manifest checkout, or any repo cloned into the tree) " +
      "as ONE graph, so imports across them resolve; persisted for later builds and automatic refreshes",
  )
  .option(
    "--no-follow-nested-repos",
    "exclude untracked nested Git clones; persisted for later builds and automatic refreshes (default)",
  )
  .option(
    "--include-dir <name>",
    "index a directory the built-in skip list leaves out (node_modules, dist, build, _build, out, target, vendor, coverage, " +
      "__pycache__, venv) — a bare name, repeatable (e.g. --include-dir build --include-dir vendor); dot-dirs are never " +
      "overridable. Persisted, REPLACING the saved list; `graft config include-dirs add` adds to it instead",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    "--exclude-dir <name>",
    "skip a directory — repeatable. A bare NAME (themes) skips it at any depth; a root-relative PATH " +
      "(src/themes) skips only that one and its subtree; a GLOB (src/*-old, **/generated) matches root-relative " +
      "paths. Persisted like --include-dir, REPLACING the saved list, and wins over it; " +
      "`graft config exclude-dirs add|remove|list` manages the list one entry at a time",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    "--only-dir <path>",
    "only index files under this repo-relative path — repeatable; the wiring walk and the --deep " +
      "concept pass both honor it. Recorded in the graph fingerprint so a later build " +
      "(and the hooks/refresh path) walks the same set; everything outside the list is skipped",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option("--no-gitignore", "skip writing graft/ into .gitignore (same as GRAFT_NO_GITIGNORE=1)")
  .option("--no-ignore", "skip writing .ignore for ripgrep re-admit (same as GRAFT_NO_IGNORE=1)")
  .action(async (
    dir: string,
    opts: {
      check?: boolean;
      json?: boolean;
      deep?: boolean;
      extensions?: string[];
      concurrency?: string;
      reuse?: boolean;
      lsp?: boolean;
      allowPartial?: boolean;
      includeDir?: string[];
      excludeDir?: string[];
      onlyDir?: string[];
      followSubmodules?: boolean;
      followNestedRepos?: boolean;
      gitignore?: boolean;
      ignore?: boolean;
    },
    command: Command,
  ) => {
    if (opts.check) {
      // The freshness check, which was `graft check`. Counted as `check` so the
      // metric carries on across the rename; the dir defaults like a query's.
      queryNote.command = "check";
      await runCheckCommand(command.args[0], { extensions: opts.extensions, json: opts.json }, cmd("graft check"));
      return;
    }
    const buildStartedAt = Date.now();
    if (opts.gitignore === false) process.env.GRAFT_NO_GITIGNORE = "1";
    if (opts.ignore === false) process.env.GRAFT_NO_IGNORE = "1";
    const concurrency = opts.concurrency ? Math.max(1, Number(opts.concurrency)) : undefined;
    if (opts.concurrency && !Number.isFinite(concurrency)) {
      console.error(`✗ --concurrency must be a number, got "${opts.concurrency}"`);
      process.exit(1);
    }
    warnUnsupportedExtensions(opts.extensions);
    // Persisted BEFORE the build itself runs, so this invocation's walks (and
    // every later no-flag build / hooks refresh) see it identically — the
    // walkDir call sites read it from state, not from a threaded option.
    const buildConfigPatch: BuildConfig = {};
    if (opts.includeDir && opts.includeDir.length > 0) {
      // --include-dir takes bare SKIP_DIRS-style directory NAMES (shouldSkipDir
      // compares a single path segment), never paths, and dot-dirs are never
      // overridable at all (see the option's own help text) — reject anything
      // else up front instead of silently persisting a value that can never
      // match a real directory name.
      for (const name of opts.includeDir) {
        const problem = includeDirProblem(name);
        if (problem) {
          console.error(`✗ --include-dir "${name}": ${problem}`);
          process.exit(1);
        }
      }
      buildConfigPatch.includeDirs = opts.includeDir;
    }
    if (opts.excludeDir && opts.excludeDir.length > 0) {
      // Accepted shapes, unlike --include-dir's bare names only: a NAME
      // (`themes`) excludes that segment at any depth, a root-relative PATH
      // (`src/themes`) excludes exactly one directory and its subtree, and a
      // GLOB matches root-relative paths. Dot-names are accepted rather than
      // rejected — they are already skipped, so naming one is redundant, not a
      // mistake.
      for (const name of opts.excludeDir) {
        const problem = excludeDirProblem(name);
        if (problem) {
          console.error(`✗ --exclude-dir "${name}": ${problem}`);
          process.exit(1);
        }
      }
      buildConfigPatch.excludeDirs = opts.excludeDir.map(normalizeExcludeEntry);
    }
    // The whitelist is NOT persisted to `.graft/config.json`: it belongs with the
    // graph (the fingerprint records it at build time), never in the source repo,
    // so a `--only-dir` build leaves no trace under the repo being indexed.
    let onlyDirs: string[] | undefined;
    if (opts.onlyDir && opts.onlyDir.length > 0) {
      // --only-dir takes a repo-relative path prefix, normalized to the same
      // posix, no-`./`, no-trailing-slash form `--in` uses, so the prefix match
      // is exact. A prefix that normalizes to "" (a bare "/" or ".") is rejected:
      // it would mean "match nothing" or "match everything", neither of which is
      // a deliberate whitelist.
      const normalized = opts.onlyDir.map((p) => normalizePathPrefix(p)).filter((p) => p !== "");
      if (normalized.length === 0) {
        console.error("✗ --only-dir: expected a non-empty repo-relative path");
        process.exit(1);
      }
      onlyDirs = normalized;
    }
    const followSubmodulesWasExplicit = command.getOptionValueSource("followSubmodules") === "cli";
    if (followSubmodulesWasExplicit && typeof opts.followSubmodules === "boolean") {
      buildConfigPatch.followSubmodules = opts.followSubmodules;
    }
    const followNestedReposWasExplicit = command.getOptionValueSource("followNestedRepos") === "cli";
    if (followNestedReposWasExplicit && typeof opts.followNestedRepos === "boolean") {
      buildConfigPatch.followNestedRepos = opts.followNestedRepos;
    }
    if (Object.keys(buildConfigPatch).length > 0) {
      patchBuildConfig(resolve(dir), buildConfigPatch);
    }
    // Databricks gateway: check the key, then use the model already set when the
    // gateway serves it; only otherwise ask which of its models to use.
    let deepSkip: string | undefined;
    if (opts.deep) {
      const choice = await chooseDatabricksDeepModel({
        config: cliConfig(),
        env: process.env,
        out: (l) => console.log(l),
        err: (l) => console.error(l),
        prompt: process.stdin.isTTY && process.stdout.isTTY ? terminalPrompter() : undefined,
        store: userEnvStore(),
      });
      if ("cancelled" in choice) {
        console.log("Cancelled — nothing was built.");
        process.exit(130);
      }
      if ("skip" in choice) deepSkip = choice.skip;
      else llmOverride = { apiKey: choice.config.apiKey, model: choice.config.model };
    }
    const engine = engineFrom();
    const fmt = (o: Record<string, number>) =>
      Object.entries(o)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n} ${k}`)
        .join(", ");

    // --deep needs a key; without one, degrade to the $0 structural build.
    let deep = opts.deep;
    const resolved = resolveConfig(cliConfig());
    if (deep && deepSkip) {
      deep = false;
      console.error(
        `⚠ ${deepSkip} — falling back to the structural build (no LLM summaries).\n` +
          `  Set GRAFT_API_KEY to a Databricks personal access token (\`${cmd("graft api key")}\`), then re-run \`${cmd("graft build --deep")}\`.`,
      );
    }
    if (deep && !resolved.apiKey) {
      deep = false;
      console.error(
        "⚠ no API key set — falling back to the structural build (no LLM summaries).\n" +
          `  Set GRAFT_API_KEY (\`${cmd("graft api key")}\`), and GRAFT_BASE_URL / GRAFT_MODEL for your provider\n` +
          `  (\`${cmd("graft api url")}\`, \`${cmd("graft model")}\`), then re-run \`${cmd("graft build --deep")}\` to add concept nodes and summaries.`,
      );
    }
    if (deep && resolved.usedLegacyEnv) {
      console.error(
        "⚠ using OPENROUTER_API_KEY (deprecated) — prefer GRAFT_API_KEY + GRAFT_BASE_URL.",
      );
    }

    // Workspace parent: build each child into its OWN graft/ + a workspace index.
    const buildRoot = resolve(dir);
    const buildGlobalDir = program.opts<GlobalOpts>().dir;
    if (isWorkspaceBuildRoot(buildRoot, buildGlobalDir)) {
      await runWorkspaceBuild(buildRoot, {
        deep: !!deep,
        extensions: opts.extensions,
        concurrency,
        childConfig: cliConfig(),
        override: buildGlobalDir,
        includeDirs: opts.includeDir,
        excludeDirs: opts.excludeDir,
        followSubmodules: followSubmodulesWasExplicit ? opts.followSubmodules : undefined,
        followNestedRepos: followNestedReposWasExplicit ? opts.followNestedRepos : undefined,
        packageName: readPackageName(import.meta.url),
      });
      return;
    }

    // --deep: concept nodes first, then the wiring graph links cards up to them.
    let conceptErrors: string[] = [];
    let conceptFatal: string | undefined;
    if (deep) {
      const c = await engine.init(dir, {
        extensions: opts.extensions,
        onlyDirs,
        onProgress: ({ phase, index, total, file }) =>
          process.stderr.write(
            `\r${phase === "summarize" ? "reading" : "writing"} concepts ${index + 1}/${total}: ${file.slice(0, 40).padEnd(40)}`,
          ),
      }).catch(async (err: unknown) => {
        // Only the stage and a code enum; the message stays on this machine.
        track("build_failed", { stage: "summarize", code: errorCode(err) }, { repo: buildRoot });
        await printLlmFailureHints([err instanceof Error ? err.message : String(err)], cliConfig());
        throw err;
      });
      process.stderr.write("\n");
      if (c.failedBatches > 0 || c.skippedBatches > 0) {
        // Not a ✓: the node set was not written (see buildContext), so "0 nodes"
        // would read as if the concept map had been emptied.
        console.log(
          `✗ concepts: synthesis incomplete (${c.batches - c.failedBatches - c.skippedBatches}/${c.batches} batches) — ` +
            `existing concept nodes kept; ${c.files} files (${c.summarized} read, ${c.cached} cached)`,
        );
      } else {
        console.log(
          `✓ concepts: ${c.nodes} nodes, ${c.links} links from ${c.files} files (${c.summarized} read, ${c.cached} cached)`,
        );
      }
      for (const e of c.errors) console.error(`✗ ${e}`);
      conceptErrors = c.errors;
      conceptFatal = c.fatal;
    }

    // Wiring graph — always; LLM meaning only with --deep.
    const g = await engine.graph(dir, {
      llm: deep,
      concurrency,
      reuse: opts.reuse,
      lsp: opts.lsp,
      onlyDirs,
      onProgress: ({ phase, index, total, file }) =>
        process.stderr.write(
          `\r${phase === "enrich" ? "summarizing" : "parsing"} ${index + 1}/${total}: ${file.slice(0, 50).padEnd(50)}`,
        ),
    }).catch(async (err: unknown) => {
      track("build_failed", { stage: "graph", code: errorCode(err) }, { repo: buildRoot });
      if (deep) await printLlmFailureHints([err instanceof Error ? err.message : String(err)], cliConfig());
      throw err;
    });
    process.stderr.write("\n");
    console.log(`✓ wiring: ${g.nodes} nodes (${fmt(g.byKind)}), ${g.edges} edges, ${g.cards} cards [${g.languages.join(", ")}]`);
    console.log(`  parsed: ${g.parsed} of ${g.files} files (${g.reused} replayed from cache)`);
    // Worth one line: this build started from a graph the user never built *here*.
    if (g.seededFrom) console.log(`  seeded: copied a starting graph from ${g.seededFrom} (git worktree)`);
    if (deep) {
      const m = g.meaning;
      console.log(`  meaning: ${m.computed} computed, ${m.cached} cached, ${m.stale} stale, ${m.pending} pending`);
    }
    console.log(`  → ${g.contextDir}`);
    // The activation event. Everything here is a bucket or a fixed label: repo
    // scale rather than a file count, a language set rather than file names.
    track(
      "build_completed",
      {
        files_bucket: filesBucket(g.files),
        langs: langsValue(g.languages),
        mode: deep ? "deep" : "fast",
        duration_bucket: durationBucket(Date.now() - buildStartedAt),
        incremental: String(g.reused > 0),
      },
      { repo: buildRoot },
    );
    for (const e of g.errors) console.error(`✗ ${e}`);
    // A language whose native grammar didn't load was parsed by its WASM stand-in:
    // say which, and the install that fixes it. Nothing when everything loaded.
    const fallbackNotice = nativeFallbackNotice(g.nativeFallback, readPackageName(import.meta.url));
    if (fallbackNotice) console.error(fallbackNotice);

    const rel = relative(process.cwd(), g.contextDir) || "graft";
    if (process.env.GRAFT_NO_GITIGNORE) {
      console.log(`  ${rel}/ is a local cache — add it to your gitignore if you want it untracked.`);
    } else {
      console.log(`  ${rel}/ is git-ignored (added automatically) — a local cache; teammates run \`${cmd("graft build")}\` to get their own.`);
    }

    // #127: a --deep run whose LLM calls failed used to print the same success
    // footer and exit 0, so a quota-exhausted build looked identical to a clean
    // one and `graft check` still said "in sync" (it only ever checked Tier-1).
    // The structural graph IS still written and every successful summary is
    // cached, so this is a loud warning about a degraded tier, not a rollback.
    if (deep) {
      const m = g.meaning;
      const failed =
        m.failedFiles > 0 || m.fatal !== undefined || conceptErrors.length > 0 || conceptFatal !== undefined;
      if (failed) {
        const ready = m.computed + m.cached;
        const total = ready + m.stale + m.pending;
        const pct = total > 0 ? Math.round((ready / total) * 100) : 0;
        console.error("");
        console.error(`✗ the deep pass did not complete — the meaning tier is incomplete.`);
        if (conceptFatal) console.error(`  concepts: ${conceptFatal}`);
        if (m.fatal) console.error(`  summaries: ${m.fatal}`);
        if (m.failedFiles > 0) {
          const skipped = m.skippedFiles > 0 ? `, ${m.skippedFiles} never attempted` : "";
          console.error(`  ${m.failedFiles} file(s) failed to summarize${skipped}.`);
        }
        if (conceptErrors.length > 0) console.error(`  ${conceptErrors.length} concept-pass error(s).`);
        console.error(`  meaning coverage: ${ready}/${total} symbols (${pct}%).`);
        await printLlmFailureHints([conceptFatal, m.fatal, ...conceptErrors, ...g.errors], cliConfig());
        console.error(
          `  Nothing computed was lost: re-run \`${cmd("graft build --deep")}\` to resume from what is cached.\n` +
            "  Pass --allow-partial to accept a degraded meaning tier and exit 0.",
        );
        if (!opts.allowPartial) process.exitCode = 1;
      }
    }
  });

/** The file part of a hit's `file:Lx-Ly` pointer. */
function pointerFile(pointer: string): string {
  return pointer.replace(/:L\d+(-L?\d+)?$/, "");
}

/**
 * After `ask`, under trail: which shown learnings are a teammate's, and the
 * shown learnings recorded as a use, which is what the team page counts as
 * reuse. Then the background upkeep that keeps branches and the workspace
 * current. Spawns no git itself. Teammates' branches come up after an edit
 * instead, once there's a function to compare (notes/edit-overlap.ts).
 */
function afterAsk(r: AskResult, repo: string): void {
  if (!r.notesChecked) return;
  rememberRepo(repo);
  maybeRefreshBranches(repo);
  const me = noteAuthor(repo);
  const files = [...new Set(r.hits.map((h) => pointerFile(h.pointer)))];
  const shown = r.notes ?? [];
  if (shown.length) {
    for (const h of shown) h.note.teammate = !!h.note.author && !!me && h.note.author !== me;
    recordActivity({
      repo: repoPlace(repo).key,
      kind: "search",
      asker: me,
      session: sessionKey(repo) ?? `${me}-${new Date().toISOString().slice(0, 10)}`,
      query: r.query,
      files,
      shown_paths: shown.map((h) => noteName(h.note)),
      shown_authors: shown.map((h) => h.note.author),
      at: new Date().toISOString(),
    });
    const saved = shown.reduce((sum, h) => sum + savedByNote(h.note), 0);
    track("learning_reused", { teammate: String(shown.some((h) => h.note.teammate)), saved_tokens_bucket: savedTokensBucket(saved) }, { repo });
  }
  maybeSyncInBackground(repo);
}

grouped(program.command("ask"), GROUP.find)
  .description("Query the graft/ graph — returns ranked nodes + exact file:line, routed to prose or wiring ($0, no key)")
  .argument("<query>", "what you want to understand, in plain words")
  .argument(...DIR_ARG)
  .option("-n, --limit <n>", "max results", "8")
  .option("--source", "inline the source at each file:line hit (retriever mode — the pack IS the answer, no need to re-open files)")
  .option("--full", "with --source: inline whole definition spans instead of the default ≤8-line crux excerpts")
  .option("--in <path>", "narrow to nodes under this path prefix, filtered before scoring (segment-aware, like scopeOf)")
  .option("--json", "output the result as JSON")
  .option("--no-graph-rank", "rank by lexical relevance only, without the graph-connectivity re-rank (ablation/eval)")
  .option(...NO_REFRESH_FLAG)
  .action(async (query: string, dirArg: string | undefined, opts: { limit: string; source?: boolean; full?: boolean; in?: string; json?: boolean; refresh?: boolean; graphRank?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const askGlobalDir = program.opts<GlobalOpts>().dir;
    if (readWorkspace(dir, askGlobalDir)) {
      runWorkspaceAsk(dir, askGlobalDir, query, {
        limit: Number(opts.limit), source: opts.source, full: opts.full, in: opts.in, json: opts.json,
      });
      return;
    }
    const engine = engineFrom();
    let r;
    try {
      r = engine.ask(dir, query, { limit: Number(opts.limit), source: opts.source, full: opts.full, in: opts.in, graphRank: opts.graphRank });
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return;
    }
    noteHit(r.hits.length > 0);
    // Teammates' branches on the same files, and the learnings shown, counted as a use.
    if (TRAIL) afterAsk(r, dir);
    // How many notes reached the agent: the demand side of `trail note`.
    if (r.notesChecked) queryNote.notes = String(Math.min(r.notes?.length ?? 0, 2));
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      const { formatAsk } = await import("./ask/ask.js");
      process.stdout.write(formatAsk(r));
      printLines(cloudLines(dir, { command: "ask" }));
    }
  });

grouped(program.command("skeleton"), GROUP.find)
  .description("Signatures-only view of one file from the wiring graph — the cheapest way to see a file's API surface")
  .argument("<file>", "repo-relative path (or unique basename) of the file")
  .argument(...DIR_ARG)
  .option("--json", "output the result as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(async (file: string, dirArg: string | undefined, opts: { json?: boolean; refresh?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const { skeleton, formatSkeleton } = await import("./ask/ask.js");
    const globalOpts = program.opts<{ dir?: string }>();
    const r = skeleton(dir, file, { contextDir: globalOpts.dir });
    if (opts.json) console.log(JSON.stringify(r, null, 2));
    else process.stdout.write(formatSkeleton(r));
  });

if (!TRAIL) {
  program
    .command("check")
    .description("Fail if graft/ is stale relative to the code (for CI)")
    .argument(...DIR_ARG)
    .option("-e, --extensions <exts...>", "code extensions to include")
    .option("--json", "output the drift as JSON")
    .action(async (dirArg: string | undefined, opts: { extensions?: string[]; json?: boolean }) => {
      await runCheckCommand(dirArg, opts, "graft check");
    });
}
// Under trail, `check` is the team check (teamCheckCommand, with the cloud
// commands below); the freshness check is `trail build --check`.

/**
 * The freshness check: `graft check`, and `trail build --check`. `label` is how
 * the report names the command, so each name prints its own spelling.
 */
async function runCheckCommand(
  dirArg: string | undefined,
  opts: { extensions?: string[]; json?: boolean },
  label: string,
): Promise<void> {
    warnUnsupportedExtensions(opts.extensions);
    const dir = noteQuery(queryRoot(dirArg));
    const checkGlobalDir = program.opts<GlobalOpts>().dir;
    if (readWorkspace(dir, checkGlobalDir)) {
      await runWorkspaceCheck(dir, checkGlobalDir);
      return;
    }
    const engine = engineFrom();
    const r = engine.check(dir, { extensions: opts.extensions });
    const g = await engine.checkGraph(dir); // graph.json is only judged when it exists

    // A layer that IS present must be in sync; a never-built layer (keyless
    // build skips the markdown layer) is informational, not a failure.
    const bothMissing = r.missing && g.missing;
    const markdownFail = !r.missing && !r.ok;
    const wiringFail = !g.missing && !g.ok;

    if (opts.json) {
      console.log(JSON.stringify({ context: r, graph: g.missing ? null : g }, null, 2));
    } else if (bothMissing) {
      console.log(`${label}: NO GRAPH\n\nNo code map found. Run \`${cmd("graft build")}\` first.`);
    } else {
      if (r.missing) {
        console.log(
          `deep layer: not built (run \`${cmd("graft build --deep")}\` for concept nodes) — wiring graph is the source of truth`,
        );
      } else {
        console.log(formatCheckReport(r, label));
      }
      if (!g.missing) console.log("\n" + formatGraphCheckReport(g));
    }

    if (bothMissing || markdownFail || wiringFail) process.exit(1);
}

program
  .command("deep-threshold")
  .description(
    "Show or set the % of out-of-date node summaries (changed or new code) above which queries recommend `graft build --deep` — " +
      `per repo, or for every repo with --global (default ${DEFAULT_DEEP_STALE_THRESHOLD}; 0 = anything out of date, 100 = never)`,
  )
  .argument("[percent]", "new threshold, 0–100 (omit to show the current one)")
  .argument(...DIR_ARG)
  .option("-g, --global", "set/reset the default for every repo (~/.graft/settings.json); a repo's own value still wins")
  .option("--reset", "remove the value: a repo's falls back to the global one, the global one to the default")
  .action((percentArg: string | undefined, dirArg: string | undefined, opts: { reset?: boolean; global?: boolean }) => {
    // `graft deep-threshold <dir>` shows that repo's value: a lone non-number that
    // names a directory is the dir, not a malformed percent.
    let percent = percentArg;
    if (dirArg === undefined && percent !== undefined && Number.isNaN(Number(percent.replace(/%$/, "")))) {
      if (existsSync(percent) && statSync(percent).isDirectory()) [dirArg, percent] = [percent, undefined];
    }
    // Repo-level, like every `.graft/config.json` setting: the nearest graft root.
    const dir = queryRoot(dirArg);
    if (opts.reset && percent !== undefined) {
      console.error("graft deep-threshold: pass a percent or --reset, not both");
      process.exit(1);
    }
    let value: number | undefined;
    if (percent !== undefined) {
      value = Number(percent.trim().replace(/%$/, ""));
      if (percent.trim() === "" || !isValidDeepStaleThreshold(value)) {
        console.error(`graft deep-threshold: "${percent}" is not a percent between 0 and 100`);
        process.exit(1);
      }
    }
    if (opts.reset || value !== undefined) {
      if (opts.global) patchGlobalSettings({ deepStaleThreshold: value });
      else patchBuildConfig(dir, { deepStaleThreshold: value });
    }

    const repoPath = join(dir, ".graft", "config.json");
    const globalPath = globalSettingsPath();
    const repoValue = readBuildConfig(dir)?.deepStaleThreshold;
    const globalValue = readGlobalSettings()?.deepStaleThreshold;
    const { value: threshold, source } = resolveDeepStaleThreshold(dir);
    const from = { repo: `this repo, ${repoPath}`, global: `global, ${globalPath}`, default: "default" }[source];
    const shown = (v: unknown) => (isValidDeepStaleThreshold(v) ? `${v}%` : "not set");
    console.log(`deep-threshold: ${threshold}% (${from})`);
    console.log(`  this repo: ${shown(repoValue)}`);
    console.log(`  global:    ${shown(globalValue)}`);
    console.log(`  default:   ${DEFAULT_DEEP_STALE_THRESHOLD}%`);
    if (opts.global && source === "repo") {
      console.log(`note: this repo keeps its own ${threshold}% — \`graft deep-threshold --reset\` here to use the global value`);
    }
    const when =
      threshold >= 100
        ? "never shown"
        : threshold === 0
          ? "shown whenever any node summary is out of date (changed or new code)"
          : `shown when more than ${threshold}% of node summaries are out of date (changed or new code)`;
    console.log(`the \`graft build --deep\` recommendation is ${when}`);
    const graph = loadGraphCached(contextDirFor(dir, program.opts<GlobalOpts>().dir));
    const s = summaryStaleness(graph);
    if (s.total > 0 && s.summarized === 0) {
      console.log(`now: no \`graft build --deep\` yet — none of the ${s.total} nodes has a prose summary (100% out of date)`);
    } else if (s.total > 0) {
      const outdated = s.stale + s.unsummarized;
      const pct = Math.round((outdated / s.total) * 100);
      console.log(
        `now: ${outdated} of ${s.total} node summaries out of date (${pct}%) — ${s.stale} changed, ${s.unsummarized} new`,
      );
    }
  });

// `graft config`: list and edit `.graft/config.json` one setting at a time. The
// prose — what each setting means and what an entry may look like — is in
// cli-help-graft.ts, shown by `graft config <setting> --help`.
const REPO_OPT = ["--repo <dir>", "repository root (default: nearest ancestor with a graft/ index, else the current directory)"] as const;
const configRepo = (opts: { repo?: string }) => queryRoot(opts.repo);

const configCommand = grouped(program.command("config"), GROUP.setup).description(
  "List and change this repo's settings in .graft/config.json: excludeDirs, includeDirs, followSubmodules, followNestedRepos",
);

configCommand
  .command("list")
  .description("Show every setting in .graft/config.json with its value, its default and what it does")
  .option(...REPO_OPT)
  .action((opts: { repo?: string }) => {
    console.log(formatConfigList(configRepo(opts)));
  });

function dirListCommands(name: string, key: DirListKey, what: string): void {
  const group = configCommand.command(name).alias(key).description(`List, add or remove ${what} (${key})`);
  const show = (repo: string) => {
    const list = readDirList(repo, key);
    if (list.length === 0) {
      console.log(`${key}: none`);
      return;
    }
    console.log(`${key}:`);
    for (const e of list) {
      const note = key === "excludeDirs" ? describeExcludeEntry(e) : includeEntryNote(e);
      console.log(`  ${e}${note ? `  — ${note}` : ""}`);
    }
  };
  group
    .command("list")
    .description(`Show the ${key} entries, each with how it matches`)
    .option(...REPO_OPT)
    .action((opts: { repo?: string }) => show(configRepo(opts)));
  group
    .command("add")
    .description(`Add entries to ${key}; ones already there are left as they are`)
    .argument("<entries...>", key === "excludeDirs" ? "names, root-relative paths or globs" : "bare directory names")
    .option(...REPO_OPT)
    .action((entries: string[], opts: { repo?: string }) => {
      for (const e of entries) {
        const problem = dirProblem(key, e);
        if (problem) {
          console.error(`✗ ${cmd(`graft config ${name} add`)} "${e}": ${problem}`);
          process.exit(1);
        }
      }
      const repo = configRepo(opts);
      const { added, present } = addDirEntries(repo, key, entries);
      for (const e of added) {
        const note = key === "excludeDirs" ? describeExcludeEntry(e) : includeEntryNote(e);
        console.log(`✓ added ${e}${note ? `  — ${note}` : ""}`);
      }
      for (const e of present) console.log(`· ${e} is already in ${key}`);
      if (added.length) console.log(CONFIG_APPLY_NOTE());
    });
  group
    .command("remove")
    .alias("rm")
    .description(`Remove entries from ${key}, written as \`list\` shows them`)
    .argument("<entries...>", "entries to remove")
    .option(...REPO_OPT)
    .action((entries: string[], opts: { repo?: string }) => {
      const repo = configRepo(opts);
      const { removed, missing } = removeDirEntries(repo, key, entries);
      for (const e of removed) console.log(`✓ removed ${e}`);
      for (const e of missing) console.error(`· ${e} is not in ${key} — \`${cmd(`graft config ${name} list`)}\` shows what is`);
      if (removed.length) console.log(CONFIG_APPLY_NOTE());
      if (missing.length && !removed.length) process.exitCode = 1;
    });
  group
    .command("clear")
    .description(`Remove every ${key} entry`)
    .option(...REPO_OPT)
    .action((opts: { repo?: string }) => {
      const cleared = clearDirEntries(configRepo(opts), key);
      if (!cleared.length) {
        console.log(`${key} was already empty`);
        return;
      }
      console.log(`✓ removed ${cleared.length} entr${cleared.length === 1 ? "y" : "ies"}: ${cleared.join(", ")}`);
      console.log(CONFIG_APPLY_NOTE());
    });
}
dirListCommands("exclude-dirs", "excludeDirs", "the directories left out of the graph");
dirListCommands("include-dirs", "includeDirs", "the built-in skipped directories indexed anyway");

function flagCommand(name: string, key: FlagKey, what: string): void {
  configCommand
    .command(name)
    .alias(key)
    .description(`Show or set ${key}: ${what}`)
    .argument("[value]", "on or off (also true/false, yes/no); omit to show the current value")
    .option(...REPO_OPT)
    .action((value: string | undefined, opts: { repo?: string }) => {
      const repo = configRepo(opts);
      if (value !== undefined) {
        const on = parseOnOff(value);
        if (on === null) {
          console.error(`✗ ${cmd(`graft config ${name}`)}: "${value}" is not on or off`);
          process.exit(1);
        }
        const before = readFlag(repo, key).value;
        writeFlag(repo, key, on);
        console.log(`✓ ${key}: ${on ? "on" : "off"}${before === on ? " (unchanged)" : ""}`);
        if (before !== on) console.log(CONFIG_APPLY_NOTE());
        return;
      }
      const { value: current, set } = readFlag(repo, key);
      console.log(`${key}: ${current ? "on" : "off"}${set ? "" : " (default)"}`);
    });
}
flagCommand("follow-submodules", "followSubmodules", "index initialized Git submodules into this repo's graph");
flagCommand(
  "follow-nested-repos",
  "followNestedRepos",
  "index nested Git clones this repo's index does not track into one graph",
);

/** What the `api url` / `api key` / `model` commands read and write through. */
function settingDeps(): SettingDeps {
  return {
    store: userEnvStore(),
    env: process.env,
    platform: process.platform,
    config: cliConfig(),
    cwd: process.cwd(),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    prompt: process.stdin.isTTY && process.stdout.isTTY ? terminalPrompter() : undefined,
  };
}

const SAVED_WHERE =
  "saved as a user environment variable (Windows: HKCU\\Environment; macOS/Linux: ~/.graft/env.sh, sourced from your shell profile)";

const apiCommand = grouped(program.command("api"), GROUP.setup).description(
  "Show or set the LLM endpoint `graft build --deep` uses: `api url` (GRAFT_BASE_URL) and `api key` (GRAFT_API_KEY)",
);

apiCommand
  .command("url")
  .description(`Show or set GRAFT_BASE_URL, the LLM endpoint for \`graft build --deep\` — ${SAVED_WHERE}`)
  .argument("[url]", "new base URL, e.g. https://my-gateway.example.com/v1 (omit to show it, and to be prompted in a terminal)")
  .option("--unset", "remove the saved value")
  .option("--no-verify", "skip the check against the endpoint after saving")
  .action(async (value: string | undefined, opts: SettingOptions) => {
    process.exitCode = await runSettingCommand("url", value, opts, settingDeps());
  });

apiCommand
  .command("key")
  .description(`Show (masked) or set GRAFT_API_KEY, the key for the LLM endpoint — ${SAVED_WHERE}`)
  .argument("[key]", "new API key (omit to be prompted with hidden input, which keeps it out of your shell history)")
  .option("--unset", "remove the saved value")
  .option("--no-verify", "skip the check against the endpoint after saving")
  .action(async (value: string | undefined, opts: SettingOptions) => {
    process.exitCode = await runSettingCommand("key", value, opts, settingDeps());
  });

grouped(program.command("model"), GROUP.setup)
  .description(
    `Show or set GRAFT_MODEL, the model \`graft build --deep\` uses — in a terminal, pick from the models the endpoint serves; ${SAVED_WHERE}`,
  )
  .argument("[id]", "new model id, e.g. claude-sonnet-5.5 (omit to show it, and to pick one in a terminal)")
  .option("--list", "list the models the endpoint serves (mid-tier first) and exit")
  .option("--unset", "remove the saved value")
  .option("--no-verify", "skip the check against the endpoint after saving")
  .action(async (value: string | undefined, opts: SettingOptions) => {
    process.exitCode = await runSettingCommand("model", value, opts, settingDeps());
  });

const pricesCommand = grouped(program.command("prices"), GROUP.setup).description(
  "Show or update the local copy of LiteLLM's model price catalog, which prices savings for models graft's built-in table does not list",
);

pricesCommand
  .command("update")
  .description(
    `Download LiteLLM's public model price catalog (one anonymous GET, nothing about you or your models is sent) and store it in ${priceCatalogPath()}`,
  )
  .action(async () => {
    try {
      const { catalog, path } = await updatePriceCatalog();
      const count = Object.keys(catalog.models).length;
      console.log(`✓ stored LiteLLM prices for ${count} models in ${path}`);
      console.log(
        `  used to price savings for models graft's built-in table does not list, until the next \`${cmd("graft prices update")}\``,
      );
    } catch (e) {
      console.error(`✗ ${cmd("graft prices update")}: ${e instanceof Error ? e.message : String(e)}`);
      console.error("  any previously stored prices are unchanged");
      process.exitCode = 1;
    }
  });

pricesCommand
  .command("status")
  .description("Show whether a local price catalog is stored, how old it is, and optionally what it lists for one model")
  .argument("[model]", "a model id to look up, e.g. claude-opus-4-5")
  .action((model: string | undefined) => {
    const s = priceCatalogStatus();
    if (s.state === "missing") {
      console.log(`no local model prices (${s.path}) — run \`${cmd("graft prices update")}\` to fetch them from LiteLLM`);
    } else {
      const when = `fetched ${s.fetchedAt!.slice(0, 10)}, ${s.ageDays} day${s.ageDays === 1 ? "" : "s"} ago`;
      console.log(`local model prices: ${s.models} models from LiteLLM, ${when} (${s.path})`);
    }
    if (model) {
      const builtin = listRate({ id: model, confidence: "certain" });
      if (builtin && !builtin.catalogFetchedAt) {
        console.log(`${model}: $${builtin.usdPerMtok}/Mtok input (graft's built-in table)`);
      } else if (builtin) {
        const c = catalogPrice(model);
        const cache = [
          c?.cacheRead !== undefined ? `cache read $${c.cacheRead}/Mtok` : "",
          c?.cacheWrite !== undefined ? `cache write $${c.cacheWrite}/Mtok` : "",
        ].filter(Boolean);
        console.log(`${model}: $${builtin.usdPerMtok}/Mtok input${cache.length ? `, ${cache.join(", ")}` : ""} (LiteLLM catalog)`);
      } else {
        console.log(`${model}: no known price`);
      }
    }
  });

grouped(program.command("staleness"), GROUP.setup)
  .description(
    "Show what % of a repo's node summaries are out of date (changed or new code) and whether `graft build --deep` is worth running yet, " +
      "judged against the deep-threshold ($0, no LLM)",
  )
  .argument(...DIR_ARG)
  .option("--top <n>", "list this many most-out-of-date files, worst first (0 = none)", "10")
  .option("--json", "output the report as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(async (dirArg: string | undefined, opts: { top: string; json?: boolean; refresh?: boolean }) => {
    const top = Number(opts.top);
    if (!Number.isInteger(top) || top < 0) {
      console.error(`graft staleness: --top "${opts.top}" is not a whole number of files`);
      process.exit(1);
    }
    const dir = queryRoot(dirArg);
    const globalDir = program.opts<GlobalOpts>().dir;
    // Refresh like any query, so edits since the last build count as changed or
    // new; but not via refreshBefore, whose nudge would only repeat this report.
    const ws = readWorkspace(dir, globalDir);
    const disabled = opts.refresh === false;
    const r = ws
      ? await ensureFreshChildren(dir, ws.children, { contextDir: globalDir, disabled })
      : await ensureFreshGraph(dir, { contextDir: globalDir, disabled });
    const note = refreshNote(r);
    if (note) console.error(note);
    const report = stalenessReport(dir, { contextDir: globalDir, children: ws?.children, top });
    console.log(opts.json ? JSON.stringify(report, null, 2) : formatStalenessReport(report));
  });

// Under trail this is part of `status`; the old name still runs, unlisted.
program
  .command("stats", { hidden: TRAIL })
  .description(`Show this agent session's ${brand()}-vs-source usage mix and tokens saved`)
  .argument(...DIR_ARG)
  .option("--json", "output the session stats as JSON")
  .action((dirArg: string | undefined, opts: { json?: boolean }) => {
    // Reads local session JSON only — no graph, no network. This is how a Cursor
    // user (no statusline) sees the numbers the Claude Code bar would show, and it
    // works under DO_NOT_TRACK because it never touches telemetry.
    const dir = queryRoot(dirArg);
    const s = latestSession(dir);
    if (opts.json) {
      console.log(JSON.stringify(s, null, 2));
      return;
    }
    console.log(formatSessionStats(s, sessionInputRate(dir)));
  });

program
  .command("models")
  .description(
    "Price this session's saved tokens under every model your agent offers — the answer when nothing named the model you actually ran",
  )
  .argument(...DIR_ARG)
  .option("--tokens <n>", "price this many saved tokens instead of the session's total")
  .option("--json", "output the model list and values as JSON")
  .action((dirArg: string | undefined, opts: { tokens?: string; json?: boolean }) => {
    const dir = queryRoot(dirArg);
    const parsed = opts.tokens === undefined ? NaN : Number(opts.tokens);
    if (opts.tokens !== undefined && (!Number.isFinite(parsed) || parsed < 0)) {
      console.error(`✗ --tokens takes a non-negative number, got "${opts.tokens}"`);
      process.exit(1);
    }
    const saved = Number.isFinite(parsed) ? parsed : latestSession(dir)?.savedTokens ?? 0;
    const host = readHostModels();
    if (opts.json) {
      console.log(JSON.stringify({ savedTokens: saved, ...(host ?? { host: null, path: null, models: [] }) }, null, 2));
      return;
    }
    console.log(formatModelPrices(host, saved));
  });

program
  .command("savings")
  .description(
    "Cumulated savings for this repo (or, with --all, every repo graft has been used in), per model — all time, or for one period: `graft savings 2026`, `graft savings 2026-09`, `graft savings 2026-09-08`",
  )
  .argument("[period]", "yyyy | yyyy-mm | yyyy-mm-dd (default: every day on record)")
  .argument(...DIR_ARG)
  .option("-a, --all", "every folder graft has recorded savings in on this machine, per repo and per model, in total (listed in ~/.graft/repos.json)")
  .option("--discover", "with --all: look again for repos with savings from before graft kept the list, in the folders your agents (Claude Code, Kilo, VS Code/Cursor/Windsurf, JetBrains, Codex) have worked in (done automatically the first time)")
  .option("--no-discover", "with --all: read only the folders already listed; never look for others")
  .option("--json", "output the rolled-up savings as JSON")
  .addHelpText(
    "after",
    // Under graft, these examples and the pricing note are part of the command's entry.
    !TRAIL ? "" : [
      "",
      "Examples:",
      "  graft savings              every day on record, per model and in total",
      "  graft savings 2026         that year",
      "  graft savings 2026-09      that month",
      "  graft savings 2026-09-08   that day",
      "  graft savings --all        every repo graft has been used in, added up",
      "  graft savings --all 2026   the same, for one period",
      "",
      "Dollars appear per model wherever a rate is known — this repo's own billing when",
      "the host reports it, else the model's list price. A model with no price at all is",
      "reported in saved input tokens alone, never at a guessed rate.",
      "",
      "Each repo's savings stay in that repo (graft/.cache/savings.json); --all reads the",
      "folders listed in ~/.graft/repos.json, which graft notes the first time it records",
      "a saving in a repo (or `graft savings` is run there). Each repo keeps its own rate.",
      "The first --all also looks through the folders your agents have worked in (Claude",
      "Code, Kilo, VS Code/Cursor/Windsurf, JetBrains, Codex) for savings recorded before",
      "the list existed; `graft savings --all --discover` looks again.",
    ].join("\n"),
  )
  .action((periodArg: string | undefined, dirArg: string | undefined, opts: { json?: boolean; all?: boolean; discover?: boolean }) => {
    // A lone argument is a period when it looks like a date and the repo
    // otherwise — `graft savings ../api` must not be read as a malformed date,
    // and `graft savings 2026-13` must not be read as a directory.
    let period = periodArg;
    let dirName = dirArg;
    if (period !== undefined && !isPeriod(period)) {
      if (dirName !== undefined || /^[\d-]+$/.test(period)) {
        console.error(`✗ not a period: ${period} — expected yyyy, yyyy-mm or yyyy-mm-dd`);
        process.exit(1);
      }
      dirName = period;
      period = undefined;
    }
    if (opts.all) {
      if (dirName !== undefined) {
        console.error(`✗ --all reads every registered repo — drop the directory (${dirName})`);
        process.exit(1);
      }
      // Fold in the repo we're standing in, in case its ledger predates the
      // registry. No walk-up message: --all is not answering for this folder.
      const here = nearestGraftRoot(process.cwd(), program.opts<GlobalOpts>().dir).root;
      registerExistingLedger(here);
      // Repos where graft recorded savings before the registry existed are
      // found through the agent hosts' own lists of the folders they have
      // worked in. Once is enough: every saving since registers its repo
      // itself. `--discover` scans again; `--no-discover` never scans.
      const registryFile = repoRegistryPath();
      const scan = opts.discover === true || (opts.discover !== false && !readRepoRegistry(registryFile).discoveredAt);
      if (scan) {
        const added = registerDiscovered(knownFolders().map((f) => f.path), { file: registryFile });
        if (added.length > 0 && !opts.json) {
          console.error(`${tag()} found savings from before this version in ${added.length} more repo${added.length === 1 ? "" : "s"} (from your agents' recent folders)`);
        }
      }
      const all = aggregateAllSavings(period, registryFile);
      if (opts.json) {
        console.log(JSON.stringify(all, null, 2));
        return;
      }
      console.log(formatAllSavingsReport(all));
      return;
    }
    // Local ledger JSON only — no graph, no network, same as `graft stats`.
    const dir = queryRoot(dirName);
    // A repo used before cross-repo totals existed joins `graft savings --all`
    // the first time anyone looks at its savings.
    registerExistingLedger(dir);
    const report = aggregateSavings(readLedger(dir), period);
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(formatSavingsReport(report));
  });

program
  .command("viz", { hidden: TRAIL })
  .description("Serve an interactive visualization of the context graph (and graph.json when present)")
  .argument(...DIR_ARG)
  .option("-p, --port <port>", "port to serve on", "4400")
  .option("--no-open", "don't open the browser")
  .option("--export <dir>", "write one self-contained index.html instead of serving (for CI, GitHub Pages, or a build artifact)")
  .option("--title <text>", "subtitle shown beside the repo name in an exported page (e.g. \"PR #151\")")
  .option("--tabs <list>", "tabs the exported page offers, comma separated: context,code,outline (default: all three)")
  .action(async (dirArg: string | undefined, opts: { port: string; open: boolean; export?: string; title?: string; tabs?: string }) => {
    // Flags are checked before the repository is: a typo'd `--tabs` is a mistake
    // in the command the caller just typed, and telling them to go build an index
    // first sends them off to fix the wrong thing.
    const tabs = parseTabs(opts.tabs);
    const dir = noteQuery(queryRoot(dirArg));
    const { existsSync } = await import("node:fs");
    const { resolve, basename } = await import("node:path");
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { contextDirFor } = await import("./context/node-file.js");
    const { startVizServer } = await import("./viz/serve.js");

    const root = resolve(dir);
    const globalOpts = program.opts<{ dir?: string }>();
    const contextDir = contextDirFor(root, globalOpts.dir);
    if (!existsSync(contextDir)) {
      console.error(`✗ no context graph at ${contextDir} — run \`${cmd("graft build --deep")}\` first`);
      process.exit(1);
    }
    const viewerDir = fileURLToPath(new URL("./viewer/", import.meta.url)); // prebuilt

    if (opts.export) {
      const { exportViz } = await import("./viz/export.js");
      const out = exportViz({
        contextDir,
        viewerDir,
        outDir: resolve(opts.export),
        repoName: basename(root),
        subtitle: opts.title,
        tabs,
      });
      const kb = Math.round(out.bytes / 1024);
      console.log(
        `${cmd("graft viz")} → ${out.file} (${kb} kB, ${out.contextNodes} concept nodes, ${out.codeNodes} code nodes)`,
      );
      return;
    }

    const srv = await startVizServer({
      contextDir,
      viewerDir,
      port: Number(opts.port),
      repoName: basename(root),
    });
    console.log(`${cmd("graft viz")} → ${srv.url}  (ctrl-c to stop)`);
    if (opts.open) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawn(opener, [srv.url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
    }
  });

program
  .command("mcp", { hidden: TRAIL })
  .description("Serve the graph over MCP (stdio) — exposes graft_find_code, graft_trace_calls, graft_find_all, graft_file_api, graft_repo_map and graft_check_freshness as tools")
  .argument(...DIR_ARG)
  .action(async (dirArg: string | undefined) => {
    const dir = noteQuery(queryRoot(dirArg));
    const { startMcpServer } = await import("./mcp/server.js");
    const globalOpts = program.opts<{ dir?: string }>();
    startMcpServer(dir, globalOpts.dir, currentVersion);
  });

grouped(program.command("callers"), GROUP.find)
  .description(
    "Who calls/references a symbol ($0, no LLM). --direction out gives callees (what it calls); --depth N (or all) walks transitively for full blast radius",
  )
  .argument("<symbol>", "bare name, qualified (Class.method), or package-qualified (pkg.Fn)")
  .argument(...DIR_ARG)
  .option("--direction <in|out>", 'edge direction: "in" = callers (default), "out" = callees')
  .option("-d, --depth <n>", 'walk transitively up to N hops for blast radius, or "all" for the full connected closure (default 1)')
  .option("--in <path>", "narrow matches to nodes at or under this path prefix")
  .option("--json", "output as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(
    async (
      symbol: string,
      dirArg: string | undefined,
      opts: { direction?: string; depth?: string; in?: string; json?: boolean; refresh?: boolean },
    ) => {
      const dir = noteQuery(queryRoot(dirArg));
      await refreshBefore(dir, opts);
      const globalOpts = program.opts<{ dir?: string }>();
      if (!opts.json && readWorkspace(dir, globalOpts.dir)) {
        runWorkspaceCallers(dir, globalOpts.dir, symbol, {
          direction: opts.direction === "out" ? "out" : "in",
          depth: opts.depth
            ? (/^(all|full|max)$/i.test(opts.depth) ? Number.POSITIVE_INFINITY : Number(opts.depth))
            : undefined,
          in: opts.in,
        });
        return;
      }
      const { runCallersCommand } = await import("./graph/traverse-cli.js");
      runCallersCommand(symbol, dir, {
        direction: opts.direction,
        depth: opts.depth,
        in: opts.in,
        json: opts.json,
        globalDir: globalOpts.dir,
      });
    },
  );

grouped(program.command("blast"), GROUP.ci)
  .description(
    "Blast radius of a diff: what depends on the lines this change touched ($0, no LLM). " +
      "Built for CI — `--format markdown` is a PR comment with a Mermaid diagram.",
  )
  .argument(...DIR_ARG)
  .option("--base <ref>", "diff against this ref's merge base with HEAD (e.g. origin/main); default: the working tree vs HEAD")
  .option("-d, --depth <n>", 'hops to walk over incoming edges, or "all" for the full closure (default 2)')
  .option("--format <fmt>", "text (default) | markdown | mermaid | json")
  .option("--name", "name the affected areas with one cached LLM call (needs GRAFT_API_KEY); without it, areas are named after their hub symbol")
  .option("--export-viz <dir>", "also write the interactive page for this radius (one self-contained index.html — for CI, GitHub Pages, or an artifact)")
  .option("--title <text>", "subtitle beside the repo name on the exported page (e.g. \"PR #171\")")
  .option("--no-owners", "do not suggest who to tag (by default, git history names the people behind each affected area)")
  .option("--pr-author <who...>", "GitHub login, git name or email of the PR author, so they are left out of their own suggestions")
  .option(...NO_REFRESH_FLAG)
  .action(async (dirArg: string | undefined, opts: { base?: string; depth?: string; format?: string; name?: boolean; exportViz?: string; title?: string; owners?: boolean; prAuthor?: string[]; refresh?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    await refreshBefore(dir, opts);
    const { runBlastCommand } = await import("./blast/blast-cli.js");
    await runBlastCommand(dir, {
      base: opts.base,
      depth: opts.depth,
      format: opts.format,
      name: opts.name,
      exportViz: opts.exportViz,
      title: opts.title,
      owners: opts.owners,
      prAuthor: opts.prAuthor,
      globalDir: program.opts<GlobalOpts>().dir,
    });
  });

grouped(program.command("grep"), GROUP.find)
  .description("Regex search over indexed files, hits grouped by enclosing symbol and ranked by coupling ($0, no LLM)")
  .argument("<pattern>", "regex pattern (or literal string with --fixed)")
  .argument(...DIR_ARG)
  .option("-i, --ignore-case", "case-insensitive match")
  .option("--fixed", "treat pattern as a literal string, not a regex")
  .option("--in <path>", "narrow to files at or under this path prefix")
  .option("--json", "output as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(
    async (
      pattern: string,
      dirArg: string | undefined,
      opts: { ignoreCase?: boolean; fixed?: boolean; in?: string; json?: boolean; refresh?: boolean },
    ) => {
      const dir = noteQuery(queryRoot(dirArg));
      await refreshBefore(dir, opts);
      const globalOpts = program.opts<{ dir?: string }>();
      if (readWorkspace(dir, globalOpts.dir)) {
        runWorkspaceGrep(dir, globalOpts.dir, pattern, {
          ignoreCase: opts.ignoreCase, fixed: opts.fixed, json: opts.json,
        });
        return;
      }
      const { runGrepCommand } = await import("./search/grep-cli.js");
      runGrepCommand(pattern, dir, {
        ignoreCase: opts.ignoreCase,
        fixed: opts.fixed,
        in: opts.in,
        json: opts.json,
        globalDir: globalOpts.dir,
      });
    },
  );

grouped(program.command("map"), GROUP.find)
  .description(
    "Token-budgeted repo orientation — directory clusters, per-directory hubs, and global hotspots from the wiring graph ($0, no LLM)",
  )
  .argument(...DIR_ARG)
  .option("--max-dirs <n>", "max directory entries shown, rest counted into dropped (default 16)")
  .option("--json", "output as JSON")
  .option(...NO_REFRESH_FLAG)
  .action(async (dirArg: string | undefined, opts: { json?: boolean; maxDirs?: string; refresh?: boolean }) => {
    const dir = noteQuery(queryRoot(dirArg));
    const root = resolve(dir);
    const globalOpts = program.opts<{ dir?: string }>();
    let maxDirsW: number | undefined;
    if (opts.maxDirs !== undefined) {
      const n = parseInt(opts.maxDirs, 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`✗ --max-dirs must be a positive integer, got "${opts.maxDirs}"`);
        process.exit(1);
        return;
      }
      maxDirsW = n;
    }
    await refreshBefore(dir, opts); // after arg validation: a bad flag shouldn't cost a rebuild
    if (!opts.json && readWorkspace(root, globalOpts.dir)) {
      runWorkspaceMap(root, globalOpts.dir, { maxDirs: maxDirsW });
      return;
    }
    const { buildRepoMap, formatRepoMap } = await import("./graph/map.js");
    const contextDir = contextDirFor(root, globalOpts.dir);
    const graph = loadGraphCached(contextDir);
    if (!graph) {
      console.error(`✗ no graph — run ${cmd("graft build")} first`);
      process.exit(1);
      return;
    }
    const map = buildRepoMap(graph, { maxDirs: maxDirsW });
    if (opts.json) {
      console.log(JSON.stringify(map, null, 2));
      return;
    }
    process.stdout.write(formatRepoMap(map));
  });

grouped(program.command("languages"), GROUP.setup)
  .description(
    "List every programming language graft indexes and its level of support on this install (full, broad, symbols, structural, …), " +
      "with what each level extracts ($0, no repo needed)",
  )
  .option("--json", "output the languages as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { formatLanguageSupport, languageSupport } = await import("./graph/languages.js");
    const rows = languageSupport(readPackageName(import.meta.url));
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    process.stdout.write(formatLanguageSupport(rows, brand()));
  });

// `trail note`: what a session worked out, saved for the next person. Listed
// under trail; under graft it still runs, unlisted, for a teammate on graft in
// a repo where someone else set up trail.
grouped(program.command("note", { hidden: !TRAIL }), GROUP.memory)
  .description("Save what this session decided, tried and ruled out, as a learning in the repo's .trail/learnings/ (the text on stdin)")
  .requiredOption("--title <text>", "what the session was about, in a few words")
  .option("-m, --body <text>", "the learning itself, instead of stdin")
  .option("--personal", "about your own setup or habits, not the code: keep it in ~/.trail, out of the repo")
  .option("--touches <list>", "comma-separated files or file#Symbol it's about (default: the files this session changed, in every repo it changed)")
  .option("--author <name>", "who wrote it (default: the first word of git config user.name)")
  .option("--minutes <n>", "what it took to work out, when the agent's transcript can't say")
  .option("--tokens <n>", "the same, in tokens")
  .option("--json", "print the saved learning as JSON")
  .argument("[dir]", "repository root", ".")
  .action(async (dir: string, opts: NoteOptions) => {
    await runNoteCommand(resolve(dir), opts);
  });

// `trail learn` and `trail skills`: corrections become takeaways on a skill,
// kept on this machine, and takeaways fold into its SKILL.md. Unlisted under
// graft, like `note`, but they run.
// Still runs; unlisted while learnings are the one thing trail keeps.
grouped(program.command("learn", { hidden: true }), GROUP.memory)
  .description("Turn a correction into a takeaway on a skill, kept in ~/.trail (the takeaway on stdin)")
  .argument("<skill>", "the skill it belongs to, e.g. pdf-coords; a new name makes a new skill")
  .argument("[dir]", "repository root", ".")
  .option("-m, --text <text>", "the takeaway itself, instead of stdin")
  .option("--description <text>", "for a new skill: what it covers")
  .option("--section <heading>", "the SKILL.md heading it belongs under when folded")
  .option("--author <name>", "who taught it (default: the first word of git config user.name)")
  .action(async (skill: string, dir: string, opts: { text?: string; description?: string; section?: string; author?: string }) => {
    const repo = resolve(dir);
    const text = (opts.text ?? (await readStdin())).trim();
    if (!text) {
      console.error(`✗ a takeaway needs its text, on stdin or with -m:`);
      console.error(`  ${cmd("graft learn")} ${skill} <<'EOF'\n  Read rotation with page.Rotation(), never pdfcpu: it drops /Rotate on linearized files.\n  EOF`);
      process.exitCode = 1;
      return;
    }
    const author = opts.author?.trim() || noteAuthor(repo);
    let r: LearnResult;
    try {
      r = learn(repo, { skill, text, author, date: new Date().toISOString().slice(0, 10), description: opts.description, section: opts.section });
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    track("takeaway_saved", { new_skill: String(r.created) }, { repo });
    const kind = r.created ? "new skill" : r.skill.where === "repo" ? "the repo's skill" : "skill";
    console.log(`✓ takeaway saved to ${kind} ${r.skill.name}${author ? ` · taught by ${author}` : ""}`);
    console.log(`· your agent follows it from now on · kept on this machine, in ${shownPath(dirname(dirname(r.takeaway.path)))}`);
    console.log(`· ${cmd("graft skills")} fold ${r.skill.name} writes it into SKILL.md`);
  });

const skillsCmd = grouped(program.command("skills", { hidden: true }), GROUP.memory)
  .description("List this repo's skills, and the takeaways waiting to fold into each")
  .argument("[dir]", "repository root", ".")
  .option("--json", "output as JSON")
  .action((dir: string, opts: { json?: boolean }) => {
    const repo = resolve(dir);
    const all = listSkills(repo);
    if (opts.json) {
      console.log(JSON.stringify(all, null, 2));
      return;
    }
    if (all.length === 0) {
      console.log(`no skills yet · ${cmd("graft learn")} <skill> saves the first takeaway and makes the skill`);
      return;
    }
    const width = Math.max(...all.map((s) => s.name.length)) + 2;
    for (const s of all) console.log(`${s.name.padEnd(width)}${skillStatus(s)}`);
  });

/** `✗ no skill called x` and the exit code, for a name that isn't one. */
function noSuchSkill(name: string): void {
  console.error(`✗ no skill called ${skillName(name)} · ${cmd("graft skills")} lists them`);
  process.exitCode = 1;
}

skillsCmd
  .command("show")
  .description("Print a skill with every takeaway not yet folded in: what an agent reads before working in its area")
  .argument("<skill>", "the skill")
  .option("-C, --dir <path>", "repository root", ".")
  .action((skill: string, opts: { dir: string }) => {
    const s = getSkill(resolve(opts.dir), skill);
    if (!s) return noSuchSkill(skill);
    process.stdout.write(skillForAgent(s));
  });

skillsCmd
  .command("fold")
  .description("Write a skill's waiting takeaways into its SKILL.md and bump its version")
  .argument("[skill]", "one skill; leave out to fold every skill with takeaways waiting")
  .option("--confirmed", "only the takeaways someone other than their teacher confirmed")
  .option("-C, --dir <path>", "repository root", ".")
  .action((skill: string | undefined, opts: { confirmed?: boolean; dir: string }) => {
    const repo = resolve(opts.dir);
    if (skill && !getSkill(repo, skill)) return noSuchSkill(skill);
    const names = skill ? [skill] : listSkills(repo).map((s) => s.name);
    let inRepo = false;
    let any = false;
    for (const n of names) {
      const r = fold(repo, n, { confirmed: opts.confirmed });
      if (!r) continue;
      if (r.folded.length === 0) {
        if (skill) console.log(`· ${r.skill} v${r.from} · nothing to fold${r.stillWaiting ? `, ${r.stillWaiting} waiting for a second person` : ""}`);
        continue;
      }
      any = true;
      inRepo ||= r.where === "repo";
      track("skills_folded", { takeaways_bucket: countBucket(r.folded.length) }, { repo });
      console.log(`✓ ${r.skill} v${r.from} → v${r.to} · folded ${r.folded.length} takeaway${r.folded.length === 1 ? "" : "s"}${r.stillWaiting ? `, ${r.stillWaiting} still waiting` : ""}`);
      console.log(`  M ${r.where === "repo" ? shown(repo, r.file) : shownPath(r.file)}   ${r.sections.map((h) => `+ ${h}`).join(" ")}`);
    }
    if (!any) {
      if (!skill) console.log("· nothing to fold");
      return;
    }
    if (inRepo) console.log("· review with git diff, then commit");
    else console.log(`· ${cmd("graft skills")} publish <skill> moves a skill into the repo's .claude/skills/, to commit for your team`);
  });

skillsCmd
  .command("publish")
  .description("Move a skill kept on this machine into the repo's .claude/skills/, ready to commit")
  .argument("<skill>", "the skill")
  .option("-C, --dir <path>", "repository root", ".")
  .action((skill: string, opts: { dir: string }) => {
    const repo = resolve(opts.dir);
    const r = publish(repo, skill);
    if (!r.ok) {
      if (r.reason === "unknown") return noSuchSkill(skill);
      console.log(`· ${skillName(skill)} is already in the repo, in .claude/skills/${skillName(skill)}/`);
      return;
    }
    console.log(`✓ ${skillName(skill)} → ${shown(repo, r.file)}`);
    console.log("· commit it to share it: Claude Code loads it for everyone who pulls. its takeaways stay on this machine");
  });

skillsCmd
  .command("confirm")
  .description("Say a teammate's takeaway is right, so `fold --confirmed` takes it")
  .argument("<skill>", "the skill")
  .argument("[takeaway]", "one takeaway file (default: every one waiting that someone else taught)")
  .option("--author <name>", "who is confirming (default: the first word of git config user.name)")
  .option("-C, --dir <path>", "repository root", ".")
  .action((skill: string, takeaway: string | undefined, opts: { author?: string; dir: string }) => {
    const repo = resolve(opts.dir);
    if (!getSkill(repo, skill)) return noSuchSkill(skill);
    const who = opts.author?.trim() || noteAuthor(repo);
    const done = confirm(repo, skill, who, takeaway);
    if (done.length === 0) {
      console.log(`· nothing to confirm on ${skillName(skill)} — a takeaway needs someone other than its teacher`);
      return;
    }
    for (const t of done) console.log(`✓ confirmed ${t.taughtBy || "a"}'s takeaway from ${shortDate(t.date)} · ${shownPath(t.path)}`);
    console.log(`· ${cmd("graft skills")} fold ${skillName(skill)} writes it into SKILL.md`);
  });

grouped(program.command("init"), GROUP.setup)
  .description(
    TRAIL
      ? "Wire trail into your agents: instruction files and MCP for each, plus hooks and a statusline for Claude Code"
      : "Wire Graft into the AI coding agents used with this repo (instruction files + MCP server; full hooks + statusline + MCP for Claude Code)",
  )
  .argument("[dir]", "target repo directory", ".")
  .option("--no-build", "skip building the graph (wire files only)")
  .option("--agents <ids...>", `only these agents (${hostIds().join(", ")}, claude)`)
  .option("--all-agents", "write instruction files for every known agent, detected or not")
  .option("--no-agents", "Claude Code wiring only; skip other agents")
  .option("--list-agents", "list known agent ids and exit")
  .option("--no-mcp", "skip MCP server registration for other agents")
  .option("--no-hooks", "skip hook installation for other agents")
  .option("--no-statusline", "skip writing Claude Code statusLine (keep a user-defined one)")
  .option("--dry-run", "print every file init would touch, then exit without writing")
  .option("-y, --yes", "skip the picker and wire every detected agent (the pre-0.8 default)")
  .option("--no-global", "skip writes outside this repo (the ~/.codex/ config + hooks)")
  .option("--workspace <file>", "wire the folders of this VS Code .code-workspace file (default: the one in [dir], asking when there are several)")
  .option("--no-workspace", "ignore .code-workspace files and wire [dir] itself")
  .option("--verbose", "print every file written, the graph build's own output and the closing banner")
  .action(async (dir: string, opts: InitOptions) => {
    await runInitCommand(dir, opts);
  });

/** Everything on stdin, or "" when nothing is piped in. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}

interface NoteOptions {
  title: string;
  body?: string;
  touches?: string;
  author?: string;
  minutes?: string;
  tokens?: string;
  json?: boolean;
  personal?: boolean;
}

async function runNoteCommand(repo: string, opts: NoteOptions): Promise<void> {
  const body = (opts.body ?? (await readStdin())).trim();
  if (!opts.title.trim() || !body) {
    console.error(`✗ a learning needs a --title and a body, on stdin or with -m:`);
    console.error(`  ${cmd("graft note")} --title "What it was about" <<'EOF'`);
    console.error("  ## Decided\n  …\n  ## Tried and ruled out\n  …\n  ## Watch out\n  …\n  EOF");
    process.exitCode = 1;
    return;
  }
  const wholeNumber = (raw: string | undefined, flag: string): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      console.error(`✗ ${flag} takes a number, got "${raw}"`);
      process.exit(1);
    }
    return Math.round(n);
  };
  const minutes = wholeNumber(opts.minutes, "--minutes");
  const tokens = wholeNumber(opts.tokens, "--tokens");
  // What the session spent, from the agent's own transcript when there is one,
  // counted from where the work the note names first came up; the flags win,
  // since only the agent knows for sure where its task began.
  const named = [...(opts.touches?.split(",").map((t) => t.trim()).filter(Boolean) ?? []), ...mentionedFiles(repo, body)];
  const spent = currentSessionCost(repo, undefined, Date.now(), aboutTerms(body, named));
  const cost =
    minutes !== undefined || tokens !== undefined || spent
      ? { minutes: minutes ?? spent?.minutes, tokens: tokens ?? spent?.tokens }
      : undefined;
  // Which repos it goes to: the one it was saved from, plus any other the
  // session edited. Explicit --touches means just this repo.
  const targets = opts.touches
    ? [{ dir: repo, touches: opts.touches.split(",").map((t) => t.trim()).filter(Boolean) }]
    : noteTargets(repo, spent?.edited ?? [], spent?.startedAt).map((t) => ({
        ...t,
        // And the files the note names, for a session that read code without editing it.
        touches: [...new Set([...t.touches, ...mentionedFiles(t.dir, body)])].slice(0, 10),
      }));
  const author = opts.author?.trim() || noteAuthor(repo);
  const date = new Date().toISOString().slice(0, 10);
  const scope = opts.personal ? "personal" : "repo";
  const earlier: Note[] = [];
  const saved: Note[] = [];
  for (const t of targets) {
    earlier.push(...listNotes(t.dir));
    saved.push(writeNote(t.dir, { title: opts.title, body, author, date, branch: currentBranch(t.dir), cost, touches: t.touches }, scope));
  }
  const touches = targets.flatMap((t) => t.touches);
  track(
    "note_saved",
    { has_cost: String(cost?.tokens !== undefined || cost?.minutes !== undefined), touches_bucket: countBucket(touches.length), scope: saved[0]?.scope ?? scope },
    { repo },
  );

  if (opts.json) {
    console.log(JSON.stringify(saved.length === 1 ? saved[0] : saved, null, 2));
    return;
  }
  for (const n of saved) console.log(`✓ ${n.scope === "personal" ? "saved just for you" : "saved for your team"} · ${notePlace(n)}`);
  const note = saved[0]!;
  // Name a code file if the note touches one; docs are rarely what it's about.
  const about = touches.find((t) => !/\.(md|mdx|txt)$/i.test(t.split("#")[0]!)) ?? touches[0];
  const first = about ? ` that touches ${basename(about.split("#")[0]!)}` : "";
  const took = costLabel(note.cost);
  if (took && tokensWorthSaying(note.cost?.tokens)) {
    const reading = tokensLabel(readingTokens(note)).replace(" tokens", "");
    console.log(`· this ${took.replace(" to work out", " to figure out")}. the next session${first} gets it for ${reading}`);
  } else if (note.scope !== "personal") {
    console.log(`· the next session${first} starts from this, and gets to a PR ${PR_SPEEDUP}`);
  }
  // Learnings about the same files, from someone else: this one builds on theirs.
  const files = new Set(touches.map((t) => t.split("#")[0]));
  const prior = earlier.find((n) => n.author !== note.author && n.touches.some((t) => files.has(t.split("#")[0])));
  if (prior) console.log(`· builds on ${prior.author ? `${prior.author}'s` : "a"} learning from ${shortDate(prior.date)}`);
  if (!SECTIONS.some((s) => sectionLead(body, s.heading) !== null))
    console.log("· tip: learnings read best under ## Decided, ## Tried and ruled out and ## Watch out");
  const repoSaved = saved.filter((n) => n.scope === "repo");
  if (repoSaved.length) {
    // Who else works on these files, for the case for committing it.
    const lines = commitLines(note, teammatesOn(repo, [...files].filter((f): f is string => !!f)));
    console.log(`${lines.uncommitted} · git add ${repoSaved.map(notePlace).join(" ")}`);
    if (!process.stdout.isTTY && TRAIL)
      console.log(
        `[trail] Close your reply with one line, word for word. If this learning is committed by the end of your turn: ${lines.committed}\n` +
          `  If it isn't: ${lines.uncommitted}`,
      );
  } else {
    console.log("· just for you: kept on this machine, out of the repo");
    if (!process.stdout.isTTY && TRAIL) console.log(`[trail] Close your reply with this line, word for word: ${PERSONAL_SAVED_LINE}`);
  }
  for (const t of targets) {
    rememberRepo(t.dir);
    maybeSyncInBackground(t.dir);
  }
  printLines(cloudLines(repo, { command: "note" }));
}

/** Lines that close a command's output, with a blank line before them. */
function printLines(lines: string[]): void {
  if (lines.length) console.log(`\n${lines.join("\n")}`);
}

/** `graft init`'s flags, as commander hands them over. */
interface InitOptions { build?: boolean; agents?: string[]; allAgents?: boolean; listAgents?: boolean; mcp?: boolean; hooks?: boolean; statusline?: boolean; dryRun?: boolean; yes?: boolean; global?: boolean; verbose?: boolean; workspace?: string | false }

/**
 * Which VS Code workspace `init` wires, if any: `--workspace <file>`, else the
 * only `.code-workspace` in `repo`, else — with several — the user's pick on a
 * terminal. `null` means none (wire `repo` itself, as before); `undefined`
 * means the user cancelled. Exits on an unusable `--workspace` file.
 */
async function chooseCodeWorkspace(
  repo: string,
  opts: InitOptions,
): Promise<{ file: string; folders: string[] } | null | undefined> {
  if (opts.workspace === false) return null;
  let file: string | null;
  if (typeof opts.workspace === "string") {
    file = resolve(repo, opts.workspace);
    if (!existsSync(file)) {
      console.error(`✗ --workspace: ${file} not found`);
      process.exit(1);
    }
  } else {
    const found = findCodeWorkspaces(repo);
    if (found.length === 0) return null;
    // Even a single workspace is asked about: wiring its folders instead of
    // this directory is a different outcome, so it's never assumed.
    if (process.stdin.isTTY && process.stderr.isTTY && !opts.yes) {
      const picked = await promptCodeWorkspace(describeCodeWorkspaces(found), repo);
      if (picked === undefined) return undefined;
      file = picked;
    } else {
      const what = found.length === 1 ? "a VS Code workspace" : `${found.length} VS Code workspaces`;
      console.error(
        `· found ${what} here (${found.map((f) => basename(f)).join(", ")}) — wiring this folder itself; pass --workspace <file> to wire its folders`,
      );
      return null;
    }
  }
  if (file === null) return null;

  let read;
  try {
    read = readCodeWorkspaceFolders(file);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (typeof opts.workspace === "string") {
      console.error(`✗ --workspace: can't read ${file} (${why})`);
      process.exit(1);
    }
    console.error(`⚠ can't read ${basename(file)} (${why}) — wiring this folder itself`);
    return null;
  }
  for (const m of read.missing) console.error(`⚠ ${basename(file)}: folder ${m} not found — skipped`);
  for (const u of read.unsupported) console.error(`⚠ ${basename(file)}: ${u} is not a local folder — skipped`);
  if (read.folders.length === 0) {
    if (typeof opts.workspace === "string") {
      console.error(`✗ --workspace: ${file} lists no existing folders`);
      process.exit(1);
    }
    console.error(`⚠ ${basename(file)} lists no existing folders — wiring this folder itself`);
    return null;
  }
  return { file, folders: read.folders };
}

/** Repo-relative with forward slashes, for printing. */
function shown(repo: string, path: string): string {
  return relative(repo, path).split("\\").join("/");
}

/** `graft init`. */
async function runInitCommand(dir: string, opts: InitOptions): Promise<{ ids: string[] } | null> {
    if (opts.listAgents) {
      for (const id of [...hostIds(), "claude"]) console.log(id);
      return null;
    }
    const repo = resolve(dir);
    const explicit = Array.isArray(opts.agents) ? opts.agents : undefined;

    if (explicit) {
      const validIds = [...hostIds(), "claude"];
      const unknown = explicit.filter((id) => !validIds.includes(id));
      if (unknown.length) {
        console.error(`✗ unknown agent id(s): ${unknown.join(", ")} — valid: ${validIds.join(", ")}`);
        process.exit(1);
      }
    }

    // A VS Code workspace file here means its folders are what agents open as
    // roots, so they — not this directory — get the wiring and the graphs.
    const codeWs = await chooseCodeWorkspace(repo, opts);
    if (codeWs === undefined) {
      console.error("· cancelled — nothing written");
      return null;
    }

    // Which agents to wire, decided before anything is written. Explicit flags
    // win; otherwise prompt on a TTY, and on a pipe write nothing rather than
    // guessing (pre-0.8 this silently wired every agent the machine had ever
    // installed — see --yes to get that back).
    const home = homedir();
    const plan = planInit(repo, { home });
    const detectedIds = plan.filter((p) => p.detected).map((p) => p.id);
    const noAgents = (opts as { agents?: unknown }).agents === false;

    let ids: string[];
    // The consent answer from the picker. Undefined everywhere else — a scripted
    // or flag-driven init never asked, so it must not silently answer.
    let consent: boolean | undefined;
    if (explicit) ids = explicit;
    else if (opts.allAgents) ids = plan.map((p) => p.id);
    else if (noAgents) ids = ["claude"];
    else if (opts.yes || opts.dryRun) ids = detectedIds;
    else if (process.stdin.isTTY && process.stderr.isTTY) {
      // The consent row is only offered when telemetry could run, which it never
      // can now (permanently off), so the picker shows agents only.
      const reason = offReason();
      const picked = await runPicker(plan, repo, home, {
        offerTelemetry: reason === null || userCanEnable(reason),
        telemetryChecked: reason === null,
      });
      if (picked === null) {
        console.error("· cancelled — nothing written");
        return null;
      }
      ids = picked.hosts;
      consent = picked.telemetry;
    } else {
      console.error(formatNonInteractiveHelp(detectedIds));
      return null;
    }

    // The picker's answer, recorded before anything is wired: a user who
    // unchecked the row must not have this run's init_completed sent.
    if (consent !== undefined) {
      patchState({ enabled: consent, noticeShownAt: new Date().toISOString() });
    }

    // Workspace parent: every child repo gets its OWN wiring too. A session
    // opens at a repo root, not at the parent, and reads `.claude/` from there —
    // wiring only the parent leaves each child with no skill, hooks, or MCP.
    // The parent's own wiring stays (queries there federate across children).
    // With a VS Code workspace, each of its folders is such a root in turn.
    const globalDir = program.opts<GlobalOpts>().dir;
    const roots = codeWs ? codeWs.folders : [repo];
    const overrideFor = (root: string) => (root === repo ? globalDir : undefined);
    const childrenOf = new Map<string, string[]>(
      roots.map((root) => [root, isWorkspaceBuildRoot(root, overrideFor(root)) ? discoverWorkspaceChildren(root) : []]),
    );
    const children = childrenOf.get(repo) ?? [];
    // Each root FIRST: its build is the workspace build, which builds every child's
    // graph, so each child's own `buildGraphIfMissing` then finds one and no-ops.
    const targets = [
      ...new Map(
        roots
          .flatMap((root) => [root, ...childrenOf.get(root)!.map((c) => join(root, c))])
          .map((t) => [process.platform === "win32" ? t.toLowerCase() : t, t] as const),
      ).values(),
    ];
    const label = (target: string) => relative(repo, target).split("\\").join("/") || ".";

    if (opts.dryRun) {
      if (codeWs) {
        console.error(`· VS Code workspace ${basename(codeWs.file)}: ${roots.length} folder(s) — ${roots.map(label).join(", ")}`);
        for (const target of targets) {
          console.error(`\n— ${label(target)}/\n` + formatPlan(planInit(target, { home }), ids, target, home));
          const cfg = missingBuildConfigPath(target);
          if (cfg) console.error(`\n  would write ${cfg} (repo build settings)`);
        }
        return null;
      }
      console.error(formatPlan(plan, ids, repo, home));
      // wireTarget scaffolds this before touching any agent, so a dry run that
      // listed only agent files would under-report what init writes.
      for (const target of targets) {
        const cfg = missingBuildConfigPath(target);
        if (cfg) console.error(`\n  would write ${cfg} (repo build settings)`);
      }
      for (const child of children)
        console.error(`\n— ${child}/ (workspace child)\n` + formatPlan(planInit(join(repo, child), { home }), ids, join(repo, child), home));
      return null;
    }
    if (ids.length === 0) {
      console.error("· no agents selected — nothing written");
      return null;
    }

    const wantClaude = ids.includes("claude");
    const cliPath = fileURLToPath(import.meta.url);

    // Under trail, each repo gets its `.trail/learnings/`, committed with the
    // code, and its folder in ~/.trail for personal learnings and corrections.
    // First, before the reads below send their first event: that makes the
    // repo one on trail, so the event's repo id lands in `.trail/cache/` and
    // not in a `graft/` that nothing ignores.
    const notesHome = new Map<string, { created: boolean; dir: string }>();
    if (TRAIL)
      for (const target of targets) {
        const { place } = ensureRepoHome(target);
        const created = place.git ? ensureRepoTrail(place.checkout) : false;
        notesHome.set(target, { created, dir: place.git ? place.checkout : place.dir });
        if (place.git) maybeRefreshBranches(place.checkout);
      }

    // Under trail, with Claude Code picked: what the person kept telling Claude
    // in this repo's past sessions, and what reviewers kept flagging on its
    // merged PRs, read while the rest of init runs and saved as learnings at
    // the end. Once per repo, and never asked about first.
    const pastRead = TRAIL && wantClaude ? beginPastRead(repo) : null;
    if (pastRead) console.error(`· reading your ${pastRead.sessions} past Claude sessions here for what you keep telling Claude`);
    const reviewRead = TRAIL && wantClaude ? beginReviewRead(repo) : null;
    if (reviewRead) console.error("· reading review comments on this repo's merged PRs for what reviewers keep flagging");

    if (codeWs)
      console.error(`· VS Code workspace ${basename(codeWs.file)}: wiring ${roots.length} folder(s) — ${roots.map(label).join(", ")}`);
    for (const root of roots) {
      const kids = childrenOf.get(root)!;
      if (kids.length) console.error(`· workspace: wiring ${root} and ${kids.length} child repo(s) — ${kids.join(", ")}`);
    }

    // Today's output, file by file, behind --verbose. Everything else gets one
    // line per step: the graph, then one per agent.
    const verbose = opts.verbose === true;
    const reports: WireReport[] = [];
    for (const target of targets) {
      if (verbose && (target !== repo || codeWs)) console.error(`\n— ${label(target)}/`);
      reports.push(wireTarget(target, ids, { home, cliPath, plan, opts, wantClaude, quiet: !verbose }));
    }

    // The graph, built once per root after the wiring: a workspace parent's
    // build is the workspace build, so it covers every child.
    const graphLines: string[] = [];
    if (!verbose) {
      for (const root of roots) {
        const kids = childrenOf.get(root)!;
        const where = codeWs ? ` · ${label(root)}` : "";
        const res = await buildGraphWithProgress(root, { build: opts.build, cliPath });
        for (const m of res.messages) console.error(m);
        const existing = res.built ? null : loadGraphCached(contextDirFor(root, kids.length ? undefined : overrideFor(root)));
        const fmt = (x: number) => x.toLocaleString("en-US");
        let graphLine: string;
        if (res.graph) {
          graphLine = `✓ graph built · ${fmt(res.graph.nodes)} nodes, ${fmt(res.graph.edges)} edges${res.graph.files ? ` from ${fmt(res.graph.files)} file${res.graph.files === 1 ? "" : "s"}` : ""}${where}`;
        } else if (res.built) {
          graphLine = `✓ graph built${where}`;
        } else if (res.failed) {
          graphLine = `⚠ the graph build failed${where} — run ${cmd("graft build")} to see why`;
        } else if (existing) {
          graphLine = `✓ graph ready · ${fmt(existing.meta.nodeCount)} nodes, ${fmt(existing.meta.edgeCount)} edges${where}`;
        } else if (hasGraftIndex(root)) {
          graphLine = `✓ graph ready${where}`;
        } else {
          graphLine = `· skipped the graph build${where} — run ${cmd("graft build")}`;
        }
        graphLines.push(graphLine);
      }
    }

    if (!verbose) {
      // Warnings and removals in full, whatever else is folded.
      const removed = [...new Set(reports.flatMap((r) => r.retracted))];
      for (const id of removed) console.error(`- removed ${id} — agent not selected`);
      for (const w of reports.flatMap((r) => r.warnings)) console.error(w);
      const writesFor = (id: string) =>
        (plan.find((p) => p.id === id)?.writes ?? []).filter((w) => opts.global !== false || w.scope !== "global");
      if (graphLines.length) console.error(graphLines.join("\n"));
      const width = Math.max(...ids.map((id) => id.length));
      for (const id of ids) {
        const summary = compactWrites(writesFor(id), repo, home);
        console.error(`✓ ${id.padEnd(width)}   ${summary}`.trimEnd());
      }
    }

    // Under trail: what init learned from past sessions and PR reviews, where
    // this repo's learnings are, and how many there already are.
    let learnedNow = false;
    if (TRAIL && (pastRead || reviewRead)) {
      if (pastRead && !pastRead.done) console.error("· still reading your past sessions…");
      const fromSessions = pastRead ? (await pastRead.result).findings : [];
      if (reviewRead && !reviewRead.done) console.error("· still reading PR reviews…");
      const fromReviews = reviewRead ? (await reviewRead.result).findings : [];
      // On a terminal, the person ticks which to keep in one list for both
      // sources, all ticked to start; a scripted run, or one with --yes, keeps
      // them all. Cancelling saves none, and the next init asks again.
      const picked =
        process.stdin.isTTY && process.stderr.isTTY && !opts.yes && fromSessions.length + fromReviews.length
          ? await pickLearnings([
              ...fromSessions.map((f) => ({ title: f.title, forTeam: f.for === "team", sessions: f.sessions.length })),
              ...fromReviews.map((f) => ({ title: f.title, forTeam: true, prs: f.prs.length })),
            ])
          : undefined;
      // The picked rows that are `found`'s, which start at `from` in the list.
      const keepFrom =
        <T>(from: number) =>
        picked === undefined
          ? undefined
          : async (found: T[]) => picked && picked.filter((i) => i >= from && i < from + found.length).map((i) => found[i - from]!);
      const learned: Note[] = [];
      if (pastRead) {
        const { result, saved, kept, cancelled } = await finishPastRead(repo, pastRead, keepFrom<Finding>(0));
        const offered = result.findings.length;
        if (saved.length) {
          const n = saved.length;
          const what = n < offered ? `kept ${n} of the ${offered} things` : `learned ${n} thing${n === 1 ? "" : "s"}`;
          console.error(`✓ ${what} you told Claude more than once, from your last ${result.read} sessions here`);
          // Each with how many sessions it was said in: saveFindings keeps the findings' order.
          saved.forEach((note, i) => {
            const said = kept[i]?.sessions.length ?? 0;
            const count = said > 1 ? `told Claude in ${said} sessions: ` : "";
            console.error(`    ${note.scope === "personal" ? "just for you " : "for your team"} · ${count}${note.title}`);
          });
        } else if (cancelled) {
          console.error(`· saved none of the ${offered} things you told Claude more than once; ${cmd("graft init")} again asks again`);
        } else if (offered) {
          console.error(`· kept none of the ${offered} things you told Claude more than once`);
        } else if (result.reason === "failed") {
          console.error(`· couldn't read your past sessions this time; ${cmd("graft init")} again tries again`);
        }
        learned.push(...saved);
      }
      if (reviewRead) {
        const { result, saved, kept, cancelled } = await finishReviewRead(repo, reviewRead, keepFrom<ReviewFinding>(fromSessions.length));
        const offered = result.findings.length;
        if (saved.length) {
          const n = saved.length;
          const what = n < offered ? `kept ${n} of the ${offered} things` : `learned ${n} thing${n === 1 ? "" : "s"}`;
          console.error(`✓ ${what} reviewers flagged on more than one PR, from the last ${result.prs} merged PRs here`);
          // saveReviewFindings keeps the findings' order.
          saved.forEach((note, i) => console.error(`    for your team · flagged in review on ${kept[i]?.prs.length ?? 2} PRs: ${note.title}`));
        } else if (cancelled) {
          console.error(`· saved none of the ${offered} things reviewers flagged; ${cmd("graft init")} again asks again`);
        } else if (offered) {
          console.error(`· kept none of the ${offered} things reviewers flagged`);
        } else if (result.reason === "failed") {
          console.error(`· couldn't read PR reviews this time; ${cmd("graft init")} again tries again`);
        }
        learned.push(...saved);
      }
      learnedNow = learned.length > 0;
      if (learnedNow) {
        console.error("· Claude follows them from your next session");
        if (learned.some((s) => s.scope === "repo")) console.error(commitLines({}, teammatesOn(repo), "repo").uncommitted);
      }
    }
    if (TRAIL && !learnedNow) {
      const home = notesHome.get(repo);
      if (home) {
        const learnings = listNotes(repo, { branches: false }).filter((n) => n.scope === "repo");
        if (learnings.length === 0) console.error(`✓ learnings  ${LEARNINGS_DIR}/ · sessions that take real digging leave one there, for your whole team`);
        else console.error(`✓ learnings  ${learnings.length} in ${LEARNINGS_DIR}/, from ${new Set(learnings.map((n) => n.author || "someone")).size} ${new Set(learnings.map((n) => n.author)).size === 1 ? "person" : "people"}`);
      }
    }

    if (!verbose) {
      // What there is to commit: the top-level entries the picked agents wrote.
      const tops: string[] = [];
      for (const w of selectedWrites(plan, ids)) {
        if (w.scope !== "repo") continue;
        const rel = shown(repo, w.path);
        // trail's Claude Code setup shares one file in .claude/; the rest there is personal.
        if (TRAIL && rel.startsWith(".claude/") && rel !== ".claude/settings.json") continue;
        const parts = rel.split("/");
        const top = TRAIL && rel === ".claude/settings.json" ? rel : parts.length > 1 ? `${parts[0]}/` : parts[0]!;
        if (!tops.includes(top)) tops.push(top);
      }
      console.error(`· restart your agents so a new session picks up ${brand()}`);
      if (TRAIL && !tops.includes(".trail/")) tops.push(".trail/");
      // Only what git sees as new or changed: a teammate's init over committed files has nothing to commit.
      for (const root of codeWs ? roots : [repo]) {
        const changedTops = tops.filter((t) => {
          const r = spawnSync("git", ["status", "--porcelain", "--", t], { cwd: root, encoding: "utf8" });
          return r.status !== 0 || r.stdout.trim().length > 0;
        });
        const where = codeWs ? ` in ${label(root)}` : "";
        if (changedTops.length)
          console.error(
            TRAIL
              ? `· commit ${changedTops.slice(0, 5).join(" and ")}${changedTops.length > 5 ? ` +${changedTops.length - 5} more` : ""}${where} once — after that, teammates' Claude reads your learnings even before they install trail`
              : `· commit ${changedTops.slice(0, 5).join(" ")}${changedTops.length > 5 ? ` +${changedTops.length - 5} more` : ""}${where} to share it — graft/ stays local and git-ignored`,
          );
      }
    }

    // One epilogue for the whole run. A workspace parent holds no nodes of its
    // own, so the totals come from the children — the graph the user actually got.
    const graphs = roots
      .flatMap((root) => {
        const kids = childrenOf.get(root)!;
        return kids.length ? kids.map((c) => ({ d: join(root, c), o: undefined })) : [{ d: root, o: overrideFor(root) }];
      })
      .map(({ d, o }) => loadGraphCached(contextDirFor(d, o)))
      .filter((g): g is NonNullable<typeof g> => g !== null);
    if (verbose) console.error(
      "\n" +
        formatInitEpilogue({
          graphBuilt: graphs.length > 0,
          nodes: graphs.reduce((n, g) => n + g.meta.nodeCount, 0),
          edges: graphs.reduce((n, g) => n + g.meta.edgeCount, 0),
        }),
    );
    // Sorted so `claude,cursor` and `cursor,claude` aggregate as one value.
    track(
      "init_completed",
      { agents: [...ids].sort().join(","), consent: consent === undefined ? "unasked" : String(consent) },
      { repo },
    );
    return { ids };
}

/** What one target's wiring did, for the compact summary to report. */
interface WireReport {
  /** Hosts whose files were removed because they were not selected. */
  retracted: string[];
  /** ⚠ lines, printed in full. */
  warnings: string[];
}

/** One repo's worth of `init` writes — the parent, then each workspace child. */
function wireTarget(
  repo: string,
  ids: string[],
  ctx: {
    home: string;
    cliPath: string;
    plan: ReturnType<typeof planInit>;
    wantClaude: boolean;
    opts: { build?: boolean; mcp?: boolean; hooks?: boolean; global?: boolean; statusline?: boolean };
    /** Collect warnings and removals instead of printing a line per file, and
     *  leave the graph build to the caller (see buildGraphWithProgress). */
    quiet?: boolean;
  },
): WireReport {
    const { home, cliPath, plan, wantClaude } = ctx;
    const quiet = ctx.quiet === true;
    const opts = quiet ? { ...ctx.opts, build: false } : ctx.opts;
    const report: WireReport = { retracted: [], warnings: [] };
    // Every per-file line goes through here; in quiet mode only ⚠ lines survive.
    const say = (line: string) => {
      if (!quiet) console.error(line);
      else if (line.startsWith("⚠")) report.warnings.push(line);
    };
    const wantStatusline = statuslineWanted({ statusline: opts.statusline });

    // Before any agent wiring, and regardless of which agents were picked: the
    // repo's own build settings. Only absent keys are added, so re-running init
    // never discards an edited exclude list, and a config written by an older
    // graft still learns the options it predates.
    const configPath = ensureDefaultBuildConfig(repo);
    if (configPath) say(`✓ wrote ${configPath}`);

    // Converge, don't just add. init writes the selected hosts; without this it
    // never touches the rest, so a repo wired by an older version (or by the same
    // version with different --agents) keeps that run's files forever — and
    // `reconcileWiring` then keeps them *up to date*, which is worse than stale.
    // Retract every host NOT being written now; `exclude` spares the ones about to
    // be rewritten, and the graph cache is kept (init is one step from using it).
    const retracted = changed(
      runRetract(repo, { home, apply: true, global: opts.global, cache: false, exclude: ids }),
    ).filter((r) => r.action !== "skipped-unparseable");
    for (const r of retracted) say(`- removed ${r.path} (${r.what}) — agent not selected`);
    report.retracted = [...new Set(retracted.map((r) => r.hostId))];

    if (wantClaude) {
      // `global`/`home` are threaded through alongside `statusline`: the claude layer
      // writes under `~/.claude` now (hosts/claude-global.ts), so --no-global has to
      // reach it or the flag would silently mean "no out-of-repo writes, except three".
      const res = runInit(repo, { build: opts.build, cliPath, statusline: wantStatusline, global: opts.global, home, brand: brand() });
      say(`✓ wrote ${res.settingsPath}`);
      for (const s of res.shims) say(`✓ wrote ${s}`);
      if (res.skill) say(`✓ wrote ${res.skill}`);
      if (!res.mcp) {
        // trail registers no server for Claude Code: the hooks and the `trail` command cover it.
      } else if (res.mcp.action === "skipped-unparseable")
        say(`⚠ .mcp.json: ${res.mcp.path} left unchanged (not valid JSON) — add the graft server manually`);
      else if (res.mcp.action === "unchanged")
        say(`· mcp claude: ${res.mcp.path} (already registered)`);
      else
        say(`✓ mcp claude: ${res.mcp.path} (${res.mcp.action}) — restart Claude Code to load the graft MCP server`);
      say(res.built ? `✓ built the graph (${cmd("graft build")})` : "· skipped graph build");
      if (!wantStatusline) say("· skipped Claude Code statusLine (--no-statusline)");
      for (const w of res.warnings) say(`⚠ ${w}`);
    }

    // `ids` is already resolved, so hosts init is always driven by an explicit
    // list — never by its own detection fallback.
    const others = ids.filter((id) => id !== "claude");
    if (others.length > 0) {
      const r = runHostsInit(repo, {
        agents: others,
        home,
        mcp: opts.mcp,
        hooks: opts.hooks,
        global: opts.global,
        brand: brand(),
      });
      // A config graft could not parse is left untouched rather than clobbered —
      // say so instead of reporting it as written. Kilo's kilo.jsonc is the common
      // case: JSONC comments are not JSON, and rewriting would delete them.
      const sayWrite = (label: string, w: { id: string; path: string; action: string }) =>
        say(
          w.action === "skipped-unparseable"
            ? `⚠ ${label}${w.id}: ${w.path} left unchanged (not valid JSON — // comments count) — add graft's entries by hand` +
                // The one config graft can't auto-merge often enough to be worth
                // naming the exact keys for: a JSONC kilo.jsonc the user has commented.
                (w.id === "kilo-config" ? `\n  → add "${kiloRuleRel(hostWiringName(repo, brand()))}" to "instructions", and a "${hostWiringName(repo, brand())}" server under "mcp"` : "")
            : `✓ ${label}${w.id}: ${w.path} (${w.action})`,
        );
      for (const w of r.written) sayWrite("", w);
      for (const m of r.mcp) sayWrite("mcp ", m);
      for (const h of r.hooks) say(`✓ hook ${h.id}: ${h.path} (${h.action})`);
      // Only worth saying when there was actually something out-of-repo to skip.
      if (opts.global === false && selectedWrites(plan, ids).some((w) => w.scope === "global"))
        say("· skipped out-of-repo writes (--no-global)");
    }

    // Record WHICH graft wrote this repo's agent files, and under which flags.
    // Every entry point compares this against the running binary and re-writes
    // them on a mismatch, so an `npm i -g` upgrade reaches the hooks/skill/rules
    // too — not just the binary. The flags ride along so a refresh replays the
    // user's choices (notably --no-global) instead of overriding them.
    writeStamp(repo, currentVersion, ids, {
      global: opts.global !== false,
      mcp: opts.mcp !== false,
      hooks: opts.hooks !== false,
      statusline: wantStatusline,
    });

    // Every host's wiring points at graft/, so the graph is built whatever was
    // selected — not only when Claude Code is in the list (runInit does its own).
    if (!wantClaude) {
      if (!quiet)
        say(
          buildGraphIfMissing(repo, { build: opts.build, cliPath })
            ? `✓ built the graph (${cmd("graft build")})`
            : "· skipped graph build",
        );
    }
    return report;
}

/** Group a retraction report by host, so the output reads as "what leaves each agent". */
function formatRetractions(rs: Retraction[], apply: boolean): string {
  const hit = changed(rs);
  if (hit.length === 0) return "· nothing to remove — no graft wiring found here";
  const verb = apply ? "removed" : "would remove";
  const lines: string[] = [];
  const byHost = new Map<string, Retraction[]>();
  for (const r of hit) {
    const k = byHost.get(r.hostId) ?? [];
    k.push(r);
    byHost.set(r.hostId, k);
  }
  for (const [host, items] of byHost) {
    lines.push(`\n${host}:`);
    for (const r of items) {
      const mark =
        r.action === "skipped-unparseable"
          ? "⚠"
          : r.action === "deleted"
            ? "-"
            : "~";
      const note =
        r.action === "skipped-unparseable"
          ? " — not valid JSON, left untouched (remove the graft entry by hand)"
          : r.action === "deleted"
            ? ` (${r.what} — deleted)`
            : ` (${r.what})`;
      const scope = r.scope === "global" ? " [machine-wide]" : "";
      lines.push(`  ${mark} ${verb}: ${r.path}${scope}${note}`);
    }
  }
  return lines.join("\n").replace(/^\n/, "");
}

grouped(program.command("uninstall"), GROUP.setup)
  .description(`Remove every file and config entry ${TRAIL ? "trail or graft" : "graft"} has written to this repo (the inverse of init)`)
  .argument("[dir]", "target repo directory", ".")
  .option("-y, --yes", "actually remove (without this, prints what it would remove and exits)")
  .option("--keep-cache", "keep graft/ and the .gitignore entries — wiring only")
  .option("--no-global", "leave out-of-repo files alone (~/.codex, ~/.gemini)")
  .action((dir: string, opts: { yes?: boolean; keepCache?: boolean; global?: boolean }) => {
    const repo = resolve(dir);
    const home = homedir();
    const common = { home, global: opts.global, cache: opts.keepCache ? false : true };

    if (!opts.yes) {
      console.error(formatRetractions(planRetract(repo, common), false));
      console.error("\nDry run — nothing was touched. Re-run with -y to remove.");
      if (opts.global !== false)
        console.error("Entries marked [machine-wide] affect every project; --no-global skips them.");
      return;
    }
    const done = runRetract(repo, { ...common, apply: true });
    console.error(formatRetractions(done, true));
    const bad = changed(done).filter((r) => r.action === "skipped-unparseable");
    console.error(
      bad.length
        ? `\n⚠ ${bad.length} file(s) could not be parsed and were left as-is — see above.`
        : `\n✓ ${brand()} fully removed. \`${cmd("graft init")}\` re-wires from scratch.`,
    );
  });


/* -------------------------------------------------------------------------- */
/* trail login · logout · workspace                                           */
/* -------------------------------------------------------------------------- */

/**
 * `trail login`: connect this machine to a Trail workspace by hand. Normally
 * nobody runs it: Claude offers the same link once there's a learning to
 * share. Prints the link, opens it, and waits for the person to sign in and
 * pick repos, then uploads those repos' learnings.
 */
function loginCommand(name = "login"): Command {
  return new Command(name)
    .description("Connect this machine to a Trail workspace: sign in, pick the repos it gets, invite your team")
    .argument("[dir]", "the repo you're in, ticked first in the picker", ".")
    .option("--server <url>", "a self-hosted Trail, e.g. https://trail.acme.internal (default: Trail cloud)")
    .action(async (dir: string, opts: { server?: string }) => {
      // Trail cloud is permanently off: refuse, like `telemetry enable`, before
      // anything is remembered, opened or sent.
      if (!cloudEnabled()) {
        console.error(`✗ ${CLOUD_DISABLED}`);
        process.exitCode = 1;
        return;
      }
      const repo = resolve(dir);
      const server = opts.server?.trim().replace(/\/+$/, "");
      if (server) {
        if (!/^https?:\/\//.test(server)) {
          console.error(`✗ --server takes a URL, like https://trail.acme.internal`);
          process.exitCode = 1;
          return;
        }
        process.env.TRAIL_URL = server;
      }
      const cloud = readCloud();
      if (cloud) {
        console.error(`✓ already connected to workspace ${cloud.workspace.name} · ${cloud.workspace.url}`);
        return;
      }
      rememberRepo(repo);
      const url = loginLink(repo);
      console.error(`· sign in and pick the repos your workspace gets:\n  ${url}`);
      if (process.stdout.isTTY) openBrowser(url);
      console.error("· waiting for you to finish in the browser (ctrl-c stops; Claude picks it up later too)");
      const got = await waitForConnect({ waitMs: 10 * 60 * 1000 });
      if (got && "cloud" in got) printLines(cloudLines(repo, { command: "note", agent: false }));
      else if (got && "error" in got) {
        console.error(`✗ ${got.error} · run ${cmd("graft login")} again for a new link`);
        process.exitCode = 1;
      } else console.error(`· not connected yet · the link stays good for a day`);
    });
}

function logoutCommand(name = "logout"): Command {
  return new Command(name)
    .description("Disconnect this machine from its Trail workspace (learnings stay in your repos)")
    .action(() => {
      const cloud = readCloud();
      clearPending();
      if (!clearCloud()) {
        console.error("· not connected to a workspace");
        return;
      }
      console.error(`✓ disconnected from workspace ${cloud?.workspace.name ?? ""} · learnings stay in your repos' .trail/`.replace("  ", " "));
    });
}

/** The repo at `repo`, as the workspace names it. */
function workspaceRepo(repo: string): { key: string; name: string; checkout: string; git: boolean } {
  const place = repoPlace(repo);
  return { key: place.key, name: repoName(place.key, place.checkout), checkout: place.checkout, git: place.git };
}

function workspaceCommand(name = "workspace"): Command {
  const ws = new Command(name)
    .description("Your Trail workspace: its repos, the team page and the invite link")
    .argument("[dir]", "repository root", ".")
    .option("--json", "output as JSON")
    .action(async (dir: string, opts: { json?: boolean }) => {
      const repo = resolve(dir);
      const cloud = readCloud();
      if (!cloud) {
        console.log(`· ${CLOUD_DISABLED}`);
        return;
      }
      const me = await fetchMe(cloud);
      if (isError(me)) {
        console.error(`✗ ${me.error}`);
        process.exitCode = 1;
        return;
      }
      // What the workspace has now, for every command that reads cloud.json.
      writeCloud({ ...cloud, workspace: me.workspace, repos: me.repos.map((r) => r.key) });
      if (opts.json) {
        console.log(JSON.stringify(me, null, 2));
        return;
      }
      console.log(`${me.workspace.name} · ${me.workspace.url}`);
      console.log(`invite  ${me.workspace.invite_url}`);
      console.log("");
      const here = workspaceRepo(repo);
      const width = Math.max(...me.repos.map((r) => r.name.length), here.name.length) + 3;
      for (const r of me.repos) {
        const by = r.added_by ? ` · added by ${r.added_by}` : "";
        console.log(`  ✓ ${r.name.padEnd(width)}${r.learnings} learning${r.learnings === 1 ? "" : "s"}${by}`);
      }
      if (here.git && !me.repos.some((r) => r.key === here.key)) {
        console.log(`  · ${here.name.padEnd(width)}not in the workspace · ${cmd("graft workspace add")} shares its learnings`);
      }
    });
  ws.command("add")
    .description("Add this repo to your workspace and share its learnings")
    .argument("[dir]", "repository root", ".")
    .action(async (dir: string) => {
      const repo = resolve(dir);
      const cloud = readCloud();
      if (!cloud) {
        console.error(`✗ ${CLOUD_DISABLED}`);
        process.exitCode = 1;
        return;
      }
      const here = workspaceRepo(repo);
      if (!here.git) {
        console.error("✗ not a git repository");
        process.exitCode = 1;
        return;
      }
      const added = await addRepo(cloud, { key: here.key, name: here.name });
      if (isError(added)) {
        console.error(`✗ ${added.error}`);
        process.exitCode = 1;
        return;
      }
      const next: Cloud = { ...cloud, repos: added.repos.map((r) => r.key) };
      writeCloud(next);
      rememberRepo(repo);
      const res = await syncRepo(here.checkout, next);
      if (isError(res)) {
        console.error(`✓ added ${here.name} to ${cloud.workspace.name} · its learnings go up in the background (${res.error})`);
        return;
      }
      console.error(`✓ added ${here.name} to ${cloud.workspace.name} · shared ${res.learnings} learning${res.learnings === 1 ? "" : "s"}`);
      console.error(`· ${cloud.workspace.url}`);
    });
  return ws;
}

/* -------------------------------------------------------------------------- */
/* trail team · trail check                                                   */
/* -------------------------------------------------------------------------- */

/** Fold a long line at `width`, indenting what wraps. */
function wrap(text: string, width: number, indent: string): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = indent + word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

function teamCommand(name = "team"): Command {
  return new Command(name)
    .description("What the team learned this week, who's working on what, and where work overlaps")
    .argument("[dir]", "repository root", ".")
    .option("--days <n>", "how far back to look", "7")
    .option("--json", "output as JSON")
    .action(async (dir: string, opts: { days: string; json?: boolean }) => {
      const repo = resolve(dir);
      const days = Math.max(1, Math.min(90, Number(opts.days) || 7));
      const cloud = readCloud();
      if (!cloud) {
        localTeam(repo, days, opts.json === true);
        return;
      }
      maybeSyncInBackground(repo);
      const here = workspaceRepo(repo);
      const t = await fetchTeam(cloud, { repo: cloud.repos.includes(here.key) ? here.key : undefined, days });
      if (isError(t)) {
        console.error(`✗ ${t.error}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(t, null, 2));
        return;
      }
      const period = days === 7 ? "this week" : `the last ${days} days`;
      console.log(`${period} in ${t.repo || t.workspace}`);
      console.log(
        `${t.people} ${t.people === 1 ? "person" : "people"} · ${t.sessions} session${t.sessions === 1 ? "" : "s"} · ` +
          `${t.new_learnings} new learning${t.new_learnings === 1 ? "" : "s"} · reused ${t.reused}×`,
      );
      if (t.members.length) {
        console.log("");
        const nameW = Math.max(...t.members.map((m) => m.name.length)) + 3;
        const topicW = Math.min(36, Math.max(...t.members.map((m) => m.topics.join(", ").length)) + 3);
        for (const m of t.members) {
          const learnings = m.learnings ? `${m.learnings} learning${m.learnings === 1 ? "" : "s"}` : "";
          const reused = m.reused ? `  reused ${m.reused}×` : "";
          console.log(`  ${m.name.padEnd(nameW)}${m.topics.join(", ").padEnd(topicW)}${learnings.padEnd(12)}${reused}`.trimEnd());
        }
      }
      const overlaps = [...t.overlaps.map((o) => o.text), ...branchOverlapTexts(repo)];
      if (overlaps.length) {
        console.log("\noverlap");
        for (const o of overlaps) for (const [i, l] of wrap(o, 66, "    ").entries()) console.log(i === 0 ? `  ● ${l}` : l);
      }
      if (t.url) console.log(`\n  team page: ${t.url}`);
    });
}

/** Pairs of teammates' pushed branches that change the same files, from this clone's branch cache. */
function branchOverlapTexts(repo: string, now = Date.now()): string[] {
  const branches = readBranchCache(repo)?.branches ?? [];
  const out: string[] = [];
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      const a = branches[i]!;
      const b = branches[j]!;
      if (!a.author || !b.author || a.author === b.author) continue;
      const shared = a.files.filter((f) => !f.startsWith(".trail/") && b.files.includes(f));
      if (!shared.length) continue;
      const files = shared.length <= 2 ? shared.join(" and ") : `${shared.slice(0, 2).join(", ")} and ${shared.length - 2} more`;
      out.push(
        `${a.author}'s ${a.ref.replace(/^origin\//, "")} (pushed ${pushedWhen(a.at, now)}) and ${b.author}'s ${b.ref.replace(/^origin\//, "")} (pushed ${pushedWhen(b.at, now)}) both change ${files}`,
      );
      if (out.length >= 5) return out;
    }
  }
  return out;
}

/**
 * `trail team` before this machine is connected: what this clone can see on
 * its own. Who wrote which learnings lately, and where teammates' pushed
 * branches overlap. Reuse and the team page need the workspace.
 */
function localTeam(repo: string, days: number, json: boolean): void {
  maybeRefreshBranches(repo);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const recent = listNotes(repo).filter((n) => n.scope === "repo" && n.date >= since);
  const byAuthor = new Map<string, Note[]>();
  for (const n of recent) byAuthor.set(n.author || "someone", [...(byAuthor.get(n.author || "someone") ?? []), n]);
  const overlaps = branchOverlapTexts(repo);
  if (json) {
    console.log(JSON.stringify({ days, learnings: recent.length, members: [...byAuthor].map(([name, ns]) => ({ name, learnings: ns.length, titles: ns.map((n) => n.title) })), overlaps }, null, 2));
    return;
  }
  const here = workspaceRepo(repo);
  console.log(`${days === 7 ? "this week" : `the last ${days} days`} in ${here.name} · from this clone`);
  console.log(`${byAuthor.size} ${byAuthor.size === 1 ? "person" : "people"} · ${recent.length} new learning${recent.length === 1 ? "" : "s"}`);
  if (byAuthor.size) {
    console.log("");
    const nameW = Math.max(...[...byAuthor.keys()].map((k) => k.length)) + 3;
    for (const [name, ns] of byAuthor) {
      const latest = ns[0]!.title.length > 40 ? `${ns[0]!.title.slice(0, 39)}…` : ns[0]!.title;
      console.log(`  ${name.padEnd(nameW)}${latest.padEnd(42)}${ns.length} learning${ns.length === 1 ? "" : "s"}`);
    }
  }
  if (overlaps.length) {
    console.log("\noverlap");
    for (const o of overlaps) for (const [i, l] of wrap(o, 66, "    ").entries()) console.log(i === 0 ? `  ● ${l}` : l);
  }
  console.log("\n· reuse and the team page, across your repos, are in a Trail workspace");
  printLines(cloudLines(repo, { command: "check" }));
}

function teamCheckCommand(name = "check"): Command {
  return new Command(name)
    .description("Check your branch's diff against everything the team has learned: the repo's learnings, yours and your skills")
    .argument("[dir]", "repository root", ".")
    .option("--base <ref>", "compare against where the branch left this ref (default: origin's default branch)")
    .option("--json", "output as JSON")
    .action(async (dir: string, opts: { base?: string; json?: boolean }) => {
      await runTeamCheck(resolve(dir), opts);
    });
}

/** A unified diff without the sections for `.trail/` files: a learning is never the change being checked. */
function withoutTrailFiles(diff: string): string {
  return diff
    .split(/(?=^diff --git )/m)
    .filter((part) => !/^diff --git a\/\.trail\//.test(part))
    .join("");
}

/**
 * `trail check`, on this machine: the branch's diff against the learnings in
 * the repo's `.trail/` (teammates' pushed branches included), this person's
 * own, and the repo's skills. No sign-in, no server. Exits 1 on a conflict.
 */
async function runTeamCheck(repo: string, opts: { base?: string; json?: boolean }): Promise<void> {
  const d = branchDiff(repo, opts.base);
  if (!d) {
    console.error("✗ not a git repository");
    process.exitCode = 1;
    return;
  }
  const files = d.files.filter((f) => !f.startsWith(".trail/"));
  const me = noteAuthor(repo);
  // Learnings this branch changed, as they were before it: the check reads those,
  // and changing a teammate's is a finding of its own.
  const atBase = learningsAtBase(repo, d.from, d.files);
  const edits = teammateEdits(repo, atBase, me);
  if (files.length === 0 && edits.length === 0) {
    console.log(`· nothing to check: no changes against ${d.base}`);
    return;
  }
  maybeRefreshBranches(repo);
  if (d.truncated) console.error("⚠ the diff is over 400 KB; only the first 400 KB is checked");
  const r = checkLocally({ diff: withoutTrailFiles(d.diff), files, notes: withBaseLearnings(listNotes(repo), atBase), skills: listSkills(repo), asker: me });
  r.findings.unshift(...edits);
  const sources = r.findings.map((f) => f.source).filter((s) => s.path);
  recordActivity({
    repo: repoPlace(repo).key,
    kind: "check",
    asker: me,
    session: sessionKey(repo) ?? `${me}-${new Date().toISOString().slice(0, 10)}`,
    query: "",
    files,
    shown_paths: [...new Set(sources.map((s) => s.path!.slice(s.path!.lastIndexOf("/") + 1)))],
    shown_authors: [...new Set(sources.map((s) => s.author ?? ""))],
    at: new Date().toISOString(),
  });
  const overlaps = overlapsWith(repo, files, me).slice(0, 3);
  if (opts.json) {
    console.log(JSON.stringify({ ...r, overlaps }, null, 2));
  } else {
    printCheck(r);
    if (overlaps.length) console.log(`\n${overlaps.map((o) => formatOverlap(o)).join("\n")}`);
    printLines(cloudLines(repo, { command: "check" }));
  }
  maybeSyncInBackground(repo);
  if (r.findings.some((f) => f.verdict === "conflict")) process.exitCode = 1;
}

function printCheck(r: CheckResult): void {
  console.log(
    `checking ${r.files} changed file${r.files === 1 ? "" : "s"} against ${r.notes} learning${r.notes === 1 ? "" : "s"} and ${r.skills} skill${r.skills === 1 ? "" : "s"}\n`,
  );
  const conflicts = r.findings.filter((f) => f.verdict === "conflict");
  for (const f of [...conflicts, ...r.findings.filter((x) => x.verdict !== "conflict")]) {
    const mark = f.verdict === "conflict" ? "✗" : "✓";
    console.log(`${mark} ${f.file}${f.line ? `:${f.line}` : ""}`);
    console.log(`  ${f.summary}`);
    const s = f.source;
    if (f.verdict === "conflict" && s.quote) {
      const who = [s.author, s.date ? shortDate(s.date) : ""].filter(Boolean).join(" · ");
      for (const l of wrap(`${who ? `${who}: ` : ""}${s.quote}`, 70, "  ")) console.log(`  ${l.trimStart()}`);
    }
  }
  if (r.findings.length === 0) console.log("✓ nothing the team has learned bears on this change");
  console.log("");
  console.log(
    conflicts.length
      ? `· ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} · fix ${conflicts.length === 1 ? "it" : "them"}, or say why in the commit message or PR description`
      : "· no conflicts",
  );
}

/** Tokens saved by this repo's agent sessions touched in the last 7 days. */
function savedThisWeek(repo: string, now = Date.now()): number {
  const since = now - 7 * 24 * 60 * 60 * 1000;
  let total = 0;
  for (const id of listSessionIds(repo)) {
    try {
      if (statSync(join(sessionDir(repo), `${id}.json`)).mtimeMs < since) continue;
    } catch {
      continue;
    }
    total += readSession(repo, id).savedTokens ?? 0;
  }
  return total;
}

/** 212345 → `212k`, 1_250_000 → `1.3M`. */
function shortCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * `trail status`: what was `graft stats`, on one
 * screen. The code map and whether it matches the code, the learnings for
 * this repo, the workspace, and what the agents saved this week.
 */
function statusCommand(name = "status"): Command {
  return new Command(name)
    .description("Code map, learnings and tokens saved, on one screen")
    .argument(...DIR_ARG)
    .option("--json", "machine-readable output")
    .action(async (dirArg: string | undefined, opts: { json?: boolean }) => {
      const repo = queryRoot(dirArg);
      const graph = loadGraphCached(contextDirFor(repo, program.opts<GlobalOpts>().dir));
      const g = graph ? await engineFrom().checkGraph(repo) : null;
      const fresh = g && !g.missing ? g.ok : null;
      const kept = keepsNotes(repo);
      const all = kept ? listNotes(repo) : [];
      const inRepo = all.filter((n) => n.scope === "repo" && !n.ref).length;
      const onBranches = all.filter((n) => n.ref).length;
      const personal = all.filter((n) => n.scope === "personal").length;
      const cloud = readCloud();
      const shared = cloud ? inWorkspace(repo, cloud) : false;
      const saved = savedThisWeek(repo);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              codeMap: graph ? { nodes: graph.meta.nodeCount, inSync: fresh } : null,
              learnings: kept ? { repo: inRepo, branches: onBranches, personal } : null,
              workspace: cloud ? { name: cloud.workspace.name, url: cloud.workspace.url, repos: cloud.repos.length, thisRepo: shared } : null,
              week: { savedTokens: saved },
            },
            null,
            2,
          ),
        );
        return;
      }
      const fmt = (x: number) => x.toLocaleString("en-US");
      const row = (k: string, v: string) => console.log(`${k.padEnd(11)} ${v}`);
      if (!graph) row("code map", `✗ not built · run ${cmd("graft build")}`);
      else if (fresh === false) row("code map", `⚠ ${fmt(graph.meta.nodeCount)} nodes · behind the code, refreshed on the next query`);
      else row("code map", `✓ ${fmt(graph.meta.nodeCount)} nodes · in sync with the code`);
      if (kept) {
        const parts = [`${inRepo} for the team in ${LEARNINGS_DIR}/`];
        if (onBranches) parts.push(`${onBranches} on teammates' branches`);
        if (personal) parts.push(`${personal} just for you, on this machine`);
        row("learnings", parts.join(" · "));
      }
      if (!cloud) {
        if (cloudEnabled()) row("workspace", "not connected · Claude offers a link once there are learnings to share");
      } else
        row(
          "workspace",
          `${cloud.workspace.name} · ${cloud.repos.length} repo${cloud.repos.length === 1 ? "" : "s"}${shared ? ", this one included" : `, not this one (${cmd("graft workspace add")})`} · ${cloud.workspace.url}`,
        );
      row("this week", saved > 0 ? `~${shortCount(saved)} tokens saved` : "nothing saved yet");
    });
}

if (TRAIL) {
  for (const c of [teamCheckCommand(), teamCommand()]) program.addCommand(c.helpGroup(GROUP.memory));
  // Signing in waits until it gives a team more than committing .trail/ does.
  for (const c of [workspaceCommand(), loginCommand(), logoutCommand()]) program.addCommand(c.helpGroup(GROUP.cloud), { hidden: !cloudEnabled() });
  program.addCommand(statusCommand().helpGroup(GROUP.setup));

  // Help lists the groups in this order, and the commands within each.
  const order = ["ask", "grep", "skeleton", "callers", "map", "note", "check", "team", "learn", "skills", "init", "build", "status", "upgrade", "uninstall", "telemetry", "workspace", "login", "logout", "blast"];
  const rank = (c: Command) => {
    const i = order.indexOf(c.name());
    return i === -1 ? order.length : i;
  };
  (program.commands as Command[]).sort((a, b) => rank(a) - rank(b));

  // One line each in the list; `trail <command> --help` keeps the long text.
  const summaries: Record<string, string> = {
    ask: "ranked answer, with the code inlined at each file:line",
    grep: "every occurrence, grouped by enclosing symbol",
    skeleton: "a file's whole API in ~200 tokens",
    callers: "who calls it, or what it calls with --direction out",
    map: "directory clusters, hubs and hotspots",
    note: "save what this session worked out, as a learning in .trail/",
    learn: "turn a correction into a takeaway on a skill",
    skills: "list skills, show one, fold takeaways in, publish to the repo",
    init: "wire trail into your agents",
    build: "rebuild the code map · --check fails if it's stale",
    status: "code map, learnings and tokens saved",
    upgrade: "install the latest trail",
    uninstall: "remove everything trail or graft wrote to this repo",
    telemetry: "anonymous usage stats: permanently off",
    check: "check your diff against everything the team has learned",
    team: "what the team learned this week, and where work overlaps",
    workspace: "your workspace's repos, team page and invite link",
    login: "connect a Trail workspace (Claude offers you the link)",
    logout: "disconnect this machine from its workspace",
    blast: "what depends on the lines this diff touched",
  };
  for (const c of program.commands) if (summaries[c.name()]) c.summary(summaries[c.name()]!);
  program.addHelpText("after", "\ntrail <command> --help for flags · every graft command still works");
}

// `build --deep` is the one command the LLM options act on, so its own help lists them too.
program.commands.find((c) => c.name() === "build")?.configureHelp({ showGlobalOptions: true });
// The top-level -h works but is not listed among the global options. Added last:
// every subcommand copies the program's help option when it is created, and keeps
// its own listed `-h, --help`.
program.addHelpOption(program.createOption("-h, --help", "display help for command").hideHelp());

// `graft /h` and `graft /help`: the Windows-style spelling of `graft help`, same
// output (and `/h <command>` like `help <command>`). Hidden, so no help lists them.
for (const name of ["/h", "/help"]) {
  program
    .command(name, { hidden: true })
    .description("Show the help — the same as `graft help`")
    .argument("[command...]", "the command to show the help of")
    .action((words: string[]) => {
      let target: Command = program;
      for (const word of words) {
        const next = (target.commands as Command[]).find((c) => c.name() === word || c.aliases().includes(word));
        if (!next) break;
        target = next;
      }
      target.outputHelp();
    });
}
if (!TRAIL) installGraftHelp(program);

// Commander's implicit `help <command>` only looks one level down, so
// `graft help config exclude-dirs` would print `config`'s help. The hidden `/help`
// above walks the whole path; hand a multi-word `help` to it.
if (process.argv[2] === "help" && process.argv.length > 4) process.argv.splice(2, 1, "/help");

// Only global options and no command (`graft --model x`): say what is missing
// rather than dumping the whole help as an error.
const globalValueOptions = program.options
  .filter((o) => o.required || o.optional)
  .flatMap((o) => [o.long, o.short].filter((f): f is string => Boolean(f)));
const noCommand = missingCommandHint(process.argv.slice(2), globalValueOptions, brand());
if (noCommand) {
  console.error(noCommand);
  process.exit(1);
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
