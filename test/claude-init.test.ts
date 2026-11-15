import { test } from 'node:test';
import assert from 'node:assert/strict';

// The MCP launch command is resolved from PATH at init time; pin it to the npx
// form so these expectations are the same on every machine.
process.env.GRAFT_MCP_NPX = '1';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildGraphIfMissing, runInit } from '../src/claude/init.js';
import { formatInitEpilogue } from '../src/cli-epilogue.js';
import { readStamp } from '../src/upkeep.js';
import { runCli } from './helpers.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-init-')); }

function runPostinstall(env: Record<string, string>): string {
  try {
    return execFileSync(process.execPath, ['scripts/postinstall.mjs'],
      { encoding: 'utf8', env: { ...process.env, ...env } });
  } catch { return ''; }
}

test('runInit scaffolds settings + both shims + the skill (build skipped)', () => {
  const d = fresh();
  const r = runInit(d, { build: false, home: fresh() });
  assert.ok(existsSync(join(d, '.claude', 'settings.json')));
  assert.ok(existsSync(join(d, '.claude', 'helpers', 'graft-statusline.cjs')));
  assert.ok(existsSync(join(d, '.claude', 'helpers', 'graft-hooks.cjs')));
  const skillPath = join(d, '.claude', 'skills', 'graft', 'SKILL.md');
  assert.ok(existsSync(skillPath), 'writes the graft skill');
  assert.equal(r.skill, skillPath);
  assert.match(readFileSync(skillPath, 'utf8'), /name: graft/);
  assert.equal(r.built, false);
  const s = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
  assert.ok(s.statusLine.command.includes('graft-statusline.cjs'));
  assert.ok(s.hooks.Stop[0].hooks[0].command.includes('graft-hooks.cjs'));
  assert.deepEqual(s.permissions.allow, ['Bash(trail:*)', 'Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)', 'mcp__graft', 'mcp__trail']);
});

test('runInit overwrites a stale skill file', () => {
  const d = fresh();
  const skillPath = join(d, '.claude', 'skills', 'graft', 'SKILL.md');
  mkdirSync(join(d, '.claude', 'skills', 'graft'), { recursive: true });
  writeFileSync(skillPath, 'stale junk');
  runInit(d, { build: false, home: fresh() });
  assert.match(readFileSync(skillPath, 'utf8'), /name: graft/);
});

test('runInit preserves foreign settings and warns on foreign statusLine', () => {
  const d = fresh();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify({ model: 'x', statusLine: { command: 'mine' } }));
  const r = runInit(d, { build: false, home: fresh() });
  const s = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.model, 'x');
  assert.equal(s.statusLine.command, 'mine');
  assert.equal(r.warnings.length, 1);
});

test('runInit updates a prior Graft statusLine whose command still names the helper', () => {
  const d = fresh();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'node .claude/helpers/graft-statusline.cjs' },
  }));
  runInit(d, { build: false });
  const s = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
  assert.ok(s.statusLine.command.includes('graft-statusline.cjs'));
  assert.match(s.statusLine.command, /CLAUDE_PROJECT_DIR/);
});

test('runInit with statusline: false does not write a statusLine', () => {
  const d = fresh();
  runInit(d, { build: false, statusline: false });
  const s = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.statusLine, undefined);
  assert.equal(s.subagentStatusLine, undefined);
  assert.ok(existsSync(join(d, '.claude', 'helpers', 'graft-statusline.cjs')), 'shim still installed');
  assert.ok(s.hooks.Stop[0].hooks[0].command.includes('graft-hooks.cjs'));
});

test('CLI: --no-statusline leaves statusLine unset', () => {
  const d = fresh();
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'init', d, '--no-build', '--no-agents', '--no-statusline', '--verbose'],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /skipped Claude Code statusLine/);
  const s = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.statusLine, undefined);
  assert.equal(s.subagentStatusLine, undefined);
  assert.equal(readStamp(d)?.opts?.statusline, false);
});

test('runInit is idempotent', () => {
  const d = fresh();
  runInit(d, { build: false, home: fresh() });
  runInit(d, { build: false, home: fresh() });
  const s = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.hooks.PostToolUse.length, 2); // post-edit + tool-savings, not duplicated on re-init
  assert.deepEqual(s.permissions.allow, ['Bash(trail:*)', 'Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)', 'mcp__graft', 'mcp__trail']);
});

test('runInit appends the allowlist to a pre-existing permissions block, preserving unrelated entries', () => {
  const d = fresh();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
  runInit(d, { build: false, home: fresh() });
  const s = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s.permissions.allow, ['Bash(ls)', 'Bash(trail:*)', 'Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)', 'mcp__graft', 'mcp__trail']);
});

test('postinstall prints the nudge in a fresh dir', () => {
  const d = fresh();
  const out = runPostinstall({ INIT_CWD: d, CI: '' });
  assert.match(out, /npx graft init/);
});

test('postinstall is silent when already initialized', () => {
  const d = fresh();
  runInit(d, { build: false, home: fresh() });
  const out = runPostinstall({ INIT_CWD: d, CI: '' });
  assert.equal(out.trim(), '');
});

test('postinstall is silent under CI', () => {
  const out = runPostinstall({ INIT_CWD: fresh(), CI: '1' });
  assert.equal(out.trim(), '');
});

test('formatInitEpilogue: graph built shows stats, wordmark, and the 3-step list', () => {
  const out = formatInitEpilogue({ graphBuilt: true, nodes: 6398, edges: 10912 });
  assert.match(out, /\|___\/\s*$/m);
  assert.ok(out.includes('6,398 nodes · 10,912 edges'));
  assert.ok(out.includes('1. restart your agent'));
  assert.ok(out.includes('2. code as usual'));
  assert.ok(out.includes('3. explore by hand'));
  assert.ok(out.includes('graft ask'));
  assert.ok(!out.includes('build the graph'));
  assert.ok(!out.includes('OPENROUTER'));
  // graft/ is git-ignored now — the shareable artifact is .claude (wiring), not the graph.
  assert.ok(out.includes('git add .claude'));
});

test('formatInitEpilogue: under trail the wordmark says trail, not graft', () => {
  const before = process.env.TRAIL_INVOKED_AS;
  process.env.TRAIL_INVOKED_AS = 'trail';
  try {
    const out = formatInitEpilogue({ graphBuilt: true, nodes: 6398, edges: 10912 });
    assert.ok(!out.includes("/ _` | '__/ _` | |_| __|"), 'no graft wordmark');
    assert.ok(out.includes(" | __| '__/ _` | | |"), 'the trail wordmark');
    assert.ok(out.includes('6,398 nodes · 10,912 edges'));
    assert.ok(out.includes('trail ask') && !out.includes('graft ask'));
  } finally {
    if (before === undefined) delete process.env.TRAIL_INVOKED_AS;
    else process.env.TRAIL_INVOKED_AS = before;
  }
});

test('formatInitEpilogue: graph not built shows "build the graph" as step 1, no stats, same column alignment', () => {
  const built = formatInitEpilogue({ graphBuilt: true, nodes: 4, edges: 4 });
  const notBuilt = formatInitEpilogue({ graphBuilt: false });
  assert.ok(notBuilt.includes('1. build the graph'));
  assert.ok(notBuilt.includes('2. restart your agent'));
  assert.ok(notBuilt.includes('3. code as usual'));
  assert.ok(notBuilt.includes('4. explore by hand'));
  assert.ok(!notBuilt.includes('nodes ·'));
  assert.ok(notBuilt.includes('git add .claude'));
  // the command column (after "restart your agent", the longest label) lines up
  // identically whether there are 3 or 4 numbered steps.
  const col = (text: string, marker: string) => text.split('\n').find((l) => l.includes(marker))!.indexOf('a new session');
  assert.equal(col(built, 'restart your agent'), col(notBuilt, 'restart your agent'));
});

test('formatInitEpilogue: a due deep build adds an "add summaries" step after the graph, never before it is built', () => {
  const due = formatInitEpilogue({ graphBuilt: true, nodes: 4, edges: 4, deepDue: true });
  assert.ok(due.includes('1. add summaries'), due);
  assert.ok(due.includes('graft build --deep'));
  assert.ok(due.includes('an LLM pass: it needs an API key and costs tokens'));
  assert.ok(due.includes('2. restart your agent'));
  assert.ok(!formatInitEpilogue({ graphBuilt: true, nodes: 4, edges: 4 }).includes('--deep'), 'not due: no step');
  assert.ok(!formatInitEpilogue({ graphBuilt: false, deepDue: true }).includes('--deep'), 'no graph yet: build it first');
});

/**
 * A repo holding one function, with its structural graph built (no `--deep`).
 * Built here rather than by init: init's own build spawns the CLI with this
 * run's `--import tsx`, which a temp folder cannot resolve when run from source.
 */
function builtRepo(home: string): string {
  const d = fresh();
  writeFileSync(join(d, 'a.ts'), 'export function hello(): number {\n  return 1;\n}\n');
  const b = runCli(['build', d], { home });
  assert.equal(b.status, 0, b.describe());
  return d;
}

test('CLI: graft init suggests graft build --deep when no deep build has run on the repo', () => {
  // A scratch home: a real `~/.graft/settings.json` threshold must not steer this.
  const home = fresh();
  const d = builtRepo(home);
  const res = runCli(['init', d, '--no-agents'], { home });
  assert.equal(res.status, 0, res.describe());
  assert.match(res.stderr, /graph ready/);
  assert.match(res.stderr, /· run `graft build --deep` next: no `graft build --deep` has run here yet, so none of the \d+ nodes has a prose summary/);
  // Run with no terminal, as an agent runs it: the agent is told to pass it on.
  assert.match(res.stderr, /Tell the user a `graft build --deep` is recommended\./);

  const verbose = runCli(['init', d, '--no-agents', '--verbose'], { home });
  assert.equal(verbose.status, 0, verbose.describe());
  assert.match(verbose.stderr, /1\. add summaries +graft build --deep/);
});

test('CLI: graft init suggests no deep build when there is no graph, or the repo opted out', () => {
  const home = fresh();
  const skipped = runCli(['init', fresh(), '--no-build', '--no-agents'], { home });
  assert.equal(skipped.status, 0, skipped.describe());
  assert.doesNotMatch(skipped.stderr, /build --deep/);

  const optedOut = builtRepo(home);
  const t = runCli(['deep-threshold', '100', optedOut], { home });
  assert.equal(t.status, 0, t.describe());
  const res = runCli(['init', optedOut, '--no-agents'], { home });
  assert.equal(res.status, 0, res.describe());
  assert.match(res.stderr, /graph ready/);
  assert.doesNotMatch(res.stderr, /build --deep/);
});

test('CLI: graft init prints one line per step, and no banner', () => {
  const d = fresh();
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'init', d, '--no-build', '--no-agents'],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /skipped the graph build: run graft build/);
  assert.match(res.stderr, /✓ claude +\.claude[\\/], \.mcp\.json/);
  assert.match(res.stderr, /restart your agents so a new session picks up graft/);
  assert.doesNotMatch(res.stderr, /to share it: graft\/ stays local/, 'the commit tip is left out in this fork');
  assert.ok(!res.stderr.includes('|___/'), 'the banner is --verbose only');
  assert.ok(!res.stderr.includes('✓ wrote'), 'file-by-file lines are --verbose only');
});

test('CLI: graft init --verbose epilogue has the wordmark + next steps, and never mentions OPENROUTER', () => {
  const d = fresh();
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'init', d, '--no-build', '--no-agents', '--verbose'],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stderr.includes('|___/'), 'wordmark present');
  assert.ok(res.stderr.includes('code as usual'));
  assert.ok(res.stderr.includes('restart your agent'));
  assert.ok(res.stderr.includes('git add .claude'));
  assert.ok(res.stderr.includes('graft ask'));
  assert.ok(!res.stderr.includes('OPENROUTER'));
  // --no-build, never built before → "build the graph" is step 1
  assert.ok(res.stderr.includes('1. build the graph'));
});

// --- buildGraphIfMissing --------------------------------------------------
// Shared with the CLI's non-Claude path, so its guards are pinned here.

test('buildGraphIfMissing: build:false never spawns a build', () => {
  assert.equal(buildGraphIfMissing(fresh(), { build: false, cliPath: '/nonexistent/cli.js' }), false);
});

test('buildGraphIfMissing: no cliPath means nothing to spawn', () => {
  assert.equal(buildGraphIfMissing(fresh(), { build: true }), false);
});

test('buildGraphIfMissing: an existing graph is left alone', () => {
  const dir = fresh();
  mkdirSync(join(dir, 'graft', '.graph'), { recursive: true });
  writeFileSync(join(dir, 'graft', '.graph', 'wiring.json'), '{}');
  // A bogus cliPath would throw if it were reached; the wiring check short-circuits.
  assert.equal(buildGraphIfMissing(dir, { build: true, cliPath: '/nonexistent/cli.js' }), false);
});
