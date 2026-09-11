/**
 * Tests for the shared "tokens saved" estimate ({@link savingsFor} +
 * {@link withSavings}) that every retrieval-style command routes through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savingsFor, savingsLine, withSavings, toTokens, setPricing, setRepoRoot } from '../src/context/savings.js';
import { NO_MODEL, RATE_ENV, pricingFor, type AgentModel } from '../src/context/price.js';
import { hasSavingsTally } from '../src/claude/tally.js';
import type { GraphV1, NodeV1 } from '../src/graph/types.js';

/** A developer box that exports the override would otherwise price every
 * fixture below at a rate the assertions know nothing about. */
delete process.env[RATE_ENV];

const certain = (id: string): AgentModel => ({ id, confidence: 'certain' });
const declared = (id: string): AgentModel => ({ id, confidence: 'declared' });

/** The footer for a fixed 1,000-token saving, priced however the caller set it
 * up. Every wording assertion below reads this one string. */
function footer(): string {
  return savingsLine('x'.repeat(400), { files: 2, baselineChars: 8000 });
}

/** Run `body` with the env override set (or explicitly unset), always restoring
 * it — the wording branches turn on this variable, so a leak between tests would
 * silently assert the wrong scenario. */
function withEnvRate<T>(value: string | null, body: () => T): T {
  const had = process.env[RATE_ENV];
  if (value === null) delete process.env[RATE_ENV];
  else process.env[RATE_ENV] = value;
  try {
    return body();
  } finally {
    if (had === undefined) delete process.env[RATE_ENV];
    else process.env[RATE_ENV] = had;
  }
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
  assert.match(footer, /graft saved ~N tokens \(.*\) this turn/);
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

test('the turn nudge carries no dollar figure until something prices the tokens', () => {
  withEnvRate(null, () => {
    setPricing(pricingFor(NO_MODEL));
    setRepoRoot(null);
    const f = savingsLine('body', { files: 2, baselineChars: 8000 });
    assert.match(f, /graft saved ~N tokens/);
    assert.doesNotMatch(f, /~\$0|worth \$[\d.]/, 'nothing measured or declared, so nothing is priced');
    // Unpriced is the one branch where the user can DO something about it, so
    // both the prose and the relayed example carry the fix.
    assert.match(f, /`model` in \.graft\/config\.json/);
    assert.doesNotMatch(f, /\]\(/, 'no repo known, so the file is named but not linked');
  });
  setPricing(null);
});

test('the unpriced hint links the config file once the repo is known', () => {
  withEnvRate(null, () => {
    setPricing(pricingFor(NO_MODEL));
    setRepoRoot(process.platform === 'win32' ? 'C:\\repo' : '/repo');
    // A markdown link with an absolute file URI, so a chat host can open the real
    // file on click rather than showing an unresolvable relative path.
    assert.match(footer(), /\[\.graft\/config\.json\]\(file:\/\/\/\S*\.graft\/config\.json\)/);
  });
  setRepoRoot(null);
  setPricing(null);
});

// ── scenario 0: the session's own billing, which outranks every list price ──

test('a measured rate is priced bare — there is nothing to caveat', () => {
  // $5/Mtok: a 1,000-token saving is worth half a cent, which must read as
  // "<$0.01" rather than "$0.00" — see formatDollars.
  setPricing({ rate: { usdPerMtok: 5, measured: true }, model: certain('claude-opus-5') });
  const f = footer();
  assert.match(f, /worth <\$0\.01/);
  assert.match(f, /rate this session is actually paying/);
  assert.match(f, /"🌱 graft saved ~N tokens \(~\$X\) this turn"/);
  setPricing(null);
});

test('a measured rate is not displaced by the env override', () => {
  // What the user was BILLED beats a number they typed into a shell once.
  withEnvRate('99', () => {
    setPricing(pricingFor(certain('claude-opus-5'), { usdPerMtok: 5, measured: true }));
    const f = footer();
    assert.match(f, /rate this session is actually paying/);
    assert.doesNotMatch(f, new RegExp(RATE_ENV));
  });
  setPricing(null);
});

// ── scenario 1: model certain, graft knows its price ──────────────────────

test('a certain model with a known price names both, and ignores every override', () => {
  // The host stamped the model (or --agent-model named it) and graft's table
  // prices it: both halves are facts, so neither the env var nor a config entry
  // may touch them.
  withEnvRate('99', () => {
    setPricing(pricingFor(certain('claude-opus-5')));
    const f = footer();
    assert.match(f, /\(~\$X at \$5\/input mtok for claude-opus-5\) this turn/);
    assert.doesNotMatch(f, new RegExp(RATE_ENV), 'the override must not appear at all');
    assert.doesNotMatch(f, /config\.json/, 'nor may a config entry claim the credit');
    assert.doesNotMatch(f, /actually paying/, 'a list price is not what the session paid');
  });
  setPricing(null);
});

test('the quoted rate is the real list number, not a dollars-and-cents rounding', () => {
  // formatDollars floors at "<$0.01", which is right for a saving and wrong for
  // a rate: $0.2/mtok must read as itself.
  withEnvRate(null, () => {
    setPricing(pricingFor(certain('gpt-5.6-luna')));
    assert.match(footer(), /~\$X at \$0\.2\/input mtok for gpt-5\.6-luna/);
  });
  setPricing(null);
});

// ── scenario 2: model certain, graft has no price for it ──────────────────

test('2.1 a certain unpriced model falls back to the env override, and says so', () => {
  withEnvRate('7.5', () => {
    setPricing(pricingFor(certain('claude-opus-6')));
    const f = footer();
    assert.match(
      f,
      new RegExp(`\\(~\\$X at \\$7\\.5/input mtok for claude-opus-6 specified by the ${RATE_ENV} environment variable\\) this turn`),
    );
    assert.doesNotMatch(f, /config\.json/, 'a config entry never overrides a model we are sure of');
  });
  setPricing(null);
});

test('2.2 a certain unpriced model with no override explains the exact gap', () => {
  withEnvRate(null, () => {
    setPricing(pricingFor(certain('claude-opus-6')));
    const f = footer();
    assert.match(
      f,
      new RegExp(`the savings in dollars cannot be estimated because graft has no info about claude-opus-6's price per input mtok and also the ${RATE_ENV} environment variable was not set`),
    );
    assert.doesNotMatch(f, /~\$0|worth \$[\d.]/, 'and no figure is invented');
  });
  setPricing(null);
});

// ── scenario 3 & 4: the model came from .graft/config.json ────────────────

test('3 a declared model with a known price names the config it came from', () => {
  // The config is pinned while the host's model selector is not. Naming the
  // file is what lets a reader notice the two have drifted apart — and the env
  // override is ignored, because the pair (model, list price) is still complete.
  withEnvRate('99', () => {
    setPricing(pricingFor(declared('claude-opus-5')));
    const f = footer();
    assert.match(f, /\(~\$X at \$5\/input mtok for claude-opus-5 specified as model in \.graft\/config\.json\) this turn/);
    assert.doesNotMatch(f, new RegExp(RATE_ENV));
    assert.doesNotMatch(f, /actually paying/);
  });
  setPricing(null);
});

test('4.1 a declared unpriced model credits the config AND the override', () => {
  withEnvRate('7.5', () => {
    setPricing(pricingFor(declared('claude-opus-6')));
    assert.match(
      footer(),
      new RegExp(`\\(~\\$X at \\$7\\.5/input mtok for claude-opus-6 specified as model in \\.graft/config\\.json and by the specified ${RATE_ENV} environment variable\\) this turn`),
    );
  });
  setPricing(null);
});

test('4.2 a declared unpriced model with no override names the file and the var', () => {
  withEnvRate(null, () => {
    setPricing(pricingFor(declared('claude-opus-6')));
    assert.match(
      footer(),
      new RegExp(`cannot be estimated because graft has no info about the price per input mtok for the 'claude-opus-6' model specified in the \\.graft/config\\.json file and also the ${RATE_ENV} environment variable was not set`),
    );
  });
  setPricing(null);
});

// ── scenario 5: nothing names a model at all ──────────────────────────────

test('5.1 with no model at all the override is the whole basis, and says so', () => {
  withEnvRate('7.5', () => {
    setPricing(pricingFor(NO_MODEL));
    const f = footer();
    assert.match(
      f,
      new RegExp(`\\(~\\$X at \\$7\\.5/input mtok as specified by the ${RATE_ENV} environment variable and no model specified in the \\.graft/config\\.json\\) this turn`),
    );
    assert.doesNotMatch(f, /list list/, 'and it still reads as English');
  });
  setPricing(null);
});

test('5.2 with neither a model nor an override, the tally names both gaps', () => {
  withEnvRate(null, () => {
    setPricing(pricingFor(NO_MODEL));
    assert.match(
      footer(),
      new RegExp(`cannot be estimated because no model was specified in the \\.graft/config\\.json file and also the ${RATE_ENV} environment variable was not set`),
    );
  });
  setPricing(null);
});

test('a malformed override is reported as malformed, not as absent', () => {
  // "unset" and "set to nonsense" send the user to different fixes.
  withEnvRate('abc', () => {
    setPricing(pricingFor(NO_MODEL));
    assert.match(footer(), new RegExp(`the ${RATE_ENV} environment variable was set to a value that is not a positive number`));
  });
  setPricing(null);
});

// ── invariants every branch has to keep ───────────────────────────────────

test('every wording branch leaves exactly one number for the accumulator', () => {
  // The nudge must never grow a second `[graft] tokens saved ≈ <n>` — the
  // PostToolUse accumulator sums every match, so an example carrying the
  // pattern would double-count the call.
  const branches = [
    () => setPricing({ rate: { usdPerMtok: 5, measured: true }, model: certain('claude-opus-5') }),
    () => setPricing(pricingFor(certain('claude-opus-5'))),
    () => setPricing(pricingFor(declared('claude-opus-5'))),
    () => setPricing(pricingFor(certain('claude-opus-6'))),
    () => setPricing(pricingFor(NO_MODEL)),
  ];
  withEnvRate(null, () => {
    for (const setup of branches) {
      setup();
      assert.equal((footer().match(/\[graft\] tokens saved ≈ [\d,]+/g) ?? []).length, 1);
    }
  });
  setPricing(null);
});

test('every wording branch still matches the reported-turns tally regex', () => {
  // Wording changes must not quietly zero `reportedTurns`, which measures
  // whether the agent told the user anything at all.
  assert.equal(hasSavingsTally('🌱 graft saved ~12,400 tokens (~$0.04) this turn'), true);
  assert.equal(
    hasSavingsTally('🌱 graft saved ~5,548 tokens (~$0.03 at $5/input mtok for claude-opus-5) this turn'),
    true,
  );
  assert.equal(
    hasSavingsTally(
      '🌱 graft saved ~5,548 tokens (the savings in dollars cannot be estimated because ' +
        "graft has no info about claude-opus-6's price per input mtok) this turn",
    ),
    true,
  );
});

test('setPricing refuses a rate that would render as $NaN', () => {
  withEnvRate(null, () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      setPricing({ rate: { usdPerMtok: bad, measured: true }, model: certain('claude-opus-5') });
      // The unpriced branch mentions `$` in its "set a model" hint, so the check
      // is for a rendered FIGURE, not for the character.
      assert.doesNotMatch(footer(), /worth \$[\d.]|~\$0/, `rate ${bad} must price nothing`);
    }
  });
  setPricing(null);
});

test('a cleared rate keeps the model, so the unpriced wording can still name it', () => {
  // The whole point of carrying the model alongside the rate: "we cannot price
  // this" is only actionable if it says WHICH model went unpriced.
  withEnvRate(null, () => {
    setPricing({ rate: { usdPerMtok: Number.NaN, measured: true }, model: certain('claude-opus-6') });
    assert.match(footer(), /graft has no info about claude-opus-6's price per input mtok/);
  });
  setPricing(null);
});
