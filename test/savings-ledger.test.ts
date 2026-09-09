/**
 * The lifetime savings ledger behind `graft savings`: bucketing by day and
 * model, rolling a period up, and the honesty rules the readout inherits from
 * `context/price.ts` — a measured rate where the host billed us, a labelled list
 * rate where it didn't, and tokens alone where nothing prices the model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_MODEL_ENV,
  UNKNOWN_MODEL,
  aggregateSavings,
  currentModel,
  dayKey,
  formatSavingsReport,
  isPeriod,
  readLedger,
  recordSavedTokens,
  recordTurnBilling,
  setAgentModel,
} from '../src/claude/ledger.js';
import { recordToolUse } from '../src/claude/session-metrics.js';
import { readSession } from '../src/claude/state.js';
import { sumSavingsFooters } from '../src/context/savings.js';
import { callTool } from '../src/mcp/tools.js';
import { RATE_ENV } from '../src/context/price.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-ledger-')); }

/** A built repo big enough that reading its files whole really would cost more
 * than the pack — a two-function repo has no saving to claim and so nothing to
 * record, which would pass these assertions for the wrong reason. */
function builtFixture(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(d, 'src'), { recursive: true });
  for (const name of ['math', 'stats', 'money']) {
    const body = Array.from({ length: 60 }, (_, i) =>
      `/** Add ${i} to a running ${name} total, the long way round. */\n` +
      `export function ${name}Add${i}(a: number, b: number): number {\n  return a + b + ${i};\n}\n`,
    ).join('\n');
    writeFileSync(join(d, 'src', `${name}.ts`), body);
  }
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
  return d;
}

// Both are read by the code under test; a developer box that happens to export
// either would otherwise price these fixtures at a rate the assertions don't know.
delete process.env[RATE_ENV];
delete process.env[AGENT_MODEL_ENV];

const day = (s: string) => new Date(`${s}T12:00:00`);

// ── recording ─────────────────────────────────────────────────────────────

test('savings accumulate per day and per model', () => {
  const d = fresh();
  recordSavedTokens(d, 'claude-opus-5', 1000, day('2026-09-08'));
  recordSavedTokens(d, 'claude-opus-5', 500, day('2026-09-08'));
  recordSavedTokens(d, 'claude-sonnet-5', 200, day('2026-09-08'));
  recordSavedTokens(d, 'claude-opus-5', 7, day('2026-08-01'));

  const l = readLedger(d);
  assert.equal(l.days['2026-09-08']['claude-opus-5'].savedTokens, 1500);
  assert.equal(l.days['2026-09-08']['claude-sonnet-5'].savedTokens, 200);
  assert.equal(l.days['2026-08-01']['claude-opus-5'].savedTokens, 7);
});

test('a zero or negative saving writes nothing at all', () => {
  const d = fresh();
  recordSavedTokens(d, 'claude-opus-5', 0);
  recordSavedTokens(d, 'claude-opus-5', -5);
  assert.deepEqual(readLedger(d).days, {});
});

test('an empty ledger reads as empty rather than throwing', () => {
  assert.deepEqual(readLedger(fresh()).days, {});
});

test('turn billing is recorded per model, unpriced ones named but not costed', () => {
  const d = fresh();
  recordTurnBilling(d, [
    { model: 'claude-opus-5', costMicros: 600_000, tokens: 1_000_000 },
    { model: 'some-future-model', costMicros: null, tokens: 900 },
  ], day('2026-09-08'));

  const bucket = readLedger(d).days['2026-09-08'];
  assert.equal(bucket['claude-opus-5'].costMicros, 600_000);
  assert.equal(bucket['claude-opus-5'].tokensBilled, 1_000_000);
  assert.equal(bucket['some-future-model'].costMicros, 0, 'unpriced costs nothing we can claim');
  assert.equal(bucket['some-future-model'].tokensBilled, 0, 'and buys no rate');
});

test('recordToolUse files its saving in the ledger under today', () => {
  const d = fresh();
  process.env[AGENT_MODEL_ENV] = 'claude-sonnet-5';
  try {
    recordToolUse(d, 's1', { kind: 'graft', savedTokens: 4200 });
  } finally {
    delete process.env[AGENT_MODEL_ENV];
  }
  assert.equal(readLedger(d).days[dayKey()]['claude-sonnet-5'].savedTokens, 4200);
});

test('an MCP call is left to the MCP server to file, so it is never counted twice', () => {
  const d = fresh();
  recordToolUse(d, 's1', { kind: 'graft', savedTokens: 4200, viaMcp: true });
  assert.deepEqual(readLedger(d).days, {}, 'mcp/tools.ts already filed this one');
  assert.equal(readSession(d, 's1').savedTokens, 4200, 'the session total still wants it');
});

test('an MCP call files its saving — the only path a hookless host has', async () => {
  const d = builtFixture('graft-ledger-mcp-');

  process.env[AGENT_MODEL_ENV] = 'gemini-3.8-flash';
  let res: { text: string; isError: boolean };
  try {
    res = await callTool(d, 'graft_find_code', { query: 'add two numbers to a total' });
  } finally {
    delete process.env[AGENT_MODEL_ENV];
  }

  const claimed = sumSavingsFooters(res.text);
  assert.ok(claimed > 0, 'the call printed a savings footer to record');
  assert.equal(readLedger(d).days[dayKey()]['gemini-3.8-flash'].savedTokens, claimed);
});

test('a second MCP call files its own tokens, never the first call\'s again', async () => {
  const d = builtFixture('graft-ledger-mcp2-');

  process.env[AGENT_MODEL_ENV] = 'gemini-3.8-flash';
  let both = 0;
  try {
    for (const query of ['add two numbers to a total', 'a running money total']) {
      both += sumSavingsFooters((await callTool(d, 'graft_find_code', { query })).text);
    }
  } finally {
    delete process.env[AGENT_MODEL_ENV];
  }

  assert.ok(both > 0, 'both calls printed footers to record');
  assert.equal(
    readLedger(d).days[dayKey()]['gemini-3.8-flash'].savedTokens,
    both,
    'the long-lived server must not carry call one into call two',
  );
});

test('a plain CLI query files its saving — the only path a terminal-driven host has', () => {
  const d = builtFixture('graft-ledger-cli-');

  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'ask', 'add two numbers to a total', '--source', d,
     '--agent-model', 'claude-opus-5'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const claimed = sumSavingsFooters(out);
  assert.ok(claimed > 0, 'the query printed a savings footer to record');
  assert.equal(readLedger(d).days[dayKey()]['claude-opus-5'].savedTokens, claimed);
});

// ── which model a saving belongs to ───────────────────────────────────────

test('currentModel prefers the measured stamp, then the env, then unknown', () => {
  const d = fresh();
  process.env[AGENT_MODEL_ENV] = 'claude-sonnet-5';
  try {
    assert.equal(currentModel(d, 'claude-opus-5'), 'claude-opus-5', 'what the host actually ran wins');
    assert.equal(currentModel(d, null), 'claude-sonnet-5');
    assert.equal(currentModel(d, '  '), 'claude-sonnet-5', 'a blank stamp is not a model');
  } finally {
    delete process.env[AGENT_MODEL_ENV];
  }
  assert.equal(currentModel(d), UNKNOWN_MODEL);
});

test('graft\'s own LLM-pass model never prices the agent\'s saved tokens', () => {
  const d = fresh();
  // GRAFT_MODEL names the summariser `graft build --deep` calls, which is
  // routinely neither the agent's model nor its price.
  process.env.GRAFT_MODEL = 'gemini-3.8-flash';
  try {
    assert.equal(currentModel(d), UNKNOWN_MODEL);
  } finally {
    delete process.env.GRAFT_MODEL;
  }
});

test('--agent-model outranks env and config, and a blank one clears it', () => {
  const d = fresh();
  process.env[AGENT_MODEL_ENV] = 'claude-sonnet-5';
  try {
    setAgentModel('claude-opus-5');
    assert.equal(currentModel(d), 'claude-opus-5', 'the agent naming itself on this call wins');
    assert.equal(currentModel(d, 'claude-haiku-4-5'), 'claude-haiku-4-5', 'but a measured stamp still wins');
    setAgentModel('   ');
    assert.equal(currentModel(d), 'claude-sonnet-5', 'a blank flag falls through rather than pricing nothing');
  } finally {
    setAgentModel(null);
    delete process.env[AGENT_MODEL_ENV];
  }
});

// ── period parsing ────────────────────────────────────────────────────────

test('isPeriod accepts the three documented shapes and nothing else', () => {
  for (const ok of ['2026', '2026-09', '2026-09-08', '2026-12-31']) {
    assert.equal(isPeriod(ok), true, ok);
  }
  for (const bad of ['26', '2026-13', '2026-00', '2026-09-32', '2026-9', '../api', 'yesterday', '']) {
    assert.equal(isPeriod(bad), false, bad);
  }
});

// ── rolling a period up ───────────────────────────────────────────────────

function seeded(): string {
  const d = fresh();
  recordSavedTokens(d, 'claude-opus-5', 100_000, day('2026-09-08'));
  recordTurnBilling(d, [{ model: 'claude-opus-5', costMicros: 600_000, tokens: 1_000_000 }], day('2026-09-08'));
  recordSavedTokens(d, 'claude-sonnet-5', 50_000, day('2026-08-02'));
  recordSavedTokens(d, 'claude-opus-5', 1_000, day('2025-01-05'));
  return d;
}

test('all time sums every day on record', () => {
  const r = aggregateSavings(readLedger(seeded()));
  assert.equal(r.period, null);
  assert.equal(r.days, 3);
  assert.equal(r.savedTokens, 151_000);
});

test('a year, a month and a day each narrow the same ledger', () => {
  const l = readLedger(seeded());
  assert.equal(aggregateSavings(l, '2026').savedTokens, 150_000);
  assert.equal(aggregateSavings(l, '2026-09').savedTokens, 100_000);
  assert.equal(aggregateSavings(l, '2026-09-08').savedTokens, 100_000);
  assert.equal(aggregateSavings(l, '2026-08').savedTokens, 50_000);
  assert.equal(aggregateSavings(l, '2024').models.length, 0, 'a period with no history is empty, not zeroed');
});

test('a billed model is priced at the rate it was actually billed', () => {
  // $0.60/Mtok measured, an order of magnitude under this model's $5 list price.
  const r = aggregateSavings(readLedger(seeded()), '2026-09');
  const opus = r.models.find((m) => m.model === 'claude-opus-5')!;
  assert.equal(opus.value!.measured, true);
  assert.ok(Math.abs(opus.value!.usd - 0.06) < 1e-9);
});

test('an unbilled model falls back to its list price, marked as such', () => {
  const r = aggregateSavings(readLedger(seeded()), '2026-08');
  const sonnet = r.models.find((m) => m.model === 'claude-sonnet-5')!;
  assert.equal(sonnet.value!.measured, false);
  assert.ok(Math.abs(sonnet.value!.usd - 0.1) < 1e-9, '50k tokens at $2/Mtok');
  assert.equal(r.measured, false, 'the total inherits the caveat');
});

test('a model with no price is counted in tokens and left out of the dollars', () => {
  const d = fresh();
  recordSavedTokens(d, 'claude-sonnet-5', 50_000, day('2026-09-08'));
  recordSavedTokens(d, UNKNOWN_MODEL, 30_000, day('2026-09-08'));
  const r = aggregateSavings(readLedger(d));
  assert.equal(r.savedTokens, 80_000);
  assert.equal(r.unpricedTokens, 30_000);
  assert.ok(Math.abs(r.usd! - 0.1) < 1e-9, 'only the priced half is money');
});

test('nothing priced at all yields no dollar figure rather than zero', () => {
  const d = fresh();
  recordSavedTokens(d, UNKNOWN_MODEL, 30_000, day('2026-09-08'));
  const r = aggregateSavings(readLedger(d));
  assert.equal(r.usd, null);
  assert.equal(r.savedTokens, 30_000);
});

// ── the readout ───────────────────────────────────────────────────────────

test('the report lists every model, the total, and the list-rate caveat', () => {
  const out = formatSavingsReport(aggregateSavings(readLedger(seeded())));
  assert.match(out, /all time · 3 days recorded/);
  assert.match(out, /claude-opus-5\s+~101,000 tokens/);
  assert.match(out, /claude-sonnet-5\s+~50,000 tokens\s+~\$0\.10\s+\(list rate\)/);
  assert.match(out, /total\s+~151,000 tokens/);
});

test('the report names the period it was asked for', () => {
  const out = formatSavingsReport(aggregateSavings(readLedger(seeded()), '2026-09'));
  assert.match(out, /graft savings — 2026-09 · 1 day recorded/);
});

test('an unpriced model is labelled and excluded from the total dollars', () => {
  const d = fresh();
  recordSavedTokens(d, 'claude-sonnet-5', 50_000, day('2026-09-08'));
  recordSavedTokens(d, UNKNOWN_MODEL, 30_000, day('2026-09-08'));
  const out = formatSavingsReport(aggregateSavings(readLedger(d)));
  assert.match(out, /unknown\s+~30,000 tokens\s+\(no rate — tokens only\)/);
  assert.match(out, /total\s+~80,000 tokens\s+~\$0\.10\s+\(excludes ~30,000 unpriced tokens\)/);
});

test('the empty states say which kind of empty it is', () => {
  const d = fresh();
  assert.match(formatSavingsReport(aggregateSavings(readLedger(d))), /nothing recorded yet/);
  assert.match(
    formatSavingsReport(aggregateSavings(readLedger(d), '2026-01')),
    /2026-01: nothing recorded in that period/,
  );
});
