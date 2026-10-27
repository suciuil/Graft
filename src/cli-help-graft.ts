/**
 * graft's help screens (the `graft` name only; `trail` keeps commander's grouped help).
 *
 * `graft --help` is just the command list, A→Z, and every entry is complete on its
 * own: what the command does in plain words, its arguments, ALL of its options —
 * including the global ones (`--dir`, `--agent-model`, the LLM options) on exactly
 * the commands they affect — and examples. `graft <command> --help` prints that
 * same entry. Arguments and options are read from commander, so this never drifts
 * from the code; only the prose and the examples live here.
 */
import type { Argument, Command, Help, Option } from "commander";
import { choices, ENV_GROUPS, ENV_VARS } from "./env-cli.js";

/**
 * The help entries of the environment-variable commands (`files store`, `refresh
 * auto`, …) and of their new groups, written from the same table that registers
 * them (env-cli.ts), so a variable's command and its help can't disagree.
 */
function envVarHelp(): Record<string, CommandHelp> {
  const out: Record<string, CommandHelp> = {};
  for (const [name, g] of Object.entries(ENV_GROUPS)) {
    out[name] = {
      description: g.help,
      examples: ENV_VARS.filter((v) => v.command.startsWith(`${name} `)).map((v) => v.examples[0]!),
    };
  }
  for (const v of ENV_VARS) {
    if (v.builtin) continue;
    out[v.command] = {
      description:
        `${v.help}\n` +
        `Sets ${v.name}, saved as a user environment variable for every new terminal (HKCU\\Environment on Windows, ` +
        `~/.graft/env.sh on macOS/Linux). Without a value it shows the value in this terminal and the saved one; ` +
        `--unset removes the saved one. When not set: ${v.unset}. Accepts: ${choices(v)}.`,
      examples: v.examples,
    };
  }
  return out;
}

type GlobalGroup = "dir" | "agent-model" | "llm";

interface CommandHelp {
  description: string;
  examples: string[];
  globals?: GlobalGroup[];
}

const GLOBAL_FLAGS: Record<GlobalGroup, string[]> = {
  dir: ["--dir"],
  "agent-model": ["--agent-model"],
  llm: ["--provider", "--model", "--api-key", "--base-url"],
};

/** Commands that query the graph: they read it (`--dir`) and price what they save (`--agent-model`). */
const QUERY: GlobalGroup[] = ["dir", "agent-model"];

/** Keyed by the command path without the program name (`api key`). */
export const GRAFT_HELP: Record<string, CommandHelp> = {
  "api key": {
    description:
      "Show or change GRAFT_API_KEY, the API key `graft build --deep` sends to the LLM endpoint. " +
      "Run without a key in a terminal to be asked for it (input hidden, kept out of your shell history). " +
      "It is saved as a user environment variable, so new terminals pick it up, then checked against the endpoint. " +
      "The key is always shown masked.",
    examples: ["graft api key", "graft api key --unset"],
  },
  "api url": {
    description:
      "Show or change GRAFT_BASE_URL, the address of the LLM endpoint `graft build --deep` calls " +
      "(any OpenAI-compatible API, or Anthropic's). Saved as a user environment variable, then checked against the endpoint.",
    examples: ["graft api url", "graft api url https://my-gateway.example.com/v1"],
  },
  ask: {
    description:
      "Ask a question about the code in plain words. Returns the best-matching places with exact file:line " +
      "locations; add --source to see the code itself. Free: no API key, no LLM call.",
    examples: ['graft ask "where is auth handled" --source', 'graft ask "how are retries done" -n 3 --in src/net'],
    globals: QUERY,
  },
  blast: {
    description:
      "Show what depends on the lines a change touched (its blast radius), so you can see what it may break. " +
      "Compares the working tree with HEAD, or your branch with --base. Built for CI: --format markdown writes a pull-request comment.",
    examples: ["graft blast", "graft blast --base origin/main --format markdown"],
    globals: QUERY,
  },
  build: {
    description:
      "Build or update the code graph in graft/: the wiring graph (who calls what) and one card per file. " +
      "Free, no API key. Add --deep to also have an LLM write summaries and a concept map; that needs an API key, " +
      "an endpoint and a model: save them once with `graft api key`, `graft api url` and `graft model`, or pass " +
      "--api-key, --base-url and --model (below). --deep only re-summarizes code that changed since the last run; " +
      "add --force to re-summarize everything.",
    examples: ["graft build", "graft build --deep", "graft build --deep --force", "graft build --check"],
    globals: ["dir", "llm"],
  },
  callers: {
    description:
      "List who calls or references a symbol (function, class, method). --direction out lists what it calls instead; " +
      "--depth walks further, to everything a change to it could affect.",
    examples: ["graft callers resolveConfig", "graft callers Engine.graph --depth 2", "graft callers main --direction out"],
    globals: QUERY,
  },
  check: {
    description: "Fail (exit code 1) when graft/ is out of date with the code. Meant for CI.",
    examples: ["graft check", "graft check --json"],
    globals: QUERY,
  },
  config: {
    description:
      "This repo's settings live in .graft/config.json at the repo root: local to your clone (graft adds .graft/ to " +
      ".gitignore) and read by every build and by the automatic refresh before each query, so they apply without " +
      "passing flags again. `graft config list` shows them all; the commands below change one at a time, and " +
      "`graft config <setting> --help` explains what an entry may look like. Each command works on the repo found " +
      "from the current directory (the nearest one with a graft/ index), or on the one --repo names. A change applies " +
      "at the next build, or the refresh before the next query.\n" +
      "Settings: excludeDirs (directories left out of the graph), includeDirs (built-in skipped directories indexed " +
      "anyway), followSubmodules (index Git submodules), followNestedRepos (index nested Git clones), and " +
      "deepStaleThreshold (set with `graft deep-threshold`).",
    examples: ["graft config list", "graft config exclude-dirs --help"],
  },
  "config list": {
    description:
      "Show every setting in .graft/config.json: its value, whether that is the default, what it does, and the " +
      "command that changes it. Each excludeDirs entry says how it matches (name, path or glob).",
    examples: ["graft config list", "graft config list --repo ../other-repo"],
  },
  "config exclude-dirs": {
    description:
      "excludeDirs lists directories to leave out of the graph, on top of the ones graft always skips (dot-directories " +
      "and node_modules, dist, build, _build, out, target, vendor, coverage, __pycache__, venv). Use it for vendored " +
      "code, generated output and asset trees that are real files to Git but noise in a code graph. It wins over " +
      "includeDirs, and unlike includeDirs it also removes files Git tracks.\n" +
      "An entry is one of three forms:\n" +
      "• a NAME with no slash (themes): every directory with that name, at any depth.\n" +
      "• a PATH relative to the repo root (src/themes): that one directory and everything under it.\n" +
      "• a GLOB (contains * or ?), matched against paths relative to the repo root, and so also excluding everything " +
      "under a match. * matches any characters within one path segment, ? exactly one character, and ** any number of " +
      "segments: src/*-old matches src/ui-old, **/generated matches generated directories at any depth below the top " +
      "level (unlike .gitignore, not a top-level one — the bare name generated covers every depth), and gen* only " +
      "top-level directories (add **/gen* for deeper ones). [ ], { } and ! are not wildcards.\n" +
      "Paths must be relative to the repo root: absolute paths (C:\\…, /…) and .. are rejected. Either slash works, " +
      "and a leading ./ or trailing / is dropped (./src/themes/ is stored as src/themes). Matching is case-sensitive, " +
      "on every OS.",
    examples: [
      "graft config exclude-dirs list",
      "graft config exclude-dirs add themes src/legacy \"**/generated\"",
      "graft config exclude-dirs remove src/legacy",
      "graft config exclude-dirs clear",
    ],
  },
  "config exclude-dirs list": {
    description: "Show the excludeDirs entries, each with how it matches: name (any depth), path (from the repo root) or glob.",
    examples: ["graft config exclude-dirs list"],
  },
  "config exclude-dirs add": {
    description:
      "Add one or more entries to excludeDirs; ones already there are skipped. An entry is a NAME (themes: at any " +
      "depth), a root-relative PATH (src/themes: that directory and its subtree) or a GLOB (* within a segment, ? one " +
      "character, ** across segments). Absolute paths and .. are rejected; matching is case-sensitive. Quote globs so " +
      "your shell does not expand them. `graft config exclude-dirs --help` has the details.",
    examples: [
      "graft config exclude-dirs add themes",
      "graft config exclude-dirs add src/legacy \"src/*-old\" \"**/generated\"",
    ],
  },
  "config exclude-dirs remove": {
    description:
      "Remove entries from excludeDirs, written as `graft config exclude-dirs list` shows them (either slash works). " +
      "Exits 1 when none of them was there.",
    examples: ["graft config exclude-dirs remove src/legacy"],
  },
  "config exclude-dirs clear": {
    description: "Remove every excludeDirs entry, so only the built-in skip list applies.",
    examples: ["graft config exclude-dirs clear"],
  },
  "config include-dirs": {
    description:
      "includeDirs lists directories that graft skips by default but that hold real source in this repo, so they " +
      "are indexed after all. Only the built-in skip list can be lifted: node_modules, dist, build, _build, out, " +
      "target, vendor, coverage, __pycache__, venv. Dot-directories (.git, .github, …) are always skipped and cannot " +
      "be included.\n" +
      "An entry is a bare directory NAME, matched at any depth (build lifts every build/ directory). Paths, wildcards, " +
      "absolute paths and dot-names are rejected. Matching is case-sensitive.\n" +
      "In a Git repo, Git's ignore rules still apply: an ignored directory stays out unless its files are tracked. An " +
      "excludeDirs entry wins over an includeDirs one.",
    examples: [
      "graft config include-dirs list",
      "graft config include-dirs add build vendor",
      "graft config include-dirs remove vendor",
      "graft config include-dirs clear",
    ],
  },
  "config include-dirs list": {
    description: "Show the includeDirs entries; an entry that is not in the built-in skip list (and so changes nothing) is flagged.",
    examples: ["graft config include-dirs list"],
  },
  "config include-dirs add": {
    description:
      "Add one or more bare directory names to includeDirs, so those built-in skipped directories (node_modules, dist, " +
      "build, _build, out, target, vendor, coverage, __pycache__, venv) are indexed at any depth. Paths, wildcards and " +
      "dot-directories are rejected. `graft config include-dirs --help` has the details.",
    examples: ["graft config include-dirs add build", "graft config include-dirs add vendor _build"],
  },
  "config include-dirs remove": {
    description: "Remove names from includeDirs, so those directories are skipped again. Exits 1 when none of them was there.",
    examples: ["graft config include-dirs remove build"],
  },
  "config include-dirs clear": {
    description: "Remove every includeDirs entry, so the whole built-in skip list applies again.",
    examples: ["graft config include-dirs clear"],
  },
  "config follow-submodules": {
    description:
      "Show or set followSubmodules. On: initialized Git submodules are indexed into this repo's graph, recursively, " +
      "so calls into them resolve. Off (the default): the graph stops at the submodule boundary. Uninitialized " +
      "submodules are never indexed, and each submodule keeps its own ignore rules. The same as " +
      "`graft build --follow-submodules` / `--no-follow-submodules`.",
    examples: ["graft config follow-submodules", "graft config follow-submodules on"],
  },
  "config follow-nested-repos": {
    description:
      "Show or set followNestedRepos. On: Git clones nested inside this repo that its index does not track — how " +
      "multi-repo tools (west, repo, gclient, tsrc, mr) check dependencies out, or a clone parked in the tree — are " +
      "indexed into one graph with it, so imports across them resolve. Off (the default): they are left out. " +
      "Separate from followSubmodules, which covers clones the parent pins as submodules. Gitignored nested clones " +
      "stay out either way. The same as `graft build --follow-nested-repos` / `--no-follow-nested-repos`.",
    examples: ["graft config follow-nested-repos", "graft config follow-nested-repos off"],
  },
  "deep-threshold": {
    description:
      "Show or set when graft recommends running `graft build --deep`: the percentage of out-of-date summaries " +
      "above which queries suggest it. Per repo, or for every repo with --global. Default 10; 0 = as soon as anything " +
      "is out of date, 100 = never.",
    examples: ["graft deep-threshold", "graft deep-threshold 25", "graft deep-threshold 50 --global"],
    globals: ["dir"],
  },
  effort: {
    description:
      "Show or change GRAFT_REASONING_EFFORT, the thinking / reasoning effort `graft build --deep` asks the model for " +
      "(none, minimal, low, medium, high, xhigh, max). Which levels exist depends on the model, so graft asks the model " +
      "with one tiny request per level and offers only the ones it accepts; run without a level in a terminal to pick " +
      "one. Sent as reasoning_effort to OpenAI-compatible endpoints and as output_config.effort to Anthropic's. While " +
      "it is not set, graft asks for high, and a model that does not take high runs at its own default; " +
      "`graft effort default` sends no effort at all. Saved as a user environment variable.",
    examples: ["graft effort", "graft effort low", "graft effort default", "graft effort --list", "graft effort --unset"],
  },
  env: {
    description:
      "Every environment variable graft reads that you might want to set has its own command (`graft files store`, " +
      "`graft refresh auto`, `graft api retries`, …), the way `graft api key` and `graft model` have theirs; " +
      "`graft env list` shows them all with the variable each one sets. `graft env get|set|unset <NAME>` does the " +
      "same by the variable's name. Values are saved as user environment variables, so new terminals, IDEs (once " +
      "restarted), hooks and MCP servers see them: HKCU\\Environment on Windows, ~/.graft/env.sh (sourced from your " +
      "shell profile) on macOS/Linux. A value set in a terminal still wins there. Each change also prints the line " +
      "that applies it to the current terminal, which a child process cannot change.",
    examples: ["graft env list", "graft env list --set", "graft env get GRAFT_PROFILE_STORE"],
  },
  "env list": {
    description:
      "Show every variable graft reads, grouped by the command that sets it: what it does, what applies when it is " +
      "not set, and its value in this terminal and saved. Switches read as on or off, as graft will act on them. " +
      "--set shows only the ones that have a value.",
    examples: ["graft env list", "graft env list --set", "graft env list --json"],
  },
  "env get": {
    description:
      "Show one variable by its name: what it does, its value in this terminal and saved (and why they differ, if they " +
      "do), what applies when it is not set, what it accepts, and its own command.",
    examples: ["graft env get GRAFT_PROFILE_STORE"],
  },
  "env set": {
    description:
      "Save a variable by its name, exactly as its own command would with that value. A switch takes on/off for the " +
      "feature its command names, not for the variable: `graft env set GRAFT_NO_REFRESH off` turns automatic refresh " +
      "off, the same as `graft refresh auto off`. Names are case-insensitive.",
    examples: ["graft env set GRAFT_PROFILE_STORE off", "graft env set GRAFT_LLM_RETRIES 8", "graft env set GRAFT_API_KEY"],
  },
  "env unset": {
    description: "Remove a saved variable by its name, so what applies when it is not set comes back in new terminals.",
    examples: ["graft env unset GRAFT_DIR"],
  },
  ...envVarHelp(),
  grep: {
    description:
      "Search the indexed files for a regular expression (or plain text with --fixed). Unlike plain grep, every " +
      "occurrence is reported, grouped by the function or class it is in, most connected first.",
    examples: ['graft grep "TODO"', 'graft grep "new Date(" --fixed --in src'],
    globals: QUERY,
  },
  help: {
    description: "Show the help of one command — the same as `graft <command> --help`.",
    examples: ["graft help ask", "graft help config exclude-dirs"],
  },
  init: {
    description:
      "Connect graft to the AI coding agents used in this repo (Claude Code, GitHub Copilot, Cursor, …): writes " +
      "their instruction files, registers the MCP server, installs hooks where supported, and builds the graph. " +
      "In a terminal it asks which agents to set up.",
    examples: ["graft init", "graft init --agents copilot claude", "graft init --dry-run"],
    globals: ["dir"],
  },
  languages: {
    description:
      "List every programming language graft indexes, the level of support each gets on this install, and what " +
      "that level extracts: symbols, calls, imports, inheritance, typed member calls, and the language server " +
      "`graft build --lsp` would use. Levels, best first: full (a hand-written extractor), broad (generic " +
      "tree-sitter tags: symbols and calls), symbols (symbols only), structural (data and markup: keys, elements, " +
      "headings), file-only, and skipped (an optional grammar that is not built). A level below what the language " +
      "can get says why and how to raise it. Free: no repo, no API key, no LLM call.",
    examples: ["graft languages", "graft languages --json"],
  },
  map: {
    description:
      "Get oriented in a repo: its main directories, the central files and symbols in each, and the hotspots, " +
      "sized to fit a small token budget.",
    examples: ["graft map", "graft map --max-dirs 30"],
    globals: QUERY,
  },
  mcp: {
    description:
      "Run graft as an MCP server over stdio, so an AI agent can call it as tools (graft_find_code, " +
      "graft_trace_calls, graft_find_all, graft_file_api, graft_repo_map, graft_check_freshness). Your agent starts " +
      "it; `graft init` sets that up.",
    examples: ["graft mcp", "graft mcp --agent-model claude-sonnet-5.5"],
    globals: QUERY,
  },
  model: {
    description:
      "Show or change GRAFT_MODEL, the model `graft build --deep` uses. Run without an id in a terminal to pick from " +
      "the models the endpoint serves, mid-tier first: a top-tier model is not needed for summaries. Saved as a user " +
      "environment variable, then checked against the endpoint. In a terminal, graft then asks the model which " +
      "thinking efforts it accepts and lets you pick one (see `graft effort`).",
    examples: ["graft model", "graft model claude-haiku-5-5", "graft model --list"],
  },
  models: {
    description:
      "Show what this session's saved tokens are worth under each model your agent offers — useful when graft " +
      "could not tell which model you ran.",
    examples: ["graft models", "graft models --tokens 50000"],
  },
  "prices status": {
    description:
      "Show whether a local copy of LiteLLM's model price catalog is stored and how old it is, and the snapshot of " +
      "that catalog shipped with graft; name a model to see the price graft would use for it. Local only, no network.",
    examples: ["graft prices status", "graft prices status claude-opus-4-5"],
  },
  "prices update": {
    description:
      "Download LiteLLM's public model price catalog and store it locally (~/.graft/prices.json), so savings for " +
      "models graft's built-in table does not list are priced in dollars. One anonymous GET of the whole catalog: " +
      "nothing about you, your repo or your models is sent. Kept until you run it again. graft already ships a " +
      "snapshot of this catalog; whichever of the two is newer is used first.",
    examples: ["graft prices update"],
  },
  savings: {
    description:
      "Show the tokens graft saved in this repo, per model, and their dollar value where a price is known: all time, " +
      "or for one year, month or day. A model with no known price is reported in tokens only, never at a guessed rate. " +
      "--last prints the latest turn's graft calls and the tally to report, for when a savings line was cut out of the output.",
    examples: ["graft savings", "graft savings 2026", "graft savings 2026-09", "graft savings 2026-09-08", "graft savings --last"],
  },
  skeleton: {
    description:
      "Show one file's API: every function, class and method with its signature and line range, without the bodies. " +
      "Much cheaper than reading the file.",
    examples: ["graft skeleton src/engine.ts"],
    globals: QUERY,
  },
  staleness: {
    description:
      "Show how much of the graph's summaries are out of date (changed or new code), which files are the most out " +
      "of date, and whether a `graft build --deep` is worth running yet. Free, no LLM.",
    examples: ["graft staleness", "graft staleness --top 5"],
    globals: ["dir"],
  },
  stats: {
    description:
      "Show this agent session's numbers: how much graft was used instead of reading source files, and the tokens it saved.",
    examples: ["graft stats", "graft stats --json"],
  },
  telemetry: {
    description:
      "Show the status of graft's anonymous usage statistics. Telemetry is permanently disabled in this version: " +
      "nothing is recorded or sent, and it cannot be turned on (`enable` refuses). `debug` shows that nothing is queued.",
    examples: ["graft telemetry", "graft telemetry debug"],
  },
  uninstall: {
    description:
      "Remove everything graft wrote to this repo — the reverse of `graft init`. Without --yes it only lists what it would remove.",
    examples: ["graft uninstall", "graft uninstall --yes"],
  },
  upgrade: {
    description: "Upgrade the globally installed graft to the latest version on npm.",
    examples: ["graft upgrade"],
  },
  version: {
    description: "Show the installed version and the latest version published on npm.",
    examples: ["graft version"],
  },
  where: {
    description:
      "Show where graft keeps the files of the current folder, or of each folder given: the map (cards, INDEX.md, " +
      "the graph and its caches) and the settings file. For a repo whose files are in your profile store " +
      "(~/.graft/repos/<folder>-<hash of the repo path>/, the default for new repos) it names that folder, which " +
      "you can't guess from the repo's name. A folder of several git repos lists each repo. --all lists every folder " +
      "in the profile store with the repo it belongs to, and marks the ones whose repo is gone.",
    examples: ["graft where", "graft where . ../other-repo", "graft where --all", "graft where --json"],
    globals: ["dir"],
  },
  viz: {
    description:
      "Open an interactive view of the graph in your browser, or write it to one self-contained HTML file with --export.",
    examples: ["graft viz", "graft viz --export site"],
    globals: QUERY,
  },
};

/** The command's path below the program, e.g. `api key`. */
function pathOf(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c && c.parent; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

function rootOf(cmd: Command): Command {
  let c = cmd;
  while (c.parent) c = c.parent;
  return c;
}

function argTerm(a: Argument): string {
  const name = `${a.name()}${a.variadic ? "..." : ""}`;
  return a.required ? `<${name}>` : `[${name}]`;
}

/** Word-wrap `text` to `width` columns, every line indented by `indent`. A
 * paragraph that starts with a bullet (`• `) hangs its later lines under the text. */
export function wrap(text: string, width: number, indent: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    const hang = para.startsWith("• ") ? 2 : 0;
    const room = Math.max(20, width - indent);
    let line = "";
    let pad = " ".repeat(indent);
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > room - (pad.length - indent)) {
        lines.push(pad + line);
        line = word;
        pad = " ".repeat(indent + hang);
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(pad + line);
  }
  return lines;
}

/** Two-column rows (term, description), the description wrapped beside the term. */
function rows(items: [string, string][], width: number, indent: number): string[] {
  const termWidth = Math.min(24, Math.max(...items.map(([t]) => t.length)));
  const out: string[] = [];
  for (const [term, desc] of items) {
    const descIndent = indent + termWidth + 2;
    const wrapped = desc ? wrap(desc, width, descIndent) : [""];
    if (term.length > termWidth) {
      out.push(" ".repeat(indent) + term);
      if (desc) out.push(...wrapped);
    } else {
      out.push(" ".repeat(indent) + term.padEnd(termWidth + 2) + wrapped[0]!.trimStart());
      out.push(...wrapped.slice(1));
    }
  }
  return out;
}

function globalOptions(cmd: Command, groups: GlobalGroup[] | undefined): Option[] {
  const root = rootOf(cmd);
  const flags = (groups ?? []).flatMap((g) => GLOBAL_FLAGS[g]);
  return flags.map((f) => root.options.find((o) => o.long === f)).filter((o): o is Option => Boolean(o));
}

/**
 * One command's entry. `prefix` is the program name for `graft <command> --help`
 * and empty inside the list, where entries sit under "Commands:".
 */
export function formatCommandEntry(cmd: Command, helper: Help, width: number, prefix = "", path = pathOf(cmd)): string[] {
  const extra = GRAFT_HELP[path];
  const own = cmd.options.filter((o) => !o.hidden && o.long !== "--help");
  const options = [...own, ...globalOptions(cmd, extra?.globals)];
  const args = cmd.registeredArguments;
  const head = [prefix, path, ...args.map(argTerm), options.length ? "[options]" : ""].filter(Boolean).join(" ");

  const lines = [`  ${head}`];
  lines.push(...wrap(extra?.description ?? cmd.description(), width, 6));
  const described = args.filter((a) => helper.argumentDescription(a));
  if (described.length) {
    lines.push("      Arguments:");
    lines.push(...rows(described.map((a) => [argTerm(a), helper.argumentDescription(a)]), width, 8));
  }
  if (options.length) {
    lines.push("      Options:");
    lines.push(...rows(options.map((o) => [helper.optionTerm(o), helper.optionDescription(o)]), width, 8));
  }
  if (extra?.examples.length) lines.push(...examplesOf(extra));
  return lines;
}

/** Every listed command under `root` with its full path (`api key`, `config exclude-dirs add`),
 * subcommands expanded, A→Z. From the program, commander's implicit `help` is listed once. */
export function listedCommands(root: Command, helper: Help): { cmd: Command; path: string }[] {
  const out: { cmd: Command; path: string }[] = [];
  const walk = (cmd: Command, parentPath: string) => {
    for (const c of helper.visibleCommands(cmd)) {
      // Commander's implicit `help` is not in `.commands`; list it once, at the top.
      const implicitHelp = !(cmd.commands as Command[]).includes(c);
      if (implicitHelp && (parentPath || cmd.parent)) continue;
      const path = parentPath ? `${parentPath} ${c.name()}` : c.name();
      if (c.commands.length > 0) walk(c, path);
      else out.push({ cmd: c, path });
    }
  };
  walk(root, pathOf(root));
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function examplesOf(h: CommandHelp): string[] {
  if (!h.examples.length) return [];
  return [h.examples.length === 1 ? "      Example:" : "      Examples:", ...h.examples.map((e) => `        ${e}`)];
}

function helpWidth(helper: Help): number {
  const w = (helper as unknown as { helpWidth?: number }).helpWidth ?? process.stdout.columns ?? 100;
  return Math.max(60, Math.min(w, 120));
}

/**
 * Wire graft's help into `program` and every command under it. Call once, after
 * every command is registered.
 */
export function installGraftHelp(program: Command): void {
  const configure = (cmd: Command): void => {
    if (cmd === program) {
      cmd.configureHelp({
        formatHelp: (_c, helper) => {
          const width = helpWidth(helper);
          const entries = listedCommands(program, helper).map(({ cmd: c, path }) =>
            formatCommandEntry(c, helper, width, "", path).join("\n"),
          );
          return `Commands:\n${entries.join("\n\n")}\n`;
        },
      });
    } else if (cmd.commands.length > 0) {
      // A command group (`api`, `config`, `config exclude-dirs`): its own intro
      // when it has one — what the setting means, what an entry may look like —
      // then every command under it, nested groups expanded.
      cmd.configureHelp({
        formatHelp: (c, helper) => {
          const width = helpWidth(helper);
          const intro = GRAFT_HELP[pathOf(c)];
          const head = intro
            ? [`  ${program.name()} ${pathOf(c)}`, ...wrap(intro.description, width, 6), ...examplesOf(intro)].join("\n") + "\n\n"
            : "";
          const subs = listedCommands(c, helper);
          return `${head}${subs.map(({ cmd: s, path }) => formatCommandEntry(s, helper, width, program.name(), path).join("\n")).join("\n\n")}\n`;
        },
      });
    } else {
      cmd.configureHelp({
        formatHelp: (c, helper) => `${formatCommandEntry(c, helper, helpWidth(helper), program.name()).join("\n")}\n`,
      });
    }
    for (const sub of cmd.commands as Command[]) configure(sub);
  };
  configure(program);
  showHelpOnUnknownCommand(program);
}

/**
 * `graft foo` (and `graft api foo`): after commander's `unknown command` error and
 * its "Did you mean …?", print the help of the command that was mistyped under,
 * to stderr, so the available commands are right there. Other errors (a missing
 * argument, an unknown option) stay one line.
 */
function showHelpOnUnknownCommand(cmd: Command): void {
  if (cmd.commands.length === 0) return;
  const error = cmd.error.bind(cmd);
  cmd.error = (message, errorOptions) => {
    if (errorOptions?.code === "commander.unknownCommand") cmd.showHelpAfterError(true);
    return error(message, errorOptions);
  };
  for (const sub of cmd.commands as Command[]) showHelpOnUnknownCommand(sub);
}
