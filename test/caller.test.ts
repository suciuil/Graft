/**
 * Which agent made a graft call (src/context/caller.ts): the key that keeps
 * one agent's calls apart from another's in the same repo, for
 * `graft savings --last` and the turn's model mix in the savings footer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { callerOf, detectCaller, type CallerProbe } from '../src/context/caller.js';

const norm = (p: string): string => p.replace(/\\/g, '/');

/** A probe with `env`, an optional MCP client name, and JSON files by path. */
function probe(env: NodeJS.ProcessEnv, files: Record<string, unknown> = {}, client: string | null = null): Partial<CallerProbe> {
  const byPath = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return { env, client, readJson: (p) => byPath.get(norm(p)) ?? null };
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
    assert.deepEqual(detectCaller(channel, probe(KILO_IN_VSCODE)), { assistant: 'Kilo Code', hostEnv: 'Visual Studio Code' });
  }
});

test('callerOf: one key per agent, so two agents in one repo are not one turn', () => {
  // Kilo over MCP and from its own shell is one caller, whatever its platform
  assert.equal(callerOf(detectCaller('mcp', probe({}, {}, 'Kilo Code'))), 'Kilo');
  assert.equal(callerOf(detectCaller('cli', probe(KILO_IN_VSCODE))), 'Kilo');
  assert.equal(callerOf(detectCaller('cli', probe({ KILO: '1', KILO_PLATFORM: 'cli' }))), 'Kilo');
  // Copilot drives graft from a VS Code terminal that names no agent, or as VS Code's MCP client
  const copilotTerminal = callerOf(detectCaller('cli', probe({ TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.145.1' })));
  assert.equal(copilotTerminal, 'GitHub Copilot');
  assert.equal(callerOf(detectCaller('mcp', probe({ VSCODE_PID: '1' }, {}, 'Visual Studio Code'))), 'GitHub Copilot');
  assert.notEqual(copilotTerminal, callerOf(detectCaller('cli', probe(KILO_IN_VSCODE))), 'Kilo in VS Code is not Copilot');
  // Claude Code in VS Code's terminal is Claude Code, not Copilot
  assert.equal(callerOf(detectCaller('cli', probe({ CLAUDECODE: '1', TERM_PROGRAM: 'vscode' }))), 'Claude Code');
  // A person at a plain terminal: the terminal; nothing at all: null
  assert.equal(callerOf(detectCaller('cli', probe({ WT_SESSION: 'abc' }))), 'Windows Terminal');
  assert.equal(callerOf({ assistant: null, hostEnv: null }), null);
  // Every VS Code build counts, and only those: the editor names itself from product.json
  const host = (hostEnv: string) => callerOf({ assistant: null, hostEnv });
  for (const name of ['Visual Studio Code', 'Visual Studio Code - Insiders', 'Code - OSS', 'VSCodium']) {
    assert.equal(host(name), 'GitHub Copilot', name);
  }
  assert.equal(host('Cursor'), 'Cursor');
});

test('a VS Code-family editor is named from its own product.json', () => {
  const app = join('/opt/cursor', 'resources', 'app');
  const env = { TERM_PROGRAM: 'vscode', VSCODE_CWD: '/opt/cursor' };
  const files = { [join(app, 'product.json')]: { nameLong: 'Cursor', version: '1.0.0' } };
  assert.deepEqual(detectCaller('cli', probe(env, files)), { assistant: null, hostEnv: 'Cursor' });
  assert.equal(callerOf(detectCaller('cli', probe(env, files))), 'Cursor');
});

test('detection never throws', () => {
  const throwing: Partial<CallerProbe> = { env: { TERM_PROGRAM: 'vscode', VSCODE_CWD: '/x' }, client: null, readJson: () => { throw new Error('boom'); } };
  assert.doesNotThrow(() => detectCaller('cli', throwing));
});
