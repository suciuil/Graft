import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluate,
  handlePreTool,
  isIndexedFile,
  isRepoSearchCommand,
  toolRole,
  wholeFileCatTarget,
} from '../src/claude/gate.js';
import { readSession } from '../src/claude/state.js';

/** A repo whose graph knows exactly `src/auth.ts`. */
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'graft-gate-'));
  mkdirSync(join(d, 'graft', '.graph'), { recursive: true });
  writeFileSync(
    join(d, 'graft', '.graph', 'wiring.json'),
    JSON.stringify({
      meta: { nodeCount: 1, edgeCount: 0, languages: ['typescript'] },
      nodes: [{ id: 'f1', kind: 'file', path: 'src/auth.ts', name: 'auth.ts' }],
      edges: [],
    }),
  );
  return d;
}

// --- tool-name normalization -------------------------------------------

test('toolRole maps every host spelling onto one of three roles', () => {
  assert.equal(toolRole('Read'), 'read');
  assert.equal(toolRole('read_file'), 'read');
  assert.equal(toolRole('Grep'), 'grep');
  assert.equal(toolRole('Bash'), 'shell');
  assert.equal(toolRole('shell'), 'shell');
  assert.equal(toolRole('local_shell'), 'shell');
  // An unknown tool is always allowed: Codex's matcher is deliberately wider
  // than this list, and a tool we have not reasoned about must never be refused.
  assert.equal(toolRole('Write'), null);
  assert.equal(toolRole('apply_patch'), null);
});

// --- what counts as a repo search ---------------------------------------

test('isRepoSearchCommand recognizes repo-wide searches, not pipe filters', () => {
  assert.ok(isRepoSearchCommand('rg findMe'));
  assert.ok(isRepoSearchCommand('grep -rn findMe src/'));
  assert.ok(isRepoSearchCommand('git grep findMe'));
  // Filtering another command's output is not a repo search — graft has no
  // equivalent for it, so refusing would be pure noise.
  assert.ok(!isRepoSearchCommand('cat x.txt | grep findMe'));
  assert.ok(!isRepoSearchCommand('npm ls | rg graft'));
  assert.ok(!isRepoSearchCommand('echo hello'));
});

test('wholeFileCatTarget matches a plain cat, never a pipe or a ranged read', () => {
  assert.equal(wholeFileCatTarget('cat src/auth.ts'), 'src/auth.ts');
  assert.equal(wholeFileCatTarget('cat "src/a b.ts"'), 'src/a b.ts');
  assert.equal(wholeFileCatTarget('cat src/auth.ts | head -5'), null);
  assert.equal(wholeFileCatTarget('head -20 src/auth.ts'), null);
  assert.equal(wholeFileCatTarget('sed -n \'10,40p\' src/auth.ts'), null);
});

// --- indexed-file detection ---------------------------------------------

test('isIndexedFile is true only for files actually in the graph', () => {
  const d = repo();
  assert.ok(isIndexedFile(d, join(d, 'src', 'auth.ts')));
  assert.ok(isIndexedFile(d, 'src/auth.ts'), 'relative paths resolve too');
  // Not indexed: graft has no answer, so reading it whole is the right move.
  assert.ok(!isIndexedFile(d, 'README.md'));
  assert.ok(!isIndexedFile(d, 'package-lock.json'));
  // Outside the repo, and graft's own output, are never "indexed source".
  assert.ok(!isIndexedFile(d, '/etc/hosts'));
  assert.ok(!isIndexedFile(d, 'graft/INDEX.md'));
});

test('isIndexedFile fails open when there is no graph at all', () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-gate-nograph-'));
  assert.ok(!isIndexedFile(d, 'src/auth.ts'));
});

// --- the decision -------------------------------------------------------

test('a repo-wide Grep is refused, and the message names the graft command', () => {
  const d = repo();
  const v = evaluate({ tool_name: 'Grep', tool_input: { pattern: 'findMe' } }, d);
  assert.ok(v.deny);
  assert.match(v.reason, /graft grep "findMe"/);
  // A refusal that does not say how to override it is a wall, not a redirect.
  assert.match(v.reason, /re-issue this exact call/i);
});

test('a Grep scoped to a single file is allowed (a targeted read, not a search)', () => {
  const d = repo();
  assert.ok(!evaluate({ tool_name: 'Grep', tool_input: { pattern: 'x', path: 'src/auth.ts' } }, d).deny);
});

test('a whole-file Read of an indexed file is refused; an unindexed one is not', () => {
  const d = repo();
  const denied = evaluate({ tool_name: 'Read', tool_input: { file_path: join(d, 'src', 'auth.ts') } }, d);
  assert.ok(denied.deny);
  assert.match(denied.reason, /graft skeleton src\/auth\.ts/);
  // README.md is not in the graph: graft cannot answer, so the read stands.
  assert.ok(!evaluate({ tool_name: 'Read', tool_input: { file_path: join(d, 'README.md') } }, d).deny);
});

test('a RANGED read is never refused — it is the behaviour the gate exists to produce', () => {
  const d = repo();
  const file = join(d, 'src', 'auth.ts');
  for (const range of [{ offset: 10, limit: 30 }, { start_line: 10, end_line: 40 }, { line_range: [10, 40] }]) {
    assert.ok(!evaluate({ tool_name: 'Read', tool_input: { file_path: file, ...range } }, d).deny,
      `ranged read ${JSON.stringify(range)} must pass`);
  }
});

test('shell: rg is refused, head/sed on the same file are not', () => {
  const d = repo();
  assert.ok(evaluate({ tool_name: 'Bash', tool_input: { command: 'rg findMe' } }, d).deny);
  assert.ok(evaluate({ tool_name: 'Bash', tool_input: { command: 'cat src/auth.ts' } }, d).deny);
  assert.ok(!evaluate({ tool_name: 'Bash', tool_input: { command: 'head -20 src/auth.ts' } }, d).deny);
  assert.ok(!evaluate({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, d).deny);
  // cat of a file graft does not index: no equivalent, so no refusal.
  assert.ok(!evaluate({ tool_name: 'Bash', tool_input: { command: 'cat README.md' } }, d).deny);
});

// --- refuse once, then allow --------------------------------------------

/** Capture what the hook wrote to stdout. */
function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write;
  (process.stdout as any).write = (c: any) => { chunks.push(String(c)); return true; };
  try { fn(); } finally { (process.stdout as any).write = orig; }
  return chunks.join('');
}

test('the gate refuses once, then lets the identical call through (re-issue IS the override)', () => {
  const d = repo();
  const input = { session_id: 's1', tool_name: 'Grep', tool_input: { pattern: 'findMe' } };

  const first = captureStdout(() => handlePreTool(input, d));
  const parsed = JSON.parse(first);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /graft grep/);
  assert.equal(readSession(d, 's1').gateDenied?.length, 1, 'the refusal is recorded');

  // Same call again: allowed, silently, and the key is released so a genuinely
  // fresh instance much later is redirected again.
  const second = captureStdout(() => handlePreTool(input, d));
  assert.equal(second, '', 'the second identical call is not refused');
  assert.deepEqual(readSession(d, 's1').gateDenied, [], 'the override clears the key');
});

test('a DIFFERENT call is still refused after one override', () => {
  const d = repo();
  captureStdout(() => handlePreTool({ session_id: 's2', tool_name: 'Grep', tool_input: { pattern: 'a' } }, d));
  captureStdout(() => handlePreTool({ session_id: 's2', tool_name: 'Grep', tool_input: { pattern: 'a' } }, d));
  const other = captureStdout(() =>
    handlePreTool({ session_id: 's2', tool_name: 'Grep', tool_input: { pattern: 'b' } }, d));
  assert.match(other, /"permissionDecision":"deny"/);
});

// --- the escape hatches -------------------------------------------------

test('GRAFT_NO_GATE=1 disables the gate entirely', () => {
  const d = repo();
  const prev = process.env.GRAFT_NO_GATE;
  process.env.GRAFT_NO_GATE = '1';
  try {
    const out = captureStdout(() =>
      handlePreTool({ session_id: 's3', tool_name: 'Grep', tool_input: { pattern: 'findMe' } }, d));
    assert.equal(out, '');
  } finally {
    if (prev === undefined) delete process.env.GRAFT_NO_GATE; else process.env.GRAFT_NO_GATE = prev;
  }
});

test('the gate fails open on malformed input and on an unbuilt repo', () => {
  const d = repo();
  // Garbage shapes must never deny, and must never throw: the agent's tool call
  // is stalled behind this process.
  for (const bad of [{}, { tool_name: null }, { tool_name: 'Grep' }, { tool_name: 'Read', tool_input: {} }]) {
    assert.equal(captureStdout(() => handlePreTool(bad, d)), '', `${JSON.stringify(bad)} must pass`);
  }
  const unbuilt = mkdtempSync(join(tmpdir(), 'graft-gate-unbuilt-'));
  assert.equal(
    captureStdout(() => handlePreTool({ tool_name: 'Grep', tool_input: { pattern: 'x' } }, unbuilt)),
    '',
    'no graph → nothing to redirect to',
  );
});
