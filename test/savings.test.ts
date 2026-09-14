/**
 * Tests for the shared "tokens saved" estimate ({@link savingsFor} +
 * {@link withSavings}) that every retrieval-style command routes through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  savingsFor,
  savingsLine,
  withSavings,
  toTokens,
  setPricing,
  setRepoRoot,
  setMcpSurface,
  setModelTable,
} from '../src/context/savings.js';
import { NO_MODEL, pricingFor, type AgentModel } from '../src/context/price.js';
import { hasSavingsTally } from '../src/claude/tally.js';
import type { GraphV1, NodeV1 } from '../src/graph/types.js';

const certain = (id: string, label?: string): AgentModel => ({ id, confidence: 'certain', label });

/** The footer for a fixed 1,000-token saving, priced however the caller set it
 * up. Every wording assertion below reads this one string. */
function footer(): string {
  return savingsLine('x'.repeat(400), { files: 2, baselineChars: 8000 });
}

/** Reset both process-level slots between tests: a leaked model table would make
 * the next test assert the wrong branch entirely. */
function clearPricing(): void {
  setPricing(null);
  setModelTable(null);
  setMcpSurface(false);
}

function fileNode(path: string, chars?: number): NodeV1 {
  return {
    id: path,
    name: path,
    kind: 'file',
    path,
    span: 'L1-L1',
    signature: null,
    exported: true,
    origin: 'ast',
    body_hash: '',
    summary_state: 'pending',
    summary: null,
    crux: null,
    chars,
  };
}

function graphOf(nodes: NodeV1[]): GraphV1 {
  return { meta: { version: 1, nodeCount: nodes.length, edgeCount: 0, languages: [] }, nodes, edges: [] };
}

test('savingsFor: sums the sizes of the distinct baseline files', () => {
  const g = graphOf([fileNode('a.ts', 400), fileNode('b.ts', 600)]);
  const s = savingsFor(g, ['a.ts', 'b.ts', 'a.ts']); // duplicate a.ts counted once
  assert.deepEqual(s, { files: 2, baselineChars: 1000 });
});

test('savingsFor: skips files with no known size, returns undefined when none are sized', () => {
  const g = graphOf([fileNode('a.ts'), fileNode('b.ts', 800)]);
  assert.deepEqual(savingsFor(g, ['a.ts', 'b.ts']), { files: 1, baselineChars: 800 });
  assert.equal(savingsFor(graphOf([fileNode('a.ts')]), ['a.ts']), undefined);
  assert.equal(savingsFor(g, ['missing.ts']), undefined);
});

test('savingsLine: reports saved tokens and percent when the output is smaller', () => {
  const body = 'x'.repeat(40); // ≈ 10 tok
  const footer = savingsLine(body, { files: 2, baselineChars: 8000 }); // baseline ≈ 2000 tok
  assert.match(footer, /tokens saved ≈ [\d,]+ \(\d+%\)/);
  assert.match(footer, /2 file\(s\)/);
  const base = toTokens(8000);
  // en-US like the assertions above (`[\d,]+`) and like savingsLine itself: a
  // bare toLocaleString() here made this test pass only on en-US machines.
  assert.ok(footer.includes((base - toTokens(body.length)).toLocaleString('en-US')));
  // The nudge rides along so the agent reports the turn total without SKILL.md.
  assert.match(footer, /end of your reply/i);
  assert.match(footer, /graft saved ~N tokens/);
  // The nudge must NOT introduce a second "[graft] tokens saved ≈ <n>" token —
  // the PostToolUse accumulator sums every such match, so a stray one double-counts.
  assert.equal((footer.match(/\[graft\] tokens saved ≈ [\d,]+/g) ?? []).length, 1);
});

test('savingsLine: stays silent when there is nothing honest to claim', () => {
  assert.equal(savingsLine('anything', undefined), '');
  assert.equal(savingsLine('anything', { files: 1, baselineChars: 0 }), '');
  // Baseline no bigger than the output itself (tiny file) → no claim.
  assert.equal(savingsLine('x'.repeat(1000), { files: 1, baselineChars: 40 }), '');
});

test('withSavings: puts the line on top so `head -N` and host truncation keep it', () => {
  const body = 'line1\nline2\nline3';
  const out = withSavings(body, { files: 2, baselineChars: 8000 });
  const first = out.split('\n')[0];
  assert.match(first, /^\[graft\] tokens saved ≈ [\d,]+/);
  assert.ok(out.endsWith(body), 'body follows the header verbatim');
  // Exactly one number in the whole output — a second copy would be
  // double-counted by the PostToolUse accumulator's matchAll.
  assert.equal((out.match(/\[graft\] tokens saved ≈ [\d,]+/g) ?? []).length, 1);
});

test('withSavings: returns the body untouched when there is nothing to claim', () => {
  assert.equal(withSavings('body', undefined), 'body');
});

// ── priced: the session was billed, or the agent named its model ───────────

test('a measured rate is priced bare — there is nothing to caveat', () => {
  // $5/Mtok: a 1,000-token saving is worth half a cent, which must read as
  // "<$0.01" rather than "$0.00" — see formatDollars.
  setPricing({ rate: { usdPerMtok: 5, measured: true }, model: certain('claude-opus-5') });
  const f = footer();
  assert.match(f, /worth <\$0\.01/);
  assert.match(f, /rate this session is actually paying/);
  assert.match(f, /"🌱 graft saved ~N tokens \(~\$X\) this turn"/);
  clearPricing();
});

test('a model the agent named is priced at list, and named in the tally', () => {
  setPricing(pricingFor(certain('claude-opus-5')));
  const f = footer();
  assert.match(f, /\(~\$X for claude-opus-5\) this turn/);
  assert.doesNotMatch(f, /actually paying/, 'a list price is not what the session paid');
  clearPricing();
});

test('the tally prefers the host display name over the wire id', () => {
  // The user picked "Claude Opus 5" from a menu; `vertex_ai/claude-opus-5` is
  // plumbing they should not have to decode.
  setPricing(pricingFor(certain('vertex_ai/claude-opus-5', 'Claude Opus 5')));
  const f = footer();
  assert.match(f, /\(~\$X for Claude Opus 5\) this turn/);
  assert.doesNotMatch(f, /vertex_ai/);
  clearPricing();
});

// ── unpriced: nothing named the model ──────────────────────────────────────

test('with no model and no host table, the tally is tokens alone', () => {
  setPricing(pricingFor(NO_MODEL));
  setModelTable(null);
  const f = footer();
  assert.match(f, /"🌱 graft saved ~N tokens by this turn"/);
  assert.doesNotMatch(f, /~\$X|worth \$/, 'no model, so no dollar figure of any kind');
  // On the CLI the fix exists, so it is named.
  assert.match(f, /--agent-model/);
  clearPricing();
});

test('over MCP the agent is pointed at the tool argument, not the CLI flag', () => {
  // `--agent-model` is a CLI flag; MCP has no such thing, so advising it there
  // would be an instruction the agent cannot follow. The `model` tool argument
  // is the equivalent that does exist on this surface.
  setPricing(pricingFor(NO_MODEL));
  setModelTable(null);
  setMcpSurface(true);
  const f = footer();
  assert.doesNotMatch(f, /--agent-model/);
  assert.match(f, /Send `model: "<your model id>"`/);
  assert.match(f, /"🌱 graft saved ~N tokens by this turn"/);
  clearPricing();
});

test('a host with a table is told to relay it, and nothing contradictory', () => {
  // "Reproduce the table" and "report the tokens alone" must never appear in the
  // same breath: the table IS the answer where one exists.
  setPricing(pricingFor(NO_MODEL));
  setMcpSurface(true);
  setModelTable(() => [{ label: 'Claude Opus 5', value: '$3.12' }]);
  const f = footer();
  assert.match(f, /Reproduce the table exactly/);
  assert.doesNotMatch(f, /Send `model:/, 'no competing instruction alongside the table');
  assert.doesNotMatch(f, /--agent-model/);
  clearPricing();
});

test('a model with no published price is not priced from anything else', () => {
  // Previously an env override filled this gap. It no longer exists: an unknown
  // price means tokens alone, full stop.
  setPricing(pricingFor(certain('claude-opus-6')));
  setModelTable(null);
  const f = footer();
  assert.match(f, /"🌱 graft saved ~N tokens by this turn"/);
  assert.doesNotMatch(f, /~\$X|worth \$/);
  clearPricing();
});

test('a host that lists its models gets a per-model table instead of nothing', () => {
  setPricing(pricingFor(NO_MODEL));
  setModelTable(() => [
    { label: 'Claude Opus 5', value: '$3.12' },
    { label: 'Gemini 3.8 Flash', value: '$0.47' },
  ]);
  const f = footer();
  assert.match(f, /graft saved ~N tokens by this turn, as estimated below:/);
  // Drawn with ASCII rules rather than markdown pipes: a chat host only renders
  // a markdown table when it sees a `|---|` delimiter row, and pipe rows without
  // one arrive as a wall of plain text. A box needs no renderer cooperation.
  assert.match(f, /\+------------------\+-------\+/);
  assert.match(f, /\| Claude Opus 5    \| \$3\.12 \|/);
  // Values are right-aligned so the amounts line up on their last digit.
  assert.match(f, /\| Gemini 3\.8 Flash \| \$0\.47 \|/);
  // Fenced, because the padding IS the table — unfenced, a chat host collapses
  // the space runs and the box falls apart.
  assert.match(f, /below:\n```\n\+/);
  assert.match(f, /\+\n```"/);
  // And the agent is told where to put it.
  assert.match(f, /collapsed\/expandable section/);
  clearPricing();
});

test('the table opens and closes with a rule, so it reads as a box', () => {
  setPricing(pricingFor(NO_MODEL));
  setModelTable(() => [{ label: 'M', value: '$1.00' }]);
  const lines = footer().slice(footer().indexOf('```')).split('\n');
  assert.equal(lines[1], '+---+-------+', 'top rule');
  assert.equal(lines[2], '| M | $1.00 |');
  assert.equal(lines[3], '+---+-------+', 'bottom rule matches the top exactly');
  clearPricing();
});

test('the table is driven by the real saving, not a fixed number', () => {
  setPricing(pricingFor(NO_MODEL));
  let seen = -1;
  setModelTable((saved) => {
    seen = saved;
    return [{ label: 'M', value: '$1' }];
  });
  footer();
  assert.equal(seen, 1900, 'the table prices the tokens this call actually saved');
  clearPricing();
});

test('a host table that throws or comes back empty degrades to tokens alone', () => {
  setPricing(pricingFor(NO_MODEL));
  setModelTable(() => { throw new Error('unreadable config'); });
  assert.match(footer(), /"🌱 graft saved ~N tokens by this turn"/);

  setModelTable(() => []);
  assert.match(footer(), /"🌱 graft saved ~N tokens by this turn"/);
  clearPricing();
});

// ── invariants every branch has to keep ───────────────────────────────────

test('every wording branch leaves exactly one number for the accumulator', () => {
  // The nudge must never grow a second `[graft] tokens saved ≈ <n>` — the
  // PostToolUse accumulator sums every match, so an example carrying the
  // pattern would double-count the call.
  const branches: Array<() => void> = [
    () => setPricing({ rate: { usdPerMtok: 5, measured: true }, model: certain('claude-opus-5') }),
    () => setPricing(pricingFor(certain('claude-opus-5'))),
    () => setPricing(pricingFor(certain('claude-opus-6'))),
    () => setPricing(pricingFor(NO_MODEL)),
    () => {
      setPricing(pricingFor(NO_MODEL));
      setModelTable(() => [{ label: 'Claude Opus 5', value: '$0.01' }]);
    },
  ];
  for (const setup of branches) {
    clearPricing();
    setup();
    assert.equal((footer().match(/\[graft\] tokens saved ≈ [\d,]+/g) ?? []).length, 1);
  }
  clearPricing();
});

test('every wording branch still matches the reported-turns tally regex', () => {
  // Wording changes must not quietly zero `reportedTurns`, which measures
  // whether the agent told the user anything at all.
  assert.equal(hasSavingsTally('🌱 graft saved ~12,400 tokens (~$0.04) this turn'), true);
  assert.equal(hasSavingsTally('🌱 graft saved ~5,548 tokens (~$0.03 for Claude Opus 5) this turn'), true);
  assert.equal(hasSavingsTally('🌱 graft saved ~5,548 tokens by this turn'), true);
  assert.equal(
    hasSavingsTally(
      '🌱 graft saved ~5,548 tokens by this turn, which estimates in $ as following:\n' +
        '| Claude Opus 5 | $0.03 |',
    ),
    true,
  );
});

test('setPricing refuses a rate that would render as $NaN', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    setPricing({ rate: { usdPerMtok: bad, measured: true }, model: certain('claude-opus-5') });
    assert.doesNotMatch(footer(), /worth \$[\d.]|~\$X/, `rate ${bad} must price nothing`);
  }
  clearPricing();
});

test('setRepoRoot is still accepted and changes nothing about pricing', () => {
  // Kept for the callers that set it; the config file it used to address is no
  // longer consulted by any pricing path.
  setRepoRoot(process.platform === 'win32' ? 'C:\\repo' : '/repo');
  setPricing(pricingFor(NO_MODEL));
  assert.match(footer(), /"🌱 graft saved ~N tokens by this turn"/);
  setRepoRoot(null);
  clearPricing();
});

