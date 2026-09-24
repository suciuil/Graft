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
 * Nothing here guesses, and nothing here is declared. A price is only ever
 * attached to a model the AGENT ITSELF named — via `--agent-model`, or a stamp
 * the host wrote into its own transcript — because that is the only kind of
 * claim that cannot silently rot. Standing declarations (a `model` field in a
 * config file, a `$/Mtok` env override) were both removed for exactly that
 * reason: they outlive the session that justified them, and a stale price reads
 * on screen precisely like a correct one.
 *
 * So there are two states and no third. Either we know the model and this table
 * prices it — one figure, attributable — or we do not, and the saving is
 * reported in tokens alone. What fills that second gap is NOT a guessed rate: it
 * is the per-model table in `hosts/models.ts`, which prices the same saving under
 * every model the user's agent offers and lets them read their own row.
 *
 * Precedence (see {@link pricingFor}): what the session was BILLED, else this
 * table's list price for the model we were told we are running. Nothing else.
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
  // Must precede the Opus 5 row, which is prefix-anchored only and would
  // otherwise price `claude-opus-5-5` at Opus 5's $5. The lookahead keeps a
  // hypothetical `claude-opus-5-50` or `5.5.1` from borrowing this rate.
  [/^claude-opus-5[.-]5(?![.\d])/i, 4],
  [/^claude-opus-(5(-0)?|4[.-][5-8])/i, 5],
  [/^claude-sonnet-5(-0)?/i, 2],
  [/^claude-sonnet-4[.-][56]/i, 3],
  [/^claude-3[.-]7-sonnet/i, 3],
  [/^claude-haiku-4[.-]5/i, 1],
  [/^gpt-6-astra(?:$|[-:])/i, 10],
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
 * dropped, config-entry discriminator dropped, and the separators a human types
 * (spaces, underscores) folded to the hyphens a model id uses.
 *
 * The two prefix shapes are what hosts and marketplaces actually display:
 * `anthropic/claude-opus-5` names who SERVES the model, and `Google: Gemini 3.8
 * Flash` is a vendor label on a UI row. The `word:` rule is deliberately
 * letters-only so it can strip `Google:` without touching a real suffix like
 * `gemini-3.8-flash:free`, whose left side carries digits and dots.
 *
 * ## The `#` suffix
 *
 * A host whose model list is a MAP needs distinct keys to offer one model twice
 * under different settings, so it appends a discriminator: Kilo Code writes
 * `vertex_ai/claude-opus-5#pair-gemini` for a second entry that declares
 * `"id": "vertex_ai/claude-opus-5"` and differs only in which model its
 * subagents use. The part after `#` names the CONFIG ENTRY, exactly as the part
 * before the last `/` names the server — neither says which model runs, and no
 * vendor puts a `#` in a real model id.
 *
 * Left in, it split the ledger the same way the version separator once did: a
 * user who switches between the plain entry and the paired one accumulates
 * `claude-opus-5` and `claude-opus-5#pair-gemini` as two rows, two dollar
 * figures, for one model. It also left the id one literal away from every
 * anchored price pattern, so an entry named `#fast` on an otherwise priced model
 * would go unpriced the moment a suffix landed anywhere but the end.
 */
export function normalizeModelId(model: string): string {
  const trimmed = model.trim();
  const routed = trimmed.slice(trimmed.lastIndexOf('/') + 1).trim();
  const entry = routed.split('#')[0].trim();
  return entry.replace(/^[A-Za-z]+\s*:\s*/, '').replace(/[\s_]+/g, '-');
}

/**
 * The one key two spellings of the same model must agree on.
 *
 * {@link normalizeModelId} drops the routing prefix and folds spaces, which is
 * enough to match the price table — its patterns are written `[.-]` precisely
 * because vendors disagree about the version separator, and they are
 * case-insensitive for the same reason. The LEDGER had neither concession, so it
 * keyed on the raw spelling and the same model arrived under several:
 *
 *     gemini-3.7-flash    ~863,871 tokens
 *     gemini-3-7-flash    ~717,427 tokens
 *
 * One model, two rows, two dollar figures, and a total that reads as though two
 * different things had been used. The spellings come from genuinely different
 * places — a host config, an agent's self-report, a session file — so no single
 * writer can be blamed or fixed; the key itself has to stop distinguishing them.
 *
 * Folds the two things vendors vary and nothing else: case, and `.` versus `-`
 * BETWEEN DIGITS (`3.7` ≡ `3-7`). A dot elsewhere is left alone, since it can
 * carry meaning — `gpt-4.1-mini` and a hypothetical `gpt-4.1mini` are not the
 * same claim, and this must not invent equivalences the price table would not
 * make.
 */
export function canonicalModelKey(model: string): string {
  return normalizeModelId(model)
    .toLowerCase()
    .replace(/(\d)\.(\d)/g, '$1-$2');
}

/**
 * Is `candidate` the same model as `claim`, named more precisely?
 *
 * True for `gpt-5.6-luna` against `gpt-5`, false for `gemini-3.8-flash` against
 * `gpt-5`, and false when the two are equal. The distinction matters because an
 * agent in a router mode ("Auto") does not know which model it is and answers
 * with the family — `gpt-5` — while the host records what actually ran. Those
 * are not competing claims about different models; they are the same claim at
 * two precisions, and the precise one is both more useful and more honest.
 *
 * Requiring a separator after the prefix is what keeps this from matching by
 * accident: `gpt-5` refines to `gpt-5.6-luna` and `gpt-5-mini`, but not to a
 * hypothetical `gpt-55`, which would be a different model entirely.
 *
 * Deliberately NOT a general "these look similar" test. It answers one question
 * — may a more specific observation replace a vaguer self-report — and every
 * other disagreement between two named models is left to the caller's
 * precedence rules, where a genuine conflict must not be silently resolved.
 */
export function refinesModelId(candidate: string, claim: string): boolean {
  // Compared in the canonical form, so `gpt-5.6-luna` refines `gpt-5` whichever
  // separator either side happens to use.
  const specific = canonicalModelKey(candidate);
  const general = canonicalModelKey(claim);
  if (!specific || !general || specific === general) return false;
  if (!specific.startsWith(general)) return false;
  return specific[general.length] === '-';
}

/** List input price for a model id, or null when we don't know it — a model
 * released after this table was written, or a host reporting something else
 * entirely. Null propagates all the way to "render tokens only".
 *
 * Any provider routing prefix is dropped before matching: a gateway host names
 * the model `anthropic/claude-opus-5` or `azure/eastus/gpt-5.6-luna`, where
 * everything up to the last `/` says who SERVES the model rather than which one
 * it is — and the table's patterns are anchored, so the prefix would otherwise
 * turn a priced model into an unpriced one. The savings ledger normalises the
 * same way before filing (see `ledgerKey`), so one model reached by two gateways
 * is one row rather than two lines that never add up. */
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
 * Shared across the vendors in the table above as the default, because most
 * publish exactly these ratios; the models that discount cache reads further
 * are listed in {@link CACHE_READ_MULTIPLIER_OVERRIDES}. */
const CACHE_CREATE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** Models whose cache read is NOT a tenth of list, matched against the
 * normalised id exactly as {@link INPUT_USD_PER_MTOK} is. First match wins.
 *
 * Claude Opus 5.5 bills a cache hit at 0.05x its $4 list ($0.20/Mtok). Leaving
 * it on the 0.1x default would double the cost of the cache-read bulk of every
 * long turn and so overstate the measured rate — and every saving priced at it —
 * by close to 2x. */
const CACHE_READ_MULTIPLIER_OVERRIDES: ReadonlyArray<readonly [RegExp, number]> = [
  [/^claude-opus-5[.-]5(?![.\d])/i, 0.05],
];

/** The cache-read multiplier for a model: its override, else the 0.1x default. */
function cacheReadMultiplier(model: string): number {
  const id = normalizeModelId(model);
  for (const [pattern, mult] of CACHE_READ_MULTIPLIER_OVERRIDES) if (pattern.test(id)) return mult;
  return CACHE_READ_MULTIPLIER;
}

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
    usage.cacheRead * cacheReadMultiplier(usage.model);
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
  /** The model this rate prices, so every surface can name it. A figure that
   * names the model behind it is one the reader can check; a bare one is not.
   * Absent for a measured rate, where the session itself is the proof. */
  model?: string;
  /** Display name for {@link model}, when the host gave one ("Claude Opus 5"
   * rather than `vertex_ai/claude-opus-5`). The tally prefers it: the user
   * picked the model from a menu showing this string, not the wire id. */
  label?: string;
}

/**
 * How sure we are of the model a saving should be priced at.
 *
 * Only two values, deliberately. `certain` is a model the host stamped in its
 * transcript or the agent named on this very call — what the turn actually ran.
 * `unknown` is everything else. The old middle ground (`declared`, a model
 * standing in a config file) is gone: it was a guess wearing the same clothes as
 * a fact, and on screen the two were indistinguishable.
 */
export type ModelConfidence = 'certain' | 'unknown';

/** The model a saving belongs to, and how sure we are of it. */
export interface AgentModel {
  /** The model id, or null when nothing named one (`confidence: 'unknown'`). */
  id: string | null;
  confidence: ModelConfidence;
  /** The host's display name for it, when one is known. */
  label?: string;
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

/**
 * The list price for a model the agent named, or null when this table has never
 * heard of it (or nothing named a model at all).
 *
 * Named `listRate` rather than the old `declaredRate` because the distinction is
 * now the whole point: nothing is DECLARED to graft any more. The only input is a
 * model the agent itself reported for THIS session, and the only output is that
 * model's published rate. A model we were merely told about once, in a file, no
 * longer prices anything.
 */
export function listRate(model: AgentModel): InputRate | null {
  if (model.confidence !== 'certain' || !model.id) return null;
  const usdPerMtok = inputUsdPerMtok(model.id);
  if (usdPerMtok === null) return null;
  return { usdPerMtok, measured: false, model: model.id, label: model.label };
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
  return { rate: measured ?? listRate(model), model };
}

/** What a saving was worth, carrying through whether the rate behind it was
 * measured or a published list price. Null when there is no rate, or nothing
 * saved. */
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
 * measured path only, with no list-price fallback.
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
