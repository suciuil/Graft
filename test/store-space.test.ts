import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { defaultProfileStoreRoot, profileMapDirFor } from "../src/context/profile-store.js";
import { writeFingerprint } from "../src/graph/fingerprint.js";
import type { DiskSpace } from "../src/context/store-location.js";
import {
  C_DRIVE_MIN_FREE,
  checkStoreSpace,
  estimateMapBytes,
  MAP_BYTES_PER_FILE,
  MAP_BYTES_PER_SOURCE_BYTE,
  MIN_LEFT_FREE,
  onDriveC,
  SAFETY_FACTOR,
  storeLocationAdvice,
  storeSpaceAdvice,
  type PlannedMap,
} from "../src/context/store-space.js";

const GB = 1024 * 1024 * 1024;
const space = (at: string, free: number): DiskSpace => ({ at, free, blockSize: 4096, dev: 1 });
const map = (bytes: number, existing = 0, files = 1): PlannedMap => ({ files, bytes, existing });

test("store space: the map is estimated from the source bytes, with a floor per file", () => {
  assert.equal(estimateMapBytes(10, 1e9), 1e9 * MAP_BYTES_PER_SOURCE_BYTE);
  assert.equal(estimateMapBytes(1000, 10), 1000 * MAP_BYTES_PER_FILE);
  assert.equal(estimateMapBytes(0, 0), 0);
});

test("store space: drive C: is told only on Windows", () => {
  assert.ok(onDriveC("C:\\Users\\me\\.graft\\repos", "win32"));
  assert.ok(onDriveC("c:\\maps", "win32"));
  assert.ok(!onDriveC("D:\\maps", "win32"));
  assert.ok(!onDriveC("C:\\maps", "linux"));
});

test("store space: drive C: with less than 20 GB free suggests moving, whatever the build needs", () => {
  const c = checkStoreSpace("C:\\Users\\me\\.graft\\repos", space("C:\\Users\\me", C_DRIVE_MIN_FREE - 1), [map(1000)], "win32");
  assert.equal(c.reason, "c-drive");
  const lines = storeSpaceAdvice(c);
  assert.match(lines[0]!, /^⚠ graft keeps its generated files in C:\\Users\\me\\\.graft\\repos, on drive C:, where only /);
  assert.match(lines[0]!, /less than 20\.0 GB/);
  assert.match(lines.join("\n"), /`graft files location <folder>`/);
  assert.match(lines.join("\n"), /--dry-run/);
});

test("store space: drive C: with 20 GB or more free and room for the map says nothing", () => {
  const c = checkStoreSpace("C:\\maps", space("C:\\", C_DRIVE_MIN_FREE), [map(1000)], "win32");
  assert.equal(c.reason, null);
  assert.deepEqual(storeSpaceAdvice(c), []);
});

test("store space: the same free space off Windows is not a drive C: case", () => {
  const c = checkStoreSpace("/home/me/.graft/repos", space("/home/me", 5 * GB), [map(1000)], "linux");
  assert.equal(c.reason, null);
});

test("store space: another drive too small for the estimated map with a safe margin suggests moving", () => {
  const bytes = 100 * 1024 * 1024; // 100 MB of source: 1000 MB of map
  const estimate = estimateMapBytes(1, bytes);
  const needed = estimate * SAFETY_FACTOR + MIN_LEFT_FREE;
  const short = checkStoreSpace("D:\\maps", space("D:\\", needed - 1), [map(bytes)], "win32");
  assert.equal(short.reason, "space");
  assert.equal(short.needed, needed);
  const lines = storeSpaceAdvice(short);
  assert.match(lines[0]!, /^⚠ graft keeps its generated files in D:\\maps, where .* is free, which may not be enough for this build/);
  assert.match(lines.join("\n"), /estimated at about 1000 MB/);
  assert.match(lines.join("\n"), /`graft files location <folder>`/);

  assert.equal(checkStoreSpace("D:\\maps", space("D:\\", needed), [map(bytes)], "win32").reason, null);
});

test("store space: drive C: with 20 GB free is still told when the map would not fit", () => {
  const bytes = 2 * GB; // about 20 GB of map
  assert.equal(checkStoreSpace("C:\\maps", space("C:\\", 25 * GB), [map(bytes)], "win32").reason, "space");
});

test("store space: what the map being rebuilt already takes counts as room", () => {
  const bytes = 100 * 1024 * 1024;
  const estimate = estimateMapBytes(1, bytes);
  const free = estimate; // short by estimate + 1 GB without the old map
  assert.equal(checkStoreSpace("D:\\maps", space("D:\\", free), [map(bytes)], "win32").reason, "space");
  const rebuilt = checkStoreSpace("D:\\maps", space("D:\\", free), [map(bytes, estimate + MIN_LEFT_FREE)], "win32");
  assert.equal(rebuilt.reason, null);
  assert.match(storeSpaceAdvice({ ...rebuilt, reason: "space" }).join("\n"), /the map it replaces takes/);
});

test("store space: the maps of several roots add up", () => {
  const bytes = 100 * 1024 * 1024;
  const needed = estimateMapBytes(1, bytes) * SAFETY_FACTOR + MIN_LEFT_FREE;
  assert.equal(checkStoreSpace("D:\\maps", space("D:\\", needed), [map(bytes)], "win32").reason, null);
  assert.equal(checkStoreSpace("D:\\maps", space("D:\\", needed), [map(bytes), map(bytes)], "win32").reason, "space");
});

test("store space: a build whose map is in the store is told; the lines name the store's root", () => {
  const home = tmpRepo("store-space-home");
  const repo = tmpRepo("store-space-repo");
  const env = {};
  const mapDir = profileMapDirFor(repo, env, home)!;
  const lines = storeLocationAdvice([{ root: repo, mapDir }], undefined, {
    env,
    home,
    platform: "linux",
    space: (dir) => space(dir, 10 * 1024 * 1024),
    plan: () => ({ files: 10, bytes: 1_000_000 }),
  });
  assert.equal(lines.length, 3);
  assert.ok(lines[0]!.includes(defaultProfileStoreRoot(home)), lines[0]);
});

test("store space: a rebuild is sized from its last build's prints, not by walking the repo", () => {
  const home = tmpRepo("store-space-home");
  const repo = tmpRepo("store-space-repo");
  const env = {};
  const mapDir = profileMapDirFor(repo, env, home)!;
  // The repo on disk is empty: only the prints say 2 GB of source were indexed.
  const print = (size: number) => ({ size, mtimeMs: 1, hash: "h" }) as Parameters<typeof writeFingerprint>[1][string];
  assert.ok(writeFingerprint(mapDir, { "a.ts": print(GB), "b.ts": print(GB) }));
  const deps = { env, home, platform: "linux" as const, space: (dir: string) => space(dir, 5 * GB), existing: () => 0 };
  const lines = storeLocationAdvice([{ root: repo, mapDir }], undefined, deps);
  assert.match(lines.join("\n"), /estimated at about 20(\.0)? GB/);
  // Prints of a build limited to other folders say nothing about this one: the repo is walked.
  assert.deepEqual(storeLocationAdvice([{ root: repo, mapDir }], ["src"], deps), []);
});

test("store space: a map inside the repo, or the store turned off, is not told", () => {
  const home = tmpRepo("store-space-home");
  const repo = tmpRepo("store-space-repo");
  const tight = {
    home,
    platform: "linux" as const,
    space: (dir: string) => space(dir, 1),
    plan: () => ({ files: 10, bytes: 1_000_000 }),
  };
  assert.deepEqual(storeLocationAdvice([{ root: repo, mapDir: join(repo, "graft") }], undefined, { ...tight, env: {} }), []);
  const mapDir = profileMapDirFor(repo, {}, home)!;
  assert.deepEqual(storeLocationAdvice([{ root: repo, mapDir }], undefined, { ...tight, env: { GRAFT_PROFILE_STORE: "0" } }), []);
});

test("store space: drive C: short of room is told without sizing the repo", () => {
  const home = tmpRepo("store-space-home");
  const repo = tmpRepo("store-space-repo");
  const env = { GRAFT_PROFILE_STORE: "C:\\graft-maps" };
  // The store named by an absolute Windows path only reads as absolute on Windows.
  if (process.platform !== "win32") return;
  const mapDir = profileMapDirFor(repo, env, home)!;
  let planned = 0;
  const lines = storeLocationAdvice([{ root: repo, mapDir }], undefined, {
    env,
    home,
    platform: "win32",
    space: () => space("C:\\", 5 * GB),
    plan: () => {
      planned++;
      return { files: 1, bytes: 1 };
    },
  });
  assert.equal(planned, 0);
  assert.match(lines[0]!, /on drive C:, where only 5\.0 GB is free/);
});

test("store space: the map being rebuilt is sized only when the build may be short of room", () => {
  const home = tmpRepo("store-space-home");
  const repo = tmpRepo("store-space-repo");
  const env = {};
  const mapDir = profileMapDirFor(repo, env, home)!;
  const bytes = 100 * 1024 * 1024;
  const estimate = estimateMapBytes(10, bytes);
  let sized = 0;
  const deps = (free: number, old: number) => ({
    env,
    home,
    platform: "linux" as const,
    space: (dir: string) => space(dir, free),
    plan: () => ({ files: 10, bytes }),
    existing: () => {
      sized++;
      return old;
    },
  });
  // Room to spare even with nothing freed: the old map is never walked.
  assert.deepEqual(storeLocationAdvice([{ root: repo, mapDir }], undefined, deps(estimate * SAFETY_FACTOR + MIN_LEFT_FREE, 0)), []);
  assert.equal(sized, 0);
  // Short unless the old map's room counts: it is sized, and then there is room.
  assert.deepEqual(storeLocationAdvice([{ root: repo, mapDir }], undefined, deps(estimate, estimate + MIN_LEFT_FREE)), []);
  assert.equal(sized, 1);
  // Short even then: told, with what the old map takes.
  const lines = storeLocationAdvice([{ root: repo, mapDir }], undefined, deps(estimate, 1024));
  assert.equal(sized, 2);
  assert.match(lines.join("\n"), /the map it replaces takes/);
});
