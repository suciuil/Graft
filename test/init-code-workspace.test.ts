/**
 * `graft init` and VS Code `.code-workspace` files.
 *
 * A multi-root workspace opens each listed folder as its own root, and agents
 * read their instruction files from those roots — so when the init directory
 * holds a workspace file, its folders are what get wired. With several files,
 * the user picks one (or none: wire the directory itself, as before).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runCli, tmpRepo } from "./helpers.js";
import {
  describeCodeWorkspaces,
  findCodeWorkspaces,
  promptCodeWorkspace,
  readCodeWorkspaceFolders,
} from "../src/hosts/code-workspace.js";

/** A dir with `front`, `back` and `other` repos, plus the given workspace files. */
function fixture(tag: string, files: Record<string, string>): string {
  const dir = tmpRepo(tag);
  for (const child of ["front", "back", "other"]) {
    mkdirSync(join(dir, child, ".git"), { recursive: true });
    mkdirSync(join(dir, child, "src"), { recursive: true });
    writeFileSync(join(dir, child, "src", "main.ts"), `export function ${child}Main(): number {\n  return 1;\n}\n`);
  }
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const wired = (dir: string) => existsSync(join(dir, ".claude", "settings.json"));

const FRONT_BACK = `{
  // JSONC, as VS Code writes it
  "folders": [
    { "path": "front" },
    { "name": "api", "path": "./back" },
    { "path": "gone" },
  ],
  "settings": { "files.exclude": { "**/x": true } }
}`;

test("readCodeWorkspaceFolders resolves paths against the file, skips missing ones, tolerates JSONC", () => {
  const dir = fixture("cws-read", { "app.code-workspace": FRONT_BACK });
  const r = readCodeWorkspaceFolders(join(dir, "app.code-workspace"));
  assert.deepEqual(r.folders, [join(dir, "front"), join(dir, "back")]);
  assert.deepEqual(r.missing, ["gone"]);
  assert.deepEqual(findCodeWorkspaces(dir), [join(dir, "app.code-workspace")]);
  assert.deepEqual(describeCodeWorkspaces([join(dir, "app.code-workspace")]), [{ file: join(dir, "app.code-workspace"), folders: 2 }]);
});

test("promptCodeWorkspace: a number picks, 0 is none, bad input re-asks, EOF cancels", async () => {
  const choices = [
    { file: "/w/a.code-workspace", folders: 2 },
    { file: "/w/b.code-workspace", folders: 1 },
  ];
  const ask = async (text: string, end: boolean) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.on("data", (d) => (shown += d));
    const p = promptCodeWorkspace(choices, "/w", { input, output });
    input.write(text);
    if (end) input.end();
    return { picked: await p, shown };
  };
  assert.equal((await ask("2\n", false)).picked, "/w/b.code-workspace");
  assert.equal((await ask("0\n", false)).picked, null);
  const retry = await ask("9\nx\n1\n", false);
  assert.equal(retry.picked, "/w/a.code-workspace");
  assert.match(retry.shown, /enter a number from 0 to 2/);
  assert.match(retry.shown, /a\.code-workspace · wire its 2 folders/);
  assert.equal((await ask("", true)).picked, undefined);
});

test("promptCodeWorkspace asks even about a single workspace: 1 uses it, 0 runs as before", async () => {
  const one = [{ file: "/w/app.code-workspace", folders: 3 }];
  const run = async (text: string) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.on("data", (d) => (shown += d));
    const p = promptCodeWorkspace(one, "/w", { input, output });
    input.write(text);
    return { picked: await p, shown };
  };
  const yes = await run("1\n");
  assert.equal(yes.picked, "/w/app.code-workspace");
  assert.match(yes.shown, /Found a VS Code workspace in \/w/);
  assert.match(yes.shown, /0\) none · wire this whole folder instead/);
  assert.match(yes.shown, /\[0-1\]/);
  assert.equal((await run("0\n")).picked, null);
});

test("init with one .code-workspace and no terminal runs as before, and says how to use it", () => {
  const dir = fixture("cws-one-pipe", { "app.code-workspace": FRONT_BACK });
  const r = runCli(["init", dir, "--agents", "claude", "--no-build"], { home: tmpRepo("cws-one-pipe-home") });
  assert.equal(r.status, 0, r.describe());
  assert.match(r.stderr, /found a VS Code workspace here \(app\.code-workspace\)/);
  assert.match(r.stderr, /--workspace <file>/);
  assert.doesNotMatch(r.stderr, /wiring 2 folder/);
  assert.ok(wired(dir), "the dir itself is wired, as before");
  for (const c of ["front", "back", "other"]) assert.ok(wired(join(dir, c)), `${c} wired by the usual fan-out`);
});

test("init --workspace with one .code-workspace wires its folders, not the dir or unlisted repos", () => {
  const dir = fixture("cws-one", { "app.code-workspace": FRONT_BACK });
  const home = tmpRepo("cws-one-home");
  const r = runCli(["init", dir, "--agents", "claude", "--no-build", "--workspace", "app.code-workspace"], { home });
  assert.equal(r.status, 0, r.describe());
  assert.ok(wired(join(dir, "front")), "front wired");
  assert.ok(wired(join(dir, "back")), "back wired");
  assert.ok(!wired(join(dir, "other")), "a repo the workspace doesn't list is left alone");
  assert.ok(!wired(dir), "the dir holding the workspace file is not itself a root");
  assert.match(r.stderr, /VS Code workspace app\.code-workspace: wiring 2 folder/);
  assert.match(r.stderr, /folder gone not found/);
});

test("init with several .code-workspace files and no terminal wires the whole dir, and says how to pick", () => {
  const dir = fixture("cws-many", {
    "a.code-workspace": `{ "folders": [{ "path": "front" }] }`,
    "b.code-workspace": `{ "folders": [{ "path": "back" }] }`,
  });
  const home = tmpRepo("cws-many-home");
  const r = runCli(["init", dir, "--agents", "claude", "--no-build"], { home });
  assert.equal(r.status, 0, r.describe());
  assert.match(r.stderr, /found 2 VS Code workspaces/);
  assert.match(r.stderr, /--workspace <file>/);
  // No workspace file chosen: the existing behaviour — a parent of git repos fans out.
  assert.ok(wired(dir));
  for (const c of ["front", "back", "other"]) assert.ok(wired(join(dir, c)), `${c} wired`);
});

test("--workspace picks one of several; --no-workspace ignores them", () => {
  const files = {
    "a.code-workspace": `{ "folders": [{ "path": "front" }] }`,
    "b.code-workspace": `{ "folders": [{ "path": "back" }] }`,
  };
  const picked = fixture("cws-pick", files);
  const r = runCli(["init", picked, "--agents", "claude", "--no-build", "--workspace", "b.code-workspace"], { home: tmpRepo("cws-pick-home") });
  assert.equal(r.status, 0, r.describe());
  assert.ok(wired(join(picked, "back")));
  assert.ok(!wired(join(picked, "front")));
  assert.ok(!wired(picked));

  const ignored = fixture("cws-none", { "a.code-workspace": files["a.code-workspace"] });
  const r2 = runCli(["init", ignored, "--agents", "claude", "--no-build", "--no-workspace"], { home: tmpRepo("cws-none-home") });
  assert.equal(r2.status, 0, r2.describe());
  assert.doesNotMatch(r2.stderr, /VS Code workspace/);
  assert.ok(wired(ignored));
  assert.ok(wired(join(ignored, "back")), "the dir's own git-children fan-out still applies");
});

test("--workspace with a missing file fails without writing", () => {
  const dir = fixture("cws-missing", {});
  const r = runCli(["init", dir, "--agents", "claude", "--no-build", "--workspace", "nope.code-workspace"], { home: tmpRepo("cws-missing-home") });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--workspace: .*not found/);
  assert.ok(!wired(dir));
});

test("--dry-run lists each workspace folder's writes and writes nothing", () => {
  const dir = fixture("cws-dry", { "app.code-workspace": FRONT_BACK });
  const r = runCli(["init", dir, "--agents", "claude", "--no-build", "--dry-run", "--workspace", "app.code-workspace"], { home: tmpRepo("cws-dry-home") });
  assert.equal(r.status, 0, r.describe());
  assert.match(r.stderr, /— front\//);
  assert.match(r.stderr, /— back\//);
  assert.ok(!wired(join(dir, "front")) && !wired(join(dir, "back")));
});
