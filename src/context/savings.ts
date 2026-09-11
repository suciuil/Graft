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
 * What this session pays per input token and what we know about the model it is
 * paying it for — or, when nothing prices anything, just the model knowledge, so
 * the nudge can explain the ABSENCE of a figure instead of going quiet.
 *
 * Process-level because it is a process-level fact: one CLI invocation answers
 * one query for one session, and the alternative — threading a rate through
 * `withSavings` and all seven of its callers — would put a billing parameter in
 * the signature of every retrieval formatter for no gain. Set by the CLI's
 * `noteQuery` and by the MCP dispatch, both of which already resolve the repo
 * root; unset everywhere else, which is why the default is "no rate, no model".
 */
let pricing: Pricing = { rate: null, model: NO_MODEL };

/** Tell this module what an input token costs here, and for which model. Null
 * clears the rate, and so does anything that isn't a positive finite number — a
 * NaN from a zero-denominator rate must render as "no dollars known", never as
 * `$NaN` in the agent's face. The model knowledge survives a cleared rate: it is
 * exactly what the unpriced wording needs to name. */
export function setPricing(p: Pricing | null): void {
  const rate = p?.rate ?? null;
  pricing = {
    rate: rate && Number.isFinite(rate.usdPerMtok) && rate.usdPerMtok > 0 ? rate : null,
    model: p?.model ?? NO_MODEL,
  };
}

/**
 * The repo this process is answering for, held process-level for the same reason
 * {@link setPricing} is: one invocation answers one query for one repo, and the
 * alternative is threading a path through every retrieval formatter.
 */
let repoRoot: string | null = null;

/** Tell this module which repo is being answered for. */
export function setRepoRoot(dir: string | null): void {
  repoRoot = dir && dir.trim() ? dir : null;
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
export type ModelTable = (savedTokens: number) => Array<{ label: string; value: string }>;

let modelTable: ModelTable | null = null;

/** Supply the per-model rows shown when no single model can be named. Null
 * clears it, which is the correct state for every host that is not Kilo. */
export function setModelTable(rows: ModelTable | null): void {
  modelTable = rows;
}

/**
 * Everything this process has claimed in a `[graft] tokens saved ≈ N` line so
 * far.
 *
 * The two emitters below are the only places a saving is ever asserted, so
 * counting here is what makes the number filable without every print site in
 * the CLI growing a ledger call. Process-level for the same reason
 * {@link setInputRate} is: one invocation answers one query for one session.
 */
let claimedTokens = 0;

/** What this process has claimed, for the caller that files it. */
export function claimedSavings(): number {
  return claimedTokens;
}

/** Record a claim. Called by each footer emitter as it asserts a number —
 * including `ask`, which renders its own footer rather than going through
 * {@link savingsLine}. */
export function noteClaimedSavings(tokens: number): void {
  if (tokens > 0) claimedTokens += tokens;
}

/** Forget what has been claimed, so a long-lived process (the MCP server, which
 * files each call itself) cannot re-file the same tokens on the next one. */
export function resetClaimedSavings(): void {
  claimedTokens = 0;
}

/** How the agent should name the model in the tally: the host's display name
 * ("Claude Opus 5") when it gave one, else the wire id. The user chose the model
 * from a menu showing the former. */
function modelLabel(rate: InputRate): string | null {
  return rate.label ?? rate.model ?? null;
}

/**
 * The per-model table for the unpriced branch, as markdown rows.
 *
 * Returned as a single pre-rendered block rather than data because it has to
 * survive being relayed verbatim by an agent: anything requiring the agent to
 * lay out a table itself is something it will lay out differently every turn.
 * Empty string when no host table is available, which is every host but Kilo.
 */
function modelTableBlock(savedTokens: number): string {
  if (!modelTable || savedTokens <= 0) return '';
  let rows: Array<{ label: string; value: string }>;
  try {
    rows = modelTable(savedTokens);
  } catch {
    return ''; // a price table is never worth failing a retrieval over
  }
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.label.length));
  const body = rows.map((r) => `| ${r.label.padEnd(width)} | ${r.value} |`).join('\n');
  return `\n${body}\n`;
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
 */
function tallyExample(savedTokens: number, rate: InputRate | null): string {
  if (rate === null) {
    const table = modelTableBlock(savedTokens);
    return table
      ? '"\u{1F331} graft saved ~N tokens by this turn, which estimates in $ as ' +
          `following:${table}"`
      : '"\u{1F331} graft saved ~N tokens by this turn"';
  }
  if (rate.measured) return '"\u{1F331} graft saved ~N tokens (~$X) this turn"';
  const name = modelLabel(rate);
  return name
    ? `"\u{1F331} graft saved ~N tokens (~$X for ${name}) this turn"`
    : '"\u{1F331} graft saved ~N tokens (~$X) this turn"';
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
  const sum = ' — sum each such line across your graft calls — e.g. ';
  const rate = savedTokens > 0 ? pricing.rate : null;
  const example = tallyExample(savedTokens, rate);

  if (rate === null) {
    const priced = modelTableBlock(savedTokens)
      ? 'Reproduce the table exactly, summed across your graft calls, in a ' +
        'collapsed/expandable section. '
      : '';
    return (
      ' This call cannot be priced: nothing named the model you are running. ' +
      'At the end of your reply, tell the user the total graft tokens saved ' +
      `this turn. ${priced}Pass \`--agent-model <your model id>\` on your graft ` +
      `calls to have savings priced directly${sum}${example}.`
    );
  }

  const usd = (savedTokens * rate.usdPerMtok) / 1_000_000;
  const name = modelLabel(rate);
  const basis = rate.measured
    ? 'the rate this session is actually paying for input tokens'
    : `${name} list rates (the model named on this call)`;
  return (
    ` This call is worth ${formatDollars(usd)} at ${basis}. At the end of your ` +
    'reply, tell the user the total graft tokens saved this turn and what they ' +
    `were worth${sum}${example}.`
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
  claimedTokens += delta;
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
