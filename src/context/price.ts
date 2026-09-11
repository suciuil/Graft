/**
 * What a saved token was actually worth, in dollars.
 *
 * `savings.ts` answers "how many input tokens did graft keep out of the
 * context"; this answers "what does an input token cost here". The two are
 * deliberately separate: the token count is arithmetic over file sizes and is
 * true everywhere, while the price depends on which model the session ran and
 * how much of its context was served from cache — facts only the host's
 * transcript knows.
 *
 * Nothing here guesses. A model we don't have a price for yields null, and the
 * callers then render the token count alone rather than a dollar figure we made
 * up. The one way a number appears without a measurement is when the user
 * declares one — a `model` in `.graft/config.json`, or the bare
 * `GRAFT_INPUT_USD_PER_MTOK` override — which is what the many hosts that expose
 * no billing at all (Copilot, Kilo, Codex, Cursor) have to fall back on. A
 * declared rate is still not a guess, but it IS a list rate with no observable
 * cache discount, so it carries `measured: false` and every surface labels it. A
 * wrong number on the statusline is worse than no number; an unlabelled one is
 * worse still.
 *
 * Precedence, once and for all (see {@link pricingFor}): what the session was
 * BILLED, else this table's list price for the model we know we ran, else the
 * env override. The override is last because it is the crudest of the three —
 * a bare number nobody can check against a model — so it fills the hole the
 * other two leave rather than papering over an answer they already have.
 */

/** Input $/Mtok, list price, per model family. Output tokens are irrelevant —
 * what graft saves is context the agent would otherwise have read IN.
 *
 * First match wins, so patterns must stay mutually exclusive. Non-Anthropic
 * families are priced at their SHORT-context standard rate: the long-context
 * tier only starts billing above a prompt size we cannot see from a savings
 * count, and quoting the higher tier would overstate every figure. */
const INPUT_USD_PER_MTOK: ReadonlyArray<readonly [RegExp, number]> = [
  [/^claude-(fable|mythos)-5/i, 10],
  [/^claude-opus-(5(-0)?|4[.-][5-8])/i, 5],
  [/^claude-sonnet-5(-0)?/i, 2],
  [/^claude-sonnet-4[.-][56]/i, 3],
  [/^claude-3[.-]7-sonnet/i, 3],
  [/^claude-haiku-4[.-]5/i, 1],
  [/^gpt-5[.-]6-sol/i, 4],
  [/^gpt-5[.-]6-terra/i, 2],
  [/^gpt-5[.-]6-luna/i, 0.2],
  [/^gpt-5[.-]5/i, 5],
  [/^gpt-5[.-]4-mini/i, 0.75],
  [/^gpt-5[.-]4-nano/i, 0.2],
  [/^gpt-5[.-]4/i, 2.5],
  [/^gpt-5[.-]3-codex/i, 1.75],
  [/^gpt-5[.-]2/i, 1.75],
  [/^gpt-5[.-]1/i, 1.25],
  [/^gpt-5-mini/i, 0.25],
  [/^gpt-5-nano/i, 0.05],
  [/^gpt-5(-chat)?$/i, 1.25],
  [/^gpt-4o-mini/i, 0.15],
  [/^gpt-3\.?5-turbo/i, 0.5],
  [/^(gpt-)?o3-mini/i, 1.1],
  [/^gemini-3[.-][678]-flash/i, 0.75],
  [/^gemini-3[.-]5-flash-lite/i, 0.3],
  [/^gemini-3[.-]5-flash/i, 1.5],
  [/^gemini-3[.-]1-flash-lite/i, 0.25],
  [/^gemini-2[.-]5-pro/i, 1.25],
  [/^gemini-2[.-]5-flash-lite/i, 0.1],
  [/^gemini-2[.-]5-flash/i, 0.3],
  [/^grok-4[.-]3/i, 1.25],
  [/^grok-4-fast/i, 0.2],
  [/^grok-3/i, 2],
  [/^deepseek-v4[.-]pro/i, 1.32],
  [/^deepseek-v4[.-]flash/i, 0.44],
  [/^deepseek-v3[.-]2/i, 0.27],
  [/^kimi-k2[.-]6/i, 0.8],
  [/^kimi-k2-thinking/i, 0.6],
];

/**
 * A model id reduced to the form the table is written in: routing prefix
 * dropped, and the separators a human types (spaces, underscores) folded to the
 * hyphens a model id uses.
 *
 * The two prefix shapes are what hosts and marketplaces actually display:
 * `anthropic/claude-opus-5` names who SERVES the model, and `Google: Gemini 3.8
 * Flash` is a vendor label on a UI row. The `word:` rule is deliberately
 * letters-only so it can strip `Google:` without touching a real suffix like
 * `gemini-3.8-flash:free`, whose left side carries digits and dots.
 */
export function normalizeModelId(model: string): string {
  const trimmed = model.trim();
  const routed = trimmed.slice(trimmed.lastIndexOf('/') + 1).trim();
  return routed.replace(/^[A-Za-z]+\s*:\s*/, '').replace(/[\s_]+/g, '-');
}

/** List input price for a model id, or null when we don't know it — a model
 * released after this table was written, or a host reporting something else
 * entirely. Null propagates all the way to "render tokens only".
 *
 * Any provider routing prefix is dropped before matching: a gateway host names
 * the model `anthropic/claude-opus-5` or `azure/eastus/gpt-5.6-luna`, where
 * everything up to the last `/` says who SERVES the model rather than which one
 * it is — and the table's patterns are anchored, so the prefix would otherwise
 * turn a priced model into an unpriced one. Only the lookup normalises; callers
 * keep filing savings under the id the host reported, so two routes to the same
 * model stay distinguishable in the ledger. */
export function inputUsdPerMtok(model: unknown): number | null {
  if (typeof model !== 'string') return null;
  const raw = model.trim();
  if (!raw) return null;
  const id = normalizeModelId(raw);
  if (!id) return null;
  for (const [pattern, usd] of INPUT_USD_PER_MTOK) if (pattern.test(id)) return usd;
  return null;
}

/** One turn's input-token usage, as the host's transcript reports it. */
export interface TurnUsage {
  model: string;
  /** Fresh tokens, billed at the list rate. */
  input: number;
  /** Written to the cache this turn — a 25% premium over list. */
  cacheCreate: number;
  /** Served from cache — a tenth of list, and usually the bulk of a long turn. */
  cacheRead: number;
}

/** Cache-write costs 1.25x list, a cache read a tenth of it. The multipliers are
 * why a measured rate beats an assumed one: a session deep into a long
 * conversation pays nearer $0.50/Mtok than the $5.00 its model lists at.
 *
 * Shared across all three vendors in the table above rather than per-family
 * because, as of writing, all three publish exactly these ratios. */
const CACHE_CREATE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** Micro-dollars, so a running total stays an integer and never drifts. */
const MICROS_PER_USD = 1_000_000;

/** What this turn's input tokens cost, in micro-dollars, or null on a model we
 * have no price for. */
export function turnInputCostMicros(usage: TurnUsage): number | null {
  const list = inputUsdPerMtok(usage.model);
  if (list === null) return null;
  const weighted =
    usage.input +
    usage.cacheCreate * CACHE_CREATE_MULTIPLIER +
    usage.cacheRead * CACHE_READ_MULTIPLIER;
  return Math.round((weighted * list * MICROS_PER_USD) / 1_000_000);
}

/** Every input token this turn was billed for, cached or not — the denominator
 * of the blended rate. */
export function turnInputTokens(usage: TurnUsage): number {
  return usage.input + usage.cacheCreate + usage.cacheRead;
}

/** What one input token costs here, and whether that came from this session's
 * own billing or from a price the user declared. Provenance travels WITH the
 * number because every surface has to word itself differently for the two:
 * "the rate this session is actually paying" is a lie about a list rate. */
export interface InputRate {
  usdPerMtok: number;
  measured: boolean;
  /** The model this rate is being applied TO, so surfaces can name it. Named
   * even when the number came from the env override: the user still wants to
   * read which model their tokens were priced for, and a rate that names the
   * model it assumed is the only kind a reader can catch out. Absent for a
   * measured rate (the session is the proof) and when nothing named a model. */
  model?: string;
  /** We KNOW this is the model that ran: the host stamped it in the transcript,
   * or the agent named itself on this very call with `--agent-model`. The price
   * may still be list, but the model is not a guess — the distinction the
   * user-facing tally has to make, or a standing `.graft/config.json`
   * declaration (which a mid-session model switch silently invalidates) reads as
   * confidently as a measured turn. */
  named?: boolean;
  /** The NUMBER came from `GRAFT_INPUT_USD_PER_MTOK` rather than from graft's
   * own table. Only ever set when the table had no price to offer: a rate we
   * know is right is never overridden by a bare number the user typed once. */
  fromEnv?: boolean;
}

/**
 * How sure we are of the model a saving should be priced at — the axis the
 * whole precedence below turns on.
 *
 * `certain` is a model the host stamped in its transcript or the agent named on
 * this very call: it is what the turn actually ran, so nothing may override it.
 * `declared` is the standing `model` in `.graft/config.json`, which is the
 * user's best guess and goes stale the moment they switch models in their host's
 * UI. `unknown` is a host that names no model over a repo that declares none.
 */
export type ModelConfidence = 'certain' | 'declared' | 'unknown';

/** The model a saving belongs to, and how sure we are of it. */
export interface AgentModel {
  /** The model id, or null when nothing named one (`confidence: 'unknown'`). */
  id: string | null;
  confidence: ModelConfidence;
}

/** Nothing named a model. */
export const NO_MODEL: AgentModel = { id: null, confidence: 'unknown' };

/**
 * A rate to price a saving at, plus the model knowledge behind it — including
 * when there is no rate, because the ABSENCE has to be explained too ("graft has
 * no price for claude-opus-6, and you set no override") and only the model
 * knowledge can explain it.
 */
export interface Pricing {
  /** What to price at, or null when nothing here can price anything. */
  rate: InputRate | null;
  /** The model this was resolved for, wording material for either branch. */
  model: AgentModel;
}

/**
 * The blended rate this session has actually been paying, or null when nothing
 * has been sampled yet (turn one, or a host whose hooks name no transcript).
 *
 * `costMicros / tokensBilled` is the price of one input token here — model and
 * cache-hit ratio already folded in — so this re-blends as the session goes
 * rather than freezing turn one's rate. Micro-dollars per token and dollars per
 * million tokens are the same number: both divide by 1e6 once.
 */
export function blendedRate(
  costMicros: number | undefined,
  tokensBilled: number | undefined,
): InputRate | null {
  if (!costMicros || !tokensBilled) return null;
  const usdPerMtok = costMicros / tokensBilled;
  return Number.isFinite(usdPerMtok) && usdPerMtok > 0 ? { usdPerMtok, measured: true } : null;
}

/** Overrides the model lookup, for a host that reports no model at all or one
 * this table has never heard of. */
export const RATE_ENV = 'GRAFT_INPUT_USD_PER_MTOK';

/** The env override as a number, or null when it is unset, blank or malformed.
 * A malformed value prices nothing rather than being coerced: silently billing
 * at a different number than the one that was typed is exactly the class of
 * quiet wrongness this module exists to avoid. */
export function envRate(): number | null {
  const raw = process.env[RATE_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const usdPerMtok = Number(raw);
  return Number.isFinite(usdPerMtok) && usdPerMtok > 0 ? usdPerMtok : null;
}

/**
 * The rate the user declared, for the hosts that measure nothing.
 *
 * Codex and Cursor fire no turn-end event carrying a transcript, and Copilot and
 * Kilo expose no billing surface whatsoever — so for them the measured path can
 * never produce a number. Declaring one is the only honest alternative to
 * silence, and it stays honest because the user chose it: a `model` in
 * `.graft/config.json` (or one the host/agent named outright) that this table
 * prices, else the `GRAFT_INPUT_USD_PER_MTOK` number.
 *
 * The table BEATS the override, which is the one ordering choice here worth
 * arguing about. When we know the model and know its price, that pair is a fact
 * about the world; the override is a number the user typed into their shell
 * once, months ago, for a model they may no longer run. Letting it win would
 * mean a correct price could be silently replaced by a stale one, and the user
 * would have no way to see it happen. So the override does what an override of
 * last resort should: it fills the hole — an unpriced or unnamed model — and
 * touches nothing else.
 */
export function declaredRate(model?: string | null, opts: { named?: boolean } = {}): InputRate | null {
  const named = opts.named === true;
  const id = typeof model === 'string' && model.trim() ? model.trim() : null;
  const list = inputUsdPerMtok(id);
  if (list !== null) return { usdPerMtok: list, measured: false, model: id!, named };
  const env = envRate();
  if (env === null) return null;
  // The model rides along even here: the number is the user's, but it is still
  // being applied to THIS model, and a tally that names it is one the reader can
  // check. `id === null` (nothing named a model) simply omits it.
  return id === null
    ? { usdPerMtok: env, measured: false, fromEnv: true }
    : { usdPerMtok: env, measured: false, model: id, named, fromEnv: true };
}

/**
 * Everything a savings surface needs to word itself: what to price at, and what
 * we know about the model behind it — including when the answer is "nothing".
 *
 * `measured` (the session's own blended billing) always wins when it exists: it
 * is what the user was actually charged, cache discounts and mid-session model
 * switches already folded in, and no list price can improve on that.
 */
export function pricingFor(model: AgentModel, measured: InputRate | null = null): Pricing {
  if (measured) return { rate: measured, model };
  return {
    rate: declaredRate(model.id, { named: model.confidence === 'certain' }),
    model,
  };
}

/** What a saving was worth, carrying through whether the rate behind it was
 * measured or merely declared. Null when there is no rate, or nothing saved. */
export function valueSaved(
  savedTokens: number,
  rate: InputRate | null,
): { usd: number; measured: boolean } | null {
  if (!rate || savedTokens <= 0) return null;
  const usd = (savedTokens * rate.usdPerMtok) / MICROS_PER_USD;
  // Belt and braces against a non-finite accumulator reaching a rendered
  // surface: "$NaN" on the statusline is worse than no dollar figure at all.
  return Number.isFinite(usd) ? { usd, measured: rate.measured } : null;
}

/**
 * Dollars saved, at the rate the session has actually been paying — the
 * measured path only, with no declared-rate fallback.
 */
export function dollarsSaved(
  savedTokens: number,
  costMicros: number | undefined,
  tokensBilled: number | undefined,
): number | null {
  return valueSaved(savedTokens, blendedRate(costMicros, tokensBilled))?.usd ?? null;
}

/** `$1.23`, or `<$0.01` for a real but sub-cent saving. Never `$0.00`: a
 * rounded-to-nothing number reads as "graft saved you nothing", which is a
 * different claim from "graft saved you less than a cent". */
export function formatDollars(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}
