/**
 * The environment variables graft reads that a person would set, each with its
 * own command, the way `graft api key` and `graft model` have theirs:
 *
 *   graft files store | map-dir | repos-list
 *   graft api provider | retries | tool-rescues | balance-wait | balance-poll |
 *             balance-backoff | balance-backoff-max | openrouter-model | system-ca
 *   graft prices file | bundled
 *   graft refresh auto | hash | seed | gitignore | ignore-file
 *   graft agents gate | statusline | npx | trail-switch
 *   graft output savings-copy | rename-notice | browser
 *
 * plus `graft env list|get|set|unset` over all of them. Each saves a USER
 * environment variable through the store `graft api key` uses (llm-settings.ts):
 * HKCU\Environment on Windows, `~/.graft/env.sh` (or fish's conf.d) elsewhere,
 * so new terminals, IDEs once restarted, hooks and MCP servers see it. A child
 * process can't change the shell that started it, so each change also prints
 * the line that applies it to the current terminal.
 *
 * Switches are phrased as the feature, not the variable: `graft refresh auto
 * off` saves GRAFT_NO_REFRESH=1. Each switch knows how graft's code reads its
 * variable, so what is shown as on/off is what graft will actually do.
 *
 * Left out on purpose: test seams, internal handoffs (GRAFT_SET_*, GRAFT_JB_*),
 * the GitHub App server's deployment variables, the retired GRAFT_AGENT_MODEL,
 * and every switch that would send data off the machine (telemetry, Trail
 * cloud, TRAIL_NO_LOOK_BACK, TRAIL_NO_FETCH): this fork offers no command that
 * turns sending on (docs/no-cloud-policy.md).
 *
 * Pure over an injected store and environment; the commander wiring is in cli.ts.
 */
import { isAbsolute } from "node:path";
import { cmd } from "./brand.js";
import { envSetExample } from "./ai/llm-hints.js";
import { maskSecret, readSaved, type Prompter, type UserEnvStore } from "./ai/llm-settings.js";

export type EnvKind = "path" | "url" | "secret" | "int" | "choice" | "text" | "store" | "switch";

export interface EnvVar {
  name: string;
  /** The command that shows and sets it, without the program name (`files store`). */
  command: string;
  /** Registered elsewhere (`api url`, `api key`, `model`), with its own verification. */
  builtin?: boolean;
  /** One line, for the command list. */
  title: string;
  /** The full description, for `--help`. */
  help: string;
  /** What applies while it is not set. */
  unset: string;
  kind: EnvKind;
  examples: string[];
  /** `int`: the smallest value accepted. */
  min?: number;
  /** `int`: the unit, shown with the value. */
  unit?: string;
  /** `choice`: the values accepted, stored as written here. */
  values?: string[];
  /** `path`: only an absolute path is accepted. */
  absolute?: boolean;
  /** `switch`: whether the feature is on while the variable is not set. */
  defaultOn?: boolean;
  /** `switch`: what to store for on / off; `null` removes the variable. */
  store?: { on: string | null; off: string | null };
  /** `switch`: whether the feature is on for a set, non-empty value, read exactly as graft's code reads it. */
  isOn?: (raw: string) => boolean;
}

/** The command groups the variables live in, other than `api` and `prices`, which exist already. */
export const ENV_GROUPS: Record<string, { title: string; help: string }> = {
  files: {
    title: "Show or set where graft keeps its files: the profile store, the map folder, and the cross-repo savings list",
    help:
      "Where graft keeps what it writes. `files store` decides whether a repo that has no map or settings inside it yet " +
      "keeps them in your profile (the default) or inside the repo; `files map-dir` names one map folder to use instead; " +
      "`files repos-list` moves the list `graft savings --all` adds up. Each is a user environment variable, saved for " +
      "every new terminal. `graft where` shows where the current repo's files ended up.",
  },
  refresh: {
    title: "Show or set how the graph keeps up with the code: refresh before queries, change detection, worktree seeding, ignore files",
    help:
      "How the graph is kept in sync with the code, and what `graft build` writes into the repo besides the map. " +
      "`refresh auto` turns the rebuild before a query on or off, `refresh hash` makes change detection read every file, " +
      "`refresh seed` controls copying a parent checkout's graph into a new git worktree, and `refresh gitignore` / " +
      "`refresh ignore-file` control the .gitignore and .ignore entries. Each is a user environment variable, saved for " +
      "every new terminal.",
  },
  agents: {
    title: "Show or set how graft is wired into your agents: the read gate, the status line, how MCP starts graft, the move to trail",
    help:
      "How graft behaves inside the agents `graft init` wired: `agents gate` turns the hook that steers whole-file reads " +
      "to graft on or off, `agents statusline` the Claude Code status line, `agents npx` how MCP configs start graft, and " +
      "`agents trail-switch` whether repos move to trail when the trail command is installed. Each is a user environment " +
      "variable, saved for every new terminal.",
  },
  output: {
    title: "Show or set what graft prints: the savings copy on stderr, the rename notice, and opening a browser",
    help:
      "What graft prints or opens besides the answer: `output savings-copy` the copy of the savings line on stderr when " +
      "stdout is piped, `output rename-notice` the notice that graft is now trail, and `output browser` whether " +
      "`graft viz` opens a browser. Each is a user environment variable, saved for every new terminal.",
  },
};

/** The new commands under the groups that existed before (`api`, `prices`) don't change their group's own text. */
export const API_GROUP_TITLE =
  "Show or set the LLM endpoint `graft build --deep` uses and how its calls are made: `api url`, `api key`, `api provider`, retries, " +
  "balance waits, and trusting the system's certificates";

const truthy = (raw: string) => raw !== "0" && raw.toLowerCase() !== "false";
const OFF_WORDS = new Set(["0", "false", "off", "no"]);

/** Every variable, in the order `graft env list` shows them. */
export const ENV_VARS: EnvVar[] = [
  // ── files ──
  {
    name: "GRAFT_PROFILE_STORE",
    command: "files store",
    title: "Show or set GRAFT_PROFILE_STORE: keep the map and settings of new repos in your profile, another folder, or the repo",
    help:
      "Where a repo that has no map or settings inside it yet keeps them. on (the default): in your profile, at " +
      "~/.graft/repos/<folder>-<hash of the repo path>/, so nothing is written into the checkout. An absolute folder: the " +
      "same layout under that folder. off: inside the repo as before (graft/ and .graft/config.json). A map or settings " +
      "file already in a repo is always used and never moved, whatever this says. Wins over \"profileStore\" in " +
      "~/.graft/settings.json; --dir and GRAFT_DIR win over both. `graft where` shows the folder a repo uses.",
    unset: "on, at ~/.graft/repos (or what ~/.graft/settings.json says)",
    kind: "store",
    examples: ["graft files store", "graft files store off", "graft files store D:\\graft-maps", "graft files store --unset"],
  },
  {
    name: "GRAFT_DIR",
    command: "files map-dir",
    title: "Show or set GRAFT_DIR: one map folder to use instead of graft/ or the profile store",
    help:
      "The folder that holds the map (cards, INDEX.md, the graph and its caches), instead of graft/ or the profile store. " +
      "A relative path is taken inside each repo (.graft-map → <repo>/.graft-map). An absolute path makes EVERY repo use " +
      "that one folder, which is rarely what you want saved for all terminals; use --dir on one command instead. The " +
      "same as the global --dir option, which wins over it.",
    unset: "graft/ in the repo, or the profile store",
    kind: "path",
    examples: ["graft files map-dir", "graft files map-dir .graft-map", "graft files map-dir --unset"],
  },
  {
    name: "GRAFT_REPOS_FILE",
    command: "files repos-list",
    title: "Show or set GRAFT_REPOS_FILE: the list of repos `graft savings --all` adds up",
    help:
      "The file that lists every folder graft has recorded savings in, which `graft savings --all` reads to add them up. " +
      "Only a pointer to each repo is kept there, never the figures. Takes an absolute path.",
    unset: "~/.graft/repos.json",
    kind: "path",
    absolute: true,
    examples: ["graft files repos-list", "graft files repos-list D:\\graft\\repos.json"],
  },
  // ── api ──
  {
    name: "GRAFT_BASE_URL",
    command: "api url",
    builtin: true,
    title: "Show or set GRAFT_BASE_URL: the LLM endpoint for `graft build --deep`",
    help: "The LLM endpoint `graft build --deep` calls (any OpenAI-compatible API, or Anthropic's).",
    unset: "the Databricks AI Gateway",
    kind: "url",
    examples: ["graft api url"],
  },
  {
    name: "GRAFT_API_KEY",
    command: "api key",
    builtin: true,
    title: "Show or set GRAFT_API_KEY: the key for the LLM endpoint (shown masked)",
    help: "The API key sent to the LLM endpoint. Always shown masked.",
    unset: "ANTHROPIC_AUTH_TOKEN, if set",
    kind: "secret",
    examples: ["graft api key"],
  },
  {
    name: "GRAFT_MODEL",
    command: "model",
    builtin: true,
    title: "Show or set GRAFT_MODEL: the model `graft build --deep` uses",
    help: "The model `graft build --deep` uses.",
    unset: "graft's default model for the endpoint",
    kind: "text",
    examples: ["graft model"],
  },
  {
    name: "GRAFT_REASONING_EFFORT",
    command: "effort",
    builtin: true,
    title: "Show or set GRAFT_REASONING_EFFORT: the thinking effort `graft build --deep` asks the model for",
    help:
      "The thinking / reasoning effort `graft build --deep` asks the model for: none, minimal, low, medium, high, " +
      "xhigh or max, of which each model accepts its own subset; \"default\" sends none.",
    unset: "high where the model takes it, else the model's own default",
    kind: "text",
    examples: ["graft effort"],
  },
  {
    name: "GRAFT_PROVIDER",
    command: "api provider",
    title: "Show or set GRAFT_PROVIDER: the wire format spoken to the LLM endpoint",
    help:
      "The wire format graft speaks to the LLM endpoint, not a vendor: openai (any OpenAI-compatible API: OpenAI, " +
      "OpenRouter, Fireworks, a LiteLLM proxy, a local server), anthropic (Anthropic's Messages API), litellm, " +
      "orcarouter, or llm-incubator (needs `graft api url`). Leave it unset to let graft pick: on the Databricks AI " +
      "Gateway the route follows the model, elsewhere openai. The same as the global --provider option, which wins over it.",
    unset: "picked from the model on the Databricks gateway, else openai",
    kind: "choice",
    values: ["openai", "anthropic", "litellm", "orcarouter", "llm-incubator"],
    examples: ["graft api provider", "graft api provider anthropic", "graft api provider --unset"],
  },
  {
    name: "GRAFT_LLM_RETRIES",
    command: "api retries",
    title: "Show or set GRAFT_LLM_RETRIES: how often a failed LLM call is retried",
    help:
      "How many times `graft build --deep` retries an LLM call that failed for a reason worth retrying (a rate limit, a " +
      "5xx, a timeout), after the first try, with growing pauses that honour Retry-After. Lower it for a metered " +
      "gateway, raise it for a flaky proxy. 0 = no retries.",
    unset: "4",
    kind: "int",
    min: 0,
    examples: ["graft api retries", "graft api retries 8"],
  },
  {
    name: "GRAFT_LLM_FORCED_RESCUES",
    command: "api tool-rescues",
    title: "Show or set GRAFT_LLM_FORCED_RESCUES: when to stop forcing tool calls on an endpoint that can't serve them",
    help:
      "Some endpoints or models reject a forced tool call and graft rescues the call another way. After this many " +
      "rescued calls on the same endpoint and model, graft stops forcing the tool call there and asks the easier way " +
      "from the start, which saves a failed round trip per call.",
    unset: "2",
    kind: "int",
    min: 1,
    examples: ["graft api tool-rescues", "graft api tool-rescues 1"],
  },
  {
    name: "GRAFT_BALANCE_WAIT_MS",
    command: "api balance-wait",
    unit: "ms",
    title: "Show or set GRAFT_BALANCE_WAIT_MS: how long to wait for an empty account balance to be refilled",
    help:
      "When the endpoint says the account's balance is empty, `graft build --deep` first backs off, then waits up to " +
      "this long (in milliseconds) for the balance to be refilled before giving up, checking every `api balance-poll`. " +
      "0 = don't wait, give up after the backoff.",
    unset: "1800000 (30 minutes)",
    kind: "int",
    min: 0,
    examples: ["graft api balance-wait", "graft api balance-wait 600000", "graft api balance-wait 0"],
  },
  {
    name: "GRAFT_BALANCE_POLL_MS",
    command: "api balance-poll",
    unit: "ms",
    title: "Show or set GRAFT_BALANCE_POLL_MS: how often to check whether an empty balance was refilled",
    help: "While waiting for an empty balance to be refilled (`api balance-wait`), how often to check, in milliseconds.",
    unset: "30000 (30 seconds)",
    kind: "int",
    min: 1,
    examples: ["graft api balance-poll", "graft api balance-poll 60000"],
  },
  {
    name: "GRAFT_BALANCE_RETRY_BASE_MS",
    command: "api balance-backoff",
    unit: "ms",
    title: "Show or set GRAFT_BALANCE_RETRY_BASE_MS: the first pause after an empty-balance error",
    help:
      "After an empty-balance error, the first pause before trying again, in milliseconds. Each further pause doubles, " +
      "up to `api balance-backoff-max`.",
    unset: "2000 (2 seconds)",
    kind: "int",
    min: 0,
    examples: ["graft api balance-backoff", "graft api balance-backoff 5000"],
  },
  {
    name: "GRAFT_BALANCE_RETRY_MAX_MS",
    command: "api balance-backoff-max",
    unit: "ms",
    title: "Show or set GRAFT_BALANCE_RETRY_MAX_MS: the longest single pause after an empty-balance error",
    help: "The longest single pause between tries after an empty-balance error, in milliseconds.",
    unset: "60000 (1 minute)",
    kind: "int",
    min: 0,
    examples: ["graft api balance-backoff-max", "graft api balance-backoff-max 120000"],
  },
  {
    name: "GRAFT_OPENROUTER_MODEL",
    command: "api openrouter-model",
    title: "Show or set GRAFT_OPENROUTER_MODEL: the older name for GRAFT_MODEL",
    help:
      "The model `graft build --deep` uses, under the name older graft versions read. Only read when GRAFT_MODEL is not " +
      "set; prefer `graft model`, and remove this one with --unset once that is set.",
    unset: "not used",
    kind: "text",
    examples: ["graft api openrouter-model", "graft api openrouter-model --unset"],
  },
  {
    name: "GRAFT_SYSTEM_CA",
    command: "api system-ca",
    title: "Show or set GRAFT_SYSTEM_CA: trust the operating system's certificates for HTTPS",
    help:
      "Whether graft's HTTPS requests (the LLM endpoint, `graft prices update`, the version check) also trust the " +
      "certificates installed in your operating system, which is what lets them through a corporate proxy that " +
      "re-signs traffic. on (the default) adds them to Node's bundled ones; off uses Node's bundled ones only.",
    unset: "on",
    kind: "switch",
    defaultOn: true,
    store: { on: null, off: "0" },
    isOn: (raw) => !OFF_WORDS.has(raw.trim().toLowerCase()),
    examples: ["graft api system-ca", "graft api system-ca off"],
  },
  // ── prices ──
  {
    name: "GRAFT_PRICES_FILE",
    command: "prices file",
    title: "Show or set GRAFT_PRICES_FILE: where `graft prices update` stores the price catalog",
    help:
      "The file `graft prices update` downloads LiteLLM's public model price catalog into, and that savings are priced " +
      "from for models graft's built-in table doesn't list. Takes an absolute path.",
    unset: "~/.graft/prices.json",
    kind: "path",
    absolute: true,
    examples: ["graft prices file", "graft prices file D:\\graft\\prices.json"],
  },
  {
    name: "GRAFT_BUNDLED_PRICES",
    command: "prices bundled",
    title: "Show or set GRAFT_BUNDLED_PRICES: use the price snapshot shipped with graft",
    help:
      "Whether savings may be priced from the snapshot of LiteLLM's price catalog shipped with graft, when the catalog " +
      "`graft prices update` downloaded doesn't list the model (or there is none). off = only graft's built-in table " +
      "and your downloaded catalog.",
    unset: "on",
    kind: "switch",
    defaultOn: true,
    store: { on: null, off: "0" },
    isOn: (raw) => !OFF_WORDS.has(raw.trim().toLowerCase()),
    examples: ["graft prices bundled", "graft prices bundled off"],
  },
  // ── refresh ──
  {
    name: "GRAFT_NO_REFRESH",
    command: "refresh auto",
    title: "Show or set GRAFT_NO_REFRESH: rebuild the graph before a query when the code changed",
    help:
      "Whether a query (`graft ask`, `grep`, `callers`, the MCP tools) first brings the graph up to date when the code " +
      "changed since the last build: cheap when nothing moved, a $0 structural rebuild when something did. off = " +
      "queries answer from the graph as it is and never write, for CI or read-only checkouts. A command's own " +
      "--no-refresh does the same for one call.",
    unset: "on",
    kind: "switch",
    defaultOn: true,
    store: { on: null, off: "1" },
    isOn: (raw) => !truthy(raw),
    examples: ["graft refresh auto", "graft refresh auto off"],
  },
  {
    name: "GRAFT_REFRESH",
    command: "refresh hash",
    title: "Show or set GRAFT_REFRESH: detect changed files by their bytes instead of their times",
    help:
      "How the refresh before a query finds changed files. off (the default): by file size and time, reading the bytes " +
      "only of files that look changed. on: read every file's bytes every time, for file systems whose times can't be " +
      "trusted (some network drives, containers, checkouts restored with old times). Slower on a big repo.",
    unset: "off",
    kind: "switch",
    defaultOn: false,
    store: { on: "hash", off: null },
    isOn: (raw) => raw === "hash",
    examples: ["graft refresh hash", "graft refresh hash on"],
  },
  {
    name: "GRAFT_NO_SEED",
    command: "refresh seed",
    title: "Show or set GRAFT_NO_SEED: start a new git worktree from its parent checkout's graph",
    help:
      "A new git worktree has no graph of its own (the map is git-ignored), so graft copies the parent checkout's graph " +
      "into it and refreshes only what differs, instead of parsing the whole repo again. off = every worktree builds " +
      "its own from scratch.",
    unset: "on",
    kind: "switch",
    defaultOn: true,
    store: { on: null, off: "1" },
    isOn: (raw) => !truthy(raw),
    examples: ["graft refresh seed", "graft refresh seed off"],
  },
  {
    name: "GRAFT_NO_GITIGNORE",
    command: "refresh gitignore",
    title: "Show or set GRAFT_NO_GITIGNORE: let `graft build` add graft/ and .graft/ to .gitignore",
    help:
      "Whether `graft build` adds the map folder (graft/) and the settings folder (.graft/) to the repo's .gitignore " +
      "the first time, so the local cache is never committed. Nothing is added when git already ignores them, or when " +
      "they live outside the repo (the profile store). off = never touch .gitignore. `graft build --no-gitignore` " +
      "does the same for one build.",
    unset: "on",
    kind: "switch",
    defaultOn: true,
    store: { on: null, off: "1" },
    isOn: (raw) => !truthy(raw),
    examples: ["graft refresh gitignore", "graft refresh gitignore off"],
  },
  {
    name: "GRAFT_NO_IGNORE",
    command: "refresh ignore-file",
    title: "Show or set GRAFT_NO_IGNORE: let `graft build` write the .ignore that keeps graft/ searchable",
    help:
      "ripgrep, and every search tool built on it, skips what .gitignore lists, so a git-ignored graft/ could never be " +
      "found by a search. `graft build` writes a root .ignore that lets ripgrep see the cards again (but not the " +
      "caches). off = never write .ignore. Nothing is written when the map lives outside the repo. `graft build " +
      "--no-ignore` does the same for one build.",
    unset: "on",
    kind: "switch",
    defaultOn: true,
    store: { on: null, off: "1" },
    isOn: (raw) => !truthy(raw),
    examples: ["graft refresh ignore-file", "graft refresh ignore-file off"],
  },
  // ── agents ──
  {
    name: "GRAFT_NO_GATE",
    command: "agents gate",
    title: "Show or set GRAFT_NO_GATE: steer an agent's whole-file reads to graft",
    help:
      "Where hooks are installed (Claude Code, Codex, Cursor), the gate turns an agent's whole-file read of an indexed " +
      "source file back with a pointer to the graft query that answers it in far fewer tokens. A read of an exact line " +
      "range, or of a file graft doesn't index, always goes through, and the gate lets everything through if anything " +
      "goes wrong. off = never steer.",
    unset: "on",
    kind: "switch",
    defaultOn: true,
    store: { on: null, off: "1" },
    isOn: (raw) => raw !== "1",
    examples: ["graft agents gate", "graft agents gate off"],
  },
  {
    name: "GRAFT_NO_STATUSLINE",
    command: "agents statusline",
    title: "Show or set GRAFT_NO_STATUSLINE: install graft's Claude Code status line",
    help:
      "Whether `graft init` installs the Claude Code status line that shows the graph's size, whether it is in sync, " +
      "and the tokens saved this session. off = leave Claude Code's status line alone. `graft init --no-statusline` " +
      "does the same for one run.",
    unset: "on",
    kind: "switch",
    defaultOn: true,
    store: { on: null, off: "1" },
    isOn: (raw) => !truthy(raw),
    examples: ["graft agents statusline", "graft agents statusline off"],
  },
  {
    name: "GRAFT_MCP_NPX",
    command: "agents npx",
    title: "Show or set GRAFT_MCP_NPX: start graft's MCP server through npx",
    help:
      "How the MCP configs `graft init` writes start graft. off (the default): the installed graft command when it is " +
      "on PATH, else npx. on: always through npx, which fetches the published package: the way out when the " +
      "installed command is stale or shadowed by another one. Applies to configs written after the change: run " +
      "`graft init` again.",
    unset: "off",
    kind: "switch",
    defaultOn: false,
    store: { on: "1", off: null },
    isOn: (raw) => truthy(raw),
    examples: ["graft agents npx", "graft agents npx on"],
  },
  {
    name: "GRAFT_NO_TRAIL_SWITCH",
    command: "agents trail-switch",
    title: "Show or set GRAFT_NO_TRAIL_SWITCH: move repos to trail once the trail command is installed",
    help:
      "graft is now called trail. With the trail command installed, a repo wired as graft moves to trail the first " +
      "time an agent session opens in it. off = repos on this machine stay on graft.",
    unset: "on",
    kind: "switch",
    defaultOn: true,
    store: { on: null, off: "1" },
    isOn: (raw) => raw !== "1",
    examples: ["graft agents trail-switch", "graft agents trail-switch off"],
  },
  // ── output ──
  {
    name: "GRAFT_STDERR_SAVINGS",
    command: "output savings-copy",
    title: "Show or set GRAFT_STDERR_SAVINGS: copy the savings line to stderr when output is piped",
    help:
      "When graft's output is piped (an agent filtering it through head, Select-Object or grep), the savings line at " +
      "the end may be cut off, so graft also prints it on stderr. Never under Claude Code, which reads both streams. " +
      "off = no copy, for a host that captures both streams and would show it twice.",
    unset: "on",
    kind: "switch",
    defaultOn: true,
    store: { on: null, off: "0" },
    isOn: (raw) => raw !== "0",
    examples: ["graft output savings-copy", "graft output savings-copy off"],
  },
  {
    name: "GRAFT_NO_RENAME_NOTICE",
    command: "output rename-notice",
    title: "Show or set GRAFT_NO_RENAME_NOTICE: the notice that graft is now called trail",
    help:
      "Once a day, someone typing graft in a terminal is told it is now called trail. Agents, hooks, CI and pipes never " +
      "see it. off = never show it.",
    unset: "on",
    kind: "switch",
    defaultOn: true,
    store: { on: null, off: "1" },
    isOn: () => false,
    examples: ["graft output rename-notice", "graft output rename-notice off"],
  },
  {
    name: "GRAFT_NO_BROWSER",
    command: "output browser",
    title: "Show or set GRAFT_NO_BROWSER: let `graft viz` open a browser",
    help: "Whether `graft viz` opens the viewer in your default browser. off = only print its address.",
    unset: "on",
    kind: "switch",
    defaultOn: true,
    store: { on: null, off: "1" },
    isOn: () => false,
    examples: ["graft output browser", "graft output browser off"],
  },
];

export function findEnvVar(name: string): EnvVar | undefined {
  const n = name.trim().toUpperCase();
  return ENV_VARS.find((v) => v.name === n);
}

const ON_SPELLINGS = new Set(["on", "true", "yes", "enable", "enabled"]);
const OFF_SPELLINGS = new Set(["off", "false", "no", "disable", "disabled"]);

/** The value to store for what a person typed (`null` = remove), or the reason it is refused. */
export function normalizeEnvValue(v: EnvVar, raw: string): { value: string | null } | { problem: string } {
  const value = raw.trim();
  if (value === "") return { problem: `the value is empty; --unset removes it` };
  const lower = value.toLowerCase();
  switch (v.kind) {
    case "switch":
      if (ON_SPELLINGS.has(lower)) return { value: v.store!.on };
      if (OFF_SPELLINGS.has(lower)) return { value: v.store!.off };
      return { problem: `expected on or off (on = ${feature(v)})` };
    case "store":
      if (ON_SPELLINGS.has(lower) || lower === "1") return { value: "1" };
      if (OFF_SPELLINGS.has(lower) || lower === "0") return { value: "0" };
      return isAbsolute(value) ? { value } : { problem: "expected on, off, or an absolute folder" };
    case "path":
      if (v.absolute && !isAbsolute(value)) return { problem: "expected an absolute path" };
      return { value };
    case "url":
      try {
        const u = new URL(value);
        if (u.protocol !== "http:" && u.protocol !== "https:") return { problem: `"${value}" is not an http(s) URL` };
      } catch {
        return { problem: `"${value}" is not a URL` };
      }
      return { value };
    case "int": {
      if (!/^\d+$/.test(value)) return { problem: "expected a whole number" };
      const n = Number(value);
      if (v.min !== undefined && n < v.min) return { problem: `expected ${v.min} or more` };
      return { value: String(n) };
    }
    case "choice": {
      const hit = v.values?.find((x) => x.toLowerCase() === lower);
      return hit ? { value: hit } : { problem: `expected one of ${v.values!.join(", ")}` };
    }
    case "text":
      return /\s/.test(value) ? { problem: "the value contains spaces" } : { value };
    case "secret":
      return { value };
  }
}

/** The switch's feature in a few words, from its title (`rebuild the graph before a query …`). */
function feature(v: EnvVar): string {
  const i = v.title.indexOf(": ");
  return i === -1 ? v.title : v.title.slice(i + 2);
}

/** What a person may type for `v`, for messages and help. */
export function choices(v: EnvVar): string {
  switch (v.kind) {
    case "switch":
      return "on or off";
    case "store":
      return "on, off, or an absolute folder";
    case "path":
      return v.absolute ? "an absolute path" : "a path (relative = inside each repo)";
    case "url":
      return "an http(s) URL";
    case "int":
      return `a whole number${v.unit ? ` of ${v.unit === "ms" ? "milliseconds" : v.unit}` : ""}, ${v.min ?? 0} or more`;
    case "text":
      return "a value without spaces";
    case "secret":
      return "the secret (omit it in a terminal to type it hidden)";
    case "choice":
      return v.values!.join(", ");
  }
}

/** The commander argument for `v`'s command, e.g. `[on|off]`. */
export function argumentTerm(v: EnvVar): string {
  switch (v.kind) {
    case "switch":
      return "[on|off]";
    case "store":
      return "[on|off|folder]";
    case "path":
      return "[path]";
    case "url":
      return "[url]";
    case "int":
      return v.unit ? `[${v.unit}]` : "[n]";
    case "choice":
      return "[name]";
    case "text":
      return "[id]";
    case "secret":
      return "[secret]";
  }
}

/** How a value reads to a person: a switch as on/off, a secret masked. */
export function describeValue(v: EnvVar, raw: string | undefined): string {
  if (raw === undefined || raw === "") return "not set";
  if (v.kind === "secret") return maskSecret(raw);
  if (v.kind === "switch") return `${v.isOn!(raw) ? "on" : "off"} (${v.name}=${raw})`;
  if (v.kind === "store") {
    const l = raw.trim().toLowerCase();
    if (OFF_WORDS.has(l)) return `off (${v.name}=${raw})`;
    if (["1", "true", "yes", "on"].includes(l)) return `on (${v.name}=${raw})`;
  }
  return raw;
}

export interface EnvDeps {
  store: UserEnvStore;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  out: (line: string) => void;
  err: (line: string) => void;
  prompt?: Prompter;
}

function statusLines(v: EnvVar, here: string | undefined, saved: string | undefined, where: string): string[] {
  const lines = [
    `  this terminal: ${describeValue(v, here)}`,
    `  saved:         ${describeValue(v, saved)}  [${where}]`,
    `  when not set:  ${v.unset}`,
  ];
  if ((here ?? "") !== (saved ?? "")) {
    lines.push(
      saved !== undefined && here === undefined
        ? "  note: saved after this terminal started; new terminals use it"
        : here !== undefined && saved === undefined
          ? "  note: set in this terminal only, not saved"
          : "  note: this terminal differs from the saved value; new terminals use the saved one",
    );
  }
  return lines;
}

/**
 * One variable's own command (`graft refresh auto [on|off] [--unset]`): show it
 * with no value, save the value given, or remove it with --unset.
 */
export async function runVarCommand(v: EnvVar, value: string | undefined, opts: { unset?: boolean }, deps: EnvDeps): Promise<number> {
  const command = cmd(`graft ${v.command}`);
  if (opts.unset && value !== undefined) {
    deps.err(`✗ ${command}: pass a value or --unset, not both`);
    return 1;
  }
  if (opts.unset) return write(v, null, deps);
  if (value === undefined) {
    if (v.kind === "secret" && deps.prompt) {
      try {
        value = await deps.prompt.askHidden(`${v.name}: `);
      } catch {
        deps.out("Cancelled — nothing changed.");
        return 130;
      }
    } else {
      const saved = readSaved(deps.store, [v.name])[v.name];
      deps.out(`${v.name} — ${feature(v)}`);
      for (const l of statusLines(v, deps.env[v.name], saved, deps.store.where)) deps.out(l);
      deps.out(`Set it with \`${command} ${argumentTerm(v).slice(1, -1)}\` (${choices(v)}), remove it with \`${command} --unset\`.`);
      return 0;
    }
  }
  const r = normalizeEnvValue(v, value);
  if ("problem" in r) {
    deps.err(`✗ ${command}: ${r.problem}`);
    return 1;
  }
  return write(v, r.value, deps);
}

function write(v: EnvVar, value: string | null, deps: EnvDeps): number {
  try {
    deps.store.write(v.name, value ?? undefined);
  } catch (e) {
    deps.err(`✗ ${cmd(`graft ${v.command}`)}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (value === null) {
    const now = v.kind === "switch" ? `${v.defaultOn ? "on" : "off"} (the default)` : v.unset;
    deps.out(`✓ ${v.name} is not saved (removed from ${deps.store.where}) — now: ${now}`);
  } else {
    deps.out(`✓ saved ${v.name} = ${describeValue(v, value)} to ${deps.store.where}`);
  }
  deps.out("  New terminals see it; restart your IDE so its terminals, hooks and MCP servers do too. For this terminal run:");
  deps.out(
    `    ${
      value === null
        ? deps.platform === "win32"
          ? `Remove-Item Env:${v.name} -ErrorAction SilentlyContinue`
          : `unset ${v.name}`
        : envSetExample(v.name, v.kind === "secret" ? "<your-secret>" : value, deps.platform)
    }`,
  );
  if (v.builtin && value !== null) deps.out(`  ${cmd(`graft ${v.command}`)} saves it too, and checks the endpoint.`);
  return 0;
}

// ── graft env: all of them at once ──

/** `graft env list`: every variable, grouped by command, with this terminal's and the saved value. */
export function runEnvList(deps: EnvDeps, opts: { json?: boolean; setOnly?: boolean } = {}): number {
  const saved = readSaved(deps.store, ENV_VARS.map((v) => v.name));
  const rows = ENV_VARS.map((v) => ({ v, here: deps.env[v.name], saved: saved[v.name] })).filter(
    (r) => !opts.setOnly || r.here !== undefined || r.saved !== undefined,
  );
  if (opts.json) {
    deps.out(
      JSON.stringify(
        {
          savedIn: deps.store.where,
          variables: rows.map(({ v, here, saved: s }) => ({
            name: v.name,
            command: `graft ${v.command}`,
            description: feature(v),
            whenNotSet: v.unset,
            accepts: choices(v),
            thisTerminal: here === undefined ? null : v.kind === "secret" ? maskSecret(here) : here,
            saved: s === undefined ? null : v.kind === "secret" ? maskSecret(s) : s,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  deps.out(`saved in: ${deps.store.where}`);
  if (rows.length === 0) deps.out("\nnone set: every variable is at its default");
  let group = "";
  for (const { v, here, saved: s } of rows) {
    const g = v.command.includes(" ") ? v.command.split(" ")[0]! : "api";
    if (g !== group) {
      group = g;
      deps.out("");
    }
    const now = here !== undefined ? describeValue(v, here) : s !== undefined ? `${describeValue(v, s)} (saved, new terminals)` : "not set";
    deps.out(`  ${cmd(`graft ${v.command}`).padEnd(30)} ${v.name} = ${now}`);
    deps.out(`  ${"".padEnd(30)} ${feature(v)} · when not set: ${v.unset}`);
  }
  deps.out("");
  deps.out(`each command alone shows its variable; give it a value to save one, or --unset to remove it · \`${cmd("graft <command> --help")}\` for the details`);
  return 0;
}

function unknown(deps: EnvDeps, name: string): number {
  deps.err(`✗ graft does not read ${name.trim() || "that variable"} — \`${cmd("graft env list")}\` shows the ones it does`);
  return 1;
}

/** `graft env get <NAME>`: one variable, by its name. */
export function runEnvGet(name: string, deps: EnvDeps): number {
  const v = findEnvVar(name);
  if (!v) return unknown(deps, name);
  const saved = readSaved(deps.store, [v.name])[v.name];
  deps.out(`${v.name} — ${feature(v)}`);
  for (const l of statusLines(v, deps.env[v.name], saved, deps.store.where)) deps.out(l);
  deps.out(`  accepts:       ${choices(v)}`);
  deps.out(`  command:       ${cmd(`graft ${v.command}`)}`);
  return 0;
}

/** `graft env set <NAME> [value]`: the same as the variable's own command with that value. */
export function runEnvSet(name: string, raw: string | undefined, deps: EnvDeps): Promise<number> | number {
  const v = findEnvVar(name);
  if (!v) return unknown(deps, name);
  if (raw === undefined && v.kind !== "secret") {
    deps.err(`✗ ${cmd("graft env set")} ${v.name}: give a value (${choices(v)})`);
    return 1;
  }
  return runVarCommand(v, raw, {}, deps);
}

/** `graft env unset <NAME>`. */
export function runEnvUnset(name: string, deps: EnvDeps): number {
  const v = findEnvVar(name);
  if (!v) return unknown(deps, name);
  return write(v, null, deps);
}
