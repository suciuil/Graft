/**
 * Persisted local build configuration.
 *
 * Explicit directory and submodule choices must survive later no-flag builds
 * and the hooks/refresh path, which never sees CLI flags. These tests pin the
 * round-trip and merge contracts independently of the CLI wiring.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConfigPath,
  patchBuildConfig,
  readBuildConfig,
  readFollowSubmodules,
  readExcludeDirs,
  readIncludeDirs,
  writeBuildConfig,
} from "../src/util/state.js";

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "graft-buildconfig-"));
}

test("readBuildConfig returns null when nothing was ever persisted", () => {
  const d = fresh();
  assert.equal(readBuildConfig(d), null);
  assert.equal(readIncludeDirs(d), undefined, "no persisted config -> today's default (no includes)");
  assert.equal(readFollowSubmodules(d), false, "no persisted config -> historical submodule boundary");
});

test("writeBuildConfig + readBuildConfig round-trip includeDirs", () => {
  const d = fresh();
  writeBuildConfig(d, { includeDirs: ["build", "vendor"] });
  assert.deepEqual(readBuildConfig(d), { includeDirs: ["build", "vendor"] });
  assert.equal(buildConfigPath(d), join(d, ".graft", "config.json"));
  assert.equal(existsSync(join(d, "graft", ".cache", "config.json")), false);
  assert.match(readFileSync(join(d, ".gitignore"), "utf8"), /^\/\.graft\/$/m);
});

test("readIncludeDirs turns a persisted list into a Set; an empty persisted list reads as undefined (default behavior)", () => {
  const d = fresh();
  writeBuildConfig(d, { includeDirs: ["build"] });
  assert.deepEqual(readIncludeDirs(d), new Set(["build"]));

  writeBuildConfig(d, { includeDirs: [] });
  assert.equal(readIncludeDirs(d), undefined, "an empty list must read exactly like no list at all");
});

test("readExcludeDirs turns a persisted list into a Set; an empty list reads as undefined", () => {
  const d = fresh();
  writeBuildConfig(d, { excludeDirs: ["Documents", "themes"] });
  assert.deepEqual(readExcludeDirs(d), new Set(["Documents", "themes"]));

  writeBuildConfig(d, { excludeDirs: [] });
  assert.equal(readExcludeDirs(d), undefined, "an empty list must read exactly like no list at all");
});

// The two lists are independent knobs on one file, and a user edits
// .graft/config.json by hand as well — persisting one must not disturb the other.
test("includeDirs and excludeDirs coexist in one config", () => {
  const d = fresh();
  writeBuildConfig(d, { includeDirs: ["build"] });
  patchBuildConfig(d, { excludeDirs: ["Documents"] });
  assert.deepEqual(readBuildConfig(d), { includeDirs: ["build"], excludeDirs: ["Documents"] });
  assert.deepEqual(readIncludeDirs(d), new Set(["build"]));
  assert.deepEqual(readExcludeDirs(d), new Set(["Documents"]));
});

test("followSubmodules round-trips true and explicit false", () => {
  const d = fresh();
  writeBuildConfig(d, { followSubmodules: true });
  assert.equal(readFollowSubmodules(d), true);

  writeBuildConfig(d, { followSubmodules: false });
  assert.deepEqual(readBuildConfig(d), { followSubmodules: false });
  assert.equal(readFollowSubmodules(d), false);
});

test("patchBuildConfig preserves unrelated persisted build choices", () => {
  const d = fresh();
  writeBuildConfig(d, { includeDirs: ["build"] });
  patchBuildConfig(d, { followSubmodules: true });
  assert.deepEqual(readBuildConfig(d), {
    includeDirs: ["build"],
    followSubmodules: true,
  });

  patchBuildConfig(d, { includeDirs: ["vendor"] });
  assert.deepEqual(readBuildConfig(d), {
    includeDirs: ["vendor"],
    followSubmodules: true,
  });

  patchBuildConfig(d, { followSubmodules: false });
  assert.deepEqual(readBuildConfig(d), {
    includeDirs: ["vendor"],
    followSubmodules: false,
  });
});
