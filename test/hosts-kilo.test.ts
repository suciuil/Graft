import { test } from 'node:test';
import assert from 'node:assert/strict';

// The MCP launch command is resolved from PATH at init time; pin it to the npx
// form so these expectations are the same on every machine.
process.env.GRAFT_MCP_NPX = '1';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runHostsInit } from '../src/hosts/init.js';
import { KILO_RULE_REL, kiloConfigPath, stripJsonc, writeKiloConfig } from '../src/hosts/kilo.js';
import { planInit } from '../src/hosts/plan.js';
import { toPosixPath } from '../src/util/paths.js';
import { tmpRepo } from './helpers.js';

function fresh(): string { return tmpRepo('kilo'); }

const GRAFT_SERVER = { type: 'local', command: ['npx', '-y', '@nanonets/graft', 'mcp'], enabled: true };

test('a bare repo gets the rule file plus a .kilo/kilo.jsonc that loads it', () => {
  const repo = fresh(); const home = fresh();
  const r = runHostsInit(repo, { home, agents: ['kilo'] });

  assert.deepEqual(r.written.map((w) => w.id), ['kilo', 'kilo-config']);
  assert.deepEqual(r.written.map((w) => w.action), ['created', 'created']);
  assert.match(readFileSync(join(repo, '.kilo', 'rules', 'graft.md'), 'utf8'), /graft ask "/);

  const cfg = JSON.parse(readFileSync(join(repo, '.kilo', 'kilo.jsonc'), 'utf8'));
  // The rule file is inert unless it is listed here — that is the whole point.
  assert.deepEqual(cfg.instructions, [KILO_RULE_REL]);
  assert.deepEqual(cfg.mcp.graft, GRAFT_SERVER);
  // Posix separators, or the entry never matches the file on Windows.
  assert.equal(KILO_RULE_REL, '.kilo/rules/graft.md');
});

test('re-running converges', () => {
  const repo = fresh(); const home = fresh();
  runHostsInit(repo, { home, agents: ['kilo'] });
  const again = runHostsInit(repo, { home, agents: ['kilo'] });
  assert.deepEqual(again.written.map((w) => w.action), ['unchanged', 'unchanged']);
});

test('an existing root kilo.jsonc is merged into, not shadowed by a new .kilo/ one', () => {
  const repo = fresh();
  writeFileSync(join(repo, 'kilo.jsonc'), JSON.stringify({ model: 'sonnet', instructions: ['docs/house.md'] }));

  const w = writeKiloConfig(repo);
  assert.equal(w.action, 'updated');
  assert.equal(toPosixPath(w.path), toPosixPath(join(repo, 'kilo.jsonc')));
  assert.ok(!existsSync(join(repo, '.kilo', 'kilo.jsonc')), 'a second config would take precedence and hide theirs');

  const cfg = JSON.parse(readFileSync(join(repo, 'kilo.jsonc'), 'utf8'));
  assert.equal(cfg.model, 'sonnet', 'foreign keys preserved');
  assert.deepEqual(cfg.instructions, ['docs/house.md', KILO_RULE_REL], 'appended, not replaced');
});

test('.kilo/kilo.jsonc wins over a root kilo.jsonc when both exist', () => {
  const repo = fresh();
  writeFileSync(join(repo, 'kilo.jsonc'), '{}');
  mkdirSync(join(repo, '.kilo'), { recursive: true });
  writeFileSync(join(repo, '.kilo', 'kilo.jsonc'), '{}');
  assert.equal(toPosixPath(kiloConfigPath(repo)), toPosixPath(join(repo, '.kilo', 'kilo.jsonc')));
});

test('mcp: false still registers the rule file, just without the server', () => {
  const repo = fresh(); const home = fresh();
  runHostsInit(repo, { home, agents: ['kilo'], mcp: false });
  const cfg = JSON.parse(readFileSync(join(repo, '.kilo', 'kilo.jsonc'), 'utf8'));
  assert.deepEqual(cfg.instructions, [KILO_RULE_REL]);
  assert.equal(cfg.mcp, undefined);
});

test('a commented .jsonc is never rewritten — comments would not survive JSON.stringify', () => {
  const repo = fresh();
  mkdirSync(join(repo, '.kilo'), { recursive: true });
  const path = join(repo, '.kilo', 'kilo.jsonc');
  const original = `{
  // our house model
  "model": "sonnet",
}
`;
  writeFileSync(path, original);

  const w = writeKiloConfig(repo);
  assert.equal(w.action, 'skipped-unparseable');
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('a commented .jsonc that already lists graft reports unchanged, not a warning', () => {
  const repo = fresh();
  mkdirSync(join(repo, '.kilo'), { recursive: true });
  const path = join(repo, '.kilo', 'kilo.jsonc');
  writeFileSync(path, `{
  // graft — wired by graft init
  "instructions": ["${KILO_RULE_REL}"],
  "mcp": { "graft": ${JSON.stringify(GRAFT_SERVER)} }
}
`);
  assert.equal(writeKiloConfig(repo).action, 'unchanged');
});

test('a non-array instructions value is left alone; the mcp half still lands', () => {
  const repo = fresh();
  writeFileSync(join(repo, 'kilo.json'), JSON.stringify({ instructions: 'see AGENTS.md' }));
  assert.equal(writeKiloConfig(repo).action, 'updated');
  const cfg = JSON.parse(readFileSync(join(repo, 'kilo.json'), 'utf8'));
  assert.equal(cfg.instructions, 'see AGENTS.md');
  assert.deepEqual(cfg.mcp.graft, GRAFT_SERVER);
});

test('genuinely broken JSON is skipped', () => {
  const repo = fresh();
  writeFileSync(join(repo, 'kilo.jsonc'), '{ not json at all');
  assert.equal(writeKiloConfig(repo).action, 'skipped-unparseable');
  assert.equal(readFileSync(join(repo, 'kilo.jsonc'), 'utf8'), '{ not json at all');
});

test('stripJsonc keeps comment-shaped text inside strings', () => {
  const src = `{"url": "https://x.dev/a", /* gone */ "b": 1, // gone
 "c": [2,]}`;
  assert.deepEqual(JSON.parse(stripJsonc(src)), { url: 'https://x.dev/a', b: 1, c: [2] });
});

test('the plan names both kilo files, and tags the config as MCP', () => {
  const repo = fresh();
  const kilo = planInit(repo, { home: fresh(), ids: ['kilo'] })[0];
  assert.deepEqual(
    kilo.writes.map((w) => toPosixPath(w.path.slice(repo.length))).sort(),
    ['/.kilo/kilo.jsonc', '/.kilo/rules/graft.md'],
  );
  assert.ok(kilo.writes.some((w) => w.kind === 'mcp'), 'else the picker labels Kilo Code "no MCP"');
  assert.ok(kilo.writes.every((w) => w.scope === 'repo'));
});
