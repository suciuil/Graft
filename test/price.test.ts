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
  declaredRate,
  envRate,
  pricingFor,
  valueSaved,
  NO_MODEL,
  RATE_ENV,
} from '../src/context/price.js';

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

// ── the declared rate: the only number available on a host that measures none ──

test('declaredRate: a known model prices at list, and is marked unmeasured', () => {
  delete process.env[RATE_ENV];
  // The model rides along so every priced surface can name what it priced at;
  // `named` separates "the agent said so on this call" from a standing config.
  assert.deepEqual(declaredRate('gemini-3.8-flash'), { usdPerMtok: 0.75, measured: false, model: 'gemini-3.8-flash', named: false });
  assert.deepEqual(declaredRate('gpt-5.6-sol', { named: true }), { usdPerMtok: 4, measured: false, model: 'gpt-5.6-sol', named: true });
});

test('declaredRate: nothing declared, or a model with no price, stays null', () => {
  delete process.env[RATE_ENV];
  assert.equal(declaredRate(null), null, 'no model configured');
  assert.equal(declaredRate(''), null, 'the scaffolded empty default');
  assert.equal(declaredRate('some-future-model'), null, 'a model this table never priced');
});

test('declaredRate: a known list price is NOT displaced by the env override', () => {
  // The pair (model we know, price we have) is a fact about the world. The
  // override is a number typed into a shell once, for a model the user may no
  // longer run — letting it win would replace a correct price with a stale one,
  // invisibly. So it fills holes and nothing else.
  process.env[RATE_ENV] = '0.30';
  try {
    assert.deepEqual(declaredRate('gpt-5.6-sol'), {
      usdPerMtok: 4,
      measured: false,
      model: 'gpt-5.6-sol',
      named: false,
    });
  } finally {
    delete process.env[RATE_ENV];
  }
});

test('declaredRate: the env override fills in for an unpriced or unnamed model', () => {
  process.env[RATE_ENV] = '0.30';
  try {
    // A model graft has never heard of: the override is the only number going.
    assert.deepEqual(declaredRate('some-future-model', { named: true }), {
      usdPerMtok: 0.3,
      measured: false,
      model: 'some-future-model',
      named: true,
      fromEnv: true,
    });
    // Nothing named a model at all: a bare number, nothing claimed about one.
    assert.deepEqual(declaredRate(null), { usdPerMtok: 0.3, measured: false, fromEnv: true });
  } finally {
    delete process.env[RATE_ENV];
  }
});

test('declaredRate: a malformed override prices nothing rather than falling through', () => {
  // Falling back to something else here would quietly bill at a different
  // number than the one the user typed, which is the failure mode this module
  // exists to avoid. Silence sends them back to fix the typo.
  for (const bad of ['abc', '0', '-1', 'NaN', 'Infinity']) {
    process.env[RATE_ENV] = bad;
    try {
      assert.equal(declaredRate('some-future-model'), null, `override ${bad} must price nothing`);
      assert.equal(declaredRate(null), null, `override ${bad} must price nothing`);
    } finally {
      delete process.env[RATE_ENV];
    }
  }
});

test('envRate: reads the override, and rejects everything unusable', () => {
  delete process.env[RATE_ENV];
  assert.equal(envRate(), null, 'unset');
  process.env[RATE_ENV] = '   ';
  assert.equal(envRate(), null, 'blank');
  process.env[RATE_ENV] = '2.5';
  assert.equal(envRate(), 2.5);
  delete process.env[RATE_ENV];
});

// ── pricingFor: the one precedence every savings surface reads ────────────

test('pricingFor: measured billing outranks every list price and override', () => {
  process.env[RATE_ENV] = '99';
  try {
    const measured = { usdPerMtok: 0.6, measured: true };
    const p = pricingFor({ id: 'claude-opus-5', confidence: 'certain' }, measured);
    assert.deepEqual(p.rate, measured);
    assert.equal(p.model.confidence, 'certain');
  } finally {
    delete process.env[RATE_ENV];
  }
});

test('pricingFor: a certain model is marked named, a declared one is not', () => {
  delete process.env[RATE_ENV];
  // `named` is what tells the tally "this is the model that ran" rather than
  // "this is what a config file last said".
  assert.equal(pricingFor({ id: 'claude-opus-5', confidence: 'certain' }).rate?.named, true);
  assert.equal(pricingFor({ id: 'claude-opus-5', confidence: 'declared' }).rate?.named, false);
});

test('pricingFor: no model and no override prices nothing, but keeps the model', () => {
  delete process.env[RATE_ENV];
  const p = pricingFor(NO_MODEL);
  assert.equal(p.rate, null);
  // The model travels even with no rate: the unpriced wording has to name what
  // it could not price.
  assert.deepEqual(p.model, NO_MODEL);

  const unpriced = pricingFor({ id: 'claude-opus-6', confidence: 'certain' });
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

  const declared = valueSaved(100_000, { usdPerMtok: 0.75, measured: false });
  assert.equal(declared?.measured, false);
  assert.ok(Math.abs(declared!.usd - 0.075) < 1e-9, `got ${declared?.usd}`);

  assert.equal(valueSaved(100_000, null), null, 'no rate, no figure');
  assert.equal(valueSaved(0, { usdPerMtok: 5, measured: true }), null, 'nothing saved');
});
