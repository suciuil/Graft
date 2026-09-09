/**
 * What graft has saved this repo, per day and per model, for as long as it has
 * been installed here.
 *
 * `session-metrics.ts` answers "what did THIS session save"; a session file is
 * keyed by the host's session id, carries no dates, and is the wrong shape to
 * ask "what did graft save us in March". So the same two facts — tokens kept out
 * of the context, and what the tokens that WERE sent cost — are also appended
 * here, bucketed by local calendar day and by the model that was running. Days
 * are the finest bucket `graft savings` can be asked for, so nothing finer is
 * stored, and a day-by-model row is a few dozen bytes: a year of daily use is a
 * file measured in kilobytes.
 *
 * The model is the key because the price is per model, and a repo worked on with
 * two of them saved different amounts of money for the same tokens. When no
 * model can be named — a host that reports none and a repo that declares none —
 * the saving is filed under {@link UNKNOWN_MODEL} and reported in tokens alone,
 * never priced at a guess (see `context/price.ts` for why).
 */
import { join } from 'node:path';
import { cacheDir, readDeclaredModel, readJson, writeJsonAtomic } from '../util/state.js';
import { blendedRate, declaredRate, formatDollars, valueSaved, type InputRate } from '../context/price.js';
import { formatCount } from '../context/savings.js';
import type { ModelUsage } from './tally.js';

/** One model's running totals within one day. */
export interface ModelLedger {
  /** Tokens graft's retrieval kept out of the context (est.). */
  savedTokens: number;
  /** Micro-dollars this model's input tokens actually cost that day, and the
   * tokens that bought — the pair a measured rate is made of. Zero when the host
   * reports no billing, which reads as "not measured" everywhere downstream. */
  costMicros: number;
  tokensBilled: number;
}

/** `days[YYYY-MM-DD][model]`. A plain nested record so a period query is a
 * prefix match on the key and needs no index. */
export interface SavingsLedger {
  days: Record<string, Record<string, ModelLedger>>;
}

/** Filed under this when nothing names the model. Not a model id, so it can
 * never collide with one, and never priced. */
export const UNKNOWN_MODEL = 'unknown';

/**
 * The model the CODING AGENT is running — the one whose context window graft's
 * retrieval is keeping tokens out of, and therefore the only one whose price
 * says what a saving was worth.
 *
 * Deliberately NOT `GRAFT_MODEL`. That names the model graft's own `--deep`
 * enrichment pass calls (see `ai/providers.ts`), which is routinely a cheap
 * summarisation model pointed at a different gateway than the agent the user is
 * actually talking to. Pricing an agent's saved tokens at graft's summariser
 * rate is off by whatever the two models' list prices differ by — silently, and
 * in whichever direction — so the two are kept apart.
 */
export const AGENT_MODEL_ENV = 'GRAFT_AGENT_MODEL';

/**
 * The agent model named by the current invocation (`--agent-model`), if any.
 *
 * Process-level for the same reason `context/savings.ts` holds the rate that
 * way: one CLI process answers one query for one session, and the alternative
 * is threading an identifier through every retrieval formatter. Unset means
 * "nobody named one on this call", which falls through to env and config.
 */
let invocationModel: string | null = null;

/** Record the model the agent says it is running for this invocation. Blank and
 * undefined both clear it, so a host that interpolates an empty variable into
 * `--agent-model ""` falls through to env/config instead of pricing nothing. */
export function setAgentModel(model?: string | null): void {
  invocationModel = model && model.trim() ? model.trim() : null;
}

/** The local calendar day, which is the day the user means when they type one. */
export function dayKey(when: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/**
 * Which model a saving belongs to: the one the host's transcript reported for
 * the last turn, else the one this invocation named via `--agent-model`, else
 * `GRAFT_AGENT_MODEL`, else the `model` declared in `.graft/config.json`, else
 * unknown.
 *
 * Ordered by how close each source sits to the turn being priced. A stamped
 * model is what the session demonstrably ran; `--agent-model` is the agent
 * naming itself on this very call, which beats env and config because those are
 * standing declarations that go stale the moment the user switches models
 * mid-session — the exact case a per-call flag exists to cover.
 */
export function currentModel(dir: string, stamped?: string | null): string {
  if (stamped && stamped.trim()) return stamped.trim();
  if (invocationModel) return invocationModel;
  const env = process.env[AGENT_MODEL_ENV];
  if (env && env.trim()) return env.trim();
  return readDeclaredModel(dir) ?? UNKNOWN_MODEL;
}

/** One file for the whole history. Measured at ten years of daily use (7,300
 * day/model rows, ~900 kB): under 10ms to rewrite, ~4ms to read. Both are noise
 * beside the retrieval that triggered them, so the simpler layout wins. */
export function ledgerPath(d: string): string {
  return join(cacheDir(d), 'savings.json');
}

export function readLedger(d: string): SavingsLedger {
  const l = readJson<SavingsLedger>(ledgerPath(d));
  return l && typeof l.days === 'object' && l.days !== null ? l : { days: {} };
}

/** Read-modify-write of one day/model bucket. Best-effort and never throwing:
 * every caller is on a tool-call path, and a ledger entry is not worth failing a
 * turn over. Unlocked like `patchStats`, so a race loses a count, never the
 * file. */
function patchBucket(d: string, model: string, when: Date, patch: (b: ModelLedger) => void): void {
  try {
    const ledger = readLedger(d);
    const day = (ledger.days[dayKey(when)] ??= {});
    const bucket = (day[model] ??= { savedTokens: 0, costMicros: 0, tokensBilled: 0 });
    patch(bucket);
    writeJsonAtomic(ledgerPath(d), ledger);
  } catch {
    // A lifetime total is never worth failing a hook over.
  }
}

/** Fold one retrieval's saving into today's bucket for `model`. */
export function recordSavedTokens(d: string, model: string, savedTokens: number, when: Date = new Date()): void {
  if (!(savedTokens > 0)) return;
  patchBucket(d, model, when, (b) => { b.savedTokens += savedTokens; });
}

/** Fold one turn's input spend into today's buckets, one per model the turn ran.
 * Unpriced models are recorded at zero cost: their presence names the model, and
 * a zero pair reads as "not measured" to {@link blendedRate}. */
export function recordTurnBilling(d: string, models: ModelUsage[], when: Date = new Date()): void {
  for (const m of models) {
    const model = m.model.trim() || UNKNOWN_MODEL;
    patchBucket(d, model, when, (b) => {
      if (m.costMicros === null) return;
      b.costMicros += m.costMicros;
      b.tokensBilled += m.tokens;
    });
  }
}

/** A `yyyy`, `yyyy-mm` or `yyyy-mm-dd` filter — a literal prefix of a day key,
 * which is why the keys are stored in that order. */
const PERIOD = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

export function isPeriod(arg: string): boolean {
  return PERIOD.test(arg);
}

/** One model's savings over the queried period, priced when a rate exists. */
export interface ModelSavings extends ModelLedger {
  model: string;
  /** What those tokens were worth, or null when nothing prices this model. */
  value: { usd: number; measured: boolean } | null;
}

export interface SavingsReport {
  period: string | null;
  /** Days with at least one entry in range — how much history the totals rest on. */
  days: number;
  models: ModelSavings[];
  savedTokens: number;
  /** Dollars across the models that could be priced, or null when none could. */
  usd: number | null;
  /** Whether every priced model's rate was measured rather than declared. */
  measured: boolean;
  /** Tokens belonging to models with no rate at all — excluded from `usd`, and
   * named in the report so the dollar figure is never read as the whole story. */
  unpricedTokens: number;
}

/**
 * Roll the ledger up over a period, newest facts and oldest alike.
 *
 * A model's rate is its own measured one when the host billed it, and only then
 * the declared fallback — the same order every other surface uses, so a repo
 * with one measured model and one unpriced one reports each honestly instead of
 * pricing both at whichever rate was handy.
 */
export function aggregateSavings(ledger: SavingsLedger, period?: string | null): SavingsReport {
  const byModel = new Map<string, ModelLedger>();
  let days = 0;
  for (const [day, models] of Object.entries(ledger.days)) {
    if (period && !day.startsWith(period)) continue;
    days++;
    for (const [model, b] of Object.entries(models)) {
      const acc = byModel.get(model) ?? { savedTokens: 0, costMicros: 0, tokensBilled: 0 };
      acc.savedTokens += b.savedTokens ?? 0;
      acc.costMicros += b.costMicros ?? 0;
      acc.tokensBilled += b.tokensBilled ?? 0;
      byModel.set(model, acc);
    }
  }

  const models: ModelSavings[] = [];
  let savedTokens = 0;
  let usd = 0;
  let priced = false;
  let measured = true;
  let unpricedTokens = 0;
  for (const [model, b] of byModel) {
    // An unpriced or unknown model falls through to `declaredRate`, which prices
    // nothing it doesn't recognise — the row then reports tokens alone.
    const rate: InputRate | null = blendedRate(b.costMicros, b.tokensBilled) ?? declaredRate(model);
    const value = valueSaved(b.savedTokens, rate);
    models.push({ model, ...b, value });
    savedTokens += b.savedTokens;
    if (value) {
      priced = true;
      usd += value.usd;
      if (!value.measured) measured = false;
    } else {
      unpricedTokens += b.savedTokens;
    }
  }
  models.sort((a, b) => b.savedTokens - a.savedTokens || a.model.localeCompare(b.model));
  return {
    period: period ?? null,
    days,
    models,
    savedTokens,
    usd: priced ? usd : null,
    measured: priced && measured,
    unpricedTokens,
  };
}

const NOTHING_YET =
  'graft savings: nothing recorded yet — use graft in an agent session, then look again.';

/** The rendered readout `graft savings` prints. Tokens always, dollars only
 * where a rate exists, and a caveat wherever the rate was a list price rather
 * than something this repo was billed. */
export function formatSavingsReport(r: SavingsReport): string {
  const scope = r.period ? `— ${r.period}` : '— all time';
  if (r.models.length === 0) {
    return r.period
      ? `graft savings ${scope}: nothing recorded in that period.`
      : NOTHING_YET;
  }

  const rows = r.models.map((m) => ({
    model: m.model,
    tokens: `~${formatCount(m.savedTokens)} tokens`,
    value: m.value ? `~${formatDollars(m.value.usd)}` : '',
    note: m.value ? (m.value.measured ? '' : '(list rate)') : '(no rate — tokens only)',
  }));
  rows.push({
    model: 'total',
    tokens: `~${formatCount(r.savedTokens)} tokens`,
    value: r.usd === null ? '' : `~${formatDollars(r.usd)}`,
    note: r.unpricedTokens > 0 ? `(excludes ~${formatCount(r.unpricedTokens)} unpriced tokens)` : '',
  });

  const modelWidth = Math.max(...rows.map((x) => x.model.length));
  const tokenWidth = Math.max(...rows.map((x) => x.tokens.length));
  const valueWidth = Math.max(...rows.map((x) => x.value.length));
  const line = (x: (typeof rows)[number]) =>
    `  ${x.model.padEnd(modelWidth)}  ${x.tokens.padStart(tokenWidth)}  ${x.value.padStart(valueWidth)}${x.note ? `  ${x.note}` : ''}`.trimEnd();

  const dayCount = `${r.days} day${r.days === 1 ? '' : 's'} recorded`;
  const body = rows.slice(0, -1).map(line);
  return [
    `graft savings ${scope} · ${dayCount}`,
    ...body,
    `  ${'─'.repeat(modelWidth + tokenWidth + valueWidth + 4)}`,
    line(rows[rows.length - 1]),
  ].join('\n');
}
