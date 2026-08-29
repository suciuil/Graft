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

export function windsurfRule(): string {
  return `${instructionBody()}
`;
}
