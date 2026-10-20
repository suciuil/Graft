/**
 * The session rollup. Telemetry is permanently off, so a session — closed,
 * force-closed, or live — is never rolled up into an event, and its file is left
 * exactly as it was.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_IDLE_MS, flushClosedSessions, summarizeSession } from '../src/telemetry/sessions.js';
import { peek } from '../src/telemetry/queue.js';
import { patchState } from '../src/telemetry/identity.js';
import { tmpRepo } from './helpers.js';

const OPEN: NodeJS.ProcessEnv = {};

/** A repo and a home that had opted in under an older graft. */
function fixture(tag: string): { repo: string; home: string } {
  const repo = tmpRepo(tag);
  const home = tmpRepo(`${tag}-home`);
  mkdirSync(join(home, '.graft'), { recursive: true });
  mkdirSync(join(repo, 'graft', '.cache', 'session'), { recursive: true });
  process.env.GRAFT_POSTHOG_KEY = 'phc_test_key';
  patchState({ enabled: true }, home);
  return { repo, home };
}

function writeSessionFile(repo: string, id: string, body: object, ageMs: number): string {
  const path = join(repo, 'graft', '.cache', 'session', `${id}.json`);
  writeFileSync(path, JSON.stringify(body));
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
  return path;
}

test('a closed session is never rolled up, and its file is left untouched', () => {
  const { repo, home } = fixture('sess-closed');
  const path = writeSessionFile(repo, 's1', { graftReads: 56, sourceReads: 12, savedTokens: 7400 }, SESSION_IDLE_MS + 1000);
  const before = readFileSync(path, 'utf8');
  assert.equal(flushClosedSessions(repo, Date.now(), home, OPEN), 0);
  assert.equal(flushClosedSessions(repo, Date.now(), home, OPEN, 'cursor'), 0);
  assert.deepEqual(peek(home), []);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('a force-closed session (a session-end hook) records nothing either', () => {
  const { repo, home } = fixture('sess-force');
  const path = writeSessionFile(repo, 's1', { graftReads: 4, sourceReads: 1 }, 0);
  const before = readFileSync(path, 'utf8');
  assert.equal(summarizeSession(repo, 's1', { host: 'cursor', home, env: OPEN }), 0);
  assert.deepEqual(peek(home), []);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('a repo with no sessions is a no-op', () => {
  const { repo, home } = fixture('sess-none');
  assert.equal(flushClosedSessions(repo, Date.now(), home, OPEN), 0);
  assert.deepEqual(peek(home), []);
});
