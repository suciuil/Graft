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
import {
  NO_MODEL,
  RATE_ENV,
  envRate,
  formatDollars,
  type InputRate,
  type Pricing,
} from './price.js';

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
 * {@link setInputRate} is: one invocation answers one query for one repo, and the
 * alternative is threading a path through every retrieval formatter.
 *
 * Only used to address the config file the unpriced nudge points at. Null means
 * "nobody said", and the nudge then names the file without linking it.
 */
let repoRoot: string | null = null;

/** Tell this module which repo is being answered for. */
export function setRepoRoot(dir: string | null): void {
  repoRoot = dir && dir.trim() ? dir : null;
}

/** `.graft/config.json`, as a markdown link to the real file when the repo is
 * known so a chat host can open it on click, and as bare text when it isn't. */
function configTarget(): string {
  const label = '.graft/config.json';
  if (repoRoot === null) return label;
  try {
    return `[${label}](${pathToFileURL(buildConfigPath(repoRoot)).href})`;
  } catch {
    return label;
  }
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

/** A $/Mtok rate as a human would write it: `$5`, `$0.75`, `$1.25`. Not
 * {@link formatDollars}, which floors at `<$0.01` — that is right for a saving
 * (a real sub-cent amount is not nothing) and wrong for a rate, where the number
 * IS the fact being quoted and rounding it away would misquote the price. */
function formatRate(usdPerMtok: number): string {
  return `$${Number(usdPerMtok.toFixed(4))}`;
}

/** What the env override is doing right now, for the sentence that has to
 * explain why there is no dollar figure. "Not set" and "set to something
 * unusable" send the user to different fixes, so they are never conflated. */
function envOverrideState(): 'unset' | 'invalid' {
  if (envRate() !== null) return 'unset'; // unreachable in the unpriced branch
  const raw = process.env[RATE_ENV];
  return raw === undefined || raw.trim() === '' ? 'unset' : 'invalid';
}

/** The trailing half of "…cannot be estimated because X and also …". */
function envOverrideClause(): string {
  return envOverrideState() === 'invalid'
    ? `the ${RATE_ENV} environment variable was set to a value that is not a positive number`
    : `the ${RATE_ENV} environment variable was not set`;
}

/**
 * What goes in the parentheses of the tally the user actually reads, and the
 * matching explanation for the agent's own benefit.
 *
 * These two are separate on purpose. The prose sentence is read by the agent and
 * thrown away; the example is RELAYED, so anything the user must know — which
 * model was assumed, which rate, and who declared it — has to be inside the
 * example itself or it never arrives. Hence the parenthetical says the whole
 * thing in one breath rather than deferring to a caveat the reader never sees.
 *
 * The five shapes below are the five things graft can honestly know, ordered by
 * how much that is:
 *
 *  1. measured — the session's own billing. A bare `~$X`: nothing to caveat.
 *  2. certain model, known price — `~$X at $5/input mtok for claude-opus-5`.
 *     The host stamped the model or the agent named it on this call, and graft's
 *     table prices it. No override may touch either half; both are facts.
 *  3. certain model, no price — the model is new. Then, and only then, the
 *     `GRAFT_INPUT_USD_PER_MTOK` number fills in, and says so.
 *  4. declared model (`.graft/config.json`) — same two cases, but the tally
 *     names the file, because a standing declaration is exactly the thing that
 *     goes stale when the user switches models and nobody tells graft.
 *  5. no model at all — an override alone, or no figure and a plain statement of
 *     the two things that would produce one.
 */
function tallyDetail(rate: InputRate | null): string {
  const model = pricing.model;
  const name = rate?.model ?? model.id ?? null;
  const declared = model.confidence === 'declared';

  if (rate === null) {
    const why = name
      ? declared
        ? `graft has no info about the price per input mtok for the '${name}' model specified in the .graft/config.json file`
        : `graft has no info about ${name}'s price per input mtok`
      : 'no model was specified in the .graft/config.json file';
    return `the savings in dollars cannot be estimated because ${why} and also ${envOverrideClause()}`;
  }
  if (rate.measured) return '~$X';

  const at = `~$X at ${formatRate(rate.usdPerMtok)}/input mtok`;
  if (name === null || name === undefined) {
    // Nothing named a model, so the override is the entire basis — and the tally
    // says the config field is empty, which is the one thing the user can fix.
    return `${at} as specified by the ${RATE_ENV} environment variable and no model specified in the .graft/config.json`;
  }
  if (!rate.fromEnv) {
    return declared
      ? `${at} for ${name} specified as model in .graft/config.json`
      : `${at} for ${name}`;
  }
  return declared
    ? `${at} for ${name} specified as model in .graft/config.json and by the specified ${RATE_ENV} environment variable`
    : `${at} for ${name} specified by the ${RATE_ENV} environment variable`;
}

/** Appended to every retrieval footer so the agent reports the turn's running
 * total even when SKILL.md isn't loaded — the instruction rides along in the
 * tool output itself. Deliberately free of the `[graft] tokens saved ≈ <n>`
 * pattern so the PostToolUse accumulator that parses these footers never
 * mistakes the nudge (or its example) for a second number to count.
 *
 * Carries this call's dollar value once a rate is known, because the agent has
 * no way to price a token itself — the ask it's given has to contain the
 * number, not just request one. A declared list rate is worded as such: on a
 * host that reports no billing there is no cache discount to observe, so the
 * figure is an upper bound and must not claim to be what the session paid.
 *
 * When nothing can price the tokens, the tally now SAYS so — naming the model it
 * has no price for, or the empty config field — instead of quietly dropping the
 * money. "No figure" and "no figure because of this specific gap" look the same
 * to a reader, and only the second one can be acted on. The example phrasing
 * stays inside what `hasSavingsTally` (claude/tally.ts) recognises in every
 * branch, so wording changes here never quietly zero the reported-turns metric. */
export function savingsTurnNudge(savedTokens: number): string {
  const sum = ' — sum each such line across your graft calls — e.g. ';
  const rate = savedTokens > 0 ? pricing.rate : null;
  const example = `"\u{1F331} graft saved ~N tokens (${tallyDetail(rate)}) this turn"`;

  if (rate === null) {
    // Reached on exactly the hosts that report no billing and name no priced
    // model. The prose points at the file, linked, because that is the fix; the
    // example says the same thing in plain text, because that is what the user
    // gets to read.
    return (
      ' This call cannot be priced — set `model` in ' +
      `${configTarget()} (or ${RATE_ENV}) to have savings valued in $. At the ` +
      'end of your reply, tell the user the total graft tokens saved this turn ' +
      `and why they could not be priced${sum}${example}.`
    );
  }

  const usd = (savedTokens * rate.usdPerMtok) / 1_000_000;
  const name = rate.model ?? null;
  const basis = rate.measured
    ? 'the rate this session is actually paying for input tokens'
    : rate.fromEnv
      ? name
        ? `the ${RATE_ENV} override (graft has no list price for ${name})`
        : `the ${RATE_ENV} override (nothing here names a model)`
      : name
        ? pricing.model.confidence === 'declared'
          ? `${name} list rates (declared in .graft/config.json — correct it there if you have since switched models)`
          : `${name} list rates (the model named on this call)`
        : 'the list input-token rate configured for this repo';
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
