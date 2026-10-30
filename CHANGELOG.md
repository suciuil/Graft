# Changelog

## Unreleased

### Added

- **Profile store, on by default: a repo's map and settings live in your
  profile.** A repo that has no `graft/` map and no `.graft/config.json` yet
  gets them in `~/.graft/repos/<folder>-<hash of the repo path>/` (`graph/` and
  `config.json`). graft finds them again from the repo's path, so nothing is
  written into the checkout, including `.gitignore` and `.ignore`. A map or
  settings file already in the repo always wins and is never moved, so existing
  repos keep working as before. `GRAFT_PROFILE_STORE=0` (or
  `"profileStore": false` in `~/.graft/settings.json`) restores `<repo>/graft/`
  for new repos. An absolute folder puts the store there instead. `--dir` and
  `GRAFT_DIR` still take precedence. The home folder used as a repo keeps
  `graft/`. `graft savings --all` and `graft retract` know about the store.
- **Every environment variable graft reads has its own command**, like
  `graft api key` and `graft model`, with a full description in `--help` and in
  `graft --help`. Run with no value, a command shows the variable. With a value
  it saves it, and `--unset` removes it. Switches take on/off for the feature
  the command names, not for the variable, so `graft refresh auto off` saves
  `GRAFT_NO_REFRESH=1`. The commands, grouped:
  - `graft files store` (GRAFT_PROFILE_STORE)
  - `files map-dir` (GRAFT_DIR)
  - `files repos-list` (GRAFT_REPOS_FILE)
  - `api provider`, `retries`, `tool-rescues`, `balance-wait`, `balance-poll`,
    `balance-backoff`, `balance-backoff-max`, `openrouter-model`, `system-ca`
  - `prices file`, `prices bundled`
  - `refresh auto`, `hash`, `seed`, `gitignore`, `ignore-file`
  - `agents gate`, `statusline`, `npx`, `trail-switch`
  - `output savings-copy`, `rename-notice`, `browser`

  Values are saved as user environment variables (HKCU\Environment on Windows,
  `~/.graft/env.sh` elsewhere), the same place `graft api key` uses, so new
  terminals, IDEs, hooks and MCP servers see them. Each value is checked before
  it is saved. Each change prints the line that applies it to the current
  terminal. `graft env list` shows all of them with their command, default and
  current values. `graft env get|set|unset <NAME>` does the same by the
  variable's name. Secrets are always masked. Test seams, internal variables,
  and every switch that would send data off the machine (telemetry, Trail
  cloud, `TRAIL_NO_LOOK_BACK`, `TRAIL_NO_FETCH`) have no command.
- **`graft where`: shows where a repo's files are kept.** For the current
  folder, or each folder given, it prints the map folder and the settings file,
  whether each is in your profile store or inside the repo, and whether each
  exists yet. For a repo using the profile store, that is the store folder
  whose name you can't guess from the repo's name. A folder of several git
  repos lists each repo. `--all` lists every folder in the profile store with
  the repo it belongs to, and marks the ones whose repo is gone. `--json`
  outputs the same data.
- **Savings are no longer lost when an agent pipes graft's output.** An agent
  that ran graft through `Select-Object -First`, `head`, `Select-String` or
  `findstr` cut the savings line out with everything else, and then had to say
  it had no figures to report. Four changes fix this:
  - Every agent's instructions (Copilot, Cursor, Kiro, Windsurf, Kilo,
    AGENTS.md), not only the Claude skill, now say never to pipe or filter
    graft output, naming the PowerShell filters too, and how to recover if it
    happens anyway. Run `graft init` to pick up the new instructions.
  - **`graft savings --last`** prints the latest turn's graft calls in this repo
    and the summed tally to close a reply with. It uses the figures the footers
    printed and doesn't recompute anything. `--json` outputs the same data. The
    calls are kept in `graft/.cache/recent-calls.json`, capped at 50 calls and
    24 hours.
  - When stdout is piped, the CLI repeats the savings figure and the example
    tally on stderr, which the pipe can't filter. The copy uses a different
    wording from the `[graft] tokens saved ≈ N` footer, so a host that reads
    both streams together still counts the call once. It is off under Claude
    Code, whose hooks already keep the count, and `GRAFT_STDERR_SAVINGS=0`
    turns it off anywhere else.
  - A graft call made within 10 minutes of another one in the same repo gets a
    short savings footer: the figure, its dollar value and the example tally,
    without the paragraph the agent has just read. The warning lines stay in the
    example. Repeating the long footer on every call is what made agents filter
    it out.

- **`graft savings --all`: savings added up across every repo.** Each repo
  still keeps its own ledger (`graft/.cache/savings.json`). Now, whenever graft
  records a saving in a repo, it also adds that folder to `~/.graft/repos.json`
  in your profile (at most one write per repo per day). `graft savings --all
  [period]` reads every folder on that list and prints each repo's total, a
  per-model breakdown and one grand total, in tokens, with dollars wherever a
  rate is known. Each repo is priced at its own rate, so one repo's billing
  never re-prices another's, and the per-repo lines add up to the total. If a
  listed folder's ledger is gone, the report names the folder and leaves it out
  of the totals. `--json` outputs the same data. `GRAFT_REPOS_FILE` points the
  list at another file.
- **Repos you used graft in before this version are found automatically.** The
  first `graft savings --all` also looks through the folders your agents
  remember working in: Claude Code's project list (`~/.claude.json`), Kilo's
  sessions, VS Code / Cursor / Windsurf / VSCodium workspaces, JetBrains IDEs'
  recent projects, and the working folders of Codex sessions. Any of those
  folders (or a parent folder) that holds a graft savings ledger is added to
  the list, dated by its own history. This scan runs once. After that, each
  repo adds itself when it records a saving. `--discover` scans again;
  `--no-discover` skips the scan. It only reads files, never writes into the
  hosts' files, and takes well under a second.

### Changed

- **The default model is `claude-haiku-5-5` on every provider.** When neither
  `--model` nor `GRAFT_MODEL` names one, `graft build --deep` uses
  `claude-haiku-5-5` (falling back to the `claude-haiku-5.5` spelling when a
  gateway does not serve the first), instead of `google/gemini-3.8-flash` on
  OpenAI-compatible endpoints. `graft model` and the failure hints now recommend
  the latest Claude Haiku an endpoint serves first, then Claude Sonnet, then
  Gemini Flash, then GPT terra, and give `claude-haiku-5.5` as the first example
  id. `graft init`'s look-back, its skill-naming call and the PR-review read use
  `claude-haiku-5-5` too.

### Fixed

- **Databricks GPT models without a `model_service.models.1adp-*` id work.**
  `databricks-gpt-*` ids (for example `databricks-gpt-6-astra` and
  `databricks-gpt-5-mini`, which have no service id) now go to the gateway's
  OpenAI route (`/ai-gateway/openai/v1`). Before, they went to
  `/serving-endpoints`, which refuses them with "rate limit set to 0". Each GPT
  model's two names now fall back to each other, including when the gateway
  refuses one of them with a 403 "rate limit set to 0" (as it does for
  `databricks-gpt-5-5`). `graft model` now lists the OpenAI route's models. The
  route has no working model list, so graft takes the GPT endpoints from the
  workspace's serving registry and checks each one with a request that has no
  messages, so no tokens are spent. Models that only support the Responses API
  are left out.
- **Databricks model ids are priced and grouped as the vendor's model.**
  `model_service.models.1adp-opus-5-5`, `databricks-claude-opus-5-5` and
  `claude-opus-5-5` are now priced as Claude Opus 5.5 and recorded as one
  ledger row. Previously the first two were unpriced and each got its own row.
  This applies to Claude, GPT, Gemini, Codex and o-series models. Models that
  Databricks hosts itself (`databricks-meta-llama-…`) keep their own id and price.
  Picking the latest model also no longer reads the `1` of `1adp` as the version.
- **Forks of Kilo Code are recognised.** graft now also looks for a Kilo 5.x
  `secrets.json` under VS Code Insiders' storage and under the
  `automotive.kilo-code` extension id. The CLI also reads the running model
  from Kilo's session when it runs in a shell started by Kilo's agent
  (`KILO=1`), not only over MCP.
- **A Claude Code tool call no longer hangs when the host leaves stdin open.**
  The `pre-tool` hook (the gate before every Read, Grep and shell call) read its
  payload with a blocking read that never returned when stdin wasn't closed, so
  the call stalled until the host killed the hook. The `pre-bash` hook had the
  same problem on Windows, where a pending pipe read can't be cancelled. Both
  now give up after 2 seconds and exit 0, which lets the call through.
- **Fewer lost writes on Windows.** graft and Trail save files by writing a
  temp file and renaming it over the old one. On Windows that rename fails while
  another process, such as antivirus or the search indexer, has the file open
  for a moment, and the write was lost. The rename is now retried for about a
  quarter of a second. This covers the savings ledger, stats and session files,
  Trail's state files, the graph, the summaries cache and the review page store.
  A file that stays locked still fails the write, as before.
- **The test suite runs on Windows.** Several tests used POSIX-only commands
  (`rm`, `ps`, `mkdir -p`), depended on the machine's own Kilo config or on Go
  being installed, or were too tightly timed for a loaded machine. `npm test`
  now skips the Trail cloud test files, since cloud is permanently disabled.
  `CLOUD_TESTS=1` runs them anyway.
- **Trail's look-back and fetching are off by default.** The look-back has
  `trail init` read your past Claude Code sessions and send what it finds to
  Claude. Fetching covers `git fetch origin`, `gh pr list`, and the read of
  merged PRs' review comments, which also go to Claude. Both now behave as if
  `TRAIL_NO_LOOK_BACK=1` and `TRAIL_NO_FETCH=1` were set. Set the variable to
  `0` to turn a feature back on. Any value other than `0` keeps it off. Before,
  `TRAIL_NO_FETCH=0` turned some fetching off and left the rest on; now every
  part gives the same answer. `npm test` sets both to `0`, because the suite
  tests these features.
- **A written no-cloud policy for this fork.** `docs/no-cloud-policy.md` sets
  four rules for every AI agent and contributor. First, anything that sends
  data to a cloud, whether new or merged from upstream, is off by default.
  Second, users have no way to turn it on: the gate is hard-coded off and reads
  no environment variable, config key, flag, command, MCP argument or UI
  toggle. Upstream enable/login/connect/pair switches stay ignored or refuse
  with a "disabled in this fork" message, get no `graft env` command, and are
  not documented as a way to turn sending on. Only the repository owner can
  lift this, by changing the policy file. Third, tests of such features are
  skipped. Fourth, whenever an upstream change adds or changes a request that
  sends data to any third party (cloud, telemetry, LLM provider, GitHub,
  package registry or any other host), the agent stops and asks the
  repository owner whether to disable it, remove it, keep it as an opt-in or
  keep it as upstream ships it. It stays disabled until the owner answers, and
  each answer is recorded in a "Decisions on third-party data flows" table in
  the policy file. The rules are in `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
  `.github/copilot-instructions.md`, and the Kilo Code, Cursor, Windsurf, Kiro,
  Cline and Roo rule folders. To skip a test file, add an
  `@cloud-sending-test` comment to it; `npm test` skips every file that has one.
- **A model saved with `graft model` is used even in a terminal opened before
  it was saved.** `graft model` showed the saved `GRAFT_MODEL` while `graft
  build --deep` in the same terminal still ran graft's default model and failed
  with `unknown model`. `build --deep`, `blast --name` and `graft model` /
  `graft api url|key` now fill `GRAFT_BASE_URL`, `GRAFT_API_KEY` and
  `GRAFT_MODEL` from the saved user settings (HKCU\Environment, or
  `~/.graft/env.sh`) when the process does not set them; a value in the shell
  or `./.env` still wins. `GRAFT_NO_SAVED_SETTINGS=1` turns this off.
- **Warnings no longer run into the build's progress line.** A message printed
  during `graft build --deep` (`⚠ … retrying at …`, `synthesis batch …`) used to
  be appended to the end of the `reading concepts 17/913: …` line. The progress
  line is now taken off before any other output and redrawn below it.

- **`graft build --deep` no longer asks for a model on every run.** On the
  Databricks AI Gateway it used to list every model and ask which to use each
  time, even with `GRAFT_MODEL` set. It now uses the model already set —
  `--model`, `GRAFT_MODEL`, or the default (`claude-haiku-5-5`) — whenever the
  gateway serves it for your key, and says which one and where it came from
  (`graft model` picks another). It asks only when that model is not among the
  ones the gateway lists, or when the default cannot be checked because its
  route lists nothing.

- **Telemetry is permanently disabled.** Nothing is recorded or sent, and it
  cannot be turned on: the gate always answers "off", whatever the publish-time
  key, a setting saved by an older version, or the environment says.
  `graft telemetry enable` refuses with an error, `graft init` no longer shows
  the "anonymous usage stats" row, no first-run notice is printed, and the npm
  postinstall hook records no `install` event and starts no background flush.
  `graft telemetry status` says it is permanently disabled; events queued by an
  older version are never sent. `graft telemetry` is no longer listed by
  `graft --help` (there is nothing to configure); it still runs, and
  `graft telemetry --help` still explains it.
- **Trail cloud (the Trail workspace) is permanently disabled.** Nothing is
  sent to Trail and it cannot be turned on: `TRAIL_CLOUD=1`, `TRAIL_URL` /
  `GRAFT_BRAIN_URL` and a `~/.trail/cloud.json` (left by an older version or
  written by hand) are all ignored. No sign-in link is offered, no background
  `_trail-claim` / `_trail-sync` child is started, no learnings, activity or
  repo list are uploaded, no use is written to `~/.trail/outbox.jsonl`, and no
  workspace token is stored. `trail login` and `trail workspace add` refuse with
  an error, `trail workspace` says it is disabled, the workspace commands stay
  out of `trail --help`, and `trail status` shows no workspace row.
- The `graft init` picker: **enter now also selects the highlighted agent**
  before confirming. Moving to an agent and pressing enter used to confirm a
  selection without it, so init wired everything except the agent you were on,
  and the picker was gone. An agent you unticked yourself (space or `a`) stays
  unticked, enter on the usage-stats row never opts you in, and the learnings
  picker in `trail init` is unchanged.
- The recommendation lines under the savings tally now spell out the action and
  put the command in single quotes, e.g.
  `⚠️ Run the 'graft build --deep' command — recommended (…)`, and likewise for
  `graft prices update` and `graft init`.
- **Every recommendation line now says why it is shown and what it covers.**
  The `graft init` line lists every instruction file that differs (no more
  "and 1 more"), the graft version whose text it differs from, which sections
  changed (e.g. `“Verify before you assert”`, `the introduction`), and the
  agents a re-run refreshes. The `graft build --deep` line gives the node
  counts behind its percentage (changed and new) and says it is an LLM pass
  that needs an API key and costs tokens.
- Every agent's instructions now cover the case where it cannot run commands,
  such as GitHub Copilot's Ask mode (no terminal) or a read-only or planning
  mode. This covers Copilot, Kilo Code, Cursor, Gemini CLI, Kiro, Windsurf,
  `AGENTS.md` hosts, and the Claude Code / AdaL / Grok skill. Instead of
  skipping graft, the agent uses graft's MCP tools where the host has them
  (Kilo Code, or Claude Code with the server registered). Otherwise it reads
  the graph with its file tools: it lists `graft/` for the concept nodes, and
  browses `graft/src/…` instead of `src/…`, because each source file's card there
  lists its symbols with line spans. It is told not to fall back to listing
  source folders or reading READMEs. It must not write a `🌱 graft saved` line
  in that mode (Copilot in IntelliJ was seen inventing one). Whenever it could not
  run graft commands, it must end its reply with a fixed line telling the user to
  switch to Agent mode to use graft properly. That line is required even if it
  read no graft files, so the user always learns why graft was not used.
  `graft/INDEX.md`, the file such agents open first, now says the same in a short
  "No terminal?" paragraph. Re-run `graft init` to install the instructions, and
  `graft build` to regenerate `INDEX.md`.
- These recommendation lines now each start on a new line
  directly under the savings tally, with no blank line between them. Each line
  above a warning ends in a markdown line break (two trailing spaces), and the
  agent instructions say to keep it. Markdown chat views such as GitHub Copilot
  in IntelliJ merge a plain single newline into the previous line, so the
  warnings ran on after the tally instead of appearing on their own lines.

### Fixed

- **Following the `⚠️ Run the 'graft init' command` nudge could remove agents'
  instructions instead of updating them.** `init` retracts every agent it is not
  given, and its picker started with only Claude Code ticked, so accepting it
  deleted graft's block from `AGENTS.md`, `.github/copilot-instructions.md` and
  the other wired agents' files. Agents only a teammate's machine has (an
  `AGENTS.md` wired elsewhere, with no `~/.codex` here) were not even shown. The
  picker now starts with every agent already wired in the repo ticked and
  shown, and `--yes` keeps them as well.
- **Dollar savings in GitHub Copilot for IntelliJ IDEA (and other JetBrains
  IDEs) on Windows.** While the IDE is open it holds a lock over Copilot's whole
  agent-session store, so every read failed and the model was never found:
  savings showed in tokens only, even for a model VS Code priced. A locked store
  is now read through a memory-mapped view, which Windows does not lock, by a
  short PowerShell step. What it finds is cached in the temp folder until the
  store changes, so this costs one read per Copilot turn, not one per graft call.
- The same reader no longer gives up when one session records the model as its
  id (`gemini-3.8-flash`) and another as its display name (`Gemini 3.8 Flash`).

### Added

- **Make support (depth tier).** Through the optional `tree-sitter-make` grammar
  (`file:../tree-sitter-make`), built by `npm run build:grammars` like the
  others. `Makefile`, `makefile` and `GNUmakefile` are claimed by name and
  `*.mk` / `*.mak` by extension; automake's `Makefile.am` / `Makefile.in` are
  not. Every literal rule target is a `target` node spanning its rule (special
  targets like `.PHONY` excepted), assignments are `variable` nodes and
  `define … endef` blocks `function` nodes. A prerequisite is a reference from
  the target to the target of that name (so `graft callers app` lists what
  depends on `app`), `$(VAR)` a reference to the variable, `$(call f)` a call;
  `include` / `-include` / `sinclude` and `$(MAKE) -C dir` are imports resolved
  to the in-repo file.

- **Bash and Perl support (depth tier).** Through the optional
  `tree-sitter-bash` and `@ganezdragon/tree-sitter-perl` grammars
  (`file:../tree-sitter-bash`, `file:../tree-sitter-perl`), built by
  `npm run build:grammars` like the others.
  - Bash (`.sh`, `.bash`, `.bashrc`, `.bash_profile`): `function f` / `f()`
    definitions, every command as a call (project functions resolve, external
    programs drop), `source f` / `. f` as an import resolved relative to the
    script.
  - Perl (`.pl`, `.pm`, `.t`): `package X;` and `package X { … }` as `package`
    nodes, subs as methods owned by their package (`file#My::App::init`), bare,
    `&f()` and `Pkg::f()` calls, `Pkg->m()` and `$self->m()` resolved through the
    package and up `use parent` / `use base` / `@ISA`, `use` / `require Module`
    as imports resolved to the in-repo `Module.pm` (pragmas like `strict` are
    not imports).
- **`npm run build:grammars` regenerates an ABI-15 parser on the first build
  too.** It only did so for a grammar it had already built once, so a fresh
  checkout of an upstream that ships an ABI-15 `parser.c` (tree-sitter-bash,
  tree-sitter-perl) compiled it unchanged and then failed the load check. It is
  now regenerated at the runtime's ABI (14) before the build.

- **The newer Kotlin grammar is built again.** `tree-sitter-kotlin-local` is back
  in `optionalDependencies`, now pointing at `../tree-sitter-kotlin-grammar`
  (fwcd/tree-sitter-kotlin 0.4); `../tree-sitter-kotlin` holds the KTreeSitter
  bindings, not a grammar. `npm run build:grammars` compiles, packs and vendors it
  like the other native grammars, so `.kt`/`.kts` parse with it instead of the
  registry grammar (0.3.8), which stays the fallback.

- **CMake support (depth tier).** `CMakeLists.txt` and `*.cmake` files are
  indexed through the optional `tree-sitter-cmake` grammar
  (`file:../tree-sitter-cmake`, built by `npm run build:grammars` like the
  others): `function()` and `macro()` definitions, `add_library` /
  `add_executable` / `add_custom_target` as `target` nodes, `option()` switches,
  call edges between functions and macros (case-insensitive, as CMake is),
  `target_link_libraries` / `add_dependencies` / `ALIAS` as references between
  targets, and `include()` / `add_subdirectory()` as imports resolved to the
  in-repo file (a bare module name to the one `<Name>.cmake` in the repo).
  `CMakeLists.txt` is claimed by its exact name, so no other `.txt` file is
  indexed.

- **`graft languages`: which languages graft indexes, and how well.** One row
  per language with its level of support on this install — `full` (a
  hand-written extractor), `broad` (generic tree-sitter tags: symbols and
  calls), `symbols`, `structural` (data and markup), `file-only`, or `skipped`
  (an optional grammar that isn't built) — plus whether it extracts symbols,
  calls, imports, inheritance and typed member calls, the language server
  `graft build --lsp` would use, and its extensions. The level is the one a
  build really gets: a native parser that won't load shows its WASM stand-in's
  level and the install that fixes it. `--json` prints the rows. No repo, key
  or LLM needed.

- **`graft init` follows VS Code workspaces.** When the init directory holds a
  `.code-workspace` file, init asks whether to wire and build each folder the
  workspace lists (resolved relative to the file, JSONC comments allowed)
  instead of the directory itself, because those folders are the roots agents
  open. It asks even when there is only one workspace file. Folders that don't
  exist are skipped with a warning. With several workspace files, init asks
  which one to use, or none (wire the whole directory as before). Without a
  terminal, or with `--yes`, it never assumes a workspace: it wires the
  directory and says how to pick one. `--workspace <file>` chooses one
  explicitly; `--no-workspace` ignores them.

- **`graft config`: list and change `.graft/config.json` without editing JSON.**
  `graft config list` shows every setting with its value, whether that is the
  default, what it does and the command that changes it.
  `graft config exclude-dirs add|remove|list|clear` and
  `graft config include-dirs add|remove|list|clear` edit those lists one entry
  at a time (`graft build --exclude-dir` / `--include-dir` replace the whole
  list), with the same validation as the build flags.
  `graft config follow-submodules on|off` and
  `graft config follow-nested-repos on|off` show or set those switches. Every
  command takes `--repo <dir>`. `graft config <setting> --help` explains the
  setting: what it means and what an entry may look like, i.e. a name at any
  depth, a root-relative path with its subtree, or a glob (`*` within a path
  segment, `?` one character, `**` across segments). It also covers which
  directories can be included, and that absolute paths and `..` are rejected
  and matching is case-sensitive. A command group's help now opens with that
  explanation and lists the commands nested under it, and
  `graft help <group> <command>` reaches nested commands. The note in
  `.graft/config.json` and `graft build --help` point to these commands, and
  `--exclude-dir`'s help now mentions globs.

- **`graft prices update` / `graft prices status`: dollar savings for models graft
  does not list.** `update` downloads LiteLLM's public model price catalog with
  one anonymous GET (no credentials, no model ids, nothing about the repo) and
  stores only the input-side rates in `~/.graft/prices.json` (`GRAFT_PRICES_FILE`
  overrides the path). When graft's built-in table has no price for the model a
  call names, that catalog prices it, including its own cache-read/write rates,
  and the nudge says the figure came from LiteLLM and when it was fetched. A
  session's measured billing and the built-in table still take precedence. The
  stored catalog is used until the next update replaces it, and a failed update
  keeps the previous copy.
- **A `⚠️ Run the 'graft init' command — recommended (…)` line under the savings tally** when the
  agent instructions `graft init` installed in the repo (host instruction files
  and the Claude Code skill) differ from what the running graft version would
  write, i.e. graft was updated but `init` was not re-run there. It names the
  files and sits between the price-update and deep-build lines. Content is
  compared, not version numbers, so an update that leaves the instructions
  unchanged prompts nothing; only files `init` wrote are checked.
- **A `⚠️ Run the 'graft prices update' command — recommended (…)` line under the savings tally**
  whenever a saving is reported in tokens alone because graft knows no price for
  the model. It sits between the tally and the deep-build line.

- **`graft api url`, `graft api key`, `graft model`: save the LLM settings once.**
  Each shows the current value of `GRAFT_BASE_URL` / `GRAFT_API_KEY` (masked) /
  `GRAFT_MODEL`, the saved one, and what `build --deep` would use and why. Given
  a value, or answered at the prompt in a terminal, it saves it as a user
  environment variable, so new terminals, IDEs and MCP hosts see it (Windows:
  `HKCU\Environment`, written without putting the key on a command line;
  macOS/Linux: `~/.graft/env.sh`, mode 600 and sourced from the shell profile,
  or a fish `conf.d` file). `api key` asks for the key with hidden input.
  `model` lists the models the endpoint serves, mid-tier first with top-tier
  ones marked as not needed, and lets you pick one by number; `model --list`
  prints that list. The recommended model (in the picker, the list, and the
  `build --deep` hint) is the endpoint's latest Gemini Flash (not Flash-Lite),
  else its latest GPT terra, else its latest Claude Sonnet. After saving, one `GET /models` checks the endpoint, the
  key, and that the model is listed (`--no-verify` skips it). `--unset` removes
  a saved value. The `build --deep` failure hints and the no-key warning now
  name these commands.

- **`graft build --deep` says how to fix a failed LLM pass.** When the deep
  pass fails, the report now ends with a "How to fix it:" block naming the
  setting to change: an unreachable endpoint (connection refused, DNS, timeout,
  wrong path) → `GRAFT_BASE_URL`, including when it is unset and graft's
  default endpoint was used; a rejected or expired key → `GRAFT_API_KEY` (never
  echoed); an unknown model (the default or `GRAFT_MODEL`) → `GRAFT_MODEL`,
  listing the models the endpoint serves (`GET /models`, mid-tier first) or,
  when it will not list them, examples such as `claude-sonnet-5.5`,
  `gpt-5.5-terra`, `gemini-3.8-flash` — with a note that a top-tier model
  (Opus, astra/sol, Pro) is not needed. Each hint shows the shell syntax to
  set the variable and which flag or variable the bad value came from. Quota
  and balance failures get no hint, since no setting fixes them. Workspace
  builds print the hints once for all child repos.

- **Agents now pass on a due `graft build --deep`.** The `[graft] … build --deep
  is recommended` note was observed going unrelayed (GitHub Copilot closed with
  the savings tally only): it prints before the savings line, whose "at the end
  of your reply…" claims the slot an agent fills. While a deep build is due,
  the example tally now gets a second line,
  `⚠️ graft build --deep recommended (no summaries yet | N% of summaries out
  of date)`, on the CLI and over MCP, and the agent instructions and skill say
  to keep that line and never to run the deep build unasked.
- **Clearer help.** `graft --help` is now just the command list, A→Z (a
  group's commands by full path: `api key`, `api url`). Each entry says in
  plain words what the command does and lists its arguments, every one of its
  options, and examples. The global options appear only on the commands they
  affect: `--dir` on the commands that read or write the graph,
  `--agent-model` on the query commands, and `--provider`, `--model`,
  `--api-key`, `--base-url` on `build`. `graft <command> --help` and
  `graft help <command>` print that same entry; `graft /h` and `graft /help`
  (unlisted) print the same as `graft help`. `-h/--help` and `-v/--version`
  still work but are not listed, and `--agent-model` no longer advertises
  `GRAFT_AGENT_MODEL`, which has been ignored since 0.18.0. `trail --help` keeps
  its grouped layout. An unknown command (`graft buld`) prints the error and
  the "Did you mean …?" suggestion followed by that full help, on stderr
  (`graft api foo` shows the `api` commands); other errors stay one line.
  `graft --model x` with no command now prints a short
  error with the corrected command (`graft --model x build --deep`, never
  echoing an API key) instead of the whole help.
- **`graft staleness [dir]`: is a `--deep` build worth it yet.** Prints what
  share of a repo's node summaries are out of date (changed plus new code),
  the deep-threshold it is judged against and where that value comes from, the
  verdict (the same rule as the query nudge, so the two never disagree), and
  the files holding the most out-of-date summaries (`--top N`). Refreshes the
  graph first (`--no-refresh` to skip), sums a workspace's child repos with a
  per-repo split, and `--json` gives scripts `recommended` / `pct` / `totals`.
  $0, no LLM.
- **LLM calls trust the operating system's certificate store.** Behind a
  corporate gateway or TLS-inspecting proxy signed by a company root, every
  `--deep` call used to fail with a bare `Connection error.`
  (`SELF_SIGNED_CERT_IN_CHAIN`) unless each machine set `NODE_EXTRA_CA_CERTS`.
  graft now adds the OS store to Node's bundled roots on its first network
  request, in every process an agent starts (CLI, `graft mcp`, hooks); queries
  that never touch the network pay nothing. Needs Node 22.19+/24.5+ (older Node
  is unchanged); `GRAFT_SYSTEM_CA=0` turns it off.
- **`graft build --deep` pauses through an empty relay balance instead of
  failing.** On a `403 Insufficient account balance` from any relay, once the
  short balance backoff is spent, one rejected call is re-sent on a shared poll
  (every 30s, `GRAFT_BALANCE_POLL_MS`) while every other LLM call waits on it;
  all resume the moment the relay accepts a call again, for up to 30 min
  (`GRAFT_BALANCE_WAIT_MS`, `0` disables). A pass that has already waited the
  full limit does not wait again until a call goes through.
- **Synthesis batches fail one at a time.** A failing concept-synthesis batch is
  caught and reported instead of aborting the build; every successful batch is
  checkpointed to the cache, so a re-run only pays for the missing ones, and an
  incomplete synthesis leaves the concept nodes on disk untouched.
- **Relay balance errors are retried with backoff** (2s doubling, capped at 60s,
  `GRAFT_LLM_RETRIES` attempts) and, once exhausted, reported as an exhausted
  relay balance rather than "the provider rejected the API key". They no longer
  trigger (and disable) the provider wire-format fallback.
- **Kotlin parses with the locally built `tree-sitter-kotlin` (0.4) when present.**
  Declared as the optional `tree-sitter-kotlin-local` (`file:../tree-sitter-kotlin`),
  built by `npm run build:grammars` and vendored like the other native grammars;
  without it the registry grammar (0.3.8) is the fallback, so `.kt`/`.kts` are
  indexed either way. The registry grammar collapsed common class headers — a
  primary constructor plus a `: Base(…)` clause, a secondary constructor
  delegating to `this(…)` — into ERROR nodes and lost every member inside them.
- **`graft build --deep` covers `.kts`** in the concept map. Gradle build scripts
  and Kotlin scripts already got per-symbol summaries, but were not in the
  concept pass's extension list.
- **XML is structural only.** Its element nodes carry `summary_state: "none"`:
  `--deep` never spends an LLM call on a config entry or MSBuild item, and
  `graft check` does not report them as pending.
- **Every MCP tool accepts a `model` argument** — the equivalent of the CLI's
  `--agent-model`, for the surface that has no flags. Over MCP nothing else can
  name the model: no flag can be passed and no transcript is stamped, so a Kilo
  (or Cursor, or Codex) session's savings were priced at nothing and accumulated
  in the lifetime ledger under `unknown`. The agent always knew what it was
  running; it simply had no way to say so. Sending `model: "claude-opus-5"` now
  yields one exact figure — `🌱 graft saved ~5,548 tokens (~$0.03 for Claude
  Opus 5) this turn` — and files the saving against that model in
  `graft savings`. The per-model table remains the fallback for a call that omits
  it. Optional everywhere, and applied to every tool schema centrally so a tool
  added later cannot silently miss it.
- **Claude Opus 5.5 is priced** at its $4/Mtok input list rate, with its 0.05x
  cache-read multiplier ($0.20/Mtok) applied when measuring a session's billed
  rate. Before this, `claude-opus-5-5` matched the prefix-anchored Opus 5 row and
  was silently priced at $5/Mtok with a 0.1x cache read — overstating list-price
  savings by 25% and measured ones by up to ~2x on cache-heavy turns.

### Changed

- The per-model savings tally now reads **"as estimated below:"** rather than
  "which estimates in $ as following:".
- **The savings ledger files under the bare model id, not the gateway route.**
  `vertex_ai/claude-opus-5`, `anthropic/claude-opus-5` and a plain
  `claude-opus-5` are now one row instead of three. The prefix says who *serves*
  the model, not which model it is, so keeping it split a model's lifetime total
  across every route it was ever reached through — answering a question nobody
  asked at the cost of the one they did. Normalisation happens in the single
  read-modify-write every writer funnels through, so savings and billing for the
  same model always land in the same row. Existing ledgers keep any prefixed rows
  already written; new entries accumulate under the bare id.

### Fixed

- **Kotlin heritage edges.** A superclass (`: Base(1)`), a delegated interface
  (`: Runnable by impl`) and a qualified supertype (`: com.acme.Base()`) all
  produced no `extends` edge — only a bare interface name did.
- **One-line Kotlin objects.** `object Keys { const val A = "a" }` and `data object
  Idle { … }` are misparsed by tree-sitter-kotlin 0.4 as an infix call; they are
  recovered as the object they are, with their members owned by it rather than
  leaking out as top-level functions.
- **Concurrent MCP tool calls no longer read each other's model.** The facts a
  savings report needs — the model the agent named, the rate, the per-model
  table, the claimed-token counter — were module-level slots, which is correct
  for the CLI (one process answers one query and exits) and wrong for the MCP
  server, which is long-lived and serves `async` calls. Two tool calls issued at
  once, as JSON-RPC ids exist to allow, interleaved at every `await`: one call's
  model landed before the other had read its own, so a saving could be priced at
  the wrong rate, reported under the wrong name, and **filed in the lifetime
  ledger against a model that never ran it**. Two overlapping calls could also
  each file the sum of both their tokens. Per-call state now lives in an
  `AsyncLocalStorage` scope entered once per tool call, so awaits inside a call
  see it and siblings cannot; the CLI and hooks keep a process-level store and
  are unaffected. Found by probing the real server — every sequential test passed
  beforehand.

- **The Kilo Code savings table renders as a table.** The per-model rows were
  emitted as markdown pipes with no `|---|` delimiter row, and a chat host only
  draws a table when it sees one — so what reached the user was a wall of plain
  text with stray pipes in it. The table is now drawn with ASCII rules
  (`+-----+-----+`) inside a fenced code block, which needs no cooperation from
  the renderer and looks identical in chat, in a terminal, and in a diff. Values
  are right-aligned so the amounts line up on their last digit.
- **The per-model table no longer leaks into other hosts' sessions.** It was
  wired unconditionally, so it appeared whenever a Kilo config existed *on the
  machine* — meaning a developer with Kilo installed who drove graft from Cursor,
  Codex or a plain terminal was shown Kilo's price list for a session Kilo had
  nothing to do with. Graft now records the client that introduces itself at the
  MCP `initialize` handshake (`params.clientInfo.name`, previously discarded) and
  offers the table only to Kilo, the one host whose model configuration it can
  actually read. Every other host gets the token count and a pointer to
  `--agent-model`, which yields one exact figure — a better answer than a table
  of alternatives, and the reason the table exists only where that is impossible.
- **The unpriced nudge stops advising a flag the surface does not have.**
  `--agent-model` is a CLI flag; over MCP there is no equivalent parameter, so
  suggesting it there asked the agent for something it could not do — spending
  tokens on advice that cannot be followed, and teaching the agent that graft's
  instructions are approximate. The hint now appears only on the CLI. Hosts with
  a per-model table are told to relay that instead, and are no longer told both
  "reproduce the table" and "report the tokens alone" in the same breath.

## 0.24.1

### Added

- **`trail init --pair <code>`**: set up from the Trail web app at
  team.trailhq.com. The setup prompt there carries a pair code; with it, init
  streams its steps (map, PR reviews, past sessions, learnings) to the live
  onboarding page, which shows the tokens one lookup on the map saved and
  teammates' open branches that touch your files, then hands the repo's
  learnings and skills over for you to review before anything is uploaded.
  A learning you drop there stays dropped.
- **`trail init --connect <code>`**: connects this machine to your Trail
  workspace with the one-time code from team.trailhq.com (the token goes where
  `trail login` keeps it) and sends one summary of the repo: what a lookup on
  the code map saved, the learnings' titles, and teammates' recently pushed
  branches that change the files you work on. Titles, counts and names only;
  never code, diffs or session text.
- **`--server <url>`** (or `TRAIL_URL`) points `--pair` and `--connect` at a
  self-hosted Trail. Offline, init says so once and prints the exact command
  to connect later.
- **Workspace brains in your agents**: once connected, `trail mcp` also serves
  the workspace's `list_brains`, `get_context`, `search_rules` and `get_rules`,
  passed to the workspace with your token; the repo tools keep working
  offline. Claude Code gets one user-level `trail` entry that serves just
  those (`trail mcp --brains`); `trail logout` takes it out.
- `trail init` writes a skill when your past sessions repeat a procedure.

### Changed

- Trail cloud now defaults to https://team.trailhq.com.

### Fixed

- The agent picker no longer leaves a stray title behind in an 80-column
  terminal.

## 0.24.0

### Added

- **`trail init` offers what your teammates' Claude doesn't know yet** (#662):
  what reviewers flagged on merged PRs, and Claude Code's memory of the repo.
  Every team row names real code, and anything CLAUDE.md, AGENTS.md or a
  learning already says is dropped. What you told Claude more than once is now
  offered as personal only.
- **Learnings are asked for on real signals** (#663): a check that failed, then
  passed after an edit; a correction followed by code work; a commit, push or
  PR after edits; a long read that found where something lives. The ask names
  what happened.
- **`trail note` checks a team learning before saving it**: it must name a file
  or function in the repo, give a reason, and not repeat an existing learning.
  `--replaces <file>` supersedes an old one, and `--anyway` skips the checks.
- **Shell parsing and command risk checks** behind trail's hooks, and new
  learning fields (#654).
- **Gleam support** (#408).

### Fixed

- Language servers are found and started on Windows (#579), and child
  processes no longer flash console windows there (#631).
- Update checks honor `DO_NOT_TRACK` (#651).
- `--no-gitignore` is kept when build options are saved (#413), and `/graft/`
  isn't added to `.gitignore` when git already ignores the folder (#622).
- Unchanged cards aren't rewritten on every build (#472).
- Background task notifications no longer trigger retrieval in the prompt hook
  (#551).
- Deep builds: stringified concept-pass nodes are read, empty batches don't
  tick (#395), and concept batches run in parallel (#521).
- LLM providers: a 200 carrying an error is retried, a forced `tool_choice`
  that isn't honoured falls back (#502), and structured message content from
  OpenAI-compatible providers is read (#479).
- The viewer keeps the selection after a pan (#630).

## 0.23.1

### Fixed

- **Learnings reach Claude when it opens the file they're about** (#642). When
  Claude reads or edits a file, it gets the learnings whose `touches` name that
  file, at most two, once a session, without calling trail first.
- **A learning's `touches` come from what the session did**: files edited, then
  files named in the learning, then files read. They no longer list whatever
  untracked files sat in the repo.
- **An empty `trail grep` names the git-ignored code it didn't search.**
- **Exploratory turns are asked for a learning too**, when trail's answers
  saved 30k+ tokens of reading.
- **`trail init` refuses your home folder**, and outside git it says the
  learnings stay on this machine.
- **The shared hook reads single-quoted learning titles** (#626), as Prettier
  writes them, so teammates without trail see clean titles. `.trail/hook.cjs`
  is updated at the next session; commit it once.

## 0.23.0

### Changed

- **One shared folder** (#619): `trail init` now shares `.trail/hook.cjs` and
  one SessionStart line in `.claude/settings.json`. Everything else is
  personal: `.claude/settings.local.json`, and the skill in `~/.claude`. Repos
  set up the old way move over by themselves at the next session; commit
  `.trail/` and `.claude/settings.json` once after that.
- **The code map lives in `.trail/cache/`** in a repo on trail, kept out of git
  by `.trail/.gitignore`. An existing `graft/` map is moved there, not rebuilt.
- **No MCP server for Claude Code.** init stops adding it and removes the one
  an older init added. Cursor keeps its server.
- **Overlap shows up after an edit, per function** (#617): a teammate's open
  branch is mentioned only when you both change the same function, and merged
  or closed branches no longer count.
- **A learning's cost counts from where its work began** (#620), not from the
  start of a long session.

### Fixed

- A fresh `trail init` no longer leaves an untracked `graft/` folder behind.

## 0.22.1

### Added

- **Teammates without trail still get the learnings** (#611): in a repo with
  committed `.trail/`, Claude reads the newest learnings, credits the one it
  used, and then offers once to install trail.
- **`trail init` lets you tick which learnings to keep**, and says how many
  sessions each one came from.
- **`trail init` learns from PR review comments**: things reviewers flagged on
  2 or more of the last 50 merged PRs become team learnings.
- **`trail check` flags edits to a teammate's learning.**

### Fixed

- **`trail init` finds Claude Code installed only as a VS Code or Cursor
  extension**, so it no longer skips past sessions without a word. Run
  `trail init` again to get the learnings it missed.

### Removed

- The GitHub App's brain build (#613).

## 0.22.0

graft is now **Trail-code**. The same build ships as two packages:
`@trailhq/trail-code` (the `trail` command) and `@nanonets/graft` (the `graft`
command, unchanged). Both keep getting every release.

### Added

- **`npm install -g @trailhq/trail-code`** gives you the `trail` command: the
  code map plus learnings your team shares in `.trail/`.
- **`graft upgrade` adds `trail` alongside graft**, and the next Claude Code
  session in a graft-wired repo moves it to trail by itself.
- **The agent passes the news on**: on a machine with graft and no trail,
  Claude Code is told once a week to mention that `graft upgrade` adds trail.

### Fixed

- **Each Claude Code hook answers once**, not from both the repo's and
  `~/.claude`'s copies, so learnings no longer arrive twice per prompt.
- **Hook shims find `@trailhq/trail-code`**, and `trail` warns in a repo whose
  older graft hooks can't reach it.
- **No crash on npm 12**, which skips the grammars' install scripts: grammars
  load per language and fall back to WASM.
- The package points at `github.com/trailhq/Trail-Code`.

## 0.19.0

### Added

- **Push a repo's brain from the terminal** (#422): a loopback handoff hands the
  browser a finished brain instead of a half-built one — the push waits for the
  build, then lands the browser on the result.
- **A public repo can be read without installing the App** (#349): access is
  answered on its own, without first reading the repo.

### Fixed

- **The finished push lands in Trail** (#417), not on a local page, and signup
  goes to Trail's own front end rather than the shared agents host.
- **A repo read runs in a child process** so the app keeps answering while it
  works, and the digest finishes sending before the child disconnects.
- **Public reads borrow an installation token** instead of falling back to the
  anonymous rate limit.

## 0.18.0

### Added

- **Trail Brain integration** (#322): graft can build a *brain* from a repo and
  carry its rules into every `ask` — a two-way link, so retrieval is shaped by
  the team context a brain accumulates, not the code graph alone.
- **A brain verifies the checkout before it mines** (#344): graft checks the
  working copy against the repo a brain expects, so rules are never mined from
  the wrong tree.

### Fixed

- **A brain refreshes its rules from upkeep** (#343), so a single empty pull no
  longer leaves it stuck without rules.

## 0.17.0

### Added

- **Claude Code sessions now report the dollar value of what graft saved** (#282),
  not just the token count — the running total on the statusline is priced, so
  the payoff of routing a lookup through the graph instead of reading files whole
  is visible in the terminal.
- **`graft init` also writes the Claude Code wiring into `~`** (#276), so
  worktrees and fresh shells created off the same home keep graft available
  instead of losing the hooks and statusline the moment you leave the repo root.

### Fixed

- The **PR-review GitHub App** keeps its review pages on disk (#278) so posted
  links survive a restart, reviews **merged and closed PRs** via the head ref
  diffed against the merge base (#279, #280) so a merged PR keeps a working graph
  link, and **runs each review in its own process** (#281) so one slow review no
  longer blocks the server.
- **Green main** (#277): the telemetry test clears every CI environment variable
  before asserting, and the CodeQL action pins are realigned.

## 0.16.0

### Added

- **`graft init --no-statusline`** (and `GRAFT_NO_STATUSLINE=1`) skips writing
  Claude Code's `statusLine` / `subagentStatusLine`. A custom bar — in the
  project's `.claude/settings.json` or in `~/.claude/settings.json` — stays in
  front: a project-level field would otherwise hide the user-level one. The
  choice is recorded in the wiring stamp, so a later session refresh cannot
  put Graft's bar back. Graft still recognises its own helper
  (`graft-statusline.cjs`) and will update that command on re-init.

## 0.15.0

### Added

- **Swift gets full-fidelity (depth-tier) extraction**, promoted from the
  breadth tier the same way Kotlin was (#130) — whose swift tags query had no
  call captures at all, so Swift repos indexed symbols with zero wiring.
  `tree-sitter-swift` (native, `^0.7.1` — the first release whose install
  compiles the shipped parser instead of regenerating it, which broke under
  npm's hoisting; a root `overrides` entry pins its `tree-sitter` peer for dev
  installs) parses `.swift`. One `class_declaration` node covers `class` /
  `struct` / `enum` / `actor` / `extension`, told apart by their own keyword:
  class and actor → `class`, struct → `struct`, enum → `enum`, `protocol` →
  `interface`, `typealias` → `type`, top-level `let`/`var` → `variable`. An
  `extension Point` node takes the extended type's own name, so its members
  mint as Point methods and member calls on a Point receiver resolve to them.
  The extension node itself is kind `module`, not a second same-named class —
  otherwise every `Point()` call and `: Point` heritage target would go
  ambiguous and drop. `init` becomes a method named after its type (like a
  Java constructor); `func` is a method inside any type and a function
  elsewhere. Calls resolve via `call_expression` with `navigation_expression`
  / `self` / `super` receivers. A bare lowercase call inside a type body is
  ONE edge carrying both of its readings in Swift's own inner-scope-first
  order: the member reading first (owner-qualified index + the in-repo
  ancestor chain — a stdlib call like `contains` inside `extension Set`
  drops instead of binding to an unrelated type's only same-named method, a
  false positive dogfooding on swift-composable-architecture caught), then
  the free-function reading only when no member exists on the chain — so a
  name defined as both yields the member edge alone, as Swift dispatches it.
  `super.method()` resolves against the declaration's own superclass (the
  first `:` entry, which Swift's grammar puts before any protocol), climbing
  past the current class's override. Overloads disambiguate by declared
  arity vs call-site argument count (Java's exact mechanism — defaults and
  variadics make the arity a minimum); an overload set arity can't split
  (`save(Int)` vs `save(String)`) DROPS rather than taking the same-file
  tiebreak, which would stamp whichever overload appears first `extracted`.
  An initializer call (`Animal(legs: 4)` — an ordinary call node, no `new`)
  falls back to class/struct/enum targets once functions find nothing,
  Python's constructor-fallback shape. The `:` inheritance clause yields `extends`
  edges (bare names — Swift can't say syntactically which specifier is the
  superclass), `import` declarations yield module-path import edges, and
  visibility maps to `exported` as only `private`/`fileprivate` hidden —
  Swift's default `internal` is module-wide, which for a one-module repo is
  the API surface. A Swift bindings collector types receivers from the
  confident, syntax-local clues: typed parameters (`func feed(animal:
  Animal)`, argument labels handled), typed properties, initializer-call
  assignments (`let vet = Vet()` — UpperCamelCase callee, the same convention
  trust as Go's `NewX`), and fields bound both bare and `self.`-prefixed —
  so `vet.check()`, `keeper.wave()`, `self.repo.save()`, and type-member
  calls (`Animal.census()`) all resolve through the owner-qualified method
  index. A receiver with no local clue (a chained call's result) stays
  unresolved rather than guessed.
### Fixed

- **`allowScripts` now names R by the identity npm actually matches on.** The
  entry was `tree-sitter-r@1.3.0`, the alias in `dependencies`, but npm derives
  the identity from the resolved package in the lockfile —
  `@davisvaughan/tree-sitter-r@1.3.0`. The old key matched nothing, so the
  grammar's install script counted as unreviewed and was blocked;
  `npm ci --strict-allow-scripts` failed on it. Harmless in practice only
  because the package ships prebuilds for every supported platform. Note the
  `overrides` key must stay the alias — the two fields key differently.
- **`graft check` no longer reports every container-tier node as `removed`.**
  `checkGraph` branched on the depth and breadth tiers but never on the container
  tier the build uses for `.vue`, so `genericLangOf` returned null, a `generic!`
  assertion threw, and the catch swallowed it as a parse failure — every `.vue`
  node fell through to `removed` on a clean build, and the `graft build` the
  check told you to run had already written them. The check now mirrors the
  build's three-way branch, warms the container grammars alongside the generic
  ones, and treats "no tier claims this file" as an explicit case rather than a
  non-null assertion, so the next tier added fails in the type checker instead of
  silently reporting drift. ([#236](https://github.com/trailhq/Graft/issues/236))

### Added

- **Telemetry can now tell "graft saved tokens" apart from "the user was told".**
  `saved_tokens_bucket` counted what graft *computed* — every
  `[graft] tokens saved ≈ N` footer the PostToolUse accumulator swept up — so a
  turn that saved 20,000 tokens in silence and a turn that saved nothing were the
  same number. `session_summary` now also carries `graft_turns_bucket` and
  `reported_turns_bucket`: of the turns that used graft, how many closed with the
  one-line tally `SKILL.md` and `SAVINGS_TURN_NUDGE` both ask for.

  The agent's own prose lives in one place a hook can reach, so at the end of a
  turn that used graft the Stop hook reads the tail of the host transcript named
  on its stdin and checks the reply for a "graft saved ~N tokens" line. Only a
  count of turns is kept, and only as a bucket — no reply, no fragment, not even a
  length. `TELEMETRY.md` documents the local read in full.

  A turn that can't be checked — a host whose Stop hook names no transcript, an
  unreadable file, a Stop racing the transcript write — is counted in *neither*
  total, so the ratio means "of the turns we could read" rather than deflating to
  zero on every editor but Claude Code. One reply is one turn however often Stop
  fires, guarded by the id of the last reply examined.

- **`scripts/tally-audit.mjs`**, the same ratio offline and at full resolution:
  which turns were silent, whether the number the agent reported matched graft's
  own footers, and whether it named the call count. Run it when the aggregate says
  something surprising. It also flags per-turn savings estimates large enough to be
  artifacts rather than savings.


- **`graft init` converges instead of accumulating, and `graft uninstall` removes
  graft entirely.** `init` wrote the files the selected agents needed and never
  looked at the rest, so a repo wired by an older version — or by the same version
  with different `--agents` — kept that run's files forever, and the session-start
  refresh then kept them *up to date*. `init` now retracts every agent it isn't
  about to write, and `graft uninstall` retracts the lot.

  Only graft's own contribution is touched: inside a shared file just the
  marker-fenced block, inside a config just the `graft` key — foreign MCP servers,
  hooks, statuslines and ignore entries survive byte for byte. A file left holding
  nothing is deleted rather than truncated to an empty shell, and the directories
  that empties are pruned. An unparseable config is reported and left alone.
  `uninstall` is dry-run until `-y`.

  The target list is derived from the same registries `init` writes through, so a
  host added later is retractable for free; only a host *removed* from the registry
  needs a hand-written entry, and `LEGACY_TARGETS` says so. Exclusion is by path as
  well as by host id: three hosts write `AGENTS.md`, and keeping any one of them has
  to spare that block.

### Fixed

- **A stale `[mcp_servers.graft]` is now replaced instead of skipped.** The TOML
  writer returned early the moment the header existed, which froze the launch
  command at whatever the first `init` wrote — a repo wired when graft wasn't on
  `PATH` kept the slow `npx` form forever, and no upgrade could correct it. Codex
  and Grok both went through that path. Foreign tables are untouched either way.

- **`.claude/settings.json` no longer accumulates graft's own entries.** The
  allowlist and `footerLinksRegexes` were append-only, so a renamed invocation form
  stayed in the user's settings beside its replacement with nothing able to remove
  it. Both now drop graft's prior entries before adding the current set, the same
  way the hooks merge already did. Scoped to the forms graft is actually invoked as,
  so a hand-written `Bash(graft-mytool:*)` survives.

- **`graft blast` suggests who to tag.** The comment already named the areas a
  diff changes and the areas it can affect; it now names the people behind them,
  read from git history with no API call and no config file. One `git log` per
  area over that area's own files, weighted towards recent work (120-day
  half-life), with areas the diff only *reaches* counted at 0.6 against a changed
  area's 1.0 — the person whose code your change can break is exactly the
  reviewer the diff alone would never surface. The markdown report gains a `Tag:`
  line under the tests line and a collapsed `Who knows this code` table; the
  exported page gains initials badges on each bubble, a *Who knows this* block in
  the detail panel, and a `people` legend toggle.

  A handle is never guessed: only a GitHub noreply commit address resolves to
  `@mention`, and anyone else is printed as a plain unlinked name, because a
  guessed mention pings a stranger. A repo can fix that for good with a
  `.mailmap` entry, which git applies to the names `blast` reads. Merge commits,
  bots, everyone who authored a commit in the diff range, and — for a local run
  with no `--base` — your own git identity are all excluded. `--no-owners` turns
  the layer off; `--pr-author <who...>` takes logins, names or emails; the
  bundled action gains a `suggest-reviewers` input, defaulting true.

## 0.13.0

### Added

- **Grok (xAI) is a first-class `graft init` host.** Detects `~/.grok` or a
  repo `.grok/` and writes `.grok/skills/graft/SKILL.md` plus a repo-level
  `[mcp_servers.graft]` block in `.grok/config.toml` (Grok's MCP config).
  Select it with `graft init --agents grok`.
- **R language support.** `tree-sitter-r` (`npm:@davisvaughan/tree-sitter-r`;
  the unscoped npm name is a squatted placeholder) parses `.R`/`.r` files.
  Plain functions: every `name <- function(...)` / `name = function(...)` /
  `function(...) -> name` assignment becomes a `function` node (the grammar's
  `function_definition` has no name field, so the name comes from the
  enclosing assignment; right-assign has its own AST shape). Classes — R's
  class systems are library convention, not syntax, so they are recognised by
  call idiom: **R6** (`R6::R6Class(...)` — the class node, `public =`/
  `private =`/`active =` entries as methods, `inherit =` heritage, and `self$`/
  `private$`/`super$` calls resolving to the class or its parent), **S4**
  (`setClass()`/`setMethod()` with `contains =` heritage), **S3**
  (`generic.Class <- function()` only when `generic` is registered locally via
  `UseMethod()` or is one of a small curated base-R set — false negatives over
  false positives), and plain-list mixin bundles (`Foo <- list(public =
  list(...), ...)`) that are spliced across classes instead of inherited. An
  untyped `obj$method()` resolves by bare name to a uniquely-named method
  (ambiguous drops). Visibility: a roxygen `#' @export` tag wins; a roxygen
  block without it means "not exported"; no roxygen falls back to the
  leading-dot convention; R6 `private =` members are unexported.
  `library()`/`require()`/`source()` calls are the import edges. Known gaps:
  S3 generics registered in another file aren't seen (per-file pass); S4
  `signature()` multiple dispatch isn't handled; R6 active bindings are
  ordinary methods.
- **Resumable `graft build --deep`.** The concept phase now checkpoints
  summaries to disk atomically as it runs, so a build interrupted by a session
  or rate limit resumes where it stopped on the next run (content-hash cached,
  no repeated LLM cost) instead of restarting from zero.
- **Kotlin gets full-fidelity (depth-tier) extraction**, and **Lua** and **Nix**
  join the breadth tier. **Dart** now indexes top-level functions and consts.
- **Hermes Agent** is a first-class `graft init` host.
- **Every reported edge quotes the source line** where the call or reference
  happens, in the PR comment, the CLI, and one shared helper.

### Fixed

- **PHP.** Enums with array consts stay in the graph; trait-inherited method
  calls (`$this->traitMethod()`) resolve through the `implements` edge;
  attribute usage is wired as `references` edges; anonymous classes are minted
  as nodes with their `implements` edges.
- **Java.** Generic type arguments (`Base<Item>`) no longer become bogus
  `extends`/`implements` edges or poison call resolution; anonymous-class
  methods no longer take the enclosing type's owner, so calls resolve to the
  real method.
- **Python.** Constructor calls (`Foo()`) resolve to the class instead of being
  dropped.
- **Deep tier.** An empty meaning reply is no longer cached as a permanent
  `pending` state, and per-file failures surface instead of the build exiting
  successfully.
- **`graft ask`.** Distinct files are ranked ahead of one file's sibling spans
  under bounded output, and multi-scope workspaces score comparably across
  scopes.
- **Claude hooks, sync-run, and statusline respect `GRAFT_DIR`**, and the hook
  timeout is also read from user-level settings.
- **Ingest** skips the `_build/` directory (the underscore spelling of a build
  tree).

## 0.12.0

### Added

- **Kotlin moves to full-fidelity extraction.** `.kt` and `.kts` files are now
  parsed by a hand-written tree-sitter extractor — the same tier as TypeScript,
  Python, Go, and Java — instead of the generic breadth grammar, so Kotlin
  symbols, call edges, heritage, and imports resolve with scope awareness. The
  kind mapping now matches tree-sitter-kotlin's real node types (the earlier
  attempt reused Java's, which do not exist in the Kotlin grammar and emitted no
  symbols at all): `class_declaration` is re-read off its own keyword into
  class / interface / enum / annotation, `object` and `companion object` become
  classes, secondary constructors and member functions become methods,
  `typealias` becomes a type, and top-level `val`/`var` become variables.
- **Kotlin edges.** Calls resolve through `call_expression` (member calls via
  `navigation_expression`, with `this`/`super` receivers), the `:` heritage
  clause yields `extends` edges, `import_header` yields import edges, and
  `internal`/`private`/`protected` visibility maps to the exported flag.
### Changed

- **graft now collects anonymous usage stats, and the README no longer says it
  doesn't.** We had no way to tell whether a repo ever got past `graft build`,
  or whether an agent reaches for graft over grep once it has — npm downloads
  answer neither. Six events, all buckets and fixed enums: `first_run`,
  `init_completed`, `build_completed`, `build_failed`, `query`,
  `session_summary`. Never your code, file paths, repo name, symbols, queries,
  prompts, or error messages — [`TELEMETRY.md`](TELEMETRY.md) is the complete
  contract and `src/telemetry/contract.ts` enforces it as a hard allowlist, so
  a property that is not in the document cannot be sent even by accident.

  Identity is two random UUIDs (one per machine, one per checkout), derived from
  nothing; events are anonymous in PostHog with no person profile. Nothing is
  sent from a command you run — events queue locally and a detached process
  posts them at most once a day, so no query ever waits on the network.

  Off if you uncheck the box in `graft init`, run `graft telemetry disable`, set
  `DO_NOT_TRACK`, are in CI, or built from source (the key is stamped in only at
  publish time, so forks never send). `graft telemetry debug` prints the exact
  batch your machine would send, and sends nothing.

## 0.11.0

### Fixed

- **Node 24 no longer aborts breadth-tier builds with `Fatal process out of
  memory: Zone`.** The broader `tree-sitter-wasm` grammar bundle avoids the V8
  Turboshaft failure triggered by the previous bundle. CI now exercises every
  breadth grammar under Node 24 to keep that runtime compatibility pinned
  ([#122]).
- **`npm install -g @nanonets/graft@latest` could silently do nothing.** The
  generated shims (`.claude/helpers/graft-*.cjs`, and Codex's
  `~/.codex/hooks/graft/`) locate the installed package at runtime from four
  candidates, and took the *first* one that existed. The first is the absolute
  `dist/claude` path graft happened to be running from when `graft init` ran, so
  switching Node versions (nvm/volta) or moving the install left that directory
  on disk — still first, still winning — and the upgrade replaced a directory
  the shim never looked at. The upgrade appeared to succeed and changed nothing.
  The shims now read each candidate's `package.json` and load the
  **highest-versioned** one. The `npm root -g` subprocess is still reached only
  when all three cheap candidates miss, so hook latency is unchanged.

### Added

- **The wiring now follows the binary.** `graft init` writes files *into* a repo
  (hooks, shims, skill, rule files) and into `~/.codex`; upgrading the npm
  package replaced the binary and touched none of them, so a repo wired by 0.7
  kept 0.7's prompts and 0.7's hook timeouts indefinitely — and nothing
  agent-facing ever mentions `graft init`, so no agent would think to re-run it.
  `graft init` now records a stamp (version, hosts, flags) in
  `graft/.cache/wiring-stamp.json`; every entry point compares it against the
  running binary and re-runs the writes on a mismatch. Hosts come from the union
  of the stamp and what's on disk, so a rule file that went missing is restored
  rather than dropped from all future refreshes. The init flags are replayed, so
  a repo wired with `--no-global` or `--no-hooks` keeps that choice. The refresh
  never builds the graph (it runs at session start, where a rebuild would stall
  the first turn) and is fail-soft throughout.
- **An upgrade nudge.** A machine-global 24h cache
  (`~/.graft/update-check.json` — one registry request a day per machine, not
  per repo), filled by a detached `graft _update-check` child, feeds a one-line
  "newer version available" notice. Hooks only ever *read* that cache; the CLI
  and the MCP server are the fillers, because a hook that shelled out to
  `npm view` would spend its whole timeout on the network.
- Both run from one shared code path, called at three entry points so no host
  is left out: Claude Code's `SessionStart` hook, the MCP server's `initialize`
  (the only channel that reaches Cursor, which has no hooks — the lines ride in
  `instructions`, since stdout carries protocol messages only), and a CLI
  `preAction` hook for every command except `version`, `upgrade`, `mcp` and
  `_update-check`.

## 0.9.0

### Added

- **`graft build --include-dir <name>`** — an explicit, persisted override for
  `SKIP_DIRS` (repeatable: `--include-dir build --include-dir tools`). Some
  ecosystems keep genuine hand-written source under a directory name graft
  otherwise treats as build output (e.g. a `build/` that isn't generated).
  The override is persisted per repo in Git-ignored `.graft/config.json`: set
  it once and every later no-flag `graft build`, plus the hooks/refresh path
  (which never sees CLI flags at all), include it identically. It lifts only
  graft's own skip list — in a
  Git repository, Git's ignore rules stay authoritative, so a directory that
  is both skip-listed and gitignored needs un-ignoring (or `git add -f`) too,
  the same contract indexing already applies to tracked-but-ignored files.
  Dot-directories are never overridable. Reaches the wiring graph, the Tier-2
  markdown/concept pipeline, Go module discovery, and workspace child builds
  alike, and is validated up front (a bare directory name only — no paths, no
  dot-prefixes).

### Fixed

- **`graft map` no longer promotes unrelated methods into hubs and hotspots.**
  A member call with an unknown receiver could be wired to the repository's
  only method with the same bare name, so built-ins such as `Map.set()` inflated
  an unrelated user-defined `set` method. Member calls now require an
  owner-qualified receiver-type match; unresolved calls are dropped rather
  than guessed ([#35]).

- **Indexing now respects `.gitignore`.** In Git repositories, graft indexes
  tracked files plus untracked files that Git does not ignore, so generated
  output such as `Scripts/bundles/` and `Scripts/transpiled/` is no longer
  parsed merely because its extension is supported. Nested ignore files,
  negations, and global Git excludes follow Git's own rules; non-Git directories
  retain the existing filesystem walk and built-in skip list ([#39]).

- **`graft ask` no longer lets normalization undo test-file de-ranking.** Test
  files were penalized before lexical scores were normalized, but the strongest
  test match was still normalized back to the maximum score. The test prior now
  also applies to the final lexical/graph blend, while test-seeking queries keep
  the existing unpenalized behavior ([#37]).

- **`callers` now includes imported functions used as values.** Named imports that
  are passed, returned, or stored are reported as weaker `references` edges,
  while direct invocations remain `calls` ([#34]).

- **The build banner and repo map now name the language, not its parser.** JavaScript
  files (`.js`, `.mjs`, `.cjs`) use the TypeScript grammar internally, and `.jsx`
  uses the TSX grammar, but reporting those parser names made indexed files look
  absent. Coverage now reports `javascript` and `jsx` alongside the existing
  `typescript`, `tsx`, `python`, and `go` labels ([#36]).

- **README: `init` does not write a `CLAUDE.md` section.** Claude Code receives the
  wholly-owned `.claude/skills/graft/SKILL.md`; existing `CLAUDE.md` content is
  never touched ([#36]).

- **Windows: `graft upgrade` no longer reinstalls over an npx run.** The npx-cache check
  matched `/_npx/` against a path that arrives with the platform separator, so it was
  always false on Windows and `graft upgrade` ran `npm install -g` instead of explaining
  that npx already fetches the latest build on every run.

- **Windows: a git worktree kept the graph it was seeded with, but not the record that
  makes it cheap.** The seed's copy filter dropped every sidecar next to the graph — the
  freshness fingerprint included — so the query right behind the seed found no
  fingerprint, could not diff against the parent checkout, and re-parsed the whole repo.
  It answered correctly the whole time, which is why nothing reported it; the only
  visible trace was a `(? files changed)` note instead of a count.

- **`graft init` printed one path with two separators** on Windows (`~\.codex/`), from a
  `/` concatenated onto an otherwise native display path.

- The `windows-latest` CI leg now **gates** rather than merely reporting. The 21 failures
  it shipped with are resolved: two were the real bugs above, most of the rest were tests
  asserting `/` in paths that are deliberately printed with the native separator or
  pointing a child process at `HOME` (Windows reads `USERPROFILE`), and four are now
  explicit named skips — nothing in Node's `fs` can deny a *read* on Windows, and there
  is no exec bit or `SIGTERM` to test.

- **Windows: path scoping and `map` work again.** graft stores a repo-relative path
  for every indexed file — in node ids, `node.path`, the extract cache, the freshness
  fingerprint — and it was produced with `relative()`, which returns the *platform*
  separator. So on Windows every stored path was `src\gate.ts`, while the query layer
  parses those strings with `/` by hand. Nothing errored; it just matched nothing:

  - `ask --in <path>` reported `nothing indexed under "…"` for **every** prefix,
    making path scoping unusable on the platform ([#33]).
  - `map` saw one path segment instead of several, so it emitted one single-file
    "directory" per file — on a large repo spending its whole token budget describing
    ~16 arbitrary files instead of the repo's shape ([#35]).
  - `callers <file.ts>`-style filename lookups missed.

  Repo-relative paths are now normalized to posix once, where they are created
  (`src/util/paths.ts`), instead of defensively at each consumer. Mac and Linux are
  unaffected — the conversion is the identity there, and existing graphs are
  byte-identical. **On Windows every cache key changes**, so the first `graft build`
  after upgrading re-parses the repo once and `graft check` may report drift until it
  runs. One-time, and `graft/` is a local gitignored cache — nothing to migrate.

  CI now runs a `windows-latest` leg, because this whole class of bug is invisible to
  a posix-only matrix.

### Changed

- **`--in` means the same thing on every command.** `ask --in` matched a segment-aware
  path prefix while `grep --in` and `callers --in` matched a bare substring, so
  `grep --in src` also swept up `lib/mysrc/`. All three now use the prefix rule, and
  all three accept either separator (`--in server\src\gpu` works on Windows). A prefix
  matching nothing indexed is now a loud error on all three rather than — for `grep`
  and `callers` — empty output the caller had to interpret.

  This is stricter: a mid-path fragment like `--in gpu` for `server/src/gpu` no longer
  matches. Pass a real prefix (`--in server/src/gpu`), a full file path
  (`--in src/a.ts`), or use `grep`'s pattern to match on content.

- **Duplicate-named definitions no longer silently collide onto one graph node
  id.** A branch-guarded redeclaration, a reopened class, or any other same-name
  definition within a file used to mint the exact same node id as an earlier
  definition, so the second one silently overwrote the first in every id-keyed
  lookup (`callers`, `ask`, MCP tools). Every definition now mints a unique id
  (`~2`, `~3`, ... on a document-order duplicate), and a qualified query
  (`Class.method`) now matches every duplicate, not just the first.

- **UTF-16LE source is now decoded consistently everywhere graft reads repo
  source.** `graft build`'s parse, `check`'s and `fingerprint`'s drift hashes,
  the context summarizer's input, `ask --source`'s span slicer, and `grep` each
  read files with their own `readFileSync(file, "utf8")` — hashing what the
  parser actually sees wasn't guaranteed, and a UTF-16LE file (the common
  encoding Windows tooling writes) got silently mojibake'd by some readers and
  not others. All of them now share one `readSourceFile`, so a file decodes
  identically no matter which command reads it. UTF-16BE, unsupported by
  Node's built-in decoders, is a clean skip (an empty entry) rather than a
  mojibake read.

- **`graft callers`'s zero-hit note now says when the query name itself is
  ambiguous.** When a symbol name is defined more than once, name resolution
  drops a cross-file call to it rather than guessing which definition it means
  — so a zero-hit result could really mean "something calls this, but the edge
  was dropped for being ambiguous." The note now states how many definitions
  share the name.

[#33]: https://github.com/NanoNets/Graft/issues/33
[#34]: https://github.com/NanoNets/Graft/issues/34
[#35]: https://github.com/NanoNets/Graft/issues/35
[#36]: https://github.com/NanoNets/Graft/issues/36
[#37]: https://github.com/NanoNets/Graft/issues/37
[#39]: https://github.com/NanoNets/Graft/issues/39

## 0.8.2

### Fixed

- **`graft ask` no longer buries source under test files on pytest-style repos.** The
  test-de-rank (`isTestPath`) matched test directories (`tests/`, `spec/`) and suffix
  names (`_test`, `.test`, `.spec`) but missed Python's dominant `test_*.py` filename
  **prefix** and `conftest.py`. On repos whose tests live outside a `tests/`-named
  directory (e.g. a `t/unit/` layout), tests were not de-ranked and swamped `ask`
  results. The prefix and `conftest.py` are now recognized.

## 0.8.1

### Changed

- **Every graft query now refreshes the graph before it answers.** Freshness used to be the
  `Stop` hook's job — it rebuilt once the turn had ended — so every query an agent made
  between its first edit and the end of that turn answered from a graph that no longer
  matched the file it had just changed, and it stayed that way indefinitely if the
  background sync failed. Edits made outside the agent (your editor, a branch switch, a
  stash) set no flag at all, so the statusline read `✓ synced` while the graph was behind.

  `ask`, `grep`, `callers`, `skeleton` and `map` now stat the working tree against the last
  build's fingerprint (~3ms) and rebuild only if something moved. `check` is exempt — it is
  the drift report, and refreshing first would make it always say OK.

  A refresh writes only what a query reads: the wiring graph, the `ask` sidecar, and the
  freshness record. It does **not** rewrite the markdown cards, `INDEX.md`, or your
  `.gitignore` — a query is a read, and those stay the job of an explicit `graft build`
  (which is what the Claude Code `Stop` hook already runs at the end of a turn). So the
  retrieval tools are always current, while the markdown you might `grep` by hand can lag
  an edit until the turn ends.

  The refresh is structural and `$0`: it never calls the LLM, so `graft check` still reports
  concept-node drift and stale summaries until you run `graft build --deep` yourself. A
  refresh that fails answers from the graph on disk rather than failing the query.

  ```bash
  graft ask "..." --no-refresh     # answer from the graph exactly as it is on disk
  GRAFT_NO_REFRESH=1               # same, for every command in the process
  ```

### Added

- **Incremental extraction.** `graft build` memoizes each file's parse under `graft/.cache/`
  and replays the files whose bytes have not moved, so a rebuild costs roughly the files
  that changed: on this repo (124 files) **0.74s cold against 0.18s after one edit**. Output
  is byte-identical to a cold build. The memo is discarded automatically when the extraction
  code or the graft version changes, so a stale parse can't outlive an upgrade. `graft build`
  now reports `parsed: N of M files (K replayed from cache)`, and `graft build --no-reuse`
  forces a cold parse of everything.

  Only the *parse* is skipped — every file is still read and hashed on every build. A stat
  may decide whether a query bothers rebuilding; it may not decide what the rebuild itself
  looks at, or `graft check` (which always re-hashes) could report drift that the `graft
  build` it recommends refuses to repair.

- **`GRAFT_REFRESH=hash`** — confirm every file by hashing its contents instead of trusting
  size and mtime, for tooling that rewrites files while preserving both.

### Fixed

- **A git worktree is no longer blind.** `graft/` is gitignored, so `git worktree add`
  never checks it out — and the graph is the only thing the MCP tools read. Every tool in
  a fresh worktree answered `no matching nodes` / `no graph found` for the whole session,
  and `INDEX.md` and the cards were missing too, so `grep` and the repo map came up empty.

  A query in a worktree now copies the parent checkout's graph and query sidecars in, then
  treats the difference between the two checkouts as ordinary drift. The worktree's `.git`
  is a file naming its parent, so there is nothing to configure; the copy is $0 and
  offline, and the Tier-2 meaning layer survives it (a cold rebuild would have thrown away
  every summary you paid for and re-parsed the repo). `graft build` in a worktree starts
  from the same copy, so it is incremental too — and it is what writes the worktree's
  cards and `INDEX.md`, generated from *this* checkout's code rather than copied from the
  parent's branch. A query still writes only what a query reads.

  Reads the parent, never writes to it. No-ops unless there is genuinely a built parent
  checkout on disk — a fresh clone, CI, or a cloned (rather than worktree'd) cloud session
  behaves exactly as before. `GRAFT_NO_SEED=1` turns it off.

## 0.8.0

### Changed

- **`graft init` now asks which agents to wire, instead of writing files for every
  agent it detects.** Detection keyed off directories in `$HOME`, so anyone who had
  tried several coding CLIs got instruction files and MCP configs for all of them —
  plain `graft init` effectively behaved like `--all-agents`. On a terminal it now
  shows every known agent, which ones were detected, and the exact files each would
  write, and wires only what you select (Claude Code pre-selected).

  **Migration —** `graft init` in CI, a Dockerfile, or any non-interactive shell now
  writes **nothing** and prints the command to run instead. Add `--yes` for the old
  behaviour, or `--agents <ids>` to be explicit:

  ```bash
  graft init --yes                  # wire every detected agent (pre-0.8 default)
  graft init --agents claude        # or name them
  ```

### Added

- **`graft init --dry-run`** — print every path `init` would touch, then exit without
  writing. Out-of-repo writes get their own section.
- **`graft init --no-global`** — skip every write outside the repo. Selecting the
  `agents` host writes to `~/.codex/config.toml`, `~/.codex/hooks.json`, and
  `~/.codex/hooks/graft/`; those are user-level and apply to every repo you open with
  Codex, and previously nothing suppressed the `config.toml` write (`--no-hooks` only
  covered the other two). These are now labelled `machine-wide` in the picker.
- **`graft init --yes`** — wire every detected agent without prompting.

## 0.7.0

### Changed

- **`graft/` is now a local, git-ignored cache, not a committed artifact.** Every
  `graft build` adds `graft/` to the repo's `.gitignore` itself, so the graph is
  regenerated locally (like `node_modules`) rather than shared through git. Commit
  `.claude/` (hooks, skill, statusline, `.mcp.json`) so teammates' agents pick graft
  up; each teammate runs `graft build` for their own graph. `graft check` is now a
  local freshness signal rather than a CI merge gate.

### Removed

- The `bench/` benchmark harness is no longer part of the published repo.

## 0.6.0

Consolidates the structural-traversal surface and wires the MCP server into
Claude Code. **Breaking** — see migration below.

### Breaking

- **Removed `graft callees` and `graft impact`.** Both fold into `graft callers`:
  - `graft callees <symbol>` → `graft callers <symbol> --direction out`
  - `graft impact <symbol> -d N` → `graft callers <symbol> --depth N`
  - `graft callers` with no new flags is unchanged (defaults `--direction in --depth 1`).
- **Removed MCP tools `graft_callees` and `graft_blast_radius`.** The `graft_callers`
  tool now takes optional `direction` (`in`|`out`, default `in`) and `depth`
  (default `1`) parameters covering both:
  - callees → `graft_callers { direction: "out" }`
  - blast radius → `graft_callers { depth: N }` (accepts a file path or symbol,
    same file-seed aggregation the old `graft_blast_radius` did).

  Rationale: a coding-agent tool-selection experiment showed agents never picked
  `graft_blast_radius`/`impact` (they reconstructed it by calling `callers`
  repeatedly) and never picked `callees` (they read the named file instead). One
  well-named command with flags is selected more reliably than three.

### Added

- `graft callers --direction <in|out>` — walk incoming (callers, default) or
  outgoing (callees) edges.
- `graft callers --depth <n>` — walk transitively out to depth N for the full
  blast radius (default 1 = direct edges only). For a file seed at depth >1 the
  walk aggregates over the symbols the file defines.
- `graft init` now registers the graft MCP server in the project's `.mcp.json`
  for Claude Code (previously Claude Code got only hooks + statusline + skill).
  Restart Claude Code to load it. Existing `.mcp.json` servers are preserved.

### Changed

- `graft mcp --help` and docs now list the full tool set
  (`graft_ask`, `graft_callers`, `graft_grep`, `graft_skeleton`, `graft_map`,
  `graft_check`) instead of only three.
- The bundled Claude Code skill and other-agent instructions document the
  consolidated `callers` flags.
