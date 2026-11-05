/**
 * `graft savings-report <enable|disable|status|flush>`: the user's switch for
 * the opt-in remote savings report (src/reporting/store.ts, flush.ts).
 */
import { installId } from '../telemetry/identity.js';
import {
  clearOutbox,
  configComplete,
  loadReportingConfig,
  patchReportingState,
  peekOutbox,
  readReportingState,
  type ReportingState,
} from './store.js';
import { FLUSH_WATCHDOG_MS, odpnetAvailable, runFlush, type FlushResult } from './flush.js';

const WHAT_IS_SENT =
  "each saving and billing entry graft files in a repo's ledger: a random install id, the day and time, the model, " +
  'the tokens saved or billed, their dollar value, which graft surface filed it (cli / mcp / hook) with its command, ' +
  'and which AI assistant and editor or terminal ran graft, with their versions (e.g. Kilo Code 7.8.18, Visual Studio Code 1.144.0). ' +
  'No repo name or path, user name, machine host name, file name or query text.';

function stateLine(s: ReportingState): string {
  if (s.enabled === true) return 'savings report: on';
  if (s.disabledBy === 'remote') {
    return `savings report: off — turned off by the database's kill switch${s.changedAt ? ` (${s.changedAt})` : ''}; \`graft savings-report enable\` turns it back on, and the switch is checked again before every send`;
  }
  if (s.disabledBy === 'user') return `savings report: off — turned off with \`graft savings-report disable\`${s.changedAt ? ` (${s.changedAt})` : ''}`;
  return 'savings report: off (the default) — `graft savings-report enable` turns it on';
}

function databaseLine(home?: string): string[] {
  const { config, sources } = loadReportingConfig(home);
  const db = configComplete(config)
    ? `${config.user}@${config.connectString} (mode ${config.mode ?? 'auto'}${config.libDir ? `, Oracle Client ${config.libDir}` : ''}${config.schema ? `, schema ${config.schema}` : ''}` +
      `${(config.mode ?? 'auto') === 'auto' && odpnetAvailable() ? '; without an Oracle Client: ODP.NET managed driver' : ''})`
    : 'not configured — needs connectString, user and password in config/savings-report.json (shipped with graft) or ~/.graft/savings-report.json';
  return [`  database:    ${db}`, `  config:      ${sources.length ? sources.join(', ') : '(none found)'}`];
}

export function formatReportingStatus(home?: string): string {
  const s = readReportingState(home);
  const lines = [stateLine(s), `  install id:  ${installId(home).id}`, ...databaseLine(home), `  queued:      ${peekOutbox(home).length} row(s)`];
  if (s.lastFlush) {
    const f = s.lastFlush;
    lines.push(`  last flush:  ${f.at} — ${f.ok ? `ok, ${f.sent} row(s) delivered` : `failed${f.sent ? ` after ${f.sent} row(s)` : ''}: ${f.error ?? 'unknown error'}`}`);
  }
  lines.push(`  sends:       ${WHAT_IS_SENT}`);
  return lines.join('\n');
}

export function enableReporting(home?: string): string {
  patchReportingState({ enabled: true, disabledBy: undefined, changedAt: new Date().toISOString() }, home);
  const id = installId(home).id;
  const { config } = loadReportingConfig(home);
  const lines = [
    'savings report: on.',
    `  From now on graft queues ${WHAT_IS_SENT}`,
    '  A background process sends the queue to the company database at most every 5 minutes; nothing ever waits on it and errors are silent.',
    `  Install id: ${id}. \`graft savings-report disable\` turns it off and discards anything not yet sent.`,
  ];
  if (!configComplete(config)) lines.push('  ! no database is configured yet, so entries are only queued — see `graft savings-report status`.');
  return lines.join('\n');
}

export function disableReporting(home?: string): string {
  patchReportingState({ enabled: false, disabledBy: 'user', changedAt: new Date().toISOString() }, home);
  clearOutbox(home);
  return 'savings report: off. Nothing more is queued or sent, and the entries not yet sent were discarded.';
}

export function formatFlushResult(r: FlushResult): string {
  if (r.skipped === 'disabled') return 'savings report is off — nothing to send (`graft savings-report enable` turns it on)';
  if (r.skipped === 'unconfigured') return `✗ ${r.error}`;
  if (r.remoteDisabled) return "savings report: turned OFF by the database's kill switch (DISABLE_COST_SAVINGS_REPORTING). The queue was discarded; nothing was sent.";
  const mode = r.mode ? ` (${r.mode} mode)` : '';
  const counts = `${r.inserted} inserted, ${r.duplicates} already there, ${r.rejected} rejected, ${r.kept} kept for the next flush`;
  if (r.ok) return `✓ savings report flushed${mode}: ${counts}`;
  return `✗ savings report flush failed${mode}: ${r.error ?? 'unknown error'}\n  ${counts}`;
}

/** The foreground flush, bounded like the background one. */
export async function flushNow(home?: string): Promise<FlushResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<FlushResult>((res) => {
    timer = setTimeout(
      () => res({ ok: false, inserted: 0, duplicates: 0, rejected: 0, kept: peekOutbox(home).length, error: `timed out after ${FLUSH_WATCHDOG_MS / 1000}s` }),
      FLUSH_WATCHDOG_MS,
    );
    timer.unref();
  });
  try {
    return await Promise.race([runFlush({ home }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
