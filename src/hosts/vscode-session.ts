/**
 * The model VS Code's chat (GitHub Copilot) is running right now, read from the
 * editor's own chat session files.
 *
 * ## Why this exists at all
 *
 * Copilot is the host that can use neither of graft's two existing answers. It
 * has no hook surface, so nothing stamps a transcript; and graft deliberately
 * registers no MCP server for it (`hosts/mcp-config.ts`), so the `model` tool
 * argument never reaches it either — Copilot drives graft by running the CLI in
 * a VS Code terminal. The instruction file does ask the agent to pass
 * `--agent-model`, and in practice it mostly does not, exactly as measured for
 * the MCP argument on Kilo. The result is the report the user actually sees:
 * `🌱 graft saved ~N tokens by this turn`, with no dollar figure, for every
 * session.
 *
 * VS Code, however, writes the running model to disk as part of ordinary chat
 * persistence:
 *
 *   %APPDATA%/Code/User/workspaceStorage/<hash>/
 *     workspace.json              → { "folder": "file:///d%3A/work/repo" }
 *                                 or { "workspace": "file:///…/x.code-workspace" }
 *     chatSessions/<id>.jsonl     → append-only chat log; each request carries
 *                                   "modelId" and, once finished, "resolvedModel";
 *                                   an Auto request also gets an
 *                                   "autoModeResolution" part as it starts
 *
 * `modelId` is what the picker holds (`copilot/auto`, `copilot/claude-opus-5`);
 * `resolvedModel` is what that actually ran (`claude-opus-5`,
 * `claude-haiku-4-5-20251001`), recorded when the turn ends; and
 * `autoModeResolution` is the model Auto routed to, recorded when the turn
 * begins. Reading the routed model is what makes `auto` priceable at all — the
 * mode most users leave it in — and reading it from the part written at the
 * START of the turn is what makes it priceable while graft runs, which is
 * always mid-turn ({@link sessionModelFrom}).
 *
 * The session file has one weakness: VS Code writes a new chat's first request
 * to it late, after that turn's tool calls have already run. So the first
 * source read is Copilot Chat's own output log, which names the model of every
 * call as it returns ({@link copilotLogModel}):
 *
 *   %APPDATA%/Code/logs/<run>/window<N>/exthost/
 *     exthost.log                               → the window's workspaceStorage/<hash>
 *     GitHub.copilot-chat/GitHub Copilot Chat.log → "ccreq:… | success | <model> | …ms | [panel/editAgent]"
 *
 * The session files remain the fallback.
 *
 * ## Why reading it is a fact, not a guess
 *
 * The same argument as `kilo-session.ts`: what `ledger.ts` forbids is a STANDING
 * DECLARATION — a model written once into a config file that keeps pricing
 * confidently long after the user switched. A chat session file is the opposite:
 * written by the editor, per session, naming the model of the conversation whose
 * terminal is running this very command. It enters through the same `stamped`
 * slot as a transcript stamp and stays below the agent's own `--agent-model`.
 *
 * ## What it does not claim
 *
 * The session is matched by mapping the workspace to its folder(s) and finding
 * the one containing the repo, then taking that workspace's most recently
 * written session. Two chat sessions open on one workspace with different models
 * resolve to the last one written — the same limit Kilo's reader has, and the
 * same reason this ranks below what the agent says. A session not touched
 * recently ({@link MAX_SESSION_AGE_MS}) names nothing, so a closed project
 * prices nothing.
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SESSION_AGE_MS, dirKeys } from './kilo-session.js';

/** VS Code's user-data directory per platform, for each flavour in the field. */
const FLAVOURS = ['Code', 'Code - Insiders'] as const;

function userDataDirs(home: string, env: NodeJS.ProcessEnv, os: string, flavours: readonly string[] = FLAVOURS): string[] {
  const roots: string[] = [];
  for (const flavour of flavours) {
    if (os === 'win32') {
      const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
      roots.push(join(appData, flavour, 'User'));
    } else if (os === 'darwin') {
      roots.push(join(home, 'Library', 'Application Support', flavour, 'User'));
    } else {
      const xdg = env.XDG_CONFIG_HOME;
      roots.push(join(xdg && xdg.trim() ? xdg.trim() : join(home, '.config'), flavour, 'User'));
    }
  }
  return roots;
}

/**
 * A `file://` URL as VS Code writes it, back to a path.
 *
 * `fileURLToPath` rather than manual unescaping: the URL is percent-encoded
 * (`d%3A`, and `%21` for a `!` in a directory name — both present on the machine
 * this was written against), and hand-rolling that decoding is how a path with a
 * space or a hash silently stops matching.
 */
function urlToPath(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith('file:')) return null;
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/**
 * Strip `//` and `/* *\/` comments so a `.code-workspace` can be parsed.
 *
 * VS Code writes these files as JSONC and users comment them freely (the
 * workspace this was tested against has two comment blocks in `settings`).
 * String-aware, so a `//` inside a path value survives.
 */
export function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '"') { j++; break; }
        j++;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * The repo folders a workspace-storage entry covers.
 *
 * Two shapes, both in the field: `folder` for a plain opened directory, and
 * `workspace` for a `.code-workspace` file — whose `folders[].path` entries are
 * relative to the file and must be resolved, or a multi-root workspace (the
 * shape VED-ChAIR uses) matches nothing at all.
 */
export function workspaceFolders(metaPath: string): string[] {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return [];
  }

  const folder = urlToPath(meta.folder);
  if (folder) return [folder];

  const wsFile = urlToPath(meta.workspace);
  if (!wsFile) return [];
  let cfg: Record<string, any>;
  try {
    cfg = JSON.parse(stripComments(readFileSync(wsFile, 'utf8')));
  } catch {
    // The workspace file is gone or unreadable; its own directory is still the
    // best available answer for a single-root `.code-workspace`, which is the
    // common shape.
    return [dirname(wsFile)];
  }
  const folders = Array.isArray(cfg.folders) ? cfg.folders : [];
  const out: string[] = [];
  for (const f of folders) {
    if (typeof f?.path === 'string') out.push(resolve(dirname(wsFile), f.path));
  }
  return out.length ? out : [dirname(wsFile)];
}

/**
 * Every folder a VS Code-family editor has opened (directly or as a root of a
 * `.code-workspace`), from its `workspaceStorage`. For `graft savings --all`,
 * which needs the folders graft may have been used in before the cross-repo
 * registry existed.
 *
 * Cursor and Windsurf are VS Code forks with the same storage layout, so they are
 * read too — unlike {@link vscodeSessionModel}, which only trusts VS Code's own
 * chat log format. Never throwing; an editor that is not installed adds nothing.
 */
export function editorWorkspaceFolders(
  opts: { home?: string; env?: NodeJS.ProcessEnv; os?: string } = {},
): string[] {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const os = opts.os ?? platform();
  const out: string[] = [];
  for (const userDir of userDataDirs(home, env, os, [...FLAVOURS, 'Cursor', 'Windsurf', 'VSCodium'])) {
    const storage = join(userDir, 'workspaceStorage');
    let entries: string[];
    try {
      entries = readdirSync(storage);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const meta = join(storage, entry, 'workspace.json');
      if (existsSync(meta)) out.push(...workspaceFolders(meta));
    }
  }
  return out;
}

function within(f: string, r: string): boolean {
  return r === f || r.startsWith(`${f}/`);
}

/** Whether `repo` is `folder` or lives inside it. A workspace folder is the repo
 * root in the normal case, but graft may be invoked from a subdirectory.
 *
 * Compared as given AND as resolved through junctions and symlinks, on both
 * sides: VS Code records the folder the way it was opened (`d:/work/repo`, a
 * junction), while git and the process cwd may report the real location
 * (`D:/OneDrive/_D/work/repo`). Plain string equality missed that pair, so a
 * Copilot session in a junctioned checkout named no model at all. `repoKeys` is
 * built once by the caller, since this runs for every workspace on the machine. */
function covers(folder: string, repoKeys: Set<string>): boolean {
  const folderKeys = dirKeys(folder);
  for (const f of folderKeys) {
    for (const r of repoKeys) if (within(f, r)) return true;
  }
  return false;
}

/**
 * Every signal in a chat log that bears on the running model, in file order:
 *
 *   1. `"requestId":"…"` — a new request starts (the picker `modelId` follows it).
 *   2. `"resolvedModel":"…"` — what a FINISHED request ran. Written only in the
 *      request's `result`, i.e. when the turn ends.
 *   3. `{"kind":"autoModeResolution","resolved":{"id":"…"}}` — the model Auto
 *      routed to. A response part, so it is written as the turn STARTS — the
 *      only name an Auto turn has while it is still running.
 *   4. `"modelId":"…"` — the picker value on a request (`copilot/auto`,
 *      `copilot/claude-opus-5.5`), and the model of each tool-call round inside
 *      a result (`claude-opus-5.5`).
 *
 * Every one of these is an unescaped JSON key, which text inside a chat message
 * can never produce (its quotes are written as `\"`), so the user typing one of
 * these names cannot be mistaken for the real thing.
 */
const SIGNAL =
  /"requestId"\s*:\s*"|"resolvedModel"\s*:\s*"([^"]+)"|"kind"\s*:\s*"autoModeResolution"\s*,\s*"resolved"\s*:\s*\{[^{}]*?"id"\s*:\s*"([^"]+)"|"modelId"\s*:\s*"([^"]+)"/g;

/** `auto` (with or without a `copilot/` route) names a router, not a model. */
function isRouter(id: string): boolean {
  return /(^|\/)auto$/i.test(id);
}

/**
 * The log without the requests the user has QUEUED behind the running turn.
 *
 * A queued message carries the model picked when it was typed, which is not the
 * model running now; left in, a message queued after switching the picker would
 * price the current turn at the next turn's model. Queued requests live in a
 * top-level `pendingRequests` array — after `requests` in a snapshot line, and
 * as their own `"k":["pendingRequests"]` delta lines afterwards.
 */
function withoutQueued(text: string): string {
  if (!text.includes('"pendingRequests"')) return text;
  return text
    .split('\n')
    .map((line) => {
      if (/^\{"kind"\s*:\s*\d+\s*,\s*"k"\s*:\s*\[\s*"pendingRequests"/.test(line)) return '';
      if (!line.startsWith('{"kind":0')) return line;
      const pending = line.indexOf('"pendingRequests"');
      const requests = line.indexOf('"requests"');
      return pending > requests && requests !== -1 ? line.slice(0, pending) : line;
    })
    .join('\n');
}

/**
 * The model named by a chat session log.
 *
 * The file is append-only JSONL whose first line is a full snapshot and whose
 * later lines are deltas, so a LATER occurrence in the raw text is a more recent
 * one — which is why this scans the text rather than parsing and walking the
 * structure. It also means a mid-conversation model switch is picked up without
 * this module knowing anything about the delta format, which is VS Code's to
 * change.
 *
 * The newest signal that names a model wins. Two cases made that the rule, both
 * seen on real logs, both while graft runs — which is always mid-turn, since
 * Copilot runs it from a tool call:
 *
 * - **Auto, first turn.** `resolvedModel` is written only when a turn ENDS. Until
 *   then an Auto turn's request says `copilot/auto`, which names a router, and
 *   the only real name in the file is Auto's `autoModeResolution` part. Reading
 *   only `resolvedModel` and `modelId` priced every first Auto turn at nothing.
 * - **A switch.** Picking a model after an Auto turn starts a request naming the
 *   new model, while the newest `resolvedModel` still names the old one. Always
 *   preferring `resolvedModel` priced that whole turn at the previous model.
 *
 * When the newest request is on Auto and nothing in it has resolved yet, the
 * answer is the model Auto last routed to in this session — Auto keeps its route
 * across a conversation — and null when Auto has not routed here yet. Never a
 * model the user picked by hand earlier: that would be a guess at what the
 * router chose. A `copilot/` routing prefix is left on for `price.ts` to strip,
 * exactly as `vertex_ai/` is.
 */
export function sessionModelFrom(text: string): string | null {
  let current: string | null = null; // the newest model the log names
  let routed: string | null = null; // the newest model Auto routed to
  let onAuto = false; // the newest request was sent on Auto…
  let settled = false; // …and has since named the model it runs

  for (const m of withoutQueued(text).matchAll(SIGNAL)) {
    const [whole, resolved, autoRoute, picked] = m;
    if (whole.startsWith('"requestId"')) {
      onAuto = false;
      settled = false;
      continue;
    }
    if (autoRoute !== undefined) {
      const id = autoRoute.trim();
      if (!id || isRouter(id)) continue;
      current = routed = id;
      onAuto = settled = true;
      continue;
    }
    const id = (resolved ?? picked ?? '').trim();
    if (!id) continue;
    if (isRouter(id)) {
      onAuto = true;
      settled = false;
      continue;
    }
    current = id;
    if (onAuto) {
      // What an Auto request ran (a result's rounds or its resolved model) is
      // Auto's route too — the only record of it in logs from VS Code builds
      // that predate the `autoModeResolution` part.
      routed = id;
      settled = true;
    }
  }

  return onAuto && !settled ? routed : current;
}

/**
 * One finished model call in Copilot Chat's output log, as it writes it at
 * `info` level the moment the call returns:
 *
 *   2026-11-11 10:33:44.368 [info] ccreq:a5da432a.copilotmd | success | gpt-6-luna | 4220ms | [panel/editAgent]
 *
 * Only calls that answer the user count — the chat panel, inline chat in an
 * editor, terminal or notebook (`[panel/…]`, `[editor/…]`, `[terminal/…]`,
 * `[notebook/…]`). Copilot's own housekeeping runs on a cheap model of its own
 * (`[title]`, `[progressMessages]`,
 * `[copilotLanguageModelWrapper/toolRiskAssessment]`, all `gpt-4o-mini` on the
 * machine this was written against) and says nothing about the model the user
 * is talking to. Only `success`: a cancelled or failed call issued no tool call,
 * so it cannot be the one that ran graft.
 */
const CCREQ =
  /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))? \[\w+\] ccreq:\S+ \| success \| ([^|\r\n]+?) \| \d+ms \| \[(?:panel|editor|terminal|notebook)\/[^\]\r\n]*\]/gm;

/**
 * The model of the newest user-facing call in a Copilot Chat log, with the time
 * it finished (local time, as the log writes it), or null.
 *
 * A line may name a request and the deployment that served it
 * (`claude-opus-5.5 -> claude-opus-5-5-20261001`); the served one is what ran.
 * A router name (`auto`) is skipped, not returned: it would price nothing.
 */
export function copilotLogModelFrom(text: string): { model: string; at: number } | null {
  let last: { model: string; at: number } | null = null;
  for (const m of text.matchAll(CCREQ)) {
    const [, y, mo, d, h, mi, s, ms, named] = m;
    const parts = named.split('->').map((p) => p.trim()).filter(Boolean);
    const model = parts.reverse().find((p) => !isRouter(p));
    if (!model) continue;
    const at = new Date(+y, +mo - 1, +d, +h, +mi, +s, ms ? +ms.padEnd(3, '0') : 0).getTime();
    last = { model, at };
  }
  return last;
}

/** Read at most the last `bytes` of a file — Copilot's log grows all day, and
 * only its newest lines matter. Null when unreadable. */
function readTail(file: string, bytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already gone
      }
    }
  }
}

/** Read at most the first `bytes` of a file, or null. */
function readHead(file: string, bytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already gone
      }
    }
  }
}

/** The workspace-storage entry an extension host serves, from its own log:
 * VS Code core logs the storage folder it locks (or skips locking) at startup,
 * `…\User\workspaceStorage\8c39e775ac99d24721eaf2ae1cd9743e.` An empty window
 * has none. */
const STORAGE_REF = /workspaceStorage[\\/]([0-9a-f]{16,64})\b/i;

/**
 * The model Copilot is running for `repo` right now, from Copilot Chat's output
 * log in the VS Code window that has the repo open.
 *
 * ## Why the log, when the chat session file names the model too
 *
 * Because the session file is written LATE. On VS Code 1.145 a new chat's first
 * request — the line carrying `modelId`, Auto's `autoModeResolution` and
 * everything else {@link sessionModelFrom} reads — reached the disk only after
 * the turn's tool calls had run: graft's three calls in the turn this was traced
 * on (10:33:44–10:33:54) saw a file holding nothing but the empty snapshot
 * (`copilot/auto`, a router), and the request line landed with outputs
 * timestamped 10:34:17. Every graft call in the first minute of a chat priced
 * nothing.
 *
 * Copilot's log has no such lag: it writes one `ccreq` line per model call as
 * the call RETURNS, which is just before the tool call that call asked for
 * starts (10:33:44.368 the call, 10:33:44.401 the `graft map` it requested). So
 * the newest user-facing line in the caller's window names the model that is
 * running graft, at the moment graft runs — including whatever Auto routed that
 * very call to, per call, rather than once per conversation.
 *
 * ## Which window
 *
 * VS Code writes one log folder per run (`logs/20261111T100131`) and one
 * `window<N>` folder per window inside it. Only the newest run with windows is
 * live (see {@link copilotLogHit}); within
 * it, a window belongs to the repo when the workspace-storage entry its
 * extension host logged at startup ({@link STORAGE_REF}) covers the repo — the
 * same `workspace.json` test the session reader uses. A window on another
 * project is never read, so a second Copilot chat elsewhere cannot price this
 * one.
 */
export function copilotLogModel(
  userDir: string,
  repoKeys: Set<string>,
  now: number,
  maxAge: number,
): string | null {
  return copilotLogHit(userDir, repoKeys, now, maxAge)?.model ?? null;
}

/**
 * {@link copilotLogModel} with the time of the log line, so that callers can
 * compare the VS Code flavours (Code, Insiders, VSCodium) against each other.
 *
 * The live run is the newest one that HAS windows, not simply the newest: a
 * `code <file>` launched while VS Code is open (from another shell, or as git's
 * editor) leaves a run folder of its own with no `window*` in it, newer than
 * the run whose windows are still open.
 */
export function copilotLogHit(
  userDir: string,
  repoKeys: Set<string>,
  now: number,
  maxAge: number,
): { model: string; at: number } | null {
  const logsRoot = join(dirname(userDir), 'logs');
  let runs: string[];
  try {
    runs = readdirSync(logsRoot).filter((n) => /^\d{8}T\d{6}$/.test(n)).sort().reverse();
  } catch {
    return null;
  }
  let runDir: string | undefined;
  let windows: string[] = [];
  for (const run of runs) {
    try {
      windows = readdirSync(join(logsRoot, run)).filter((n) => /^window\d+$/.test(n));
    } catch {
      continue;
    }
    if (windows.length > 0) {
      runDir = join(logsRoot, run);
      break;
    }
  }
  if (!runDir) return null;

  let best: { model: string; at: number } | null = null;
  for (const win of windows) {
    let hosts: string[];
    try {
      hosts = readdirSync(join(runDir, win)).filter((n) => /^exthost\d*$/.test(n));
    } catch {
      continue;
    }
    for (const host of hosts) {
      const hostDir = join(runDir, win, host);
      const ref = storageRef(join(hostDir, 'exthost.log'));
      if (!ref) continue;
      const meta = join(userDir, 'workspaceStorage', ref[1], 'workspace.json');
      if (!existsSync(meta) || !workspaceFolders(meta).some((f) => covers(f, repoKeys))) continue;

      const log = readTail(join(hostDir, 'GitHub.copilot-chat', 'GitHub Copilot Chat.log'), LOG_TAIL_BYTES);
      const hit = log ? copilotLogModelFrom(log) : null;
      if (!hit || now - hit.at > maxAge) continue;
      if (!best || hit.at > best.at) best = hit;
    }
  }
  return best;
}

/** The workspace-storage match in an extension host's log head: the first few
 * kilobytes first, the longer head only when they do not hold it. */
function storageRef(file: string): RegExpExecArray | null {
  const head = readHead(file, LOG_HEAD_FIRST_BYTES);
  if (head === null) return null;
  const ref = STORAGE_REF.exec(head);
  // Shorter than asked for: that was the whole file.
  if (ref || Buffer.byteLength(head, 'utf8') < LOG_HEAD_FIRST_BYTES) return ref;
  return STORAGE_REF.exec(readHead(file, LOG_HEAD_BYTES) ?? '');
}

/** The storage line is written in the extension host's first second; a few
 * kilobytes in on the machine this was written against. */
const LOG_HEAD_FIRST_BYTES = 16 * 1024;
const LOG_HEAD_BYTES = 256 * 1024;

/** Enough of Copilot's log for the last few turns; it logs a handful of lines
 * per model call. */
const LOG_TAIL_BYTES = 256 * 1024;

/**
 * The model VS Code chat is running for `repo`, or null when nothing says so.
 *
 * Best-effort and never throwing: no VS Code, no chat history, a workspace that
 * does not contain this repo, and a storage layout that has moved all return
 * null, which is exactly today's behaviour.
 */
export function vscodeSessionModel(
  repo: string,
  opts: { home?: string; env?: NodeJS.ProcessEnv; now?: number; maxAgeMs?: number; os?: string } = {},
): string | null {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? MAX_SESSION_AGE_MS;

  const candidates: Array<{ mtime: number; file: string }> = [];
  const repoKeys = dirKeys(repo);
  const userDirs = userDataDirs(home, env, opts.os ?? platform());

  // Copilot's own log first: written as each model call returns, so it names the
  // model running graft even while the chat session file is still unwritten
  // (see `copilotLogModel`). The session files below are the fallback — for a
  // log level that hides `ccreq` lines, or a Copilot build that stops writing them.
  // The newest line across flavours wins: with Code and Insiders both installed,
  // the one that ran a model last is the one running graft, whichever is listed first.
  let logged: { model: string; at: number } | null = null;
  for (const userDir of userDirs) {
    try {
      const hit = copilotLogHit(userDir, repoKeys, now, maxAge);
      if (hit && (!logged || hit.at > logged.at)) logged = hit;
    } catch {
      // Fall through to the session files.
    }
  }
  if (logged) return logged.model;

  for (const userDir of userDirs) {
    const storage = join(userDir, 'workspaceStorage');
    let entries: string[];
    try {
      entries = readdirSync(storage);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = join(storage, entry);
      const sessions = join(dir, 'chatSessions');
      // Cheapest checks first: most workspace entries on a developer's machine
      // are for other projects, and this runs on every retrieval.
      if (!existsSync(sessions)) continue;
      const meta = join(dir, 'workspace.json');
      if (!existsSync(meta)) continue;
      if (!workspaceFolders(meta).some((f) => covers(f, repoKeys))) continue;

      let files: string[];
      try {
        files = readdirSync(sessions).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const p = join(sessions, f);
        let mtime: number;
        try {
          mtime = statSync(p).mtimeMs;
        } catch {
          continue;
        }
        if (now - mtime > maxAge) continue;
        candidates.push({ mtime, file: p });
      }
    }
  }

  // Newest first, then the first one that actually names a model. NOT simply the
  // newest file: VS Code touches a session log when a chat is merely opened, so
  // the most recent file is routinely one with no request in it yet. Stopping
  // there reported "unknown" while the answer sat in the session just behind it.
  candidates.sort((a, b) => b.mtime - a.mtime);
  const named: Array<{ model: string; mtime: number }> = [];
  for (const { file, mtime } of candidates.slice(0, MAX_SESSIONS_READ)) {
    try {
      const model = sessionModelFrom(readFileSync(file, 'utf8'));
      if (model) named.push({ model, mtime });
    } catch {
      // Unreadable (being written, or locked) — try the next.
    }
  }
  if (named.length === 0) return null;

  // Several chats open on one workspace, running different models, is the case
  // that makes "newest wins" a guess rather than an observation — see the same
  // reasoning in `kilo-session.ts`. When the live candidates disagree, only a
  // session written within the current turn can be the caller; if that does not
  // single one out, no price is better than the wrong one.
  const newest = named[0];
  if (named.every((s) => s.model.toLowerCase() === newest.model.toLowerCase())) return newest.model;
  const active = named.filter((s) => now - s.mtime <= ACTIVE_TURN_MS);
  return active.length === 1 ? active[0].model : null;
}

/** Mirrors `kilo-session.ts`: how recently a chat log must have been written to
 * be the one mid-turn, used only to break a tie between disagreeing sessions. */
const ACTIVE_TURN_MS = 2 * 60 * 1000;

/**
 * How many session logs to open before giving up.
 *
 * These files reach hundreds of kilobytes and this runs on every retrieval, so
 * the scan is bounded rather than exhaustive. A handful covers the real case —
 * the live session plus the empty ones VS Code touched on open — while a
 * workspace with ninety historical logs cannot turn one `graft ask` into ninety
 * file reads.
 */
const MAX_SESSIONS_READ = 5;

/**
 * Whether this process was started from a VS Code terminal.
 *
 * The gate on reading any of the above. Without it, a plain shell session on a
 * machine that merely HAS VS Code installed would be priced at whatever model
 * some editor window is running — the same class of mistake as showing Kilo's
 * model table to Cursor. `TERM_PROGRAM=vscode` is what VS Code's integrated
 * terminal sets; `VSCODE_*` covers a process spawned by the extension host.
 */
export function inVsCodeTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TERM_PROGRAM === 'vscode') return true;
  return Boolean(env.VSCODE_PID ?? env.VSCODE_CWD ?? env.VSCODE_IPC_HOOK ?? env.VSCODE_GIT_IPC_HANDLE);
}
