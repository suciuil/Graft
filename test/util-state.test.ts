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
  cacheDir,
  ensureDefaultBuildConfig,
  patchBuildConfig,
  readBuildConfig,
  readFollowSubmodules,
  readExcludeDirs,
  readIncludeDirs,
  resolveContextDir,
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

// ── resolveContextDir / GRAFT_DIR ──────────────────────────────────────────
//
// Everything in this module keyed only by a project dir (stats cache, sync
// lock, session state, the upkeep stamp) resolves its `graft/` subpath
// through resolveContextDir, so hooks/sync-run/statusline honor GRAFT_DIR
// the same way a direct `--dir` CLI call already does via contextDirFor.

function withGraftDir<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.GRAFT_DIR;
  if (value === undefined) delete process.env.GRAFT_DIR; else process.env.GRAFT_DIR = value;
  try { return fn(); }
  finally { if (prev === undefined) delete process.env.GRAFT_DIR; else process.env.GRAFT_DIR = prev; }
}

test("resolveContextDir defaults to <projectDir>/graft when GRAFT_DIR is unset", () => {
  const d = fresh();
  withGraftDir(undefined, () => {
    assert.equal(resolveContextDir(d), join(d, "graft"));
    assert.equal(cacheDir(d), join(d, "graft", ".cache"));
  });
});

test("resolveContextDir resolves a relative GRAFT_DIR against projectDir", () => {
  const d = fresh();
  withGraftDir(".repo-docs/graft", () => {
    assert.equal(resolveContextDir(d), join(d, ".repo-docs", "graft"));
    assert.equal(cacheDir(d), join(d, ".repo-docs", "graft", ".cache"));
  });
});

test("resolveContextDir takes an absolute GRAFT_DIR verbatim", () => {
  const d = fresh();
  const abs = join(tmpdir(), "graft-context-elsewhere");
  withGraftDir(abs, () => {
    assert.equal(resolveContextDir(d), abs);
    assert.equal(cacheDir(d), join(abs, ".cache"));
  });
});

test("a `model` left in an old config is preserved on disk but never read", () => {
  // The field was removed from the schema, not from users' files. Rewriting a
  // file the user owns to delete a key is worse than ignoring the key.
  const d = fresh();
  writeBuildConfig(d, { model: "claude-3.7-sonnet" } as Record<string, unknown>);
  ensureDefaultBuildConfig(d);
  assert.equal(
    (readBuildConfig(d) as Record<string, unknown>).model,
    "claude-3.7-sonnet",
    "the stale value survives a top-up",
  );
  // ...and the scaffold no longer offers the key to anyone new.
  assert.ok(!("model" in (pendingKeys(fresh()) ?? {})), "a fresh scaffold has no model field");
});

/** The keys `ensureDefaultBuildConfig` would write into a virgin repo. */
function pendingKeys(d: string): Record<string, unknown> | null {
  ensureDefaultBuildConfig(d);
  return readBuildConfig(d) as Record<string, unknown> | null;
}
