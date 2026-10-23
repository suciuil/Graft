/**
 * `graft where`: names where a repo's map and settings are kept, the profile
 * store above all, and lists the store's folders with the repo each belongs to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { profileRepoDir } from "../src/context/profile-store.js";
import { formatStoreFolders, formatWhereReport, listStoreFolders, whereFor, whereReport } from "../src/context/where.js";

const env = (store: string): NodeJS.ProcessEnv => ({ GRAFT_PROFILE_STORE: store });

/** Run with the store env set, as the CLI reads it, restoring it after. */
function withStore<T>(store: string, fn: () => T): T {
  const prev = process.env.GRAFT_PROFILE_STORE;
  const prevDir = process.env.GRAFT_DIR;
  process.env.GRAFT_PROFILE_STORE = store;
  delete process.env.GRAFT_DIR;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.GRAFT_PROFILE_STORE;
    else process.env.GRAFT_PROFILE_STORE = prev;
    if (prevDir !== undefined) process.env.GRAFT_DIR = prevDir;
  }
}

test("a fresh repo: map and settings both in its store folder, neither made yet", () => {
  const store = tmpRepo("where-store");
  const repo = tmpRepo("where-fresh");
  withStore(store, () => {
    const e = whereFor(repo, undefined, env(store));
    const dir = profileRepoDir(repo, store);
    assert.equal(e.storeDir, dir);
    assert.deepEqual(e.map, { path: join(dir, "graph"), source: "profile store", built: false });
    assert.deepEqual(e.settings, { path: join(dir, "config.json"), source: "profile store", exists: false });
    const out = formatWhereReport({ storeRoot: store, entries: [e] });
    assert.match(out, new RegExp(`store: +${dir.replace(/\\/g, "\\\\")}`));
    assert.match(out, /not built yet/);
  });
});

test("a repo with graft/ and .graft/config.json: both inside the repo, no store folder", () => {
  const store = tmpRepo("where-store-in");
  const repo = tmpRepo("where-inrepo");
  mkdirSync(join(repo, "graft", ".graph"), { recursive: true });
  mkdirSync(join(repo, ".graft"), { recursive: true });
  writeFileSync(join(repo, ".graft", "config.json"), "{}");
  withStore(store, () => {
    const e = whereFor(repo, undefined, env(store));
    assert.equal(e.storeDir, null);
    assert.deepEqual(e.map, { path: join(repo, "graft"), source: "repo", built: true });
    assert.equal(e.settings.source, "repo");
    assert.equal(e.settings.exists, true);
  });
});

test("--dir is reported as the source of the map", () => {
  const store = tmpRepo("where-store-dir");
  const repo = tmpRepo("where-dir");
  const elsewhere = tmpRepo("where-elsewhere");
  withStore(store, () => assert.equal(whereFor(repo, elsewhere, env(store)).map.source, "--dir"));
});

test("a folder of git repos lists each repo after the folder itself", () => {
  const store = tmpRepo("where-store-ws");
  const ws = tmpRepo("where-ws");
  for (const c of ["b", "a"]) mkdirSync(join(ws, c, ".git"), { recursive: true });
  withStore(store, () => {
    const r = whereReport([ws], undefined, env(store));
    assert.deepEqual(r.entries.map((e) => e.child ?? ""), ["", "a", "b"]);
    assert.equal(r.storeRoot, store);
  });
});

test("--all lists store folders with their checkout, and marks a gone one", () => {
  const store = tmpRepo("where-store-all");
  const live = tmpRepo("where-live");
  const gone = tmpRepo("where-gone");
  for (const [root, built] of [[live, true], [gone, false]] as const) {
    const dir = profileRepoDir(root, store);
    mkdirSync(join(dir, "graph", built ? ".graph" : ""), { recursive: true });
    writeFileSync(join(dir, "repo.json"), JSON.stringify({ root }));
  }
  rmSync(gone, { recursive: true, force: true });
  mkdirSync(join(store, "stray"), { recursive: true });

  const folders = listStoreFolders(store);
  assert.equal(folders.length, 3);
  const byRoot = (r: string | null) => folders.find((f) => f.root === r)!;
  assert.equal(byRoot(live).rootExists, true);
  assert.equal(byRoot(live).built, true);
  assert.equal(byRoot(gone).rootExists, false);
  assert.equal(byRoot(null).dir, join(store, "stray"));

  const out = formatStoreFolders(store, folders);
  assert.match(out, /gone: the folder can be deleted/);
  assert.match(out, /unknown \(no repo\.json\)/);
  assert.match(formatStoreFolders(null, []), /off/);
});
