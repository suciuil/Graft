/**
 * The opt-in remote savings report (src/reporting/): off by default, queues
 * only what the owner approved, honours the database's kill switch, keeps what
 * it could not deliver, and never needs a real database here (a fake driver).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSavedTokens, recordTurnBilling } from '../src/claude/ledger.js';
import {
  ORPHAN_AGE_MS,
  loadReportingConfig,
  outboxPath,
  patchReportingState,
  peekOutbox,
  readReportingState,
  recoverOrphans,
  reportingEnabled,
  type ReportEvent,
} from '../src/reporting/store.js';
import {
  FLUSH_INTERVAL_MS,
  chooseMode,
  insertSql,
  killSwitchOn,
  maybeFlushInBackground,
  resetThickProbe,
  runFlush,
  runPowerShell,
  schemaPrefix,
  toBinds,
  windowsPowerShellEnv,
  type OdpnetRun,
  type OracleDriver,
} from '../src/reporting/flush.js';
import { disableReporting, enableReporting, formatReportingStatus } from '../src/reporting/command.js';

// Never start a real send from a test, whatever runner started it.
process.env.GRAFT_REPORTING_NO_FLUSH = '1';

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p));

/** A scratch home for the report, also the one the ledger's calls resolve. */
function home(): string {
  const h = tmp('graft-report-home-');
  process.env.GRAFT_REPORTING_HOME = h;
  return h;
}

const CONFIG = { connectString: 'db.example:1521/svc', user: 'U', password: 'P', mode: 'thick' as const };

interface FakeOpts {
  kill?: unknown;
  killThrows?: boolean;
  connectThrows?: boolean;
  insertThrows?: boolean;
  batchErrors?: Array<{ offset: number; errorNum?: number; message: string }>;
}

function fakeDriver(o: FakeOpts = {}) {
  const calls = { inserts: [] as Record<string, unknown>[][], commits: 0, closed: 0, sql: [] as string[] };
  const driver: OracleDriver = {
    STRING: 'STRING',
    NUMBER: 'NUMBER',
    thin: false,
    initOracleClient() {},
    async getConnection() {
      if (o.connectThrows) throw new Error('ORA-12170: TNS:Connect timeout occurred');
      return {
        callTimeout: 0,
        async execute(sql: string) {
          calls.sql.push(sql);
          if (o.killThrows) throw new Error('ORA-00942: table or view does not exist');
          return { rows: o.kill === undefined ? [] : [[o.kill]] };
        },
        async executeMany(sql: string, binds: Record<string, unknown>[]) {
          calls.sql.push(sql);
          if (o.insertThrows) throw new Error('ORA-03113: end-of-file on communication channel');
          calls.inserts.push(binds);
          return { rowsAffected: binds.length - (o.batchErrors?.length ?? 0), batchErrors: o.batchErrors };
        },
        async commit() { calls.commits++; },
        async close() { calls.closed++; },
      };
    },
  };
  return { driver, calls };
}

function event(over: Partial<ReportEvent> = {}): ReportEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
    installId: '11111111-1111-4111-8111-111111111111',
    kind: 'saving',
    ts: '2026-11-03T09:54:02.123Z',
    day: '2026-11-03',
    channel: 'cli',
    command: 'ask',
    model: 'claude-opus-5',
    savedTokens: 1234,
    usd: 0.0185,
    measured: false,
    costMicros: 0,
    tokensBilled: 0,
    ...over,
  };
}

function seedOutbox(h: string, events: ReportEvent[]): void {
  mkdirSync(join(h, '.graft'), { recursive: true });
  writeFileSync(outboxPath(h), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

test('off by default: the ledger queues nothing', () => {
  const h = home();
  const repo = tmp('graft-report-repo-');
  assert.equal(reportingEnabled(h), false);
  recordSavedTokens(repo, 'claude-opus-5', 5000, new Date(), { channel: 'cli', command: 'ask', usd: 0.1, measured: false });
  recordTurnBilling(repo, [{ model: 'claude-opus-5', costMicros: 600_000, tokens: 1_000_000 }]);
  assert.equal(existsSync(outboxPath(h)), false);
});

test('enabled: a saving is queued with the approved fields only', () => {
  const h = home();
  const repo = tmp('graft-report-repo-secret-name-');
  enableReporting(h);
  recordSavedTokens(repo, 'vertex_ai/claude-opus-5', 5000, new Date('2026-11-03T10:00:00Z'), { channel: 'mcp', command: 'graft_find_code', usd: 0.075, measured: true });
  const [e] = peekOutbox(h);
  assert.ok(e, 'one event queued');
  assert.equal(e.kind, 'saving');
  assert.equal(e.model, 'claude-opus-5', 'canonical ledger key');
  assert.equal(e.savedTokens, 5000);
  assert.equal(e.usd, 0.075);
  assert.equal(e.measured, true);
  assert.equal(e.channel, 'mcp');
  assert.equal(e.command, 'graft_find_code');
  assert.match(e.installId, /^[0-9a-f-]{36}$/);
  assert.match(e.eventId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(e).sort(), [
    'channel', 'command', 'costMicros', 'day', 'eventId', 'installId', 'kind', 'measured', 'model', 'savedTokens', 'tokensBilled', 'ts', 'usd',
  ]);
  assert.ok(!readFileSync(outboxPath(h), 'utf8').includes('secret-name'), 'no repo path in the outbox');
});

test('enabled: billing is queued per priced model, unpriced ones are not', () => {
  const h = home();
  const repo = tmp('graft-report-repo-');
  enableReporting(h);
  recordTurnBilling(repo, [
    { model: 'claude-opus-5', costMicros: 600_000, tokens: 1_000_000 },
    { model: 'mystery-model', costMicros: null, tokens: 50_000 },
  ], new Date(), { channel: 'hook', command: 'stop' });
  const events = peekOutbox(h);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'billing');
  assert.equal(events[0].costMicros, 600_000);
  assert.equal(events[0].tokensBilled, 1_000_000);
  assert.equal(events[0].usd, null);
  assert.equal(events[0].measured, null);
});

test('disable stops queueing and discards the queue', () => {
  const h = home();
  const repo = tmp('graft-report-repo-');
  enableReporting(h);
  recordSavedTokens(repo, 'claude-opus-5', 100);
  assert.equal(peekOutbox(h).length, 1);
  disableReporting(h);
  assert.equal(peekOutbox(h).length, 0);
  assert.equal(readReportingState(h).disabledBy, 'user');
  recordSavedTokens(repo, 'claude-opus-5', 100);
  assert.equal(peekOutbox(h).length, 0);
});

test('flush inserts the queue, commits, and empties the outbox', async () => {
  const h = home();
  enableReporting(h);
  seedOutbox(h, [event(), event({ kind: 'billing', usd: null, measured: null, savedTokens: 0, costMicros: 9, tokensBilled: 10 })]);
  const { driver, calls } = fakeDriver();
  const r = await runFlush({ home: h, driver, config: CONFIG });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.inserted, 2);
  assert.equal(calls.inserts[0].length, 2);
  assert.equal(calls.commits, 1);
  assert.equal(calls.closed, 1);
  assert.equal(peekOutbox(h).length, 0);
  assert.equal(readReportingState(h).lastFlush?.ok, true);
});

test('kill switch: turns reporting off, discards the queue, inserts nothing', async () => {
  for (const kill of ['1', 'TRUE', 'true', 1]) {
    const h = home();
    enableReporting(h);
    seedOutbox(h, [event()]);
    const { driver, calls } = fakeDriver({ kill });
    const r = await runFlush({ home: h, driver, config: CONFIG });
    assert.equal(r.remoteDisabled, true, `kill=${String(kill)}`);
    assert.equal(calls.inserts.length, 0);
    assert.equal(peekOutbox(h).length, 0);
    assert.equal(reportingEnabled(h), false);
    assert.equal(readReportingState(h).disabledBy, 'remote');
    assert.match(formatReportingStatus(h), /kill switch/);
  }
});

test('kill switch off, missing or unreadable: the flush carries on', async () => {
  for (const o of [{ kill: '0' }, { kill: 'false' }, {}, { killThrows: true }] as FakeOpts[]) {
    const h = home();
    enableReporting(h);
    seedOutbox(h, [event()]);
    const { driver, calls } = fakeDriver(o);
    const r = await runFlush({ home: h, driver, config: CONFIG });
    assert.equal(r.inserted, 1, JSON.stringify(o));
    assert.equal(calls.inserts.length, 1);
    assert.equal(reportingEnabled(h), true);
  }
});

test('re-enabling after the kill switch works, and the switch is read again', async () => {
  const h = home();
  patchReportingState({ enabled: false, disabledBy: 'remote' }, h);
  enableReporting(h);
  assert.equal(reportingEnabled(h), true);
  assert.equal(readReportingState(h).disabledBy, undefined);
  seedOutbox(h, [event()]);
  const { driver, calls } = fakeDriver({ kill: '1' });
  await runFlush({ home: h, driver, config: CONFIG });
  assert.ok(calls.sql.some((s) => /GRAFT_REPORTING_SETTINGS/.test(s)));
  assert.equal(reportingEnabled(h), false);
});

test('a failed connection or insert keeps the batch; nothing is thrown', async () => {
  for (const o of [{ connectThrows: true }, { insertThrows: true }] as FakeOpts[]) {
    const h = home();
    enableReporting(h);
    seedOutbox(h, [event(), event()]);
    const { driver } = fakeDriver(o);
    const r = await runFlush({ home: h, driver, config: CONFIG });
    assert.equal(r.ok, false);
    assert.ok(r.error);
    assert.equal(peekOutbox(h).length, 2, JSON.stringify(o));
    assert.equal(readReportingState(h).lastFlush?.ok, false);
  }
});

test('duplicates count as delivered, rejected rows are dropped', async () => {
  const h = home();
  enableReporting(h);
  seedOutbox(h, [event(), event(), event()]);
  const { driver } = fakeDriver({
    batchErrors: [
      { offset: 0, errorNum: 1, message: 'ORA-00001: unique constraint (PK_GRAFT_COST_SAVINGS) violated' },
      { offset: 2, errorNum: 12899, message: 'ORA-12899: value too large for column' },
    ],
  });
  const r = await runFlush({ home: h, driver, config: CONFIG });
  assert.equal(r.inserted, 1);
  assert.equal(r.duplicates, 1);
  assert.equal(r.rejected, 1);
  assert.equal(peekOutbox(h).length, 0);
});

test('no database configured: nothing is attempted and the queue is kept', async () => {
  const h = home();
  enableReporting(h);
  seedOutbox(h, [event()]);
  const { driver, calls } = fakeDriver();
  const r = await runFlush({ home: h, driver, config: {} });
  assert.equal(r.skipped, 'unconfigured');
  assert.equal(calls.inserts.length, 0);
  assert.equal(peekOutbox(h).length, 1);
});

test('flush does nothing while reporting is off', async () => {
  const h = home();
  seedOutbox(h, [event()]);
  const { driver, calls } = fakeDriver();
  const r = await runFlush({ home: h, driver, config: CONFIG });
  assert.equal(r.skipped, 'disabled');
  assert.equal(calls.sql.length, 0);
});

test('background flush: only when on, queued, and not within the interval', () => {
  const h = home();
  const spawned: string[][] = [];
  const spawner = (_exe: string, args: string[]) => { spawned.push(args); };
  seedOutbox(h, [event()]);
  assert.equal(maybeFlushInBackground(h, 1_000_000, spawner), false, 'off');
  enableReporting(h);
  assert.equal(maybeFlushInBackground(h, 1_000_000, spawner), true);
  assert.equal(spawned[0].at(-1), '_savings-report-flush');
  assert.equal(maybeFlushInBackground(h, 1_000_000 + FLUSH_INTERVAL_MS - 1, spawner), false, 'throttled');
  assert.equal(maybeFlushInBackground(h, 1_000_000 + FLUSH_INTERVAL_MS, spawner), true);
});

test('a dead flush leaves its batch to be recovered', () => {
  const h = home();
  mkdirSync(join(h, '.graft'), { recursive: true });
  const orphan = `${outboxPath(h)}.999.1.sending`;
  writeFileSync(orphan, JSON.stringify(event()) + '\n');
  assert.equal(recoverOrphans(h), 0, 'too young: may still be in flight');
  const old = (Date.now() - ORPHAN_AGE_MS - 1000) / 1000;
  utimesSync(orphan, old, old);
  assert.equal(recoverOrphans(h), 1);
  assert.equal(peekOutbox(h).length, 1);
  assert.equal(existsSync(orphan), false);
});

test('binds fit the columns; the timestamp is sent as UTC', () => {
  const b = toBinds(event({ command: 'x'.repeat(100), model: 'm'.repeat(300), channel: 'verylongchannel' as never, measured: true }));
  assert.equal(b.ts, '2026-11-03T09:54:02.123');
  assert.equal((b.command as string).length, 64);
  assert.equal((b.model as string).length, 200);
  assert.equal((b.channel as string).length, 10);
  assert.equal(b.measured, 1);
  assert.match(insertSql(''), /FROM_TZ\(TO_TIMESTAMP\(:ts, 'YYYY-MM-DD"T"HH24:MI:SS\.FF3'\), 'UTC'\)/);
  assert.equal(toBinds(event({ usd: null, measured: null })).measured, null);
});

test('schema prefix refuses anything but a plain identifier', () => {
  assert.equal(schemaPrefix(undefined), '');
  assert.equal(schemaPrefix('CHAIR_DEV1'), 'CHAIR_DEV1.');
  assert.throws(() => schemaPrefix('X; DROP TABLE Y'));
  assert.throws(() => schemaPrefix('a.b'));
});

test('kill switch values', () => {
  for (const v of ['1', 'true', 'TRUE', ' True ', 'yes', 1]) assert.equal(killSwitchOn(v), true, String(v));
  for (const v of ['0', 'false', '', null, undefined, 0, 'no']) assert.equal(killSwitchOn(v), false, String(v));
});

test('config: the user file overrides the shipped one field by field', () => {
  const h = home();
  const shipped = join(tmp('graft-report-cfg-'), 'savings-report.json');
  writeFileSync(shipped, JSON.stringify({ connectString: 'a:1/b', user: 'U', password: 'P', mode: 'auto' }));
  mkdirSync(join(h, '.graft'), { recursive: true });
  writeFileSync(join(h, '.graft', 'savings-report.json'), JSON.stringify({ password: 'Q', mode: 'thin', bogus: 1 }));
  const { config, sources } = loadReportingConfig(h, shipped);
  assert.deepEqual(config, { connectString: 'a:1/b', user: 'U', password: 'Q', mode: 'thin' });
  assert.equal(sources.length, 2);
});

// ── driver choice and the ODP.NET fallback ────────────────────────────────────

test('auto mode: thick when an Oracle Client loads, else ODP.NET where it can run, else thin', () => {
  const ok = fakeDriver().driver;
  const noClient: OracleDriver = { ...ok, initOracleClient() { throw new Error('DPI-1047: Cannot locate a 64-bit Oracle Client library'); } };
  try {
    resetThickProbe();
    assert.equal(chooseMode(ok, { mode: 'auto' }, true), 'thick');
    resetThickProbe();
    assert.equal(chooseMode(noClient, { mode: 'auto' }, true), 'odpnet');
    assert.equal(chooseMode(noClient, { mode: 'auto' }, false), 'thin');
    assert.equal(chooseMode(null, {}, true), 'odpnet', 'oracledb not loadable');
    assert.throws(() => chooseMode(noClient, { mode: 'thick' }, true), /DPI-1047/);
    assert.equal(chooseMode(noClient, { mode: 'thin' }, true), 'thin');
    assert.equal(chooseMode(null, { mode: 'odpnet' }, true), 'odpnet');
    assert.throws(() => chooseMode(ok, { mode: 'odpnet' }, false), /needs Windows/);
  } finally {
    resetThickProbe();
  }
});

/** A stand-in for the PowerShell sender: records its stdin, prints `lines`. */
function fakeOdpnet(lines: object[] | ((rows: Record<string, unknown>[]) => object[]), over: Partial<OdpnetRun> = {}) {
  const seen: { header?: Record<string, unknown>; rows: Record<string, unknown>[] } = { rows: [] };
  const runner = async (input: string): Promise<OdpnetRun> => {
    const [head, ...rest] = input.trim().split('\n');
    seen.header = JSON.parse(head);
    seen.rows = rest.map((l) => JSON.parse(l));
    const out = typeof lines === 'function' ? lines(seen.rows) : lines;
    return { lines: out.map((o) => JSON.stringify(o)), code: 0, stderr: '', ...over };
  };
  return { runner, seen };
}

const ODP = { ...CONFIG, mode: 'odpnet' as const };

test('odpnet: rows and credentials go to the sender on stdin; batches settle the outbox', async () => {
  const h = home();
  enableReporting(h);
  seedOutbox(h, [event(), event(), event()]);
  const { runner, seen } = fakeOdpnet([
    { t: 'kill', on: false, v: '0' },
    { t: 'batch', n: 3, ins: 2, dup: 1, rej: 0, err: null },
    { t: 'done' },
  ]);
  const r = await runFlush({ home: h, config: ODP, odpnetAvailable: true, odpnetRunner: runner });
  assert.equal(r.mode, 'odpnet');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.inserted, 2);
  assert.equal(r.duplicates, 1);
  assert.equal(peekOutbox(h).length, 0);
  assert.equal(seen.rows.length, 3);
  assert.equal(seen.rows[0].ts, '2026-11-03T09:54:02.123', 'the same binds as the oracledb path');
  assert.equal(seen.header?.password, 'P');
  assert.equal(seen.header?.dataSource, CONFIG.connectString);
  assert.match(String(seen.header?.insertSql), /INSERT INTO GRAFT_COST_SAVINGS/);
  assert.match(String(seen.header?.killSql), /GRAFT_REPORTING_SETTINGS/);
  assert.match(String(seen.header?.dll), /Oracle\.ManagedDataAccess\.dll$/);
  const binds = seen.header?.binds as Array<[string, string]>;
  assert.deepEqual(binds.map(([n]) => n).sort(), Object.keys(toBinds(event())).sort(), 'every bind is described');
  for (const v of ['1', 'TRUE', 'yes']) assert.match(v, new RegExp(String(seen.header?.killPattern), 'i'));
  assert.doesNotMatch('0', new RegExp(String(seen.header?.killPattern), 'i'));
});

test('odpnet: the kill switch turns reporting off and drops the queue', async () => {
  const h = home();
  enableReporting(h);
  seedOutbox(h, [event()]);
  const { runner } = fakeOdpnet([{ t: 'kill', on: true, v: '1' }]);
  const r = await runFlush({ home: h, config: ODP, odpnetAvailable: true, odpnetRunner: runner });
  assert.equal(r.remoteDisabled, true);
  assert.equal(r.inserted, 0);
  assert.equal(peekOutbox(h).length, 0);
  assert.equal(readReportingState(h).disabledBy, 'remote');
});

test('odpnet: a fatal error or a dead sender keeps what was not committed', async () => {
  const cases: Array<[object[], Partial<OdpnetRun>, number, RegExp]> = [
    [[{ t: 'error', msg: 'ORA-01017: invalid username/password; logon denied' }], { code: 1 }, 3, /ORA-01017/],
    [[{ t: 'kill', on: false, v: null }, { t: 'batch', n: 2, ins: 2, dup: 0, rej: 0, err: null }], { code: null, timedOut: true }, 1, /timed out/],
    [[], { code: 1, stderr: 'Cannot convert value ... Constrained Language Mode' }, 3, /exited with code 1: Cannot convert/],
  ];
  for (const [lines, over, kept, error] of cases) {
    const h = home();
    enableReporting(h);
    seedOutbox(h, [event(), event(), event()]);
    const { runner } = fakeOdpnet(lines, over);
    const r = await runFlush({ home: h, config: ODP, odpnetAvailable: true, odpnetRunner: runner });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', error);
    assert.equal(r.kept, kept);
    assert.equal(peekOutbox(h).length, kept, JSON.stringify(lines));
    assert.equal(r.inserted, 3 - kept);
  }
});

test('odpnet: rows the database refuses are dropped and reported', async () => {
  const h = home();
  enableReporting(h);
  seedOutbox(h, [event(), event()]);
  const { runner } = fakeOdpnet([
    { t: 'kill', on: false, v: null },
    { t: 'batch', n: 2, ins: 1, dup: 0, rej: 1, err: 'ORA-12899: value too large for column' },
    { t: 'done' },
  ]);
  const r = await runFlush({ home: h, config: ODP, odpnetAvailable: true, odpnetRunner: runner });
  assert.equal(r.ok, false);
  assert.equal(r.rejected, 1);
  assert.match(r.error ?? '', /1 row\(s\) rejected: ORA-12899/);
  assert.equal(peekOutbox(h).length, 0);
});

test('odpnet: the real sender script runs in Windows PowerShell and reports a load failure as JSON', { skip: process.platform !== 'win32' }, async () => {
  const header = { dll: join(tmp('graft-odp-missing-'), 'Oracle.ManagedDataAccess.dll'), user: 'U', password: 'P', dataSource: 'x:1/y', timeoutSec: 5 };
  const run = await runPowerShell(JSON.stringify(header) + '\n');
  const msgs = run.lines.map((l) => JSON.parse(l) as { t: string; msg?: string });
  assert.equal(run.code, 1, run.stderr);
  assert.equal(msgs.length, 1, run.lines.join('\n'));
  assert.equal(msgs[0].t, 'error');
  assert.ok(msgs[0].msg, 'carries the reason');
});

test('status never prints the password', () => {
  const h = home();
  mkdirSync(join(h, '.graft'), { recursive: true });
  writeFileSync(join(h, '.graft', 'savings-report.json'), JSON.stringify({ connectString: 'a:1/b', user: 'U', password: 'S3cr3t-pw' }));
  assert.ok(!formatReportingStatus(h).includes('S3cr3t-pw'));
});

test('the ODP.NET sender drops PowerShell 7 module folders, so Windows PowerShell loads its own modules', () => {
  const env = windowsPowerShellEnv({
    PATH: 'C:\\x',
    PSModulePath: [
      'C:\\Users\\u\\Documents\\PowerShell\\Modules',
      'C:\\Program Files\\PowerShell\\Modules',
      'c:\\program files\\powershell\\7\\Modules\\',
      'C:\\Users\\u\\Documents\\WindowsPowerShell\\Modules',
      'C:\\Program Files\\WindowsPowerShell\\Modules',
      'C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules',
      'C:\\Program Files (x86)\\Microsoft Purview Information Protection\\Powershell',
      '',
    ].join(';'),
  });
  assert.equal(
    env.PSModulePath,
    'C:\\Users\\u\\Documents\\WindowsPowerShell\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules;' +
      'C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules;C:\\Program Files (x86)\\Microsoft Purview Information Protection\\Powershell',
  );
  assert.equal(env.PATH, 'C:\\x');
  // Only PowerShell 7 folders: none left, so Windows PowerShell uses its defaults
  assert.equal('PSModulePath' in windowsPowerShellEnv({ PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules' }), false);
  // Whatever the variable's casing, and absent stays absent
  assert.equal(windowsPowerShellEnv({ PSMODULEPATH: 'D:\\PowerShell\\Modules;D:\\Mine' }).PSMODULEPATH, 'D:\\Mine');
  assert.deepEqual(windowsPowerShellEnv({ PATH: 'C:\\x' }), { PATH: 'C:\\x' });
});
