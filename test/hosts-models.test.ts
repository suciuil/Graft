/**
 * `graft models` — the per-model price table, read from Kilo Code's own config.
 *
 * Every test injects its own `home`. Reading the developer's real Kilo config
 * here would make the suite pass or fail by machine, which is exactly how an
 * earlier attempt at host-config reading broke three unrelated tests.
 *
 * Both config generations are covered: 7.x (`~/.config/kilo/kilo.jsonc`) and
 * 5.x (the VS Code extension's `secrets.json`, whose model list is a
 * JSON-encoded string nested inside the outer JSON).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatModelPrices, hostLabelFor, pricedRows, readHostModels } from '../src/hosts/models.js';
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

/**
 * The paired shape, copied from a real config: a SECOND entry for a model
 * already listed, keyed with a `#` discriminator and declaring the model it
 * actually runs in `id`. It exists to give that model different subagent wiring,
 * and it is what the user sees in their picker.
 */
const PAIR_SHAPE = {
  model: 'a/gemini-3.8-flash',
  provider: {
    a: {
      models: {
        'vertex_ai/claude-opus-5': { name: 'Claude Opus 5' },
        'vertex_ai/claude-opus-5#pair-gemini': {
          id: 'vertex_ai/claude-opus-5',
          name: 'Claude Opus 5 + Gemini 3.8 Flash',
        },
        'gemini-3.8-flash': { name: 'Gemini 3.8 Flash' },
      },
    },
  },
};

/** A Kilo 5.x secrets file: the model list is a JSON-encoded STRING nested in
 * the outer JSON, one entry per configured API profile. */
function kilo5Home(profiles: Record<string, unknown>, current = 'default'): string {
  const home = tmpRepo('kilo5-models');
  const dir = join(home, '.kilocode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'secrets.json'),
    JSON.stringify({
      'kilo code.kilo-code': {
        roo_cline_config_api_config: JSON.stringify({ currentApiConfigName: current, apiConfigs: profiles }),
      },
    }),
  );
  return home;
}

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

test('models are ordered Anthropic, then OpenAI, then Google, top tier first', () => {
  const h = readHostModels({ home: kiloHome(REAL_SHAPE) })!;
  assert.deepEqual(h.models.map((m) => m.name ?? m.id), [
    'Claude Opus 5',      // Anthropic, top tier ($5)
    'Claude Sonnet 4.6',  // Anthropic, mid  ($3)
    'GPT 5.6 Sol',        // OpenAI          ($4)
    'Gemini 3.8 Flash',   // Google          ($0.75)
  ]);
});

test('a vendor graft has no editorial order for follows the named three', () => {
  const home = kiloHome({
    provider: { a: { models: {
      'grok-4.3': { name: 'Grok 4.3' },
      'claude-opus-5': { name: 'Claude Opus 5' },
      'deepseek-v4.pro': { name: 'DeepSeek V4 Pro' },
    } } },
  });
  const h = readHostModels({ home })!;
  // Anthropic first (named), then the rest alphabetically by vendor.
  assert.deepEqual(h.models.map((m) => m.id), ['claude-opus-5', 'deepseek-v4.pro', 'grok-4.3']);
});

// ── Kilo Code 5.x ─────────────────────────────────────────────────────────

test('reads the model list out of a Kilo 5.x secrets file', () => {
  const home = kilo5Home({
    default: { apiProvider: 'openai', openAiModelId: 'vertex_ai/claude-opus-5' },
    'sonnet-profile': { apiProvider: 'openai', openAiModelId: 'claude-sonnet-4-6' },
    'gemini-profile': { apiProvider: 'openai', openAiModelId: 'gemini-3.8-flash' },
  });
  const h = readHostModels({ home });
  assert.ok(h, 'the 5.x secrets file must be found');
  assert.deepEqual(h.models.map((m) => m.id), [
    'vertex_ai/claude-opus-5',
    'claude-sonnet-4-6',
    'gemini-3.8-flash',
  ]);
  // The profile NAME is never mistaken for a model id.
  assert.ok(!h.models.some((m) => m.id.includes('profile')));
});

test('5.x: the current profile is the default, and other id fields are read', () => {
  const home = kilo5Home(
    {
      a: { apiModelId: 'claude-opus-5' },
      b: { openRouterModelId: 'gemini-3.8-flash' },
      c: { apiProvider: 'openai' }, // no model id at all — skipped, not crashed
    },
    'b',
  );
  const h = readHostModels({ home })!;
  assert.deepEqual(h.models.filter((m) => m.isDefault).map((m) => m.id), ['gemini-3.8-flash']);
  assert.equal(h.models.length, 2, 'a profile naming no model contributes none');
});

test('both generations installed side by side yield ONE de-duplicated list', () => {
  // A user mid-upgrade has both files. The same model reached by two routes is
  // one row: the reply is about what a saving cost, not about config archaeology.
  const home = kiloHome(REAL_SHAPE);
  const dir = join(home, '.kilocode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'secrets.json'),
    JSON.stringify({
      'kilo code.kilo-code': {
        roo_cline_config_api_config: JSON.stringify({
          currentApiConfigName: 'default',
          apiConfigs: {
            default: { openAiModelId: 'claude-opus-5' },     // same model as 7.x's vertex_ai/ one
            extra: { openAiModelId: 'claude-haiku-4-5' },    // only in 5.x
          },
        }),
      },
    }),
  );
  const h = readHostModels({ home })!;
  assert.equal(h.paths.length, 2, 'both files are reported as sources');
  const ids = h.models.map((m) => m.id);
  assert.ok(ids.includes('vertex_ai/claude-opus-5'), '7.x wins the duplicate: it has the display name');
  assert.ok(!ids.includes('claude-opus-5'), 'the bare 5.x duplicate is dropped');
  assert.ok(ids.includes('claude-haiku-4-5'), 'a model only 5.x knows still appears');
});

test('the host default is flagged, matched across its routing prefix', () => {
  const home = kiloHome(REAL_SHAPE);
  const h = readHostModels({ home })!;
  // `model` is "a/gemini-3.8-flash"; the models map keys it bare.
  assert.deepEqual(h.models.filter((m) => m.isDefault).map((m) => m.id), ['gemini-3.8-flash']);
});

test('the host default is matched across case and the version separator too', () => {
  // The routing prefix is not the only thing the two sides disagree about. The
  // `model` field and the `provider.<id>.models` keys are written by different
  // parts of the host, and a `.`-vs-`-` or case difference between them left the
  // default unflagged — so `graft models` printed a table in which NO row was
  // the default, which reads as "none of these" rather than as a match failure.
  for (const spelling of ['a/gemini-3-8-flash', 'a/Gemini-3.8-Flash', 'A/GEMINI-3.8-FLASH']) {
    const home = kiloHome({ ...REAL_SHAPE, model: spelling });
    const h = readHostModels({ home })!;
    assert.deepEqual(
      h.models.filter((m) => m.isDefault).map((m) => m.id),
      ['gemini-3.8-flash'],
      `default written as ${spelling}`,
    );
  }
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

test('a model graft cannot price is left out entirely, never shown as $0.00', () => {
  // This table is read in the agent's reply on every turn: a row that cannot
  // answer "what was it worth" is noise, and a $0.00 would be a lie.
  const home = kiloHome({
    model: 'a/some-future-model',
    provider: { a: { models: {
      'some-future-model': { name: 'Future' },
      'claude-opus-5': { name: 'Claude Opus 5' },
    } } },
  });
  const h = readHostModels({ home })!;
  assert.deepEqual(h.models.map((m) => m.id), ['claude-opus-5']);
  const out = formatModelPrices(h, 1_000_000);
  assert.doesNotMatch(out, /\$0\.00/);
  assert.doesNotMatch(out, /some-future-model/);
});

test('a config whose every model is unpriced yields null, not an empty table', () => {
  const home = kiloHome({ provider: { a: { models: { 'some-future-model': { name: 'F' } } } } });
  assert.equal(readHostModels({ home }), null);
});

test('with no host config the table explains itself instead of printing nothing', () => {
  const out = formatModelPrices(null, 1000);
  assert.match(out, /no agent config with a model list found/);
  assert.match(out, /--agent-model/, 'and names the one way to get a price');
});

// ── the rows the savings nudge relays ─────────────────────────────────────

test('pricedRows labels each row the way the user sees it in their host', () => {
  const h = readHostModels({ home: kiloHome(REAL_SHAPE) })!;
  const rows = pricedRows(h, 1_000_000);
  assert.deepEqual(rows, [
    { label: 'Claude Opus 5', value: '$5.00' },
    { label: 'Claude Sonnet 4.6', value: '$3.00' },
    { label: 'GPT 5.6 Sol', value: '$4.00' },
    { label: 'Gemini 3.8 Flash', value: '$0.75' },
  ]);
});

test('a 5.x-only model falls back to its id when the host gave no display name', () => {
  const rows = pricedRows(readHostModels({ home: kilo5Home({ a: { apiModelId: 'claude-opus-5' } }) })!, 1_000_000);
  assert.deepEqual(rows, [{ label: 'claude-opus-5', value: '$5.00' }]);
});

test('hostLabelFor resolves a wire id to the name the user picked from a menu', () => {
  const home = kiloHome(REAL_SHAPE);
  assert.equal(hostLabelFor('vertex_ai/claude-opus-5', { home }), 'Claude Opus 5');
  // Matched across the routing prefix in either direction.
  assert.equal(hostLabelFor('claude-opus-5', { home }), 'Claude Opus 5');
  assert.equal(hostLabelFor('some-other-model', { home }), undefined);
});

// ── one model offered twice, with different subagent wiring ───────────────

test('a paired config entry is one row with the plain one, not a second model', () => {
  // `…#pair-gemini` runs the same model at the same rate — it only changes which
  // model the SUBAGENTS use. Two rows would price one saving twice in a table
  // the user reads on every turn, and split the ledger into two dollar figures
  // for a model they switched between rather than used twice.
  const h = readHostModels({ home: kiloHome(PAIR_SHAPE) })!;
  assert.deepEqual(h.models.map((m) => m.id), ['vertex_ai/claude-opus-5', 'gemini-3.8-flash']);
  assert.equal(h.models[0].usdPerMtok, 5);
});

test('the paired entry keeps the name the user picked it by', () => {
  // It prices as plain Opus, but "Claude Opus 5" is not what the user selected:
  // a tally naming it that sends them looking for a model absent from their
  // picker. The exact entry wins over the row it was folded into.
  const home = kiloHome(PAIR_SHAPE);
  assert.equal(
    hostLabelFor('a/vertex_ai/claude-opus-5#pair-gemini', { home }),
    'Claude Opus 5 + Gemini 3.8 Flash',
  );
  assert.equal(hostLabelFor('a/vertex_ai/claude-opus-5', { home }), 'Claude Opus 5', 'plain entry unaffected');
});

test('the host default is found on a paired entry too', () => {
  // The default may name the alias rather than the entry listed first; the flag
  // belongs to the model either way.
  const home = kiloHome({ ...PAIR_SHAPE, model: 'a/vertex_ai/claude-opus-5#pair-gemini' });
  const h = readHostModels({ home })!;
  assert.deepEqual(h.models.filter((m) => m.isDefault).map((m) => m.id), ['vertex_ai/claude-opus-5']);
});

test('hostLabelFor matches the id shapes an agent actually reports', () => {
  // What the agent sends is its own configured id, and Kilo spells that with the
  // PROVIDER route on the front: `a/gemini-3.8-flash`, not the bare key of the
  // `provider.a.models` map. A stacked route (`a/vertex_ai/claude-opus-5`) is the
  // same story one level deeper. Case and the version separator vary for the
  // same reason — different writers, same model. A miss here is silent: the
  // tally falls back to the wire id, and the user is shown a name that appears
  // nowhere in their model picker.
  const home = kiloHome(REAL_SHAPE);
  assert.equal(hostLabelFor('a/gemini-3.8-flash', { home }), 'Gemini 3.8 Flash');
  assert.equal(hostLabelFor('a/vertex_ai/claude-opus-5', { home }), 'Claude Opus 5');
  assert.equal(hostLabelFor('a/gemini-3-8-flash', { home }), 'Gemini 3.8 Flash', 'separator folds');
  assert.equal(hostLabelFor('A/Gemini-3.8-Flash', { home }), 'Gemini 3.8 Flash', 'case folds');
  // The fold must not invent a match: a different model still has no label.
  assert.equal(hostLabelFor('a/gemini-3.7-flash', { home }), undefined);
});

test('the two generations de-duplicate across the version separator as well', () => {
  // Both files on disk mid-upgrade, the same model spelled `gemini-3.8-flash` in
  // the 7.x provider map and `gemini-3-8-flash` in a 5.x profile. That is one
  // model the user configured once; listing it twice prices the same saving
  // under the same model on two rows of the same table.
  const home = kiloHome({ provider: { a: { models: { 'gemini-3.8-flash': { name: 'Gemini 3.8 Flash' } } } } });
  const dir = join(home, '.kilocode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'secrets.json'),
    JSON.stringify({
      'kilo code.kilo-code': {
        roo_cline_config_api_config: JSON.stringify({
          currentApiConfigName: 'default',
          apiConfigs: { default: { openAiModelId: 'gemini-3-8-flash' } },
        }),
      },
    }),
  );
  const h = readHostModels({ home })!;
  assert.deepEqual(h.models.map((m) => m.id), ['gemini-3.8-flash'], '7.x wins: it has the display name');
});
