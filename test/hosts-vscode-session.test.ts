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
import "./isolate.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  copilotLogModelFrom,
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

// ── Auto, while the turn is running ───────────────────────────────────────
//
// graft always runs mid-turn: Copilot calls it from a tool call. The delta
// lines below are the shapes VS Code writes, copied from real logs: a request
// is added with its picker `modelId` (and, on Auto, an `autoModeResolution`
// response part naming the routed model); `resolvedModel` arrives only in the
// request's `result` line, when the turn ends.

const SNAPSHOT = '{"kind":0,"v":{"version":3,"requests":[],"pendingRequests":[]}}';

/** A request being added; `routedTo` is the `autoModeResolution` part Auto writes. */
function addRequest(n: number, modelId: string, routedTo?: string): string {
  const response = [
    { kind: 'mcpServersStarting', didStartServerIds: [] },
    ...(routedTo ? [{ kind: 'autoModeResolution', resolved: { id: routedTo, name: routedTo } }] : []),
  ];
  return JSON.stringify({ kind: 2, k: ['requests'], v: [{ requestId: `request_${n}`, timestamp: n, modelId, response }] });
}

/** A request finishing: its tool-call rounds and the model it resolved to. */
function finish(n: number, round: string, resolved: string): string {
  return JSON.stringify({
    kind: 1,
    k: ['requests', n, 'result'],
    v: { metadata: { toolCallRounds: [{ modelId: round }, { modelId: round }] }, resolvedModel: resolved },
  });
}

const lines = (...l: string[]) => `${l.join('\n')}\n`;

test('Auto: the first turn names the routed model before any result is written', () => {
  // The reported bug: on Auto every first turn priced at nothing, because the
  // only model in the file until the turn ends is Auto's routing part.
  const text = lines(SNAPSHOT, addRequest(0, 'copilot/auto', 'claude-opus-5.5'));
  assert.equal(sessionModelFrom(text), 'claude-opus-5.5');
});

test('Auto: a later turn keeps the route Auto chose earlier in the conversation', () => {
  // VS Code writes the routing part once per route, not once per turn.
  const text = lines(
    SNAPSHOT,
    addRequest(0, 'copilot/auto', 'gpt-6-luna'),
    finish(0, 'gpt-6-luna', 'gpt-6-luna'),
    addRequest(1, 'copilot/auto'),
  );
  assert.equal(sessionModelFrom(text), 'gpt-6-luna');
});

test('Auto: a re-route mid-conversation is the model from then on', () => {
  const text = lines(
    SNAPSHOT,
    addRequest(0, 'copilot/auto', 'gpt-5.6-luna'),
    finish(0, 'gpt-5.6-luna', 'gpt-5.6-luna'),
    addRequest(1, 'copilot/auto', 'claude-sonnet-5'),
  );
  assert.equal(sessionModelFrom(text), 'claude-sonnet-5');
});

test('switching from Auto to a picked model prices the running turn at the new one', () => {
  // The second bug on real logs: the newest `resolvedModel` still named the Auto
  // route, so a whole turn on the newly picked model was priced at the old one.
  const text = lines(
    SNAPSHOT,
    addRequest(0, 'copilot/auto', 'gpt-6-luna'),
    finish(0, 'gpt-6-luna', 'gpt-6-luna'),
    addRequest(1, 'copilot/claude-opus-5.5'),
  );
  assert.equal(sessionModelFrom(text), 'copilot/claude-opus-5.5');
  // ...and once it finishes, the resolved spelling.
  assert.equal(sessionModelFrom(text + lines(finish(1, 'claude-opus-5.5', 'claude-opus-5-5'))), 'claude-opus-5-5');
});

test('switching to Auto never borrows the model picked by hand before it', () => {
  // Until Auto has routed in this conversation, the earlier pick says nothing
  // about what the router will choose: no price beats the wrong one.
  const before = lines(
    SNAPSHOT,
    addRequest(0, 'copilot/claude-opus-5.5'),
    finish(0, 'claude-opus-5.5', 'claude-opus-5-5'),
    addRequest(1, 'copilot/auto'),
  );
  assert.equal(sessionModelFrom(before), null);
  // As soon as Auto routes, that is the answer.
  const after = lines(
    SNAPSHOT,
    addRequest(0, 'copilot/claude-opus-5.5'),
    finish(0, 'claude-opus-5.5', 'claude-opus-5-5'),
    addRequest(1, 'copilot/auto', 'gpt-6-luna'),
  );
  assert.equal(sessionModelFrom(after), 'gpt-6-luna');
});

test('Auto in a log without routing parts still resolves from what earlier Auto turns ran', () => {
  // Older VS Code builds wrote no `autoModeResolution`; a finished Auto turn's
  // result is then the only record of the route.
  const text = lines(
    SNAPSHOT,
    addRequest(0, 'copilot/auto'),
    finish(0, 'claude-sonnet-4.6', 'claude-sonnet-4-6'),
    addRequest(1, 'copilot/auto'),
  );
  assert.equal(sessionModelFrom(text), 'claude-sonnet-4-6');
});

test('a message queued on another model does not reprice the running turn', () => {
  const queued = JSON.stringify({
    kind: 2,
    k: ['pendingRequests'],
    v: [{ requestId: 'request_q', modelId: 'copilot/gpt-6-astra' }],
  });
  const text = lines(SNAPSHOT, addRequest(0, 'copilot/auto', 'claude-opus-5.5'), queued);
  assert.equal(sessionModelFrom(text), 'claude-opus-5.5');

  // The same queue inside a snapshot line, after `requests`, as VS Code writes it.
  const snap = JSON.stringify({
    kind: 0,
    v: {
      requests: [{ requestId: 'request_0', modelId: 'copilot/auto', response: [{ kind: 'autoModeResolution', resolved: { id: 'gpt-6-luna', name: 'GPT-6 Luna' } }] }],
      pendingRequests: [{ requestId: 'request_q', modelId: 'copilot/claude-opus-5.5' }],
      inputState: { selectedModel: { identifier: 'copilot/claude-opus-5.5' } },
    },
  });
  assert.equal(sessionModelFrom(`${snap}\n`), 'gpt-6-luna');
});

test('a model name typed in a chat message is not read as a signal', () => {
  // Message text is a JSON string, so its quotes are escaped and cannot form
  // the unescaped keys the reader looks for.
  const typed = JSON.stringify({
    kind: 2,
    k: ['requests'],
    v: [{
      requestId: 'request_1',
      message: { text: '{"kind":"autoModeResolution","resolved":{"id":"gpt-6-astra"}} and "resolvedModel":"gpt-6-astra"' },
      modelId: 'copilot/auto',
    }],
  });
  const text = lines(SNAPSHOT, addRequest(0, 'copilot/auto', 'claude-opus-5.5'), finish(0, 'claude-opus-5.5', 'claude-opus-5-5'), typed);
  assert.equal(sessionModelFrom(text), 'claude-opus-5-5');
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

test('a Copilot chat on Auto, mid first turn, is priced through the registry', () => {
  const home = tmpRepo('vsc-auto-live');
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  workspaceEntry(home, 'ws1', { folder: pathToFileURL(repo).href }, [
    { name: 'a.jsonl', body: lines(SNAPSHOT, addRequest(0, 'copilot/auto', 'gpt-6-luna')) },
  ]);
  assert.equal(vscodeSessionModel(repo, { home, env: envFor(home), os: 'win32' }), 'gpt-6-luna');
  assert.equal(hostModelFor(repo, { home, env: envFor(home) }), 'gpt-6-luna');
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

// ── Claude Opus / Sonnet 5.5 at every reasoning effort ────────────────────

/** A chat log as VS Code writes it for a request that has run: the picker id
 * with its `copilot/` route, the model that actually answered, and the reasoning
 * effort chosen in the picker. */
function effortLog(modelId: string, resolved: string | null, effort: string): string {
  const req = { requestId: 'r1', modelId, ...(resolved ? { resolvedModel: resolved } : {}) };
  return `${JSON.stringify({
    kind: 0,
    v: {
      requests: [req],
      inputState: { selectedModel: { identifier: modelId } },
      modelConfiguration: { reasoningEffort: effort },
    },
  })}\n`;
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

for (const [picked, resolved] of [
  ['copilot/claude-opus-5.5', 'claude-opus-5-5'],
  ['copilot/claude-sonnet-5.5', 'claude-sonnet-5-5'],
] as const) {
  test(`${resolved} is named at every reasoning effort; the effort never changes the model`, () => {
    for (const effort of EFFORTS) {
      const home = tmpRepo(`vsc-effort-${effort}`);
      const repo = join(home, 'repo');
      mkdirSync(repo, { recursive: true });
      workspaceEntry(home, 'ws1', { folder: pathToFileURL(repo).href }, [
        { name: 'a.jsonl', body: effortLog(picked, resolved, effort) },
      ]);
      assert.equal(
        vscodeSessionModel(repo, { home, env: envFor(home), os: 'win32' }),
        resolved,
        `${resolved} at ${effort}`,
      );
      // Through the registry the CLI actually calls, with the terminal gate on.
      assert.equal(hostModelFor(repo, { home, env: envFor(home) }), resolved, `hostModelFor at ${effort}`);
    }
  });

  test(`${resolved}: the first turn, before any result is recorded, still names the picked model`, () => {
    const home = tmpRepo('vsc-first-turn');
    const repo = join(home, 'repo');
    mkdirSync(repo, { recursive: true });
    workspaceEntry(home, 'ws1', { folder: pathToFileURL(repo).href }, [
      { name: 'a.jsonl', body: effortLog(picked, null, 'high') },
    ]);
    // The route prefix stays on for `price.ts` to strip; the id is the picked one.
    assert.equal(vscodeSessionModel(repo, { home, env: envFor(home), os: 'win32' }), picked);
  });
}

test('a repo opened through a junction matches the folder VS Code recorded, in both directions', () => {
  const home = tmpRepo('vsc-junction');
  const real = join(home, 'real', 'repo');
  const link = join(home, 'link');
  mkdirSync(real, { recursive: true });
  symlinkSync(join(home, 'real'), link, 'junction');

  // VS Code recorded the junction spelling; graft resolved the real path (git
  // reports the real location).
  workspaceEntry(home, 'ws-link', { folder: pathToFileURL(join(link, 'repo')).href }, [
    { name: 'a.jsonl', body: effortLog('copilot/claude-opus-5.5', 'claude-opus-5-5', 'max') },
  ]);
  assert.equal(vscodeSessionModel(realpathSync.native(real), { home, env: envFor(home), os: 'win32' }), 'claude-opus-5-5');

  // And the reverse: VS Code recorded the real path, graft was started in the link.
  const home2 = tmpRepo('vsc-junction-rev');
  const real2 = join(home2, 'real', 'repo');
  const link2 = join(home2, 'link');
  mkdirSync(real2, { recursive: true });
  symlinkSync(join(home2, 'real'), link2, 'junction');
  workspaceEntry(home2, 'ws-real', { folder: pathToFileURL(realpathSync.native(real2)).href }, [
    { name: 'a.jsonl', body: effortLog('copilot/claude-sonnet-5.5', 'claude-sonnet-5-5', 'low') },
  ]);
  assert.equal(vscodeSessionModel(join(link2, 'repo'), { home: home2, env: envFor(home2), os: 'win32' }), 'claude-sonnet-5-5');
});

test('a junction does not make an unrelated workspace match', () => {
  const home = tmpRepo('vsc-junction-other');
  const mine = join(home, 'real', 'mine');
  const theirs = join(home, 'real', 'theirs');
  mkdirSync(mine, { recursive: true });
  mkdirSync(theirs, { recursive: true });
  symlinkSync(join(home, 'real'), join(home, 'link'), 'junction');
  workspaceEntry(home, 'ws', { folder: pathToFileURL(join(home, 'link', 'theirs')).href }, [
    { name: 'a.jsonl', body: effortLog('copilot/claude-opus-5.5', 'claude-opus-5-5', 'high') },
  ]);
  assert.equal(vscodeSessionModel(mine, { home, env: envFor(home), os: 'win32' }), null);
});

// ── Copilot Chat's output log ─────────────────────────────────────────────
//
// The chat session file of a NEW chat reaches the disk only after that turn's
// tool calls have run, so every graft call in a chat's first minute found a file
// naming nothing but `copilot/auto`. Copilot's log names each call's model as
// the call returns — just before the tool it asked for starts.

/** `YYYY-MM-DD HH:MM:SS.mmm` in local time, as VS Code's log writes it. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** One `ccreq` line, at `agoMs` before now. */
function ccreq(model: string, where = 'panel/editAgent', agoMs = 1_000, status = 'success'): string {
  return `${stamp(Date.now() - agoMs)} [info] ccreq:${Math.random().toString(16).slice(2, 10)}.copilotmd | ${status} | ${model} | 3682ms | [${where}]`;
}

/** A VS Code window's log folder: its extension host names the storage entry,
 * Copilot's log holds `lines`. */
function copilotWindow(home: string, run: string, win: string, storageId: string, lines: string[], flavour = 'Code'): void {
  const host = join(home, 'AppData', 'Roaming', flavour, 'logs', run, win, 'exthost');
  mkdirSync(join(host, 'GitHub.copilot-chat'), { recursive: true });
  writeFileSync(
    join(host, 'exthost.log'),
    `2026-11-11 10:01:34.250 [info] Extension host with pid 1 started\n` +
      `2026-11-11 10:01:34.264 [info] Skipping acquiring lock for c:\\Users\\me\\AppData\\Roaming\\Code\\User\\workspaceStorage\\${storageId}.\n`,
  );
  writeFileSync(join(host, 'GitHub.copilot-chat', 'GitHub Copilot Chat.log'), `${lines.join('\n')}\n`);
}

const STORE = '8c39e775ac99d24721eaf2ae1cd9743e';
const OTHER = 'cbbf74727ec2e153713963f927fcaae8';

test('the newest user-facing ccreq line names the model; housekeeping calls do not', () => {
  const text = [
    ccreq('gpt-4o-mini-2024-07-18', 'title', 9_000),
    ccreq('gpt-6-luna', 'panel/editAgent', 5_000),
    ccreq('gpt-4o-mini-2024-07-18', 'progressMessages', 3_000),
    ccreq('gpt-4o-mini-2024-07-18', 'copilotLanguageModelWrapper/toolRiskAssessment', 2_000),
    ccreq('claude-opus-5.5', 'panel/editAgent', 1_500, 'cancelled'),
    'GitHub Copilot Chat: some unrelated line mentioning | success | claude-opus-5.5 |',
  ].join('\n');
  assert.equal(copilotLogModelFrom(text)?.model, 'gpt-6-luna');
});

test('a ccreq line naming a request and its deployment yields the deployment; a router is skipped', () => {
  assert.equal(copilotLogModelFrom(ccreq('claude-opus-5.5 -> claude-opus-5-5-20261001'))?.model, 'claude-opus-5-5-20261001');
  const text = [ccreq('gpt-6-luna', 'panel/editAgent', 5_000), ccreq('auto', 'panel/editAgent', 1_000)].join('\n');
  assert.equal(copilotLogModelFrom(text)?.model, 'gpt-6-luna');
  assert.equal(copilotLogModelFrom(ccreq('copilot/auto')), null);
});

test('the time of a ccreq line is read as local time', () => {
  const at = Date.now() - 4_321;
  const line = `${stamp(at)} [info] ccreq:ab.copilotmd | success | gpt-6-luna | 10ms | [panel/editAgent]`;
  assert.equal(copilotLogModelFrom(line)?.at, at);
});

test('a first Auto turn is priced from the log while its session file names only the router', () => {
  // The traced case: the session file holds the empty snapshot (`copilot/auto`)
  // while graft runs; Copilot's log already says what Auto routed this call to.
  const home = tmpRepo('vsc-log-first-turn');
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  workspaceEntry(home, STORE, { folder: pathToFileURL(repo).href }, [
    { name: 'a.jsonl', body: lines(SNAPSHOT) },
  ]);
  copilotWindow(home, '20261111T100131', 'window1', STORE, [
    ccreq('gpt-4o-mini-2024-07-18', 'title', 4_000),
    ccreq('gpt-6-luna', 'panel/editAgent', 1_000),
  ]);
  assert.equal(vscodeSessionModel(repo, { home, env: envFor(home), os: 'win32' }), 'gpt-6-luna');
  assert.equal(hostModelFor(repo, { home, env: envFor(home) }), 'gpt-6-luna');
});

test('the log wins over a session file that still names the previous model', () => {
  const home = tmpRepo('vsc-log-wins');
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  workspaceEntry(home, STORE, { folder: pathToFileURL(repo).href }, [
    { name: 'a.jsonl', body: log('copilot/claude-opus-5', 'claude-opus-5') },
  ]);
  copilotWindow(home, '20261111T100131', 'window1', STORE, [ccreq('claude-sonnet-5')]);
  assert.equal(vscodeSessionModel(repo, { home, env: envFor(home), os: 'win32' }), 'claude-sonnet-5');
});

test('another window\'s Copilot log never prices this repo', () => {
  const home = tmpRepo('vsc-log-other-window');
  const repo = join(home, 'repo');
  const theirs = join(home, 'theirs');
  mkdirSync(repo, { recursive: true });
  mkdirSync(theirs, { recursive: true });
  workspaceEntry(home, STORE, { folder: pathToFileURL(repo).href }, [
    { name: 'a.jsonl', body: log('copilot/claude-opus-5', 'claude-opus-5') },
  ]);
  workspaceEntry(home, OTHER, { folder: pathToFileURL(theirs).href }, []);
  // This repo's window has no user-facing call yet; the other project's is newer.
  copilotWindow(home, '20261111T100131', 'window1', STORE, [ccreq('gpt-4o-mini-2024-07-18', 'title')]);
  copilotWindow(home, '20261111T100131', 'window2', OTHER, [ccreq('gemini-3.8-flash', 'panel/editAgent', 10)]);
  assert.equal(vscodeSessionModel(repo, { home, env: envFor(home), os: 'win32' }), 'claude-opus-5', 'falls back to the session file');
  assert.equal(vscodeSessionModel(theirs, { home, env: envFor(home), os: 'win32' }), 'gemini-3.8-flash');
});

test('only the newest VS Code run is read, and a stale log line prices nothing', () => {
  const home = tmpRepo('vsc-log-stale');
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  workspaceEntry(home, STORE, { folder: pathToFileURL(repo).href }, []);
  // A dead run's log names a model; the live run's window has said nothing yet.
  copilotWindow(home, '20261110T161454', 'window1', STORE, [ccreq('claude-opus-5')]);
  copilotWindow(home, '20261111T100131', 'window1', STORE, []);
  assert.equal(vscodeSessionModel(repo, { home, env: envFor(home), os: 'win32' }), null);

  const home2 = tmpRepo('vsc-log-stale2');
  const repo2 = join(home2, 'repo');
  mkdirSync(repo2, { recursive: true });
  workspaceEntry(home2, STORE, { folder: pathToFileURL(repo2).href }, []);
  copilotWindow(home2, '20261111T100131', 'window1', STORE, [ccreq('claude-opus-5', 'panel/editAgent', 7 * 3600_000)]);
  assert.equal(vscodeSessionModel(repo2, { home: home2, env: envFor(home2), os: 'win32' }), null);
});

test('a newer run left by a `code` launch, with no windows, does not hide the live run', () => {
  const home = tmpRepo('vsc-log-windowless-run');
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  workspaceEntry(home, STORE, { folder: pathToFileURL(repo).href }, []);
  copilotWindow(home, '20261111T100131', 'window1', STORE, [ccreq('gpt-6-luna')]);
  // `code <file>` from another shell while VS Code is open: a run folder of its own, no window in it.
  mkdirSync(join(home, 'AppData', 'Roaming', 'Code', 'logs', '20261111T110000'), { recursive: true });
  writeFileSync(join(home, 'AppData', 'Roaming', 'Code', 'logs', '20261111T110000', 'main.log'), '');
  assert.equal(vscodeSessionModel(repo, { home, env: envFor(home), os: 'win32' }), 'gpt-6-luna');
});

test('with Code and Insiders both installed, the flavour that ran a model last wins', () => {
  const home = tmpRepo('vsc-log-flavours');
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  workspaceEntry(home, STORE, { folder: pathToFileURL(repo).href }, []);
  const insiders = join(home, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'workspaceStorage', STORE);
  mkdirSync(insiders, { recursive: true });
  writeFileSync(join(insiders, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(repo).href }));
  copilotWindow(home, '20261111T100131', 'window1', STORE, [ccreq('claude-opus-5', 'panel/editAgent', 60 * 60_000)]);
  copilotWindow(home, '20261111T100131', 'window1', STORE, [ccreq('gpt-6-luna', 'panel/editAgent', 2_000)], 'Code - Insiders');
  assert.equal(vscodeSessionModel(repo, { home, env: envFor(home), os: 'win32' }), 'gpt-6-luna');
});

test('a Copilot log does not price a turn run from Kilo\'s shell', () => {
  // Kilo runs inside VS Code, so its shell looks like a VS Code terminal; the
  // Kilo source stands down for every later one rather than lend it Copilot's model.
  const home = tmpRepo('vsc-log-kilo');
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  workspaceEntry(home, STORE, { folder: pathToFileURL(repo).href }, []);
  copilotWindow(home, '20261111T100131', 'window1', STORE, [ccreq('gpt-6-luna')]);
  assert.equal(hostModelFor(repo, { home, env: { ...envFor(home), KILO: '1', KILO_PID: '42' } }), null);
});
