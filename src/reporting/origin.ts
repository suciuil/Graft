/**
 * Where a savings-report row came from: which AI assistant ran graft (Kilo
 * Code, GitHub Copilot, Claude Code, ...) and in which host environment (an
 * editor such as Visual Studio Code, or a terminal), each with its version
 * when graft can tell. Product names and versions only: never the machine's
 * host name, the user, a path or a repo (docs/no-cloud-policy.md).
 *
 * Read from what the process was handed, nothing is asked over the network:
 *   - the MCP `initialize` handshake (`clientInfo.name` / `.version`, see
 *     src/mcp/client.ts) on the MCP surface;
 *   - the environment the assistant or editor started graft with: Kilo Code's
 *     `KILO_*` variables, the agents' own markers (src/hosts/auto.ts), VS
 *     Code's `VSCODE_*` / `TERM_PROGRAM*`, JetBrains' `TERMINAL_EMULATOR`,
 *     Windows Terminal's `WT_SESSION`;
 *   - for a VS Code-family editor, its own `product.json` (name and version)
 *     in the install folder those variables point at, and for GitHub Copilot
 *     the version of the Copilot Chat extension it runs.
 *
 * Anything graft cannot tell is null. Never throws.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { AGENT_NAMES, callingAgent } from '../hosts/auto.js';
import { inVsCodeTerminal } from '../hosts/vscode-session.js';
import { mcpClient, mcpClientVersion } from '../mcp/client.js';

export interface ReportOrigin {
  /** The AI assistant, e.g. `Kilo Code`, `GitHub Copilot`, `Claude Code`. */
  assistant: string | null;
  assistantVersion: string | null;
  /** The host environment, e.g. `Visual Studio Code`, `Windows Terminal`, `Terminal`. */
  hostEnv: string | null;
  hostEnvVersion: string | null;
}

/** Column widths in the database: names up to 100 characters, versions up to 50. */
export const ORIGIN_NAME_MAX = 100;
export const ORIGIN_VERSION_MAX = 50;

/** Everything detection reads, injectable for tests. */
export interface OriginProbe {
  env: NodeJS.ProcessEnv;
  /** The MCP client from the handshake; nulls on the CLI and hook surfaces. */
  client: { name: string | null; version: string | null };
  /** Parsed JSON at a path, or null when missing or unreadable. */
  readJson: (path: string) => unknown;
  home: string;
}

type Channel = 'cli' | 'mcp' | 'hook' | null;

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const name = (v: unknown): string | null => text(v, ORIGIN_NAME_MAX);
const ver = (v: unknown): string | null => text(v, ORIGIN_VERSION_MAX);
const set = (v: string | undefined): boolean => v !== undefined && v !== '' && v !== '0' && v !== 'false';

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

const field = (o: unknown, key: string): unknown =>
  o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined;

// ── VS Code family ────────────────────────────────────────────────────────────

/** A VS Code-family editor that names itself in the MCP handshake. */
const VSCODE_CLIENT = /^(visual studio code|vscode|code - (insiders|oss)|vscodium)\b/i;

/**
 * The editor's `resources/app` folder, from the variables its extension host
 * and integrated terminal set: `VSCODE_NODE_COMPILE_CACHE_ROOT` sits inside it;
 * otherwise `VSCODE_CWD` plus the commit folder `VSCODE_CODE_CACHE_PATH` names
 * (current layout), or `VSCODE_CWD` itself (older layout).
 */
function vscodeAppDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs: string[] = [];
  if (env.VSCODE_NODE_COMPILE_CACHE_ROOT) dirs.push(dirname(env.VSCODE_NODE_COMPILE_CACHE_ROOT));
  if (env.VSCODE_CWD) {
    const commit = env.VSCODE_CODE_CACHE_PATH ? basename(env.VSCODE_CODE_CACHE_PATH) : '';
    if (/^[0-9a-f]{10,}$/i.test(commit)) dirs.push(join(env.VSCODE_CWD, commit.slice(0, 10), 'resources', 'app'));
    dirs.push(join(env.VSCODE_CWD, 'resources', 'app'));
  }
  return dirs;
}

interface Product { dir: string; name: string; version: string | null }

/** The editor's own name and version, from its `product.json` (version, else `package.json`'s). */
function vscodeProduct(p: OriginProbe): Product | null {
  for (const dir of vscodeAppDirs(p.env)) {
    const product = p.readJson(join(dir, 'product.json'));
    const productName = name(field(product, 'nameLong')) ?? name(field(product, 'nameShort'));
    if (!productName) continue;
    const version = ver(field(product, 'version')) ?? ver(field(p.readJson(join(dir, 'package.json')), 'version'));
    return { dir, name: productName, version };
  }
  return null;
}

/** VS Code's version without its install folder: its terminal's `TERM_PROGRAM_VERSION`,
 *  or the version in its IPC pipe name (`...-1.144.0-main-sock`). */
function vscodeVersionHint(env: NodeJS.ProcessEnv): string | null {
  if (env.TERM_PROGRAM === 'vscode' && ver(env.TERM_PROGRAM_VERSION)) return ver(env.TERM_PROGRAM_VERSION);
  const m = /-(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)-main-sock/.exec(env.VSCODE_IPC_HOOK ?? '');
  return m ? m[1] : null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The GitHub Copilot Chat version this editor runs: a user-installed
 * `github.copilot-chat` (the newest listed in `extensions.json`) wins over the
 * copy recent VS Code builds ship in `resources/app/extensions/copilot`.
 */
function copilotVersion(p: OriginProbe, product: Product | null): string | null {
  const insiders = /insiders/i.test(product?.name ?? '');
  const list = p.readJson(join(p.home, insiders ? '.vscode-insiders' : '.vscode', 'extensions', 'extensions.json'));
  let best: string | null = null;
  if (Array.isArray(list)) {
    for (const e of list) {
      const id = field(field(e, 'identifier'), 'id');
      const v = ver(field(e, 'version'));
      if (typeof id === 'string' && id.toLowerCase() === 'github.copilot-chat' && v && (!best || compareVersions(v, best) > 0)) best = v;
    }
  }
  if (best) return best;
  const dirs = product ? [product.dir] : vscodeAppDirs(p.env);
  for (const dir of dirs) {
    const v = ver(field(p.readJson(join(dir, 'extensions', 'copilot', 'package.json')), 'version'));
    if (v) return v;
  }
  return null;
}

// ── assistants ────────────────────────────────────────────────────────────────

/** MCP client names as product names, matched loosely: the string is the host's to choose. */
const CLIENT_NAMES: Array<[RegExp, string]> = [
  [/kilo/i, 'Kilo Code'],
  [/claude[\s_-]*code/i, 'Claude Code'],
  [/codex/i, 'Codex'],
  [/cursor/i, 'Cursor'],
  [/gemini/i, 'Gemini CLI'],
  [/copilot/i, 'GitHub Copilot'],
  [/windsurf/i, 'Windsurf'],
  [/opencode/i, 'OpenCode'],
  [/\bcline\b/i, 'Cline'],
  [/roo[\s_-]*(code|cline)/i, 'Roo Code'],
  [/\bkiro\b/i, 'Kiro'],
];

function clientProduct(raw: string): string {
  for (const [re, product] of CLIENT_NAMES) if (re.test(raw)) return product;
  return raw.slice(0, ORIGIN_NAME_MAX);
}

/** Kilo Code (or the Kilo CLI) from the variables it starts its tools with. It also
 *  sets `OPENCODE=1` and `AGENT=1`, which is why it is checked before the generic markers. */
function kiloEnv(env: NodeJS.ProcessEnv): { assistant: string; version: string | null; editor: string | null; editorVersion: string | null } | null {
  if (!(set(env.KILO) || env.KILO_APP_NAME || env.KILOCODE_VERSION)) return null;
  const platform = (env.KILO_PLATFORM ?? env.KILO_CLIENT ?? '').toLowerCase();
  const assistant = platform === 'cli' ? 'Kilo CLI' : 'Kilo Code';
  const editor = name(env.KILO_EDITOR_NAME);
  let editorVersion: string | null = null;
  const full = (env.KILOCODE_EDITOR_NAME ?? '').trim();
  if (editor && full.toLowerCase().startsWith(editor.toLowerCase())) editorVersion = ver(full.slice(editor.length));
  if (!editorVersion && editor && platform === 'vscode') editorVersion = ver(env.KILO_VSCODE_VERSION);
  return { assistant, version: ver(env.KILO_APP_VERSION) ?? ver(env.KILOCODE_VERSION), editor, editorVersion };
}

// ── detection ─────────────────────────────────────────────────────────────────

/** The assistant and host environment for a row filed on `channel`. Never throws. */
export function detectOrigin(channel: Channel, probe?: Partial<OriginProbe>): ReportOrigin {
  const p: OriginProbe = {
    env: probe?.env ?? process.env,
    client: probe?.client ?? { name: mcpClient(), version: mcpClientVersion() },
    readJson: probe?.readJson ?? readJsonFile,
    home: probe?.home ?? homedir(),
  };
  const origin: ReportOrigin = { assistant: null, assistantVersion: null, hostEnv: null, hostEnvVersion: null };
  try {
    const env = p.env;
    const client = name(p.client.name);
    const clientVersion = ver(p.client.version);
    const vscodeClient = client !== null && VSCODE_CLIENT.test(client);
    const kilo = kiloEnv(env);
    const inVsCode = vscodeClient || inVsCodeTerminal(env) || (kilo?.editor ? /visual studio code|vscode/i.test(kilo.editor) : false);
    let product: Product | null | undefined;
    const editorProduct = (): Product | null => (product === undefined ? (product = inVsCode ? vscodeProduct(p) : null) : product);

    // The assistant. The MCP handshake is the client's own word; VS Code's own
    // MCP client is the one GitHub Copilot's agent mode uses.
    if (client) {
      if (vscodeClient) {
        origin.assistant = 'GitHub Copilot';
        origin.assistantVersion = copilotVersion(p, editorProduct());
      } else {
        origin.assistant = clientProduct(client);
        origin.assistantVersion = clientVersion ?? (origin.assistant === 'Kilo Code' && kilo ? kilo.version : null);
      }
    } else if (kilo) {
      origin.assistant = kilo.assistant;
      origin.assistantVersion = kilo.version;
    } else {
      const agent = callingAgent(env);
      if (agent) {
        origin.assistant = AGENT_NAMES[agent];
        if (agent === 'copilot' && inVsCode) origin.assistantVersion = copilotVersion(p, editorProduct());
      } else if (channel === 'hook') {
        origin.assistant = 'Claude Code'; // graft's hooks are Claude Code's (src/claude/)
      }
    }

    // The host environment.
    const term = env.TERM_PROGRAM ?? '';
    if (vscodeClient) {
      const pr = editorProduct();
      origin.hostEnv = pr?.name ?? client;
      origin.hostEnvVersion = clientVersion ?? pr?.version ?? null;
    } else if (kilo?.editor) {
      origin.hostEnv = kilo.editor;
      origin.hostEnvVersion = kilo.editorVersion ?? editorProduct()?.version ?? null;
    } else if (inVsCode) {
      const pr = editorProduct();
      origin.hostEnv = pr?.name ?? 'Visual Studio Code';
      origin.hostEnvVersion = pr?.version ?? vscodeVersionHint(env);
    } else if (/^(windsurf|kiro)$/i.test(term)) {
      origin.hostEnv = term.toLowerCase() === 'kiro' ? 'Kiro' : 'Windsurf';
      origin.hostEnvVersion = ver(env.TERM_PROGRAM_VERSION);
    } else if (env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') {
      origin.hostEnv = 'JetBrains IDE';
    } else if (name(term)) {
      origin.hostEnv = name(term);
      origin.hostEnvVersion = ver(env.TERM_PROGRAM_VERSION);
    } else if (set(env.WT_SESSION)) {
      origin.hostEnv = 'Windows Terminal';
    } else if (channel === 'cli' || kilo?.assistant === 'Kilo CLI' || env.CLAUDE_CODE_ENTRYPOINT === 'cli') {
      origin.hostEnv = 'Terminal';
    }
  } catch {
    /* an origin is never worth an error */
  }
  return origin;
}

let cached: { key: string; origin: ReportOrigin } | null = null;

/** {@link detectOrigin} for this process, cached: neither the environment nor the
 *  MCP client changes while it runs. */
export function processOrigin(channel: Channel): ReportOrigin {
  const key = `${channel}\u0000${mcpClient() ?? ''}\u0000${mcpClientVersion() ?? ''}`;
  if (cached?.key !== key) cached = { key, origin: detectOrigin(channel) };
  return cached.origin;
}
