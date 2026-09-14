/**
 * The one canonical Graft instruction block, rendered into each host's
 * native format. Content changes happen HERE only; renderers just wrap it.
 */

export function instructionBody(): string {
  return `## Graft — repo context graph

This repo is indexed in \`graft/\`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run \`graft map\` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

Invoke it as plain \`graft\` from the repo root — it is a CLI on your PATH, on
every OS including Windows. There is no binary checked into the repo: never
\`.\\graft.exe\`, \`./graft\`, or \`node graft.js\`. If \`graft\` is not found, fall
back to \`npx -y @nanonets/graft <args>\`.

- Run \`graft ask "<your question>" --source\` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; \`--full\` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  \`covers:\` file:line spans and edit straight from \`--source\`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run \`graft grep "<literal>"\` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw \`grep -rn\` only for unindexed files.
- \`graft skeleton <file>\` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- \`graft callers <symbol>\` gives precomputed, exact edges — who calls this.
  Add \`--direction out\` for what it calls, or \`--depth N\` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: \`graft/INDEX.md\` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry \`[scope/]\` labels naming which one they're from. Narrow with
  \`graft ask "<task>" --in <scope>/\` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

### The rule, stated as a rule

- Searching for a literal → \`graft grep "<literal>"\`. Not \`grep -rn\`, not
  \`rg\`, not the host's Grep tool.
- "What is in this file" → \`graft skeleton <file>\`. Not reading it whole.
- "Who calls this / what breaks if I change it" → \`graft callers <symbol>\`.
  Not a text search.
- Raw grep and whole-file reads are for what graft does NOT index: docs,
  config, lockfiles, files created this session — and for opening an exact
  \`file:line\` range graft just handed you.

This is a rule, not a preference: every one of those substitutions returns the
same answer for a fraction of the tokens, and the graph edges behind
\`callers\` are not reconstructible by reading at all.
Pass \`--agent-model <your own model id>\` on your graft calls when you know it
(e.g. \`graft ask "..." --source --agent-model claude-opus-5\`). Graft prices
the tokens it saves at YOUR model's rate, and it cannot see which model you are;
without this it reports the saving in tokens alone. Graft never guesses a model
and never reads one from a config file, so this flag is the only way to get a
dollar figure.
Every graft output ends with an example tally in quotes. Close your reply with
it, verbatim, substituting the summed tokens and dollars — it already says
exactly what may and may not be claimed about the price.
After big code changes, refresh the graph with \`graft build\` (deterministic,
no API key, $0).`;
}

export function cursorRule(): string {
  return `---
description: Use the Graft context graph in graft/ before exploring source
alwaysApply: true
---
${instructionBody()}
`;
}

export function kiroSteering(): string {
  return `---
inclusion: always
---
${instructionBody()}
`;
}

/**
 * Kilo Code rule files are plain markdown — no frontmatter. They are loaded by
 * being listed in `instructions` in kilo.jsonc, which hosts/kilo.ts writes.
 *
 * Kilo gets one section nobody else does. It reaches graft over MCP, where no
 * `--agent-model` flag can be passed and no transcript is stamped, so its
 * savings can never be priced at a single model. What it CAN do — uniquely —
 * is enumerate the models its own configuration offers, so graft hands it a
 * per-model table instead of a bare token count. The rule has to explain what to
 * do with that table, because the shape of the reply is otherwise unguessable.
 */
export function kiloRule(): string {
  return `${instructionBody()}

### Reporting what graft saved (Kilo Code)

**Send \`model: "<your model id>"\` with every graft tool call.** Kilo reaches
graft over MCP, which stamps no transcript, so this argument is the only way
graft learns what you are running. With it you get one exact figure —
\`🌱 graft saved ~5,548 tokens (~$0.03 for Claude Opus 5) this turn\` — and the
saving is recorded against that model in \`graft savings\` instead of as
"unknown".

Without it, graft cannot know the model, so its output carries a table pricing
this turn's saving under every model your Kilo configuration offers instead.

Close any reply where you used graft with that tally, summed across your graft
calls, and put the table in a **collapsed/expandable section** so it never
crowds out the answer itself:

    🌱 graft saved ~5,548 tokens by this turn, as estimated below:
    \`\`\`
    +-------------------+-------+
    | Claude Opus 5     | $3.12 |
    | Claude Sonnet 4.6 | $1.87 |
    | GPT 5.6 Sol       | $2.49 |
    | Gemini 3.8 Flash  | $0.47 |
    +-------------------+-------+
    \`\`\`

**Keep the fenced code block around the table.** The columns are held in line by
space padding, and an unfenced table is re-flowed by the chat renderer into a
wall of text — which defeats the point of showing a table at all.

Reproduce the rows graft gives you — do not add models, drop models, or reorder
them, and never price a token yourself. A model graft has no published rate for
is already absent from the table by design.
`;
}

export function windsurfRule(): string {
  return `${instructionBody()}
`;
}
