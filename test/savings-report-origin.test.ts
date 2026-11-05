/**
 * Which AI assistant and host environment a savings-report row names
 * (src/reporting/origin.ts): from the MCP handshake, the environment the
 * assistant or editor started graft with, and the editor's own product.json.
 * Product names and versions only; anything graft cannot tell is null.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { detectOrigin, type OriginProbe } from '../src/reporting/origin.js';
import { mcpClient, mcpClientVersion, setMcpClient } from '../src/mcp/client.js';

const norm = (p: string): string => p.replace(/\\/g, '/');

/** A probe with `env`, an optional MCP client, and JSON files by path. */
function probe(env: NodeJS.ProcessEnv, files: Record<string, unknown> = {}, client: OriginProbe['client'] = { name: null, version: null }): Partial<OriginProbe> {
  const byPath = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return { env, client, home: '/home/u', readJson: (p) => byPath.get(norm(p)) ?? null };
}

/** What Kilo Code 7.8.18 in VS Code 1.144.0 hands the tools it runs (seen on Windows). */
const KILO_IN_VSCODE: NodeJS.ProcessEnv = {
  AGENT: '1',
  OPENCODE: '1',
  KILO: '1',
  KILO_APP_NAME: 'kilo-code',
  KILO_APP_VERSION: '7.8.18',
  KILO_CLIENT: 'vscode',
  KILO_PLATFORM: 'vscode',
  KILO_EDITOR_NAME: 'Visual Studio Code',
  KILOCODE_EDITOR_NAME: 'Visual Studio Code 1.144.0',
  KILO_VSCODE_VERSION: '1.144.0',
  KILOCODE_VERSION: '7.8.18',
  VSCODE_PID: '5748',
  VSCODE_IPC_HOOK: '\\\\.\\pipe\\1b1c46dc-1.144.0-main-sock',
};

test('Kilo Code in VS Code: named by its own variables, not as OpenCode', () => {
  for (const channel of ['cli', 'mcp', 'hook'] as const) {
    assert.deepEqual(detectOrigin(channel, probe(KILO_IN_VSCODE)), {
      assistant: 'Kilo Code', assistantVersion: '7.8.18', hostEnv: 'Visual Studio Code', hostEnvVersion: '1.144.0',
    }, channel);
  }
});

test('the Kilo CLI in a terminal', () => {
  const o = detectOrigin('cli', probe({ KILO: '1', OPENCODE: '1', KILO_PLATFORM: 'cli', KILO_APP_VERSION: '7.9.0' }));
  assert.deepEqual(o, { assistant: 'Kilo CLI', assistantVersion: '7.9.0', hostEnv: 'Terminal', hostEnvVersion: null });
});

test('VS Code as the MCP client: GitHub Copilot, with the Copilot Chat version it runs', () => {
  const app = 'C:\\Programs\\Microsoft VS Code\\2c33b50b16\\resources\\app';
  const env = { VSCODE_NODE_COMPILE_CACHE_ROOT: `${app}\\node-compile-cache`, VSCODE_PID: '1' };
  const files = {
    [join(app, 'product.json')]: { nameLong: 'Visual Studio Code', version: '1.144.0' },
    [join(app, 'extensions', 'copilot', 'package.json')]: { name: 'copilot-chat', version: '0.72.0' },
  };
  const client = { name: 'Visual Studio Code', version: '1.144.0' };
  assert.deepEqual(detectOrigin('mcp', probe(env, files, client)), {
    assistant: 'GitHub Copilot', assistantVersion: '0.72.0', hostEnv: 'Visual Studio Code', hostEnvVersion: '1.144.0',
  });
  // A user-installed Copilot Chat wins over the built-in one; the newest listed counts
  const withUserExt = {
    ...files,
    [join('/home/u', '.vscode', 'extensions', 'extensions.json')]: [
      { identifier: { id: 'GitHub.copilot-chat' }, version: '0.80.1' },
      { identifier: { id: 'github.copilot-chat' }, version: '0.79.9' },
      { identifier: { id: 'automotive.kilo-code' }, version: '7.8.18' },
    ],
  };
  assert.equal(detectOrigin('mcp', probe(env, withUserExt, client)).assistantVersion, '0.80.1');
});

test('another MCP client names itself; the host comes from its environment', () => {
  const o = detectOrigin('mcp', probe({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.10' }, {}, { name: 'claude-code', version: '2.1.3' }));
  assert.deepEqual(o, { assistant: 'Claude Code', assistantVersion: '2.1.3', hostEnv: 'iTerm.app', hostEnvVersion: '3.5.10' });
  assert.equal(detectOrigin('mcp', probe({}, {}, { name: 'codex-mcp-client', version: '0.50.0' })).assistant, 'Codex');
  assert.equal(detectOrigin('mcp', probe({}, {}, { name: 'Some New Agent', version: null })).assistant, 'Some New Agent');
});

test('Cursor: the editor name and version come from its own product.json', () => {
  const env = { CURSOR_AGENT: '1', VSCODE_CWD: 'C:\\Cursor', VSCODE_CODE_CACHE_PATH: 'C:\\Users\\u\\AppData\\Roaming\\Cursor\\CachedData\\0123456789abcdef0123' };
  const files = { [join('C:\\Cursor', '0123456789', 'resources', 'app', 'product.json')]: { nameLong: 'Cursor', version: '1.7.2' } };
  assert.deepEqual(detectOrigin('cli', probe(env, files)), { assistant: 'Cursor', assistantVersion: null, hostEnv: 'Cursor', hostEnvVersion: '1.7.2' });
});

test('Claude Code hooks in VS Code\'s terminal, without the install folder', () => {
  const o = detectOrigin('hook', probe({ TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.143.2' }));
  assert.deepEqual(o, { assistant: 'Claude Code', assistantVersion: null, hostEnv: 'Visual Studio Code', hostEnvVersion: '1.143.2' });
});

test('a person at the command line: no assistant; the terminal when it says', () => {
  assert.deepEqual(detectOrigin('cli', probe({ WT_SESSION: 'abc' })), { assistant: null, assistantVersion: null, hostEnv: 'Windows Terminal', hostEnvVersion: null });
  assert.deepEqual(detectOrigin('cli', probe({ TERMINAL_EMULATOR: 'JetBrains-JediTerm' })).hostEnv, 'JetBrains IDE');
  assert.deepEqual(detectOrigin('cli', probe({})), { assistant: null, assistantVersion: null, hostEnv: 'Terminal', hostEnvVersion: null });
  // VS Code's version from its IPC pipe name when nothing else says
  assert.deepEqual(detectOrigin('cli', probe({ VSCODE_IPC_HOOK: '\\\\.\\pipe\\ab12-1.144.0-main-sock' })).hostEnvVersion, '1.144.0');
});

test('names and versions are cut to the column widths; a failing read is not an error', () => {
  const o = detectOrigin('mcp', probe({}, {}, { name: 'x'.repeat(300), version: '9'.repeat(80) }));
  assert.equal(o.assistant?.length, 100);
  assert.equal(o.assistantVersion?.length, 50);
  const throwing: Partial<OriginProbe> = { env: { VSCODE_PID: '1', VSCODE_CWD: 'C:\\x' }, client: { name: null, version: null }, home: '/h', readJson: () => { throw new Error('EACCES'); } };
  assert.doesNotThrow(() => detectOrigin('cli', throwing));
});

test('the MCP handshake keeps the client version, and clears it with the name', () => {
  try {
    setMcpClient(' Visual Studio Code ', ' 1.144.0 ');
    assert.equal(mcpClient(), 'Visual Studio Code');
    assert.equal(mcpClientVersion(), '1.144.0');
    setMcpClient('Kilo Code');
    assert.equal(mcpClientVersion(), null);
    setMcpClient('', '1.0.0');
    assert.equal(mcpClientVersion(), null, 'no version without a name');
  } finally {
    setMcpClient(undefined);
  }
});
