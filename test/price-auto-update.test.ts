/**
 * Tests for the automatic `graft prices update` (`withAutoPrices`): when it runs
 * (the installer's answer, `graft prices auto`), how often it downloads, and what
 * it tells the savings tally. No test touches the network or the user's real
 * installer answers: every fetch is a fake and every path a scratch file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FAILED_RETRY_MS,
  HOOK_CHILD_ENV,
  INSTALLER_PRICES_ANSWER_ID,
  INSTALLER_PRICES_AUTO_ANSWER_ID,
  LOCK_STALE_MS,
  MODEL_RETRY_MS,
  PRICES_AUTO_ENV,
  autoPricesLockPath,
  autoPricesLogPath,
  autoPricesState,
  installerPricesConsent,
  withAutoPrices,
} from '../src/context/price-auto-update.js';
import { LITELLM_PRICES_URL, type PriceCatalog } from '../src/context/price-catalog.js';
import { NO_MODEL, pricingFor, type AgentModel, type Pricing } from '../src/context/price.js';

process.env.GRAFT_BUNDLED_PRICES = '0';

const dir = mkdtempSync(join(tmpdir(), 'graft-price-auto-'));
let n = 0;
const certain = (id: string, label?: string): AgentModel => ({ id, confidence: 'certain', label });
const NOW = Date.parse('2026-11-15T05:00:00.000Z');
const HOUR = 3_600_000;

/** A fresh, empty folder for the price catalog (and so the attempt log). */
function freshPrices(catalog?: PriceCatalog): string {
  const sub = mkdtempSync(join(dir, `p${n++}-`));
  const path = join(sub, 'prices.json');
  if (catalog) writeFileSync(path, JSON.stringify(catalog));
  process.env.GRAFT_PRICES_FILE = path;
  return path;
}

/** An installer answers file, as START-HERE-install-graft.cmd writes it. */
function choices(value: string | null, id = INSTALLER_PRICES_AUTO_ANSWER_ID, bom = false): string {
  const path = join(dir, `choices-${n++}.json`);
  const answers = value === null ? {} : { [id]: { value, date: '2026-11-01', question: 'Download the price list?' } };
  writeFileSync(path, `${bom ? '\uFEFF' : ''}${JSON.stringify({ version: 1, answers })}`);
  return path;
}

const LITELLM_SAMPLE = {
  sample_spec: { mode: 'chat', input_cost_per_token: 0 },
  'vertex_ai/zeta-1': { mode: 'chat', input_cost_per_token: 0.000002 },
  'gpt-4o-mini': { mode: 'chat', input_cost_per_token: 1.5e-7 },
};

/** A fake fetch serving LiteLLM's catalog (or a status), counting its calls. */
function fakeFetch(status = 200): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return status === 200
      ? new Response(JSON.stringify(LITELLM_SAMPLE), { status })
      : new Response('nope', { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const yes = () => ({ env: {}, choicesPath: choices('yes') });

test('installer consent: only a recorded "yes" to automatic updates, for this very download address, counts', () => {
  assert.deepEqual(installerPricesConsent(choices('yes')), { date: '2026-11-01' });
  assert.deepEqual(installerPricesConsent(choices('Yes', undefined, true)), { date: '2026-11-01' }, 'a BOM and casing are fine');
  assert.equal(installerPricesConsent(choices('no')), null);
  assert.equal(installerPricesConsent(choices(null)), null, 'never asked');
  assert.equal(installerPricesConsent(choices('yes', 'prices-auto-update|https://example.com/other.json')), null, 'another address');
  assert.equal(installerPricesConsent(choices('yes', INSTALLER_PRICES_ANSWER_ID)), null, 'a "yes" to the one-off download alone is not one to automatic updates');
  assert.equal(installerPricesConsent(join(dir, 'no-such-choices.json')), null, 'installer never ran');
  const broken = join(dir, 'broken-choices.json');
  writeFileSync(broken, '{ not json');
  assert.equal(installerPricesConsent(broken), null);
  assert.equal(INSTALLER_PRICES_ANSWER_ID, `prices-download|${LITELLM_PRICES_URL}`, 'the installer keys its answer the same way');
  assert.equal(INSTALLER_PRICES_AUTO_ANSWER_ID, `prices-auto-update|${LITELLM_PRICES_URL}`);
});

test('the installer downloads from, and keys its answers on, the very address graft downloads from', () => {
  const script = readFileSync(new URL('../install-graft-helper.ps1', import.meta.url), 'utf8');
  const url = /^\$PricesUrl\s*=\s*'([^']+)'/m.exec(script)?.[1];
  assert.equal(url, LITELLM_PRICES_URL, '$PricesUrl in install-graft-helper.ps1');
  assert.match(script, /^\$PricesAnswerId\s*=\s*"prices-download\|\$PricesUrl"/m);
  assert.match(script, /^\$PricesAutoAnswerId\s*=\s*"prices-auto-update\|\$PricesUrl"/m);
});

test('the option: on by default once the installer said yes; on/off override it', () => {
  const y = choices('yes');
  const no = choices('no');
  assert.deepEqual(autoPricesState({}, y), { on: true, why: 'installer', date: '2026-11-01' });
  assert.deepEqual(autoPricesState({}, no), { on: false, why: 'no-consent' });
  for (const off of ['0', 'off', 'false', 'no', ' OFF ']) {
    assert.deepEqual(autoPricesState({ [PRICES_AUTO_ENV]: off }, y), { on: false, why: 'off' }, `${off} turns it off`);
  }
  assert.deepEqual(autoPricesState({ [PRICES_AUTO_ENV]: '1' }, no), { on: true, why: 'explicit' }, 'explicitly on needs no installer');
  assert.deepEqual(autoPricesState({ [PRICES_AUTO_ENV]: '   ' }, no), { on: false, why: 'no-consent' }, 'blank is the default');
});

test('nothing to do: a priced model, an unnamed model, or the option off never downloads', async () => {
  freshPrices();
  const { fetchImpl, calls } = fakeFetch();
  const priced = pricingFor(certain('claude-opus-5'));
  assert.ok(priced.rate, 'graft prices this one itself');
  assert.equal(await withAutoPrices(priced, { ...yes(), fetchImpl, now: NOW }), priced);
  const unnamed = pricingFor(NO_MODEL);
  assert.equal(await withAutoPrices(unnamed, { ...yes(), fetchImpl, now: NOW }), unnamed);
  const guessed: Pricing = { rate: null, model: { id: 'zeta-1', confidence: 'guess' } as AgentModel };
  assert.equal(await withAutoPrices(guessed, { ...yes(), fetchImpl, now: NOW }), guessed, 'only a model the agent named');
  const unpriced = pricingFor(certain('zeta-1'));
  assert.equal(await withAutoPrices(unpriced, { env: {}, choicesPath: choices('no'), fetchImpl, now: NOW }), unpriced);
  assert.equal(
    await withAutoPrices(unpriced, { env: { [PRICES_AUTO_ENV]: '0' }, choicesPath: choices('yes'), fetchImpl, now: NOW }),
    unpriced,
  );
  assert.equal(calls.length, 0);
});

test('an unpriced model is priced by downloading the catalog right then', async () => {
  const path = freshPrices();
  const { fetchImpl, calls } = fakeFetch();
  const before = pricingFor(certain('zeta-1', 'Zeta 1'));
  assert.equal(before.rate, null);
  const after = await withAutoPrices(before, { ...yes(), fetchImpl, now: NOW });
  assert.deepEqual(calls, [LITELLM_PRICES_URL], 'one GET of the whole public catalog');
  assert.equal(after.rate?.usdPerMtok, 2);
  assert.equal(after.model, before.model);
  assert.deepEqual(after.autoUpdate, { outcome: 'updated', fetchedAt: new Date(NOW).toISOString() });
  assert.ok(existsSync(path), 'stored like `graft prices update` stores it');
  const log = JSON.parse(readFileSync(autoPricesLogPath(path), 'utf8'));
  assert.equal(log.models['zeta-1'].ok, true);
});

test('`graft prices auto on` works without the installer', async () => {
  freshPrices();
  const { fetchImpl, calls } = fakeFetch();
  const after = await withAutoPrices(pricingFor(certain('zeta-1')), {
    env: { [PRICES_AUTO_ENV]: '1' },
    choicesPath: join(dir, 'no-such-choices.json'),
    fetchImpl,
    now: NOW,
  });
  assert.equal(calls.length, 1);
  assert.equal(after.autoUpdate?.outcome, 'updated');
});

test('a model LiteLLM does not list: one download, then none for a day', async () => {
  freshPrices();
  const { fetchImpl, calls } = fakeFetch();
  const opts = yes();
  const model = pricingFor(certain('nobody-knows-9'));
  const first = await withAutoPrices(model, { ...opts, fetchImpl, now: NOW });
  assert.equal(first.rate, null);
  assert.equal(first.autoUpdate?.outcome, 'updated');
  assert.equal(calls.length, 1);

  const later = await withAutoPrices(model, { ...opts, fetchImpl, now: NOW + 2 * HOUR });
  assert.deepEqual(later.autoUpdate, { outcome: 'current', fetchedAt: new Date(NOW).toISOString() });
  assert.equal(calls.length, 1, 'no second download the same day');

  const nextDay = await withAutoPrices(model, { ...opts, fetchImpl, now: NOW + MODEL_RETRY_MS + HOUR });
  assert.equal(nextDay.autoUpdate?.outcome, 'updated');
  assert.equal(calls.length, 2, 'tried again a day later');
});

test('a local catalog updated less than an hour ago is not downloaded again', async () => {
  freshPrices({
    version: 1,
    source: 'LiteLLM',
    url: LITELLM_PRICES_URL,
    fetchedAt: new Date(NOW - HOUR / 2).toISOString(),
    models: { 'gpt-4o-mini': { input: 0.15 } },
  });
  const { fetchImpl, calls } = fakeFetch();
  const after = await withAutoPrices(pricingFor(certain('nobody-knows-9')), { ...yes(), fetchImpl, now: NOW });
  assert.deepEqual(after.autoUpdate, { outcome: 'current', fetchedAt: new Date(NOW - HOUR / 2).toISOString() });
  assert.equal(after.rate, null);
  assert.equal(calls.length, 0);
});

test('a failed download: the model stays unpriced, says why, and is retried an hour later', async () => {
  freshPrices();
  const failing = fakeFetch(503);
  const opts = yes();
  const model = pricingFor(certain('zeta-1'));
  const first = await withAutoPrices(model, { ...opts, fetchImpl: failing.fetchImpl, now: NOW });
  assert.equal(first.rate, null);
  assert.equal(first.autoUpdate?.outcome, 'failed');
  assert.match((first.autoUpdate as { reason: string }).reason, /HTTP 503/);

  const soon = await withAutoPrices(model, { ...opts, fetchImpl: failing.fetchImpl, now: NOW + HOUR / 2 });
  assert.equal(soon.autoUpdate?.outcome, 'failed');
  assert.equal(failing.calls.length, 1, 'not on every call');

  const working = fakeFetch();
  const later = await withAutoPrices(model, { ...opts, fetchImpl: working.fetchImpl, now: NOW + FAILED_RETRY_MS + 1 });
  assert.equal(later.autoUpdate?.outcome, 'updated');
  assert.equal(later.rate?.usdPerMtok, 2);
});

test('a `graft prices update` run by hand since supersedes the attempt on record', async () => {
  const path = freshPrices();
  const opts = yes();
  const model = pricingFor(certain('nobody-knows-9'));
  const failing = fakeFetch(503);
  const failed = await withAutoPrices(model, { ...opts, fetchImpl: failing.fetchImpl, now: NOW });
  assert.equal(failed.autoUpdate?.outcome, 'failed');

  // The user follows the failure line's advice ten minutes later, and it works.
  const manual = new Date(NOW + 10 * 60_000).toISOString();
  writeFileSync(path, JSON.stringify({ version: 1, source: 'LiteLLM', url: LITELLM_PRICES_URL, fetchedAt: manual, models: { 'gpt-4o-mini': { input: 0.15 } } }));
  const after = await withAutoPrices(model, { ...opts, fetchImpl: failing.fetchImpl, now: NOW + 15 * 60_000 });
  assert.deepEqual(after.autoUpdate, { outcome: 'current', fetchedAt: manual }, 'no stale failure line');
  assert.equal(failing.calls.length, 1, 'and no download: the catalog is minutes old');
});

test('another graft process downloading: this one waits for it instead of downloading too', async () => {
  const path = freshPrices();
  const lock = autoPricesLockPath(path);
  writeFileSync(lock, '');
  const { fetchImpl, calls } = fakeFetch();
  const fetchedAt = new Date(NOW).toISOString();
  setTimeout(() => {
    writeFileSync(path, JSON.stringify({ version: 1, source: 'LiteLLM', url: LITELLM_PRICES_URL, fetchedAt, models: { 'zeta-1': { input: 2 } } }));
    unlinkSync(lock);
  }, 300);
  const after = await withAutoPrices(pricingFor(certain('zeta-1')), { ...yes(), fetchImpl, now: NOW });
  assert.equal(calls.length, 0, 'the other process made the download');
  assert.equal(after.rate?.usdPerMtok, 2);
  assert.deepEqual(after.autoUpdate, { outcome: 'updated', fetchedAt });

  // The other process failed: recorded as a failure here too, so this one does
  // not pay the same timeout again on its next call.
  const path2 = freshPrices();
  const lock2 = autoPricesLockPath(path2);
  writeFileSync(lock2, '');
  setTimeout(() => unlinkSync(lock2), 300);
  const opts = yes();
  const failed = await withAutoPrices(pricingFor(certain('zeta-1')), { ...opts, fetchImpl, now: NOW });
  assert.equal(failed.autoUpdate?.outcome, 'failed');
  const again = await withAutoPrices(pricingFor(certain('zeta-1')), { ...opts, fetchImpl, now: NOW + 60_000 });
  assert.equal(again.autoUpdate?.outcome, 'failed');
  assert.equal(calls.length, 0);
});

test('a lock left by a process that died is taken over, and released after the download', async () => {
  const path = freshPrices();
  const lock = autoPricesLockPath(path);
  writeFileSync(lock, '');
  const old = (Date.now() - LOCK_STALE_MS - 60_000) / 1000;
  utimesSync(lock, old, old);
  const { fetchImpl, calls } = fakeFetch();
  const after = await withAutoPrices(pricingFor(certain('zeta-1')), { ...yes(), fetchImpl, now: NOW });
  assert.equal(calls.length, 1);
  assert.equal(after.autoUpdate?.outcome, 'updated');
  assert.equal(existsSync(lock), false, 'no lock left behind');
});

test('a slow download: the call goes on without it, and the download still lands for the next call', async () => {
  const path = freshPrices();
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slowFetch = (async (url: string) => {
    calls.push(url);
    await gate;
    return new Response(JSON.stringify(LITELLM_SAMPLE), { status: 200 });
  }) as unknown as typeof fetch;
  const opts = yes();
  const started = Date.now();
  const first = await withAutoPrices(pricingFor(certain('zeta-1')), { ...opts, fetchImpl: slowFetch, now: NOW, waitMs: 50 });
  assert.ok(Date.now() - started < 2_000, 'answered without waiting for the download');
  assert.equal(first.rate, null);
  assert.deepEqual(first.autoUpdate, { outcome: 'pending' });
  assert.equal(calls.length, 1);

  // Recorded as started, so a process killed now leaves a failed attempt behind.
  const log = autoPricesLogPath(path);
  const entry = () => (existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')).models['zeta-1'] : undefined);
  assert.equal(entry()?.pending, true);
  release();
  // The background download records its result once it ends.
  for (let i = 0; i < 100 && !entry()?.ok; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(entry().ok, true);
  assert.equal(entry().pending, undefined);
  const next = pricingFor(certain('zeta-1'));
  assert.equal(next.rate?.usdPerMtok, 2, 'the next call is priced from the stored catalog');
  assert.equal(existsSync(autoPricesLockPath(path)), false, 'no lock left behind');
});

test('another process still downloading after our own timeout: pending, and nothing recorded here', async () => {
  const path = freshPrices();
  const lock = autoPricesLockPath(path);
  writeFileSync(lock, '');
  const { fetchImpl, calls } = fakeFetch();
  const after = await withAutoPrices(pricingFor(certain('zeta-1')), { ...yes(), fetchImpl, now: NOW, timeoutMs: 100, waitMs: 5_000 });
  assert.deepEqual(after.autoUpdate, { outcome: 'pending' });
  assert.equal(calls.length, 0);
  assert.equal(existsSync(autoPricesLogPath(path)), false, 'the other process records its own result');
  unlinkSync(lock);
});

test("a hook's graft child never downloads: the hook would kill it first", async () => {
  freshPrices();
  const { fetchImpl, calls } = fakeFetch();
  const unpriced = pricingFor(certain('zeta-1'));
  const after = await withAutoPrices(unpriced, { env: { [HOOK_CHILD_ENV]: '1' }, choicesPath: choices('yes'), fetchImpl, now: NOW });
  assert.equal(after, unpriced);
  assert.equal(calls.length, 0);
});

test('a download whose process was killed counts as a failed attempt; one still running is waited for', async () => {
  const pendingEntry = (at: number) =>
    JSON.stringify({ version: 1, models: { 'zeta-1': { at: new Date(at).toISOString(), ok: false, pending: true, reason: 'the download did not finish: the graft process running it ended first' } } });

  // Killed: the entry is there, the lock is not.
  const path = freshPrices();
  writeFileSync(autoPricesLogPath(path), pendingEntry(NOW));
  const { fetchImpl, calls } = fakeFetch();
  const opts = yes();
  const soon = await withAutoPrices(pricingFor(certain('zeta-1')), { ...opts, fetchImpl, now: NOW + 60_000 });
  assert.equal(soon.autoUpdate?.outcome, 'failed');
  assert.match(soon.autoUpdate?.outcome === 'failed' ? soon.autoUpdate.reason : '', /ended first/);
  assert.equal(calls.length, 0, 'not started again on every call');
  const later = await withAutoPrices(pricingFor(certain('zeta-1')), { ...opts, fetchImpl, now: NOW + FAILED_RETRY_MS + 1 });
  assert.equal(later.autoUpdate?.outcome, 'updated');
  assert.equal(calls.length, 1);

  // Still running: its lock is held, so this call waits for it.
  const path2 = freshPrices();
  writeFileSync(autoPricesLogPath(path2), pendingEntry(NOW));
  const lock = autoPricesLockPath(path2);
  writeFileSync(lock, '');
  const fetchedAt = new Date(NOW).toISOString();
  setTimeout(() => {
    writeFileSync(path2, JSON.stringify({ version: 1, source: 'LiteLLM', url: LITELLM_PRICES_URL, fetchedAt, models: { 'zeta-1': { input: 2 } } }));
    unlinkSync(lock);
  }, 300);
  const waited = await withAutoPrices(pricingFor(certain('zeta-1')), { ...yes(), fetchImpl, now: NOW + 1_000 });
  assert.equal(waited.autoUpdate?.outcome, 'updated');
  assert.equal(calls.length, 1, 'the other process made the download');
});

test('never throws, and overlapping calls share one download', async () => {
  freshPrices();
  const throwing = (() => {
    throw new Error('no network stack');
  }) as unknown as typeof fetch;
  const failed = await withAutoPrices(pricingFor(certain('zeta-1')), { ...yes(), fetchImpl: throwing, now: NOW });
  assert.equal(failed.autoUpdate?.outcome, 'failed');

  freshPrices();
  const { fetchImpl, calls } = fakeFetch();
  const opts = yes();
  const [a, b] = await Promise.all([
    withAutoPrices(pricingFor(certain('zeta-1')), { ...opts, fetchImpl, now: NOW }),
    withAutoPrices(pricingFor(certain('nobody-knows-9')), { ...opts, fetchImpl, now: NOW }),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(a.autoUpdate?.outcome, 'updated');
  assert.equal(b.autoUpdate?.outcome, 'updated');
});
