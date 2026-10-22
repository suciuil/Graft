/**
 * Tests for the local LiteLLM price catalog (`graft prices update`) and how the
 * price table falls back to it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LITELLM_PRICES_URL,
  bundledPriceCatalog,
  catalogPrice,
  parseLiteLlmCatalog,
  priceCatalogPath,
  priceCatalogStatus,
  updatePriceCatalog,
  type PriceCatalog,
} from '../src/context/price-catalog.js';
import { BUNDLED_PRICE_CATALOG } from '../src/context/price-catalog-bundled.js';
import { inputUsdPerMtok, listRate, turnInputCostMicros } from '../src/context/price.js';
import { savingsLine, setPricing, setDeepDue } from '../src/context/savings.js';

const dir = mkdtempSync(join(tmpdir(), 'graft-price-catalog-'));
let n = 0;

/** Point the module at a fresh file holding `catalog` (or nothing). */
function useFile(catalog: PriceCatalog | null): string {
  const path = join(dir, `prices-${n++}.json`);
  if (catalog) writeFileSync(path, JSON.stringify(catalog));
  process.env.GRAFT_PRICES_FILE = path;
  return path;
}

const LITELLM_SAMPLE = {
  sample_spec: { mode: 'chat', input_cost_per_token: 0 },
  'claude-opus-4-5': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 0.000005,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 0.00000625,
  },
  'openrouter/anthropic/claude-opus-4.5': { mode: 'chat', input_cost_per_token: 0.0000055 },
  'vertex_ai/zeta-1': { mode: 'chat', input_cost_per_token: 0.000002 },
  'bedrock/zeta-1': { mode: 'chat', input_cost_per_token: 0.000002 },
  'vertex_ai/omega-2': { mode: 'chat', input_cost_per_token: 0.000002 },
  'bedrock/omega-2': { mode: 'chat', input_cost_per_token: 0.000003 },
  'ft:gpt-4o-mini': { mode: 'chat', input_cost_per_token: 0.0000003 },
  'gpt-4o-mini': { mode: 'chat', input_cost_per_token: 1.5e-7 },
  'text-embedding-x': { mode: 'embedding', input_cost_per_token: 1e-7 },
  'free-model': { mode: 'chat', input_cost_per_token: 0 },
  'absurd-model': { mode: 'chat', input_cost_per_token: 5 },
  'resp-model-1.5': { mode: 'responses', input_cost_per_token: 0.000001 },
};

const freshCatalog = (models: PriceCatalog['models'], daysOld = 1): PriceCatalog => ({
  version: 1,
  source: 'LiteLLM',
  url: LITELLM_PRICES_URL,
  fetchedAt: new Date(Date.now() - daysOld * 86_400_000).toISOString(),
  models,
});

test('parse: keeps text models, prefers the vendor key, and leaves disagreements unpriced', () => {
  const c = parseLiteLlmCatalog(LITELLM_SAMPLE, '2026-10-20T00:00:00.000Z');
  assert.deepEqual(c.models['claude-opus-4-5'], { input: 5, cacheRead: 0.5, cacheWrite: 6.25 }, 'the vendor key beats the gateway');
  assert.deepEqual(c.models['zeta-1'], { input: 2 }, 'gateways that agree price a gateway-only model');
  assert.equal(c.models['omega-2'], undefined, 'gateways that disagree leave it unpriced');
  assert.deepEqual(c.models['gpt-4o-mini'], { input: 0.15 }, 'a fine-tune never lends the base model its price');
  assert.equal(c.models['text-embedding-x'], undefined, 'embedding models are not priced');
  assert.equal(c.models['free-model'], undefined, 'a zero price is no price');
  assert.equal(c.models['absurd-model'], undefined, 'an absurd price is rejected');
  assert.deepEqual(c.models['resp-model-1-5'], { input: 1 }, 'keyed canonically');
  assert.equal(c.models['sample-spec'], undefined);
  assert.equal(c.fetchedAt, '2026-10-20T00:00:00.000Z');
});

test('parse: rejects what is not a catalog', () => {
  assert.throws(() => parseLiteLlmCatalog([], 'x'), /not a JSON object/);
  assert.throws(() => parseLiteLlmCatalog({ a: { mode: 'embedding', input_cost_per_token: 1e-6 } }, 'x'), /no priced text models/);
});

test('lookup: a fresh catalog prices models the built-in table does not know, under any spelling', () => {
  useFile(freshCatalog({ 'acme-large-2-1': { input: 3, cacheRead: 0.3 } }));
  assert.equal(inputUsdPerMtok('acme-large-2.1'), 3);
  assert.equal(inputUsdPerMtok('openrouter/acme/Acme-Large-2-1'), 3);
  assert.equal(inputUsdPerMtok('acme-large-3'), null);
  assert.equal(catalogPrice('acme-large-2.1')?.cacheRead, 0.3);
});

test('lookup: the built-in table still wins over the catalog', () => {
  useFile(freshCatalog({ 'claude-opus-5': { input: 99 } }));
  assert.equal(inputUsdPerMtok('claude-opus-5'), 5);
  const r = listRate({ id: 'claude-opus-5', confidence: 'certain' });
  assert.equal(r?.usdPerMtok, 5);
  assert.equal(r?.catalogFetchedAt, undefined);
});

test('lookup: a stored catalog is used whatever its age, and status reports the age', () => {
  const path = useFile(freshCatalog({ 'acme-large-2-1': { input: 3 } }, 400));
  assert.equal(inputUsdPerMtok('acme-large-2.1'), 3);
  const s = priceCatalogStatus();
  assert.equal(s.state, 'stored');
  assert.equal(s.ageDays, 400);
  assert.equal(s.path, path);
});

test('lookup: a missing or corrupt file is simply no catalog', () => {
  useFile(null);
  assert.equal(priceCatalogStatus().state, 'missing');
  assert.equal(inputUsdPerMtok('acme-large-2.1'), null);
  const bad = join(dir, 'corrupt.json');
  writeFileSync(bad, '{ not json');
  process.env.GRAFT_PRICES_FILE = bad;
  assert.equal(priceCatalogStatus().state, 'missing');
});

test('listRate marks a catalog price, and the savings wording names LiteLLM and the fetch date', () => {
  const catalog = freshCatalog({ 'acme-large-2-1': { input: 3 } });
  useFile(catalog);
  const r = listRate({ id: 'acme-large-2.1', confidence: 'certain' });
  assert.equal(r?.usdPerMtok, 3);
  assert.equal(r?.catalogFetchedAt, catalog.fetchedAt);
  assert.equal(listRate({ id: 'acme-large-2.1', confidence: 'unknown' }), null, 'never for an unnamed model');

  setPricing({ rate: r, model: { id: 'acme-large-2.1', confidence: 'certain' } });
  setDeepDue(null);
  const f = savingsLine('x'.repeat(400), { files: 2, baselineChars: 8000 });
  assert.match(f, new RegExp(`from the local LiteLLM price catalog, fetched ${catalog.fetchedAt.slice(0, 10)}`));
  assert.match(f, /\(~\$X for acme-large-2\.1\) this turn\.$/);
  assert.doesNotMatch(f, /prices update/);
  setPricing(null);
});

test('turnInputCostMicros uses the catalog’s own cache rates, else the default ratios', () => {
  useFile(freshCatalog({ 'acme-large-2-1': { input: 3, cacheRead: 0.15, cacheWrite: 4 }, 'acme-small-1': { input: 1 } }));
  const usage = { input: 1_000_000, cacheCreate: 1_000_000, cacheRead: 1_000_000 };
  assert.equal(turnInputCostMicros({ model: 'acme-large-2.1', ...usage }), 3_000_000 + 4_000_000 + 150_000);
  assert.equal(turnInputCostMicros({ model: 'acme-small-1', ...usage }), 1_000_000 + 1_250_000 + 100_000);
  assert.equal(turnInputCostMicros({ model: 'acme-unknown', ...usage }), null);
});

test('update: one anonymous GET of the whole catalog, stored compactly at the catalog path', async () => {
  const path = useFile(null);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(LITELLM_SAMPLE), { status: 200 });
  }) as unknown as typeof fetch;
  const { catalog, path: written } = await updatePriceCatalog({ fetchImpl: fakeFetch });
  assert.equal(written, path);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, LITELLM_PRICES_URL, 'the fixed public URL, no query string, nothing model-specific');
  assert.equal(calls[0]!.init?.headers, undefined, 'no headers of graft’s own');
  assert.equal(calls[0]!.init?.credentials, 'omit');
  const stored = JSON.parse(readFileSync(path, 'utf8')) as PriceCatalog;
  assert.deepEqual(stored.models, catalog.models);
  assert.equal(priceCatalogStatus().state, 'stored');
  assert.equal(inputUsdPerMtok('zeta-1'), 2, 'usable immediately in the same process');
});

test('update: a failed download keeps the previous catalog', async () => {
  const previous = freshCatalog({ 'acme-large-2-1': { input: 3 } });
  const path = useFile(previous);
  const failing = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(updatePriceCatalog({ fetchImpl: failing }), /HTTP 503/);
  const garbage = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(updatePriceCatalog({ fetchImpl: garbage }), /valid JSON/);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), previous);
});

/** Run `fn` with the bundled snapshot enabled and holding `models`, fetched `daysOld` ago. */
function withBundled(models: PriceCatalog['models'], daysOld: number, fn: () => void): void {
  const saved = { models: BUNDLED_PRICE_CATALOG.models, fetchedAt: BUNDLED_PRICE_CATALOG.fetchedAt };
  const flag = process.env.GRAFT_BUNDLED_PRICES;
  BUNDLED_PRICE_CATALOG.models = models;
  BUNDLED_PRICE_CATALOG.fetchedAt = new Date(Date.now() - daysOld * 86_400_000).toISOString();
  delete process.env.GRAFT_BUNDLED_PRICES;
  try {
    fn();
  } finally {
    BUNDLED_PRICE_CATALOG.models = saved.models;
    BUNDLED_PRICE_CATALOG.fetchedAt = saved.fetchedAt;
    if (flag === undefined) delete process.env.GRAFT_BUNDLED_PRICES;
    else process.env.GRAFT_BUNDLED_PRICES = flag;
  }
}

test('bundled: prices a model with no local catalog at all, and says so', () => {
  useFile(null);
  withBundled({ 'acme-bundled-1': { input: 0.7, cacheRead: 0.07 } }, 3, () => {
    assert.equal(inputUsdPerMtok('acme-bundled-1'), 0.7);
    const c = catalogPrice('openrouter/acme/acme-bundled-1');
    assert.equal(c?.bundled, true);
    assert.equal(c?.cacheRead, 0.07);
    const r = listRate({ id: 'acme-bundled-1', confidence: 'certain' });
    assert.equal(r?.catalogBundled, true);
    const s = priceCatalogStatus();
    assert.equal(s.state, 'missing');
    assert.equal(s.bundled?.models, 1);
    assert.equal(s.bundled?.ageDays, 3);

    setPricing({ rate: r, model: { id: 'acme-bundled-1', confidence: 'certain' } });
    setDeepDue(null);
    const f = savingsLine('x'.repeat(400), { files: 2, baselineChars: 8000 });
    assert.match(f, /from the LiteLLM price catalog bundled with graft, fetched /);
    setPricing(null);
  });
});

test('bundled: the newer catalog wins, and the other fills its gaps', () => {
  useFile(freshCatalog({ 'acme-shared': { input: 3 }, 'acme-local-only': { input: 4 } }, 10));
  withBundled({ 'acme-shared': { input: 2 }, 'acme-bundled-only': { input: 1 } }, 1, () => {
    assert.equal(inputUsdPerMtok('acme-shared'), 2, 'a newer bundled snapshot beats an old local copy');
    assert.equal(inputUsdPerMtok('acme-local-only'), 4, 'the local copy still prices what the snapshot lacks');
    assert.equal(catalogPrice('acme-local-only')?.bundled, undefined);
  });
  useFile(freshCatalog({ 'acme-shared': { input: 3 } }, 1));
  withBundled({ 'acme-shared': { input: 2 }, 'acme-bundled-only': { input: 1 } }, 10, () => {
    assert.equal(inputUsdPerMtok('acme-shared'), 3, 'a newer `graft prices update` beats the snapshot');
    assert.equal(inputUsdPerMtok('acme-bundled-only'), 1, 'the snapshot still prices what the local copy lacks');
  });
});

test('bundled: the built-in table still wins, and GRAFT_BUNDLED_PRICES=0 turns the snapshot off', () => {
  useFile(null);
  withBundled({ 'claude-opus-5': { input: 99 }, 'acme-bundled-1': { input: 0.7 } }, 1, () => {
    assert.equal(inputUsdPerMtok('claude-opus-5'), 5);
    process.env.GRAFT_BUNDLED_PRICES = '0';
    assert.equal(bundledPriceCatalog(), null);
    assert.equal(inputUsdPerMtok('acme-bundled-1'), null);
    assert.equal(priceCatalogStatus().bundled, undefined);
  });
});

test('bundled: the shipped snapshot is a valid catalog of the LiteLLM URL', () => {
  const b = BUNDLED_PRICE_CATALOG;
  assert.equal(b.version, 1);
  assert.equal(b.source, 'LiteLLM');
  assert.ok(Number.isFinite(Date.parse(b.fetchedAt)));
  for (const [key, p] of Object.entries(b.models)) {
    assert.equal(typeof p.input, 'number', key);
    assert.ok(p.input > 0 && p.input <= 1000, `${key} has a sane input rate`);
  }
});

test('the catalog path defaults under ~/.graft and honours GRAFT_PRICES_FILE', () => {
  assert.equal(priceCatalogPath({}, '/home/u'), join('/home/u', '.graft', 'prices.json'));
  assert.equal(priceCatalogPath({ GRAFT_PRICES_FILE: ' /tmp/p.json ' }, '/home/u'), '/tmp/p.json');
  assert.ok(!existsSync(join(dir, 'never.json')));
});
