import { test } from "node:test";
import assert from "node:assert/strict";
import {
  kitFileName,
  kitVersion,
  latestKitInChangelog,
  nextKitBuild,
  parseKitName,
  parseKitRecord,
  parseKitVersion,
} from "../scripts/kit-build.mjs";
import { stampChangelog } from "../scripts/stamp-changelog.mjs";

test("parseKitVersion splits a kit version into package version and build", () => {
  assert.deepEqual(parseKitVersion("0.28.0.3"), { version: "0.28.0", build: 3 });
  assert.deepEqual(parseKitVersion(kitVersion("1.2.3-beta.1", 5)), { version: "1.2.3-beta.1", build: 5 });
  assert.equal(parseKitVersion("0.28.0"), null);
});

test("parseKitRecord accepts only a semver version and a build of 0 or more", () => {
  assert.deepEqual(parseKitRecord('{"version":"0.28.0","build":2,"kit":"graft-0.28.0.2-win-x64.zip"}'), { version: "0.28.0", build: 2 });
  assert.deepEqual(parseKitRecord('{"version":"0.28.0","build":0}'), { version: "0.28.0", build: 0 });
  assert.equal(parseKitRecord('{"version":"0.28.0","build":-1}'), null);
  assert.equal(parseKitRecord('{"version":"0.28.0","build":1.5}'), null);
  assert.equal(parseKitRecord('{"version":"0.28.0","build":"2"}'), null);
  assert.equal(parseKitRecord('{"build":2}'), null);
  assert.throws(() => parseKitRecord("{not json"));
});

test("latestKitInChangelog finds the newest build group named by a kit version", () => {
  const page =
    '<section id="changes">\n<div class="group" data-group="pending">\n  <ul>\n<!-- pending:start -->\n<li data-type="fix" data-area="cli">x</li>\n<!-- pending:end -->\n  </ul>\n</div>\n<!-- groups:start -->\n' +
    '\n<div class="group" data-group="bundle" data-date="2026-10-01" data-version="0.27.0">\n</div>\n</section>';
  assert.equal(latestKitInChangelog(page), null);
  const once = stampChangelog(page, { date: "2026-11-04", version: kitVersion("0.28.0", 0) }).html;
  const twice = stampChangelog(once.replace("<!-- pending:end -->", '<li data-type="fix" data-area="cli">y</li>\n<!-- pending:end -->'), {
    date: "2026-11-05",
    version: kitVersion("0.28.0", 1),
  }).html;
  assert.deepEqual(latestKitInChangelog(once), { version: "0.28.0", build: 0 });
  assert.deepEqual(latestKitInChangelog(twice), { version: "0.28.0", build: 1 });
});

test("kitVersion puts the build number after a.b.c, before a prerelease suffix", () => {
  assert.equal(kitVersion("0.28.0", 0), "0.28.0.0");
  assert.equal(kitVersion("0.28.0", 1), "0.28.0.1");
  assert.equal(kitVersion("0.28.0", 12), "0.28.0.12");
  assert.equal(kitVersion("0.28.0-beta.1", 2), "0.28.0.2-beta.1");
  assert.throws(() => kitVersion("0.28", 1));
});

test("kitFileName names the kit graft-a.b.c.d-win-<arch>.zip", () => {
  assert.equal(kitFileName("0.28.0", 3, "x64"), "graft-0.28.0.3-win-x64.zip");
  assert.equal(kitFileName("0.28.0", 0, "x64"), "graft-0.28.0.0-win-x64.zip");
  assert.equal(kitFileName("1.0.0-rc.1", 1, "arm64"), "graft-1.0.0.1-rc.1-win-arm64.zip");
});

test("parseKitName reads version and build back, and ignores kits without a build number", () => {
  assert.deepEqual(parseKitName("graft-0.28.0.3-win-x64.zip", "x64"), { version: "0.28.0", build: 3 });
  assert.deepEqual(parseKitName("graft-0.28.0.0-win-x64.zip", "x64"), { version: "0.28.0", build: 0 });
  assert.deepEqual(parseKitName("graft-0.28.0.2-beta.1-win-x64 - Copy.zip", "x64"), { version: "0.28.0-beta.1", build: 2 });
  assert.equal(parseKitName("graft-0.28.0-win-x64.zip", "x64"), null);
  assert.equal(parseKitName("graft-0.28.0.3-win-arm64.zip", "x64"), null);
  assert.equal(parseKitName("node-v26.13.0-win-x64.zip", "x64"), null);
  for (const [v, b] of [["0.28.0", 7], ["2.0.0-beta.3", 4]] as const) {
    assert.deepEqual(parseKitName(kitFileName(v, b, "x64"), "x64"), { version: v, build: b });
  }
});

test("nextKitBuild counts up for the same graft version and restarts at 0 for another", () => {
  assert.equal(nextKitBuild("0.28.0", null), 0);
  assert.equal(nextKitBuild("0.28.0", { version: "0.28.0", build: 0 }), 1);
  assert.equal(nextKitBuild("0.28.0", { version: "0.28.0", build: 1 }), 2);
  assert.equal(nextKitBuild("0.28.0", { version: "0.28.0", build: 9 }), 10);
  assert.equal(nextKitBuild("0.29.0", { version: "0.28.0", build: 9 }), 0);
  assert.equal(nextKitBuild("0.28.0", { version: "0.28.0-beta.1", build: 4 }), 0);
  assert.equal(nextKitBuild("0.28.0", { version: "0.28.0", build: -1 }), 0);
});
