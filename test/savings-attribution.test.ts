/**
 * Which model a saving is filed under, and what it is worth, end to end.
 *
 * Regression tests for the attribution failures found after the 0.28.0 merge:
 *
 *  - A Claude Code session stamp (`model`, written only by its Stop hook) outranked
 *    both the model the agent named and the host's own record, and had no age
 *    check. In a repo Claude Code had ever touched, every Kilo or Copilot saving
 *    was filed under the last Claude model that ran there, weeks later.
 *  - The ledger treated any read failure as "empty" and then overwrote the file,
 *    which loses the whole history when the read fails for a transient reason
 *    (a OneDrive placeholder with its client stopped).
 *  - Claude Opus 5.5 ($4/Mtok) and Sonnet 5.5 ($2/Mtok) must price correctly
 *    through Kilo (MCP) and Copilot (CLI in a VS Code terminal), at every
 *    reasoning effort, because the effort is not part of the model id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { callTool } from '../src/mcp/tools.js';
import { setMcpClient } from '../src/mcp/client.js';
import {
  UNKNOWN_MODEL,
  aggregateSavings,
  dayKey,
  ledgerPath,
  readLedger,
  recordSavedTokens,
  setAgentModel,
} from '../src/claude/ledger.js';
import { callerIsClaudeCode, liveClaudeSession, sessionPricing } from '../src/claude/session-metrics.js';
import { sessionDir, writeSession } from '../src/claude/state.js';
import { MAX_SESSION_AGE_MS } from '../src/hosts/kilo-session.js';
import { sumSavingsFooters } from '../src/context/savings.js';
import { tmpRepo } from './helpers.js';

// Never let a test reach the developer's real registry or profile store, even
// when this file is run on its own rather than through `npm test`.
process.env.GRAFT_REPOS_FILE ??= join(tmpRepo('attribution-registry'), 'repos.json');
process.env.GRAFT_PROFILE_STORE ??= '0';

const noSqlite = (process.getBuiltinModule?.('node:sqlite') as any)?.DatabaseSync === undefined
  ? 'node:sqlite is unavailable on this runtime (Node < 22.5)'
  : false;

/** Run `fn` with these env vars set (undefined deletes), restoring them after. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    setAgentModel(null);
    setMcpClient(undefined);
  }
}

/** A built repo big enough that a retrieval really does save tokens. */
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

/** Kilo's session database with one live row for `dir`, replacing any earlier one. */
function kiloDb(xdg: string, dir: string, model: string, variant?: string): void {
  const sqlite = process.getBuiltinModule?.('node:sqlite') as any;
  const dbDir = join(xdg, 'kilo');
  mkdirSync(dbDir, { recursive: true });
  const path = join(dbDir, 'kilo.db');
  rmSync(path, { force: true });
  const db = new sqlite.DatabaseSync(path);
  db.exec('create table session (id text primary key, directory text, model text, time_updated integer)');
  db.prepare('insert into session values (?, ?, ?, ?)').run(
    'ses_1',
    dir.replace(/\\/g, '/'),
    JSON.stringify({ id: model, providerID: 'aumovio-databricks', ...(variant ? { variant } : {}) }),
    Date.now(),
  );
  db.close();
}

/** Dollars the ledger reports for one model, plus the tokens behind them. */
function reported(d: string, model: string): { tokens: number; usd: number | null } {
  const row = aggregateSavings(readLedger(d)).models.find((m) => m.model === model);
  assert.ok(row, `the ledger has a row for ${model}; has ${Object.keys(readLedger(d).days[dayKey()] ?? {}).join(', ')}`);
  return { tokens: row.savedTokens, usd: row.value?.usd ?? null };
}

const MODELS = [
  { id: 'claude-opus-5-5', route: 'aumovio-databricks/claude-opus-5-5', perMtok: 4 },
  { id: 'claude-sonnet-5-5', route: 'aumovio-databricks/claude-sonnet-5-5', perMtok: 2 },
] as const;
const VARIANTS = [undefined, 'low', 'medium', 'high', 'max'];
const ASK = { query: 'add two numbers to a total' };

// ── the stamp gate ────────────────────────────────────────────────────────

function stamp(d: string, id: string, model: string, ageMs = 0): void {
  writeSession(d, id, { graftReads: 0, sourceReads: 0, savedTokens: 0, model, inputCostMicros: 9_000_000, inputTokensBilled: 1_000_000 } as any);
  if (ageMs > 0) {
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(join(sessionDir(d), `${id}.json`), when, when);
  }
}

test('callerIsClaudeCode: the env var or the MCP client name, nothing else', () => {
  assert.equal(callerIsClaudeCode({ env: { CLAUDECODE: '1' }, client: null }), true);
  assert.equal(callerIsClaudeCode({ env: {}, client: 'claude-code' }), true);
  assert.equal(callerIsClaudeCode({ env: {}, client: 'Claude Code' }), true);
  assert.equal(callerIsClaudeCode({ env: {}, client: 'Kilo Code' }), false);
  assert.equal(callerIsClaudeCode({ env: {}, client: 'claude-ai' }), false, 'a different product');
  assert.equal(callerIsClaudeCode({ env: {}, client: 'Cursor' }), false);
  assert.equal(callerIsClaudeCode({ env: {}, client: null }), false, 'the CLI outside Claude Code');
});

test('a Claude session stamp is trusted only for Claude Code, and only while fresh', () => {
  const d = tmpRepo('stamp-gate');
  stamp(d, 's1', 'claude-opus-4-8');
  const claude = { env: { CLAUDECODE: '1' }, client: null };

  assert.equal(liveClaudeSession(d, claude)?.model, 'claude-opus-4-8', 'Claude Code, fresh: honoured');
  assert.equal(liveClaudeSession(d, { env: {}, client: 'Kilo Code' }), null, 'Kilo: ignored');
  assert.equal(liveClaudeSession(d, { env: {}, client: null }), null, 'CLI outside Claude Code: ignored');

  // The same session, aged past the window.
  const now = Date.now() + MAX_SESSION_AGE_MS + 60_000;
  assert.equal(liveClaudeSession(d, { ...claude, now }), null, 'Claude Code, stale: ignored');
  assert.equal(liveClaudeSession(d, { ...claude, now, maxAgeMs: 2 * MAX_SESSION_AGE_MS })?.model, 'claude-opus-4-8');

  assert.equal(liveClaudeSession(tmpRepo('stamp-none'), claude), null, 'no session at all');
});

test('sessionPricing ignores a stale or foreign stamp and its blended rate', async () => {
  const d = tmpRepo('stamp-pricing');
  stamp(d, 's1', 'claude-opus-4-8', 60 * 24 * 3600_000);
  await withEnv({ CLAUDECODE: undefined }, () => {
    setMcpClient('Kilo Code');
    const p = sessionPricing(d);
    assert.equal(p.rate, null, 'the stale $9/Mtok blended rate must not price anything');
  });
  // The same file, fresh and read as Claude Code, is what it always was.
  stamp(d, 's1', 'claude-sonnet-5-5');
  await withEnv({ CLAUDECODE: '1' }, () => {
    const p = sessionPricing(d);
    assert.ok(p.rate, 'fresh Claude Code stamp still prices');
  });
});

// ── MCP: Kilo, with and without the `model` argument ──────────────────────

for (const m of MODELS) {
  test(`Kilo over MCP: ${m.id} is filed and priced at $${m.perMtok}/Mtok at every variant, with and without the model argument`, { skip: noSqlite }, async () => {
    const d = builtFixture(`attr-mcp-${m.id}-`);
    const xdg = tmpRepo(`attr-mcp-home-${m.id}-`);
    let claimed = 0;
    await withEnv({ XDG_DATA_HOME: xdg, CLAUDECODE: undefined }, async () => {
      setMcpClient('Kilo Code');
      for (const variant of VARIANTS) {
        for (const sendModel of [false, true]) {
          kiloDb(xdg, d, m.id, variant);
          const res = await callTool(d, 'graft_find_code', sendModel ? { ...ASK, model: m.route } : ASK);
          const saved = sumSavingsFooters(res.text);
          assert.ok(saved > 0, `a saving at variant ${variant ?? 'none'}, model arg ${sendModel}`);
          claimed += saved;
          assert.match(res.text, /\(~\$X for [^)]+\) this turn/, `priced at variant ${variant ?? 'none'}, model arg ${sendModel}`);
          assert.doesNotMatch(res.text, /as estimated below/);
        }
      }
    });
    const day = readLedger(d).days[dayKey()];
    assert.deepEqual(Object.keys(day), [m.id], 'one row: the effort and the route never split it');
    assert.equal(day[UNKNOWN_MODEL], undefined);

    const { tokens, usd } = reported(d, m.id);
    assert.equal(tokens, claimed, 'the ledger holds exactly what the footers claimed');
    assert.ok(usd !== null);
    assert.ok(Math.abs(usd - (claimed * m.perMtok) / 1_000_000) < 1e-9, `${usd} vs ${(claimed * m.perMtok) / 1_000_000}`);
  });
}

test('a 60-day-old Claude stamp does not outrank the model Kilo is running', { skip: noSqlite }, async () => {
  const d = builtFixture('attr-stale-stamp-');
  const xdg = tmpRepo('attr-stale-stamp-home-');
  stamp(d, 'old-claude-session', 'claude-opus-4-8', 60 * 24 * 3600_000);
  kiloDb(xdg, d, 'claude-opus-5-5', 'high');
  await withEnv({ XDG_DATA_HOME: xdg, CLAUDECODE: undefined }, async () => {
    setMcpClient('Kilo Code');
    await callTool(d, 'graft_find_code', ASK);
  });
  const day = readLedger(d).days[dayKey()];
  assert.ok(day['claude-opus-5-5']?.savedTokens > 0, 'filed under the model Kilo runs');
  assert.equal(day['claude-opus-4-8'], undefined, 'not the stale stamp');
  const { tokens, usd } = reported(d, 'claude-opus-5-5');
  assert.ok(usd !== null && Math.abs(usd - (tokens * 4) / 1_000_000) < 1e-9, 'at $4/Mtok, not the stamp\'s blended rate');
});

test('even a FRESH Claude stamp is ignored when the caller is Kilo', { skip: noSqlite }, async () => {
  const d = builtFixture('attr-fresh-foreign-');
  const xdg = tmpRepo('attr-fresh-foreign-home-');
  stamp(d, 'live-claude-session', 'claude-haiku-4-5');
  kiloDb(xdg, d, 'claude-sonnet-5-5', 'low');
  await withEnv({ XDG_DATA_HOME: xdg, CLAUDECODE: undefined }, async () => {
    setMcpClient('Kilo Code');
    await callTool(d, 'graft_find_code', ASK);
  });
  const day = readLedger(d).days[dayKey()];
  assert.ok(day['claude-sonnet-5-5']?.savedTokens > 0);
  assert.equal(day['claude-haiku-4-5'], undefined);
});

test('a fresh Claude stamp is still honoured for Claude Code itself', async () => {
  const d = builtFixture('attr-claude-code-');
  stamp(d, 'live-claude-session', 'claude-sonnet-5-5');
  await withEnv({ CLAUDECODE: undefined }, async () => {
    setMcpClient('claude-code');
    await callTool(d, 'graft_find_code', ASK);
  });
  const day = readLedger(d).days[dayKey()];
  assert.ok(day['claude-sonnet-5-5']?.savedTokens > 0, 'the stamp names the model for Claude Code');
});

// ── CLI: Copilot in a VS Code terminal ────────────────────────────────────

function effortLog(modelId: string, resolved: string, effort: string): string {
  return `${JSON.stringify({
    kind: 0,
    v: {
      requests: [{ requestId: 'r1', modelId, resolvedModel: resolved }],
      inputState: { selectedModel: { identifier: modelId } },
      modelConfiguration: { reasoningEffort: effort },
    },
  })}\n`;
}

const CLI_MODELS = [
  { id: 'claude-opus-5-5', picked: 'copilot/claude-opus-5.5', perMtok: 4 },
  { id: 'claude-sonnet-5-5', picked: 'copilot/claude-sonnet-5.5', perMtok: 2 },
] as const;

for (const m of CLI_MODELS) {
  test(`Copilot via the CLI: ${m.id} is filed and priced at $${m.perMtok}/Mtok at every reasoning effort`, () => {
    const d = builtFixture(`attr-cli-${m.id}-`);
    const home = tmpRepo(`attr-cli-home-${m.id}-`);
    const appData = join(home, 'AppData', 'Roaming');
    let claimed = 0;
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const ws = join(appData, 'Code', 'User', 'workspaceStorage', 'ws1');
      mkdirSync(join(ws, 'chatSessions'), { recursive: true });
      writeFileSync(join(ws, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(d).href }));
      writeFileSync(join(ws, 'chatSessions', 'a.jsonl'), effortLog(m.picked, m.id, effort));

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: appData,
        XDG_CONFIG_HOME: join(home, '.config'),
        TERM_PROGRAM: 'vscode',
        GRAFT_PROFILE_STORE: '0',
        GRAFT_REPOS_FILE: join(home, 'repos.json'),
      };
      for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'KILO', 'KILO_PID', 'KILO_CLIENT', 'KILO_APP_VERSION', 'GRAFT_AGENT_MODEL']) delete env[k];

      const out = execFileSync(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', 'ask', ASK.query, '--source', d],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env },
      );
      const saved = sumSavingsFooters(out);
      assert.ok(saved > 0, `a saving at effort ${effort}`);
      claimed += saved;
    }
    const day = readLedger(d).days[dayKey()];
    assert.deepEqual(Object.keys(day), [m.id], 'one row at every effort');
    const { tokens, usd } = reported(d, m.id);
    assert.equal(tokens, claimed);
    assert.ok(usd !== null && Math.abs(usd - (claimed * m.perMtok) / 1_000_000) < 1e-9, `${usd}`);
  });
}

// ── the ledger must never lose history to a read error ────────────────────

/** Capture what the ledger says on stderr while `fn` runs. */
function captureStderr(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return lines.join('\n');
}

test('an unreadable ledger is left alone — recording does not throw and does not replace it', () => {
  const d = tmpRepo('ledger-unreadable');
  const file = ledgerPath(d);
  // A directory where the file should be: reading it fails with EISDIR, the same
  // class of failure as a OneDrive placeholder (EUNKNOWN) or a locked file.
  mkdirSync(file, { recursive: true });
  writeFileSync(join(file, 'precious.txt'), 'history');

  const said = captureStderr(() => recordSavedTokens(d, 'claude-opus-5-5', 1234));

  assert.ok(statSync(file).isDirectory(), 'still what it was, not overwritten with a fresh ledger');
  assert.equal(existsSync(join(file, 'precious.txt')), true);
  assert.match(said, /could not be read/, 'the user is told why nothing was recorded');
});

test('a missing ledger is simply empty, and recording creates it', () => {
  const d = tmpRepo('ledger-missing');
  assert.equal(existsSync(ledgerPath(d)), false);
  recordSavedTokens(d, 'claude-opus-5-5', 500);
  assert.equal(readLedger(d).days[dayKey()]['claude-opus-5-5'].savedTokens, 500);
  recordSavedTokens(d, 'claude-opus-5-5', 250);
  assert.equal(readLedger(d).days[dayKey()]['claude-opus-5-5'].savedTokens, 750, 'accumulates, history kept');
});

test('a corrupt ledger is set aside, not destroyed, and recording starts fresh', () => {
  const d = tmpRepo('ledger-corrupt');
  const file = ledgerPath(d);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '{"days": {"2026-01-01": {"claude-opus-5-5": {"savedTok');

  recordSavedTokens(d, 'claude-opus-5-5', 100);

  const backups = readdirSync(join(file, '..')).filter((f) => /^savings\.json\.corrupt-\d+$/.test(f));
  assert.equal(backups.length, 1, 'the bytes survive for recovery');
  assert.equal(readLedger(d).days[dayKey()]['claude-opus-5-5'].savedTokens, 100);
});

test('per-model dollars add up across spellings, models and days', () => {
  const d = tmpRepo('ledger-totals');
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 3600_000);
  // One model, three spellings: gateway route, dotted version, bare id.
  recordSavedTokens(d, 'aumovio-databricks/claude-opus-5-5', 1_000_000, today);
  recordSavedTokens(d, 'copilot/claude-opus-5.5', 1_000_000, today);
  recordSavedTokens(d, 'claude-opus-5-5', 1_000_000, yesterday);
  recordSavedTokens(d, 'claude-sonnet-5-5', 1_000_000, today);
  recordSavedTokens(d, UNKNOWN_MODEL, 700_000, today);

  const report = aggregateSavings(readLedger(d));
  const opus = report.models.find((m) => m.model === 'claude-opus-5-5');
  const sonnet = report.models.find((m) => m.model === 'claude-sonnet-5-5');
  assert.equal(report.models.filter((m) => /opus/.test(m.model)).length, 1, 'one Opus row');
  assert.equal(opus?.savedTokens, 3_000_000);
  assert.ok(opus?.value && Math.abs(opus.value.usd - 12) < 1e-9, 'Opus 5.5: 3M x $4');
  assert.ok(sonnet?.value && Math.abs(sonnet.value.usd - 2) < 1e-9, 'Sonnet 5.5: 1M x $2');
  assert.ok(report.usd !== null && Math.abs(report.usd - 14) < 1e-9, 'total excludes the unpriced');
  assert.equal(report.unpricedTokens, 700_000, 'unknown is reported in tokens, never priced');
});
