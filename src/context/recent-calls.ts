/**
 * The last few graft calls in a repo, each with the saving its footer claimed.
 *
 * Two things need to know what graft printed a moment ago, and neither can get
 * it from the ledger (`claude/ledger.ts`), which is bucketed by day and model:
 *
 *  - `graft savings --last`, the recovery path for an agent that cut the savings
 *    line out of graft's output (a `Select-Object -First`, `head`, `findstr`, or
 *    `Select-String` filter). It reprints this turn's calls and the tally to
 *    close the reply with, from the figures the footers used, not recomputed.
 *  - the short form of the savings nudge: a call that follows another one by a
 *    few minutes gets the figure and the example without the paragraph around
 *    them, which the agent has just read (see `savingsTurnNudge`).
 *
 * Kept in the repo's own `graft/.cache/`, capped in length and age, and never
 * allowed to fail a call: every reader and writer here swallows its errors.
 */
import { join } from 'node:path';
import { cacheDir, readJson, writeJsonAtomic } from '../util/state.js';
import { formatDollars } from './price.js';
import { formatCount } from './savings.js';
import { brand } from '../brand.js';

/** One graft call that claimed a saving. */
export interface RecentCall {
  /** When it ran (ISO 8601). */
  at: string;
  /** The command or tool, e.g. `ask` or `graft_find_code`. */
  command: string;
  /** Tokens its footer claimed. */
  tokens: number;
  /** Their dollar value at the rate the footer used, or null when it priced nothing. */
  usd: number | null;
  /** The model the example tally named, or null. */
  model: string | null;
  /** The rate was this session's measured billing rather than a list price. */
  measured?: boolean;
  /** The warning lines the example tally carried (build --deep, init, prices update). */
  warnings?: string;
}

/**
 * Calls further apart than this are not one turn. Also the window in which a
 * call counts as "just after another one" for the short nudge.
 */
export const TURN_GAP_MS = 10 * 60 * 1000;

/** Kept at most: enough for a long turn, small enough to rewrite on every call. */
const MAX_KEPT = 50;

/** Dropped once older than this, whatever the count. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface RecentCallsFile {
  calls: RecentCall[];
}

export function recentCallsPath(dir: string): string {
  return join(cacheDir(dir), 'recent-calls.json');
}

/** Every remembered call, oldest first, minus anything malformed. */
export function readRecentCalls(dir: string): RecentCall[] {
  try {
    const f = readJson<RecentCallsFile>(recentCallsPath(dir));
    if (!f || !Array.isArray(f.calls)) return [];
    return f.calls.filter(
      (c) => c && typeof c.at === 'string' && !Number.isNaN(Date.parse(c.at)) && typeof c.tokens === 'number' && c.tokens > 0,
    );
  } catch {
    return [];
  }
}

/** Remember one call. A no-op for a call that claimed nothing. */
export function recordRecentCall(dir: string, call: Omit<RecentCall, 'at'>, when: Date = new Date()): void {
  if (!(call.tokens > 0)) return;
  try {
    const cutoff = when.getTime() - MAX_AGE_MS;
    const calls = readRecentCalls(dir).filter((c) => Date.parse(c.at) >= cutoff);
    calls.push({ ...call, at: when.toISOString() });
    writeJsonAtomic(recentCallsPath(dir), { calls: calls.slice(-MAX_KEPT) } satisfies RecentCallsFile);
  } catch {
    // Losing one entry costs a recovery line, never the call.
  }
}

/** Whether another graft call in this repo claimed a saving within {@link TURN_GAP_MS}. */
export function calledRecently(dir: string, now: Date = new Date()): boolean {
  const last = readRecentCalls(dir).at(-1);
  if (!last) return false;
  const age = now.getTime() - Date.parse(last.at);
  return age >= 0 && age < TURN_GAP_MS;
}

/**
 * The latest run of calls: walking back from the newest, every call less than
 * {@link TURN_GAP_MS} after the one before it. That is the closest a CLI can get
 * to "this turn" without seeing the conversation.
 */
export function lastTurnCalls(calls: RecentCall[]): RecentCall[] {
  if (calls.length === 0) return [];
  let i = calls.length - 1;
  while (i > 0 && Date.parse(calls[i].at) - Date.parse(calls[i - 1].at) < TURN_GAP_MS) i--;
  return calls.slice(i);
}

/**
 * The tally to close a reply with, summed over `calls`, in the same shapes the
 * footers use. Dollars appear only when every call was priced under the same
 * model, because adding a priced figure to an unpriced one would show a total
 * that covers only part of the tokens. Warnings come from the newest call.
 */
export function summedTally(calls: RecentCall[]): string {
  const b = brand();
  const tokens = calls.reduce((n, c) => n + c.tokens, 0);
  const priced = calls.length > 0 && calls.every((c) => c.usd !== null);
  const models = new Set(calls.map((c) => c.model ?? ''));
  const measured = calls.every((c) => c.measured === true);
  let line = `\u{1F331} ${b} saved ~${formatCount(tokens)} tokens by this turn`;
  if (priced && models.size === 1) {
    const usd = formatDollars(calls.reduce((n, c) => n + (c.usd ?? 0), 0));
    const model = [...models][0];
    line = model && !measured
      ? `\u{1F331} ${b} saved ~${formatCount(tokens)} tokens (~${usd} for ${model}) this turn`
      : `\u{1F331} ${b} saved ~${formatCount(tokens)} tokens (~${usd}) this turn`;
  }
  return line + (calls.at(-1)?.warnings ?? '');
}

/** What `graft savings --last` prints: this turn's calls, then the tally. */
export function formatLastCalls(all: RecentCall[], now: Date = new Date()): string {
  const b = brand();
  const calls = lastTurnCalls(all);
  if (calls.length === 0) {
    return (
      `${b} has no recent calls on record in this repo that claimed a saving, so there is no tally to report. ` +
      'Do not invent one.'
    );
  }
  const newest = Date.parse(calls.at(-1)!.at);
  const ago = Math.max(0, Math.round((now.getTime() - newest) / 60_000));
  const rows = calls.map((c) => {
    const time = new Date(c.at).toTimeString().slice(0, 8);
    const worth = c.usd !== null ? ` (${formatDollars(c.usd)}${c.model ? ` for ${c.model}` : ''})` : '';
    return `  ${time}  ${c.command.padEnd(18)} ~${formatCount(c.tokens)} tokens${worth}`;
  });
  return [
    `${b} calls this turn (${calls.length}; the newest ${ago === 0 ? 'under a minute' : `${ago} min`} ago):`,
    ...rows,
    '',
    'Close your reply with this line, plus any graft calls made after it:',
    summedTally(calls),
  ].join('\n');
}
