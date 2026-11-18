import "./isolate.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { defaultProfileStoreRoot, profileStoreRoot } from "../src/context/profile-store.js";
import { executeMove, formatBytes, runLocationCommand, sizeOnDisk, storeFolders, type DiskSpace, type LocationDeps } from "../src/context/store-location.js";
import type { UserEnvStore } from "../src/ai/llm-settings.js";

/** A repo folder as the profile store writes it: a map, settings and the repo note. */
function storeFolder(root: string, name: string, bytes = 100): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "graph", ".cache"), { recursive: true });
  writeFileSync(join(dir, "graph", "node.md"), "x".repeat(bytes));
  writeFileSync(join(dir, "config.json"), "{}");
  writeFileSync(join(dir, "repo.json"), JSON.stringify({ root: join(root, "..", "checkouts", name) }));
  return dir;
}

interface Harness {
  home: string;
  deps: LocationDeps;
  out: string[];
  err: string[];
  saved: Map<string, string>;
}

/**
 * A scratch home and deps. `otherDrive` makes every folder look like it is on
 * another drive than the destination, with `free` bytes free there.
 */
function harness(opts: { otherDrive?: boolean; free?: number; env?: NodeJS.ProcessEnv } = {}): Harness {
  const home = tmpRepo("store-location");
  const out: string[] = [];
  const err: string[] = [];
  const saved = new Map<string, string>();
  const store: UserEnvStore = {
    where: "test store",
    read: (n) => saved.get(n),
    write: (n, v) => (v === undefined ? saved.delete(n) : saved.set(n, v)),
  };
  const space = (dir: string): DiskSpace => {
    let at = dir;
    while (!existsSync(at)) at = join(at, "..");
    return { at, free: opts.free ?? 1e12, blockSize: 4096, dev: opts.otherDrive ? -1 : statSync(home).dev };
  };
  const deps: LocationDeps = {
    env: { ...(opts.env ?? {}) },
    home,
    cwd: home,
    platform: process.platform,
    store,
    space,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { home, deps, out, err, saved };
}

const settings = (home: string) => {
  try {
    return JSON.parse(readFileSync(join(home, ".graft", "settings.json"), "utf8"));
  } catch {
    return null;
  }
};

test("files location: without a folder shows the current location", () => {
  const h = harness();
  storeFolder(defaultProfileStoreRoot(h.home), "app-111");
  assert.equal(runLocationCommand(undefined, {}, h.deps), 0);
  assert.match(h.out.join("\n"), new RegExp(`location: ${defaultProfileStoreRoot(h.home).replace(/\\/g, "\\\\")}`));
  assert.match(h.out.join("\n"), /1 repo folder/);
});

test("files location: moves every repo folder, keeping its name, and saves the location", () => {
  const h = harness();
  const old = defaultProfileStoreRoot(h.home);
  storeFolder(old, "app-111");
  storeFolder(old, "lib-222");
  mkdirSync(join(old, "not-a-repo-folder"));
  const target = join(h.home, "maps");

  assert.equal(runLocationCommand(target, {}, h.deps), 0, h.err.join("\n"));
  assert.deepEqual(storeFolders(target), ["app-111", "lib-222"]);
  assert.ok(existsSync(join(target, "app-111", "graph", "node.md")));
  assert.deepEqual(storeFolders(old), []);
  assert.ok(existsSync(join(old, "not-a-repo-folder")), "only repo folders move");
  assert.equal(settings(h.home)?.profileStore, target);
  assert.equal(profileStoreRoot({}, h.home), target, "every repo, new ones too, now resolves under the new location");
  assert.ok(!existsSync(join(target, "app-111", "graph", ".cache", ".sync.lock")), "the move's lock is released");
});

test("files location: relative folders and ~ are made absolute", () => {
  const h = harness();
  storeFolder(defaultProfileStoreRoot(h.home), "app-111");
  assert.equal(runLocationCommand("~/elsewhere", {}, h.deps), 0, h.err.join("\n"));
  assert.equal(settings(h.home)?.profileStore, join(h.home, "elsewhere"));
  assert.deepEqual(storeFolders(join(h.home, "elsewhere")), ["app-111"]);
});

test("files location: refuses with nothing moved when another drive lacks the space", () => {
  const h = harness({ otherDrive: true, free: 10_000 });
  const old = defaultProfileStoreRoot(h.home);
  storeFolder(old, "app-111", 50_000);
  const target = join(h.home, "maps");

  assert.equal(runLocationCommand(target, {}, h.deps), 1);
  assert.match(h.err.join("\n"), /not enough space/);
  assert.match(h.err.join("\n"), /Nothing was moved/);
  assert.deepEqual(storeFolders(old), ["app-111"]);
  assert.ok(!existsSync(target));
  assert.equal(settings(h.home), null, "the location is not changed");
});

test("files location: copies from another drive when there is room, then removes the original", () => {
  const h = harness({ otherDrive: true, free: 1e9 });
  const old = defaultProfileStoreRoot(h.home);
  storeFolder(old, "app-111", 5_000);
  const target = join(h.home, "maps");

  assert.equal(runLocationCommand(target, {}, h.deps), 0, h.err.join("\n"));
  assert.match(h.out.join("\n"), /1 copied from another drive/);
  assert.equal(readFileSync(join(target, "app-111", "graph", "node.md"), "utf8").length, 5_000);
  assert.ok(!existsSync(join(old, "app-111")));
});

test("files location: originals are deleted only after every folder was copied; a failed copy puts everything back", () => {
  const h = harness({ otherDrive: true });
  const old = defaultProfileStoreRoot(h.home);
  storeFolder(old, "app-111", 5_000);
  storeFolder(old, "lib-222", 5_000);
  storeFolder(old, "zed-333", 5_000);
  const target = join(h.home, "maps");
  // Room while planning and for the first copy, then the drive is full.
  let asked = 0;
  const roomy = h.deps.space!;
  h.deps.space = (dir) => ({ ...roomy(dir), free: ++asked <= 2 ? 1e9 : 0 });

  assert.equal(runLocationCommand(target, {}, h.deps), 1);
  assert.match(h.err.join("\n"), /not enough space left/);
  assert.match(h.err.join("\n"), /Everything was put back/);
  assert.deepEqual(storeFolders(old), ["app-111", "lib-222", "zed-333"], "no original was deleted");
  assert.equal(readFileSync(join(old, "app-111", "graph", "node.md"), "utf8").length, 5_000);
  assert.deepEqual(storeFolders(target), [], "the copy that had arrived was removed again");
  assert.equal(settings(h.home), null, "the location is not changed");
  assert.ok(!existsSync(join(old, "app-111", "graph", ".cache", ".sync.lock")), "the locks are released");
});

test("executeMove: renames only after all copies, and undoes copies and renames when a rename fails", () => {
  const h = harness();
  const old = defaultProfileStoreRoot(h.home);
  const a = storeFolder(old, "app-111");
  const b = storeFolder(old, "lib-222");
  const c = storeFolder(old, "zed-333");
  const target = join(h.home, "maps");
  mkdirSync(target);
  writeFileSync(join(h.home, "blocker"), "a file where a folder is needed");
  let committed = false;
  const result = executeMove(
    [
      { name: "app-111", from: a, to: join(target, "app-111"), sameDrive: false, bytes: 0, conflict: false },
      { name: "lib-222", from: b, to: join(target, "lib-222"), sameDrive: true, bytes: 0, conflict: false },
      { name: "zed-333", from: c, to: join(h.home, "blocker", "zed-333"), sameDrive: true, bytes: 0, conflict: false },
    ],
    () => (committed = true),
    h.deps.space,
  );
  assert.equal(result.ok, false);
  assert.equal(committed, false, "the location is saved only when every folder arrived");
  assert.deepEqual(storeFolders(old), ["app-111", "lib-222", "zed-333"], "the renamed folder came back, the copied one was never deleted");
  assert.deepEqual(storeFolders(target), []);
});

test("executeMove: deletes the copied originals only after saving the location", () => {
  const h = harness();
  const old = defaultProfileStoreRoot(h.home);
  const a = storeFolder(old, "app-111");
  const b = storeFolder(old, "lib-222");
  const target = join(h.home, "maps");
  let seenAtCommit: string[] = [];
  const result = executeMove(
    [
      { name: "app-111", from: a, to: join(target, "app-111"), sameDrive: false, bytes: 0, conflict: false },
      { name: "lib-222", from: b, to: join(target, "lib-222"), sameDrive: false, bytes: 0, conflict: false },
    ],
    () => (seenAtCommit = storeFolders(old)),
    h.deps.space,
  );
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.deepEqual(seenAtCommit, ["app-111", "lib-222"], "both originals still there when everything had been copied");
  assert.deepEqual(storeFolders(old), []);
  assert.deepEqual(storeFolders(target), ["app-111", "lib-222"]);
});

test("files location: --dry-run reports the plan and changes nothing", () => {
  const h = harness();
  const old = defaultProfileStoreRoot(h.home);
  storeFolder(old, "app-111");
  const target = join(h.home, "maps");
  assert.equal(runLocationCommand(target, { dryRun: true }, h.deps), 0);
  assert.match(h.out.join("\n"), /move {2}.*app-111/);
  assert.match(h.out.join("\n"), /dry run/);
  assert.deepEqual(storeFolders(old), ["app-111"]);
  assert.equal(settings(h.home), null);
});

test("files location: refuses a destination inside the current location", () => {
  const h = harness();
  const old = defaultProfileStoreRoot(h.home);
  storeFolder(old, "app-111");
  assert.equal(runLocationCommand(join(old, "sub"), {}, h.deps), 1);
  assert.match(h.err.join("\n"), /is inside/);
  assert.deepEqual(storeFolders(old), ["app-111"]);
});

test("files location: refuses while a build is running in one of the folders", () => {
  const h = harness();
  const old = defaultProfileStoreRoot(h.home);
  const dir = storeFolder(old, "app-111");
  writeFileSync(join(dir, "graph", ".cache", ".sync.lock"), JSON.stringify({ pid: 999_999, at: new Date().toISOString() }));
  assert.equal(runLocationCommand(join(h.home, "maps"), {}, h.deps), 1);
  assert.match(h.err.join("\n"), /a build is running/);
  assert.deepEqual(storeFolders(old), ["app-111"]);
});

test("files location: a folder already at the destination is kept, the old one left in place", () => {
  const h = harness();
  const old = defaultProfileStoreRoot(h.home);
  storeFolder(old, "app-111", 10);
  storeFolder(old, "lib-222");
  const target = join(h.home, "maps");
  storeFolder(target, "app-111", 20);

  assert.equal(runLocationCommand(target, {}, h.deps), 0, h.err.join("\n"));
  assert.equal(readFileSync(join(target, "app-111", "graph", "node.md"), "utf8").length, 20);
  assert.ok(existsSync(join(old, "app-111")));
  assert.deepEqual(storeFolders(target), ["app-111", "lib-222"]);
  assert.match(h.out.join("\n"), /already exists/);
});

test("files location: --default moves everything back and removes the setting", () => {
  const h = harness();
  const custom = join(h.home, "maps");
  mkdirSync(join(h.home, ".graft"), { recursive: true });
  writeFileSync(join(h.home, ".graft", "settings.json"), JSON.stringify({ profileStore: custom, deepStaleThreshold: 7 }));
  storeFolder(custom, "app-111");

  assert.equal(runLocationCommand(undefined, { default: true }, h.deps), 0, h.err.join("\n"));
  assert.deepEqual(storeFolders(defaultProfileStoreRoot(h.home)), ["app-111"]);
  assert.deepEqual(settings(h.home), { deepStaleThreshold: 7 }, "only profileStore is removed");
  assert.ok(!existsSync(custom), "the emptied custom location is removed");
});

test("files location: moves from a saved GRAFT_PROFILE_STORE folder and removes the variable", () => {
  const h = harness();
  const viaEnv = join(h.home, "env-maps");
  h.saved.set("GRAFT_PROFILE_STORE", viaEnv);
  storeFolder(viaEnv, "app-111");
  storeFolder(defaultProfileStoreRoot(h.home), "lib-222");
  const target = join(h.home, "maps");

  assert.equal(runLocationCommand(target, {}, h.deps), 0, h.err.join("\n"));
  assert.deepEqual(storeFolders(target), ["app-111", "lib-222"]);
  assert.ok(!h.saved.has("GRAFT_PROFILE_STORE"));
  assert.match(h.out.join("\n"), /removed the saved GRAFT_PROFILE_STORE/);
});

test("files location: warns when this terminal's GRAFT_PROFILE_STORE overrides the setting", () => {
  const h = harness({ env: { GRAFT_PROFILE_STORE: "off" } });
  storeFolder(defaultProfileStoreRoot(h.home), "app-111");
  assert.equal(runLocationCommand(join(h.home, "maps"), {}, h.deps), 0, h.err.join("\n"));
  assert.match(h.out.join("\n"), /GRAFT_PROFILE_STORE=off is set in this terminal/);
});

test("files location: a folder and --default together are refused", () => {
  const h = harness();
  assert.equal(runLocationCommand("x", { default: true }, h.deps), 1);
});

test("sizeOnDisk rounds every file up to whole blocks; formatBytes reads", () => {
  const h = harness();
  const dir = storeFolder(h.home, "app-111", 1);
  // folders: app-111, graph, graph/.cache (3 blocks) + files node.md, config.json, repo.json (3 blocks)
  assert.equal(sizeOnDisk(dir, 4096), 6 * 4096);
  assert.equal(formatBytes(512), "512 bytes");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(300 * 1024 * 1024), "300 MB");
});
