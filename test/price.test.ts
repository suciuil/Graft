/**
 * Tests for the dollar half of the savings estimate ({@link turnInputCostMicros}
 * + {@link dollarsSaved}). The token half lives in savings.test.ts.
 *
 * The property under test throughout is that nothing is ever invented: an
 * unknown model, an unbilled session and a zero saving all produce null, and
 * null renders as "tokens only" rather than as "$0.00".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inputUsdPerMtok,
  turnInputCostMicros,
  turnInputTokens,
  dollarsSaved,
  formatDollars,
  blendedRate,
  listRate,
  pricingFor,
  canonicalModelKey,
  refinesModelId,
  valueSaved,
  NO_MODEL,
} from '../src/context/price.js';

const certain = (id: string, label?: string) =>
  ({ id, confidence: 'certain', label }) as const;

test('inputUsdPerMtok: known families are priced, anything else is null', () => {
  assert.equal(inputUsdPerMtok('claude-opus-5'), 5);
  assert.equal(inputUsdPerMtok('claude-opus-5-0'), 5);
  assert.equal(inputUsdPerMtok('claude-opus-4-8'), 5);
  assert.equal(inputUsdPerMtok('claude-opus-4-7'), 5);
  assert.equal(inputUsdPerMtok('claude-opus-4-6'), 5);
  assert.equal(inputUsdPerMtok('claude-opus-4-5'), 5);
  assert.equal(inputUsdPerMtok('claude-sonnet-5'), 2);
  assert.equal(inputUsdPerMtok('claude-sonnet-5-0'), 2);
  assert.equal(inputUsdPerMtok('claude-sonnet-4-6'), 3);
  assert.equal(inputUsdPerMtok('claude-sonnet-4-5'), 3);
  assert.equal(inputUsdPerMtok('claude-3-7-sonnet'), 3);
  assert.equal(inputUsdPerMtok('claude-haiku-4-5'), 1);
  assert.equal(inputUsdPerMtok('claude-fable-5-1'), 10);
  assert.equal(inputUsdPerMtok('some-future-model'), null);
  assert.equal(inputUsdPerMtok(undefined), null);
});

test('canonicalModelKey: the spellings of one model collapse to one key', () => {
  // The field bug: a real ledger carried `gemini-3.7-flash` AND
  // `gemini-3-7-flash` as separate rows, each with its own dollar figure, as
  // though two different models had been used. The spellings come from
  // different sources (a host config, an agent's self-report, a session file),
  // so the key has to stop distinguishing them.
  const key = canonicalModelKey;
  assert.equal(key('gemini-3.7-flash'), key('gemini-3-7-flash'));
  assert.equal(key('Gemini-3.7-Flash'), key('gemini-3-7-flash'), 'case folds too');
  assert.equal(key('vertex_ai/claude-opus-5'), key('claude-opus-5'), 'routing prefix still dropped');
  assert.equal(key('Google: Gemini 3.8 Flash'), key('gemini-3-8-flash'), 'vendor label and spaces');
});

test('canonicalModelKey: distinct models keep distinct keys', () => {
  // The fold must not invent equivalences the price table would not make.
  const key = canonicalModelKey;
  assert.notEqual(key('gemini-3.7-flash'), key('gemini-3.8-flash'));
  assert.notEqual(key('gpt-5.6-luna'), key('gpt-5.6-sol'));
  assert.notEqual(key('claude-opus-5'), key('claude-sonnet-5'));
  // A dot that is not between digits carries meaning and is left alone.
  assert.notEqual(key('gpt-4.1-mini'), key('gpt-4.1mini'));
});

test('refinesModelId: a family name is refined by the model that actually ran', () => {
  // Why this exists: an agent behind a router ("Auto") reports the family, not
  // the model. `gpt-5` and `gpt-5.6-luna` differ by 6x in price, so treating the
  // vaguer self-report as authoritative overstates every saving in the session.
  assert.equal(refinesModelId('gpt-5.6-luna', 'gpt-5'), true);
  assert.equal(refinesModelId('gpt-5-mini', 'gpt-5'), true);
  assert.equal(refinesModelId('claude-opus-5-0', 'claude-opus-5'), true);
  // Routing prefixes are normalised away on both sides first.
  assert.equal(refinesModelId('copilot/gpt-5.6-luna', 'gpt-5'), true);
  // ...and so is the separator, so a refinement is not missed over spelling.
  assert.equal(refinesModelId('gpt-5-6-luna', 'gpt-5'), true);
});

test('refinesModelId: anything that is not the same model, more precisely, is false', () => {
  // The guard rails. A different model is a real conflict, not a precision
  // difference, and must be left to the caller's precedence rules.
  assert.equal(refinesModelId('gemini-3.8-flash', 'gpt-5'), false, 'different vendor');
  assert.equal(refinesModelId('gpt-5', 'gpt-5.6-luna'), false, 'vaguer, not more precise');
  assert.equal(refinesModelId('gpt-5', 'gpt-5'), false, 'identical is not a refinement');
  // The separator requirement: a longer name that merely starts with the same
  // characters is a different model, not a more specific one.
  assert.equal(refinesModelId('gpt-55', 'gpt-5'), false);
  assert.equal(refinesModelId('', 'gpt-5'), false);
  assert.equal(refinesModelId('gpt-5', ''), false);
});

test('inputUsdPerMtok: the non-Anthropic families are priced at short-context list', () => {
  assert.equal(inputUsdPerMtok('gpt-5.6-sol'), 4);
  assert.equal(inputUsdPerMtok('gpt-5.6-terra'), 2);
  assert.equal(inputUsdPerMtok('gpt-5.6-luna'), 0.2);
  assert.equal(inputUsdPerMtok('gpt-5.5'), 5);
  assert.equal(inputUsdPerMtok('gpt-5.4'), 2.5);
  assert.equal(inputUsdPerMtok('gpt-5.4-mini'), 0.75);
  assert.equal(inputUsdPerMtok('gpt-5.4-nano'), 0.2);
  assert.equal(inputUsdPerMtok('gpt-5.3-codex'), 1.75);
  assert.equal(inputUsdPerMtok('gpt-5.2'), 1.75);
  assert.equal(inputUsdPerMtok('gpt-5.2-chat'), 1.75);
  assert.equal(inputUsdPerMtok('gpt-5.2-codex'), 1.75);
  assert.equal(inputUsdPerMtok('gpt-5.1'), 1.25);
  assert.equal(inputUsdPerMtok('gpt-5.1-chat'), 1.25);
  assert.equal(inputUsdPerMtok('gpt-5'), 1.25);
  assert.equal(inputUsdPerMtok('gpt-5-chat'), 1.25);
  assert.equal(inputUsdPerMtok('gpt-5-mini'), 0.25);
  assert.equal(inputUsdPerMtok('gpt-5-nano'), 0.05);
  assert.equal(inputUsdPerMtok('gpt-4o-mini'), 0.15);
  assert.equal(inputUsdPerMtok('gpt-35-turbo'), 0.5);
  assert.equal(inputUsdPerMtok('gpt-o3-mini'), 1.1);

  assert.equal(inputUsdPerMtok('gemini-3.8-flash'), 0.75);
  assert.equal(inputUsdPerMtok('gemini-3.7-flash'), 0.75);
  assert.equal(inputUsdPerMtok('gemini-3.6-flash'), 0.75);
  assert.equal(inputUsdPerMtok('gemini-3.5-flash'), 1.5);
  assert.equal(inputUsdPerMtok('gemini-3.5-flash-lite'), 0.3);
  assert.equal(inputUsdPerMtok('gemini-3.1-flash-lite'), 0.25);
  assert.equal(inputUsdPerMtok('gemini-2.5-pro'), 1.25);
  assert.equal(inputUsdPerMtok('gemini-2.5-flash'), 0.3);
  assert.equal(inputUsdPerMtok('gemini-2.5-flash-lite'), 0.1);

  assert.equal(inputUsdPerMtok('grok-4.3-2'), 1.25);
  assert.equal(inputUsdPerMtok('grok-4-fast-non-reasoning'), 0.2);
  assert.equal(inputUsdPerMtok('grok-3'), 2);

  assert.equal(inputUsdPerMtok('DeepSeek-V4-Pro'), 1.32);
  assert.equal(inputUsdPerMtok('DeepSeek-V4-Flash'), 0.44);
  assert.equal(inputUsdPerMtok('DeepSeek-V3.2'), 0.27);

  assert.equal(inputUsdPerMtok('Kimi-K2.6'), 0.8);
  assert.equal(inputUsdPerMtok('Kimi-K2-Thinking'), 0.6);

  // The `.` in a version is escaped, so a neighbouring family cannot be priced
  // by a pattern that was never written for it.
  assert.equal(inputUsdPerMtok('gpt-546-sol'), null);
  assert.equal(inputUsdPerMtok('gemini-99-flash'), null);
  assert.equal(inputUsdPerMtok('gpt-5.6-cyber'), null);
});

test('inputUsdPerMtok: a provider routing prefix names the server, not the model', () => {
  assert.equal(inputUsdPerMtok('anthropic/claude-opus-5'), 5);
  assert.equal(inputUsdPerMtok('copilot/gpt-5.6-terra'), 2);
  assert.equal(inputUsdPerMtok('azure/eastus/gpt-5.6-luna'), 0.2, 'a multi-segment route reduces too');
  assert.equal(inputUsdPerMtok('  google/gemini-3.8-flash  '), 0.75, 'surrounding whitespace is not an id');
  assert.equal(inputUsdPerMtok('openrouter/google/gemini-3.8-flash'), 0.75);
  assert.equal(inputUsdPerMtok('kilo/gemini-3.8-flash'), 0.75);
  assert.equal(inputUsdPerMtok('Google: Gemini 3.8 Flash'), 0.75);
  // Stripping is prefix-only: it must not rescue a model this table cannot price.
  assert.equal(inputUsdPerMtok('anthropic/some-future-model'), null);
  assert.equal(inputUsdPerMtok('claude-opus-5/'), null, 'nothing after the slash is no model at all');
});

test('inputUsdPerMtok: human-formatted and UI model names match via normalisation', () => {
  assert.equal(inputUsdPerMtok('Gemini 3.8 Flash'), 0.75);
  assert.equal(inputUsdPerMtok('gemini 3.8 flash'), 0.75);
  assert.equal(inputUsdPerMtok('Gemini 3.7 Flash'), 0.75);
  assert.equal(inputUsdPerMtok('gemini-3-8-flash'), 0.75);
  assert.equal(inputUsdPerMtok('Gemini 3.8 Flash (Preview)'), 0.75);
  assert.equal(inputUsdPerMtok('gemini-3.8-flash:free'), 0.75);
  assert.equal(inputUsdPerMtok('Claude 3.7 Sonnet'), 3);
  assert.equal(inputUsdPerMtok('Claude Sonnet 4.5'), 3);
  assert.equal(inputUsdPerMtok('Claude Opus 4.6'), 5);
  assert.equal(inputUsdPerMtok('GPT 5.4'), 2.5);
  assert.equal(inputUsdPerMtok('GPT-5.4'), 2.5);
  assert.equal(inputUsdPerMtok('GPT 5.4 Mini'), 0.75);
});

test('turnInputCostMicros: fresh tokens cost list price', () => {
  // 1M fresh input tokens on a $5/Mtok model = $5.00 = 5,000,000 micro-dollars.
  const cost = turnInputCostMicros({
    model: 'claude-opus-5', input: 1_000_000, cacheCreate: 0, cacheRead: 0,
  });
  assert.equal(cost, 5_000_000);
});

test('turnInputCostMicros: cache writes cost 1.25x and reads a tenth', () => {
  const write = turnInputCostMicros({
    model: 'claude-opus-5', input: 0, cacheCreate: 1_000_000, cacheRead: 0,
  });
  const read = turnInputCostMicros({
    model: 'claude-opus-5', input: 0, cacheCreate: 0, cacheRead: 1_000_000,
  });
  assert.equal(write, 6_250_000);
  assert.equal(read, 500_000);
});

test('turnInputCostMicros: a cache-heavy turn is an order of magnitude cheaper than list', () => {
  // The shape of a real turn deep in a session: almost everything served from
  // cache. This is the whole reason the rate is measured rather than assumed —
  // pricing these tokens at list would overstate the saving roughly 10x.
  const usage = {
    model: 'claude-opus-5', input: 2, cacheCreate: 2_451, cacheRead: 132_972,
  };
  const cost = turnInputCostMicros(usage)!;
  const perMtok = cost / turnInputTokens(usage);
  assert.ok(perMtok > 0.5 && perMtok < 0.7, `blended rate was $${perMtok}/Mtok`);
});

test('turnInputCostMicros: an unpriced model yields null, never a guess', () => {
  assert.equal(
    turnInputCostMicros({ model: 'some-future-model', input: 100, cacheCreate: 0, cacheRead: 0 }),
    null,
  );
});

test('dollarsSaved: prices a saving at the session\'s blended rate', () => {
  // A session billed $0.60 for 1M input tokens pays $0.60/Mtok; 100k saved
  // tokens are therefore worth $0.06.
  const usd = dollarsSaved(100_000, 600_000, 1_000_000);
  assert.ok(usd !== null);
  assert.ok(Math.abs(usd - 0.06) < 1e-9, `got ${usd}`);
});

test('dollarsSaved: null until something has actually been billed', () => {
  assert.equal(dollarsSaved(100_000, undefined, undefined), null, 'turn one of a session');
  assert.equal(dollarsSaved(100_000, 0, 0), null, 'a host that exposes no transcript');
  assert.equal(dollarsSaved(0, 600_000, 1_000_000), null, 'nothing saved, nothing to price');
});

test('formatDollars: a real sub-cent saving is not rounded away to zero', () => {
  assert.equal(formatDollars(1.234), '$1.23');
  assert.equal(formatDollars(0.005), '<$0.01');
  assert.match(formatDollars(0.0001), /^<\$0\.01$/);
});

test('dollarsSaved: a non-finite accumulator never reaches a rendered surface', () => {
  assert.equal(dollarsSaved(100_000, Number.NaN, 1_000_000), null);
  assert.equal(dollarsSaved(100_000, 600_000, Number.NaN), null);
  assert.equal(dollarsSaved(Number.POSITIVE_INFINITY, 600_000, 1_000_000), null);
});

// ── the list rate: priced only for a model the AGENT named ────────────────

test('listRate: a model the agent named prices at list, marked unmeasured', () => {
  // The model rides along so every priced surface can name what it priced at.
  assert.deepEqual(listRate(certain('gemini-3.8-flash')), {
    usdPerMtok: 0.75, measured: false, model: 'gemini-3.8-flash', label: undefined,
  });
  // A display name, when the host had one, travels with the rate: the user
  // picked the model from a menu showing that string, not the wire id.
  assert.deepEqual(listRate(certain('vertex_ai/claude-opus-5', 'Claude Opus 5')), {
    usdPerMtok: 5, measured: false, model: 'vertex_ai/claude-opus-5', label: 'Claude Opus 5',
  });
});

test('listRate: an unknown model, or none at all, prices nothing', () => {
  assert.equal(listRate(NO_MODEL), null, 'nothing named a model');
  assert.equal(listRate(certain('some-future-model')), null, 'a model this table never priced');
  assert.equal(listRate({ id: '', confidence: 'certain' }), null, 'a blank id is not a model');
});

test('listRate: a model we are not sure of is never priced', () => {
  // The whole point of the redesign: only a model the AGENT named prices
  // anything. An id with no confidence behind it buys no dollar figure.
  assert.equal(listRate({ id: 'claude-opus-5', confidence: 'unknown' }), null);
});

// ── pricingFor: the one precedence every savings surface reads ────────────

test('pricingFor: measured billing outranks the list price', () => {
  const measured = { usdPerMtok: 0.6, measured: true };
  const p = pricingFor(certain('claude-opus-5'), measured);
  assert.deepEqual(p.rate, measured);
  assert.equal(p.model.confidence, 'certain');
});

test('pricingFor: with no measurement, a named model gets its list price', () => {
  assert.equal(pricingFor(certain('claude-opus-5')).rate?.usdPerMtok, 5);
});

test('pricingFor: no model prices nothing, but keeps the model knowledge', () => {
  const p = pricingFor(NO_MODEL);
  assert.equal(p.rate, null);
  // The model travels even with no rate: the caller still has to know whether
  // it is looking at "unknown model" or "known model, unknown price".
  assert.deepEqual(p.model, NO_MODEL);

  const unpriced = pricingFor(certain('claude-opus-6'));
  assert.equal(unpriced.rate, null);
  assert.equal(unpriced.model.id, 'claude-opus-6');
});

test('blendedRate: a measured rate is the session cost over the tokens it bought', () => {
  assert.deepEqual(blendedRate(600_000, 1_000_000), { usdPerMtok: 0.6, measured: true });
  assert.equal(blendedRate(undefined, undefined), null, 'turn one of a session');
  assert.equal(blendedRate(0, 0), null, 'a host that exposes no transcript');
});

test('valueSaved: the measured flag travels with the number', () => {
  const measured = valueSaved(100_000, { usdPerMtok: 0.6, measured: true });
  assert.equal(measured?.measured, true);
  assert.ok(Math.abs(measured!.usd - 0.06) < 1e-9, `got ${measured?.usd}`);

  const list = valueSaved(100_000, { usdPerMtok: 0.75, measured: false });
  assert.equal(list?.measured, false);
  assert.ok(Math.abs(list!.usd - 0.075) < 1e-9, `got ${list?.usd}`);

  assert.equal(valueSaved(100_000, null), null, 'no rate, no figure');
  assert.equal(valueSaved(0, { usdPerMtok: 5, measured: true }), null, 'nothing saved');
});
