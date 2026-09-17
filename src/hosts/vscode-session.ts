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
 *                                   "modelId" and, once resolved, "resolvedModel"
 *
 * `modelId` is what the picker holds (`copilot/auto`, `copilot/claude-opus-5`);
 * `resolvedModel` is what that actually ran (`claude-opus-5`,
 * `claude-haiku-4-5-20251001`). Taking the resolved value is what makes `auto`
 * priceable at all, which is the mode most users leave it in.
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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SESSION_AGE_MS } from './kilo-session.js';

/** VS Code's user-data directory per platform, for each flavour in the field. */
const FLAVOURS = ['Code', 'Code - Insiders'] as const;

function userDataDirs(home: string, env: NodeJS.ProcessEnv, os: string): string[] {
  const roots: string[] = [];
  for (const flavour of FLAVOURS) {
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
function stripComments(text: string): string {
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

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Whether `repo` is `folder` or lives inside it. A workspace folder is the repo
 * root in the normal case, but graft may be invoked from a subdirectory. */
function covers(folder: string, repo: string): boolean {
  const f = normalize(folder);
  const r = normalize(repo);
  return r === f || r.startsWith(`${f}/`);
}

/**
 * The model named by a chat session log.
 *
 * The file is append-only JSONL whose first line is a full snapshot and whose
 * later lines are deltas, so the LAST occurrence in the raw text is the most
 * recent — which is why this scans the text rather than parsing and walking the
 * structure. It also means a mid-conversation model switch is picked up without
 * this module knowing anything about the delta format, which is VS Code's to
 * change.
 *
 * `resolvedModel` is preferred over `modelId` because `modelId` is frequently
 * the literal `copilot/auto`: the picker's value, not a model. A `copilot/`
 * routing prefix is left on for `price.ts` to strip, exactly as `vertex_ai/` is.
 */
export function sessionModelFrom(text: string): string | null {
  const resolved = [...text.matchAll(/"resolvedModel"\s*:\s*"([^"]+)"/g)];
  const last = resolved.at(-1)?.[1]?.trim();
  if (last) return last;

  // No resolved model yet (a turn still in flight). Fall back to the picker
  // value, but never to `auto`: that names a router, not a model, and pricing it
  // would be a guess at whichever model the router happened to choose.
  const picked = [...text.matchAll(/"modelId"\s*:\s*"([^"]+)"/g)]
    .map((m) => m[1].trim())
    .filter((id) => id && !/(^|\/)auto$/i.test(id));
  return picked.at(-1) ?? null;
}

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

  for (const userDir of userDataDirs(home, env, opts.os ?? platform())) {
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
      if (!workspaceFolders(meta).some((f) => covers(f, repo))) continue;

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
