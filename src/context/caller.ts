/**
 * Which agent made a graft call, as a key that tells one agent's calls from
 * another's in the same repo: `graft savings --last` and the turn's model mix
 * in the savings footer (see `context/recent-calls.ts`) count only the calls
 * of the agent asking.
 *
 * Local only: read from what the process was handed, kept in the repo's own
 * `graft/.cache/`, never sent anywhere (docs/no-cloud-policy.md):
 *   - the MCP `initialize` handshake (`clientInfo.name`, see src/mcp/client.ts)
 *     on the MCP surface;
 *   - the environment the assistant or editor started graft with: Kilo's
 *     `KILO_*` variables, the agents' own markers (src/hosts/auto.ts), VS
 *     Code's `VSCODE_*` / `TERM_PROGRAM*`, JetBrains' `TERMINAL_EMULATOR`,
 *     Windows Terminal's `WT_SESSION`;
 *   - for a VS Code-family editor, the product name in its own `product.json`,
 *     in the install folder those variables point at.
 *
 * Anything graft cannot tell is null. Never throws.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { AGENT_NAMES, callingAgent } from '../hosts/auto.js';
import { inVsCodeTerminal } from '../hosts/vscode-session.js';
import { mcpClient } from '../mcp/client.js';

/** The agent and the editor or terminal it runs in, as product names. */
export interface CallerOrigin {
  /** The AI assistant, e.g. `Kilo Code`, `GitHub Copilot`, `Claude Code`. */
  assistant: string | null;
  /** The host environment, e.g. `Visual Studio Code`, `Windows Terminal`, `Terminal`. */
  hostEnv: string | null;
}

/** Everything detection reads, injectable for tests. */
export interface CallerProbe {
  env: NodeJS.ProcessEnv;
  /** The MCP client name from the handshake; null on the CLI and hook surfaces. */
  client: string | null;
  /** Parsed JSON at a path, or null when missing or unreadable. */
  readJson: (path: string) => unknown;
}

export type Channel = 'cli' | 'mcp' | 'hook' | null;

const NAME_MAX = 100;
const name = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, NAME_MAX) : null);
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

/** A VS Code-family editor that names itself in the MCP handshake or its product.json. */
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

/** The editor's own name, from its `product.json`. */
function vscodeProductName(p: CallerProbe): string | null {
  for (const dir of vscodeAppDirs(p.env)) {
    const product = p.readJson(join(dir, 'product.json'));
    const productName = name(field(product, 'nameLong')) ?? name(field(product, 'nameShort'));
    if (productName) return productName;
  }
  return null;
}

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
  return raw.slice(0, NAME_MAX);
}

/** Kilo Code (or the Kilo CLI) from the variables it starts its tools with. It also
 *  sets `OPENCODE=1` and `AGENT=1`, which is why it is checked before the generic markers. */
function kiloEnv(env: NodeJS.ProcessEnv): { assistant: string; editor: string | null } | null {
  if (!(set(env.KILO) || env.KILO_APP_NAME || env.KILOCODE_VERSION)) return null;
  const platform = (env.KILO_PLATFORM ?? env.KILO_CLIENT ?? '').toLowerCase();
  return { assistant: platform === 'cli' ? 'Kilo CLI' : 'Kilo Code', editor: name(env.KILO_EDITOR_NAME) };
}

/** The assistant and host environment of a call made on `channel`. Never throws. */
export function detectCaller(channel: Channel, probe?: Partial<CallerProbe>): CallerOrigin {
  const p: CallerProbe = {
    env: probe?.env ?? process.env,
    client: probe && 'client' in probe ? (probe.client ?? null) : mcpClient(),
    readJson: probe?.readJson ?? readJsonFile,
  };
  const origin: CallerOrigin = { assistant: null, hostEnv: null };
  try {
    const env = p.env;
    const client = name(p.client);
    const vscodeClient = client !== null && VSCODE_CLIENT.test(client);
    const kilo = kiloEnv(env);
    const inVsCode = vscodeClient || inVsCodeTerminal(env) || (kilo?.editor ? /visual studio code|vscode/i.test(kilo.editor) : false);

    // The assistant. The MCP handshake is the client's own word; VS Code's own
    // MCP client is the one GitHub Copilot's agent mode uses.
    if (client) {
      origin.assistant = vscodeClient ? 'GitHub Copilot' : clientProduct(client);
    } else if (kilo) {
      origin.assistant = kilo.assistant;
    } else {
      const agent = callingAgent(env);
      if (agent) origin.assistant = AGENT_NAMES[agent];
      else if (channel === 'hook') origin.assistant = 'Claude Code'; // graft's hooks are Claude Code's (src/claude/)
    }

    // The host environment.
    const term = env.TERM_PROGRAM ?? '';
    if (vscodeClient) {
      origin.hostEnv = vscodeProductName(p) ?? client;
    } else if (kilo?.editor) {
      origin.hostEnv = kilo.editor;
    } else if (inVsCode) {
      origin.hostEnv = vscodeProductName(p) ?? 'Visual Studio Code';
    } else if (/^(windsurf|kiro)$/i.test(term)) {
      origin.hostEnv = term.toLowerCase() === 'kiro' ? 'Kiro' : 'Windsurf';
    } else if (env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') {
      origin.hostEnv = 'JetBrains IDE';
    } else if (name(term)) {
      origin.hostEnv = name(term);
    } else if (set(env.WT_SESSION)) {
      origin.hostEnv = 'Windows Terminal';
    } else if (channel === 'cli' || kilo?.assistant === 'Kilo CLI' || env.CLAUDE_CODE_ENTRYPOINT === 'cli') {
      origin.hostEnv = 'Terminal';
    }
  } catch {
    /* a caller is never worth an error */
  }
  return origin;
}

/**
 * Which agent made a call, as a key that tells one agent's calls from
 * another's in the same repo. Kilo Code and the Kilo CLI are one key: Kilo
 * reaches graft over MCP and from its shell in the same turn. A VS Code
 * terminal with no agent of its own named is GitHub Copilot's, as
 * `hostModelFor` assumes (graft registers no MCP server for Copilot, which
 * drives the CLI). Null when nothing names the caller.
 */
export function callerOf(o: CallerOrigin): string | null {
  const a = o.assistant;
  if (a) return /^Kilo\b/.test(a) ? 'Kilo' : a;
  if (o.hostEnv && VSCODE_CLIENT.test(o.hostEnv)) return 'GitHub Copilot';
  return o.hostEnv;
}

let cached: { key: string; caller: string | null } | null = null;

/** {@link callerOf} for this process, cached: neither the environment nor the
 *  MCP client changes while it runs. Never throws. */
export function callerKey(channel: Channel): string | null {
  try {
    const key = `${channel}\u0000${mcpClient() ?? ''}`;
    if (cached?.key !== key) cached = { key, caller: callerOf(detectCaller(channel)) };
    return cached.caller;
  } catch {
    return null;
  }
}
