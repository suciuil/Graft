/**
 * This fork keeps Trail's look-back and fetching OFF unless the person turns
 * them on with TRAIL_NO_LOOK_BACK=0 / TRAIL_NO_FETCH=0 (docs/no-cloud-policy.md).
 * Not a cloud-sending test: it checks that reaching out stays off by default,
 * so it runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchDisabled, lookBackDisabled } from "../src/util/privacy-switches.js";
import { lookBackOff } from "../src/init/look-back.js";

test("the look-back is off unless TRAIL_NO_LOOK_BACK is exactly 0", () => {
  assert.equal(lookBackDisabled({}), true, "unset: off (the default)");
  assert.equal(lookBackDisabled({ TRAIL_NO_LOOK_BACK: "" }), true, "empty: off");
  assert.equal(lookBackDisabled({ TRAIL_NO_LOOK_BACK: "1" }), true);
  assert.equal(lookBackDisabled({ TRAIL_NO_LOOK_BACK: "yes" }), true, "anything else: off");
  assert.equal(lookBackDisabled({ TRAIL_NO_LOOK_BACK: "0" }), false, "0 turns it on");
  assert.equal(lookBackOff({}), true, "trail init's own check agrees");
  assert.equal(lookBackOff({ TRAIL_NO_LOOK_BACK: "0" }), false);
});

test("fetching is off unless TRAIL_NO_FETCH is exactly 0, the same answer everywhere", () => {
  assert.equal(fetchDisabled({}), true, "unset: off (the default)");
  assert.equal(fetchDisabled({ TRAIL_NO_FETCH: "" }), true);
  assert.equal(fetchDisabled({ TRAIL_NO_FETCH: "1" }), true);
  assert.equal(fetchDisabled({ TRAIL_NO_FETCH: "true" }), true);
  assert.equal(fetchDisabled({ TRAIL_NO_FETCH: "0" }), false, "0 turns it on");
});

test("no source file reads the two variables except through privacy-switches.ts", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith("privacy-switches.ts")) {
        const text = readFileSync(p, "utf8");
        // A child's environment may still set "1" to keep it off; a read is what must go through the helpers.
        if (/env\.TRAIL_NO_(?:FETCH|LOOK_BACK)\b(?!\s*:)/.test(text) || /\[["']TRAIL_NO_(?:FETCH|LOOK_BACK)["']\]/.test(text)) offenders.push(p);
      }
    }
  };
  walk(join(process.cwd(), "src"));
  assert.deepEqual(offenders, [], "read them through lookBackDisabled() / fetchDisabled(), so the default stays off");
});
