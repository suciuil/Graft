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
 * declares one — `GRAFT_INPUT_USD_PER_MTOK`, or a `model` in
 * `.graft/config.json` — which is what the many hosts that expose no billing at
 * all (Copilot, Kilo, Codex, Cursor) have to fall back on. A declared rate is
 * still not a guess, but it IS a list rate with no observable cache discount, so
 * it carries `measured: false` and every surface labels it. A wrong number on
 * the statusline is worse than no number; an unlabelled one is worse still.
 */

/** Input $/Mtok, list price, per model family. Output tokens are irrelevant —
 * what graft saves is context the agent would otherwise have read IN.
 *
 * First match wins, so patterns must stay mutually exclusive. Non-Anthropic
 * families are priced at their SHORT-context standard rate: the long-context
 * tier only starts billing above a prompt size we cannot see from a savings
 * count, and quoting the higher tier would overstate every figure. */
const INPUT_USD_PER_MTOK: ReadonlyArray<readonly [RegExp, number]> = [
  [/^claude-(fable|mythos)-5/, 10],
  [/^claude-opus-(5|4-[678])/, 5],
  [/^claude-sonnet-5/, 2],
  [/^claude-sonnet-4-6/, 3],
  [/^claude-haiku-4-5/, 1],
  [/^gpt-5\.6-sol/, 4],
  [/^gpt-5\.6-terra/, 2],
  [/^gpt-5\.6-luna/, 0.2],
  [/^gemini-3\.[78]-flash/, 0.75],
];

/** List input price for a model id, or null when we don't know it — a model
 * released after this table was written, or a host reporting something else
 * entirely. Null propagates all the way to "render tokens only". */
export function inputUsdPerMtok(model: unknown): number | null {
  if (typeof model !== 'string') return null;
  for (const [pattern, usd] of INPUT_USD_PER_MTOK) if (pattern.test(model)) return usd;
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

/**
 * The rate the user declared, for the hosts that measure nothing.
 *
 * Codex and Cursor fire no turn-end event carrying a transcript, and Copilot and
 * Kilo expose no billing surface whatsoever — so for them the measured path can
 * never produce a number. Declaring one is the only honest alternative to
 * silence, and it stays honest because the user chose it: the env var outright,
 * or a `model` in `.graft/config.json` that this table prices.
 *
 * A malformed env value yields null rather than falling through to the model.
 * Silently pricing at a different number than the one that was typed is exactly
 * the class of quiet wrongness this module exists to avoid.
 */
export function declaredRate(model?: string | null): InputRate | null {
  const raw = process.env[RATE_ENV];
  if (raw !== undefined && raw.trim() !== '') {
    const usdPerMtok = Number(raw);
    return Number.isFinite(usdPerMtok) && usdPerMtok > 0 ? { usdPerMtok, measured: false } : null;
  }
  const list = inputUsdPerMtok(model);
  return list === null ? null : { usdPerMtok: list, measured: false };
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
