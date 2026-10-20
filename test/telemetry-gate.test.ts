/**
 * Telemetry is permanently off: no stamped key, saved setting, or environment
 * variable can turn it on, so nothing is ever recorded to the local queue or sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { doNotTrack, explainOff, inCi, offReason, telemetryOn, userCanEnable } from '../src/telemetry/gate.js';
import { track, trackFirstRunIfNew, trackInstallIfNew } from '../src/telemetry/track.js';
import { peek } from '../src/telemetry/queue.js';
import { tmpRepo } from './helpers.js';

const KEY = 'phc_test_key';

function home(tag: string, state?: Record<string, unknown>): string {
  const dir = tmpRepo(tag);
  mkdirSync(join(dir, '.graft'), { recursive: true });
  if (state) writeFileSync(join(dir, '.graft', 'telemetry.json'), JSON.stringify(state));
  return dir;
}

test('no key, saved setting or environment turns telemetry on', () => {
  process.env.GRAFT_POSTHOG_KEY = KEY;
  const optedIn = home('gate-opted-in', { installId: 'x', enabled: true });
  for (const env of [{}, { CI: 'false' }, { DO_NOT_TRACK: '0' }] as NodeJS.ProcessEnv[]) {
    assert.equal(offReason(optedIn, env), 'unavailable', JSON.stringify(env));
    assert.equal(telemetryOn(optedIn, env), false);
  }
  assert.equal(offReason(home('gate-fresh'), {}), 'unavailable', 'a brand-new install');
  delete process.env.GRAFT_POSTHOG_KEY;
  assert.equal(offReason(optedIn, {}), 'unavailable');
});

test('nothing is ever recorded, even on a machine that had opted in before', () => {
  process.env.GRAFT_POSTHOG_KEY = KEY;
  const h = home('gate-nothing', { installId: 'x', enabled: true });
  assert.equal(track('query', { command: 'ask', surface: 'cli' }, { home: h, env: {} }), null);
  trackFirstRunIfNew({ home: h, env: {} });
  trackInstallIfNew({ home: h, env: {} });
  assert.deepEqual(peek(h), []);
});

test('no reason lets a user turn it on, and every reason has a sentence', () => {
  for (const r of ['unavailable', 'no-key', 'do-not-track', 'ci', 'disabled', 'not-enabled'] as const) {
    assert.equal(userCanEnable(r), false, r);
    assert.match(explainOff(r), /^off — \S/);
  }
  assert.equal(userCanEnable(null), false);
  assert.match(explainOff('unavailable'), /permanently disabled .* cannot be turned on/);
});

test('DO_NOT_TRACK=0 and an empty value mean "not set"', () => {
  assert.equal(doNotTrack({ DO_NOT_TRACK: '0' }), false);
  assert.equal(doNotTrack({ DO_NOT_TRACK: '' }), false);
  assert.equal(doNotTrack({}), false);
  assert.equal(doNotTrack({ DO_NOT_TRACK: 'true' }), true);
});

test('CI detection still reads the provider variables', () => {
  assert.equal(inCi({ CI: 'true' }), true);
  assert.equal(inCi({ GITHUB_ACTIONS: 'true' }), true);
  assert.equal(inCi({ CI: 'false' }), false, 'CI=false is not CI');
  assert.equal(inCi({ CI: '0' }), false);
});
