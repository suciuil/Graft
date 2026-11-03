/**
 * The test run's slack for the hooks' wall-clock limits (TRAIL_TEST_PROBE_SCALE):
 * only in a test home, and never under TRAIL_PERF=1, which times the real limits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { testTimeScale } from "../src/skills/probes.js";
import { tmpRepo } from "./helpers.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("the hook deadline gets the test run's slack only in a test home, and never under TRAIL_PERF", () => {
  const home = tmpRepo("time-scale");
  const testHome = { HOME: home, TRAIL_HOME: join(home, "trail-home") };
  withEnv({ TRAIL_TEST_PROBE_SCALE: "5", TRAIL_PERF: undefined }, () => {
    assert.equal(testTimeScale(testHome), 5);
    assert.equal(testTimeScale({ HOME: home }), 1, "the person's own home");
  });
  withEnv({ TRAIL_TEST_PROBE_SCALE: "50", TRAIL_PERF: undefined }, () => assert.equal(testTimeScale(testHome), 20));
  withEnv({ TRAIL_TEST_PROBE_SCALE: "5", TRAIL_PERF: "1" }, () => assert.equal(testTimeScale(testHome), 1));
  withEnv({ TRAIL_TEST_PROBE_SCALE: undefined, TRAIL_PERF: undefined }, () => assert.equal(testTimeScale(testHome), 1));
});
