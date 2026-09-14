/**
 * Reading the running model out of VS Code's own chat session files.
 *
 * This is the answer for GitHub Copilot, the host that can use neither of
 * graft's other two. It has no hook surface, and graft registers no MCP server
 * for it — so it drives the CLI from the integrated terminal, where the only
 * thing that could ever name the model was an `--agent-model` flag the agent
 * mostly does not pass. Every Copilot session therefore reported tokens and no
 * dollars.
 *
 * The fixtures below are built from the real shapes on disk: percent-encoded
 * `file://` URLs, multi-root `.code-workspace` files with comments in them, the
 * `copilot/auto` picker value that has to resolve to a real model, and the
 * freshly-opened session log that contains no model at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  inVsCodeTerminal,
  sessionModelFrom,
  vscodeSessionModel,
  workspaceFolders,
} from '../src/hosts/vscode-session.js';
import { hostModelFor } from '../src/hosts/host-model.js';
import { tmpRepo } from './helpers.js';

/** VS Code's user dir for a scratch HOME, on the platform being simulated. */
function userDir(home: string): string {
  return join(home, 'AppData', 'Roaming', 'Code', 'User');
}

/** One workspace-storage entry: a `workspace.json` plus its chat session logs. */
function workspaceEntry(
  home: string,
  id: string,
  meta: object,
  sessions: Array<{ name: string; body: string; ageMs?: number }>,
): void {
  const dir = join(userDir(home), 'workspaceStorage', id);
  mkdirSync(join(dir, 'chatSessions'), { recursive: true });
  writeFileSync(join(dir, 'workspace.json'), JSON.stringify(meta));
  for (const s of sessions) {
    const p = join(dir, 'chatSessions', s.name);
    writeFileSync(p, s.body);
    if (s.ageMs) {
      const when = (Date.now() - s.ageMs) / 1000;
      utimesSync(p, when, when);
    }
  }
}

/** A chat log naming a model, in the append-only shape VS Code writes. */
function log(modelId: string, resolved?: string): string {
  const req = { requestId: 'r1', modelId, ...(resolved ? { result: { resolvedModel: resolved } } : {}) };
  return `${JSON.stringify({ kind: 0, v: { requests: [req] } })}\n`;
}

const vscodeEnv = { APPDATA: '', TERM_PROGRAM: 'vscode' };

/** `env` for a scratch home, since APPDATA is what locates the user dir. */
function envFor(home: string): NodeJS.ProcessEnv {
  return { ...vscodeEnv, APPDATA: join(home, 'AppData', 'Roaming') };
}

// ── which model a log names ───────────────────────────────────────────────

test('the resolved model wins over the picker value', () => {
  // `copilot/auto` is a router, not a model, and it is the default the picker
  // sits on — so resolving it is what makes the common case priceable at all.
  const text = log('copilot/auto', 'claude-haiku-4-5-20251001');
  assert.equal(sessionModelFrom(text), 'claude-haiku-4-5-20251001');
});

test('the last model in an append-only log is the current one', () => {
  // The file is a snapshot followed by deltas, so a mid-conversation switch
  // appears as a later occurrence rather than a rewrite.
  const text = log('copilot/claude-opus-5', 'claude-opus-5') + log('copilot/gemini-3.7-flash', 'gemini-3.7-flash');
  assert.equal(sessionModelFrom(text), 'gemini-3.7-flash');
});

test('a picked model is used when nothing has resolved yet', () => {
  // A turn still in flight has named its model but not yet recorded a result.
  assert.equal(sessionModelFrom(log('claude-opus-5')), 'claude-opus-5');
});

test('`auto` alone names nothing — it is a router, not a model', () => {
  // Pricing this would mean guessing which model the router chose, which is the
  // one thing the pricing layer must never do.
  assert.equal(sessionModelFrom(log('copilot/auto')), null);
  assert.equal(sessionModelFrom(log('auto')), null);
});

test('a log with no model at all names nothing', () => {
  assert.equal(sessionModelFrom('{"kind":0,"v":{"requests":[]}}\n'), null);
  assert.equal(sessionModelFrom(''), null);
});

// ── mapping a workspace to its folders ────────────────────────────────────

test('a plain opened folder is decoded from its file URL', () => {
  // Percent-encoding is not cosmetic here: a real path on the machine this was
  // written against contains `!`, which arrives as `%21`.
  const home = tmpRepo('vsc-folder');
  const meta = join(home, 'workspace.json');
  writeFileSync(meta, JSON.stringify({ folder: pathToFileURL('D:/!stuff/work/repo').href }));
  assert.deepEqual(workspaceFolders(meta).map((p) => p.replace(/\\/g, '/')), ['D:/!stuff/work/repo']);
});

test('a multi-root .code-workspace resolves every folder, comments and all', () => {
  // The shape that matters: VED-ChAIR is opened through a `.code-workspace`
  // whose folders are relative (`"."`) and whose settings carry `//` comments.
  // Treating the file's own path as the repo would match the wrong directory.
  const home = tmpRepo('vsc-multiroot');
  const repoA = join(home, 'projectA');
  mkdirSync(repoA, { recursive: true });
  const wsFile = join(home, 'ChAIR.code-workspace');
  writeFileSync(
    wsFile,
    `{
  // a comment VS Code allows and JSON.parse does not
  "folders": [{ "path": "." }, { "path": "projectA" }],
  "settings": {}
}`,
  );
  const meta = join(home, 'workspace.json');
  writeFileSync(meta, JSON.stringify({ workspace: pathToFileURL(wsFile).href }));

  const got = workspaceFolders(meta).map((p) => p.replace(/\\/g, '/'));
  assert.equal(got.length, 2);
  assert.ok(got.some((p) => p.toLowerCase() === home.replace(/\\/g, '/').toLowerCase()));
  assert.ok(got.some((p) => p.toLowerCase() === repoA.replace(/\\/g, '/').toLowerCase()));
});

test('an unreadable or foreign workspace.json maps to nothing', () => {
  const home = tmpRepo('vsc-badmeta');
  const meta = join(home, 'workspace.json');
  writeFileSync(meta, 'not json at all');
  assert.deepEqual(workspaceFolders(meta), []);
  writeFileSync(meta, JSON.stringify({ somethingElse: true }));
  assert.deepEqual(workspaceFolders(meta), []);
});

// ── the lookup ────────────────────────────────────────────────────────────

test('the live chat session for a repo names its model', () => {
  const home = tmpRepo('vsc-hit');
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  workspaceEntry(home, 'ws1', { folder: pathToFileURL(repo).href }, [
    { name: 'a.jsonl', body: log('copilot/auto', 'claude-opus-5') },
  ]);
  assert.equal(vscodeSessionModel(repo, { home, env: envFor(home), os: 'win32' }), 'claude-opus-5');
});

test('a subdirectory of the workspace folder still resolves', () => {
  // graft may be invoked from anywhere inside the repo, not only its root.
  const home = tmpRepo('vsc-subdir');
  const repo = join(home, 'repo');
  const sub = join(repo, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  workspaceEntry(home, 'ws1', { folder: pathToFileURL(repo).href }, [
    { name: 'a.jsonl', body: log('gpt-5.6-sol', 'gpt-5.6-sol') },
  ]);
  assert.equal(vscodeSessionModel(sub, { home, env: envFor(home), os: 'win32' }), 'gpt-5.6-sol');
});

test('a freshly-opened empty session does not mask the one behind it', () => {
  // The bug this caught on real data: VS Code touches a log when a chat is
  // merely opened, so the NEWEST file is routinely one with no request in it.
  // Stopping there reported "unknown" while the answer sat one file back.
  const home = tmpRepo('vsc-empty-newest');
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  workspaceEntry(home, 'ws1', { folder: pathToFileURL(repo).href }, [
    { name: 'older.jsonl', body: log('copilot/claude-opus-5', 'claude-opus-5'), ageMs: 60_000 },
    { name: 'newest.jsonl', body: '{"kind":0,"v":{"requests":[]}}\n' },
  ]);
  assert.equal(vscodeSessionModel(repo, { home, env: envFor(home), os: 'win32' }), 'claude-opus-5');
});

test('another workspace\'s session never prices this repo', () => {
  const home = tmpRepo('vsc-other');
  const mine = join(home, 'mine');
  const theirs = join(home, 'theirs');
  mkdirSync(mine, { recursive: true });
  mkdirSync(theirs, { recursive: true });
  workspaceEntry(home, 'ws-theirs', { folder: pathToFileURL(theirs).href }, [
    { name: 'a.jsonl', body: log('claude-opus-5', 'claude-opus-5') },
  ]);
  assert.equal(vscodeSessionModel(mine, { home, env: envFor(home), os: 'win32' }), null);
});

test('a stale chat session prices nothing', () => {
  // A project closed last week must not price today's savings.
  const home = tmpRepo('vsc-stale');
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  workspaceEntry(home, 'ws1', { folder: pathToFileURL(repo).href }, [
    { name: 'a.jsonl', body: log('claude-opus-5', 'claude-opus-5'), ageMs: 7 * 24 * 3600_000 },
  ]);
  assert.equal(vscodeSessionModel(repo, { home, env: envFor(home), os: 'win32' }), null);
  // ...but a wider window still finds it, so the cutoff is the only reason.
  assert.equal(
    vscodeSessionModel(repo, { home, env: envFor(home), os: 'win32', maxAgeMs: 30 * 24 * 3600_000 }),
    'claude-opus-5',
  );
});

test('no VS Code on the machine is simply no answer', () => {
  const home = tmpRepo('vsc-absent');
  assert.equal(vscodeSessionModel(join(home, 'repo'), { home, env: envFor(home), os: 'win32' }), null);
});

// ── the gate ──────────────────────────────────────────────────────────────

test('a VS Code terminal is recognised, a plain shell is not', () => {
  assert.equal(inVsCodeTerminal({ TERM_PROGRAM: 'vscode' }), true);
  assert.equal(inVsCodeTerminal({ VSCODE_PID: '1234' }), true, 'spawned by the extension host');
  assert.equal(inVsCodeTerminal({}), false, 'a plain shell');
  assert.equal(inVsCodeTerminal({ TERM_PROGRAM: 'iTerm.app' }), false, 'another terminal');
});

test('outside VS Code the registry reads nothing, even with sessions on disk', () => {
  // The leak this gate closes: a plain shell on a machine that merely HAS VS
  // Code would otherwise be priced at whatever model some editor window is
  // running — the same mistake as showing Kilo's model table to Cursor.
  const home = tmpRepo('vsc-gate');
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  workspaceEntry(home, 'ws1', { folder: pathToFileURL(repo).href }, [
    { name: 'a.jsonl', body: log('claude-opus-5', 'claude-opus-5') },
  ]);
  const plain = { APPDATA: join(home, 'AppData', 'Roaming') };
  assert.equal(hostModelFor(repo, { home, env: plain }), null, 'plain shell: nothing');
  assert.equal(
    hostModelFor(repo, { home, env: { ...plain, TERM_PROGRAM: 'vscode' } }),
    'claude-opus-5',
    'inside VS Code: the running model',
  );
});

test('the registry does not read Kilo\'s database for a non-Kilo client', () => {
  // Kilo's source is gated on the MCP handshake name, not the environment: its
  // server is spawned by the client that just named itself.
  const home = tmpRepo('vsc-kilo-gate');
  assert.equal(hostModelFor(join(home, 'repo'), { home, env: {}, mcpClient: 'Cursor' }), null);
});
