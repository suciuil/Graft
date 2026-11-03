/**
 * Remote savings report: the local half. Opt-in, off by default.
 *
 * When the user has run `graft savings-report enable`, every saving and every
 * billing sample graft files in a repo's ledger (src/claude/ledger.ts) is also
 * appended here, to an outbox in `~/.graft/`, and a detached child
 * (`graft _savings-report-flush`, src/reporting/flush.ts) later inserts the
 * batch into the company's Oracle database for analytics.
 *
 * What a row carries is fixed by {@link ReportEvent}: a random install id (the
 * same `randomUUID()` the disabled telemetry minted, see telemetry/identity.ts),
 * the day, the model, token and dollar figures, and which graft surface filed
 * it. No repo path, repo name, user name, host name or query text — the owner's
 * decision recorded in docs/no-cloud-policy.md.
 *
 * Nothing here ever throws or prints: a command must not notice the report.
 */
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from '../util/state.js';
import { appendPrivateFile, writePrivateFile } from '../util/private-file.js';
import { installId } from '../telemetry/identity.js';

/** The repo / package root, from `src/reporting/` and `dist/reporting/` alike. */
export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The folder holding the reporting state, outbox and user config: `~/.graft/`.
 * `GRAFT_REPORTING_HOME` points it at a scratch home instead — used by the test
 * runner, so a developer who has reporting enabled never ships test events.
 */
export function reportingDir(home?: string): string {
  if (home) return join(home, '.graft');
  const override = process.env.GRAFT_REPORTING_HOME;
  return join(override && override.trim() ? override : homedir(), '.graft');
}

export const statePath = (home?: string): string => join(reportingDir(home), 'savings-report-state.json');
export const outboxPath = (home?: string): string => join(reportingDir(home), 'savings-report-outbox.ndjson');
export const userConfigPath = (home?: string): string => join(reportingDir(home), 'savings-report.json');
export const shippedConfigPath = (): string => join(PKG_ROOT, 'config', 'savings-report.json');

// ── state ─────────────────────────────────────────────────────────────────────

export interface ReportingState {
  /** The user's choice. Absent = never chosen = off. */
  enabled?: boolean;
  /** Who turned it off last: the user, or the database's kill switch. */
  disabledBy?: 'user' | 'remote';
  changedAt?: string;
  /** Epoch ms of the last background flush attempt (throttle). */
  flushedAt?: number;
  /** Outcome of the last flush that reached the point of trying. */
  lastFlush?: { at: string; ok: boolean; sent: number; error?: string };
}

export function readReportingState(home?: string): ReportingState {
  return readJson<ReportingState>(statePath(home)) ?? {};
}

export function patchReportingState(patch: Partial<ReportingState>, home?: string): ReportingState {
  const next = { ...readReportingState(home), ...patch };
  try { writeJsonAtomic(statePath(home), next); } catch { /* unwritable home: nothing to report from anyway */ }
  return next;
}

/** On only after an explicit `graft savings-report enable`. */
export function reportingEnabled(home?: string): boolean {
  return readReportingState(home).enabled === true;
}

// ── config ────────────────────────────────────────────────────────────────────

export type OracleMode = 'auto' | 'thick' | 'thin' | 'odpnet';

export interface ReportingConfig {
  connectString?: string;
  user?: string;
  password?: string;
  /**
   * `thick` needs an Oracle Client; `odpnet` is Oracle's managed .NET driver,
   * vendored, Windows only; `thin` is pure JS (no Native Network Encryption);
   * `auto` tries thick, then odpnet on Windows, then thin.
   */
  mode?: OracleMode;
  /** Oracle Client folder for thick mode; default: the system's (PATH). */
  libDir?: string;
  /** Owner of the two tables, when it is not the connecting user. */
  schema?: string;
}

export interface LoadedConfig {
  config: ReportingConfig;
  /** The files that contributed, shipped first. */
  sources: string[];
}

/**
 * The shipped `config/savings-report.json`, overlaid field by field with the
 * user's `~/.graft/savings-report.json`. Unknown keys are ignored.
 */
export function loadReportingConfig(home?: string, shipped: string = shippedConfigPath()): LoadedConfig {
  const config: ReportingConfig = {};
  const sources: string[] = [];
  for (const path of [shipped, userConfigPath(home)]) {
    const raw = readJson<Record<string, unknown>>(path);
    if (!raw || typeof raw !== 'object') continue;
    sources.push(path);
    for (const key of ['connectString', 'user', 'password', 'libDir', 'schema'] as const) {
      const v = raw[key];
      if (typeof v === 'string' && v.trim()) config[key] = v.trim();
    }
    if (raw.mode === 'auto' || raw.mode === 'thick' || raw.mode === 'thin' || raw.mode === 'odpnet') config.mode = raw.mode;
  }
  return { config, sources };
}

export function configComplete(c: ReportingConfig): boolean {
  return Boolean(c.connectString && c.user && c.password);
}

// ── events and outbox ─────────────────────────────────────────────────────────

export type ReportChannel = 'cli' | 'mcp' | 'hook';

/** Who filed a ledger entry, passed along by the ledger's callers. */
export interface ReportMeta {
  channel: ReportChannel;
  command?: string;
  /** The dollar value the footer claimed for a saving, when it priced one. */
  usd?: number | null;
  measured?: boolean;
}

export interface ReportEvent {
  eventId: string;
  installId: string;
  kind: 'saving' | 'billing';
  /** ISO UTC instant. */
  ts: string;
  /** `yyyy-mm-dd`, the same local-day key the ledger files under. */
  day: string;
  channel: ReportChannel | null;
  command: string | null;
  /** Canonical ledger key (`claude-opus-5`, `unknown`). */
  model: string;
  savedTokens: number;
  usd: number | null;
  measured: boolean | null;
  costMicros: number;
  tokensBilled: number;
}

/** Bound on the outbox: a machine that never reaches the database must not grow
 *  a file forever. Oldest rows go first. */
export const MAX_OUTBOX_BYTES = 1024 * 1024;
export const TRIM_TO_EVENTS = 5000;

export interface QueueInput {
  kind: 'saving' | 'billing';
  when: Date;
  day: string;
  model: string;
  savedTokens?: number;
  costMicros?: number;
  tokensBilled?: number;
  meta?: ReportMeta;
}

/**
 * Queue one ledger entry for the report, and start a background flush when one
 * is due. A no-op unless reporting is enabled. Never throws.
 */
export function queueReport(input: QueueInput, home?: string): void {
  try {
    if (!reportingEnabled(home)) return;
    const meta = input.meta;
    const usd = typeof meta?.usd === 'number' && Number.isFinite(meta.usd) ? meta.usd : null;
    const event: ReportEvent = {
      eventId: randomUUID(),
      installId: installId(home).id,
      kind: input.kind,
      ts: input.when.toISOString(),
      day: input.day,
      channel: meta?.channel ?? null,
      command: meta?.command ? meta.command.slice(0, 64) : null,
      model: input.model.slice(0, 200),
      savedTokens: Math.max(0, Math.round(input.savedTokens ?? 0)),
      usd: input.kind === 'saving' ? usd : null,
      measured: input.kind === 'saving' && usd !== null ? meta?.measured === true : null,
      costMicros: Math.max(0, Math.round(input.costMicros ?? 0)),
      tokensBilled: Math.max(0, Math.round(input.tokensBilled ?? 0)),
    };
    enqueueEvents([event], home);
    // Imported lazily: the flush side (spawn, driver loading) is never needed
    // by a command whose report is off, which is nearly every command.
    // GRAFT_REPORTING_NO_FLUSH=1 (set by the test runner) only queues: a test
    // must never start a real send.
    if (process.env.GRAFT_REPORTING_NO_FLUSH === '1') return;
    void import('./flush.js').then((m) => m.maybeFlushInBackground(home)).catch(() => {});
  } catch { /* a report is never worth an error */ }
}

export function enqueueEvents(events: ReportEvent[], home?: string): void {
  if (events.length === 0) return;
  const path = outboxPath(home);
  try {
    appendPrivateFile(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    trim(path);
  } catch { /* unwritable home, full disk */ }
}

function parseLines(text: string): ReportEvent[] {
  const out: ReportEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as ReportEvent;
      if (e && typeof e.eventId === 'string' && typeof e.installId === 'string') out.push(e);
    } catch { /* torn line: just this one */ }
  }
  return out;
}

function trim(path: string): void {
  let size: number;
  try { size = statSync(path).size; } catch { return; }
  if (size <= MAX_OUTBOX_BYTES) return;
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const kept: string[] = [];
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0 && kept.length < TRIM_TO_EVENTS; i--) {
      bytes += Buffer.byteLength(lines[i]) + 1;
      if (bytes > MAX_OUTBOX_BYTES) break;
      kept.push(lines[i]);
    }
    kept.reverse();
    writePrivateFile(path, kept.length ? kept.join('\n') + '\n' : '');
  } catch { /* the next drain clears it */ }
}

/** Read without draining, for `graft savings-report status`. */
export function peekOutbox(home?: string): ReportEvent[] {
  try { return parseLines(readFileSync(outboxPath(home), 'utf8')); } catch { return []; }
}

export interface Drained {
  events: ReportEvent[];
  /** The renamed outbox the batch was read from; removed once the batch is settled. */
  file: string | null;
}

/** A `.sending` file older than this belongs to a flush that died (watchdog,
 *  power loss) before settling its batch; its rows go back in the outbox. */
export const ORPHAN_AGE_MS = 10 * 60 * 1000;

/**
 * Take everything pending. The rename makes it safe against concurrent appends:
 * from then on other processes write to a fresh outbox. The renamed file stays
 * on disk until {@link settleDrain}, so a flush killed mid-insert loses nothing:
 * the next flush recovers it ({@link recoverOrphans}) and the primary key on
 * EVENT_ID turns any row that did get in into a harmless duplicate.
 */
export function drainOutbox(home?: string): Drained {
  const path = outboxPath(home);
  const taken = `${path}.${process.pid}.${Date.now()}.sending`;
  try { renameSync(path, taken); } catch { return { events: [], file: null }; }
  let text = '';
  try { text = readFileSync(taken, 'utf8'); } catch { /* fall through */ }
  return { events: parseLines(text), file: taken };
}

/** Finish a drained batch: put `undelivered` back (oldest first, ahead of
 *  anything queued since) and remove the drained file. */
export function settleDrain(drained: Drained, undelivered: ReportEvent[], home?: string): void {
  if (undelivered.length > 0) requeueEvents(undelivered, home);
  if (drained.file) {
    try { rmSync(drained.file, { force: true }); } catch { /* best effort */ }
  }
}

/** Put an undelivered batch back, ahead of anything queued since the drain. */
export function requeueEvents(events: ReportEvent[], home?: string): void {
  if (events.length === 0) return;
  const path = outboxPath(home);
  try {
    let pending = '';
    try { pending = readFileSync(path, 'utf8'); } catch { /* none */ }
    writePrivateFile(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n' + pending);
    trim(path);
  } catch { /* best effort */ }
}

/** Return the rows of dead flushes' `.sending` files to the outbox. */
export function recoverOrphans(home?: string, now = Date.now()): number {
  const dir = reportingDir(home);
  const prefix = `${basename(outboxPath(home))}.`;
  let recovered = 0;
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.sending')) continue;
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs < ORPHAN_AGE_MS) continue;
      const events = parseLines(readFileSync(file, 'utf8'));
      requeueEvents(events, home);
      rmSync(file, { force: true });
      recovered += events.length;
    } catch { /* leave it for the next flush */ }
  }
  return recovered;
}

/** Drop everything pending: the user or the kill switch turned the report off. */
export function clearOutbox(home?: string): void {
  const prefix = `${basename(outboxPath(home))}.`;
  try { rmSync(outboxPath(home), { force: true }); } catch { /* best effort */ }
  try {
    for (const name of readdirSync(reportingDir(home))) {
      if (name.startsWith(prefix) && name.endsWith('.sending')) rmSync(join(reportingDir(home), name), { force: true });
    }
  } catch { /* best effort */ }
}
