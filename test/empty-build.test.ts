import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { diagnoseEmptyBuild, formatEmptyBuild } from "../src/graph/empty-build.js";

function scratch(tag: string): string {
  // realpath: macOS hands out /var/... for what git reports as /private/var/...
  return realpathSync(mkdtempSync(join(tmpdir(), `graft-empty-${tag}-`)));
}

function write(root: string, path: string, content = "def f():\n    return 1\n"): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
}

/** A map dir that is not inside the scanned folder, like the profile store. */
const OUT = resolve(tmpdir(), "graft-empty-no-such-map-dir");

test("a folder git-ignored by its enclosing repo is named, with the rule and the fix", () => {
  const dir = scratch("ignored");
  try {
    gitInit(dir);
    write(dir, ".gitignore", "# local stuff\nsub/\n");
    write(dir, "sub/a.py");
    const sub = join(dir, "sub");

    const cause = diagnoseEmptyBuild(sub, OUT);
    assert.ok(cause && cause.kind === "ignored-by-enclosing-repo", JSON.stringify(cause));
    assert.equal(resolve(cause.repoRoot), resolve(dir));
    assert.deepEqual(cause.rule, { pattern: "sub/", source: resolve(dir, ".gitignore"), line: 2 });

    const text = formatEmptyBuild(cause, sub, "graft build --deep").join("\n");
    assert.match(text, /git-ignored by the repository it is inside/);
    assert.match(text, /git init/);
    assert.match(text, /graft build --deep/);
    assert.ok(text.includes(resolve(dir, ".gitignore")), text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rule in a nested .gitignore is reported against that file, not the repo root", () => {
  const dir = scratch("nested-rule");
  try {
    gitInit(dir);
    write(dir, "mid/.gitignore", "inner/\n");
    write(dir, "mid/inner/a.py");

    const cause = diagnoseEmptyBuild(join(dir, "mid", "inner"), OUT);
    assert.ok(cause && cause.kind === "ignored-by-enclosing-repo", JSON.stringify(cause));
    assert.deepEqual(cause.rule, { pattern: "inner/", source: resolve(dir, "mid", ".gitignore"), line: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("files on disk that ignore rules all hide are counted, with an example and its rule", () => {
  const dir = scratch("hidden");
  try {
    gitInit(dir);
    write(dir, ".gitignore", "*.py\n");
    write(dir, "a.py");
    write(dir, "pkg/b.py");

    const cause = diagnoseEmptyBuild(dir, OUT);
    assert.ok(cause && cause.kind === "hidden-by-gitignore", JSON.stringify(cause));
    assert.equal(cause.hidden, 2);
    assert.equal(cause.rule?.pattern, "*.py");
    assert.match(formatEmptyBuild(cause, dir, "graft build").join("\n"), /git add -f/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a folder of files no parser claims lists what it did find", () => {
  const dir = scratch("unsupported");
  try {
    write(dir, "costs.xlsx", "x");
    write(dir, "q1.xlsx", "x");
    write(dir, "report.pdf", "x");

    const cause = diagnoseEmptyBuild(dir, OUT);
    assert.ok(cause && cause.kind === "no-supported-files", JSON.stringify(cause));
    assert.equal(cause.files, 3);
    assert.deepEqual(cause.extensions, [[".xlsx", 2], [".pdf", 1]]);
    assert.match(formatEmptyBuild(cause, dir, "graft build").join("\n"), /graft languages/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an --only-dir that matches nothing is blamed, not the folder", () => {
  const dir = scratch("only-dir");
  try {
    write(dir, "src/a.py");
    const cause = diagnoseEmptyBuild(dir, OUT, ["scr"]);
    assert.deepEqual(cause, { kind: "only-dir", onlyDirs: ["scr"], sourceFiles: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty folder, and one with only skipped folders, is reported as empty", () => {
  const dir = scratch("empty");
  try {
    write(dir, "node_modules/x/index.js", "module.exports = 1;\n");
    const cause = diagnoseEmptyBuild(dir, OUT);
    assert.ok(cause && cause.kind === "empty", JSON.stringify(cause));
    assert.match(formatEmptyBuild(cause, dir, "graft build").join("\n"), /node_modules/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing to explain when there are files to index", () => {
  const dir = scratch("fine");
  try {
    write(dir, "a.py");
    assert.equal(diagnoseEmptyBuild(dir, OUT), null);
    gitInit(dir);
    assert.equal(diagnoseEmptyBuild(dir, OUT), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
