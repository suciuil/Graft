/**
 * The model Kilo Code is running right now, read from Kilo's own session store.
 *
 * This is the backstop for the one gap `--agent-model` cannot close on its own.
 * Over MCP nothing in the protocol names the model: `initialize` carries the
 * CLIENT's name and version, `tools/call` carries only the tool's arguments, and
 * no host stamps a transcript graft can read. So graft asks the agent to name
 * itself, via the `model` tool argument (see `mcp/tools.ts`).
 *
 * Measured against a real machine's Kilo history, that ask is honoured on a
 * small minority of calls: a strong model sends it when the rule file is fresh
 * in context and stops once the conversation grows, and the faster models never
 * send it at all. Every call that omits it is filed under `unknown` and reported
 * in tokens — which is most of them, which makes `graft savings` mostly an
 * unpriced column. An instruction that three models out of four ignore is not a
 * mechanism.
 *
 * Kilo, alone among MCP hosts, keeps the answer somewhere graft can read it:
 * a SQLite database at `~/.local/share/kilo/kilo.db`, whose `session` table has
 * one row per session with the working directory and the model as JSON:
 *
 *     directory  D:/work/some-repo
 *     model      {"id":"vertex_ai/claude-opus-5","providerID":"a","variant":""}
 *
 * ## Why this is a fact and not a guess
 *
 * `ledger.ts` is emphatic that a model read off disk must never price a saving,
 * and that rule stands. What it forbids is a STANDING DECLARATION — `model` in
 * `.graft/config.json`, `GRAFT_AGENT_MODEL` in a shell profile — a value written
 * once that keeps pricing confidently months after the user switched models. The
 * failure was that such a value cannot go stale VISIBLY: it renders exactly like
 * a correct one.
 *
 * A session row is the opposite kind of fact. It is written by Kilo, per
 * session, and updated as the session runs; it names the model of the very
 * conversation now calling this tool. That is the same class of evidence as
 * Claude Code's transcript stamp, which graft already ranks `certain` — so it
 * enters through the same `stamped` parameter of {@link resolveModel} rather
 * than through a new privileged path, and the agent's own `model` argument still
 * outranks it (see `ledger.ts`).
 *
 * ## What it does not claim
 *
 * The row is matched on the working directory, so two Kilo sessions open on the
 * SAME directory with different models resolve to whichever was updated last.
 * That is a real limit and the reason this is a fallback rather than the primary
 * source: an agent that sends `model` is still priced by what it said, never by
 * this. Rather than pretend otherwise, {@link kiloSessionModel} refuses a row
 * that has not been touched recently ({@link MAX_SESSION_AGE_MS}), so a stale
 * database left behind by an uninstalled Kilo prices nothing.
 *
 * Everything here is best-effort and silent on failure. `node:sqlite` landed in
 * Node 22.5 and this package supports >=20, the file may be locked by the
 * running Kilo, and the schema belongs to somebody else's project and may
 * change. Each of those returns null, which is precisely today's behaviour.
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { canonicalModelKey } from '../context/price.js';

/**
 * How recently Kilo must have touched a session row for it to name the model of
 * the call now arriving.
 *
 * The MCP server is spawned by the host it answers, so a tool call always
 * belongs to a live session — but `time_updated` advances per message, not per
 * tool call, and a long agent turn can run many minutes between writes. Six
 * hours is far longer than any single turn and far shorter than the weeks a
 * database sits around after someone stops using a repo, which is the case this
 * bound exists to exclude.
 */
export const MAX_SESSION_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * How recently a session must have been written to count as the one mid-turn.
 *
 * Only consulted to break a tie between several live sessions on one directory
 * (see {@link kiloSessionModel}). A tool call arrives while the host is
 * streaming a turn, and the host rewrites that session's row on every message,
 * so the calling session's row is seconds old. An idle chat in another tab is
 * minutes old at best.
 *
 * Two minutes rather than seconds because a turn can stall on a slow tool call
 * or a permission prompt between writes, and the cost of being too tight here is
 * an unpriced saving rather than a wrong one.
 */
const ACTIVE_TURN_MS = 2 * 60 * 1000;

/**
 * Kilo's data directory, in the order the releases have used.
 *
 * `~/.local/share/kilo` is the current location on every platform (Kilo follows
 * the XDG layout even on Windows); `XDG_DATA_HOME` overrides it where the user
 * has set one.
 */
function dbCandidates(home: string, env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = [];
  const xdg = env.XDG_DATA_HOME;
  if (xdg && xdg.trim()) paths.push(join(xdg.trim(), 'kilo', 'kilo.db'));
  paths.push(join(home, '.local', 'share', 'kilo', 'kilo.db'));
  return paths;
}

/** The first Kilo database that exists, or null. */
export function kiloDbPath(opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): string | null {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  for (const p of dbCandidates(home, env)) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* unreadable — try the next */
    }
  }
  return null;
}

/**
 * `node:sqlite`, or null on a runtime without it.
 *
 * Resolved lazily through `process.getBuiltinModule` rather than imported at
 * module scope. A static `import 'node:sqlite'` is resolved when this module
 * loads, so on Node 20 it would throw at import time and take down every surface
 * that merely mentions savings — including the CLI, which has nothing to do with
 * Kilo. The cache makes the failure cost one attempt per process, not one per
 * call.
 */
type SqliteModule = { DatabaseSync: new (path: string, opts?: object) => any };

let sqliteModule: SqliteModule | null | undefined;

function loadSqlite(): SqliteModule | null {
  if (sqliteModule !== undefined) return sqliteModule;
  let resolved: SqliteModule | null = null;
  try {
    // `process.getBuiltinModule` is itself Node >=22.3, so the optional call is
    // the version check: on Node 20 it is undefined and we stop here.
    const mod = process.getBuiltinModule?.('node:sqlite') as SqliteModule | undefined;
    if (mod && typeof mod.DatabaseSync === 'function') resolved = mod;
  } catch {
    resolved = null;
  }
  sqliteModule = resolved;
  return resolved;
}

/**
 * Kilo writes `directory` with posix separators even on Windows, and without a
 * trailing slash. Normalising both sides means a repo root graft resolved as
 * `D:\work\repo` matches the row Kilo wrote as `D:/work/repo`.
 *
 * Case is folded because Windows paths are case-insensitive and the two
 * processes need not agree on the drive letter's case.
 */
function normalizeDir(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * JSON literals that mean "no value" but survive a round trip through a TEXT
 * column as ordinary-looking words. Without this, a row Kilo wrote as a
 * JSON-encoded null is read back as a model literally named "null" — filed under
 * that name in the ledger, and priced by nothing, which is a worse outcome than
 * the honest `unknown` it should have produced.
 */
const NOT_A_MODEL = new Set(['null', 'undefined']);

/**
 * The model id out of Kilo's `session.model` column, which holds a JSON object
 * (`{"id":"…","providerID":"…","variant":"…"}`). A plain string is accepted too,
 * since the column's shape is Kilo's to change and a bare id is the obvious way
 * for it to change.
 */
export function parseSessionModel(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const text = raw.trim();
  if (!text.startsWith('{')) return NOT_A_MODEL.has(text.toLowerCase()) ? null : text;
  try {
    const parsed = JSON.parse(text);
    const id = parsed?.id;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The model Kilo is running for `dir`, or null when nothing can say so.
 *
 * Read-only and never throwing: a locked database, a schema that moved, a Node
 * without `node:sqlite`, and a directory Kilo has never opened all return null,
 * which leaves pricing exactly where it is today.
 */
export function kiloSessionModel(
  dir: string,
  opts: { home?: string; env?: NodeJS.ProcessEnv; now?: number; maxAgeMs?: number } = {},
): string | null {
  const path = kiloDbPath(opts);
  if (path === null) return null;

  const sqlite = loadSqlite();
  if (sqlite === null) return null;

  const maxAge = opts.maxAgeMs ?? MAX_SESSION_AGE_MS;
  const now = opts.now ?? Date.now();

  // The whole-file mtime is a cheap pre-filter: if Kilo has not written to the
  // database at all within the window, no row inside it can be recent either,
  // and we skip opening it.
  try {
    if (now - statSync(path).mtimeMs > maxAge) return null;
  } catch {
    return null;
  }

  let db: any;
  try {
    // Read-only so graft can never write to another tool's database, and so an
    // open handle cannot create a -wal/-shm pair next to it.
    db = new sqlite.DatabaseSync(path, { readOnly: true });
    const rows = db
      .prepare('select directory, model, time_updated from session order by time_updated desc limit 200')
      .all();
    const want = normalizeDir(dir);

    // Every session on this directory that is recent enough to be live. Kilo
    // serves one MCP server per workspace, not per chat, so a user with two
    // chats open on one repo produces several — and nothing in the protocol says
    // which of them is calling.
    const live: Array<{ model: string; updated: number }> = [];
    for (const row of rows) {
      if (typeof row?.directory !== 'string' || normalizeDir(row.directory) !== want) continue;
      const updated = Number(row.time_updated);
      // Rows are newest-first, so the first out-of-window match ends the scan:
      // every later row is older still.
      if (!Number.isFinite(updated) || now - updated > maxAge) break;
      const model = parseSessionModel(row.model);
      if (model) live.push({ model, updated });
    }
    if (live.length === 0) return null;

    const newest = live[0];
    // One candidate, or several that agree: no ambiguity to resolve.
    if (live.every((s) => canonicalModelKey(s.model) === canonicalModelKey(newest.model))) {
      return newest.model;
    }

    // They disagree, so "newest wins" is a coin toss dressed as a fact — and the
    // observed failure: a repo with a 1-minute-old Opus chat and a 74-minute-old
    // Gemini chat filed EVERY Gemini saving under Opus, a 6x price difference,
    // for as long as both stayed open.
    //
    // A tool call happens DURING a turn, and Kilo rewrites the session row on
    // every message of it, so the caller's row is seconds old rather than
    // minutes. When exactly one candidate is that fresh, it is the live one and
    // the rest are idle tabs. When none is — or several are — nothing here can
    // tell them apart, and an unpriced saving beats one filed against a model
    // that never ran.
    const active = live.filter((s) => now - s.updated <= ACTIVE_TURN_MS);
    return active.length === 1 ? active[0].model : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing to do */
    }
  }
}
