/**
 * Reading the running model out of GitHub Copilot for JetBrains' agent-session
 * store — the IntelliJ counterpart of the VS Code reader.
 *
 * Fixtures mimic the bytes the plugin writes: Java-serialized Nitrite documents
 * (TC_STRING keys and values, `java.lang.Long` timestamps with a class
 * descriptor or a back-reference), turns interleaved with session documents.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inJetBrainsTerminal, jetbrainsSessionModel, turnsFrom } from '../src/hosts/jetbrains-session.js';
import { hostModelFor } from '../src/hosts/host-model.js';
import { tmpRepo } from './helpers.js';

function s(text: string): Buffer {
  const b = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([0x74, b.length >> 8, b.length & 0xff]), b]);
}

function i64(v: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt(v));
  return b;
}

/** First Long in a stream: full class descriptor, then the value. */
function longDesc(v: number): Buffer {
  return Buffer.concat([
    Buffer.from([0x73, 0x72, 0x00, 0x0e]), Buffer.from('java.lang.Long', 'latin1'),
    Buffer.from('3b8be490cc8f23df', 'hex'), Buffer.from([0x02, 0x00, 0x01, 0x4a, 0x00, 0x05]),
    Buffer.from('value', 'latin1'), Buffer.from([0x78, 0x72, 0x00, 0x10]), Buffer.from('java.lang.Number', 'latin1'),
    Buffer.from('86ac951d0b94e08b', 'hex'), Buffer.from([0x02, 0x00, 0x00, 0x78, 0x70]), i64(v),
  ]);
}

/** A later Long in the same stream: a back-reference to the descriptor. */
function longRef(v: number): Buffer {
  return Buffer.concat([Buffer.from([0x73, 0x71, 0x00, 0x7e, 0x00, 0x05]), i64(v)]);
}

let n = 0;
function uuid(): string {
  return `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

function turn(session: string, t: { picked?: string; resolved?: string; created: number; modified?: number }): Buffer {
  return Buffer.concat([
    s('id'), s(uuid()), s('sessionId'), s(session), s('createdAt'), longDesc(t.created),
    s('request'), s('modelInformation'), s('modelType'), s('builtin'),
    ...(t.picked ? [s('model'), s(t.picked)] : []),
    s('response'), s('GitHub Copilot'),
    ...(t.resolved ? [s('modelName'), s(t.resolved)] : []),
    s('_id'), s('2105928755660902400'), s('_modified'), longRef(t.modified ?? t.created),
  ]);
}

function sessionDoc(picker: string): Buffer {
  return Buffer.concat([s('id'), s(uuid()), s('name'), s('value'), s('A chat'), s('modelName'), s(picker)]);
}

function store(home: string, body: Buffer, product = 'ic', id = 'abc'): void {
  const dir = join(home, 'AppData', 'Local', 'github-copilot', product, 'chat-agent-sessions', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'copilot-agent-sessions-nitrite.db'), Buffer.concat([Buffer.from('H:2,block:4\n'), body]));
}

function envFor(home: string): NodeJS.ProcessEnv {
  return { LOCALAPPDATA: join(home, 'AppData', 'Local'), TERMINAL_EMULATOR: 'JetBrains-JediTerm' };
}

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);

// ── parsing ───────────────────────────────────────────────────────────────

test('the resolved model wins over the `auto` picker', () => {
  const [t] = turnsFrom(turn('aaaaaaaa-0000-4000-8000-000000000001', { picked: 'auto', resolved: 'Claude Haiku 4.5', created: NOW }));
  assert.equal(t.model, 'Claude Haiku 4.5');
  assert.equal(t.touched, NOW);
});

test('the picker value stands in until a model resolves, but never `auto`', () => {
  const sid = 'aaaaaaaa-0000-4000-8000-000000000002';
  assert.equal(turnsFrom(turn(sid, { picked: 'gpt-5.1-codex-max', created: NOW }))[0].model, 'gpt-5.1-codex-max');
  assert.deepEqual(turnsFrom(turn(sid, { picked: 'auto', created: NOW })), []);
});

test('`_modified` dates a turn that is still being written', () => {
  const [t] = turnsFrom(turn('aaaaaaaa-0000-4000-8000-000000000003', { resolved: 'GPT-4.1', created: NOW - 600_000, modified: NOW }));
  assert.equal(t.touched, NOW);
});

test('a turn does not borrow the picker of the session document after it', () => {
  // Session documents carry their own `modelName` (the picker); reading past
  // the turn's end would attribute it to a turn that resolved nothing.
  const body = Buffer.concat([turn('aaaaaaaa-0000-4000-8000-000000000004', { picked: 'auto', created: NOW }), sessionDoc('gpt-5.6-sol')]);
  assert.deepEqual(turnsFrom(body), []);
});

// ── the lookup ────────────────────────────────────────────────────────────

test('the newest live turn names the model', () => {
  const home = tmpRepo('jb-hit');
  const sid = 'bbbbbbbb-0000-4000-8000-000000000001';
  store(home, Buffer.concat([
    turn(sid, { picked: 'gpt-4.1', resolved: 'GPT-4.1', created: NOW - 3_600_000 }),
    sessionDoc('auto'),
    turn(sid, { picked: 'auto', resolved: 'Claude Haiku 4.5', created: NOW - 60_000 }),
  ]));
  assert.equal(jetbrainsSessionModel('repo', { home, env: envFor(home), now: NOW, os: 'win32' }), 'Claude Haiku 4.5');
});

test('a stale store prices nothing', () => {
  const home = tmpRepo('jb-stale');
  store(home, turn('bbbbbbbb-0000-4000-8000-000000000002', { resolved: 'Claude Haiku 4.5', created: NOW - 7 * 24 * 3_600_000 }));
  assert.equal(jetbrainsSessionModel('repo', { home, env: envFor(home), now: NOW, os: 'win32' }), null);
});

test('disagreeing live sessions resolve only to the one mid-turn', () => {
  const home = tmpRepo('jb-tie');
  const a = 'cccccccc-0000-4000-8000-000000000001';
  const b = 'cccccccc-0000-4000-8000-000000000002';
  store(home, Buffer.concat([
    turn(a, { resolved: 'Claude Opus 5', created: NOW - 3_600_000 }),
    turn(b, { resolved: 'GPT-5.4', created: NOW - 30_000 }),
  ]));
  assert.equal(jetbrainsSessionModel('repo', { home, env: envFor(home), now: NOW, os: 'win32' }), 'GPT-5.4');
  // Neither mid-turn: no price rather than a guess.
  assert.equal(jetbrainsSessionModel('repo', { home, env: envFor(home), now: NOW + 600_000, os: 'win32' }), null);
});

test('stores of every JetBrains product are read', () => {
  const home = tmpRepo('jb-products');
  store(home, turn('dddddddd-0000-4000-8000-000000000001', { resolved: 'GPT-5.3-Codex', created: NOW }), 'py', 'xyz');
  assert.equal(jetbrainsSessionModel('repo', { home, env: envFor(home), now: NOW, os: 'win32' }), 'GPT-5.3-Codex');
});

test('no plugin on the machine is simply no answer', () => {
  const home = tmpRepo('jb-absent');
  assert.equal(jetbrainsSessionModel('repo', { home, env: envFor(home), now: NOW, os: 'win32' }), null);
});

// ── the gate ──────────────────────────────────────────────────────────────

test('a JetBrains terminal is recognised, a plain shell is not', () => {
  assert.equal(inJetBrainsTerminal({ TERMINAL_EMULATOR: 'JetBrains-JediTerm' }), true);
  assert.equal(inJetBrainsTerminal({ __INTELLIJ_COMMAND_HISTFILE__: 'x' }), true);
  assert.equal(inJetBrainsTerminal({}), false);
  assert.equal(inJetBrainsTerminal({ TERM_PROGRAM: 'vscode' }), false);
});

test('the registry reads the store only from a JetBrains terminal', () => {
  const home = tmpRepo('jb-gate');
  store(home, turn('eeeeeeee-0000-4000-8000-000000000001', { resolved: 'Claude Haiku 4.5', created: Date.now() }));
  const plain = { LOCALAPPDATA: join(home, 'AppData', 'Local') };
  assert.equal(hostModelFor(join(home, 'repo'), { home, env: plain }), null, 'plain shell: nothing');
  if (process.platform === 'win32') {
    assert.equal(
      hostModelFor(join(home, 'repo'), { home, env: { ...plain, TERMINAL_EMULATOR: 'JetBrains-JediTerm' } }),
      'Claude Haiku 4.5',
    );
  }
});
