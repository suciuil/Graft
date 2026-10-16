/**
 * The model GitHub Copilot for JetBrains IDEs (IntelliJ IDEA, PyCharm, …) is
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
 * where `<ide>` is the product code (`ic`, `iu`, `py`, …). Each turn is a
 * Java-serialized document carrying `sessionId`, `createdAt`, `_modified`, the
 * picker value under `request.modelInformation.model` (`auto`, `gpt-4.1`) and
 * what actually answered under `response.modelName` (`Claude Haiku 4.5`). The
 * display name is priceable as-is: `price.ts` folds spaces to hyphens.
 *
 * ## What it does not claim
 *
 * The store records no project path, so — unlike VS Code — a session cannot be
 * matched to the repo. What stands in for that: the reader only runs inside a
 * JetBrains terminal, only considers turns touched within
 * {@link MAX_SESSION_AGE_MS}, and when live sessions disagree it answers only
 * if exactly one was written within the current turn. Otherwise null: tokens,
 * no dollars.
 *
 * The file is opened read-only while the IDE holds it; MVStore pages are
 * scanned for the serialized fields rather than decoded. A compressed or
 * re-shaped store yields nothing, never a wrong figure.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
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
 * only while nothing has resolved yet, and never when it is `auto` — a router,
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

/**
 * The model Copilot for JetBrains is running, or null when nothing says so.
 *
 * `repo` is accepted for symmetry with the other readers; the store records no
 * project, so it cannot narrow the search (see the module comment).
 */
export function jetbrainsSessionModel(
  _repo: string,
  opts: { home?: string; env?: NodeJS.ProcessEnv; now?: number; maxAgeMs?: number; os?: string } = {},
): string | null {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? MAX_SESSION_AGE_MS;

  // Newest turn per session, across every store.
  const latest = new Map<string, JetBrainsTurn>();
  for (const db of recentStores(copilotRoot(home, env, opts.os ?? platform()), now, maxAge)) {
    let buf: Buffer;
    try {
      buf = readFileSync(db);
    } catch {
      continue;
    }
    for (const turn of turnsFrom(buf)) {
      if (now - turn.touched > maxAge) continue;
      const seen = latest.get(turn.session);
      if (!seen || turn.touched > seen.touched) latest.set(turn.session, turn);
    }
  }

  const live = [...latest.values()].sort((a, b) => b.touched - a.touched);
  if (live.length === 0) return null;
  const newest = live[0];
  if (live.every((t) => t.model.toLowerCase() === newest.model.toLowerCase())) return newest.model;
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
