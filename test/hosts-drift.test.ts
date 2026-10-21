import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GRAFT_MCP_NPX = '1';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHostsInit } from '../src/hosts/init.js';
import { runInit } from '../src/claude/init.js';
import { changedSections, initDueReason, outdatedInstructionDetails, outdatedInstructions } from '../src/hosts/drift.js';
import { tmpRepo } from './helpers.js';

function fresh(): string { return tmpRepo('drift'); }

test('nothing installed, nothing to re-init', () => {
  const repo = fresh();
  assert.deepEqual(outdatedInstructions(repo, { home: fresh() }), []);
  assert.equal(initDueReason(repo, { home: fresh() }), null);
});

test('right after init every instruction file is current', () => {
  const home = fresh(); const repo = fresh();
  runHostsInit(repo, { home, all: true, mcp: false, hooks: false, global: false });
  runInit(repo, { build: false, global: false, home });
  assert.deepEqual(outdatedInstructions(repo, { home }), []);
});

test('an owned file and a fenced block from another version are both reported', () => {
  const home = fresh(); const repo = fresh();
  runHostsInit(repo, { home, agents: ['cursor', 'copilot'], mcp: false, hooks: false, global: false });
  const mdc = join(repo, '.cursor', 'rules', 'graft.mdc');
  writeFileSync(mdc, readFileSync(mdc, 'utf8').replace('graft ask', 'graft find'));
  const gh = join(repo, '.github', 'copilot-instructions.md');
  writeFileSync(gh, readFileSync(gh, 'utf8').replace('graft callers', 'graft who'));
  assert.deepEqual(outdatedInstructions(repo, { home }).sort(), ['.cursor/rules/graft.mdc', '.github/copilot-instructions.md']);
  assert.match(initDueReason(repo, { home })!, /\.cursor\/rules\/graft\.mdc, \.github\/copilot-instructions\.md differ from what graft \S+ installs/);
});

test("the user's own text around the block, and line endings, are not drift", () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(repo, '.github'));
  const gh = join(repo, '.github', 'copilot-instructions.md');
  writeFileSync(gh, '# Our rules\n\nBe nice.\n');
  runHostsInit(repo, { home, agents: ['copilot'], mcp: false, hooks: false, global: false });
  writeFileSync(gh, `${readFileSync(gh, 'utf8')}\nMore of our own rules.\n`.replace(/\n/g, '\r\n'));
  assert.deepEqual(outdatedInstructions(repo, { home }), []);
});

test('a shared file without graft\'s block was not installed by init', () => {
  const repo = fresh();
  writeFileSync(join(repo, 'AGENTS.md'), '# Agents\n\nOur own text only.\n');
  assert.deepEqual(outdatedInstructions(repo, { home: fresh() }), []);
});

test('the reason names every outdated file, the agents they serve, and caps only the section list', () => {
  const home = fresh(); const repo = fresh();
  runHostsInit(repo, { home, agents: ['cursor', 'kiro', 'windsurf', 'gemini', 'copilot'], mcp: false, hooks: false, global: false });
  const files = ['.cursor/rules/graft.mdc', '.kiro/steering/graft.md', '.windsurf/rules/graft.md', 'GEMINI.md', '.github/copilot-instructions.md'];
  for (const rel of files) {
    const p = join(repo, rel);
    writeFileSync(p, readFileSync(p, 'utf8').replace('graft ask', 'graft old-ask'));
  }
  const reason = initDueReason(repo, { home })!;
  for (const f of files) assert.ok(reason.includes(f), `${f} named in: ${reason}`);
  assert.doesNotMatch(reason, /more are/, 'no file is hidden behind "and N more"');
  assert.match(reason, /— changed: “Graft — repo context graph”;/);
  assert.match(reason, /re-running it here rewrites only graft's part of those files, for cursor, gemini, copilot, kiro, windsurf$/);
  assert.doesNotMatch(reason, /[()]/, 'the tally wraps the reason in parentheses already');
});

test('a shared AGENTS.md names only the agents wired here, not every host that reads it', () => {
  const home = fresh(); const repo = fresh();
  runHostsInit(repo, { home, agents: ['agents'], mcp: false, hooks: false, global: false });
  const p = join(repo, 'AGENTS.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('graft ask', 'graft old-ask'));
  const [d] = outdatedInstructionDetails(repo, { home });
  assert.equal(d.file, 'AGENTS.md');
  // hermes and antigravity read AGENTS.md too; wiredHostIds cannot tell them apart
  // from disk alone, so all three count as wired — but never an unrelated host.
  assert.ok(d.hosts.includes('agents'));
  assert.ok(d.hosts.every((h) => ['agents', 'hermes', 'antigravity'].includes(h)), d.hosts.join(','));
});

test('changedSections labels changed, new and removed sections, and skips code fences', () => {
  const have = '---\na: 1\n---\n# Top\nsame\n## Kept\nold text\n## Gone\nx\n```\n# not a heading\n```\n';
  const want = '---\na: 2\n---\n# Top\nsame\n## Kept\nnew text\n## Added (the default)\ny\n';
  assert.deepEqual(changedSections(have, want), ['the front matter', '“Kept”', 'new “Added”', 'removed “Gone”']);
  assert.deepEqual(changedSections(want, want), []);
  assert.deepEqual(changedSections('# graft\nold intro\n', '# graft\nnew intro\n'), ['the introduction']);
});
