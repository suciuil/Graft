/**
 * Every folder the agent hosts on this machine say they have worked in.
 *
 * `graft savings --all` reads the folders listed in `~/.graft/repos.json`, and
 * graft adds a folder there whenever it records a saving. That leaves out repos
 * where graft recorded savings BEFORE the list existed. Their ledgers are still
 * on disk, but nothing outside the repo points at them.
 *
 * The hosts do keep track, each for its own reasons: Claude Code lists its
 * projects in `~/.claude.json`, Kilo keeps one row per session with its
 * directory, VS Code and its forks keep one `workspaceStorage` entry per opened
 * folder, JetBrains IDEs keep `recentProjects.xml`, and Codex writes the working
 * directory at the top of every session log. This module only collects those
 * folder paths; `repo-registry.ts` decides which of them hold a savings ledger.
 *
 * Read-only, and never throwing: a host that is not installed, or whose files
 * have moved or changed shape, adds nothing.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { kiloSessionDirectories } from './kilo-session.js';
import { editorWorkspaceFolders } from './vscode-session.js';

export type FolderSource = 'claude' | 'kilo' | 'vscode' | 'jetbrains' | 'codex';

export interface KnownFolder {
  path: string;
  source: FolderSource;
}

export interface KnownFolderOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  os?: string;
}

/** Claude Code's project list: the keys of `projects` in `.claude.json`, which
 * lives in `CLAUDE_CONFIG_DIR` when that is set and in the home folder otherwise. */
export function claudeProjectFolders(opts: KnownFolderOptions = {}): string[] {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const files = [join(home, '.claude.json')];
  if (env.CLAUDE_CONFIG_DIR?.trim()) files.unshift(join(env.CLAUDE_CONFIG_DIR.trim(), '.claude.json'));
  const out: string[] = [];
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8')) as { projects?: Record<string, unknown> };
      if (j.projects && typeof j.projects === 'object') out.push(...Object.keys(j.projects));
    } catch {
      // Not installed, or not readable.
    }
  }
  return out;
}

/** Where JetBrains IDEs keep their per-product config folders. */
function jetbrainsConfigRoot(home: string, env: NodeJS.ProcessEnv, os: string): string {
  if (os === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'JetBrains');
  if (os === 'darwin') return join(home, 'Library', 'Application Support', 'JetBrains');
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg ? xdg : join(home, '.config'), 'JetBrains');
}

/** The project paths in one `recentProjects.xml`. JetBrains writes the home
 * folder as `$USER_HOME$` and always uses `/`. */
export function recentProjectsFrom(xml: string, home: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<entry\s+key="([^"]+)"/g)) {
    const raw = m[1]
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\$USER_HOME\$/g, home);
    if (isAbsolute(raw)) out.push(resolve(raw));
  }
  return out;
}

/** Recent projects of every JetBrains IDE version installed (IntelliJ IDEA,
 * PyCharm, WebStorm, Rider, …): each has its own config folder. */
export function jetbrainsProjectFolders(opts: KnownFolderOptions = {}): string[] {
  const home = opts.home ?? homedir();
  const root = jetbrainsConfigRoot(home, opts.env ?? process.env, opts.os ?? platform());
  let products: string[];
  try {
    products = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const product of products) {
    const file = join(root, product, 'options', 'recentProjects.xml');
    try {
      out.push(...recentProjectsFrom(readFileSync(file, 'utf8'), home));
    } catch {
      // This product has no recent-projects list.
    }
  }
  return out;
}

/** How much of a Codex session log is read. The working directory is in the
 * first line's `session_meta`, ahead of the (long) instructions. */
const CODEX_HEAD_BYTES = 8192;
/** Codex keeps every session forever, one file each; this bounds a scan of a
 * machine with years of them. The newest-dated folders are read first. */
const CODEX_MAX_FILES = 5000;

/** The working directory named by a Codex session log's first line, or null. */
export function codexCwdFrom(head: string): string | null {
  const m = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(head);
  if (!m) return null;
  try {
    const cwd = JSON.parse(m[1]);
    return typeof cwd === 'string' && cwd.trim() ? cwd : null;
  } catch {
    return null;
  }
}

/** The working directories of Codex sessions (`~/.codex/sessions/yyyy/mm/dd/*.jsonl`,
 * or under `CODEX_HOME`). */
export function codexSessionFolders(opts: KnownFolderOptions = {}): string[] {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const root = join(env.CODEX_HOME?.trim() ? env.CODEX_HOME.trim() : join(home, '.codex'), 'sessions');
  if (!existsSync(root)) return [];

  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (files.length >= CODEX_MAX_FILES || depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort().reverse();
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= CODEX_MAX_FILES) return;
      const p = join(dir, e);
      if (e.endsWith('.jsonl')) files.push(p);
      else {
        try {
          if (statSync(p).isDirectory()) walk(p, depth + 1);
        } catch {
          // Gone, or unreadable.
        }
      }
    }
  };
  walk(root, 0);

  const out = new Set<string>();
  const buf = Buffer.alloc(CODEX_HEAD_BYTES);
  for (const f of files) {
    let fd: number | null = null;
    try {
      fd = openSync(f, 'r');
      const n = readSync(fd, buf, 0, buf.length, 0);
      const cwd = codexCwdFrom(buf.toString('utf8', 0, n));
      if (cwd) out.add(cwd);
    } catch {
      // Being written, or unreadable.
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* nothing to do */ }
      }
    }
  }
  return [...out];
}

/**
 * Every folder any supported host says it has worked in, with the host that
 * named it. Duplicates across hosts are kept: the caller folds them by path.
 */
export function knownFolders(opts: KnownFolderOptions = {}): KnownFolder[] {
  const out: KnownFolder[] = [];
  const add = (source: FolderSource, paths: string[]) => {
    for (const p of paths) if (typeof p === 'string' && p.trim()) out.push({ path: p, source });
  };
  add('claude', claudeProjectFolders(opts));
  add('kilo', kiloSessionDirectories(opts));
  add('vscode', editorWorkspaceFolders(opts));
  add('jetbrains', jetbrainsProjectFolders(opts));
  add('codex', codexSessionFolders(opts));
  return out;
}
