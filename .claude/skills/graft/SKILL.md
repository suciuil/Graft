---
name: graft
description: This repo is indexed by graft/. For ANY task here, whether
  understanding how something works, finding where code lives, tracing what
  calls a symbol or what a change breaks, or scoping an edit, get your context
  from graft before grepping or reading source files.
---

# graft

`graft/` holds a graph of this repo: small markdown nodes that each explain one
part in prose and name the exact `file:line` spans they cover, plus a wiring
graph of who-calls-what. Querying a node costs a few hundred tokens; rebuilding
that understanding by reading source costs thousands, and misses the edges.

Every command below is `$0`, needs no API key, and returns in under a second.
There are six of them. **Pick the one that fits the task, run it, act on the
answer; don't chain tools hoping for more. Most tasks need one call.**

Invoke it as plain `graft` from the repo root: it is a CLI on your PATH, on
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

## The tools

### 1 · `graft ask "<question>" --source`: locate + understand (the default)
Ranked retrieval over the graph, routed automatically between prose nodes and
the wiring graph, returning the top hits with exact `file:line`.
- `--source` inlines the code at each hit, the ≤8-line **crux** of each
  definition, so the result IS the code you need, no follow-up file read. Add
  `--full` only when the crux is too small to act on.
- `--in <path>` narrows to a subtree before ranking; `-n N` caps results (default 8).
- **Use it when** the question is conceptual or locational: "how does auth
  work", "where is rate-limiting handled", "what assembles the request pipeline".
- One ask usually answers. A genuinely multi-part question needs one ask per
  distinct sub-aspect, never the same question reworded. Few or weak hits mean
  switch tool (grep / skeleton / callers), don't re-ask.

### 2 · `graft grep "<pattern>"`: exhaustive find
Regex (or `--fixed` for a literal) over every indexed file, hits **grouped by
enclosing symbol** and ranked by coupling; it also reports files it couldn't read.
- **Use it when** you need every occurrence: all call sites, all uses of a
  constant, all providers. `ask` is ranked top-N and *will* miss instances;
  grep won't. One grep replaces a spray of asks.
- Search a **short symbol name or literal**, not a full guessed signature: an
  over-specific regex (`func (s *Server) GenerateHandler`) returns nothing even
  when the code is indexed. If a grep misses, **loosen it** (drop the receiver
  and signature, keep the bare name) and retry `graft grep`. Do NOT switch to
  raw `grep -rn`, which is slower and unranked.
- `-i` case-insensitive; `--in <path>` scopes to a subtree. Raw `grep -rn` is
  only for files graft genuinely doesn't index (docs, configs, brand-new files).

### 3 · `graft skeleton <file>`: a file's API at a glance
Signatures-only view of one file (every function / method / type with its span)
in ~200 tokens, ~10x cheaper than reading the file.
- **Use it when** you need "what's in this file / what can I call here" before
  editing or wiring into it. One skeleton is the whole answer for a file; don't
  re-skeleton the same file, and don't skeleton every file `map` already named.

### 4 · `graft callers <symbol>`: the exact edges
Precomputed call/reference edges, not a text search. Symbol can be bare
(`Foo`), qualified (`Class.method`), or package-qualified (`pkg.Fn`).
- default `--direction in`: **who calls/references** this; run before you
  rename, delete, or change its signature.
- `--direction out`: **what this symbol itself calls/depends on** (the old `callees`).
- `--depth N`: walk transitively N hops for the **full blast radius** (the old
  `impact`); `--depth 2` is the usual "what breaks if I touch this".
- `--depth all`: the **entire connected closure**: every source reachable
  through the edges. Reach for this before a **refactor, rename, or any
  multi-file change**: it surfaces the sibling and downstream files (platform
  variants, a module you must split out) that a single-file edit would miss.

### 5 · `graft map`: orientation for an unfamiliar repo or area
A token-budgeted tour: directory clusters, per-directory hubs, and global
hotspots, straight from the wiring graph.
- **Use it when** you land in a repo cold or are asked for "the architecture".
  `map` alone is the answer: read the hub cards it names; do NOT then skeleton
  or ask your way through every subsystem it lists. `--max-dirs N` widens it.

### 6 · Lifecycle: `graft build` / `graft check`
Every tool above refreshes the graph itself before answering, so what those tools
return always describes the code as it is right now, including edits you just made
and have not committed. You do **not** need to run `build` after editing.

One caveat, if you `grep` the markdown under `graft/` directly: those cards are a
projection, rebuilt at the end of the turn rather than on each query, so after an edit
they can lag. The tools above never do: prefer them, and treat a card's spans as
stale if you have edited that file this turn.

`build` is for the LLM layer (`--deep` adds a concept map; skip unless asked);
`check` fails when `graft/` is stale, for CI.

## Scenarios: the shortest path through a coding task

| When you're… | Reach for | Calls |
|---|---|---|
| Onboarding / "explain this codebase" | `graft map`, then read the named hub cards | 1 |
| Understanding a flow ("how does X work") | `graft ask "<flow>" --source` | 1 |
| Finding where a change belongs | `graft ask "where is <behavior>" --source` | 1 |
| Editing a symbol you can already name | `graft grep "<symbol>"`, edit at the `file:line` (skip `ask`: you know where it is) | 1 |
| Renaming / deleting / changing a signature | `graft callers <sym> --depth 2` first | 1 |
| Refactor / multi-file change (before editing) | `graft callers <sym> --depth all`: map every connected file, don't stop at the first | 1 |
| "What does this depend on?" | `graft callers <sym> --direction out` | 1 |
| Finding every occurrence of a pattern | `graft grep "<literal>"` | 1 |
| "What's the API of this file?" | `graft skeleton <file>` | 1 |
| Debugging a failure in area X | `graft ask "<symptom>" --source`, then `callers` on the suspect | 1–2 |
| Judging a diff's risk before merge | `graft callers <changed sym> --depth 2` | 1 / symbol |
| Working inside one repo of a monorepo | add `--in <scope>/` to ask / grep / callers | n/a |

In a multi-repo workspace, graft ranks fairly so the biggest repo can't drown
the rest, and every hit carries a `[scope/]` label naming its sub-project; when
you already know where you're working, narrow with `graft ask "<task>" --in <scope>/`.

## Spend the fewest calls
- A node's `covers:` list already gives exact `file:line` for every symbol, so
  cite straight from it. The spans are generated from source and authoritative;
  don't re-open or re-grep files to "double-check".
- When the task already names the file or symbol to change, go straight there:
  `graft grep "<symbol>"` for the exact `file:line`, then edit. Reserve
  `graft ask` for when you don't yet know where the code lives: an `ask`
  round-trip is wasted on a target you can already name.
- Trust the answer and act. Reach for a second tool only when the first genuinely
  fell short: weak hits, a truncated span, or a need to be exhaustive.
- If graft names a path that isn't on disk, its index is ahead of your checkout
  (a branch switch or unpulled move). Don't read the missing file: `graft grep`
  the symbol to find where it lives now, or run `graft build` to refresh.

## Verify before you assert
Every factual claim you make about this repo must rest on something you actually
read this session (a graft result, or an exact `file:line` range you opened),
never on what the code is *likely* to do. Plausible is not true, and the reader
cannot tell your guesses from your findings.

- Before stating that something exists, behaves a certain way, is called from
  somewhere, or is unused, run the call that settles it: `ask`/`grep` for
  behaviour and occurrences, `callers` for the edges. One call, under a second,
  `$0`: always cheaper than being wrong.
- "I couldn't find it" is a finding; "it isn't there" is a claim. Only
  `graft grep` is exhaustive enough to support the second; a top-N `ask` is not.
- Say so plainly when you did not verify something, when a query came back empty,
  or when you are reasoning from a general pattern rather than from this repo.
  An explicit "I haven't checked X" is useful; a confident sentence that turns
  out to be invented costs more than the answer was worth.
- Re-verify rather than trust recall when the code may have moved under you:
  after your own edits, or when what you recall of a span is from earlier in a
  long session. Graft's results already reflect uncommitted edits.
- Never invent a symbol, path, file, flag, or option to fill a gap. If graft and
  the source don't show it, it doesn't exist; report the gap instead.

This does **not** mean re-reading what you already have: the `covers:` spans
above are authoritative, so cite them directly. An assertion needs a source; a
source does not need re-reading.

## Report what graft saved, every turn
Each retrieval tool **opens** its output with a `[graft] tokens saved ≈ N` line:
the estimated tokens that call saved versus reading the files it covers whole.
Whenever you used any graft tool in a turn, close your reply with a one-line
tally summing those numbers across every graft call you made, e.g.
`🌱 graft saved ~12,400 tokens this turn (3 calls)`. A call with no such line
(tiny files, where the pointers cost as much as the source) saved nothing, so
skip it. This is the per-turn figure; the statusline carries the running
session total. When no graft command or tool ran this turn there is no tally:
never write one from recall, from an earlier turn, or as an estimate.

Each line also ends with an example tally, closing the sentence and ending in
`this turn`. Use its **wording** verbatim, with `~$X` replaced by the summed
dollar value and `~N` by the summed tokens, e.g. `🌱 graft saved ~12,400 tokens
(~$0.04 for Claude Opus 5) this turn`. Write it as a plain line of your reply:
do not wrap it in quotation marks, and do not keep any punctuation that merely
ended graft's own sentence. Never price tokens yourself and never simplify the
parenthetical away: it is the only place the user learns which model their
saving was priced at. When the example carries no dollar figure, report the
tokens alone: graft could not identify the model, and a number you invent is
worse than none.

When a `graft build --deep` is due (summaries missing, or more of them out of
date than the repo's deep-threshold), the example tally gets a second line,
`⚠️ Run the 'graft build --deep' command: recommended (29% of summaries out of date, …)`. Keep that
line directly under the tally, with no blank line between them, and end the tally
line with two spaces (a markdown line break, as in graft's example) so a markdown
chat view does not fold the two into one line: it is the only place the user learns
that the prose summaries lag the code. Don't run `graft build --deep` yourself
unless asked: it is an LLM pass that needs an API key and costs tokens.

When a saving could not be priced because graft knows no price for the model,
the example tally also gets a `⚠️ Run the 'graft prices update' command: recommended (…)` line.
Keep it under the tally too: `graft prices update` fetches LiteLLM's public
price catalog once and stores it locally, so later savings are priced in dollars.
Don't run it yourself unless asked.

When the agent instructions in this repo are not the ones the installed graft
version writes (graft was updated since `graft init` last ran here), the example
tally also gets a `⚠️ Run the 'graft init' command: recommended (…)` line. Keep it under the tally
the same way, so the user learns to re-run `graft init` and get the latest
instructions. Don't run it yourself unless asked: it rewrites files the user
commits.

Pass `--agent-model <your own model id>` on your graft calls when you know it
(e.g. `graft ask "..." --source --agent-model claude-opus-5`). Graft prices the
tokens it saves at YOUR model's rate and cannot see which model you are, and it
will not read one from a config file, so this flag is the only thing standing
between a priced saving and one reported in tokens forever.

**Never pipe a graft command through `head`, `tail`, or `sed -n`** (nor
`grep`, `Select-Object -First/-Last`, `Select-String`, `findstr`). Every tool
is already capped and states what it dropped; clipping it costs you hits you
asked for, and it silently drops the savings line the statusline's running
total is parsed from. If one was clipped anyway, run `graft savings --last`: it
prints this turn's graft calls and the tally to close your reply with.

## The gate

On this host graft installs a `PreToolUse` hook. It refuses **once** per distinct
call when a tool call has a graft equivalent (a Grep/`rg`/`grep -rn` repo
search, or a whole-file `Read`/`cat` of an indexed file), and its message names
the command to run instead.

- **Do the redirect.** The refusal is not a permission problem to route around;
  the named command answers the same question for a fraction of the tokens.
- **A ranged read is never refused.** `Read` with an offset/limit, `head`,
  `tail`, `sed -n '10,40p'`: opening the exact span graft pointed at is the
  behaviour the gate exists to produce.
- **Re-issuing the identical call overrides it.** That is deliberate, and it is
  the right move when graft genuinely has no answer: an unindexed file, a doc, a
  lockfile, something created this session. It is the wrong move as a reflex:
  if you override without trying the named command, you paid the round trip for
  nothing.

`GRAFT_NO_GATE=1` disables it entirely (a human's switch, not a workaround).

## When graft isn't enough
- Span truncated ("+N more lines"): open the file at that exact range.
- A node lacks a detail: ask a more specific question; only then read source at
  the exact `file:line`, never a whole file to rebuild understanding graft gives.
- You may also grep / ls / cat inside `graft/` directly (plain markdown;
  `graft/INDEX.md` indexes the nodes), but the tools above are faster and
  exhaustive where it matters, so reach for them first.

When the graft MCP server is connected, these are exposed as tools too:
`graft_find_code`, `graft_find_all`, `graft_file_api`, `graft_trace_calls` (with
`direction` / `depth`), `graft_repo_map`, `graft_check_freshness`. Use whichever surface is
available; the guidance is identical.
