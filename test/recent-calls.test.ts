/**
 * The recent-calls log behind `graft savings --last` and the short savings
 * nudge, plus the stderr copy of the savings line for a piped stdout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  TURN_GAP_MS,
  calledRecently,
  formatLastCalls,
  lastTurnCalls,
  readRecentCalls,
  recentCallsPath,
  recordRecentCall,
  summedTally,
  type RecentCall,
} from '../src/context/recent-calls.js';
import {
  claimedSummary,
  resetClaimedSavings,
  savingsLine,
  setCompactNudge,
  setDeepDue,
  setPricing,
  stderrSavingsCopy,
  sumSavingsFooters,
  tallyWarnings,
} from '../src/context/savings.js';
import { NO_MODEL, pricingFor, type AgentModel } from '../src/context/price.js';
import { hasSavingsTally } from '../src/claude/tally.js';
import { runCli } from './helpers.js';

const certain = (id: string, label?: string): AgentModel => ({ id, confidence: 'certain', label });

/** Pin the local price catalog to an empty one (same reason as savings.test.ts). */
const pricesFile = join(mkdtempSync(join(tmpdir(), 'graft-recent-prices-')), 'prices.json');
writeFileSync(pricesFile, JSON.stringify({ version: 1, source: 'LiteLLM', url: 'x', fetchedAt: new Date().toISOString(), models: {} }));
process.env.GRAFT_PRICES_FILE = pricesFile;

/** A 1,900-token saving: 100 tokens of output against a 2,000-token baseline. */
function footer(): string {
  return savingsLine('x'.repeat(400), { files: 2, baselineChars: 8000 });
}

function repo(): string {
  return mkdtempSync(join(tmpdir(), 'graft-recent-'));
}

const call = (at: string, tokens: number, extra: Partial<RecentCall> = {}): RecentCall => ({
  at,
  command: 'ask',
  tokens,
  usd: null,
  model: null,
  ...extra,
});

test('recordRecentCall keeps calls in order and skips ones that claimed nothing', () => {
  const dir = repo();
  const t0 = new Date('2026-10-23T10:00:00Z');
  recordRecentCall(dir, { command: 'ask', tokens: 1200, usd: 0.01, model: 'Claude Opus 5' }, t0);
  recordRecentCall(dir, { command: 'grep', tokens: 0, usd: null, model: null }, new Date(t0.getTime() + 1000));
  recordRecentCall(dir, { command: 'skeleton', tokens: 300, usd: 0.002, model: 'Claude Opus 5' }, new Date(t0.getTime() + 2000));
  assert.deepEqual(readRecentCalls(dir).map((c) => c.command), ['ask', 'skeleton']);
});

test('readRecentCalls survives a missing or malformed file', () => {
  const dir = repo();
  assert.deepEqual(readRecentCalls(dir), []);
  const p = recentCallsPath(dir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '{not json');
  assert.deepEqual(readRecentCalls(dir), []);
  writeFileSync(p, JSON.stringify({ calls: [{ at: 'nope', tokens: 5 }, { at: new Date().toISOString(), tokens: -1 }] }));
  assert.deepEqual(readRecentCalls(dir), []);
});

test('calledRecently is true only within the turn gap', () => {
  const dir = repo();
  const t0 = new Date('2026-10-23T10:00:00Z');
  assert.equal(calledRecently(dir, t0), false, 'nothing on record');
  recordRecentCall(dir, { command: 'ask', tokens: 100, usd: null, model: null }, t0);
  assert.equal(calledRecently(dir, new Date(t0.getTime() + 60_000)), true);
  assert.equal(calledRecently(dir, new Date(t0.getTime() + TURN_GAP_MS + 1)), false);
});

test('lastTurnCalls takes the newest run of calls, split at a long gap', () => {
  const calls = [
    call('2026-10-23T09:00:00Z', 10),
    call('2026-10-23T10:00:00Z', 20),
    call('2026-10-23T10:03:00Z', 30),
    call('2026-10-23T10:09:00Z', 40),
  ];
  assert.deepEqual(lastTurnCalls(calls).map((c) => c.tokens), [20, 30, 40]);
  assert.deepEqual(lastTurnCalls([]), []);
});

test('summedTally: one model, all priced -> tokens and dollars for that model', () => {
  const t = summedTally([
    call('2026-10-23T10:00:00Z', 1000, { usd: 0.25, model: 'Claude Opus 5' }),
    call('2026-10-23T10:01:00Z', 2000, { usd: 0.5, model: 'Claude Opus 5' }),
  ]);
  assert.equal(t, '\u{1F331} graft saved ~3,000 tokens (~$0.75 for Claude Opus 5) this turn');
  assert.ok(hasSavingsTally(t), 'the reported-turns metric still recognises it');
});

test('summedTally: a mix of priced and unpriced calls -> tokens only, never a partial dollar sum', () => {
  const t = summedTally([
    call('2026-10-23T10:00:00Z', 1000, { usd: 0.25, model: 'Claude Opus 5' }),
    call('2026-10-23T10:01:00Z', 2000),
  ]);
  assert.equal(t, '\u{1F331} graft saved ~3,000 tokens by this turn');
});

test("summedTally carries the newest call's warning lines under it", () => {
  const warn = "  \n\u26A0\uFE0F Run the 'graft build --deep' command \u2014 recommended (no summaries yet)";
  const t = summedTally([call('2026-10-23T10:00:00Z', 1000, { warnings: warn })]);
  assert.ok(t.endsWith(warn));
});

test('formatLastCalls lists the turn and ends with the tally; says so plainly when empty', () => {
  const now = new Date('2026-10-23T10:05:00Z');
  const out = formatLastCalls([call('2026-10-23T10:04:00Z', 1500, { usd: 0.02, model: 'Claude Opus 5', command: 'grep' })], now);
  assert.match(out, /calls this turn \(1; the newest 1 min ago\)/);
  assert.match(out, /grep\s+~1,500 tokens \(\$0\.02 for Claude Opus 5\)/);
  assert.ok(out.trimEnd().endsWith('\u{1F331} graft saved ~1,500 tokens (~$0.02 for Claude Opus 5) this turn'));
  const none = formatLastCalls([], now);
  assert.match(none, /no recent calls/);
  assert.ok(!hasSavingsTally(none), 'no figure is ever invented');
});

test('compact nudge: keeps the figure, the dollar value and the example, drops the paragraph', () => {
  setPricing(pricingFor(certain('claude-opus-5', 'Claude Opus 5')));
  const full = footer();
  setCompactNudge(true);
  const short = footer();
  setCompactNudge(false);
  assert.ok(short.length < full.length * 0.6, `short form is much shorter (${short.length} vs ${full.length})`);
  assert.match(short, /^\[graft\] tokens saved \u2248 1,900/);
  assert.equal(sumSavingsFooters(short), 1900, 'the accumulator still counts it exactly once');
  assert.match(short, /Worth <?\$/);
  assert.match(short, /\u{1F331} graft saved ~N tokens \(~\$X for Claude Opus 5\) this turn\.$/u);
  assert.doesNotMatch(short, /At the end of your reply/);
  resetClaimedSavings();
  setPricing(null);
});

test('compact nudge keeps the warning lines in the example', () => {
  setPricing(pricingFor(NO_MODEL));
  setDeepDue('no summaries yet');
  setCompactNudge(true);
  const short = footer();
  setCompactNudge(false);
  setDeepDue(null);
  assert.match(short, /\u{1F331} graft saved ~N tokens by this turn  \n\u26A0\uFE0F Run the 'graft build --deep' command/u);
  resetClaimedSavings();
  setPricing(null);
});

test('claimedSummary and tallyWarnings describe what the footers claimed', () => {
  resetClaimedSavings();
  setPricing(pricingFor(certain('claude-opus-5', 'Claude Opus 5')));
  footer();
  const s = claimedSummary();
  assert.equal(s.tokens, 1900);
  assert.equal(s.model, 'Claude Opus 5');
  assert.ok(s.usd !== null && s.usd > 0);
  assert.equal(tallyWarnings(), '');
  resetClaimedSavings();
  setPricing(null);
});

test("stderrSavingsCopy: never in the accumulator's footer shape, so a merged stream counts the call once", () => {
  resetClaimedSavings();
  assert.equal(stderrSavingsCopy(), '', 'nothing claimed, nothing repeated');
  setPricing(pricingFor(certain('claude-opus-5', 'Claude Opus 5')));
  const f = footer();
  const copy = stderrSavingsCopy();
  assert.match(copy, /~1,900 tokens, worth <?\$/);
  assert.equal(sumSavingsFooters(copy), 0);
  assert.equal(sumSavingsFooters(`${f}\n${copy}`), 1900);
  assert.match(copy, /\u{1F331} graft saved ~N tokens \(~\$X for Claude Opus 5\) this turn/u);
  resetClaimedSavings();
  setPricing(null);
});

test("graft savings --last prints the latest turn and the tally from the repo's log", () => {
  const dir = repo();
  mkdirSync(join(dir, 'graft'), { recursive: true });
  const now = Date.now();
  recordRecentCall(dir, { command: 'ask', tokens: 4000, usd: 0.02, model: 'Claude Opus 5' }, new Date(now - 60_000));
  recordRecentCall(dir, { command: 'grep', tokens: 1000, usd: 0.005, model: 'Claude Opus 5' }, new Date(now - 30_000));
  const r = runCli(['savings', '--last', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /calls this turn \(2;/);
  assert.match(r.stdout, /\u{1F331} graft saved ~5,000 tokens \(~\$0\.03 for Claude Opus 5\) this turn/u);
  const j = runCli(['savings', '--last', '--json', dir]);
  assert.equal(j.status, 0, j.stderr);
  const parsed = JSON.parse(j.stdout);
  assert.equal(parsed.calls.length, 2);
  assert.match(parsed.tally, /~5,000 tokens/);
  const bad = runCli(['savings', '--last', '2026', dir]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--last takes no period/);
});
