/**
 * Shared "tokens saved" estimate for every retrieval-style graft command.
 *
 * The model is always the same: baseline (what you'd have read otherwise, in
 * full) − this output (what graft handed you). The baseline is measured from
 * the `chars` the build stored on each file node, so it costs nothing and is
 * honest about the alternative — opening the files whole. When no file in the
 * baseline has a known size (a pre-`chars` graph), the estimate is omitted
 * rather than faked.
 *
 * `graft ask` keeps its own footer (it carries an escalation nudge and feeds
 * the session saved-token counter); everything else — skeleton, grep, callers,
 * map — routes through {@link savingsFor} + {@link withSavings} here.
 */
import type { GraphV1 } from '../graph/types.js';
import { pathToFileURL } from 'node:url';
import { buildConfigPath } from '../util/state.js';
import { NO_MODEL, formatDollars, type InputRate, type Pricing } from './price.js';
import { callScope, type ModelTable } from './call-scope.js';

export interface Savings {
  /** How many source files the baseline covers. */
  files: number;
  /** Total chars of those files — the "read them whole" cost. */
  baselineChars: number;
}

/** Rough tokens for a byte length (≈ 4 chars/token; good enough for an estimate). */
export function toTokens(chars: number): number {
  return Math.round(chars / 4);
}

/** path → char size, from the file nodes the build sized. Skips nodes with no
 * `chars` (pre-upgrade graphs), so an old index just yields a smaller baseline
 * rather than a wrong one. */
function fileSizes(graph: GraphV1): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of graph.nodes)
    if (n.kind === 'file' && typeof n.chars === 'number') m.set(n.path, n.chars);
  return m;
}

/** Baseline = whole size of the distinct `paths`, summed from file-node sizes.
 * Returns undefined when not a single path has a known size — the caller then
 * omits the estimate instead of claiming a bogus one. */
export function savingsFor(graph: GraphV1, paths: Iterable<string>): Savings | undefined {
  const sizes = fileSizes(graph);
  let baselineChars = 0;
  let files = 0;
  for (const p of new Set(paths)) {
    const c = sizes.get(p);
    if (c === undefined) continue;
    baselineChars += c;
    files++;
  }
  return files > 0 ? { files, baselineChars } : undefined;
}

/**
 * What this call pays per input token and what we know about the model it is
 * paying it for — or, when nothing prices anything, just the model knowledge, so
 * the nudge can explain the ABSENCE of a figure instead of going quiet.
 *
 * Held in the call scope rather than threaded through `withSavings` and all
 * seven of its callers, which would put a billing parameter in the signature of
 * every retrieval formatter for no gain. Set by the CLI's `noteQuery` and by the
 * MCP dispatch, both of which already resolve the repo root; unset everywhere
 * else, which is why the default is "no rate, no model". See `call-scope.ts` for
 * why this is per-call state and not a module-level slot.
 */

/** Tell this module what an input token costs here, and for which model. Null
 * clears the rate, and so does anything that isn't a positive finite number — a
 * NaN from a zero-denominator rate must render as "no dollars known", never as
 * `$NaN` in the agent's face. The model knowledge survives a cleared rate: it is
 * exactly what the unpriced wording needs to name. */
export function setPricing(p: Pricing | null): void {
  const rate = p?.rate ?? null;
  callScope().pricing = {
    rate: rate && Number.isFinite(rate.usdPerMtok) && rate.usdPerMtok > 0 ? rate : null,
    model: p?.model ?? NO_MODEL,
  };
}

/** Tell this module which repo is being answered for. */
export function setRepoRoot(dir: string | null): void {
  callScope().repoRoot = dir && dir.trim() ? dir : null;
}

/**
 * The per-model price table for the unpriced branch, injected rather than
 * imported.
 *
 * `hosts/models.ts` reads the user's agent configuration off disk; wiring that
 * into this module directly would make every retrieval formatter — including the
 * ones under test — depend on whatever Kilo config the developer's machine
 * happens to have. The MCP dispatch and the CLI set it; tests set their own.
 */
export type { ModelTable };

/** Supply the per-model rows shown when no single model can be named. Null
 * clears it, which is the correct state for every host that is not Kilo. */
export function setModelTable(rows: ModelTable | null): void {
  callScope().modelTable = rows;
}

/**
 * Whether this call arrived over MCP rather than as a CLI invocation.
 *
 * The unpriced nudge otherwise tells the agent to pass `--agent-model`, which is
 * a CLI flag: over MCP there is no such parameter, so the advice is impossible
 * to act on. An instruction an agent cannot follow is worse than no instruction
 * — it spends tokens and teaches the agent that graft's guidance can be ignored.
 */
export function setMcpSurface(on: boolean): void {
  callScope().overMcp = on === true;
}

/**
 * Everything this call has claimed in a `[graft] tokens saved ≈ N` line so far.
 *
 * The two emitters below are the only places a saving is ever asserted, so
 * counting here is what makes the number filable without every print site in
 * the CLI growing a ledger call. Per-call, like the rest of the scope: on the
 * MCP server two overlapping calls would otherwise both file the sum of their
 * tokens, double-counting every concurrent pair.
 */

/** What this call has claimed, for the caller that files it. */
export function claimedSavings(): number {
  return callScope().claimedTokens;
}

/** Record a claim. Called by each footer emitter as it asserts a number —
 * including `ask`, which renders its own footer rather than going through
 * {@link savingsLine}. */
export function noteClaimedSavings(tokens: number): void {
  if (tokens > 0) callScope().claimedTokens += tokens;
}

/** Forget what has been claimed. A scoped call gets a fresh counter anyway; this
 * stays for the process-level store the CLI and the hooks share. */
export function resetClaimedSavings(): void {
  callScope().claimedTokens = 0;
}

/** How the agent should name the model in the tally: the host's display name
 * ("Claude Opus 5") when it gave one, else the wire id. The user chose the model
 * from a menu showing the former. */
function modelLabel(rate: InputRate): string | null {
  return rate.label ?? rate.model ?? null;
}

/**
 * The per-model table for the unpriced branch, drawn with ASCII box borders.
 *
 * Pre-rendered here rather than handed over as data, because it has to survive
 * being relayed verbatim by an agent: anything that asks the agent to lay a
 * table out itself is something it lays out differently every turn.
 *
 * ASCII rules and column padding rather than a markdown table, and wrapped in a
 * fence by the caller, for one reason: a chat host only draws a markdown table
 * when it sees a `|---|` delimiter row, and pipe-delimited lines WITHOUT one
 * render as a wall of plain text — which is exactly how this first shipped. A
 * fenced ASCII box needs no cooperation from the renderer and looks the same
 * everywhere, including in terminals and diffs where markdown is never parsed.
 *
 * Labels are left-aligned and values right-aligned, so the dollar amounts line
 * up on their last digit and the column can be compared by eye.
 *
 * Empty string when no host table is available, which is every host but Kilo.
 */
function modelTableBlock(savedTokens: number): string {
  const modelTable = callScope().modelTable;
  if (!modelTable || savedTokens <= 0) return '';
  let rows: Array<{ label: string; value: string }>;
  try {
    rows = modelTable(savedTokens);
  } catch {
    return ''; // a price table is never worth failing a retrieval over
  }
  if (rows.length === 0) return '';
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  const valueWidth = Math.max(...rows.map((r) => r.value.length));
  const rule = `+-${'-'.repeat(labelWidth)}-+-${'-'.repeat(valueWidth)}-+`;
  const body = rows
    .map((r) => `| ${r.label.padEnd(labelWidth)} | ${r.value.padStart(valueWidth)} |`)
    .join('\n');
  return `\n${rule}\n${body}\n${rule}\n`;
}

/**
 * What goes in the tally the user actually reads.
 *
 * The prose sentence around it is read by the agent and thrown away; the example
 * is RELAYED. So anything the user must know — which model, which figure — has
 * to be inside the example itself or it never arrives.
 *
 * Exactly two shapes now, because graft only has two honest states:
 *
 *  1. We know the model (the host stamped it, or `--agent-model` named it) and
 *     can price it: `~$0.03 for Claude Opus 5`. One figure, attributable.
 *  2. We do not: tokens alone. On Kilo, where the agent's own configuration
 *     lists the candidate models, that is followed by a table pricing this
 *     saving under each — the user reads their own row. Everywhere else the
 *     token count stands by itself.
 *
 * Returned WITHOUT surrounding quotes, and this matters more than it looks. The
 * example used to be wrapped in `"…"` to show the agent where it began and
 * ended — but the same prose tells the agent to reproduce it verbatim, so the
 * quotes were reproduced too, and the line the user read came out as
 * `"🌱 graft saved ~568,292 tokens by this turn"` with the quotes still on it.
 * A delimiter the reader can see is a delimiter in the wrong place: the example
 * now ends the sentence, which is boundary enough for the agent and leaves
 * nothing for it to copy by mistake.
 */
function tallyExample(savedTokens: number, rate: InputRate | null): string {
  if (rate === null) {
    const table = modelTableBlock(savedTokens);
    // Fenced, because the column padding IS the table: unfenced, a chat host
    // collapses the runs of spaces and the box falls apart. The fence is part
    // of the example so the agent relays it along with everything else.
    return table
      ? `\u{1F331} graft saved ~N tokens by this turn, as estimated below:\n\`\`\`${table}\`\`\``
      : '\u{1F331} graft saved ~N tokens by this turn';
  }
  if (rate.measured) return '\u{1F331} graft saved ~N tokens (~$X) this turn';
  const name = modelLabel(rate);
  return name
    ? `\u{1F331} graft saved ~N tokens (~$X for ${name}) this turn`
    : '\u{1F331} graft saved ~N tokens (~$X) this turn';
}

/**
 * The example as it ends the nudge sentence.
 *
 * A full stop closes the prose, except after the fenced table — a `.` hanging
 * off the closing fence would be both ugly and, since the whole block is copied
 * verbatim, reproduced in the user's reply.
 */
function tallyTail(example: string): string {
  return example.endsWith('```') ? example : `${example}.`;
}

/** Appended to every retrieval footer so the agent reports the turn's running
 * total even when SKILL.md isn't loaded — the instruction rides along in the
 * tool output itself. Deliberately free of the `[graft] tokens saved ≈ <n>`
 * pattern so the PostToolUse accumulator that parses these footers never
 * mistakes the nudge (or its example) for a second number to count.
 *
 * Carries this call's dollar value once a rate is known, because the agent has
 * no way to price a token itself — the ask it's given has to contain the
 * number, not just request one. A list rate is worded as such: on a host that
 * reports no billing there is no cache discount to observe, so the figure is an
 * upper bound and must not claim to be what the session paid.
 *
 * When no model can be named, no dollar figure is invented. Instead the agent is
 * handed either a per-model table (Kilo, whose configuration lists the
 * candidates) or nothing at all — a bare token count. The example phrasing stays
 * inside what `hasSavingsTally` (claude/tally.ts) recognises in every branch, so
 * wording changes here never quietly zero the reported-turns metric. */
export function savingsTurnNudge(savedTokens: number): string {
  // Leading space, not leading punctuation: each branch below ends its own
  // sentence, so this only joins them.
  const sum = ' Sum each such line across your graft calls — e.g. ';
  const scope = callScope();
  const rate = savedTokens > 0 ? scope.pricing.rate : null;
  const example = tallyExample(savedTokens, rate);

  if (rate === null) {
    // What to do about it, named per surface so the agent is never told to use
    // something that does not exist where it is running:
    //   - a per-model table (Kilo, no model sent) — relay it; that IS the
    //     answer, so no other advice belongs in the same breath;
    //   - over MCP, the `model` tool argument;
    //   - on the CLI, the `--agent-model` flag.
    // Both of the latter turn the next call into an exactly-priced one, and file
    // the saving under a real model instead of `unknown`.
    const instruction = modelTableBlock(savedTokens)
      ? 'Reproduce the table exactly, summed across your graft calls, in a ' +
        'collapsed/expandable section.'
      : scope.overMcp
        ? 'Send `model: "<your model id>"` with your graft tool calls to have ' +
          'savings priced directly.'
        : 'Pass `--agent-model <your model id>` on your graft calls to have ' +
          'savings priced directly.';
    return (
      ' This call cannot be priced: nothing named the model you are running. ' +
      'At the end of your reply, tell the user the total graft tokens saved ' +
      `this turn. ${instruction}${sum}${tallyTail(example)}`
    );
  }

  const usd = (savedTokens * rate.usdPerMtok) / 1_000_000;
  const name = modelLabel(rate);
  const basis = rate.measured
    ? 'the rate this session is actually paying for input tokens'
    : `${name} list rates (the model named on this call)`;
  // "One line, no table" is stated explicitly because the alternative was
  // observed: on a host whose rule file describes a per-model table for the
  // UNPRICED case, an agent that had just been given an exact figure produced
  // the table anyway — with a single row repeating the number it had already
  // reported. A price graft did not print is a price the agent computed, which
  // is the one thing this whole module exists to prevent.
  return (
    ` This call is worth ${formatDollars(usd)} at ${basis}. At the end of your ` +
    'reply, tell the user the total graft tokens saved this turn and what they ' +
    'were worth, as ONE line — no table: this call is priced, and a table ' +
    `belongs only to a call that is not.${sum}${tallyTail(example)}`
  );
}

/**
 * Group a token count for display, always in en-US.
 *
 * Pinned, not machine-locale: a bare `toLocaleString()` renders 1970 as "1.970"
 * on a de/ro/etc. machine, which reads as a decimal to both the human and the
 * agent that is asked to sum these numbers — and it broke the savings tests on
 * any non-en-US developer box. `cli-epilogue.ts` already pins the same way.
 */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** The one-line savings estimate for a command's text output, so the agent gets
 * the number for free — no extra tool call. `body` is the exact rendered output
 * the agent reads (the pack). Returns "" when there's nothing honest to claim:
 * no baseline, or the output isn't actually smaller than reading the files
 * (tiny files, where the pointers cost more than the source). */
export function savingsLine(body: string, saved: Savings | undefined): string {
  if (!saved || saved.baselineChars <= 0) return '';
  const pack = toTokens(body.length);
  const base = toTokens(saved.baselineChars);
  if (base <= pack) return '';
  const delta = base - pack;
  const pct = Math.round((delta / base) * 100);
  noteClaimedSavings(delta);
  return (
    `[graft] tokens saved ≈ ${formatCount(delta)} (${pct}%) — this output ≈ ` +
    `${formatCount(pack)} tok vs reading the ${saved.files} file(s) it covers whole ≈ ` +
    `${formatCount(base)} tok (estimate).` +
    savingsTurnNudge(delta)
  );
}

/**
 * Sum every `[graft] tokens saved ≈ N` footer in a blob of text — the reader
 * half of {@link savingsLine}, kept next to the writer so the two never drift.
 * A single blob can carry several (an agent that made two graft calls in one
 * turn); the nudge from `savingsTurnNudge` deliberately omits the pattern, so its example
 * text is not miscounted here.
 */
export function sumSavingsFooters(text: string): number {
  let total = 0;
  for (const m of text.matchAll(/\[graft\] tokens saved ≈ ([\d,]+)/g)) {
    total += Number(m[1].replace(/,/g, '')) || 0;
  }
  return total;
}

/** Render `body` with the savings line on TOP.
 *
 * Deliberately a header, not a footer: agents routinely pipe graft through
 * `head -N` (and hosts truncate long tool output from the end), which silently
 * ate the number and, with it, the PostToolUse accumulator that feeds the
 * statusline's `~N tok saved`. Every clipper keeps the head, so the number
 * survives. Emitted once — a second copy at the bottom would be double-counted
 * by that accumulator's `matchAll`. */
export function withSavings(body: string, saved: Savings | undefined): string {
  const line = savingsLine(body, saved);
  return line ? `${line}\n\n${body}` : body;
}
