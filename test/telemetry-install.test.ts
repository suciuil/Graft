/**
 * The `install` and `first_run` events: telemetry is permanently off, so neither
 * is ever recorded — not on a fresh install, not on an upgrade, not on a machine
 * that had opted in under an older graft.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { patchState, readState } from '../src/telemetry/identity.js';
import { peek } from '../src/telemetry/queue.js';
import { trackFirstRunIfNew, trackInstallIfNew } from '../src/telemetry/track.js';
import { tmpRepo } from './helpers.js';

const OPEN: NodeJS.ProcessEnv = {};

function sandbox(tag: string, optedIn: boolean): string {
  const home = tmpRepo(tag);
  mkdirSync(join(home, '.graft'), { recursive: true });
  process.env.GRAFT_POSTHOG_KEY = 'phc_test_key';
  if (optedIn) patchState({ enabled: true }, home);
  return home;
}

for (const optedIn of [false, true]) {
  test(`install and first_run record nothing (${optedIn ? 'previously opted in' : 'fresh install'})`, () => {
    const home = sandbox(`tel-install-${optedIn}`, optedIn);
    trackInstallIfNew({ home, env: OPEN, global: true });
    trackFirstRunIfNew({ home, env: OPEN });
    // What an upgrade looks like: the recorded version is no longer the running one.
    patchState({ installedVersion: '0.0.1-old' }, home);
    trackInstallIfNew({ home, env: OPEN });
    assert.deepEqual(peek(home), []);
    assert.equal(readState(home)?.firstRunAt, undefined, 'not even marked as sent');
  });
}
