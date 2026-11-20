# Implementation prompt: add a graft code index to PATCH

> **How to use this file.** Give everything below the line to an AI coding
> agent that works in the **PATCH repository**. It is self-contained: the agent
> needs no access to the graft repository. It goes with the report
> `patch-graft-integration.html`, which explains the reasoning; the facts the
> agent needs are repeated here.
>
> What is known, and how far it can be trusted:
>
> - **graft is known in detail.** Its behaviour was checked against the source
>   of graft 0.28.0 (the company fork) and by running it. Section 3 and
>   Appendix A are reliable, but the agent still checks them against the pinned
>   package before relying on them. They also describe how repositories built
>   in parts work in the fork's current code: links between the parts, the
>   `graft parts` command, and `grep --in` across parts. That code still
>   reports version 0.28.0 but is newer than earlier 0.28.0 packages. Phase 1
>   finds out which behaviour the pinned package has (A.6).
> - **PATCH's internals are not known.** This prompt states only what is
>   believed about PATCH at the level of concepts (section 4). Each belief is
>   a hypothesis the agent confirms or rejects in the PATCH repository before
>   building on it. Appendix B lists file names an earlier review saw in PATCH
>   engine v3.11.0. They are leads to check, not facts.

---

## 1. Your task

You are working in the PATCH repository. PATCH is an AI agent product that
works on a large C/C++ code base called EBS. Add a **code index** to PATCH,
built with **graft** (an npm package), so that PATCH's agents (the main session
and its sub-agents) can find code by asking an index instead of grepping and
reading whole files.

When you are done, PATCH:

1. ships a pinned, integrity-checked copy of graft inside its own payload and
   runs it with PATCH's own bundled Node.js;
2. builds graft's index (the "map") for the repository during its preparation
   phase, in PATCH's own data folder, never inside the repository;
3. offers four new read-only agent tools (names are proposals; follow PATCH's
   naming conventions):
   - `code_search`: ranked search for code, with excerpts (`graft ask`);
   - `code_find_all`: every occurrence of a text or regex, grouped by
     enclosing function (`graft grep`);
   - `code_outline`: every definition in one file, with signatures and line
     ranges (`graft skeleton`);
   - `code_callers`: who calls a function, or what it calls, up to a few
     levels deep (`graft callers`);
4. runs those tools through PATCH's existing trusted-execution mechanism with a
   fixed command shape, and filters every result through PATCH's existing
   security guards before it reaches the model;
5. keeps the index reasonably fresh by rebuilding it in the background;
6. tells agents, through PATCH's prompts and sub-agent configuration, when to
   use the new tools;
7. degrades cleanly: if graft is missing, broken or the index is not built,
   PATCH works as before and the tools return a clear diagnostic.

## 2. Ground rules

1. **Discover before you build.** PATCH's internal structure is unknown to the
   author of this prompt. Do Phase 0 (section 5) first and write down what you
   found, with `file:line` references. Never assume that a PATCH file,
   function, setting or convention exists because this prompt mentions it;
   find it, or report that it does not exist.
2. **Fit PATCH, not this prompt.** Where PATCH already has a mechanism (a
   payload manifest, a preflight check, a step runner, a tool registry, an
   output envelope, a path guard, a budget for sub-agents, a test framework),
   reuse it and follow its conventions. The sketches here show intent, not
   code to paste.
3. **Never invent.** Do not make up PATCH APIs, file names, graft options or
   JSON fields. If something you need does not exist, say so and propose the
   smallest addition.
4. **Ask when a decision belongs to the owner.** Stop and ask the user (or
   list it under "Open decisions" in your report if nobody is there to ask)
   when:
   - a hypothesis in section 4 turns out false in a way that changes the design;
   - a security mechanism would have to be weakened or bypassed;
   - a new network access, new executable or new privilege would be needed;
   - the EBS index turns out too big or too slow for the agreed limits.
5. **No network, no writes into the repository, no LLM.** graft must make no
   outgoing connection, must write nothing into the checked-out repository, and
   must never run its language-model features. Section 6.2 gives the exact
   environment that ensures this. Never weaken it to make something work.
6. **Do not modify graft.** Use the published package as it is. If you find
   a limitation, work around it in PATCH and describe the graft change that
   would remove it in your final report.
7. **Small, reviewable steps.** Implement in the phase order of section 6. Each
   phase must leave PATCH working, with its tests passing. Present the Phase 0
   findings and your plan before you change code, if the user is present.

## 3. What graft is (what you need to know)

graft is a command-line tool (TypeScript compiled to JavaScript, shipped as an
npm package, run with Node.js). It parses a repository with **tree-sitter**
grammars (native `.node` modules) and writes an index called the **map**:

- every file and every **symbol** (function, method, class, struct, type,
  macro, variable) with its line range (**span**, written `L110-L118`) and
  signature;
- **edges** between symbols: `calls`, `references`, `imports`, `implements`,
  `extends`. Edges between files are matched **by name**: for C/C++ graft does
  not resolve types like a compiler, so expect calls through function pointers
  or macros to be missing and same-named functions to be confused at times;
- an **ask index** with symbol text for ranking, one markdown **card** per
  source file, and caches.

Building and querying use no AI model, no API key and no network. graft has an
optional language-model pass, `build --deep`, which sends source code to an
LLM endpoint: **never run it**.

How it works:

1. `graft build <repo>` indexes the files git sees (tracked files, plus
   untracked files git does not ignore), minus folders passed to
   `--exclude-dir`. Every parse is cached by content hash, so later builds
   re-parse only changed files.
2. Each query command (`ask`, `grep`, `skeleton`, `callers`) loads the whole
   map into memory, answers, and exits. A parsed map takes about as much memory
   as its `wiring.json` file. By default a query first checks for changed files
   and rebuilds them (a "refresh"). PATCH turns that off with `--no-refresh`
   and rebuilds on its own schedule.
3. One map is limited to about 483 million characters of its main file
   (`wiring.json`). A larger repository is built as several **parts**
   (`build --all-parts`), one map per folder. The root map folder then holds
   a `workspace.json` index listing the parts, and **links** between them
   (`.cache/links.json`): the calls, imports and references that cross from
   one part into another. A part's own map cannot settle those edges alone.
   From the repository root, `ask`, `grep`, `skeleton` and the text output of
   `callers` search every part and use the links. When maps are too big to
   keep together, they read one part at a time (`callers` at most two).
   **`callers --json` still does not search across parts** (section 6.5).
   `graft parts --json` lists the parts, where each part's map is kept, and
   whether the links are current.

Things graft normally does on a developer machine that PATCH must **not** use:
`graft init` and "auto-init" (writing instruction files for AI assistants into
the repository), the MCP server (`graft mcp`, which returns text only),
assistant hooks, refresh-before-query, `--deep`, `--lsp`, "learnings" (notes in
`.trail/learnings/`, returned by `ask` as `notes`), the savings ledger, the
opt-in savings report to a company Oracle database, the update check, the price
download, and user settings saved with `graft env`. Cloud sync and telemetry
are permanently off in the company fork.

The exact commands, options, environment variables and JSON shapes are in
**Appendix A**. Treat them as reliable for 0.28.0, and check them against the
version you pin (Phase 1). A.6 lists what differs between packages with and
without links between parts.

## 4. What is believed about PATCH (hypotheses to confirm)

For each item: confirm it and record where it lives (`file:line`), or record
that it is false and what exists instead. Items marked **(design-critical)**
change the design if false; ask before working around them.

| # | Hypothesis | Why it matters |
|---|---|---|
| H1 | PATCH is a Windows (x64) product that ships its own Node.js runtime (an earlier review saw Node 24.18.0). | graft runs on it; graft needs Node `^20.16.0 \|\| >=22.3.0`; graft's C/C++ grammars are shipped for win32-x64 only. **(design-critical)** |
| H2 | PATCH ships a signed or hash-pinned payload with a manifest that an install-integrity check verifies, and a list of protected paths. | The graft files must be added to it. |
| H3 | PATCH has preflight checks that run at start-up and can raise warnings without stopping PATCH. | Add a graft check. |
| H4 | PATCH has a preparation phase ("Prepare") with ordered steps; a step can fail with a warning without failing the phase; some steps already run external scripts with a timeout through an allowlist. | Add the index build as a step. **(design-critical)** |
| H5 | PATCH distinguishes integrity levels: trusted operations run at Medium IL; the agent's own shell runs at Low IL, where the repository is read-only and user shell commands are blocked. | graft must run as a trusted operation, never through the agent shell. **(design-critical)** |
| H6 | Agent tools are registered by a trusted extension (an earlier review saw one called `guardrails`) with typed parameter schemas, and existing knowledge/search tools follow a common pattern. | Model the four tools on them. |
| H7 | There is a closed set of trusted operations: fixed executables with fixed argument shapes, validated before running. | Add one operation for graft queries. **(design-critical)** |
| H8 | Search-type tools return a common output envelope (an earlier review saw `{"result", "truncated"?, "diagnostic"?}`) with a character cap (seen: 12,000). | Wrap graft results the same way. |
| H9 | PATCH has guards that hide credential files and protected trees from the agent, and budgets that limit what sub-agents may read or grep. | Every graft result is filtered through them. **(design-critical)** |
| H10 | PATCH honours an ignore file for the agent (seen: `.piignore`). | Mirror it into graft's `--exclude-dir` list. |
| H11 | Sessions start without repository instruction files, without arbitrary extensions, without skills from the repo and without MCP servers. | graft's own agent wiring cannot work; only PATCH tools reach the agent. |
| H12 | PATCH has sub-agents (seen: "Scout" and "General") with a list of read-only tools. | Add the four tools to it. |
| H13 | The agents' central prompt is generated from a source file in the PATCH repository; tools have short prompt snippets. | Add a "locating code" rule and tool snippets. |
| H14 | PATCH ships hash-pinned skills (seen: `/understand`, `/impact`, component-info) gated by a scope file. | Update them to use the tools. |
| H15 | The agent framework offers lifecycle hooks (seen: `before_agent_start`, `tool_result`, `tool_call`). | Optional phase: add search hits to prompts, hint after broad greps. |
| H16 | For EBS, PATCH already knows the active build flavour and components (seen: `.ebs/.active_flags` and a generated components file). | Tag hits in inactive code; graft itself parses every `#if` branch. |
| H17 | PATCH has a data folder outside the repository with restricted access (ACLs) for per-repository state. | The map goes there; it contains source text. **(design-critical)** |
| H18 | PATCH has an edit tool (seen: `source_edit`) and notices branch switches. | Triggers for background rebuilds. |
| H19 | PATCH has a status bar or similar place to show per-session figures. | Optional savings display. |

## 5. Phase 0: discovery (no code changes)

Answer each question in the PATCH repository with `file:line` evidence. Write
the answers into a short discovery note (in your reply, or in a file if PATCH
keeps design notes).

1. **Runtime:** where the bundled `node.exe` is, its exact version, and how
   PATCH starts child processes (helper functions, environment sanitising,
   timeouts, output limits, Windows job objects, integrity levels).
2. **Payload:** how files get into the payload, how the manifest and hashes
   are generated and verified, which paths are protected, and how a new
   third-party folder (with `node_modules` and native `.node` files) would be
   added. Check whether native modules need signing.
3. **Build pipeline:** how third-party npm dependencies are fetched today
   (registry configuration, lockfiles, offline mirrors), and where a pinned
   tarball would be stored or fetched in the release build.
4. **Preflight:** how checks are declared, their severities, and how a failed
   check disables a feature.
5. **Prepare:** the list of steps, their order, how a step runs an external
   command (allowlist, timeout, integrity level, environment), how warnings
   are reported, and where per-repository state is stored.
6. **Trusted operations:** how the closed set is defined, how arguments are
   validated, and how a tool calls an operation.
7. **Tools:** how an existing search-type tool is registered (schema, prompt
   snippet, output envelope, truncation), and how it detects that it runs in
   a sub-agent.
8. **Guards:** the functions that decide whether a path may be shown
   (credentials, protected trees, ignore files), and the sub-agent budgets.
   Note their inputs (absolute or repo-relative paths, separators, case).
9. **Sub-agents, prompts, skills, hooks:** where each is defined and how a
   change to it is pinned or regenerated.
10. **EBS context:** where flavour and component information is generated
    and in what format.
11. **Tests:** the test framework(s), how integration tests run, whether a
    Windows test machine or CI exists, and whether outbound network can be
    blocked in tests.
12. **Hypotheses:** the status of H1 to H19.

Then write a plan that maps each phase of section 6 to the concrete PATCH
files you will change. If the user is present, wait for approval.

## 6. Implementation phases

### 6.1 Phase 1: package graft into the payload

1. Pin one graft version. Fetch it **only from the company fork's registry**,
   never from registry.npmjs.org: upstream publishes the same package name,
   `@nanonets/graft`, with cloud features switched on. Scope the registry
   explicitly, for example
   `npm pack @nanonets/graft@<version> --@nanonets:registry=<fork npm URL>`.
   The fork's `publishConfig.registry` points at
   `https://eu.artifactory.automotive.cloud/ui/repos/tree/General/a_asc_tools_graft`,
   which is an Artifactory **UI** address; find the npm API address (ask the
   user if you cannot). Record the tarball's SHA-512 integrity hash and check
   it in the build.
2. Install the production tree into a PATCH-owned folder (an earlier review
   suggested `engine/graft/`), **without lifecycle scripts**:
   `npm install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund <tarball>`.
   - `--ignore-scripts`: graft's `postinstall` would write registry lines into
     the builder's `~/.npmrc` and create `~/.graft/telemetry.json`.
     `tree-sitter`'s install script is not needed because its win32-x64
     prebuild loads at runtime.
   - `--omit=optional`: graft's optional dependencies are local `file:` paths
     that exist only on graft's build machine; the grammars come from the
     package's `vendor/` folder instead.
3. Add the whole folder to the payload manifest and the protected paths, the
   same way PATCH protects its own engine files.
4. Add a preflight check (warning severity) that confirms:
   - `<graft>/dist/bin/graft.js` exists;
   - `<graft>/vendor/c/prebuilds/win32-x64/` and `<graft>/vendor/cpp/prebuilds/win32-x64/` hold their `.node` files;
   - `<graft>/node_modules/tree-sitter/prebuilds/win32-x64/tree-sitter.node` exists;
   - `node <graft>/dist/bin/graft.js --version` exits 0 within a few seconds and prints the pinned version.

   On failure, disable the index step and the four tools; PATCH keeps working.
5. Always run graft as `<PATCH node.exe> <graft>/dist/bin/graft.js …`. Never
   rely on a `graft` command on PATH, never use `npx`, never install anything
   on the target machine.
6. **Verify on the pinned version** (the package ships compiled `dist/` only,
   no TypeScript sources): run `--help` for `build`, `ask`, `grep`,
   `skeleton`, `callers` and `parts`, and compare the options and JSON shapes
   with Appendix A. Record any difference. Whether `graft parts --help`
   exists tells you which parts behaviour of A.6 the package has.
7. **Smoke test** on Windows x64 with PATCH's Node: build a small C repository
   and run each query with `--json`, to prove the native grammars load under
   PATCH's Node version (graft was checked only on Node 26.13.1).

### 6.2 Phase 2: graft's process environment

Build graft's environment from an **allowlist** using PATCH's existing
environment-sanitising helper if there is one. Developers may have saved graft
settings as user environment variables (`graft env` writes them to
`HKCU\Environment`), and these must not reach PATCH's graft processes.

Keep only what Node and Windows need to run (for example `SystemRoot`,
`windir`, `PATH` limited to system folders, `TEMP`/`TMP`, `PATHEXT`,
`COMSPEC`; check what PATCH's helper already keeps). Then set exactly:

| Variable | Value | Purpose |
|---|---|---|
| `USERPROFILE` and `HOME` | `<PATCH data>\graft-home` | Isolates graft's per-user folder `~/.graft` (settings, savings ledger, savings-report opt-in, install id, update cache). Node's `os.homedir()` reads `USERPROFILE` on Windows. |
| `GRAFT_DIR` | the absolute map folder for this repository (6.3) | Pins the map folder for internal paths (lock, caches) that do not see `--dir`. In a parts build it also redirects those internal paths of every part to this one folder: check that in 6.3 step 7. |
| `GRAFT_PROFILE_STORE` | `<PATCH data>\graft\repos` (absolute, outside every repository) | Where graft keeps per-repository **build settings**; `--dir` does not move them. Without it they would go into `<repo>/.graft/config.json`. In a parts build each part's **map** and settings also go here (6.3 step 7), so builds and queries must use the same value. |
| `DO_NOT_TRACK` | `1` | No background update check. |
| `GRAFT_PRICES_AUTO_UPDATE` | `0` | No price-list download. |
| `GRAFT_NO_REFRESH` | `1` for queries; **unset** for builds | Queries never rebuild or write. |
| `GRAFT_NO_AUTO_INIT` | `1` | Never writes assistant instruction files into the repository. |
| `GRAFT_NO_TRAIL_SWITCH` | `1` | Never rewrites assistant configuration from `graft` to `trail`. |
| `GRAFT_NO_GITIGNORE`, `GRAFT_NO_IGNORE` | `1` | Never edits the repository's `.gitignore` or `.ignore`. |
| `GRAFT_STDERR_SAVINGS` | `0` | stderr carries error messages only. |
| `NODE_OPTIONS` | `--max-old-space-size=<MB>` for builds | Size from a measured EBS build (6.3). |

Everything else named `GRAFT_*`, `TRAIL_*` or `npm_config_*` must be absent.
For example, `TRAIL_NO_FETCH=0` would turn on `git fetch origin` and
`gh pr list`. Create both data folders with the same ACLs as PATCH's other
per-repository state: the map contains source text.

### 6.3 Phase 3: the index build step

1. **Map folder.** Compute one absolute folder per repository under PATCH's
   data folder, for example `<PATCH data>\graft\maps\<repo-id>`, where
   `<repo-id>` is derived from the normalised repository path. Pass it as the
   global option **`--dir <map>` before the command name** on every graft call
   (`graft --dir <map> build …`, `graft --dir <map> ask …`) and as `GRAFT_DIR`.
   Without it graft looks inside the repository first: it uses a
   `.trail/cache/` or `graft/` folder a developer left there and may even
   rename `graft/` to `.trail/cache/` inside the checkout.
2. **Guard against a developer's settings file.** If `<repo>/.graft/config.json`
   exists, graft reads build settings from it and writes PATCH's settings back
   into it, whatever `--dir` says. In that case skip the index step with a
   clear warning (and make the tools report "index unavailable"). No graft
   option redirects that file. In a parts build the same holds for each part
   folder: `<repo>/<part>/.graft/config.json`. Parts are only known once
   graft has planned them, so check again after the build (step 7).
3. **Command:**

   ```
   <node> <graft>/dist/bin/graft.js --dir <map> build <repo>
       --exclude-dir <entry> [--exclude-dir <entry> ...]
       [--only-dir <path> ...] [--all-parts]
       --no-gitignore --no-ignore --no-workspace
   ```

   - `--exclude-dir` (repeatable; folder name, path or glob): pass every entry
     of PATCH's agent ignore file, plus generated and third-party trees, plus
     anything the credential and protected-tree guards hide that can be
     expressed as a folder. graft saves the list and **replaces** the saved
     list on each build, so always pass the complete set.
   - `--only-dir`: restricts indexing to some folders (also saved).
   - `--all-parts`: needed if one map would exceed the size limit (step 5).
     graft plans the parts (folders) itself and splits a part that is still
     too big. Each part inherits the root's `--exclude-dir` list (entries
     with a path are re-rooted at the part). Once a repository is built in
     parts, a plain `build` of the root (without `--all-parts`) rebuilds
     every listed part and remakes the links. Passing `--all-parts` again
     plans the parts afresh.
   - Never pass `--deep`, `--force`, `-j`, `--synth-concurrency`, `--lsp` or
     `--no-reuse` (the last one only to recover a corrupt cache).
4. **Run it as a Prepare step** after the steps it depends on (ignore rules,
   flavour and component context), with an allowlisted command, a timeout set
   from a measured build, and the build environment of 6.2. Any failure is a
   warning, never a Prepare error. Exit code 0 means built; anything else
   means failed (with `--all-parts`, failed or too-large parts give a non-zero
   exit). Keep the first lines of stderr for the warning (graft's error lines
   start with `✗`).
5. **Measure EBS before you choose the shape.** Time, peak memory, and the size
   of `<map>/.graph/wiring.json`. For scale, a repository whose `wiring.json`
   was 98.6 MB needed 2.15 GB peak memory to build, and that size is about
   20 % of the per-map limit. If the build fails with `GRAPH_TOO_LARGE`
   (graft suggests folders), use `--all-parts` or several `--only-dir`
   builds, and report the numbers to the user. In a parts build, measure
   per part (`bytes` in `graft parts --json`) and the final link step
   separately. Its memory has not been measured. A query needs about the
   largest part's `wiring.json` in memory, or two parts' for `callers`. Size
   the query concurrency limit (6.4) from that.
6. graft takes a build lock in the map folder, so concurrent builds of one
   repository wait for each other. Still serialise builds per repository in
   PATCH (one job at a time).
7. **After a parts build, check where the part maps went.** They are **not**
   under `<map>`. graft builds each part with that part's folder as root and
   ignores `--dir` for it. The root `<map>` holds only `workspace.json` and
   `.cache/links.json`. A part's map goes where a build of that folder would
   put it without `--dir`: `<repo>/<part>/.trail/cache/` or
   `<repo>/<part>/graft/` if a developer left one there, otherwise
   `<GRAFT_PROFILE_STORE>/<part-folder>-<hash>/`. Queries find the part maps
   the same way. So after each parts build:
   - run `graft --dir <map> parts <repo> --json` (exit 1 means no map);
   - check that every `parts[].map` lies under `GRAFT_PROFILE_STORE`, that no
     part folder holds a `.graft/config.json`, and that every part is
     `"built"`;
   - otherwise disable the tools with a clear warning, because the index
     would mix in a developer's maps or settings;
   - record `links` (`"current"` is expected right after a build) and
     `unlinked`;
   - check what graft wrote into `<map>` and into each part's map folder,
     with `GRAFT_DIR` set as in 6.2. That variable sends some internal files
     of every part (caches, stamps) to the root map folder; see whether this
     causes conflicts. If it does, try running the build without `GRAFT_DIR`:
     `--dir` still places the root map. Report what you chose.

### 6.4 Phase 4: the trusted query operation

Add **one** operation to PATCH's closed set of trusted operations:

- fixed executable: PATCH's `node.exe`; fixed script: `<graft>/dist/bin/graft.js`;
- fixed subcommands: `ask`, `grep`, `skeleton`, `callers` (nothing else);
- argument shape:
  `--dir <map> <subcommand> <positional…> <repo> <allowed flags…> --json --no-refresh`;
- reject any positional token that starts with `-`, or contains `;`, CR, LF
  or NUL; accept only repository-relative paths for path parameters (no `..`,
  no drive letters, no UNC paths);
- send the `ask` query on **stdin** (`ask - <repo> …` reads the query from
  stdin), so it does not appear in the process list or the argv validation;
- cwd = the repository root; environment = 6.2 with `GRAFT_NO_REFRESH=1`;
- timeout (start with 30 s and tune from measurements), stdout limit (start
  with 8 MB), and a concurrency limit of 1 to 2 graft processes per
  repository, queued (each process loads the whole map: more than 1 GB on a
  big repository);
- exit code 0: parse stdout as JSON. Non-zero: return a diagnostic built from
  the first stderr line; never pass raw stderr or stack traces to the model.

Sketch (intent only):

```js
const OPS = new Set(['ask', 'grep', 'skeleton', 'callers']);
async function graftQuery(repoRoot, op, positional, flags, { stdin } = {}) {
  if (!OPS.has(op)) throw new Error('graft: operation not allowed');
  positional.forEach(assertSafeToken);
  flags.forEach(assertAllowedFlag);             // per-op allowlist, values validated
  const argv = [GRAFT_JS, '--dir', mapDir(repoRoot), op, ...positional, repoRoot,
                ...flags, '--json', '--no-refresh'];
  const r = await runTrusted(NODE_EXE, argv, { cwd: repoRoot, env: graftEnv('query'),
                                               stdin, timeoutMs, maxStdoutBytes });
  if (r.code !== 0) return { ok: false, diagnostic: firstLine(r.stderr) };
  return { ok: true, json: JSON.parse(r.stdout) };
}
```

### 6.5 Phase 5: the four tools

Register them like PATCH's existing search tools, with typed parameter schemas
and short prompt snippets.

| Tool | Parameters | graft command (after `--dir <map>`) |
|---|---|---|
| `code_search` | `query` string 1..500; `limit` int 1..10, default 5; `path` optional repo-relative prefix | `ask - <repo> --json --source -n <limit> [--in <path>] --no-refresh`, query on stdin |
| `code_find_all` | `pattern` string 1..300; `fixed` bool; `ignore_case` bool; `path` optional | `grep <pattern> <repo> --json [--fixed] [-i] [--in <path>] --no-refresh` |
| `code_outline` | `file` repo-relative path | `skeleton <file> <repo> --json --no-refresh` |
| `code_callers` | `symbol` string; `direction` "in" or "out"; `depth` int 1..3; `path` optional | `callers <symbol> <repo> --json --direction <d> -d <n> [--in <path>] --no-refresh` |

`code_search` has no `full` parameter on purpose. On a map built without
`--deep` (PATCH never runs it), `--source` already inlines each hit's whole
definition, up to 80 lines, ending with
`… (+N more lines; open <path>:L<from>-L<to>)` when it is longer, and `--full`
changes nothing. Short excerpts ("crux", up to 8 lines) exist only in maps
built with `--deep`. Budget the character cap for this (step 7 below).

`grep` patterns may legitimately start with `-`. For `code_find_all`, either
reject such patterns with a clear message or prove from `graft grep --help`
that an end-of-options marker is supported, and use it. Do not loosen the
general token rule.

**Post-filter every result**, in this order, before the output envelope:

1. Normalise every path to repository-relative with forward slashes:
   `hits[].pointer` (format `path` or `path:Lx-Ly`), `symbol.path`,
   `hits[].path`, `groups[].path`, `groups[].symbol.path`, `file`.
2. Drop every entry whose path PATCH's credential guard or protected-tree
   guard rejects, together with its code and text; do not mask, remove. Apply
   the agent ignore file too.
3. From `ask` results, delete `notes`, `notesChecked` and `notesHint`. They are
   "learnings" read from `.trail/learnings/` in the repository: free text
   written by other agents, with absolute paths, not vetted by PATCH.
4. For EBS, tag hits in code inactive for the current flavour or outside the
   active components (H16), for example `"inactive": true`. graft knows
   nothing about flavours.
5. In sub-agents, charge the result against the same budgets PATCH applies to
   grep and read.
6. Add the index age, for example `"index": {"builtAt": "...", "stale": true|false}`.
7. Serialise, apply PATCH's character cap by removing whole hits from the end,
   and set the envelope's truncation flag.

Error handling: no index, unknown symbol, invalid regex and similar errors give
a diagnostic, never an exception. `grep` with zero hits is a success
(`totalHits: 0`). `callers` explains an empty result in `matches[].note`.

**Parts builds.** If Phase 3 had to use `--all-parts` (A.6 says what an
older package does differently):

- `ask`, `grep` and `skeleton` search all parts from the repository root,
  with the root `--dir <map>`. Every hit carries a `scope` label naming its
  part, and paths are from the repository root (check this on real output;
  the post-filter normalises them anyway). Structural `ask` questions ("who
  calls X") and `grep`'s `inDegree` count the links between parts.
- `--in <part>/` (or a folder inside a part) narrows `ask`, `grep` and
  `callers` to that part. A prefix above several parts selects all of them.
  `path` parameters therefore work as in a single map. Give `skeleton` the
  file path from the repository root (`<part>/src/file.c`).
- `callers --json` at the root fails ("no graph found"): its JSON mode reads
  only the root map, which a parts build leaves empty. Two ways round it,
  to choose after looking at real EBS output:
  1. Run it per part with `--json`, passing the part's folder as `<repo>`
     and its `map` from `graft parts --json` as `--dir`, then merge the
     results. This is structured, but it misses every edge that crosses
     parts. It may also contain edges the links mark as wrong: a call bound
     to a same-named function in the same part when the real target is in
     another part. Say in the result that edges between parts are missing.
  2. Run it at the root **without** `--json`. The text output does use the
     links: one `## <part>/` block per part that defines the symbol, and an
     `across parts:` list for hits in other parts. Parse it only with a
     strict parser tested against recorded output. Drop any line it cannot
     parse, and still apply every post-filter step to the paths it extracts.
     If the links are missing or stale, the text says that callers in other
     parts are not tracked. It may add unverified text-match guesses; drop
     those.

  Ask the owner which way to take if the choice is not clear. List
  "`callers --json` across parts" as a graft change in your report.
- If `links` in `graft parts --json` is not `"current"` (a part was rebuilt
  alone, or its build failed), queries answer without the links. Only the
  text output of `callers` says so. Report the index as degraded (6.7).

**Quality signal.** `ask` results carry `coverage` and `coverageStrong`
(0 to 1). `coverageStrong` of 0 means no query word matched the top hit's name
or path. Use it to label weak results.

### 6.6 Phase 6: prompts, sub-agents, skills

1. Add the four tools to the sub-agents' read-only tool list.
2. Add a short "Locating code" rule to the central prompt source (not to a
   generated copy):
   1. settle partition, component and flavour first, using PATCH's existing
      EBS context rules;
   2. then `code_search` or `code_callers`;
   3. then read only the returned line ranges;
   4. use plain text search last, or `code_find_all` when every occurrence is
      needed.

   Keep any existing rule that forbids answering from search results alone.
3. Add one-line prompt snippets for each tool. In a parts build, name the
   parts (the `part` values of `graft parts --json`) in the snippet for the
   `path` parameter, so agents can narrow to the part they work in.
4. Update the relevant skills (seen: `/understand`, `/impact`,
   component-info) to follow that order, and re-pin them as PATCH requires.
5. Optional, separate change: in a hook that runs before the agent starts,
   add the top 3 `code_search` hits when `coverageStrong` > 0. After a broad
   grep or a whole-file read, add a one-line hint to use the code tools. Keep
   any redirecting behaviour off by default.

### 6.7 Phase 7: freshness

- Queries never rebuild (`--no-refresh`, `GRAFT_NO_REFRESH=1`).
- Rebuild in the background, one serialised job per repository, after each
  Prepare, after successful edits (debounced) and after a branch switch. Use the
  same build command and environment (without `GRAFT_NO_REFRESH`); rebuilds
  are incremental.
- `graft --dir <map> build <repo> --check --json` reports drift without
  building. Use it for the `stale` flag if it is fast enough on EBS; otherwise
  compare against the time of the last edit or branch switch.
- If file timestamps cannot be trusted (network drives, restored checkouts),
  set `GRAFT_REFRESH=hash` for builds (slower).
- **Parts builds.** Queries with `--no-refresh` never remake the links
  between parts; only a build does. Always rebuild from the repository root
  with the same command, without `--all-parts`: it rebuilds every part
  (incrementally) and then remakes the links. Do not build a single part on
  its own, because that leaves the links stale until the next root build.
  Pass `--all-parts` again only to plan the parts afresh, for example after
  the repository grew past a part's limit. For the `stale` flag, also use
  `graft --dir <map> parts <repo> --json`: the index is degraded when
  `links` is not `"current"` or a part is not `"built"`. That command loads
  no map, so it is cheap. Whether `build --check` reports drift per part has
  not been checked; verify it on a parts build.

### 6.8 Phase 8: savings display (optional)

`ask --source` returns `saved: {files, baselineChars}`; `grep`, `skeleton` and
`callers` return `saved` too. `baselineChars` is the size of the files the
answer covers. Sum it per session and show it where PATCH shows session
figures, converted with PATCH's own model and price data. Do not pass
`--agent-model`. Do not use graft's own savings lines.

## 7. Acceptance tests

Automate what PATCH's test setup allows; list the rest as manual checks.

1. Preflight passes on a clean Windows x64 machine. Removing `vendor/c` makes
   it warn, the tools report "index unavailable", and PATCH still works.
2. Prepare on EBS builds the index within the agreed time and memory.
   `git status --ignored` shows no new or changed files in the repository (no
   `graft/`, `.graft/`, `.trail/`, `.gitignore` or `.ignore` change), and the
   developer's real `%USERPROFILE%\.graft` is untouched. Repeat with a checkout
   that already contains a developer's `graft/` map and `.trail/learnings/`.
3. With `<repo>/.graft/config.json` present, the step is skipped with a
   warning and the file is unchanged.
4. With outbound traffic blocked and captured, one build and 50 mixed queries
   make no connection attempt.
5. For each tool, a known symbol returns spans that match the file on disk,
   and an unknown one returns a diagnostic.
6. A query that matches a credential file or protected tree returns no path or
   code from it, in the main session and in a sub-agent.
7. Output never exceeds the character cap, and truncation is flagged.
8. After an edit, the background rebuild finishes and the next query sees the
   new span. The `stale` flag is set in between.
9. A developer's saved graft settings (for example `GRAFT_DIR`,
   `TRAIL_NO_FETCH=0`, a `graft savings-report` opt-in) have no effect inside
   PATCH.
10. Three sub-agents querying at once stay within the process and memory
    limits.
11. Malformed input (option-like tokens, `..`, absolute paths, CR/LF, very
    long strings) is rejected before any process starts.
12. If EBS is built in parts:
    - every part map is under `GRAFT_PROFILE_STORE` and `links` is
      `"current"` after Prepare;
    - a function called from another part shows that caller (text `callers`
      at the root, or structural `code_search`), or the result says that
      edges between parts are missing;
    - `code_find_all` with `path` set to one part returns hits from that
      part only;
    - a checkout with a developer's `graft/` map inside one part makes the
      step warn and the tools report "index unavailable".

## 8. Do not

- run graft through the agent's Low-IL shell, `npx`, a PATH lookup or an
  install on the target;
- use `graft init`, `graft mcp`, `graft env`, `build --deep`, `--lsp`,
  `blast --name`, or any `savings-report`, `login`, `connect` or `sync`
  command;
- let any query rebuild the index;
- show the model graft's raw text output, stderr, `notes`, absolute paths, or
  anything a PATCH guard rejects;
- fetch graft from registry.npmjs.org;
- weaken a PATCH guard, allowlist or integrity check to make graft fit;
- modify graft's files after installation (the payload hashes them).

## 9. What to deliver

1. The Phase 0 discovery note: answers with `file:line`, and the status of
   H1 to H19.
2. The code changes, phase by phase, each with tests.
3. The measured EBS numbers: build time, peak memory, `wiring.json` size,
   query latency (p50 and p95) per tool, and the shape chosen (single map,
   parts or `--only-dir`). For parts, add the number of parts, the largest
   part's `wiring.json`, the time and memory of the link step, and how
   `code_callers` handles edges between parts.
4. A final report with:
   - every deviation from this prompt and why;
   - the graft facts you checked, and any that differed from Appendix A;
   - the items still unverified;
   - graft changes that would simplify the integration (for example
     `callers --json` across parts with the links, build settings and part
     maps that follow `--dir`, a
     JSON mode for a long-running server, one "embedded" switch replacing the
     environment list);
   - "Open decisions" for the owner.

---

## Appendix A: graft reference (checked on graft 0.28.0, company fork)

### A.1 Package

- Name `@nanonets/graft`, ES modules, MIT licence. Node `^20.16.0 || >=22.3.0`.
- CLI entry `dist/bin/graft.js`. The package ships `dist/` (compiled
  JavaScript), `scripts/`, `vendor/*/prebuilds/**`, `vendor/oracledb/**`,
  `vendor/odpnet/**` (for the opt-in savings report; keep it off), example
  configs, README, LICENSE and `docs/changelog.html`.
- Library entry `dist/index.js` exposes only a `Graft` class with `ask`; the
  `exports` map blocks deep imports. Use the CLI.
- Native parser `tree-sitter` 0.21.1 with prebuilds including `win32-x64`.
  Bundled grammars in `vendor/<lang>/prebuilds/win32-x64/` (win32-x64 only):
  bash, c, cmake, cpp, css, csv, c_sharp, groovy, html, json, kotlin, make,
  markdown, matlab, perl, plsql, razor, scss, xml, yaml.
- `graft languages --json` lists the languages an installation supports.
- `graft where` prints the map folder and settings file a repository uses
  (useful in diagnostics). Global options go before the command name:
  `graft --dir <map> where <repo>`.

### A.2 Map folder and settings resolution

- `--dir <path>` (global) wins for the map folder. `GRAFT_DIR` covers internal
  paths that do not see `--dir`.
- Without them, graft uses, in this order: `<repo>/.trail/cache/`; in a repo
  with `.trail/learnings/` or trail hooks, an old `<repo>/graft/` map renamed
  to `.trail/cache/` (unless git tracks `graft/INDEX.md`); `<repo>/graft/` if
  it holds a map; otherwise the profile store
  (`<GRAFT_PROFILE_STORE>/<repo-folder>-<hash of path>/`).
- Build settings: `<repo>/.graft/config.json` if it exists; otherwise
  `<profile store>/<repo-folder>-<hash>/config.json`; otherwise (store off or
  unusable) `<repo>/.graft/config.json`. `--dir` does not affect this.
- Build options `--exclude-dir`, `--only-dir`, `--follow-submodules`,
  `--follow-nested-repos` and `--index-text` are saved in those settings and
  reused by later builds.

### A.3 Build

```
graft [--dir <map>] build [repo]
  --exclude-dir <name|path|glob>   repeatable; saved; replaces the saved list
  --only-dir <path>                repeatable; saved; part of the fingerprint
  --all-parts                      one map per part + workspace.json index + links
  --check [--json]                 report drift, build nothing
  --no-gitignore --no-ignore --no-workspace
  never: --deep --force -j --synth-concurrency --lsp (--no-reuse only for recovery)
```

- Exit 0 = built. Non-zero = failed; with `--all-parts`, also when parts
  failed or were too large. Error lines on stderr start with `✗`.
- Size limit: about 483 M characters of `wiring.json` per map; above that the
  build fails with `GraphTooLargeError` (code `GRAPH_TOO_LARGE`) and suggests
  folders. `--all-parts` splits too-large parts recursively, rewrites
  `workspace.json` after each part, and retries failed parts on the next build.
  It then makes the links between parts (`<map>/.cache/links.json`). A plain
  `build` of a root built in parts rebuilds every listed part and remakes the
  links; `--only-dir` or `--all-parts` replace that with a new plan.
- Part maps ignore `--dir`: each is kept where a build of the part's folder
  would keep it (A.2), normally the profile store. Each part's settings are
  derived from the root's (`--exclude-dir` re-rooted at the part).
- Build lock in the map folder; taken over only when its owner process is gone
  and it is older than 5 minutes (or older than 15 minutes in any case).

### A.4 Queries

All take `[dir]` (repository root), `--json` and `--no-refresh`. JSON goes to
stdout, pretty-printed. Errors go to stderr, starting with `✗`, with exit
code 1.

**`ask`**: `ask <query|-> [dir] --json --source -n <N> [--full] [--in <path>]`.
`-` reads the query from stdin. Default `-n` is 8. `--source` adds `code`: the
hit's definition, up to 80 lines, then `… (+N more lines; open path:Lx-Ly)`.
An excerpt of up to 8 lines (the "crux") replaces it only when the map was
built with `--deep` and `--full` is not given, so on PATCH's maps `--full` has
no effect. Searches all parts in a parts build; structural queries also
follow the links between parts.

```ts
AskResult {
  query: string;
  mode: "structural" | "lexical" | "empty";   // structural: "who calls X" style queries
  subject?: string;
  hits: AskHit[];                             // keep this order; do not re-sort
  note?: string;
  notes?: NoteHit[]; notesChecked?: boolean; notesHint?: string;   // remove in PATCH
  saved?: { files: number; baselineChars: number };
  coverage?: number; coverageStrong?: number; // 0..1
  scopes?: { federated: string[]; alsoMatched: { scope: string; bestId: string }[] };
}
AskHit {
  kind: "concept" | "symbol" | "caller" | "callee";   // no "concept" without --deep
  title: string;
  pointer: string;          // "path" or "path:Lx-Ly", repo-relative
  snippet: string;
  relation?: string; related?: string[];
  score: number;
  code?: string;            // with --source
  scope?: string;           // part label in parts builds
  parse_errors?: number;    // the file had syntax errors; information may be incomplete
}
```

**`grep`**: `grep <regex> [dir] --json [--fixed] [-i] [--in <path>]`. No index
or invalid regex: exit 1. Zero hits: exit 0 with `totalHits: 0`. Searches all
parts in a parts build and honours `--in` there (a part, a folder in one, or
a folder above several). `inDegree` includes edges from other parts when the
links are current. Older packages ignore `--in` in parts builds (A.6).

```ts
GrepResult {
  pattern: string; filesSearched: number; totalHits: number;
  groups: { symbol: { id, name, kind, path, span } | null;   // null = file level
            path: string; inDegree: number;                   // sorted by inDegree desc, path asc
            hits: { line: number; text: string /* up to 160 chars */ }[];
            parse_errors?: number }[];
  truncated: { files: number; hits: number };
  saved?: Savings;
}
```

**`skeleton`**: `skeleton <repo-relative path | unique file name> [dir] --json`.
Works across parts. How an unknown file is reported (in `note` or by exit code)
has not been checked.

```ts
SkeletonResult { file: string;
                 entries: { name; kind; span; signature: string | null; summary? }[];
                 note?: string; parse_errors?: number; saved?: Savings }
```

**`callers`**: `callers <symbol> [dir] --json [--direction in|out] [-d <n|all>] [--in <path>]`.
The symbol can be a bare name, `Class.method` or `pkg.Fn`. Exit 1 for no
index, unknown symbol, bad direction, bad depth or an unindexed `--in` prefix.
**With `--json` it does not search across parts**: it reads the root map, which
a parts build leaves empty. Without `--json` it does, at the root: one
`## <part>/` block per part defining the symbol, hits in other parts under
`across parts:` when the links are current. Otherwise it adds a line saying
callers in other parts are not tracked, and possibly text-match guesses
marked unverified.

```ts
{ query: string,
  matches: [ { symbol: { id, name, kind, path, span, parse_errors? },
               hits: [ { id, name?, kind?, path?, span?, relation, depth, parse_errors? } ],
               note?: string } ],          // note explains an empty result
  saved?: Savings }
```

Example (real output, shortened):

```json
{ "query": "repoKey",
  "matches": [ { "symbol": { "id": "src/context/profile-store.ts#repoKey", "name": "repoKey",
                             "kind": "function", "path": "src/context/profile-store.ts",
                             "span": "L110-L118" },
                 "hits": [ { "id": "src/context/profile-store.ts#profileRepoDir",
                             "relation": "calls", "depth": 1, "name": "profileRepoDir",
                             "kind": "function", "path": "src/context/profile-store.ts",
                             "span": "L121-L126" } ] } ],
  "saved": { "files": 2, "baselineChars": 34894 } }
```

**`parts`**: `graft --dir <map> parts [dir] --json`. Lists the parts of a
repository built in parts. It loads no map and does not refresh. Exit 1 when
there is no map at all (`kind: "none"`).

```ts
PartsReport {
  root: string;
  kind: "parts" | "repos" | "single" | "none";
  parts: { part: string;                 // folder from the repo root: the --in <part>/ name
           state: "built" | "not-built" | "gone";
           map: string;                  // absolute folder of that part's map
           files?: number; bytes?: number /* wiring.json */; builtAt?: string }[];
  links?: "current" | "stale" | "none" | "unavailable";   // kind "parts" only
  unlinked?: string[];                   // parts left out of current links
  here?: string; map?: string; files?: number; onlyDirs?: string[];   // map: single/none
}
```

### A.5 Network and writes, by feature

| Feature | Network or writes | In PATCH |
|---|---|---|
| Update check | npm registry lookup in a detached process | off: `DO_NOT_TRACK=1` |
| Price list | downloads a public price list for unknown models | off: `GRAFT_PRICES_AUTO_UPDATE=0` |
| `git fetch`, `gh pr list`, init look-back | off by default; `TRAIL_NO_FETCH=0` or `TRAIL_NO_LOOK_BACK=0` turn them on | strip all `TRAIL_*` |
| Savings report | uploads to a company Oracle database if opted in (the opt-in lives in `~/.graft`) | isolated home: never opted in |
| Cloud sync, telemetry | none in the company fork (permanently off) | fetch the fork's package only |
| `--deep`, `blast --name` | send code to an LLM endpoint | never |
| `--lsp` | starts local language servers | not used |
| Auto-init, trail switch | write assistant files into the repository | off: `GRAFT_NO_AUTO_INIT=1`, `GRAFT_NO_TRAIL_SWITCH=1` |
| `.gitignore` / `.ignore` edits | write into the repository | off: `GRAFT_NO_GITIGNORE=1`, `GRAFT_NO_IGNORE=1` |
| Map, caches, lock | write into the map folder | `--dir` and `GRAFT_DIR` outside the repository |
| Build settings | write `config.json` | profile store outside the repository; skip if `<repo>/.graft/config.json` exists |
| Part maps and part settings (parts builds) | written where a build of the part folder would put them, ignoring `--dir` | profile store; check each `parts[].map` after the build (6.3 step 7) |
| Links between parts | `<map>/.cache/links.json`, written by builds only | rebuild from the root (6.7) |

### A.6 Packages with and without links between parts

The parts behaviour above (links, `graft parts`, `grep --in` across parts,
the cross-part text output of `callers`) is in the fork's current code. That
code still reports version 0.28.0, but earlier 0.28.0 packages do not have
it. Find out which you have:
`graft parts --help` fails on an older package.

| Behaviour | With links | Older package |
|---|---|---|
| Edges between parts | stored in `<map>/.cache/links.json`, used by `ask` (structural), `grep` (`inDegree`) and text `callers` | not stored: a call into another part has no edge |
| `grep --in` at a parts root | honoured | ignored: filter by path in PATCH |
| `callers` text at the root | `## <part>/` blocks with `across parts:` | `## <part>/` blocks, edges within each part only |
| `callers --json` at the root | fails (no root map) | fails (no root map) |
| `graft parts` | lists parts, map folders, links state | absent: read `<map>/workspace.json` and find part maps with `graft where <repo>/<part>` (check this) |

## Appendix B: leads from an earlier review of PATCH engine v3.11.0 (unverified)

These names were seen during a review of PATCH engine v3.11.0
(`C:\tools\PATCH\runtime\engine\v3.11.0`). The PATCH repository you work in
may be organised differently or be a different version. Use them only as
search starting points, and confirm each one.

| Concern | Lead |
|---|---|
| Bundled Node | `engine/bin/node.exe` (Node 24.18.0) |
| Payload integrity | `payload-manifest.json` (`files[]` with SHA-256); `engine/host/install-integrity.js` with a `SAFETY_PATHS` list |
| Preflight | `engine/host/preflight.js`, a check with id `pi_tools` for rg/fd, severity `warn` |
| Prepare | `engine/host/prepare.js`: step list, `runPrepareStep`, a `componentsStep` running `.ebs/scripts/generate_active_components.sh` with a 600 s timeout, a `contextStep`; warnings such as `components_unavailable`; `sanitizeChildEnvironment` imported there |
| Script allowlist | `engine/host/script-runner.js` |
| Trusted operations | `app/resources/extensions/guardrails/trusted-tools.js` (closed operation set) |
| Tool registration | `app/resources/extensions/guardrails/index.ts`: `pi.registerTool`, `promptFor` / `TOOL_PROMPT_SNIPPETS`, `knowledgeOutputContract` (12,000-character cap), existing tools `courage_search` and `aflow_search`, an `isChild` flag for sub-agents, the Low-IL `workspace_shell` guard |
| Guards and budgets | `guardrails/credential-read-guard.js` (`credentialReadVerdict`), `protected-tool-trees.js` (`guardProtectedToolTrees`), `child-grep-budget.js`, `child-read-budget.js` |
| Sub-agents | `app/resources/extensions/subagents/role-catalog.ts` (`READ_ONLY_TOOLS`), `agents/scout.md` |
| Central prompt | `app/resources/prompts/AGENTS.src.md`, which generates `AGENTS.md`; `.ebs/context` is a generated mirror (do not edit) |
| Skills | `.ebs/skills/*`, hash-pinned, gated by `_scope.tsv` |
| Session start | `engine/host/session-runtime/runtime.js` (`noExtensions`, `noContextFiles`; leave unchanged); `engine/extension-groups.json` |
| EBS context | `.ebs/.active_flags`; a generated components file (name not confirmed) |
