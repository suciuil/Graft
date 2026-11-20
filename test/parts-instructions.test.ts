import "./isolate.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GRAFT_MCP_NPX = '1';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runHostsInit } from '../src/hosts/init.js';
import { runInit } from '../src/claude/init.js';
import { outdatedInstructionDetails, outdatedInstructions } from '../src/hosts/drift.js';
import { cursorRule, instructionBody, kiloRule } from '../src/hosts/instructions.js';
import { PARTS_HEADING, skillTemplate } from '../src/claude/skill-template.js';
import { mcpInstructions } from '../src/mcp/instructions.js';
import { hasPartsGuidance, repoFacts, settledFacts } from '../src/hosts/repo-facts.js';
import { removeWorkspace, writeWorkspace } from '../src/graph/workspace-index.js';
import { wiringPath } from '../src/graph/write.js';
import { resolveContextDir } from '../src/util/state.js';
import { tmpRepo } from './helpers.js';

function fresh(): string { return tmpRepo('parts-instr'); }

function splitInParts(repo: string): void {
  rmSync(wiringPath(resolveContextDir(repo)), { force: true });
  writeWorkspace(repo, { version: 1, kind: 'parts', children: ['Src/A', 'Src/B'] });
}

function oneMap(repo: string): void {
  removeWorkspace(repo);
  const p = wiringPath(resolveContextDir(repo));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '{"version":1,"nodes":[],"edges":[]}\n');
}

const wire = (repo: string, home: string) => {
  runHostsInit(repo, { home, agents: ['agents', 'cursor', 'kilo'], mcp: false, hooks: false, global: false });
  runInit(repo, { build: false, global: false, home });
};

const AGENTS = (repo: string) => readFileSync(join(repo, 'AGENTS.md'), 'utf8');
const CURSOR = (repo: string) => readFileSync(join(repo, '.cursor', 'rules', 'graft.mdc'), 'utf8');
const SKILL = (repo: string) => readFileSync(join(repo, '.claude', 'skills', 'graft', 'SKILL.md'), 'utf8');

test('the texts say nothing of parts unless the repo is built in parts', () => {
  for (const text of [instructionBody(), cursorRule(), kiloRule(), skillTemplate(), mcpInstructions(), instructionBody('graft', { parts: false })]) {
    assert.doesNotMatch(text, /built in parts/i);
  }
  assert.equal(instructionBody('graft', {}), instructionBody(), 'no facts: the plain text, unchanged');
  assert.equal(skillTemplate('graft', { parts: false }), skillTemplate(), 'not in parts: the plain skill');
});

test('a repo built in parts gets the parts section, in both spellings', () => {
  const body = instructionBody('graft', { parts: true });
  assert.match(body, new RegExp(`^### ${PARTS_HEADING}$`, 'm'));
  assert.match(body, /--in <part>\//);
  assert.ok(body.indexOf(PARTS_HEADING) < body.indexOf('### The rule, stated as a rule'), 'near the tools, before the rules');
  assert.match(kiloRule('graft', { parts: true }), new RegExp(`^### ${PARTS_HEADING}$`, 'm'));
  const skill = skillTemplate('graft', { parts: true });
  assert.match(skill, new RegExp(`^## ${PARTS_HEADING}$`, 'm'));
  assert.ok(skill.indexOf(PARTS_HEADING) < skill.indexOf('## Scenarios'), 'after the tools');
  const trail = instructionBody('trail', { parts: true });
  assert.match(trail, /`trail build` at the repo root rebuilds every part/);
  assert.doesNotMatch(trail, /`graft build`/);
  assert.match(skillTemplate('trail', { parts: true }), new RegExp(`^## ${PARTS_HEADING}$`, 'm'));
  for (const t of [body, skill, trail]) assert.ok(hasPartsGuidance(t));
});

test('the MCP instructions get one parts line and stay near their budget', () => {
  const plain = mcpInstructions();
  const parts = mcpInstructions({ parts: true });
  assert.match(parts, /Built in parts: .*`in: "<part>\/"`/);
  assert.equal(parts.split('\n').length, plain.split('\n').length + 1);
  assert.ok(parts.length - plain.length <= 130, `the parts line adds ${parts.length - plain.length} characters`);
  assert.match(parts.trimEnd().split('\n').pop()!, /^Send `model:/, 'the closing lines still close it');
});

test('repoFacts reads the map: parts index, one map, a folder of repos, or nothing', () => {
  const repo = fresh();
  assert.deepEqual(repoFacts(repo), {}, 'no map: not known');
  splitInParts(repo);
  assert.deepEqual(repoFacts(repo), { parts: true });
  oneMap(repo);
  assert.deepEqual(repoFacts(repo), { parts: false });
  const ws = fresh();
  writeWorkspace(ws, { version: 1, children: ['a', 'b'] });
  assert.deepEqual(repoFacts(ws), { parts: false }, 'a folder of separate repos is not built in parts');
});

test('settledFacts keeps what the installed text says only when the map says nothing', () => {
  const withParts = instructionBody('graft', { parts: true });
  assert.deepEqual(settledFacts({}, withParts), { parts: true });
  assert.deepEqual(settledFacts({}, instructionBody()), { parts: false });
  assert.deepEqual(settledFacts({}, null), { parts: false });
  assert.deepEqual(settledFacts({ parts: false }, withParts), { parts: false });
  assert.deepEqual(settledFacts({ parts: true }, null), { parts: true });
});

test('init in a repo built in parts writes the section, and drift calls it current', () => {
  const home = fresh(); const repo = fresh();
  splitInParts(repo);
  wire(repo, home);
  for (const t of [AGENTS(repo), CURSOR(repo), SKILL(repo)]) assert.ok(hasPartsGuidance(t));
  assert.deepEqual(outdatedInstructions(repo, { home }), []);
});

test('splitting or joining the map makes the files outdated, and init brings them in line', () => {
  const home = fresh(); const repo = fresh();
  oneMap(repo);
  wire(repo, home);
  assert.ok(!hasPartsGuidance(AGENTS(repo)));
  assert.deepEqual(outdatedInstructions(repo, { home }), []);

  splitInParts(repo);
  const out = outdatedInstructionDetails(repo, { home });
  assert.deepEqual(out.map((o) => o.file).sort(), ['.claude/skills/graft/SKILL.md', '.cursor/rules/graft.mdc', '.kilo/rules/graft.md', 'AGENTS.md']);
  assert.ok(out.every((o) => o.changes.includes(`new “${PARTS_HEADING}”`)), JSON.stringify(out));
  wire(repo, home);
  assert.ok(hasPartsGuidance(AGENTS(repo)) && hasPartsGuidance(SKILL(repo)));
  assert.deepEqual(outdatedInstructions(repo, { home }), []);

  oneMap(repo);
  assert.equal(outdatedInstructions(repo, { home }).length, 4);
  wire(repo, home);
  for (const t of [AGENTS(repo), CURSOR(repo), SKILL(repo)]) assert.ok(!hasPartsGuidance(t));
  assert.deepEqual(outdatedInstructions(repo, { home }), []);
});

test('with no map at all the installed text is kept as it is (a clone not built yet)', () => {
  const home = fresh(); const repo = fresh();
  splitInParts(repo);
  wire(repo, home);
  removeWorkspace(repo);
  assert.deepEqual(repoFacts(repo), {});
  assert.deepEqual(outdatedInstructions(repo, { home }), [], 'not outdated: nothing says otherwise');
  wire(repo, home);
  assert.ok(hasPartsGuidance(AGENTS(repo)), 'a refresh keeps the section');
});
