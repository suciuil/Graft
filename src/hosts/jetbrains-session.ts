/**
 * The model GitHub Copilot for JetBrains IDEs (IntelliJ IDEA, PyCharm, â€¦) is
 * running right now, read from the plugin's own agent-session store.
 *
 * The JetBrains counterpart of `vscode-session.ts`: Copilot there also drives
 * graft through the CLI in the IDE terminal and rarely passes `--agent-model`,
 * so every saving was reported in tokens alone. The plugin persists each agent
 * turn to a Nitrite (H2 MVStore) database:
 *
 *   %LOCALAPPDATA%/github-copilot/<ide>/chat-agent-sessions/<id>/
 *     copilot-agent-sessions-nitrite.db
 *
 * where `<ide>` is the product code (`ic`, `iu`, `py`, â€¦). Each turn is a
 * Java-serialized document carrying `sessionId`, `createdAt`, `_modified`, the
 * picker value under `request.modelInformation.model` (`auto`, `gpt-4.1`) and
 * what actually answered under `response.modelName` (`Claude Haiku 4.5`). The
 * display name is priceable as-is: `price.ts` folds spaces to hyphens.
 *
 * ## What it does not claim
 *
 * The store records no project path, so â€” unlike VS Code â€” a session cannot be
 * matched to the repo. What stands in for that: the reader only runs inside a
 * JetBrains terminal, only considers turns touched within
 * {@link MAX_SESSION_AGE_MS}, and when live sessions disagree it answers only
 * if exactly one was written within the current turn. Otherwise null: tokens,
 * no dollars.
 *
 * The file is read without writing to it while the IDE holds it; MVStore pages are
 * scanned for the serialized fields rather than decoded. A compressed or
 * re-shaped store yields nothing, never a wrong figure.
 *
 * ## The lock
 *
 * While the IDE is open, MVStore holds a byte-range lock over the whole store.
 * On Windows those locks are mandatory: every ordinary read fails with EBUSY,
 * so this reader answered null for the entire life of every IntelliJ session
 * and Copilot there never saw a dollar figure. Windows does not enforce
 * byte-range locks on memory-mapped views, and Node cannot map a file, so a
 * locked store is read through a mapped view by a short PowerShell step (see
 * {@link readLockedStore}). That costs a process start, so what it extracts is
 * cached against the store's size and mtime: one read per Copilot turn, not
 * per graft call.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAX_SESSION_AGE_MS } from './kilo-session.js';

const DB_FILE = 'copilot-agent-sessions-nitrite.db';

/** Mirrors `vscode-session.ts`: the window that marks a turn as mid-flight. */
const ACTIVE_TURN_MS = 2 * 60 * 1000;

// java.io.ObjectStreamConstants
const TC_REFERENCE = 0x71;
const TC_CLASSDESC = 0x72;
const TC_OBJECT = 0x73;
const TC_STRING = 0x74;
const END_BLOCK_NULL = Buffer.from([0x78, 0x70]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A serialized map key: TC_STRING, u16 length, bytes. */
function key(name: string): Buffer {
  const b = Buffer.from(name, 'utf8');
  return Buffer.concat([Buffer.from([TC_STRING, b.length >> 8, b.length & 0xff]), b]);
}

const K_ID = key('id');
const K_SESSION = key('sessionId');
const K_CREATED = key('createdAt');
const K_MODIFIED = key('_modified');
const K_MODEL = key('model');
const K_MODEL_NAME = key('modelName');
const K_NAME = key('name');

function stringAt(buf: Buffer, at: number): string | null {
  if (at < 0 || at + 3 > buf.length || buf[at] !== TC_STRING) return null;
  const end = at + 3 + buf.readUInt16BE(at + 1);
  return end <= buf.length ? buf.toString('utf8', at + 3, end) : null;
}

/** A serialized `java.lang.Long`: either with its class descriptor (first in a
 * stream) or as a back-reference to it, followed by the 8-byte value. */
function longAt(buf: Buffer, at: number): number | null {
  if (at < 0 || at + 2 > buf.length || buf[at] !== TC_OBJECT) return null;
  let p: number;
  if (buf[at + 1] === TC_REFERENCE) {
    p = at + 6;
  } else if (buf[at + 1] === TC_CLASSDESC) {
    const number = buf.indexOf('java.lang.Number', at, 'latin1');
    if (number < 0 || number - at > 80) return null;
    const end = buf.indexOf(END_BLOCK_NULL, number);
    if (end < 0 || end - number > 64) return null;
    p = end + 2;
  } else {
    return null;
  }
  if (p + 8 > buf.length) return null;
  const v = Number(buf.readBigInt64BE(p));
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** Offset of the value following `k` within [from, to), or -1. */
function valueOf(buf: Buffer, k: Buffer, from: number, to: number): number {
  const at = buf.indexOf(k, from);
  return at >= 0 && at < to ? at + k.length : -1;
}

/** Start of the next document: `id` = uuid, then `sessionId` (turn) or `name` (session). */
function nextDocument(buf: Buffer, from: number): number {
  for (let at = buf.indexOf(K_ID, from); at >= 0; at = buf.indexOf(K_ID, at + 1)) {
    const id = stringAt(buf, at + K_ID.length);
    if (!id || !UUID.test(id)) continue;
    const after = at + K_ID.length + 3 + Buffer.byteLength(id);
    if (buf.subarray(after, after + K_SESSION.length).equals(K_SESSION)) return at;
    if (buf.subarray(after, after + K_NAME.length).equals(K_NAME)) return at;
  }
  return buf.length;
}

function isAuto(id: string): boolean {
  return /(^|\/)auto$/i.test(id);
}

export interface JetBrainsTurn {
  session: string;
  model: string;
  /** Latest of `createdAt` and `_modified`, epoch ms. */
  touched: number;
}

/**
 * Every agent turn in a session store that names a model.
 *
 * The resolved `modelName` wins over the picker value; the picker value is used
 * only while nothing has resolved yet, and never when it is `auto` â€” a router,
 * not a model. MVStore keeps superseded copies of a document until it compacts,
 * so the same turn may appear more than once; callers take the newest.
 */
export function turnsFrom(buf: Buffer): JetBrainsTurn[] {
  const out: JetBrainsTurn[] = [];
  for (let at = buf.indexOf(K_SESSION); at >= 0; at = buf.indexOf(K_SESSION, at + 1)) {
    const valueAt = at + K_SESSION.length;
    const session = stringAt(buf, valueAt);
    if (!session || !UUID.test(session)) continue;
    const from = valueAt + 3 + Buffer.byteLength(session);
    const to = nextDocument(buf, from);

    const resolved = stringAt(buf, valueOf(buf, K_MODEL_NAME, from, to))?.trim();
    const picked = stringAt(buf, valueOf(buf, K_MODEL, from, to))?.trim();
    const model = resolved && !isAuto(resolved) ? resolved : picked && !isAuto(picked) ? picked : null;
    if (!model) continue;

    const created = longAt(buf, valueOf(buf, K_CREATED, from, to));
    const modified = longAt(buf, valueOf(buf, K_MODIFIED, from, to));
    const touched = Math.max(created ?? 0, modified ?? 0);
    if (touched > 0) out.push({ session, model, touched });
  }
  return out;
}

/** Where the plugin keeps its data. Verified on Windows; the XDG path follows
 * where the plugin keeps its other state on macOS and Linux. */
function copilotRoot(home: string, env: NodeJS.ProcessEnv, os: string): string {
  if (os === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'github-copilot');
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(home, '.config'), 'github-copilot');
}

/** Every session store written recently enough to matter, across IDE products. */
function recentStores(root: string, now: number, maxAge: number): string[] {
  const out: string[] = [];
  let products: string[];
  try {
    products = readdirSync(root);
  } catch {
    return out;
  }
  for (const product of products) {
    const sessions = join(root, product, 'chat-agent-sessions');
    let ids: string[];
    try {
      ids = readdirSync(sessions);
    } catch {
      continue;
    }
    for (const id of ids) {
      const db = join(sessions, id, DB_FILE);
      try {
        if (now - statSync(db).mtimeMs <= maxAge) out.push(db);
      } catch {
        // No store in this directory.
      }
    }
  }
  return out;
}

/** Keep only each session's newest turn â€” all the caller ever uses, and what
 * keeps the cache small (MVStore keeps superseded copies of every turn). */
function newestPerSession(turns: JetBrainsTurn[]): JetBrainsTurn[] {
  const latest = new Map<string, JetBrainsTurn>();
  for (const t of turns) {
    const seen = latest.get(t.session);
    if (!seen || t.touched > seen.touched) latest.set(t.session, t);
  }
  return [...latest.values()];
}

/** Copies a file through a read-only mapped view, which Windows does not subject
 * to byte-range locks. Paths come in through the environment, never the script
 * text, so no path can be read as PowerShell. */
const MAPPED_COPY = `$ErrorActionPreference = 'Stop'
$fs = [IO.File]::Open($env:GRAFT_JB_SRC, 'Open', 'Read', 'ReadWrite,Delete')
try {
  $acc = [IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read
  $mm = [IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($fs, [NullString]::Value, 0, $acc, [IO.HandleInheritability]::None, $true)
  $view = $mm.CreateViewStream(0, 0, $acc)
  $out = [IO.File]::Create($env:GRAFT_JB_DST)
  try { $view.CopyTo($out) } finally { $out.Close(); $view.Dispose(); $mm.Dispose() }
} finally { $fs.Close() }`;

/**
 * The bytes of a store the IDE holds locked, read through a memory-mapped view,
 * or null when that fails too. Windows only. The view is page-rounded, so the
 * copy may end in zero padding, which the scanner ignores.
 */
export function readLockedStore(db: string): Buffer | null {
  const dst = join(tmpdir(), `graft-jb-${process.pid}-${Date.now()}.db`);
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(MAPPED_COPY, 'utf16le').toString('base64')],
      { env: { ...process.env, GRAFT_JB_SRC: db, GRAFT_JB_DST: dst }, stdio: 'ignore', timeout: 15000, windowsHide: true },
    );
    return readFileSync(dst);
  } catch {
    return null;
  } finally {
    rmSync(dst, { force: true });
  }
}

interface CachedStore {
  size: number;
  mtimeMs: number;
  turns: JetBrainsTurn[];
}

function defaultCacheFile(): string {
  return join(tmpdir(), 'graft-jetbrains-turns.json');
}

function readCache(file: string): Record<string, CachedStore> {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * The turns in one store. A plain read when the store is free; when the IDE
 * holds it locked (Windows, IDE open â€” i.e. exactly when this matters), a mapped
 * read, cached until the store changes. A failed mapped read is cached as "no
 * turns" too, so a machine where it cannot work pays for it once per turn.
 */
function storeTurns(
  db: string,
  os: string,
  readStore: (db: string) => Buffer,
  readLocked: (db: string) => Buffer | null,
  cacheFile: string,
): JetBrainsTurn[] {
  try {
    return turnsFrom(readStore(db));
  } catch (err) {
    if (os !== 'win32' || (err as NodeJS.ErrnoException | null)?.code !== 'EBUSY') return [];
  }
  let size: number;
  let mtimeMs: number;
  try {
    ({ size, mtimeMs } = statSync(db));
  } catch {
    return [];
  }
  const cache = readCache(cacheFile);
  const hit = cache[db];
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs && Array.isArray(hit.turns)) return hit.turns;
  const buf = readLocked(db);
  const turns = buf ? newestPerSession(turnsFrom(buf)) : [];
  cache[db] = { size, mtimeMs, turns };
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cache));
  } catch {
    // An uncached answer is still an answer.
  }
  return turns;
}

/**
 * The model Copilot for JetBrains is running, or null when nothing says so.
 *
 * `repo` is accepted for symmetry with the other readers; the store records no
 * project, so it cannot narrow the search (see the module comment).
 */
export function jetbrainsSessionModel(
  _repo: string,
  opts: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    now?: number;
    maxAgeMs?: number;
    os?: string;
    /** Plain and locked-store reads; injectable for tests. */
    readStore?: (db: string) => Buffer;
    readLocked?: (db: string) => Buffer | null;
    cacheFile?: string;
  } = {},
): string | null {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? MAX_SESSION_AGE_MS;
  const os = opts.os ?? platform();
  const readStore = opts.readStore ?? ((db: string) => readFileSync(db));
  const readLocked = opts.readLocked ?? readLockedStore;
  const cacheFile = opts.cacheFile ?? defaultCacheFile();

  // Newest turn per session, across every store.
  const latest = new Map<string, JetBrainsTurn>();
  for (const db of recentStores(copilotRoot(home, env, os), now, maxAge)) {
    for (const turn of storeTurns(db, os, readStore, readLocked, cacheFile)) {
      if (now - turn.touched > maxAge) continue;
      const seen = latest.get(turn.session);
      if (!seen || turn.touched > seen.touched) latest.set(turn.session, turn);
    }
  }

  const live = [...latest.values()].sort((a, b) => b.touched - a.touched);
  if (live.length === 0) return null;
  const newest = live[0];
  // The same model is recorded as the picker id in one turn and the display
  // name in another (`gemini-3.8-flash` / `Gemini 3.8 Flash`); `price.ts` folds
  // both to one id, so they must not count as a disagreement here either.
  const same = (m: string) => m.toLowerCase().replace(/[\s_]+/g, '-');
  if (live.every((t) => same(t.model) === same(newest.model))) return newest.model;
  const active = live.filter((t) => now - t.touched <= ACTIVE_TURN_MS);
  return active.length === 1 ? active[0].model : null;
}

/**
 * Whether this process was started from a JetBrains IDE terminal.
 *
 * The gate on reading the store, for the same reason as `inVsCodeTerminal`: a
 * plain shell on a machine that merely has the plugin installed must not be
 * priced at whatever model an IDE window is running.
 */
export function inJetBrainsTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  if (/^jetbrains/i.test(env.TERMINAL_EMULATOR ?? '')) return true;
  return Boolean(env.__INTELLIJ_COMMAND_HISTFILE__);
}
