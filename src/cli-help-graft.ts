/**
 * graft's help screens (the `graft` name only; `trail` keeps commander's grouped help).
 *
 * `graft --help` is the command list, A→Z, closed by a short list of the common
 * commands and a pointer to `graft <command> --help`. Every entry is complete on its
 * own: what the command does in plain words, its arguments, ALL of its options —
 * including the global ones (`--dir`, `--agent-model`, the LLM options) on exactly
 * the commands they affect — and examples. `graft <command> --help` prints that
 * same entry. Arguments and options are read from commander, so this never drifts
 * from the code; only the prose and the examples live here.
 */
import type { Argument, Command, Help, Option } from "commander";
import { choices, ENV_GROUPS, ENV_VARS } from "./env-cli.js";
import { DATABRICKS_BASE_URL } from "./ai/llm/databricks.js";

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
  about: {
    description:
      "Find information about graft. Without a target it prints what graft is for, the project homepage " +
      "(https://github.com/trailhq/Trail-Code), the fork homepage " +
      "(https://github-ct.int.automotive-wan.com/pages/suciui/Graft/), which is the fork changelog: every " +
      "change this fork makes that upstream does not have, newest first, and where to download the " +
      "fork's Windows offline installer kit, the latest or any published build " +
      "(https://github-ct.int.automotive-wan.com/suciui/Graft/releases). " +
      "`graft about home` opens the project homepage in your browser, `graft about web` the fork homepage, and " +
      "`graft about fork` the changelog copy of this build (the fork homepage when this installation has none). " +
      "The addresses are also printed, in case no browser opens (or GRAFT_NO_BROWSER is set). " +
      "Nothing is sent: it only opens a page. `graft info` is the same command.",
    examples: ["graft about", "graft about home", "graft about web", "graft about fork"],
  },
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
      `(default: the Databricks AI Gateway, ${DATABRICKS_BASE_URL}). Saved as a user environment variable, then checked against the endpoint.`,
    examples: ["graft api url", `graft api url ${DATABRICKS_BASE_URL}`],
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
      "add --force to re-summarize everything. Before building, when the map goes to the folder graft keeps generated " +
      "files in (`graft files location`) and that folder is on drive C: with less than 20 GB free, or its drive may not " +
      "have room for the map with a safe margin (estimated from the source it indexes), graft suggests moving that " +
      "folder with `graft files location <folder>`; the build goes on either way.",
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
      "anyway), followSubmodules (index Git submodules), followNestedRepos (index nested Git clones), indexText (index .txt files in chunks), indexTextDirs (the folders " +
      "indexText takes them from), indexTextExtensions (more extensions indexed like .txt, set with " +
      "`graft config index-text add`), and " +
      "deepStaleThreshold (set with `graft deep-threshold`) and autoDeep (set with `graft auto-deep`).",
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
  "config index-text": {
    description:
      "Show or set indexText. On: plain-text .txt files are indexed — each one cut into chunks of a few hundred " +
      "lines, at its headings where it has any (underlined, numbered or ALL-CAPS lines), else at blank lines — and " +
      "every chunk becomes a node with its own line span, so `graft ask` and `graft grep` point at the part of a " +
      "large log, spec or dump that matters instead of the whole file. Text files up to 50 MB are read; a file " +
      "with very many chunks gets a table of contents on its card instead of a line per chunk. Text chunks are " +
      "never summarized by `graft build --deep`, so they cost no AI tokens. CMakeLists.txt stays CMake. Off (the " +
      "default): no .txt file is indexed. The same as `graft build --index-text` / `--no-index-text`.\n" +
      "On indexes every .txt file in the repository; to take them from some folders only, list those folders with " +
      "`graft config index-text-dirs add <folder>`. To index other plain-text files the same way (.log, .out, .lst, " +
      "...), add their extensions with `graft config index-text add <ext>` (indexTextExtensions). Shown without a " +
      "value, the setting also names those extensions and folders.",
    examples: [
      "graft config index-text",
      "graft config index-text on",
      "graft config index-text add .log .out",
      "graft config index-text-dirs add docs/specs",
    ],
  },
  "config index-text list": {
    description:
      "Show the indexTextExtensions: the extensions indexed as plain text on top of .txt. An entry graft ignores " +
      "(one it parses as code or data, or a malformed one written into .graft/config.json by hand) is flagged.",
    examples: ["graft config index-text list"],
  },
  "config index-text add": {
    description:
      "Add one or more file extensions to indexTextExtensions, and turn indexText on: files with them are then " +
      "indexed like .txt files — cut into chunks with their own line spans, up to 50 MB a file, under the " +
      "indexTextDirs folders when it lists any, never summarized by --deep. The dot is optional and case does not " +
      "matter (log, .LOG and .log are the same). Only extensions graft does not parse are accepted: .md, .json, " +
      ".xml, .c and the rest stay with their parsers (`graft languages` lists them). .txt is plain text anyway.",
    examples: ["graft config index-text add .log", "graft config index-text add log out lst"],
  },
  "config index-text remove": {
    description:
      "Remove extensions from indexTextExtensions, so files with them are no longer indexed. .txt files stay " +
      "indexed while indexText is on; `graft config index-text off` stops indexing text. Exits 1 when none of " +
      "them was there.",
    examples: ["graft config index-text remove .out"],
  },
  "config index-text clear": {
    description: "Remove every indexTextExtensions entry, so only .txt files are indexed as plain text.",
    examples: ["graft config index-text clear"],
  },
  "config index-text-dirs": {
    description:
      "indexTextDirs lists the folders indexText takes plain-text files (.txt and indexTextExtensions) from, so a repo can index its specs or " +
      "logs without every requirements.txt, LICENSE.txt and test fixture elsewhere. Code is indexed everywhere either " +
      "way. Empty (the default): with indexText on, every .txt file in the repository is indexed.\n" +
      "An entry is a folder PATH relative to the repo root (docs/specs): that folder and everything under it. Absolute " +
      "paths, .. and wildcards are rejected. Either slash works, and a leading ./ or trailing / is dropped. Matching is " +
      "case-sensitive, on every OS.\n" +
      "Adding a folder turns indexText on. Turning indexText off keeps the list, so turning it back on restores the " +
      "same folders. The same as `graft build --index-text-dir <folder>` (repeatable), which replaces the list.",
    examples: [
      "graft config index-text-dirs list",
      "graft config index-text-dirs add docs/specs logs/nightly",
      "graft config index-text-dirs remove logs/nightly",
      "graft config index-text-dirs clear",
    ],
  },
  "config index-text-dirs list": {
    description: "Show the indexTextDirs folders; a folder that does not exist in the repo is flagged.",
    examples: ["graft config index-text-dirs list"],
  },
  "config index-text-dirs add": {
    description:
      "Add one or more folders (paths relative to the repo root) to indexTextDirs, and turn indexText on: .txt files " +
      "are then indexed from those folders and their subfolders only. Absolute paths, .. and wildcards are rejected.",
    examples: ["graft config index-text-dirs add docs/specs", "graft config index-text-dirs add docs/specs logs"],
  },
  "config index-text-dirs remove": {
    description:
      "Remove folders from indexTextDirs. Removing the last one leaves indexText on for the whole repository; " +
      "`graft config index-text off` stops indexing text. Exits 1 when none of them was there.",
    examples: ["graft config index-text-dirs remove logs"],
  },
  "config index-text-dirs clear": {
    description:
      "Remove every indexTextDirs folder. With indexText on, every .txt file in the repository is then indexed.",
    examples: ["graft config index-text-dirs clear"],
  },
  "deep-threshold": {
    description:
      "Show or set when graft recommends running `graft build --deep`: the percentage of out-of-date summaries " +
      "above which queries suggest it. Per repo, or for every repo with --global. Default 10; 0 = as soon as anything " +
      "is out of date, 100 = never.",
    examples: ["graft deep-threshold", "graft deep-threshold 25", "graft deep-threshold 50 --global"],
    globals: ["dir"],
  },
  "auto-deep": {
    description:
      "Show or set whether `graft build --deep` runs by itself. On, a graft query that finds the share of out-of-date " +
      "summaries at or above the deep-threshold (`graft deep-threshold`) starts a deep build in the background, and the " +
      "\"run graft build --deep\" recommendation is no longer shown. Every run is an LLM pass that spends AI tokens without " +
      "asking, so turning it on prints a cost warning and asks to confirm (--yes confirms without a terminal). One run at a " +
      "time; a failed run is reported on every query and not retried until a manual `graft build --deep` succeeds or " +
      "auto-deep is turned on again. Per repo, or for every repo with --global. Default off. With no state, shows the " +
      "setting and how the last automatic run went.",
    examples: ["graft auto-deep", "graft auto-deep on", "graft auto-deep off", "graft auto-deep on --global --yes"],
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
  "files location": {
    description:
      "Choose the folder every repo's generated files are kept in, and move the ones already there. Each repo has its " +
      "own <folder>-<hash of the repo path> folder (its map, its settings and repo.json), by default under " +
      "~/.graft/repos; the folder you name becomes their parent, so every repo keeps its own folder and finds it again " +
      "from its path. Every repo folder graft knows of moves: from the current location, from the folders " +
      "GRAFT_PROFILE_STORE or ~/.graft/settings.json name, from ~/.graft/repos, and from each --from folder. The new " +
      "location is saved as \"profileStore\" in ~/.graft/settings.json, so all current repos and every new one use it, " +
      "including hooks and MCP servers already running; a saved GRAFT_PROFILE_STORE, which would win over it, is removed. " +
      "Before anything moves, graft checks that the destination has room: folders on the same drive are renamed and need " +
      "no space, folders on another drive are copied, so their size on disk plus 5% must be free there. " +
      "If there is not enough space, a build is running in one of them, or the destination is inside the current " +
      "location, nothing is moved and nothing changes. The move is all or nothing: every folder on another drive is " +
      "copied and checked first, then the ones on the same drive are renamed, and only when every folder has arrived is " +
      "the new location saved and are the copied originals deleted from the old one; if any folder cannot be brought " +
      "over, everything is put back and nothing is deleted. A folder of the same name already at the destination is kept and " +
      "the old one left in place. Maps kept inside a repo (graft/) are not moved; --dir and GRAFT_DIR still win. Without a " +
      "folder it shows the current location; --default moves everything back to ~/.graft/repos. `graft build` suggests " +
      "this command when the location is on drive C: with less than 20 GB free, or its drive may not have room for the map it builds.",
    examples: [
      "graft files location",
      "graft files location D:\\graft-maps --dry-run",
      "graft files location D:\\graft-maps",
      "graft files location --default",
    ],
  },
  "find-command": {
    description:
      "Search the commands for a keyword: every command whose name or description contains it (case-insensitive; " +
      "several words are searched as one phrase). Lists the commands found — the ones matched by name first — then " +
      "prints each one's full help, the same entry `graft help` shows. Exits 1 when no command matches.",
    examples: ["graft find-command deep", "graft find-command api key", 'graft find-command "environment variable"'],
  },
  grep: {
    description:
      "Search the indexed files for a regular expression (or plain text with --fixed). Unlike plain grep, every " +
      "occurrence is reported, grouped by the function or class it is in, most connected first.",
    examples: ['graft grep "TODO"', 'graft grep "new Date(" --fixed --in src'],
    globals: QUERY,
  },
  help: {
    description:
      "Show the help of one command — the same as `graft <command> --help`. To find a command by a word in its " +
      "name or description, use `graft find-command <keyword>`.",
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
  issues: {
    description:
      "Open the issue tracker of this graft build in your browser, where you can report a bug or request a feature: " +
      "https://github-ct.int.automotive-wan.com/suciui/graft/issues. The address is also printed, in case no " +
      "browser opens (or GRAFT_NO_BROWSER is set). Nothing is sent: it only opens the page.",
    examples: ["graft issues"],
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
  parts: {
    description:
      "List the parts a repository too big for one map was built in (`graft build --all-parts`, or `all` in the " +
      "list a too-big build offers), so you know their names. A part is named by its folder's path from the repo " +
      "root, exactly as listed: narrow `graft ask`, `graft grep` and `graft callers` to one with `--in <part>/` (over " +
      "MCP, the `in` argument), or name it in a prompt to your AI assistant. For each part: the files its map holds, " +
      "the map's size and when it was built, or that it is not built yet or its folder is gone; and whether the links " +
      "between the parts are up to date. Run inside a part, it still lists every part of the repository and marks " +
      "the one you are in. A folder of separate repos lists its repos the same way; a repository with one map says " +
      "so. --json adds the folder each part's map is kept in. Free: no LLM, nothing rebuilt, no graph loaded.",
    examples: ["graft parts", "graft parts --json", "graft parts path/to/repo"],
    globals: ["dir"],
  },
  "prices status": {
    description:
      "Show whether a local copy of LiteLLM's model price catalog is stored and how old it is, and the snapshot of " +
      "that catalog shipped with graft, and whether graft updates it by itself when a model has no known price " +
      "(`graft prices auto`); name a model to see the price graft would use for it. Local only, no network.",
    examples: ["graft prices status", "graft prices status claude-opus-4-5"],
  },
  "prices update": {
    description:
      "Download LiteLLM's public model price catalog and store it locally (~/.graft/prices.json), so savings for " +
      "models graft's built-in table does not list are priced in dollars. One anonymous GET of the whole catalog, " +
      "a public .json file hosted on GitHub: no code, prompts, model names, keys or anything else about you or your repo is sent. Kept until you run it again. graft already ships a " +
      "snapshot of this catalog; whichever of the two is newer is used first. Once you chose automatic price updates in " +
      "the Windows installer (or turned `graft prices auto` on), graft also runs it by itself when a model has no known " +
      "price; `graft prices auto off` stops that.",
    examples: ["graft prices update"],
  },
  savings: {
    description:
      "Show the tokens graft saved in this repo, per model, and their dollar value where a price is known: all time, " +
      "or for one year, month or day. A model with no known price is reported in tokens only, never at a guessed rate. " +
      "--last prints the latest turn's graft calls and the tally to report, for when a savings line was cut out of the output.",
    examples: ["graft savings", "graft savings 2026", "graft savings 2026-09", "graft savings 2026-09-08", "graft savings --last"],
  },
  "savings-report": {
    description:
      "Opt-in, off until you run `graft savings-report enable`: also send each saving and billing entry graft records " +
      "to the company's Oracle database for analytics. A row holds a random install id, the day and time, the model, " +
      "the tokens saved or billed, their dollar value, which graft surface (cli / mcp / hook) and command filed it, and " +
      "which AI assistant and editor or terminal ran graft, with their versions (e.g. Kilo Code 7.8.18 in Visual Studio " +
      "Code 1.144.0) — no repo name or path, user name, machine host name, file name or query text. Rows are queued in ~/.graft/ and sent by a " +
      "background process at most every 5 minutes; normal commands never wait on it or show its errors. `disable` stops " +
      "it and discards what was not sent; `flush` sends now and prints the outcome; `status` shows the install id, the " +
      "database, the queue and the last send. The database can turn reporting off (DISABLE_COST_SAVINGS_REPORTING in " +
      "GRAFT_REPORTING_SETTINGS); that is checked before every send and turns it off on this machine too.",
    examples: ["graft savings-report", "graft savings-report enable", "graft savings-report flush", "graft savings-report disable"],
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
    description:
      "Disabled in this fork: it installs nothing and exits with an error. New versions ship as the offline installer " +
      "kit: download the latest one from the fork's release page " +
      "(https://github-ct.int.automotive-wan.com/suciui/Graft/releases), unzip it and run " +
      "START-HERE-install-graft.cmd.",
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

/** A command found by `graft find-command`, and where the keyword was found. */
export interface CommandMatch {
  cmd: Command;
  path: string;
  inName: boolean;
  inDescription: boolean;
}

/** Lower-cased, every run of whitespace one space, so a phrase matches across a wrapped line. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Every listed command (as `graft help` lists them) whose name — its full path or
 * an alias — or whose description (the one its help shows) contains `keyword`,
 * case-insensitive. Name matches come first, then description-only ones; A→Z within each.
 */
export function searchCommands(program: Command, helper: Help, keyword: string): CommandMatch[] {
  const needle = normalize(keyword);
  if (!needle) return [];
  const found: CommandMatch[] = [];
  for (const { cmd, path } of listedCommands(program, helper)) {
    const parent = path.includes(" ") ? path.slice(0, path.lastIndexOf(" ") + 1) : "";
    const names = [path, ...cmd.aliases().map((a) => parent + a)];
    const inName = names.some((n) => normalize(n).includes(needle));
    const inDescription = normalize(GRAFT_HELP[path]?.description ?? cmd.description()).includes(needle);
    if (inName || inDescription) found.push({ cmd, path, inName, inDescription });
  }
  return [...found.filter((m) => m.inName), ...found.filter((m) => !m.inName)];
}

/**
 * The `graft find-command` report: the commands found, each with where the keyword
 * was found, then each one's full help entry, exactly as `graft <command> --help`
 * prints it. Null when nothing matched.
 */
export function formatCommandSearch(program: Command, helper: Help, keyword: string): string | null {
  const matches = searchCommands(program, helper, keyword);
  if (!matches.length) return null;
  const width = helpWidth(helper);
  const shown = normalize(keyword);
  const count = `${matches.length} command${matches.length === 1 ? "" : "s"}`;
  const list = rows(
    matches.map((m) => [m.path, [m.inName && "name", m.inDescription && "description"].filter(Boolean).join(", ")]),
    width,
    2,
  );
  const entries = matches.map((m) => formatCommandEntry(m.cmd, helper, width, program.name(), m.path).join("\n"));
  return `Found ${count} matching "${shown}" (in the name or description):\n${list.join("\n")}\n\n${entries.join("\n\n")}\n`;
}

function examplesOf(h: CommandHelp): string[] {
  if (!h.examples.length) return [];
  return [h.examples.length === 1 ? "      Example:" : "      Examples:", ...h.examples.map((e) => `        ${e}`)];
}

/**
 * The most used / suggested commands, listed after the full command list of
 * `graft help` with a one-line description each. Keyed by command path.
 */
export const COMMON_COMMANDS: [string, string][] = [
  ["find-command", "find a command by a word in its name or description"],
  ["model", "show or pick the model `build --deep` uses"],
  ["build", "build or update the graph; --deep adds LLM summaries"],
  ["parts", "list the parts a big repo is built in, to name in prompts"],
  ["deep-threshold", "show or set when `build --deep` is recommended"],
  ["staleness", "show how out of date the summaries are"],
  ["config", "show or change this repo's settings"],
  ["savings", "show the tokens (and dollars) graft saved"],
  ["files location", "show or move the folder generated files are kept in"],
  ["about", "show the homepage, fork changelog and issue tracker"],
];

/**
 * The closing paragraph of `graft help`: the common commands (only the ones
 * registered on `program`), then where to read more about any one of them.
 */
export function commonCommandsSection(program: Command, width: number): string {
  const exists = (path: string): boolean => {
    let cmd: Command | undefined = program;
    for (const name of path.split(" ")) {
      cmd = (cmd?.commands as Command[] | undefined)?.find((c) => c.name() === name || c.aliases().includes(name));
    }
    return Boolean(cmd);
  };
  const name = program.name();
  const items = COMMON_COMMANDS.filter(([path]) => exists(path)).map(([path, desc]): [string, string] => [`${name} ${path}`, desc]);
  const more = wrap(`More about any command: \`${name} <command> --help\` (or \`${name} help <command>\`).`, width, 0);
  return [...(items.length ? ["Common commands:", ...rows(items, width, 2), ""] : []), ...more].join("\n") + "\n";
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
          return `Commands:\n${entries.join("\n\n")}\n\n${commonCommandsSection(program, width)}`;
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
  hintOnUsageError(program);
}

/**
 * The line added under commander's error (and its "Did you mean …?") when a
 * command or a parameter is not known, or null for any other error, which stays
 * as commander prints it:
 *
 * - `graft foo`: the command is unknown; `graft help` lists them all.
 * - `graft api foo`: unknown under the `api` group; `graft api --help` lists its commands.
 * - `graft build --nope`, `graft upgrade extra`: the parameter is unknown;
 *   `graft build --help` tells what that command takes.
 *
 * Only the hint is printed, never the help itself.
 */
export function usageErrorHint(cmd: Command, code: string | undefined): string | null {
  const name = rootOf(cmd).name();
  const path = pathOf(cmd);
  if (code === "commander.unknownCommand") {
    return path
      ? `Run \`${name} ${path} --help\` for the list of available \`${path}\` commands.`
      : `Run \`${name} help\` for the list of available commands.`;
  }
  if (code === "commander.unknownOption" || code === "commander.excessArguments") {
    return path
      ? `Run \`${name} ${path} --help\` for more info about this command.`
      : `Run \`${name} help\` for the list of available commands.`;
  }
  return null;
}

/** Wire `usageErrorHint` into `cmd` and every command under it. */
function hintOnUsageError(cmd: Command): void {
  const error = cmd.error.bind(cmd);
  cmd.error = (message, errorOptions) => {
    const hint = usageErrorHint(cmd, errorOptions?.code);
    return error(hint ? `${message}\n${hint}` : message, errorOptions);
  };
  for (const sub of cmd.commands as Command[]) hintOnUsageError(sub);
}
