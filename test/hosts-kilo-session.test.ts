/**
 * Reading the running model out of Kilo Code's own session database.
 *
 * This is graft's answer to a measured failure, and the tests are written
 * against that measurement rather than against the happy path. Over MCP nothing
 * in the protocol names the model, so graft asks the agent to name itself on
 * every call — and on a real machine's history that ask was honoured on 12 of
 * 361 calls, by one model out of four. Everything else was filed unpriced.
 *
 * So the contract here is narrow and defensive: name the model when Kilo's live
 * session record can, and return null — never a guess — in every other case,
 * because the alternative to a wrong price is no price, not a plausible one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_SESSION_AGE_MS,
  kiloDbPath,
  kiloSessionModel,
  parseSessionModel,
} from '../src/hosts/kilo-session.js';
import { tmpRepo } from './helpers.js';

/** `node:sqlite` is Node >=22.5 and this package supports >=20. */
const sqlite = process.getBuiltinModule?.('node:sqlite') as
  | { DatabaseSync: new (p: string) => any }
  | undefined;
const noSqlite = sqlite?.DatabaseSync === undefined
  ? 'node:sqlite is unavailable on this runtime (Node < 22.5)'
  : false;

/**
 * A Kilo database with the columns graft reads, populated with the given
 * sessions. Only the three columns this feature touches are recreated: pinning
 * the whole of somebody else's schema into a fixture would make these tests fail
 * on Kilo changes that do not affect graft at all.
 */
function kiloDb(home: string, rows: Array<{ dir: string; model: unknown; updated: number }>): void {
  const dir = join(home, '.local', 'share', 'kilo');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'kilo.db');
  const db = new sqlite!.DatabaseSync(path);
  db.exec('create table session (id text primary key, directory text, model text, time_updated integer)');
  const insert = db.prepare('insert into session (id, directory, model, time_updated) values (?, ?, ?, ?)');
  rows.forEach((r, i) => {
    const model = typeof r.model === 'string' || r.model === null ? r.model : JSON.stringify(r.model);
    insert.run(`ses_${i}`, r.dir, model as any, r.updated);
  });
  db.close();
  // The mtime is a pre-filter before the file is opened at all, so a fixture
  // whose rows are recent needs a file that looks recent too.
  const newest = Math.max(...rows.map((r) => r.updated), 0) / 1000;
  if (newest > 0) utimesSync(path, newest, newest);
}

// ── the column's own shape ────────────────────────────────────────────────

test('the model id is read out of the JSON object Kilo stores', () => {
  assert.equal(
    parseSessionModel('{"id":"vertex_ai/claude-opus-5","providerID":"a","variant":""}'),
    'vertex_ai/claude-opus-5',
    'the real shape, verbatim — the gateway prefix is the ledger\'s to strip, not ours',
  );
});

test('a bare string id is accepted — the column shape is Kilo\'s to change', () => {
  assert.equal(parseSessionModel('claude-opus-5'), 'claude-opus-5');
  assert.equal(parseSessionModel('  claude-opus-5  '), 'claude-opus-5', 'trimmed');
});

test('anything that does not name a model yields null, never a guess', () => {
  for (const bad of ['', '   ', '{', '{}', '{"id":""}', '{"id":42}', 'null', null, undefined, 42, {}]) {
    assert.equal(parseSessionModel(bad), null, JSON.stringify(bad) ?? String(bad));
  }
});

// ── finding the database ──────────────────────────────────────────────────

test('no Kilo installed is not an error — it is simply no answer', () => {
  const home = tmpRepo('kilo-db-absent');
  assert.equal(kiloDbPath({ home, env: {} }), null);
  assert.equal(kiloSessionModel('/some/repo', { home, env: {} }), null);
});

test('XDG_DATA_HOME wins over the default location', { skip: noSqlite }, () => {
  const home = tmpRepo('kilo-db-xdg');
  const xdg = tmpRepo('kilo-db-xdg-data');
  mkdirSync(join(xdg, 'kilo'), { recursive: true });
  writeFileSync(join(xdg, 'kilo', 'kilo.db'), '');
  assert.equal(kiloDbPath({ home, env: { XDG_DATA_HOME: xdg } }), join(xdg, 'kilo', 'kilo.db'));
  // ...and is ignored when blank, rather than resolving against the empty string.
  assert.equal(kiloDbPath({ home, env: { XDG_DATA_HOME: '   ' } }), null);
});

// ── the lookup ────────────────────────────────────────────────────────────

test('the live session for a directory names its model', { skip: noSqlite }, () => {
  const home = tmpRepo('kilo-db-hit');
  const now = Date.now();
  kiloDb(home, [
    { dir: 'D:/work/other-repo', model: { id: 'gemini-3.8-flash' }, updated: now - 1000 },
    { dir: 'D:/work/VED-ChAIR', model: { id: 'vertex_ai/claude-opus-5' }, updated: now - 2000 },
  ]);
  assert.equal(
    kiloSessionModel('D:/work/VED-ChAIR', { home, env: {}, now }),
    'vertex_ai/claude-opus-5',
    'matched on the directory, not on recency alone',
  );
});

test('a directory Kilo has never opened names nothing', { skip: noSqlite }, () => {
  const home = tmpRepo('kilo-db-miss');
  const now = Date.now();
  kiloDb(home, [{ dir: 'D:/work/other-repo', model: { id: 'gemini-3.8-flash' }, updated: now }]);
  assert.equal(kiloSessionModel('D:/work/VED-ChAIR', { home, env: {}, now }), null);
});

test('Windows separators and drive-letter case still match', { skip: noSqlite }, () => {
  // Kilo writes posix separators even on Windows, while graft's repo root
  // arrives native — so the two spellings of one path must resolve to one row.
  const home = tmpRepo('kilo-db-sep');
  const now = Date.now();
  kiloDb(home, [{ dir: 'D:/work/VED-ChAIR', model: { id: 'claude-opus-5' }, updated: now }]);
  for (const spelling of ['D:\\work\\VED-ChAIR', 'd:/work/ved-chair', 'D:/work/VED-ChAIR/']) {
    assert.equal(kiloSessionModel(spelling, { home, env: {}, now }), 'claude-opus-5', spelling);
  }
});

test('sessions on one directory that AGREE name their shared model', { skip: noSqlite }, () => {
  // Several chats on one repo is normal; only disagreement is a problem.
  const home = tmpRepo('kilo-db-agree');
  const now = Date.now();
  kiloDb(home, [
    { dir: 'D:/repo', model: { id: 'gemini-3.8-flash' }, updated: now - 60_000 },
    { dir: 'D:/repo', model: { id: 'gemini-3.8-flash' }, updated: now - 1000 },
  ]);
  assert.equal(kiloSessionModel('D:/repo', { home, env: {}, now }), 'gemini-3.8-flash');
});

test('the session written mid-turn wins over an idle tab on the same repo', { skip: noSqlite }, () => {
  // The observed bug: a repo with an Opus chat touched a minute ago and a Gemini
  // chat touched 74 minutes ago filed EVERY Gemini saving under Opus — a 6x
  // price difference — because "newest row wins" was treated as identification.
  // Kilo rewrites a session's row on every message of a turn, so the caller's
  // row is seconds old while an idle tab's is minutes old.
  const home = tmpRepo('kilo-db-active');
  const now = Date.now();
  kiloDb(home, [
    { dir: 'D:/repo', model: { id: 'gemini-3.8-flash' }, updated: now - 2000 },
    { dir: 'D:/repo', model: { id: 'claude-opus-5' }, updated: now - 40 * 60_000 },
  ]);
  assert.equal(kiloSessionModel('D:/repo', { home, env: {}, now }), 'gemini-3.8-flash');
});

test('two sessions both mid-turn name nothing rather than guessing', { skip: noSqlite }, () => {
  // Genuinely ambiguous: nothing on disk says which of them is calling. An
  // unpriced saving is recoverable; one filed against a model that never ran is
  // indistinguishable from a correct figure, which is the failure this whole
  // module is written to avoid.
  const home = tmpRepo('kilo-db-ambiguous');
  const now = Date.now();
  kiloDb(home, [
    { dir: 'D:/repo', model: { id: 'claude-opus-5' }, updated: now - 1000 },
    { dir: 'D:/repo', model: { id: 'gemini-3.8-flash' }, updated: now - 5000 },
  ]);
  assert.equal(kiloSessionModel('D:/repo', { home, env: {}, now }), null);
});

test('two idle sessions that disagree also name nothing', { skip: noSqlite }, () => {
  // Neither is mid-turn, so neither can be the caller.
  const home = tmpRepo('kilo-db-idle-disagree');
  const now = Date.now();
  kiloDb(home, [
    { dir: 'D:/repo', model: { id: 'claude-opus-5' }, updated: now - 30 * 60_000 },
    { dir: 'D:/repo', model: { id: 'gemini-3.8-flash' }, updated: now - 40 * 60_000 },
  ]);
  assert.equal(kiloSessionModel('D:/repo', { home, env: {}, now }), null);
});

test('one spelling of a model is not mistaken for a second model', { skip: noSqlite }, () => {
  // `gemini-3.8-flash` and `gemini-3-8-flash` are one model; treating them as a
  // disagreement would throw away a perfectly good answer.
  const home = tmpRepo('kilo-db-spelling');
  const now = Date.now();
  kiloDb(home, [
    { dir: 'D:/repo', model: { id: 'gemini-3.8-flash' }, updated: now - 1000 },
    { dir: 'D:/repo', model: { id: 'gemini-3-8-flash' }, updated: now - 30 * 60_000 },
  ]);
  assert.equal(kiloSessionModel('D:/repo', { home, env: {}, now }), 'gemini-3.8-flash');
});

test('a stale database prices nothing', { skip: noSqlite }, () => {
  // The guard against the failure mode this whole design exists to avoid: a
  // model left behind by an uninstalled Kilo, confidently pricing savings made
  // by something else entirely months later.
  const home = tmpRepo('kilo-db-stale');
  const now = Date.now();
  const old = now - MAX_SESSION_AGE_MS - 60_000;
  kiloDb(home, [{ dir: 'D:/repo', model: { id: 'claude-opus-5' }, updated: old }]);
  assert.equal(kiloSessionModel('D:/repo', { home, env: {}, now }), null, 'too old to name this turn');
  // ...and is read again as soon as it is current.
  assert.equal(kiloSessionModel('D:/repo', { home, env: {}, now: old + 1000 }), 'claude-opus-5');
});

test('a corrupt or foreign database is silently no answer', { skip: noSqlite }, () => {
  // graft is reading another project's file on a tool-call path. Every way that
  // can go wrong has to degrade to today's behaviour, never to a thrown error
  // that fails the user's retrieval.
  const home = tmpRepo('kilo-db-corrupt');
  const dir = join(home, '.local', 'share', 'kilo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'kilo.db'), 'this is not a database');
  assert.equal(kiloSessionModel('D:/repo', { home, env: {}, now: Date.now() }), null);
});

test('a database without the session table is no answer either', { skip: noSqlite }, () => {
  // Kilo's schema is Kilo's to change; a rename must cost graft a price, not a
  // crash.
  const home = tmpRepo('kilo-db-schema');
  const dir = join(home, '.local', 'share', 'kilo');
  mkdirSync(dir, { recursive: true });
  const db = new sqlite!.DatabaseSync(join(dir, 'kilo.db'));
  db.exec('create table something_else (id text)');
  db.close();
  assert.equal(kiloSessionModel('D:/repo', { home, env: {}, now: Date.now() }), null);
});

test('a session row with no model names nothing', { skip: noSqlite }, () => {
  const home = tmpRepo('kilo-db-nomodel');
  const now = Date.now();
  kiloDb(home, [{ dir: 'D:/repo', model: null, updated: now }]);
  assert.equal(kiloSessionModel('D:/repo', { home, env: {}, now }), null);
});
