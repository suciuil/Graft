/**
 * The profile store: with it on, a repo with no map or settings inside it gets
 * them in the user's profile, keyed by the repo's path. A map or settings file
 * already in the repo always wins, and with the store off nothing changes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { mapDirFor } from "../src/context/map-dir.js";
import { contextDirFor, ensureGitignored, ensureSearchable } from "../src/context/node-file.js";
import {
  anyProfileMapDirFor,
  defaultProfileStoreRoot,
  isOutside,
  profileConfigPathFor,
  profileMapDirFor,
  profileRepoDir,
  profileStoreRoot,
} from "../src/context/profile-store.js";
import { buildConfigPath, ensureDefaultBuildConfig, patchBuildConfig, readBuildConfig, repoBuildConfigPath, resolveContextDir } from "../src/util/state.js";
import { ledgerCandidates } from "../src/claude/repo-registry.js";

/** Run `fn` with the store pointed at `store` (or off, for `"0"`), restoring the env after. */
function withStore<T>(store: string | undefined, fn: () => T): T {
  const prev = process.env.GRAFT_PROFILE_STORE;
  const prevDir = process.env.GRAFT_DIR;
  delete process.env.GRAFT_DIR;
  if (store === undefined) delete process.env.GRAFT_PROFILE_STORE;
  else process.env.GRAFT_PROFILE_STORE = store;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.GRAFT_PROFILE_STORE;
    else process.env.GRAFT_PROFILE_STORE = prev;
    if (prevDir === undefined) delete process.env.GRAFT_DIR;
    else process.env.GRAFT_DIR = prevDir;
  }
}

test("on by default at ~/.graft/repos: nothing set, an empty env value, or a relative folder all fall to the default", () => {
  const home = tmpRepo("ps-home-default");
  assert.equal(profileStoreRoot({}, home), defaultProfileStoreRoot(home));
  assert.equal(profileStoreRoot({ GRAFT_PROFILE_STORE: "" }, home), defaultProfileStoreRoot(home));
  assert.equal(profileStoreRoot({ GRAFT_PROFILE_STORE: "relative/dir" }, home), defaultProfileStoreRoot(home));
});

test("off through the env (0) or ~/.graft/settings.json (false); a folder moves it; the env wins both ways", () => {
  const home = tmpRepo("ps-home-switch");
  assert.equal(profileStoreRoot({ GRAFT_PROFILE_STORE: "0" }, home), null);
  assert.equal(profileStoreRoot({ GRAFT_PROFILE_STORE: "1" }, home), defaultProfileStoreRoot(home));
  const elsewhere = tmpRepo("ps-elsewhere");
  assert.equal(profileStoreRoot({ GRAFT_PROFILE_STORE: elsewhere }, home), elsewhere);

  mkdirSync(join(home, ".graft"), { recursive: true });
  writeFileSync(join(home, ".graft", "settings.json"), JSON.stringify({ profileStore: false }));
  assert.equal(profileStoreRoot({}, home), null, "the setting turns it off");
  assert.equal(profileStoreRoot({ GRAFT_PROFILE_STORE: "on" }, home), defaultProfileStoreRoot(home), "the env turns a setting back on");

  writeFileSync(join(home, ".graft", "settings.json"), JSON.stringify({ profileStore: elsewhere }));
  assert.equal(profileStoreRoot({}, home), elsewhere);
  assert.equal(profileStoreRoot({ GRAFT_PROFILE_STORE: "off" }, home), null, "the env turns a setting off");

  writeFileSync(join(home, ".graft", "settings.json"), "{ not json");
  assert.equal(profileStoreRoot({}, home), defaultProfileStoreRoot(home), "an unreadable settings file leaves the default");
});

test("the home folder used as a repo keeps graft/: a store under ~/.graft/repos would be inside it", () => {
  const home = tmpRepo("ps-home-as-repo");
  assert.equal(profileMapDirFor(home, {}, home), null);
  assert.equal(profileConfigPathFor(home, {}, home), null);
  assert.ok(profileMapDirFor(tmpRepo("ps-other-repo"), {}, home), "any other repo still gets the store");
});

test("one store folder per repo path, named for a person and unique by hash; case-insensitive where the OS is", () => {
  const store = tmpRepo("ps-store-names");
  const a = tmpRepo("ps-repo-a");
  const b = tmpRepo("ps-repo-b");
  assert.notEqual(profileRepoDir(a, store), profileRepoDir(b, store));
  assert.equal(profileRepoDir(a, store), profileRepoDir(a, store));
  assert.match(profileRepoDir(a, store), /graft-ps-repo-a-[^-]+-[0-9a-f]{16}$/);
  if (process.platform === "win32") assert.equal(profileRepoDir(a.toUpperCase(), store), profileRepoDir(a, store));
});

test("a repo with no map gets one in the store; nothing is written into the repo by a build's ignore steps", () => {
  const store = tmpRepo("ps-store-map");
  const repo = tmpRepo("ps-fresh");
  withStore(store, () => {
    const dir = mapDirFor(repo);
    assert.equal(dir, join(profileRepoDir(repo, store), "graph"));
    assert.equal(contextDirFor(repo), dir);
    assert.equal(resolveContextDir(repo), dir, "the hooks, statusline and caches agree");
    assert.equal(profileMapDirFor(repo), dir);
    ensureGitignored(repo, dir);
    ensureSearchable(repo, dir);
    assert.equal(existsSync(join(repo, ".gitignore")), false);
    assert.equal(existsSync(join(repo, ".ignore")), false);
  });
});

test("a map already in graft/ wins over the store, so turning it on moves nothing", () => {
  const store = tmpRepo("ps-store-keep");
  const repo = tmpRepo("ps-has-map");
  mkdirSync(join(repo, "graft", ".graph"), { recursive: true });
  withStore(store, () => assert.equal(mapDirFor(repo), join(repo, "graft")));
});

test("an explicit --dir or GRAFT_DIR still wins over the store", () => {
  const store = tmpRepo("ps-store-override");
  const repo = tmpRepo("ps-override");
  withStore(store, () => {
    assert.equal(contextDirFor(repo, "/elsewhere"), "/elsewhere");
    process.env.GRAFT_DIR = "ctx";
    assert.equal(resolveContextDir(repo), join(repo, "ctx"));
  });
});

test("with the store off, the map is graft/ as always", () => {
  const repo = tmpRepo("ps-off");
  withStore("0", () => assert.equal(mapDirFor(repo), join(repo, "graft")));
});

test("settings go to the store when the repo has no .graft/config.json, and never touch the repo's .gitignore", () => {
  const store = tmpRepo("ps-store-config");
  const repo = tmpRepo("ps-config");
  withStore(store, () => {
    const expected = join(profileRepoDir(repo, store), "config.json");
    assert.equal(buildConfigPath(repo), expected);
    assert.equal(profileConfigPathFor(repo), expected);
    assert.equal(ensureDefaultBuildConfig(repo), expected);
    patchBuildConfig(repo, { excludeDirs: ["themes"] });
    assert.deepEqual(readBuildConfig(repo)?.excludeDirs, ["themes"]);
    assert.ok(existsSync(expected));
    assert.equal(existsSync(repoBuildConfigPath(repo)), false, "no .graft/ in the repo");
    assert.equal(existsSync(join(repo, ".gitignore")), false, "no .gitignore entry for a file outside the repo");
    const note = JSON.parse(readFileSync(join(profileRepoDir(repo, store), "repo.json"), "utf8"));
    assert.equal(typeof note.root, "string", "the store folder names its checkout");
  });
});

test("a .graft/config.json already in the repo wins over the store", () => {
  const store = tmpRepo("ps-store-config-keep");
  const repo = tmpRepo("ps-config-keep");
  mkdirSync(join(repo, ".graft"), { recursive: true });
  writeFileSync(join(repo, ".graft", "config.json"), JSON.stringify({ followSubmodules: true }));
  withStore(store, () => {
    assert.equal(buildConfigPath(repo), repoBuildConfigPath(repo));
    assert.equal(readBuildConfig(repo)?.followSubmodules, true);
  });
});

test("the cross-repo savings list looks in the store too", () => {
  const store = tmpRepo("ps-store-ledger");
  const repo = tmpRepo("ps-ledger");
  withStore(store, () => {
    const c = ledgerCandidates({ root: repo, ledger: join(repo, "graft", ".cache", "savings.json"), firstSeen: "", lastSeen: "" });
    assert.ok(c.includes(join(anyProfileMapDirFor(repo), ".cache", "savings.json")));
  });
});

test("isOutside: a child is inside; a sibling, a parent and (on Windows) another drive are outside", () => {
  const repo = tmpRepo("ps-outside");
  assert.equal(isOutside(repo, join(repo, "graft")), false);
  assert.equal(isOutside(repo, join(repo, "..", "x")), true);
  assert.equal(isOutside(repo, join(repo, "..")), true);
  if (process.platform === "win32") {
    const other = repo.toUpperCase().startsWith("C:") ? "D:\\x" : "C:\\x";
    assert.equal(isOutside(repo, other), true);
  }
});
