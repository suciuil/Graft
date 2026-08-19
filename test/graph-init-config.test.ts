/**
 * `graft init` scaffolds `.graft/config.json` with every build option at its
 * default.
 *
 * The options were previously discoverable only through `graft build --help`, and
 * JSON cannot carry a comment to explain itself — so a repo had no visible place
 * to put an exclude list until someone knew the file existed. init writing it once
 * makes the settings self-evident; it must never overwrite an edited one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildConfigPath, ensureDefaultBuildConfig, readBuildConfig, readExcludeDirs } from "../src/util/state.js";

function freshRepo(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(d, "main.ts"), "export const x = 1;\n");
  return d;
}

/** init reports on STDERR, so both streams are captured — execFileSync would
 * return stdout alone and silently hide every line this test asserts on. */
function runInitCli(dir: string, extra: string[] = []): string {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "init", dir, "--no-agents", "--no-build", ...extra],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return (r.stdout ?? "") + (r.stderr ?? "");
}

test("graft init scaffolds .graft/config.json listing every build option at its default", () => {
  const d = freshRepo("graft-init-cfg-");
  try {
    runInitCli(d);
    const path = buildConfigPath(d);
    assert.ok(existsSync(path), "init must create .graft/config.json");

    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    // Every option a build reads, so the file answers "what can I configure?".
    assert.deepEqual(parsed.includeDirs, []);
    assert.deepEqual(parsed.excludeDirs, []);
    assert.equal(parsed.followSubmodules, false);
    assert.equal(typeof parsed["//"], "string", "a note, since JSON has no comments");

    // Defaults must be inert: an empty list has to read exactly like no list.
    assert.equal(readExcludeDirs(d), undefined, "an empty excludeDirs changes no behaviour");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("re-running init never overwrites an edited config", () => {
  const d = freshRepo("graft-init-keep-");
  try {
    runInitCli(d);
    writeFileSync(buildConfigPath(d), JSON.stringify({ excludeDirs: ["src/themes"] }, null, 2));

    runInitCli(d);
    assert.deepEqual(readBuildConfig(d), { excludeDirs: ["src/themes"] }, "the user's list survives a re-init");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("init --dry-run reports the config it would write, and writes nothing", () => {
  const d = freshRepo("graft-init-dry-");
  try {
    const out = runInitCli(d, ["--dry-run"]);
    assert.match(out, /would write .*config\.json/, "a dry run must not under-report what init writes");
    assert.equal(existsSync(buildConfigPath(d)), false, "dry run writes nothing");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("ensureDefaultBuildConfig returns the path it wrote, then null once it exists", () => {
  const d = freshRepo("graft-init-unit-");
  try {
    assert.equal(ensureDefaultBuildConfig(d), buildConfigPath(d), "first call writes");
    assert.equal(ensureDefaultBuildConfig(d), null, "second call leaves the file alone");
    // Written outside the generated graft/ cache, so deleting that cache — or
    // pointing --dir elsewhere — cannot take the repo's settings with it.
    assert.equal(existsSync(join(d, "graft", ".cache", "config.json")), false);
    assert.match(readFileSync(join(d, ".gitignore"), "utf8"), /^\/\.graft\/$/m);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a workspace init scaffolds a config in every child repo, not just the parent", () => {
  const parent = mkdtempSync(join(tmpdir(), "graft-init-ws-"));
  try {
    for (const child of ["a", "b"]) {
      mkdirSync(join(parent, child, ".git"), { recursive: true });
      writeFileSync(join(parent, child, "main.ts"), "export const x = 1;\n");
    }
    runInitCli(parent);
    // Each child is an independent repo, walked on its own — settings belong
    // where the walk happens, not only at the parent.
    for (const child of ["a", "b"]) {
      assert.ok(existsSync(buildConfigPath(join(parent, child))), `${child}/ must get its own config`);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
