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
  agentModel,
  aggregateSavings,
  currentModel,
  dayKey,
  formatSavingsReport,
  isPeriod,
  readLedger,
  recordSavedTokens,
  recordTurnBilling,
  resolveModel,
  setAgentModel,
  setHostModel,
} from '../src/claude/ledger.js';
import { writeBuildConfig } from '../src/util/state.js';
import { recordToolUse } from '../src/claude/session-metrics.js';
import { readSession } from '../src/claude/state.js';
import { sumSavingsFooters } from '../src/context/savings.js';
import { callTool } from '../src/mcp/tools.js';

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

// Neither is read by the pricing code any more, but a developer box exporting
// one should not be able to influence these fixtures either way.
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

test('the provider routing prefix is stripped before filing', () => {
  // The prefix names who SERVES the model, not which model it is. Keeping it
  // would split one model's lifetime total across every gateway it was reached
  // through — three rows that never add up to the answer the user wants.
  const d = fresh();
  recordSavedTokens(d, 'vertex_ai/claude-opus-5', 100, day('2026-09-08'));
  recordSavedTokens(d, 'anthropic/claude-opus-5', 200, day('2026-09-08'));
  recordSavedTokens(d, 'claude-opus-5', 300, day('2026-09-08'));
  recordSavedTokens(d, 'azure/eastus/gpt-5.6-luna', 7, day('2026-09-08'));

  const bucket = readLedger(d).days['2026-09-08'];
  // Keys are canonical: the routing prefix is gone and the version separator is
  // folded to `-`, so one model is one row however it was spelled.
  assert.deepEqual(Object.keys(bucket).sort(), ['claude-opus-5', 'gpt-5-6-luna']);
  assert.equal(bucket['claude-opus-5'].savedTokens, 600, 'three routes, one row');
  assert.equal(bucket['gpt-5-6-luna'].savedTokens, 7, 'a multi-segment route is stripped whole');
});

test('one model spelled two ways is one row, not two', () => {
  // The field bug, exactly as it appeared in a real `graft savings`:
  //   gemini-3.7-flash   ~863,871 tokens   ~$0.65
  //   gemini-3-7-flash   ~717,427 tokens   ~$0.54
  // Same model, two rows, two dollar figures. The spellings arrive from
  // different sources, so no single writer could be fixed — the key had to stop
  // telling them apart.
  const d = fresh();
  recordSavedTokens(d, 'gemini-3.7-flash', 100, day('2026-09-08'));
  recordSavedTokens(d, 'gemini-3-7-flash', 200, day('2026-09-08'));
  recordSavedTokens(d, 'Gemini-3.7-Flash', 300, day('2026-09-08'));

  const bucket = readLedger(d).days['2026-09-08'];
  assert.deepEqual(Object.keys(bucket), ['gemini-3-7-flash'], 'one key for one model');
  assert.equal(bucket['gemini-3-7-flash'].savedTokens, 600);
  // ...and a genuinely different model still gets its own row.
  recordSavedTokens(d, 'gemini-3.8-flash', 50, day('2026-09-08'));
  assert.deepEqual(Object.keys(readLedger(d).days['2026-09-08']).sort(), ['gemini-3-7-flash', 'gemini-3-8-flash']);
});

test('a ledger already split across spellings is merged when it is read', () => {
  // Fixing only the write path would leave every existing ledger permanently
  // split: the rows are historical facts and nothing rewrites them. So the
  // report canonicalises as it aggregates.
  const report = aggregateSavings({
    days: {
      '2026-09-14': {
        'gemini-3.7-flash': { savedTokens: 863_871, costMicros: 0, tokensBilled: 0 },
        'gemini-3-7-flash': { savedTokens: 717_427, costMicros: 0, tokensBilled: 0 },
        unknown: { savedTokens: 1_000, costMicros: 0, tokensBilled: 0 },
      },
    },
  });
  const gemini = report.models.filter((m) => m.model.startsWith('gemini'));
  assert.equal(gemini.length, 1, 'one row for the one model that ran');
  assert.equal(gemini[0].savedTokens, 863_871 + 717_427);
  // The unknown sentinel is not a model id and must never be folded into one.
  assert.ok(report.models.some((m) => m.model === UNKNOWN_MODEL));
});

test('billing is filed under the same stripped key as the savings', () => {
  // Both writers go through one funnel, so a turn billed via a gateway lands in
  // the same row as the tokens that turn saved — otherwise the measured rate
  // would never find its own savings.
  const d = fresh();
  recordSavedTokens(d, 'vertex_ai/claude-opus-5', 100_000, day('2026-09-08'));
  recordTurnBilling(d, [{ model: 'anthropic/claude-opus-5', costMicros: 600_000, tokens: 1_000_000 }], day('2026-09-08'));

  const bucket = readLedger(d).days['2026-09-08'];
  assert.deepEqual(Object.keys(bucket), ['claude-opus-5']);
  assert.equal(bucket['claude-opus-5'].savedTokens, 100_000);
  assert.equal(bucket['claude-opus-5'].costMicros, 600_000);
});

test('a model that normalises to nothing is filed as unknown, not as ""', () => {
  const d = fresh();
  recordSavedTokens(d, '   ', 50, day('2026-09-08'));
  recordSavedTokens(d, '/', 50, day('2026-09-08'));
  assert.deepEqual(Object.keys(readLedger(d).days['2026-09-08']), [UNKNOWN_MODEL]);
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
  setAgentModel('claude-sonnet-5');
  try {
    recordToolUse(d, 's1', { kind: 'graft', savedTokens: 4200 });
  } finally {
    setAgentModel(null);
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
  // MCP names no model: nothing stamps one and no flag can be passed. The
  // saving is still FILED — under the unknown-model bucket, where it is
  // reported in tokens and never priced.
  const res = await callTool(d, 'graft_find_code', { query: 'add two numbers to a total' });

  const claimed = sumSavingsFooters(res.text);
  assert.ok(claimed > 0, 'the call printed a savings footer to record');
  assert.equal(readLedger(d).days[dayKey()][UNKNOWN_MODEL].savedTokens, claimed);
});

test('a second MCP call files its own tokens, never the first call\'s again', async () => {
  const d = builtFixture('graft-ledger-mcp2-');

  let both = 0;
  for (const query of ['add two numbers to a total', 'a running money total']) {
    both += sumSavingsFooters((await callTool(d, 'graft_find_code', { query })).text);
  }

  assert.ok(both > 0, 'both calls printed footers to record');
  assert.equal(
    readLedger(d).days[dayKey()][UNKNOWN_MODEL].savedTokens,
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

test('currentModel prefers the measured stamp, then the flag, then unknown', () => {
  const d = fresh();
  setAgentModel('claude-sonnet-5');
  try {
    assert.equal(currentModel(d, 'claude-opus-5'), 'claude-opus-5', 'what the host actually ran wins');
    assert.equal(currentModel(d, null), 'claude-sonnet-5');
    assert.equal(currentModel(d, '  '), 'claude-sonnet-5', 'a blank stamp is not a model');
  } finally {
    setAgentModel(null);
  }
  assert.equal(currentModel(d), UNKNOWN_MODEL);
});

test('neither GRAFT_AGENT_MODEL nor a config `model` names the model any more', () => {
  // Both were standing declarations that outlived the session justifying them.
  // Only the agent naming itself, per call, counts now.
  const d = fresh();
  writeBuildConfig(d, { model: 'claude-opus-5' } as Record<string, unknown>);
  process.env[AGENT_MODEL_ENV] = 'claude-sonnet-5';
  try {
    assert.equal(currentModel(d), UNKNOWN_MODEL, 'neither source names a model');
  } finally {
    delete process.env[AGENT_MODEL_ENV];
  }
});

test('agentModel reports how sure we are, which is what pricing branches on', () => {
  const d = fresh();
  assert.deepEqual(agentModel(d, 'claude-opus-5'), { id: 'claude-opus-5', confidence: 'certain' },
    'a transcript stamp is the model that ran');

  setAgentModel('claude-opus-5');
  try {
    assert.deepEqual(agentModel(d), { id: 'claude-opus-5', confidence: 'certain' },
      'so is the agent naming itself on this call');
  } finally {
    setAgentModel(null);
  }

  assert.deepEqual(agentModel(fresh()), { id: null, confidence: 'unknown' });
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

test('--agent-model names the model, and a blank one clears it', () => {
  const d = fresh();
  try {
    setAgentModel('claude-opus-5');
    assert.equal(currentModel(d), 'claude-opus-5', 'the agent naming itself on this call');
    assert.equal(currentModel(d, 'claude-haiku-4-5'), 'claude-haiku-4-5', 'but a measured stamp still wins');
    setAgentModel('   ');
    assert.equal(currentModel(d), UNKNOWN_MODEL, 'a blank flag names nothing rather than pricing a blank');
  } finally {
    setAgentModel(null);
  }
});

test('the host\'s session record names the model when the agent did not', () => {
  // The gap this closes: over MCP the agent is asked to name itself on every
  // call and mostly does not, so the saving was filed as `unknown`. A host that
  // records the running model per session can answer instead.
  const d = fresh();
  try {
    setHostModel('gemini-3.8-flash');
    assert.equal(currentModel(d), 'gemini-3.8-flash');
    assert.deepEqual(agentModel(d), { id: 'gemini-3.8-flash', confidence: 'certain' },
      'the host describing its own live session is a fact about this turn, not a guess');
    setHostModel('  ');
    assert.equal(currentModel(d), UNKNOWN_MODEL, 'a blank record names nothing');
  } finally {
    setHostModel(null);
  }
});

test('what the agent says outranks what the host recorded', () => {
  // Deliberate precedence: the agent's word is scoped to THIS call, while the
  // host record is matched on a directory and cannot tell two sessions in one
  // directory apart. A cooperating agent must be unaffected by the fallback.
  const d = fresh();
  try {
    setHostModel('gemini-3.8-flash');
    setAgentModel('claude-opus-5');
    assert.equal(currentModel(d), 'claude-opus-5');
    // ...and a transcript stamp still beats both.
    assert.equal(currentModel(d, 'claude-haiku-4-5'), 'claude-haiku-4-5');
  } finally {
    setAgentModel(null);
    setHostModel(null);
  }
});

test('a router-mode agent reporting its family is refined by the host record', () => {
  // The field case: Copilot on "Auto" does not know which model it is, so it
  // answered `--agent-model gpt-5` for a turn VS Code recorded as
  // `gpt-5.6-luna`. Taking the agent's word filed the saving under `gpt-5` and
  // priced it at $1.25/Mtok against the real $0.20 — 6x over, and indexed under
  // a model that never ran.
  const d = fresh();
  try {
    setAgentModel('gpt-5');
    setHostModel('gpt-5.6-luna');
    assert.equal(currentModel(d), 'gpt-5.6-luna', 'the same claim, one decimal place better');
    assert.equal(resolveModel(d).source, 'host');
  } finally {
    setAgentModel(null);
    setHostModel(null);
  }
});

test('a genuinely different host model never overrides the agent', () => {
  // The line the refinement must not cross. Two DIFFERENT models is a real
  // conflict, not a precision difference, and there the agent is the better
  // authority on its own call — the host record is matched on a directory and
  // cannot tell two sessions apart.
  const d = fresh();
  try {
    setAgentModel('claude-opus-5');
    setHostModel('gemini-3.8-flash');
    assert.equal(currentModel(d), 'claude-opus-5');
    assert.equal(resolveModel(d).source, 'flag');
    // Nor does a SHORTER host record replace a more specific agent report: the
    // agent knowing exactly what it is beats the host knowing only the family.
    setAgentModel('gpt-5.6-luna');
    setHostModel('gpt-5');
    assert.equal(currentModel(d), 'gpt-5.6-luna');
  } finally {
    setAgentModel(null);
    setHostModel(null);
  }
});

test('resolveModel reports which of the three sources answered', () => {
  // The source travels with the model because the surfaces word themselves
  // differently per source; a silent reshuffle of this order would be invisible.
  const d = fresh();
  try {
    assert.equal(resolveModel(d).source, 'none');
    setHostModel('gemini-3.8-flash');
    assert.equal(resolveModel(d).source, 'host');
    setAgentModel('claude-opus-5');
    assert.equal(resolveModel(d).source, 'flag');
    assert.equal(resolveModel(d, 'claude-haiku-4-5').source, 'stamped');
  } finally {
    setAgentModel(null);
    setHostModel(null);
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
