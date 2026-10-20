/**
 * The disclosure. Every telemetry backlash in the tools this design was drawn
 * from was about a tool that started sending without saying so, which makes
 * these the tests that protect the project rather than the user's data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstRunNotice, formatDebug, formatStatus } from '../src/telemetry/notice.js';
import { buildBatch } from '../src/telemetry/send.js';
import { enqueue } from '../src/telemetry/queue.js';
import { readState } from '../src/telemetry/identity.js';
import { tmpRepo } from './helpers.js';

/**
 * An env with every gate open. Passed explicitly rather than mutating
 * `process.env`: this suite runs in CI, where `GITHUB_ACTIONS` alone is enough
 * to suppress the notice — which is the correct product behaviour, and exactly
 * what a test of the notice must not be subject to.
 */
const OPEN: NodeJS.ProcessEnv = {};

/** A home whose user had opted in under an older graft, unless `state` says otherwise. */
function home(tag: string, state?: Record<string, unknown>): string {
  const dir = tmpRepo(tag);
  mkdirSync(join(dir, '.graft'), { recursive: true });
  if (state) writeFileSync(join(dir, '.graft', 'telemetry.json'), JSON.stringify({ enabled: true, ...state }));
  process.env.GRAFT_POSTHOG_KEY = 'phc_test_key';
  return dir;
}

test('no notice is ever printed: telemetry is permanently off, so there is nothing to disclose', () => {
  for (const state of [undefined, { installId: 'x' }, { installId: 'x', enabled: false }]) {
    const h = home('notice-never', state);
    for (const env of [OPEN, { CI: 'true' }, { DO_NOT_TRACK: '1' }] as NodeJS.ProcessEnv[]) {
      assert.equal(firstRunNotice(h, env), null);
    }
    assert.equal(readState(h)?.noticeShownAt, undefined);
  }
});

test('status says it is permanently off, offers no way to enable it, and never prints the key', () => {
  const h = home('notice-status', { installId: 'x' });
  enqueue({ event: 'query' }, h); // left over from an older graft: still never sent
  const out = formatStatus(h, OPEN);
  assert.match(out, /^telemetry: off — telemetry is permanently disabled .* cannot be turned on/);
  assert.doesNotMatch(out, /graft telemetry enable|graft telemetry disable/);
  assert.match(out, /graft telemetry debug/);
  assert.equal(out.includes('phc_test_key'), false);
});

test('debug prints the exact batch and sends nothing', () => {
  const h = home('notice-debug', { installId: 'x' });
  enqueue({ event: 'query', properties: { command: 'ask' }, distinct_id: 'abc', timestamp: '2026-01-01T00:00:00Z' }, h);
  const out = formatDebug(h);
  assert.match(out, /sends nothing/);
  const body = JSON.parse(out.slice(out.indexOf('{')));
  assert.equal(body.batch.length, 1);
  assert.equal(body.batch[0].event, 'query');
  assert.equal(body.batch[0].properties.$process_person_profile, false, 'anonymous event');
  assert.equal(body.batch[0].properties.distinct_id, 'abc');
});

test('debug never prints the project key — this output is written to be pasted into an issue', () => {
  const h = home('notice-debug-key', { installId: 'x' });
  process.env.GRAFT_POSTHOG_KEY = 'phc_do_not_print_me';
  enqueue({ event: 'query', properties: { command: 'ask' }, distinct_id: 'abc' }, h);
  const out = formatDebug(h);
  assert.equal(out.includes('phc_do_not_print_me'), false, 'the ingestion key leaked into terminal output');
  // The field is still shown, so the output is an honest picture of the request.
  assert.match(out, /"api_key": "<omitted/);
});

test('buildBatch itself carries no key, so no logging path can reach one', () => {
  process.env.GRAFT_POSTHOG_KEY = 'phc_do_not_print_me';
  const batch = buildBatch([{ event: 'query', properties: {}, distinct_id: 'abc' }]);
  assert.equal('api_key' in batch, false);
  assert.equal(JSON.stringify(batch).includes('phc_do_not_print_me'), false);
});

test('status prints the endpoint but never the key', () => {
  const h = home('notice-status-key', { installId: 'x' });
  process.env.GRAFT_POSTHOG_KEY = 'phc_do_not_print_me';
  assert.equal(formatStatus(h, OPEN).includes('phc_do_not_print_me'), false);
});

test('debug on an empty queue explains rather than printing an empty batch', () => {
  assert.match(formatDebug(home('notice-debug-empty', { installId: 'x' })), /nothing queued/);
});
