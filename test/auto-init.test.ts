import "./isolate.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GRAFT_MCP_NPX = '1';
// scripts/run-tests.mjs turns the automatic refresh off for the suite; on here.
delete process.env.GRAFT_NO_AUTO_INIT;
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runHostsInit } from '../src/hosts/init.js';
import { installedInstructionHashes, instructionTemplatesHash, outdatedInstructions, setLoadedCodeStampForTest } from '../src/hosts/drift.js';
import { gitBusy, settleInitDue, settleInitDueAsync } from '../src/hosts/auto-init.js';
import { readStamp, runningVersion, stampPath, writeStamp } from '../src/upkeep.js';
import { tmpRepo } from './helpers.js';

const OLDER = '0.0.1';

function statePath(repo: string): string {
  return join(dirname(stampPath(repo)), 'auto-init.json');
}

/** A repo wired for Copilot only, nothing written outside it, with graft's block
 * in its instructions changed as an older graft would have left it. */
function outdatedRepo(stampVersion = OLDER): { repo: string; home: string; gh: string } {
  const home = tmpRepo('auto-init-home');
  const repo = tmpRepo('auto-init');
  runHostsInit(repo, { home, agents: ['copilot'], mcp: false, hooks: false, global: false });
  writeStamp(repo, stampVersion, ['copilot'], { global: false, mcp: false, hooks: false });
  const gh = join(repo, '.github', 'copilot-instructions.md');
  writeFileSync(gh, `# Our rules\n\nBe nice.\n\n${readFileSync(gh, 'utf8').replace('graft callers', 'graft who')}`);
  return { repo, home, gh };
}

test('outdated instructions are rewritten by themselves, and the tally recommends nothing', () => {
  const { repo, home, gh } = outdatedRepo();
  assert.deepEqual(outdatedInstructions(repo, { home }), ['.github/copilot-instructions.md']);
  const due = settleInitDue(repo, { home });
  assert.equal(due.reason, null);
  assert.match(due.note!, /updated this repo's agent instructions by itself \(for copilot\)/);
  assert.deepEqual(outdatedInstructions(repo, { home }), []);
  assert.match(readFileSync(gh, 'utf8'), /^# Our rules\n\nBe nice\.\n/, "the user's own text is kept");
  // Nothing left to do: no line on the next query.
  assert.deepEqual(settleInitDue(repo, { home }), { reason: null, note: null });
});

test('switched off, the files are left alone and init is recommended as before', () => {
  const { repo, home, gh } = outdatedRepo();
  const before = readFileSync(gh, 'utf8');
  const due = settleInitDue(repo, { home }, { ...process.env, GRAFT_NO_AUTO_INIT: '1' });
  assert.match(due.reason!, /\.github\/copilot-instructions\.md differ from what graft \S+ installs/);
  assert.equal(due.note, null);
  assert.equal(readFileSync(gh, 'utf8'), before);
});

test('never while git is in the middle of a merge or rebase', () => {
  const { repo, home, gh } = outdatedRepo();
  mkdirSync(join(repo, '.git'), { recursive: true });
  assert.equal(gitBusy(repo), false);
  writeFileSync(join(repo, '.git', 'MERGE_HEAD'), '0000000000000000000000000000000000000000\n');
  assert.equal(gitBusy(repo), true);
  const before = readFileSync(gh, 'utf8');
  const due = settleInitDue(repo, { home });
  assert.ok(due.reason, 'init is still recommended');
  assert.equal(readFileSync(gh, 'utf8'), before);
});

test('instructions a newer graft wrote are neither downgraded nor reported', () => {
  const { repo, home, gh } = outdatedRepo('999.0.0');
  const before = readFileSync(gh, 'utf8');
  assert.deepEqual(settleInitDue(repo, { home }), { reason: null, note: null });
  assert.equal(readFileSync(gh, 'utf8'), before);
});

test('a refresh that cannot clear the difference is not retried until something changes', () => {
  const { repo, home } = outdatedRepo();
  // Claude Code's skill is there, but Claude Code was never wired here: only a
  // `graft init` that chooses it would rewrite it.
  mkdirSync(join(repo, '.claude', 'skills', 'graft'), { recursive: true });
  const skill = join(repo, '.claude', 'skills', 'graft', 'SKILL.md');
  writeFileSync(skill, '# old skill\n');
  const first = settleInitDue(repo, { home });
  assert.match(first.reason!, /\.claude\/skills\/graft\/SKILL\.md/);
  assert.match(first.note!, /copilot/, 'what could be refreshed was');
  const again = settleInitDue(repo, { home });
  assert.equal(again.note, null, 'no second rewrite');
  assert.equal(again.reason, first.reason);
});

test('never in a clone where init did not run, nor on a --no-refresh query', () => {
  const { repo, home, gh } = outdatedRepo();
  const before = readFileSync(gh, 'utf8');
  const noWrite = settleInitDue(repo, { home }, process.env, false);
  assert.ok(noWrite.reason, 'init is still recommended');
  assert.equal(noWrite.note, null);
  assert.equal(readFileSync(gh, 'utf8'), before, '--no-refresh writes nothing');
  rmSync(stampPath(repo));
  const noStamp = settleInitDue(repo, { home });
  assert.ok(noStamp.reason);
  assert.equal(noStamp.note, null);
  assert.equal(readFileSync(gh, 'utf8'), before, 'no stamp: nothing says what init chose here');
});

test('choices a stamp does not record are never replayed from defaults', () => {
  const { repo, home, gh } = outdatedRepo();
  writeFileSync(stampPath(repo), JSON.stringify({ version: OLDER, hosts: ['copilot'], at: new Date().toISOString() }));
  const before = readFileSync(gh, 'utf8');
  assert.ok(settleInitDue(repo, { home }).reason);
  assert.equal(readFileSync(gh, 'utf8'), before);
});

test('text the stamp says this very graft wrote, but which changed since, is left alone', () => {
  // Same version and same templates in the stamp: something else put this text here.
  const { repo, home, gh } = outdatedRepo(runningVersion());
  const before = readFileSync(gh, 'utf8');
  assert.ok(settleInitDue(repo, { home }).reason);
  assert.equal(readFileSync(gh, 'utf8'), before);
});

test('after a refresh, text something else writes (a teammate, another install) is not overwritten', () => {
  const { repo, home, gh } = outdatedRepo();
  assert.ok(settleInitDue(repo, { home }).note, 'the first refresh runs');
  assert.ok(existsSync(statePath(repo)), 'and records what the files hold');
  // A teammate's commit brings other text, and this clone's stamp looks older.
  writeFileSync(gh, readFileSync(gh, 'utf8').replace('graft callers', 'graft whoever'));
  writeStamp(repo, OLDER, ['copilot'], { global: false, mcp: false, hooks: false });
  const before = readFileSync(gh, 'utf8');
  const due = settleInitDue(repo, { home });
  assert.ok(due.reason, 'init is recommended: the person decides');
  assert.equal(due.note, null);
  assert.equal(readFileSync(gh, 'utf8'), before);
});

test('files still holding the text an older graft wrote here are upgraded', () => {
  const { repo, home } = outdatedRepo();
  writeFileSync(statePath(repo), JSON.stringify({ version: OLDER, templates: 'older-templates', files: installedInstructionHashes(repo, { home }) }));
  const due = settleInitDue(repo, { home });
  assert.equal(due.reason, null);
  assert.match(due.note!, /by itself \(for copilot\)/);
  const state = JSON.parse(readFileSync(statePath(repo), 'utf8'));
  assert.equal(state.templates, instructionTemplatesHash());
  assert.deepEqual(state.superseded, ['older-templates'], 'the replaced text is never written back by itself');
});

test("a graft whose text was replaced here does not write it back (two installs of one version)", () => {
  const { repo, home, gh } = outdatedRepo();
  writeFileSync(
    statePath(repo),
    JSON.stringify({ version: runningVersion(), templates: 'other-install', files: installedInstructionHashes(repo, { home }), superseded: [instructionTemplatesHash()] }),
  );
  const before = readFileSync(gh, 'utf8');
  const due = settleInitDue(repo, { home });
  assert.ok(due.reason);
  assert.equal(due.note, null);
  assert.equal(readFileSync(gh, 'utf8'), before);
});

test('the note names only what the refresh fixed', () => {
  const home = tmpRepo('auto-init-home');
  const repo = tmpRepo('auto-init');
  runHostsInit(repo, { home, agents: ['copilot'], mcp: false, hooks: false, global: false });
  writeStamp(repo, OLDER, ['copilot'], { global: false, mcp: false, hooks: false });
  // Only Claude Code's skill is outdated, and Claude Code is not wired: nothing to fix.
  mkdirSync(join(repo, '.claude', 'skills', 'graft'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'skills', 'graft', 'SKILL.md'), '# old skill\n');
  const due = settleInitDue(repo, { home });
  assert.match(due.reason!, /SKILL\.md/);
  assert.equal(due.note, null);
  assert.equal(readStamp(repo)?.version, runningVersion(), 'the rewrite ran, it just fixed nothing');
});

test('put off while git is busy, the answer says to ask again', () => {
  const { repo, home } = outdatedRepo();
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'MERGE_HEAD'), '0000000000000000000000000000000000000000\n');
  assert.equal(settleInitDue(repo, { home }).retry, true);
  rmSync(join(repo, '.git', 'MERGE_HEAD'));
  const due = settleInitDue(repo, { home });
  assert.equal(due.reason, null);
  assert.ok(due.note);
});

test('a process holding older code has the code on disk do it, never its own', async () => {
  const { repo, home } = outdatedRepo();
  setLoadedCodeStampForTest('code from before an upgrade');
  try {
    // The blocking variant never writes with older code.
    const sync = settleInitDue(repo, { home });
    assert.ok(sync.reason);
    assert.equal(sync.note, null);
    assert.deepEqual(outdatedInstructions(repo, { home }), ['.github/copilot-instructions.md']);
    const due = await settleInitDueAsync(repo, { home }, 30_000);
    assert.equal(due.reason, null);
    assert.match(due.note!, /by itself \(for copilot\)/);
    assert.deepEqual(outdatedInstructions(repo, { home }), []);
  } finally {
    setLoadedCodeStampForTest(null);
  }
});
