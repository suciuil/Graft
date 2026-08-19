/**
 * `graft build --exclude-dir` drops named directories from the walk. Persisted
 * in the build config, it must take effect for the wiring graph the same way
 * `--include-dir` does — verified here by building a repo with an excluded folder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { execFileSync } from "node:child_process";
import { readBuildConfig, writeBuildConfig } from "../src/util/state.js";

test("--exclude-dir: a persisted excludeDirs entry drops that folder from the graph", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-excl-"));
  try {
    mkdirSync(join(dir, "keep"), { recursive: true });
    mkdirSync(join(dir, "skip"), { recursive: true });
    writeFileSync(join(dir, "keep", "a.ts"), "export function kept() {}\n");
    writeFileSync(join(dir, "skip", "b.ts"), "export function dropped() {}\n");

    writeBuildConfig(dir, { excludeDirs: ["skip"] });
    await buildGraph(dir);

    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const paths = graph.nodes.map((n) => n.path);
    assert.ok(paths.some((p) => p.includes("keep/a.ts")), "keep/ should be indexed");
    assert.ok(!paths.some((p) => p.includes("skip/")), "skip/ should be excluded from the graph");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--exclude-dir takes precedence over --include-dir for the same name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-excl2-"));
  try {
    // `build` is normally a SKIP_DIRS name; include re-admits it, exclude wins.
    mkdirSync(join(dir, "build"), { recursive: true });
    writeFileSync(join(dir, "build", "gen.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "main.ts"), "export const y = 2;\n");

    writeBuildConfig(dir, { includeDirs: ["build"], excludeDirs: ["build"] });
    await buildGraph(dir);

    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const paths = graph.nodes.map((n) => n.path);
    assert.ok(paths.some((p) => p.includes("main.ts")), "main.ts should be indexed");
    assert.ok(!paths.some((p) => p.includes("build/")), "excluded build/ wins over include");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- end-to-end through the real CLI ---------- */

function runCli(args: string[]): void {
  execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { stdio: "pipe" });
}

function runCliCapture(args: string[]): { stderr: string; status: number } {
  try {
    execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stderr?: string; status?: number };
    return { stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

function pathsOf(dir: string): string[] {
  return (readGraph(wiringPath(join(dir, "graft")))?.nodes ?? []).map((n) => n.path);
}

test("--exclude-dir persists to .graft/config.json and still applies to a later no-flag build", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-excl-cli-"));
  try {
    mkdirSync(join(dir, "Documents"), { recursive: true });
    writeFileSync(join(dir, "Documents", "gen.ts"), "export const doc = 1;\n");
    writeFileSync(join(dir, "main.ts"), "export const main = 2;\n");

    runCli(["build", dir, "--exclude-dir", "Documents"]);
    assert.deepEqual(readBuildConfig(dir), { excludeDirs: ["Documents"] });
    assert.ok(!pathsOf(dir).some((p) => p.includes("Documents/")), "excluded on the flagged build");

    // The persisted list is the point: a rebuild with no flags, and the
    // hooks/refresh path that never sees flags at all, must agree.
    runCli(["build", dir]);
    const paths = pathsOf(dir);
    assert.ok(paths.some((p) => p.includes("main.ts")), "main.ts stays indexed");
    assert.ok(!paths.some((p) => p.includes("Documents/")), "still excluded with no flag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The documented way to manage a long list: write .graft/config.json by hand.
// graft must honour it without the flag ever being passed.
test("a hand-written .graft/config.json excludeDirs list is honoured, at any depth", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-excl-cfg-"));
  try {
    mkdirSync(join(dir, "src", "ui", "themes"), { recursive: true });
    mkdirSync(join(dir, "src", "i18n"), { recursive: true });
    mkdirSync(join(dir, "src", "app"), { recursive: true });
    writeFileSync(join(dir, "src", "ui", "themes", "dark.ts"), "export const dark = 1;\n");
    writeFileSync(join(dir, "src", "i18n", "en.ts"), "export const en = 2;\n");
    writeFileSync(join(dir, "src", "app", "run.ts"), "export const run = 3;\n");

    mkdirSync(join(dir, ".graft"), { recursive: true });
    writeFileSync(join(dir, ".graft", "config.json"), JSON.stringify({ excludeDirs: ["themes", "i18n"] }, null, 2));

    runCli(["build", dir]);
    const paths = pathsOf(dir);
    assert.ok(paths.some((p) => p.includes("src/app/run.ts")), "unexcluded source is indexed");
    // Nested several levels down: the match is per path SEGMENT, not a prefix.
    assert.ok(!paths.some((p) => p.includes("themes/")), "src/ui/themes excluded at depth");
    assert.ok(!paths.some((p) => p.includes("i18n/")), "src/i18n excluded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- path and glob forms: one directory, not every directory of that name ---------- */

/** Two `themes/` directories at different depths plus a same-prefix sibling, so
 * the three exclude shapes are actually distinguishable from one another. */
function repoWithThemes(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const p of [["src", "themes"], ["src", "themes2"], ["src", "app"], ["web", "themes"]]) {
    mkdirSync(join(dir, ...p), { recursive: true });
    writeFileSync(join(dir, ...p, "f.ts"), "export const x = 1;\n");
  }
  writeFileSync(join(dir, "main.ts"), "export const m = 1;\n");
  return dir;
}

test("a path-form exclusion drops only that directory, leaving same-named siblings indexed", () => {
  const dir = repoWithThemes("graft-excl-path-");
  try {
    runCli(["build", dir, "--exclude-dir", "src/themes"]);
    const paths = pathsOf(dir);
    assert.ok(paths.some((p) => p.includes("main.ts")), "main.ts indexed");
    assert.ok(!paths.some((p) => p.includes("src/themes/")), "src/themes excluded");
    // The whole point of the path form: a same-named directory elsewhere survives.
    assert.ok(paths.some((p) => p.includes("web/themes/")), "web/themes must survive");
    assert.ok(paths.some((p) => p.includes("src/themes2/")), "src/themes2 is a different directory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare name still drops every directory of that name, at every depth", () => {
  const dir = repoWithThemes("graft-excl-name-");
  try {
    runCli(["build", dir, "--exclude-dir", "themes"]);
    const paths = pathsOf(dir);
    assert.ok(paths.some((p) => p.includes("main.ts")), "main.ts indexed");
    assert.ok(!paths.some((p) => p.includes("src/themes/")), "src/themes excluded");
    assert.ok(!paths.some((p) => p.includes("web/themes/")), "web/themes excluded too");
    assert.ok(paths.some((p) => p.includes("src/themes2/")), "themes2 is a different NAME, not a prefix match");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("glob forms: trailing *, /* and a leading * each select a different set", () => {
  // `src/themes*` also takes the same-prefix sibling; `src/themes/*` takes only
  // what is INSIDE src/themes; `*src/themes` anchors the tail, so web/themes stays.
  const cases: Array<{ pattern: string; gone: string[]; kept: string[] }> = [
    { pattern: "src/themes*", gone: ["src/themes/", "src/themes2/"], kept: ["web/themes/"] },
    { pattern: "src/themes/*", gone: ["src/themes/"], kept: ["src/themes2/", "web/themes/"] },
    { pattern: "*src/themes", gone: ["src/themes/"], kept: ["src/themes2/", "web/themes/"] },
  ];
  for (const [i, c] of cases.entries()) {
    const dir = repoWithThemes(`graft-excl-glob-${i}-`);
    try {
      runCli(["build", dir, "--exclude-dir", c.pattern]);
      const paths = pathsOf(dir);
      assert.ok(paths.some((p) => p.includes("main.ts")), `${c.pattern}: main.ts indexed`);
      for (const g of c.gone) assert.ok(!paths.some((p) => p.includes(g)), `${c.pattern}: ${g} excluded`);
      for (const k of c.kept) assert.ok(paths.some((p) => p.includes(k)), `${c.pattern}: ${k} kept`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Backslashes, a leading ./ and a trailing / are all things a hand-edited config
// or a Windows shell produces; they must all mean the same directory.
test("path entries are normalised: backslashes, leading ./ and trailing /", () => {
  for (const [i, spelling] of ["src\\themes", "./src/themes", "src/themes/"].entries()) {
    const dir = repoWithThemes(`graft-excl-norm-${i}-`);
    try {
      mkdirSync(join(dir, ".graft"), { recursive: true });
      writeFileSync(join(dir, ".graft", "config.json"), JSON.stringify({ excludeDirs: [spelling] }));
      runCli(["build", dir]);
      const paths = pathsOf(dir);
      assert.ok(!paths.some((p) => p.includes("src/themes/")), `${spelling}: src/themes excluded`);
      assert.ok(paths.some((p) => p.includes("web/themes/")), `${spelling}: web/themes kept`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("--exclude-dir rejects an absolute path and a .. escape", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-excl-bad-"));
  try {
    writeFileSync(join(dir, "main.ts"), "export const y = 1;\n");
    for (const bad of ["C:\\themes", "/etc/themes", "../outside"]) {
      const r = runCliCapture(["build", dir, "--exclude-dir", bad]);
      assert.equal(r.status, 1, `${bad} must be rejected`);
      assert.match(r.stderr, /--exclude-dir/);
    }
    assert.equal(readBuildConfig(dir), null, "a rejected value must not be persisted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
