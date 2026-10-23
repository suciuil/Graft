## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

Invoke it as plain `graft` from the repo root — it is a CLI on your PATH, on
every OS including Windows. There is no binary checked into the repo: never
`.\graft.exe`, `./graft`, or `node graft.js`. If `graft` is not found, fall
back to `npx -y @nanonets/graft <args>`.

Decide whether you can run commands from the tools you actually have, never
from a guess about which chat mode you are in: if any tool runs a shell command
(a terminal, bash, PowerShell, a run-in-terminal tool), you CAN run commands, so
run graft with it. The fallback below is only for when no such tool exists, or a
graft call through it actually failed.

If you cannot run commands at all (a chat mode with no terminal, such as GitHub
Copilot's Ask mode, or a read-only or planning mode), do not treat graft as
unavailable, and do not fall back to listing source folders or reading READMEs.
If this host exposes graft's MCP tools (`graft_find_code`, `graft_find_all`,
`graft_file_api`, `graft_trace_calls`, `graft_repo_map`), use them: they answer
the same queries as the commands. Otherwise read the graph as plain files with
your file tools (read a file, list a folder):

- List the `graft/` folder. Each top-level `.md` file is a concept node named
  after the system it explains, with prose and the `file:line` spans it covers.
  Open the ones the question is about. `graft/INDEX.md` may list only some of
  them, so list the folder rather than relying on the index.
- For code, browse `graft/` instead of the source tree. Every source file has a
  card at the same path under `graft/` with the extension swapped for `.md`
  (`src/app/user.ts` → `graft/src/app/user.md`; a repo-root file whose name
  clashes with a concept node is under `graft/_root/`). A card lists each
  symbol with its line span and signature, so list `graft/src/…`, not
  `src/…`, and open a source file only at a span a card names.

Cite the `file:line` spans the nodes and cards give. The files carry no ranking
and none of the call edges behind `graft callers`, so say so when the answer
needed them. Do not write a `🌱 graft saved` line in this mode: no graft command
ran, so nothing was measured and any figure would be invented.

Whenever you could not run graft commands (no tool runs them, or the graft call
failed; never merely because you did not try), end your reply with this line,
verbatim, as its last line. It is required whether or not you read graft's
files, and even when the question did not need graft, because it is the only way
the user learns that graft was not working properly here and how to fix it:

ℹ️ To use graft properly, switch to Agent mode (or another mode that can run commands): graft could not run here, so it was used only partly or not at all.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

### The rule, stated as a rule

- Searching for a literal → `graft grep "<literal>"`. Not `grep -rn`, not
  `rg`, not the host's Grep tool.
- "What is in this file" → `graft skeleton <file>`. Not reading it whole.
- "Who calls this / what breaks if I change it" → `graft callers <symbol>`.
  Not a text search.
- Raw grep and whole-file reads are for what graft does NOT index: docs,
  config, lockfiles, files created this session — and for opening an exact
  `file:line` range graft just handed you.

This is a rule, not a preference: every one of those substitutions returns the
same answer for a fraction of the tokens, and the graph edges behind
`callers` are not reconstructible by reading at all.

### Verify before you assert

Every factual claim you make about this repo must come from something you have
actually read this session — a graft result or an exact `file:line` range you
opened — not from what the code is *likely* to do. Plausible is not the same as
true, and the reader cannot tell your guesses from your findings.

- Before stating that something exists, behaves a certain way, is called from
  somewhere, or is unused, run the query that settles it: `graft ask` /
  `graft grep` for behaviour and occurrences, `graft callers` for who calls what.
  It costs a few hundred tokens and takes under a second — cheaper than being
  wrong.
- "I can't find it" is a finding; "it isn't there" is a claim. Only `graft grep`
  (exhaustive) supports the second, never a top-N `graft ask`.
- Say so plainly when you did not verify something, when a query came back empty,
  or when you are reasoning from a general pattern rather than from this repo.
  An explicit "I haven't checked X" is useful; a confident sentence that turns
  out to be invented costs the reader more than the answer was worth.
- Re-verify instead of trusting recall when the code may have moved under you —
  after your own edits, or when your memory of a span is from earlier in a long
  session. Graft's results already reflect uncommitted edits.
- Never invent a symbol, path, file, flag, or option to fill a gap. If graft and
  the source do not show it, it does not exist; report the gap instead.

This is not a licence to re-read what you already have: a graft node's
`covers:` spans are generated from source and authoritative, so cite them
directly. The rule is that an assertion needs a source, not that a source needs
re-reading.

Pass `--agent-model <your own model id>` on EVERY graft call — treat it as part
of the command, like the query itself (e.g. `graft ask "..." --source
--agent-model claude-opus-5`). Graft prices the tokens it saves at YOUR model's
rate and cannot see which model you are, so without it the saving is reported in
tokens alone and filed as "unknown". It is the first call of a long session that
tends to get this right and the twentieth that quietly drops it.

Where the host itself records the running model (VS Code writes it into its chat
session files), graft falls back to reading that — so a saving is not always
lost. That backstop is keyed on the workspace, cannot tell two chats in one
window apart, and is always outranked by what you pass. Graft still never
guesses a model and never reads one from a config file.
Every graft output ends with an example tally. Close your reply with that line,
substituting the summed tokens and dollars — its wording already says exactly
what may and may not be claimed about the price. Write it as a plain line: no
surrounding quotation marks, and drop any trailing full stop that merely closed
graft's own sentence. The figures come only from graft output you received this
turn: when no graft command or tool ran, there is no tally, and you must never
write one.
When a `graft build --deep` is due, graft prints a `[graft] … recommended`
note and the example tally gets a second line, "⚠️ Run the 'graft build --deep'
command — recommended (…)". Keep that line under the tally when you close your reply, each
warning directly on the line below the previous one, with no blank line between
them; end each line that has a warning under it with two spaces (a markdown line
break), as graft's example does, so it is not folded into one line. Keep the
wording too, so the user sees exactly which command to run — it
is how the user learns the prose summaries are out of date. Do not run `graft
build --deep` yourself unless asked: it is an LLM pass that needs an API key
and costs tokens.
When a saving could not be priced because graft knows no price for the model,
the tally also gets a "⚠️ Run the 'graft prices update' command — recommended (…)" line. Keep it
under the tally too; do not run `graft prices update` yourself unless asked.
When the agent instructions in this repo are not the ones the installed graft
version writes (graft was updated since `graft init` last ran here), the tally
also gets a "⚠️ Run the 'graft init' command — recommended (…)" line. Keep it under the tally the
same way; do not run `graft init` yourself unless asked — it rewrites files
the user commits.
After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).

### Reporting what graft saved (Kilo Code)

**Send `model: "<your model id>"` with every graft tool call — every call, not
just the first.** Kilo reaches graft over MCP, which stamps no transcript, so
this argument is how graft learns what you are running. With it you get one
exact figure — `🌱 graft saved ~5,548 tokens (~$0.03 for Claude Opus 5) this
turn` — and the saving is recorded against that model in `graft savings`
instead of as "unknown".

It is the *first* call of a long conversation that tends to get this right and
the twentieth that quietly drops it. Treat the argument as part of the call, the
same way `query` is: a graft tool call without `model` is an incomplete call.
Send the id exactly as your configuration spells it (`vertex_ai/claude-opus-5`
and `claude-opus-5` are both fine — graft strips the routing prefix itself).

Graft falls back to reading Kilo's own session record when you omit it, so a
saving is not always lost — but that is a backstop keyed on the working
directory, not a substitute. It cannot tell two sessions in one directory apart,
and what you send always wins over it.

Close any reply where you used graft with that tally, summed across your graft
calls. Write it as plain prose — never wrapped in quotation marks. It is
something you are telling the user, not something you are quoting.

#### Only reproduce a table when graft printed one

When the model IS named — the line above says `for Gemini 3.8 Flash` — that one
figure is the whole answer. **Do not add a table.** A one-row table repeating the
number you just gave is noise, and a table you assemble yourself is a price you
invented: graft has already done the arithmetic, and the only honest figures are
the ones in its output.

A table appears **only** when graft could not identify the model at all. In that
case, and only then, its output ends with `as estimated below:` followed by a
fenced block listing *every* model your Kilo configuration offers — never one.
Copy that block verbatim into a **collapsed/expandable section** so it never
crowds out the answer:

    🌱 graft saved ~5,548 tokens by this turn, as estimated below:
    ```
    +-------------------+-------+
    | Claude Opus 5     | $3.12 |
    | Claude Sonnet 4.6 | $1.87 |
    | GPT 5.6 Sol       | $2.49 |
    | Gemini 3.8 Flash  | $0.47 |
    +-------------------+-------+
    ```

**Keep the fenced code block around the table.** The columns are held in line by
space padding, and an unfenced table is re-flowed by the chat renderer into a
wall of text — which defeats the point of showing a table at all.

Reproduce the rows graft gives you — do not add models, drop models, or reorder
them, and never price a token yourself. A model graft has no published rate for
is already absent from the table by design.
