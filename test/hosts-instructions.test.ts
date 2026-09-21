import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instructionBody, cursorRule, kiloRule, kiroSteering, windsurfRule } from '../src/hosts/instructions.js';
import { HOSTS } from '../src/hosts/registry.js';
import { skillTemplate } from '../src/claude/skill-template.js';

test('canonical body names the three essentials', () => {
  const b = instructionBody();
  assert.match(b, /^## Graft — repo context graph/m);
  assert.match(b, /graft ask "/);
  assert.match(b, /graft\/INDEX\.md/);
  assert.match(b, /graft build/);
  assert.match(b, /every occurrence|enumerate with grep/i, 'teaches the exhaustive-task grep rule');
  assert.match(b, /callers/, 'teaches the callers/callees/impact commands');
  assert.match(b, /truncated/i, 'tells the agent to follow up on truncated spans');
  assert.match(b, /graft grep/, 'routes sweeps to graft grep');
  assert.match(b, /graft map/, 'tells the agent to orient with graft map before exploring');
  assert.match(b, /\[scope\/\]/, 'teaches the [scope/] label on multi-scope/monorepo hits');
  assert.match(b, /--in <scope>\//, 'teaches narrowing with ask --in <scope>/');
  assert.ok(!/\bhook|statusline\b/i.test(b), 'no host-specific machinery in the shared body');
});

test('cursor rule has alwaysApply frontmatter and the body', () => {
  const r = cursorRule();
  assert.match(r, /^---\ndescription: .+\nalwaysApply: true\n---\n/);
  assert.ok(r.includes(instructionBody()));
});

test('kiro steering has inclusion: always frontmatter and the body', () => {
  const r = kiroSteering();
  assert.match(r, /^---\ninclusion: always\n---\n/);
  assert.ok(r.includes(instructionBody()));
});

test('windsurf rule is the plain body', () => {
  assert.ok(windsurfRule().includes(instructionBody()));
});

test('kilo rule is the plain body — no frontmatter to confuse the loader', () => {
  const r = kiloRule();
  assert.ok(r.includes(instructionBody()));
  assert.ok(!r.startsWith('---'));
});

test('the body tells the agent to verify a claim rather than assume it', () => {
  const b = instructionBody();
  assert.match(b, /### Verify before you assert/);
  // The distinction the section exists to draw: an absence claim needs the
  // exhaustive tool, not the ranked one.
  assert.match(b, /graft grep/, 'names the exhaustive tool for an absence claim');
  assert.match(b, /never on|not from what the code is|Plausible is not/i);
  // And the counterweight, so the rule does not read as "re-read everything":
  // re-verifying spans graft already generated is exactly the waste it prevents.
  assert.match(b, /covers:/, 'keeps the "spans are authoritative, cite them" carve-out');
});

test('every host that carries instructions carries the verify rule', () => {
  // One body, many renderers — a host added with a bespoke `content` (as the
  // skill-based ones have) can silently miss a section the others all get, and
  // nothing else in the suite would notice.
  for (const host of HOSTS) {
    assert.match(
      host.content(),
      /Verify before you assert/,
      `${host.id} (${host.relPath}) must carry the verification rule`,
    );
  }
  assert.match(skillTemplate(), /Verify before you assert/, 'and the Claude/AdaL/Grok skill too');
});
