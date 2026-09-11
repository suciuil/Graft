/**
 * `graft models` — the per-model price table.
 *
 * Every test injects its own `home`. Reading the developer's real Kilo config
 * here would make the suite pass or fail by machine, which is exactly how an
 * earlier attempt at host-config reading broke three unrelated tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatModelPrices, readHostModels } from '../src/hosts/models.js';
import { tmpRepo } from './helpers.js';

/** A Kilo profile config, in the shape a real one has. */
function kiloHome(cfg: unknown, rel = ['.config', 'kilo', 'kilo.jsonc']): string {
  const home = tmpRepo('kilo-models');
  const dir = join(home, ...rel.slice(0, -1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, rel[rel.length - 1]),
    typeof cfg === 'string' ? cfg : JSON.stringify(cfg, null, 2),
  );
  return home;
}

const REAL_SHAPE = {
  model: 'a/gemini-3.8-flash',
  provider: {
    a: {
      models: {
        'vertex_ai/claude-opus-5': { name: 'Claude Opus 5' },
        'claude-sonnet-4-6': { name: 'Claude Sonnet 4.6' },
        'gemini-3.8-flash': { name: 'Gemini 3.8 Flash' },
        'gpt-5.6-sol': { name: 'GPT 5.6 Sol' },
      },
    },
  },
};

test('reads every model the host offers, priced from graft\'s table', () => {
  const home = kiloHome(REAL_SHAPE);
  const h = readHostModels({ home });
  assert.ok(h, 'a config with a provider.models map must be found');
  assert.equal(h.host, 'Kilo Code');
  assert.deepEqual(
    h.models.map((m) => m.id).sort(),
    ['claude-sonnet-4-6', 'gemini-3.8-flash', 'gpt-5.6-sol', 'vertex_ai/claude-opus-5'],
  );
  const byId = new Map(h.models.map((m) => [m.id, m]));
  // A provider-routed id still prices: normalizeModelId drops the route.
  assert.equal(byId.get('vertex_ai/claude-opus-5')!.usdPerMtok, 5);
  assert.equal(byId.get('claude-sonnet-4-6')!.usdPerMtok, 3);
  assert.equal(byId.get('gemini-3.8-flash')!.usdPerMtok, 0.75);
});

test('the host default is flagged, matched across its routing prefix', () => {
  const home = kiloHome(REAL_SHAPE);
  const h = readHostModels({ home })!;
  // `model` is "a/gemini-3.8-flash"; the models map keys it bare.
  assert.deepEqual(h.models.filter((m) => m.isDefault).map((m) => m.id), ['gemini-3.8-flash']);
});

test('a JSONC config with comments and trailing commas still reads', () => {
  const home = kiloHome(`{
  // the model a new session starts on
  "model": "a/gpt-5.6-sol",
  "provider": { "a": { "models": { "gpt-5.6-sol": { "name": "GPT 5.6 Sol" }, } } },
}
`);
  const h = readHostModels({ home })!;
  assert.deepEqual(h.models.map((m) => m.id), ['gpt-5.6-sol']);
  assert.equal(h.models[0].isDefault, true);
});

test('no config, an unrecognised shape, or broken JSON all yield null — never a guess', () => {
  assert.equal(readHostModels({ home: tmpRepo('kilo-empty') }), null, 'nothing on disk');
  assert.equal(readHostModels({ home: kiloHome({ model: 'a/x' }) }), null, 'no provider map');
  assert.equal(readHostModels({ home: kiloHome({ provider: { a: { models: [] } } }) }), null, 'models not a map');
  assert.equal(readHostModels({ home: kiloHome('{ not json at all') }), null, 'unparseable');
});

test('the table prices the saving under every model, and names the default', () => {
  const h = readHostModels({ home: kiloHome(REAL_SHAPE) });
  const out = formatModelPrices(h, 1_000_000);
  // 1M tokens: opus at $5/Mtok, sonnet at $3, gemini at $0.75.
  assert.match(out, /vertex_ai\/claude-opus-5\s+5\.00\s+\$5\.00/);
  assert.match(out, /claude-sonnet-4-6\s+3\.00\s+\$3\.00/);
  assert.match(out, /gemini-3\.8-flash\s+0\.75\s+\$0\.75.*host default/);
  // The caveat that makes the table worth reading at all.
  assert.match(out, /not necessarily the/);
});

test('an unpriced model shows no value rather than $0.00', () => {
  const home = kiloHome({
    model: 'a/some-future-model',
    provider: { a: { models: { 'some-future-model': { name: 'Future' } } } },
  });
  const h = readHostModels({ home })!;
  assert.equal(h.models[0].usdPerMtok, null);
  const out = formatModelPrices(h, 1_000_000);
  assert.doesNotMatch(out, /\$0\.00/, 'no price known is not the same as worth nothing');
  assert.match(out, /some-future-model\s+—\s+—/);
});

test('with no host config the table explains itself instead of printing nothing', () => {
  const out = formatModelPrices(null, 1000);
  assert.match(out, /no agent config with a model list found/);
  assert.match(out, /\.graft\/config\.json/);
});
