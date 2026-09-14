/**
 * Which MCP client is connected, and the one behaviour that turns on it: the
 * per-model savings table.
 *
 * The table prices a saving under every model a host offers, read from that
 * host's own configuration — and graft can only read Kilo Code's config shapes.
 * Shown to any other host it would be a price list for models that host cannot
 * run, which is why identity is captured at the handshake rather than inferred
 * from a config file happening to exist on the machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isKiloClient, mcpClient, setMcpClient } from '../src/mcp/client.js';
import { TOOLS, callTool } from '../src/mcp/tools.js';
import { UNKNOWN_MODEL, dayKey, readLedger, setAgentModel } from '../src/claude/ledger.js';
import { sumSavingsFooters } from '../src/context/savings.js';
import { kiloModelRows } from '../src/hosts/models.js';
import { tmpRepo } from './helpers.js';

test('the client name is whatever the handshake reported, or null', () => {
  setMcpClient(undefined);
  assert.equal(mcpClient(), null, 'no handshake yet');

  setMcpClient('Kilo Code');
  assert.equal(mcpClient(), 'Kilo Code');

  // A client that introduces itself as nothing has told us nothing.
  setMcpClient('   ');
  assert.equal(mcpClient(), null, 'blank is not a name');
  setMcpClient(42);
  assert.equal(mcpClient(), null, 'a non-string is not a name');
  setMcpClient(undefined);
});

test('Kilo is recognised across the spellings it has shipped under', () => {
  for (const name of ['Kilo Code', 'kilocode', 'kilo-code', 'Kilo_Code', 'kilo code (vscode)']) {
    setMcpClient(name);
    assert.equal(isKiloClient(), true, name);
  }
  setMcpClient(undefined);
});

test('every other client — and no client at all — is not Kilo', () => {
  // The hosts that reach graft over MCP but whose model lists graft cannot read.
  // Each must fall through to a bare token count, never to Kilo's price list.
  for (const name of ['Cursor', 'Codex', 'Windsurf', 'Kiro', 'Antigravity', 'AdaL', 'claude-ai']) {
    setMcpClient(name);
    assert.equal(isKiloClient(), false, name);
  }
  setMcpClient(undefined);
  assert.equal(isKiloClient(), false, 'the CLI, which performs no handshake');
});

test('"Kiro" is not mistaken for "Kilo" — one letter apart, different hosts', () => {
  // The substring match is deliberately loose; this is the collision it must
  // still not make.
  setMcpClient('Kiro');
  assert.equal(isKiloClient(), false);
  setMcpClient(undefined);
});

test('the Kilo rows callback reads the config lazily, and only once', () => {
  const home = tmpRepo('kilo-rows');
  mkdirSync(join(home, '.config', 'kilo'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'kilo', 'kilo.jsonc'),
    JSON.stringify({ provider: { a: { models: { 'claude-opus-5': { name: 'Claude Opus 5' } } } } }),
  );

  // Building the callback must not touch the disk: most retrievals ARE priced
  // and never reach the unpriced branch at all.
  const rows = kiloModelRows({ home });
  assert.equal(typeof rows, 'function');

  assert.deepEqual(rows(1_000_000), [{ label: 'Claude Opus 5', value: '$5.00' }]);
  // Re-priced from the memoised config rather than re-read.
  assert.deepEqual(rows(2_000_000), [{ label: 'Claude Opus 5', value: '$10.00' }]);
});

test('the Kilo rows callback yields nothing when there is no Kilo config', () => {
  const rows = kiloModelRows({ home: tmpRepo('kilo-rows-empty') });
  assert.deepEqual(rows(1_000_000), [], 'no config, no table — never an empty box');
});

// ── the gate, through the real dispatch ───────────────────────────────────

/** A built repo big enough that a retrieval really does save tokens — a tiny
 * one claims nothing, and would pass these assertions for the wrong reason. */
function builtFixture(prefix: string): string {
  const d = tmpRepo(prefix);
  mkdirSync(join(d, 'src'), { recursive: true });
  for (const name of ['math', 'stats']) {
    writeFileSync(
      join(d, 'src', `${name}.ts`),
      Array.from({ length: 60 }, (_, i) =>
        `/** Add ${i} to a running ${name} total, the long way round. */\n` +
        `export function ${name}Add${i}(a: number, b: number): number {\n  return a + b + ${i};\n}\n`,
      ).join('\n'),
    );
  }
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
  return d;
}

test('a non-Kilo MCP client gets no table, even with Kilo installed on the box', async () => {
  // The leak this gate exists to close. `callTool` reads the REAL home, so a
  // developer machine with a Kilo config was feeding Kilo's model list into
  // every other host's session.
  const d = builtFixture('graft-mcp-cursor-');
  setMcpClient('Cursor');
  try {
    const res = await callTool(d, 'graft_find_code', { query: 'add two numbers to a total' });
    assert.doesNotMatch(res.text, /as estimated below/, 'no table for a host graft cannot read');
    assert.doesNotMatch(res.text, /\+-+\+/, 'and no box drawn from somebody else’s models');
    assert.match(res.text, /graft saved ~N tokens by this turn"/, 'a bare token count instead');
    // And not pointed at `--agent-model`: that is a CLI flag, and this surface
    // has no equivalent parameter to pass it through.
    assert.doesNotMatch(res.text, /--agent-model/);
  } finally {
    setMcpClient(undefined);
  }
});

test('every tool accepts a `model` argument — MCP has no --agent-model', () => {
  // Applied centrally rather than written into each schema, so a tool added
  // later cannot quietly miss the one property that must be on all of them.
  for (const tool of TOOLS) {
    const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok('model' in props, `${tool.name} must accept a model`);
    const required = (tool.inputSchema as { required?: string[] }).required ?? [];
    assert.ok(!required.includes('model'), `${tool.name}: model stays optional`);
  }
});

test('a model sent with the call is priced, and filed under that model', async () => {
  // The whole point: over MCP nothing else can name the model, so without this
  // argument a Kilo session's savings accumulate in the ledger as `unknown`.
  const d = builtFixture('graft-mcp-modelarg-');
  setMcpClient('Kilo Code');
  try {
    const res = await callTool(d, 'graft_find_code', {
      query: 'add two numbers to a total',
      model: 'vertex_ai/claude-opus-5',
    });
    // One exact figure, named with the host's display name...
    assert.match(res.text, /\(~\$X for Claude Opus 5\) this turn/);
    // ...and no table: a menu of alternatives is strictly worse than an answer.
    assert.doesNotMatch(res.text, /as estimated below/);
    // Filed under the real model rather than the unknown bucket — and under the
    // bare id, with the `vertex_ai/` gateway prefix stripped, so the same model
    // reached through another provider adds to this row instead of starting one.
    const day = readLedger(d).days[dayKey()];
    assert.ok(day['claude-opus-5']?.savedTokens > 0, 'recorded against the model');
    assert.equal(day['vertex_ai/claude-opus-5'], undefined, 'never keyed by the route');
    assert.equal(day[UNKNOWN_MODEL], undefined, 'and nothing left unattributed');
  } finally {
    setAgentModel(null);
    setMcpClient(undefined);
  }
});

test('omitting the model still files the saving, as unknown, with the table', async () => {
  const d = builtFixture('graft-mcp-nomodelarg-');
  setMcpClient('Kilo Code');
  try {
    const res = await callTool(d, 'graft_find_code', { query: 'add two numbers to a total' });
    assert.match(res.text, /as estimated below/, 'the fallback table');
    assert.ok(readLedger(d).days[dayKey()][UNKNOWN_MODEL]?.savedTokens > 0);
  } finally {
    setAgentModel(null);
    setMcpClient(undefined);
  }
});

test('a blank or non-string model is ignored rather than filed as a model', async () => {
  // A host that interpolates an empty variable into the argument must fall
  // through to "unknown", not create a ledger row keyed on the empty string.
  const d = builtFixture('graft-mcp-blankmodel-');
  setMcpClient('Cursor');
  try {
    await callTool(d, 'graft_find_code', { query: 'add two numbers to a total', model: '   ' });
    const day = readLedger(d).days[dayKey()];
    assert.ok(day[UNKNOWN_MODEL]?.savedTokens > 0);
    assert.equal(day[''], undefined, 'no empty-string model row');
  } finally {
    setAgentModel(null);
    setMcpClient(undefined);
  }
});

test('the model argument works for a non-Kilo client too', async () => {
  // Nothing about this is Kilo-specific — it is the MCP equivalent of
  // --agent-model, and every MCP host can use it.
  const d = builtFixture('graft-mcp-cursor-model-');
  setMcpClient('Cursor');
  try {
    const res = await callTool(d, 'graft_find_code', {
      query: 'add two numbers to a total',
      model: 'claude-opus-5',
    });
    // Priced and named. The label may be the host's display name when a readable
    // config knows this id, so the assertion is on the shape, not the spelling.
    assert.match(res.text, /\(~\$X for [^)]+\) this turn/);
    assert.doesNotMatch(res.text, /as estimated below/, 'a named model beats a table');
    // Filed under the id the agent sent, verbatim — the ledger key is the id,
    // never the prettified label.
    assert.ok(readLedger(d).days[dayKey()]['claude-opus-5']?.savedTokens > 0);
  } finally {
    setAgentModel(null);
    setMcpClient(undefined);
  }
});

test('concurrent tool calls cannot read each other\'s model', async () => {
  // The defect this guards: `callTool` is async and the server is long-lived, so
  // two overlapping calls interleave at every await. With the named model in a
  // module-level slot, one call's model was read by the other — pricing a saving
  // at the wrong rate and FILING it against a model that never ran it. Found by
  // probing the real server; it passed every sequential test beforehand.
  const d = builtFixture('graft-mcp-concurrent-');
  setMcpClient('Kilo Code');
  try {
    // Deliberately NOT awaited in turn: both are in flight at once.
    const [named, unnamed] = await Promise.all([
      callTool(d, 'graft_find_code', { query: 'add two numbers to a total', model: 'claude-opus-5' }),
      callTool(d, 'graft_find_code', { query: 'a running money total' }),
    ]);

    // The named call is priced, and says so.
    assert.match(named.text, /\(~\$X for [^)]+\) this turn/, 'named call priced');
    assert.doesNotMatch(named.text, /as estimated below/, 'named call needs no table');

    // The unnamed call must be unaffected by its neighbour: no price, and the
    // fallback table instead.
    assert.match(unnamed.text, /as estimated below/, 'unnamed call kept its table');
    assert.doesNotMatch(unnamed.text, /\(~\$X for/, 'unnamed call borrowed no model');

    // And the ledger agrees: tokens under both the real model and unknown,
    // rather than everything swept under whichever call happened to win.
    const day = readLedger(d).days[dayKey()];
    assert.ok(day['claude-opus-5']?.savedTokens > 0, 'the named call filed under its model');
    assert.ok(day[UNKNOWN_MODEL]?.savedTokens > 0, 'the unnamed call filed as unknown');
  } finally {
    setAgentModel(null);
    setMcpClient(undefined);
  }
});

test('concurrent calls each claim only their own tokens', async () => {
  // The same isolation, for the savings accumulator: a shared counter had both
  // calls filing the SUM of their tokens, double-counting every overlapping pair.
  const d = builtFixture('graft-mcp-concurrent-sum-');
  setMcpClient('Cursor');
  try {
    const [a, b] = await Promise.all([
      callTool(d, 'graft_find_code', { query: 'add two numbers to a total', model: 'claude-opus-5' }),
      callTool(d, 'graft_find_code', { query: 'a running money total', model: 'claude-opus-5' }),
    ]);
    const claimed = sumSavingsFooters(a.text) + sumSavingsFooters(b.text);
    assert.ok(claimed > 0, 'both calls claimed something');
    assert.equal(
      readLedger(d).days[dayKey()]['claude-opus-5'].savedTokens,
      claimed,
      'the ledger holds exactly what the two footers claimed — no double count',
    );
  } finally {
    setAgentModel(null);
    setMcpClient(undefined);
  }
});

// ── the host-record backstop ──────────────────────────────────────────────

/**
 * Kilo's session database, with one row naming `model` as the live session for
 * `dir`. Written to a scratch HOME which `kiloSessionModel` is pointed at by the
 * env below.
 */
function kiloSessionDb(home: string, dir: string, model: string): void {
  const sqlite = process.getBuiltinModule?.('node:sqlite') as any;
  const dbDir = join(home, 'kilo');
  mkdirSync(dbDir, { recursive: true });
  const path = join(dbDir, 'kilo.db');
  const db = new sqlite.DatabaseSync(path);
  db.exec('create table session (id text primary key, directory text, model text, time_updated integer)');
  db.prepare('insert into session values (?, ?, ?, ?)')
    .run('ses_1', dir.replace(/\\/g, '/'), JSON.stringify({ id: model }), Date.now());
  db.close();
}

const noSqlite = (process.getBuiltinModule?.('node:sqlite') as any)?.DatabaseSync === undefined
  ? 'node:sqlite is unavailable on this runtime (Node < 22.5)'
  : false;

test('an agent that sends no model is still priced from Kilo\'s session record', { skip: noSqlite }, async () => {
  // The defect, end to end. Measured on a real machine, 349 of 361 graft calls
  // over MCP omitted `model` — every one of them filed as `unknown` and reported
  // in tokens. The protocol has no field for the model, so the agent was the
  // only source; this adds the one other place that knows.
  const d = builtFixture('graft-mcp-hostmodel-');
  const xdg = tmpRepo('graft-mcp-hostmodel-home-');
  kiloSessionDb(xdg, d, 'vertex_ai/claude-opus-5');
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = xdg;
  setMcpClient('Kilo Code');
  try {
    const res = await callTool(d, 'graft_find_code', { query: 'add two numbers to a total' });
    assert.match(res.text, /\(~\$X for [^)]+\) this turn/, 'priced despite the agent saying nothing');
    assert.doesNotMatch(res.text, /as estimated below/, 'a named model beats the fallback table');
    const day = readLedger(d).days[dayKey()];
    assert.ok(day['claude-opus-5']?.savedTokens > 0, 'filed under the model Kilo is running');
    assert.equal(day[UNKNOWN_MODEL], undefined, 'and nothing left unattributed');
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
    setAgentModel(null);
    setMcpClient(undefined);
  }
});

test('what the agent sends still wins over the session record', { skip: noSqlite }, async () => {
  // The backstop must never override a cooperating agent: it is matched on a
  // directory and cannot tell two sessions in one directory apart, while the
  // argument is scoped to this exact call.
  const d = builtFixture('graft-mcp-hostmodel-loses-');
  const xdg = tmpRepo('graft-mcp-hostmodel-loses-home-');
  kiloSessionDb(xdg, d, 'gemini-3.8-flash');
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = xdg;
  setMcpClient('Kilo Code');
  try {
    await callTool(d, 'graft_find_code', {
      query: 'add two numbers to a total',
      model: 'claude-opus-5',
    });
    const day = readLedger(d).days[dayKey()];
    assert.ok(day['claude-opus-5']?.savedTokens > 0, 'filed under what the agent said');
    assert.equal(day['gemini-3.8-flash'], undefined, 'not under the directory match');
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
    setAgentModel(null);
    setMcpClient(undefined);
  }
});

test('a non-Kilo client never reads Kilo\'s session database', { skip: noSqlite }, async () => {
  // Same gate as the model table, for the same reason: this reads Kilo's schema
  // and nothing else's, so on another host the row describes a different tool's
  // session and must not price anything.
  const d = builtFixture('graft-mcp-hostmodel-cursor-');
  const xdg = tmpRepo('graft-mcp-hostmodel-cursor-home-');
  kiloSessionDb(xdg, d, 'vertex_ai/claude-opus-5');
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = xdg;
  setMcpClient('Cursor');
  try {
    const res = await callTool(d, 'graft_find_code', { query: 'add two numbers to a total' });
    assert.doesNotMatch(res.text, /\(~\$X for/, 'Cursor is not priced from Kilo\'s record');
    assert.ok(readLedger(d).days[dayKey()][UNKNOWN_MODEL]?.savedTokens > 0);
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
    setAgentModel(null);
    setMcpClient(undefined);
  }
});

test('the CLI path never gets a table either — Kilo only ever arrives over MCP', () => {
  const d = builtFixture('graft-cli-notable-');
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'callers', 'mathAdd1', d],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.doesNotMatch(out, /as estimated below/);
});
