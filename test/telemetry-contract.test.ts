/**
 * The contract tests. These are the ones that matter: they assert that a call
 * site cannot send something the published `TELEMETRY.md` does not list, even if
 * it tries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVENTS,
  countBucket,
  durationBucket,
  errorCode,
  filesBucket,
  isTrackedCommand,
  langsValue,
  savedTokensBucket,
} from '../src/telemetry/contract.js';
import { track } from '../src/telemetry/track.js';
import { peek } from '../src/telemetry/queue.js';
import { patchState } from '../src/telemetry/identity.js';
import { tmpRepo } from './helpers.js';

/** A machine that had opted in under an older graft: even that must record nothing now. */
const OPEN: NodeJS.ProcessEnv = {};

function sandbox(tag: string): string {
  const home = tmpRepo(tag);
  mkdirSync(join(home, '.graft'), { recursive: true });
  process.env.GRAFT_POSTHOG_KEY = 'phc_test_key';
  patchState({ enabled: true }, home);
  return home;
}

// --- the allowlist ---

test('an event that is not in the contract is dropped whole', () => {
  const home = sandbox('tel-unknown-event');
  assert.equal(track('exfiltrate', { anything: 'here' }, { home, env: OPEN }), null);
  assert.deepEqual(peek(home), []);
});

test('every event in the contract is dropped too: telemetry is permanently off', () => {
  const home = sandbox('tel-all-dropped');
  for (const event of Object.keys(EVENTS)) {
    assert.equal(track(event, { command: 'ask', surface: 'cli' }, { home, env: OPEN }), null, event);
  }
  assert.deepEqual(peek(home), [], 'nothing reaches the local queue');
});

// Pinned rather than counted, so adding an event is a deliberate edit here and
// a matching row in TELEMETRY.md, never something that arrives with a feature.
test('the contract lists exactly the sixteen documented events', () => {
  assert.deepEqual(Object.keys(EVENTS).sort(), [
    'brain_signup_opened', 'brain_signup_settled', 'build_completed', 'build_failed',
    'cold_start', 'first_run', 'init_completed', 'install', 'learning_reused', 'learnings_committed', 'note_saved', 'query', 'repo_seen', 'session_summary', 'skills_folded', 'takeaway_saved',
  ]);
});

test('only the known commands are tracked', () => {
  assert.equal(isTrackedCommand('ask'), true);
  assert.equal(isTrackedCommand('init'), false, 'init has its own event, not a query');
  assert.equal(isTrackedCommand('telemetry'), false);
  assert.equal(isTrackedCommand('_telemetry-flush'), false);
});

// --- buckets: no raw number ever crosses ---

test('filesBucket collapses a repo size to a label', () => {
  assert.equal(filesBucket(0), '0');
  assert.equal(filesBucket(1), '1-49');
  assert.equal(filesBucket(49), '1-49');
  assert.equal(filesBucket(50), '50-199');
  assert.equal(filesBucket(999), '200-999');
  assert.equal(filesBucket(4999), '1000-4999');
  assert.equal(filesBucket(5000), '5000+');
});

test('durationBucket collapses wall-clock to a label', () => {
  assert.equal(durationBucket(999), '<1s');
  assert.equal(durationBucket(1000), '1-5s');
  assert.equal(durationBucket(29_999), '5-30s');
  assert.equal(durationBucket(600_000), '10m+');
});

test('countBucket and savedTokensBucket cover their boundaries', () => {
  assert.equal(countBucket(0), '0');
  assert.equal(countBucket(4), '1-4');
  assert.equal(countBucket(5), '5-19');
  assert.equal(countBucket(200), '200+');
  assert.equal(savedTokensBucket(0), '0');
  assert.equal(savedTokensBucket(999), '<1k');
  assert.equal(savedTokensBucket(1000), '1-5k');
  assert.equal(savedTokensBucket(100_000), '100k+');
});

test('langsValue sorts, dedupes and caps so it cannot fingerprint a repo', () => {
  assert.equal(langsValue(['ts', 'go', 'TS']), 'go,ts');
  assert.equal(langsValue([]), '');
  assert.equal(langsValue(['a','b','c','d','e','f','g','h','i','j']).split(',').length, 8);
});

// --- error codes: a message is never a code ---

test('errorCode maps to the enum and never returns the message', () => {
  const err = new Error('cannot parse /Users/someone/private/src/secrets.ts:42');
  assert.equal(errorCode(err), 'E_PARSE');
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'EACCES' })), 'E_PERMISSION');
  assert.equal(errorCode(Object.assign(new Error('x'), { status: 429 })), 'E_RATE_LIMIT');
  assert.equal(errorCode(new Error('something nobody classified')), 'E_UNKNOWN');
});

// --- the allowlist must reject by design, not by exception ---

test('a prototype key is not an event: EVENTS.constructor must not look like a hit', () => {
  const home = sandbox('tel-proto-event');
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.equal(track(name, { command: 'ask' }, { home, env: OPEN }), null, `${name} was accepted`);
  }
  assert.deepEqual(peek(home), []);
});

test('langsValue drops anything that is not a plain language token', () => {
  // The failure this guards: a value that carries file or path metadata rather
  // than a language name.
  assert.equal(langsValue(['ts', 'src/secret project/auth.ts']), 'ts');
  assert.equal(langsValue(['go', 'a'.repeat(40)]), 'go');
  assert.equal(langsValue(['ts', '../../etc/passwd']), 'ts');
  assert.equal(langsValue(['ts', 'my repo']), 'ts', 'a space is not a language token');
  // Real language labels survive, including the awkward ones.
  assert.equal(langsValue(['c++', 'c#', 'objective-c', 'f#']), 'c#,c++,f#,objective-c');
});

// --- the brain signup handoff ---

test('brain signup: both events are in the contract', () => {
  assert.ok(EVENTS.brain_signup_opened);
  assert.ok(EVENTS.brain_signup_settled);
});
