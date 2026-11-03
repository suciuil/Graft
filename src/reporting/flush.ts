/**
 * Remote savings report: the sending half. Runs only when the user has enabled
 * the report (`graft savings-report enable`), in a detached child
 * (`graft _savings-report-flush`) or in the foreground (`graft savings-report
 * flush`). Never in the command the user is waiting on.
 *
 * Every flush, in order:
 *   1. connects to the Oracle database named by the report config;
 *   2. reads the kill switch, `DISABLE_COST_SAVINGS_REPORTING` in
 *      `GRAFT_REPORTING_SETTINGS`. When it says 1/true, the report is turned off
 *      on this machine (`disabledBy: 'remote'`), the outbox is discarded and
 *      nothing is inserted. When the table or row is missing or unreadable, the
 *      flush carries on;
 *   3. inserts the outbox into `GRAFT_COST_SAVINGS`. `EVENT_ID` is the primary
 *      key, so a row sent twice (a flush killed after its commit) is a duplicate
 *      and counts as delivered.
 *
 * A failure to load the driver, connect or insert keeps the batch for the next
 * flush; a row the database rejects for its content is dropped, since it would
 * fail the same way forever. All of it is silent: the outcome goes to the state
 * file, where `graft savings-report status` shows it.
 *
 * Drivers. The target database requires Native Network Encryption, which
 * node-oracledb (vendored under `vendor/oracledb/`) supports only in thick
 * mode, i.e. with an installed Oracle Client. On Windows without one, the
 * flush hands the batch to Oracle's managed .NET driver instead (vendored
 * under `vendor/odpnet/`, scripts/vendor-odpnet.mjs), which implements the
 * encryption itself: a one-shot Windows PowerShell 5.1 process reads the
 * connection and the rows on stdin and reports per batch on stdout. The
 * default mode tries thick, then ODP.NET (Windows only), then thin.
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { graftCliPath } from '../claude/paths.js';
import {
  PKG_ROOT,
  clearOutbox,
  configComplete,
  drainOutbox,
  loadReportingConfig,
  outboxPath,
  patchReportingState,
  readReportingState,
  recoverOrphans,
  reportingEnabled,
  settleDrain,
  type ReportEvent,
  type ReportingConfig,
} from './store.js';

/** At most one background flush per this interval. */
export const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
/** A background flush that has not finished by now exits; its batch survives. */
export const FLUSH_WATCHDOG_MS = 60 * 1000;
/** Rows per executeMany round trip. */
export const BATCH_SIZE = 500;
/** Queried server-side round trips may take this long before the call fails. */
const CALL_TIMEOUT_MS = 30 * 1000;

export const KILL_SWITCH_KEY = 'DISABLE_COST_SAVINGS_REPORTING';
export const SAVINGS_TABLE = 'GRAFT_COST_SAVINGS';
export const SETTINGS_TABLE = 'GRAFT_REPORTING_SETTINGS';

// ── background trigger ────────────────────────────────────────────────────────

type Spawner = (exe: string, args: string[]) => void;

const detachedSpawn: Spawner = (exe, args) => {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
};

function outboxHasEvents(home?: string): boolean {
  try { return statSync(outboxPath(home)).size > 0; } catch { return false; }
}

/**
 * Start a detached flush when the report is on, something is queued and the
 * last attempt is old enough. The timestamp is written BEFORE the spawn, so a
 * child that dies cannot make every later command spawn another. Never throws.
 */
export function maybeFlushInBackground(home?: string, now = Date.now(), spawner: Spawner = detachedSpawn): boolean {
  try {
    if (!reportingEnabled(home)) return false;
    if (!outboxHasEvents(home)) return false;
    const last = readReportingState(home).flushedAt;
    if (typeof last === 'number' && now - last < FLUSH_INTERVAL_MS && now >= last) return false;
    patchReportingState({ flushedAt: now }, home);
    spawner(process.execPath, [graftCliPath(), '_savings-report-flush']);
    return true;
  } catch {
    return false;
  }
}

// ── driver ────────────────────────────────────────────────────────────────────

/** The slice of node-oracledb this module uses (it ships no types). */
interface OracleBindDef { type: unknown; maxSize?: number }
interface OracleConnection {
  callTimeout: number;
  execute(sql: string, binds?: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ rows?: unknown[][] }>;
  executeMany(sql: string, binds: Record<string, unknown>[], options: Record<string, unknown>): Promise<{
    rowsAffected?: number;
    batchErrors?: Array<{ offset: number; errorNum?: number; message: string }>;
  }>;
  commit(): Promise<void>;
  close(): Promise<void>;
}
export interface OracleDriver {
  STRING: unknown;
  NUMBER: unknown;
  thin: boolean;
  initOracleClient(options?: { libDir?: string }): void;
  getConnection(config: { user: string; password: string; connectString: string }): Promise<OracleConnection>;
}

/** The vendored copy first, so an offline install works; then normal resolution. */
export function loadDriver(): OracleDriver {
  const req = createRequire(import.meta.url);
  const vendored = join(PKG_ROOT, 'vendor', 'oracledb');
  if (existsSync(join(vendored, 'index.js'))) return req(vendored) as OracleDriver;
  return req('oracledb') as OracleDriver;
}

export type DriverMode = 'thick' | 'thin' | 'odpnet';

/** The vendored ODP.NET managed driver (scripts/vendor-odpnet.mjs). */
export const odpnetDllPath = (): string => join(PKG_ROOT, 'vendor', 'odpnet', 'Oracle.ManagedDataAccess.dll');

/** ODP.NET runs through Windows PowerShell, so: Windows, with the DLL shipped. */
export function odpnetAvailable(): boolean {
  return process.platform === 'win32' && existsSync(odpnetDllPath());
}

let thickTried: { ok: boolean; error?: unknown } | null = null;

/** Test seam: forget the once-per-process thick-mode probe. */
export function resetThickProbe(): void {
  thickTried = null;
}

/**
 * Pick the driver per the config. `initOracleClient` may run once per process.
 * `db` is null when node-oracledb could not be loaded; `odpnet` says whether
 * the ODP.NET fallback can run here.
 */
export function chooseMode(db: OracleDriver | null, config: ReportingConfig, odpnet = odpnetAvailable()): DriverMode {
  const mode = config.mode ?? 'auto';
  if (mode === 'odpnet') {
    if (!odpnet) throw new Error('mode odpnet needs Windows and vendor/odpnet/Oracle.ManagedDataAccess.dll');
    return 'odpnet';
  }
  if (mode === 'thin') return 'thin';
  if (db && !thickTried) {
    try {
      db.initOracleClient(config.libDir ? { libDir: config.libDir } : undefined);
      thickTried = { ok: true };
    } catch (e) {
      thickTried = { ok: false, error: e };
    }
  }
  if (db && thickTried?.ok) return 'thick';
  if (mode === 'thick') throw thickTried?.error ?? new Error('the oracledb driver could not be loaded');
  return odpnet ? 'odpnet' : 'thin';
}

// ── SQL ───────────────────────────────────────────────────────────────────────

const IDENT = /^[A-Za-z][A-Za-z0-9_$#]{0,127}$/;

/** `SCHEMA.` or nothing. A schema that is not a plain identifier is refused
 *  rather than spliced into SQL. */
export function schemaPrefix(schema: string | undefined): string {
  if (!schema) return '';
  if (!IDENT.test(schema)) throw new Error(`invalid schema name in the savings-report config: ${schema}`);
  return `${schema}.`;
}

export function insertSql(prefix: string): string {
  return (
    `INSERT INTO ${prefix}${SAVINGS_TABLE} ` +
    '(EVENT_ID, INSTALL_ID, EVENT_KIND, EVENT_TS, EVENT_DAY, CHANNEL, COMMAND, MODEL, ' +
    'SAVED_TOKENS, USD_SAVED, USD_MEASURED, COST_MICROS, TOKENS_BILLED) VALUES ' +
    `(:eventId, :installId, :kind, FROM_TZ(TO_TIMESTAMP(:ts, 'YYYY-MM-DD"T"HH24:MI:SS.FF3'), 'UTC'), ` +
    ':day, :channel, :command, :model, :savedTokens, :usd, :measured, :costMicros, :tokensBilled)'
  );
}

/** One outbox event as insert binds, normalised to what the columns accept. */
export function toBinds(e: ReportEvent): Record<string, unknown> {
  const when = new Date(e.ts);
  const ts = (Number.isNaN(when.getTime()) ? new Date() : when).toISOString().replace(/Z$/, '');
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  return {
    eventId: String(e.eventId).slice(0, 36),
    installId: String(e.installId).slice(0, 36),
    kind: e.kind === 'billing' ? 'billing' : 'saving',
    ts,
    day: /^\d{4}-\d{2}-\d{2}$/.test(e.day) ? e.day : ts.slice(0, 10),
    channel: e.channel ? String(e.channel).slice(0, 10) : null,
    command: e.command ? String(e.command).slice(0, 64) : null,
    model: (e.model ? String(e.model) : 'unknown').slice(0, 200),
    savedTokens: num(e.savedTokens),
    usd: typeof e.usd === 'number' && Number.isFinite(e.usd) ? Math.round(e.usd * 1e6) / 1e6 : null,
    measured: e.measured === null || e.measured === undefined ? null : e.measured ? 1 : 0,
    costMicros: num(e.costMicros),
    tokensBilled: num(e.tokensBilled),
  };
}

/** The insert's string binds with their maximum length, and its number binds. */
const STRING_BINDS: Record<string, number> = { eventId: 36, installId: 36, kind: 10, ts: 40, day: 10, channel: 10, command: 64, model: 200 };
const NUMBER_BINDS = ['savedTokens', 'usd', 'measured', 'costMicros', 'tokensBilled'];

function bindDefs(db: OracleDriver): Record<string, OracleBindDef> {
  const defs: Record<string, OracleBindDef> = {};
  for (const [name, maxSize] of Object.entries(STRING_BINDS)) defs[name] = { type: db.STRING, maxSize };
  for (const name of NUMBER_BINDS) defs[name] = { type: db.NUMBER };
  return defs;
}

/** Kill-switch values that mean "stop reporting" (case-insensitive, trimmed). */
const KILL_VALUE = /^(1|true|yes|y|on)$/i;

/** Whether the kill switch's value means "stop reporting". */
export function killSwitchOn(value: unknown): boolean {
  if (typeof value === 'number') return value === 1;
  return typeof value === 'string' && KILL_VALUE.test(value.trim());
}

const killSql = (prefix: string): string => `SELECT SETTING_VALUE FROM ${prefix}${SETTINGS_TABLE} WHERE SETTING_KEY = :k`;

/** Reads the kill switch. Missing table, missing row or any error: not set. */
async function readKillSwitch(conn: OracleConnection, prefix: string): Promise<boolean> {
  try {
    const r = await conn.execute(killSql(prefix), { k: KILL_SWITCH_KEY });
    return killSwitchOn(r.rows?.[0]?.[0]);
  } catch {
    return false;
  }
}

const isDuplicate = (e: { errorNum?: number; message?: string }): boolean => e.errorNum === 1 || /^ORA-00001\b/.test(e.message ?? '');

// ── flush ─────────────────────────────────────────────────────────────────────

export interface FlushResult {
  /** True when the outbox was delivered (or there was nothing to deliver). */
  ok: boolean;
  /** Why nothing was attempted: the report is off, or no database is configured. */
  skipped?: 'disabled' | 'unconfigured';
  /** The database's kill switch turned the report off during this flush. */
  remoteDisabled?: boolean;
  mode?: DriverMode;
  inserted: number;
  duplicates: number;
  /** Rows the database refused for their content; dropped. */
  rejected: number;
  /** Rows kept for the next flush. */
  kept: number;
  error?: string;
}

export interface FlushOptions {
  home?: string;
  /** Test seam: the driver to use instead of the vendored one. */
  driver?: OracleDriver;
  /** Test seam: the config to use instead of the shipped + user files. */
  config?: ReportingConfig;
  /** Test seam: whether the ODP.NET fallback can run (default: Windows + vendored DLL). */
  odpnetAvailable?: boolean;
  /** Test seam: runs the ODP.NET sender instead of Windows PowerShell. */
  odpnetRunner?: OdpnetRunner;
}

function short(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split('\n')[0].slice(0, 300);
}

/** One flush. Never throws; the outcome is also recorded in the state file. */
export async function runFlush(opts: FlushOptions = {}): Promise<FlushResult> {
  const { home } = opts;
  const result: FlushResult = { ok: false, inserted: 0, duplicates: 0, rejected: 0, kept: 0 };
  const record = (): FlushResult => {
    patchReportingState(
      { lastFlush: { at: new Date().toISOString(), ok: result.ok, sent: result.inserted + result.duplicates, ...(result.error ? { error: result.error } : {}) } },
      home,
    );
    return result;
  };
  try {
    if (!reportingEnabled(home)) return { ...result, skipped: 'disabled' };
    recoverOrphans(home);
    const config = opts.config ?? loadReportingConfig(home).config;
    if (!configComplete(config)) {
      result.skipped = 'unconfigured';
      result.error = 'no database configured (connectString, user and password)';
      return record();
    }
    const prefix = schemaPrefix(config.schema);

    let conn: OracleConnection;
    try {
      let db: OracleDriver | null = opts.driver ?? null;
      let loadError: unknown;
      if (!db && config.mode !== 'odpnet') {
        try { db = loadDriver(); } catch (e) { loadError = e; }
      }
      result.mode = chooseMode(db, config, opts.odpnetAvailable ?? odpnetAvailable());
      if (result.mode === 'odpnet') {
        await flushViaOdpnet(config, prefix, home, result, opts.odpnetRunner ?? runPowerShell);
        return record();
      }
      if (!db) throw loadError ?? new Error('the oracledb driver could not be loaded');
      conn = await db.getConnection({ user: config.user!, password: config.password!, connectString: config.connectString! });
      try { conn.callTimeout = CALL_TIMEOUT_MS; } catch { /* thin before 6.x: not settable */ }
      try {
        if (await readKillSwitch(conn, prefix)) {
          applyRemoteDisable(home, result);
          return record();
        }
        await deliver(conn, db, prefix, home, result);
      } finally {
        try { await conn.close(); } catch { /* already gone */ }
      }
    } catch (e) {
      result.error = short(e);
      return record();
    }
    return record();
  } catch (e) {
    result.error = short(e);
    return record();
  }
}

/** The database's kill switch is on: turn the report off here and drop the queue. */
function applyRemoteDisable(home: string | undefined, result: FlushResult): void {
  patchReportingState({ enabled: false, disabledBy: 'remote', changedAt: new Date().toISOString() }, home);
  clearOutbox(home);
  result.remoteDisabled = true;
  result.ok = true;
}

/** Drain the outbox and insert it batch by batch; whatever is not settled goes back. */
async function deliver(conn: OracleConnection, db: OracleDriver, prefix: string, home: string | undefined, result: FlushResult): Promise<void> {
  const drained = drainOutbox(home);
  const events = drained.events;
  let done = 0;
  try {
    const sql = insertSql(prefix);
    const defs = bindDefs(db);
    for (; done < events.length; done += BATCH_SIZE) {
      const batch = events.slice(done, done + BATCH_SIZE);
      const r = await conn.executeMany(sql, batch.map(toBinds), { autoCommit: false, batchErrors: true, bindDefs: defs });
      await conn.commit();
      const errors = r.batchErrors ?? [];
      const dup = errors.filter(isDuplicate).length;
      result.duplicates += dup;
      result.rejected += errors.length - dup;
      result.inserted += batch.length - errors.length;
      if (errors.length > dup) {
        const first = errors.find((e) => !isDuplicate(e));
        if (first) result.error = `${errors.length - dup} row(s) rejected: ${short(first.message)}`;
      }
    }
    result.ok = result.rejected === 0;
    settleDrain(drained, [], home);
  } catch (e) {
    const rest = events.slice(done);
    result.kept = rest.length;
    result.error = short(e);
    settleDrain(drained, rest, home);
  }
}

// ── ODP.NET (Windows, no Oracle Client) ───────────────────────────────────────

/** The ODP.NET sender is killed after this; its committed batches stay sent. Under FLUSH_WATCHDOG_MS. */
const ODPNET_TIMEOUT_MS = 50 * 1000;

/** What the sender printed (one JSON object per line), how it exited. */
export interface OdpnetRun {
  lines: string[];
  code: number | null;
  stderr: string;
  timedOut?: boolean;
}
/** Runs the sender with `input` on its stdin. Never rejects in the real one. */
export type OdpnetRunner = (input: string) => Promise<OdpnetRun>;

/**
 * The sender, run by Windows PowerShell 5.1 with -EncodedCommand (no script
 * file to ship, nothing on the command line but the script itself).
 *
 * stdin, UTF-8, one JSON object per line: a header (DLL path, credentials,
 * SQL, kill-switch pattern, batch size, binds), then one row per line.
 * stdout, one JSON object per line:
 *   {t:'kill', on, v}                    the kill switch; on = nothing is inserted
 *   {t:'batch', n, ins, dup, rej, err}   one committed batch of n rows
 *   {t:'done'}                           every row settled
 *   {t:'error', msg}                     fatal (load, connect, a broken session)
 * A batch is array-bound in one round trip; when the database refuses it, the
 * batch is rolled back and retried row by row, so ORA-00001 counts as already
 * there and a row refused for its content is dropped, as in the oracledb path.
 * An error that leaves the session unusable is fatal and keeps the rest.
 * The password travels on stdin only, never on a command line.
 */
export const ODPNET_SENDER = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$code = 0
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$stdout = [Console]::Out
function Say($o) { $stdout.WriteLine((ConvertTo-Json -InputObject $o -Compress)); $stdout.Flush() }
function OraEx($e) {
  $x = $e
  while ($null -ne $x -and $x.GetType().FullName -ne 'Oracle.ManagedDataAccess.Client.OracleException') { $x = $x.InnerException }
  return $x
}
function Val($x, $num) {
  if ($null -eq $x) { return [DBNull]::Value }
  if ($num) { return [decimal]$x }
  return [string]$x
}
$conn = $null
try {
  $h = ConvertFrom-Json -InputObject ([Console]::In.ReadLine())
  $rows = New-Object System.Collections.Generic.List[object]
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ($line.Trim()) { $rows.Add((ConvertFrom-Json -InputObject $line)) }
  }
  [void][Reflection.Assembly]::LoadFrom($h.dll)
  $Str = [Oracle.ManagedDataAccess.Client.OracleDbType]::Varchar2
  $Dec = [Oracle.ManagedDataAccess.Client.OracleDbType]::Decimal
  [Oracle.ManagedDataAccess.Client.OracleConfiguration]::SqlNetEncryptionClient = 'accepted'
  [Oracle.ManagedDataAccess.Client.OracleConfiguration]::SqlNetCryptoChecksumClient = 'accepted'
  $b = New-Object Oracle.ManagedDataAccess.Client.OracleConnectionStringBuilder
  $b['User Id'] = [string]$h.user
  $b['Password'] = [string]$h.password
  $b['Data Source'] = [string]$h.dataSource
  $b['Pooling'] = $false
  $b['Connection Timeout'] = [int]$h.timeoutSec
  $conn = New-Object Oracle.ManagedDataAccess.Client.OracleConnection $b.ConnectionString
  $conn.Open()

  function New-Cmd($sql) {
    $c = $conn.CreateCommand()
    $c.BindByName = $true
    $c.CommandTimeout = [int]$h.timeoutSec
    $c.CommandText = $sql
    return $c
  }
  function Add-Bind($c, $name, $num, $value) {
    $p = New-Object Oracle.ManagedDataAccess.Client.OracleParameter
    $p.ParameterName = $name
    if ($num) { $p.OracleDbType = $Dec } else { $p.OracleDbType = $Str }
    $p.Value = $value
    [void]$c.Parameters.Add($p)
  }
  function Insert-Array($batch) {
    $c = New-Cmd $h.insertSql
    $c.ArrayBindCount = $batch.Count
    foreach ($bd in $h.binds) {
      $num = $bd[1] -eq 'n'
      $vals = New-Object 'object[]' $batch.Count
      for ($j = 0; $j -lt $batch.Count; $j++) { $vals[$j] = Val ($batch[$j].($bd[0])) $num }
      Add-Bind $c $bd[0] $num $vals
    }
    [void]$c.ExecuteNonQuery()
  }
  function Insert-Row($row) {
    $c = New-Cmd $h.insertSql
    foreach ($bd in $h.binds) {
      $num = $bd[1] -eq 'n'
      Add-Bind $c $bd[0] $num (Val ($row.($bd[0])) $num)
    }
    [void]$c.ExecuteNonQuery()
  }
  function Alive() {
    try { $c = New-Cmd 'SELECT 1 FROM DUAL'; [void]$c.ExecuteScalar(); return $true } catch { return $false }
  }

  $v = $null
  try {
    $k = New-Cmd $h.killSql
    Add-Bind $k 'k' $false ([string]$h.killKey)
    $r = $k.ExecuteScalar()
    if ($null -ne $r -and -not ($r -is [DBNull])) { $v = [string]$r }
  } catch { $v = $null }
  $on = ($null -ne $v) -and ($v.Trim() -match $h.killPattern)
  Say @{ t = 'kill'; on = $on; v = $v }

  if (-not $on) {
    for ($i = 0; $i -lt $rows.Count; $i += $h.batchSize) {
      $n = [Math]::Min([int]$h.batchSize, $rows.Count - $i)
      $batch = $rows.GetRange($i, $n)
      $ins = 0; $dup = 0; $rej = 0; $err = $null
      $tx = $conn.BeginTransaction()
      try {
        Insert-Array $batch
        $tx.Commit()
        $ins = $n
      } catch {
        if ($null -eq (OraEx $_.Exception)) { throw }
        $tx.Rollback()
        if (-not (Alive)) { throw }
        $tx = $conn.BeginTransaction()
        foreach ($row in $batch) {
          try {
            Insert-Row $row
            $ins++
          } catch {
            $ox = OraEx $_.Exception
            if ($null -eq $ox) { throw }
            if ($ox.Number -eq 1) { $dup++ }
            elseif (Alive) { $rej++; if ($null -eq $err) { $err = $ox.Message } }
            else { throw }
          }
        }
        $tx.Commit()
      }
      Say @{ t = 'batch'; n = $n; ins = $ins; dup = $dup; rej = $rej; err = $err }
    }
  }
  Say @{ t = 'done' }
} catch {
  $code = 1
  $ox = OraEx $_.Exception
  if ($null -ne $ox) { $m = $ox.Message } else { $m = $_.Exception.Message }
  try { Say @{ t = 'error'; msg = [string]$m } } catch { }
} finally {
  if ($null -ne $conn) { try { $conn.Close() } catch { } }
}
exit $code
`;

/** The insert's binds for the sender: name and 's' (string) or 'n' (number). */
const ODPNET_BINDS: Array<[string, 's' | 'n']> = [
  ...Object.keys(STRING_BINDS).map((name): [string, 's'] => [name, 's']),
  ...NUMBER_BINDS.map((name): [string, 'n'] => [name, 'n']),
];

function powershellExe(): string {
  const full = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(full) ? full : 'powershell.exe';
}

/** The real runner: Windows PowerShell 5.1, hidden, killed after ODPNET_TIMEOUT_MS. */
export const runPowerShell: OdpnetRunner = (input) =>
  new Promise((resolve) => {
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ lines: out.split(/\r?\n/).filter((l) => l.trim()), code, stderr: err, timedOut });
    };
    const encoded = Buffer.from(ODPNET_SENDER, 'utf16le').toString('base64');
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(powershellExe(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      err = short(e);
      resolve({ lines: [], code: null, stderr: err });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* already gone */ }
    }, ODPNET_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => { if (err.length < 4000) err += d; });
    child.on('error', (e) => { err += short(e); finish(null); });
    child.on('close', (code) => finish(code));
    child.stdin?.on('error', () => { /* the sender died early; its exit says why */ });
    child.stdin?.end(input, 'utf8');
  });

/** The ODP.NET path of a flush: one sender run for the whole outbox. */
async function flushViaOdpnet(
  config: ReportingConfig,
  prefix: string,
  home: string | undefined,
  result: FlushResult,
  runner: OdpnetRunner,
): Promise<void> {
  const drained = drainOutbox(home);
  const events = drained.events;
  const header = {
    dll: odpnetDllPath(),
    user: config.user,
    password: config.password,
    dataSource: config.connectString,
    timeoutSec: CALL_TIMEOUT_MS / 1000,
    killSql: killSql(prefix),
    killKey: KILL_SWITCH_KEY,
    killPattern: KILL_VALUE.source,
    insertSql: insertSql(prefix),
    batchSize: BATCH_SIZE,
    binds: ODPNET_BINDS,
  };
  const input = [header, ...events.map(toBinds)].map((o) => JSON.stringify(o)).join('\n') + '\n';

  let run: OdpnetRun;
  try {
    run = await runner(input);
  } catch (e) {
    result.kept = events.length;
    result.error = short(e);
    settleDrain(drained, events, home);
    return;
  }

  const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  let done = 0;
  let finished = false;
  let killed = false;
  let fatal: string | undefined;
  for (const line of run.lines) {
    let m: Record<string, unknown>;
    try { m = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!m || typeof m !== 'object') continue;
    if (m.t === 'kill') killed = m.on === true || killSwitchOn(m.v);
    else if (m.t === 'batch') {
      const dup = count(m.dup);
      const rej = count(m.rej);
      done += count(m.n);
      result.inserted += count(m.ins);
      result.duplicates += dup;
      result.rejected += rej;
      if (rej && typeof m.err === 'string') result.error = `${rej} row(s) rejected: ${short(m.err)}`;
    } else if (m.t === 'done') finished = true;
    else if (m.t === 'error') fatal = short(m.msg ?? 'unknown error');
  }

  if (killed) {
    settleDrain(drained, [], home);
    applyRemoteDisable(home, result);
    return;
  }
  const rest = finished ? [] : events.slice(done);
  result.kept = rest.length;
  settleDrain(drained, rest, home);
  if (finished) {
    result.ok = result.rejected === 0;
    return;
  }
  const stderr = run.stderr.trim();
  result.error =
    fatal ??
    (run.timedOut
      ? `the ODP.NET sender timed out after ${ODPNET_TIMEOUT_MS / 1000}s`
      : `the ODP.NET sender exited with code ${run.code ?? 'unknown'}${stderr ? `: ${short(stderr)}` : ''}`);
}
