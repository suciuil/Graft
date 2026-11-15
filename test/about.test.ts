import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FORK_HOMEPAGE_URL, FORK_RELEASES_URL, FORK_REPO_URL, ISSUES_URL, PROJECT_URL, fileUri, findChangelog, formatAbout, parseAboutTarget } from "../src/about.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

test("parseAboutTarget accepts home, fork and web, case-insensitively, and nothing else", () => {
  assert.equal(parseAboutTarget("home"), "home");
  assert.equal(parseAboutTarget(" FORK "), "fork");
  assert.equal(parseAboutTarget("Web"), "web");
  assert.equal(parseAboutTarget("homepage"), null);
  assert.equal(parseAboutTarget(undefined), null);
});

test("findChangelog finds docs/changelog.html next to package.json, then the kit layout", () => {
  const pkg = join("root", "package.json");
  const docs = join("root", "docs", "changelog.html");
  const kit = join("root", "changelog.html");
  assert.equal(findChangelog(pkg, (p) => p === docs || p === kit), docs);
  assert.equal(findChangelog(pkg, (p) => p === kit), kit);
  assert.equal(findChangelog(pkg, () => false), null);
});

test("the repo ships the fork changelog where findChangelog looks", () => {
  assert.ok(existsSync(join(repoRoot, "docs", "changelog.html")));
  assert.equal(findChangelog(join(repoRoot, "package.json")), join(repoRoot, "docs", "changelog.html"));
});

test("formatAbout names the homepage and how to open each page, but not the local changelog copy", () => {
  const report = join(repoRoot, "docs", "changelog.html");
  const text = formatAbout("graft", "1.2.3", report);
  assert.match(text, /^graft 1\.2\.3: /);
  assert.ok(text.includes(PROJECT_URL));
  assert.ok(!text.includes(report));
  assert.ok(!text.includes("file:///"));
  assert.ok(!/as of this build/.test(text));
  assert.ok(fileUri(report).startsWith("file:///"));
  assert.match(text, /graft about home/);
  assert.match(text, /graft about fork/);
  assert.match(text, /Nothing is sent/);
});

test("formatAbout names the fork homepage, the published changelog, and how to open it", () => {
  for (const changelog of [join(repoRoot, "docs", "changelog.html"), null]) {
    const text = formatAbout("graft", "1.2.3", changelog);
    assert.ok(text.includes(FORK_HOMEPAGE_URL));
    assert.ok(text.includes(FORK_RELEASES_URL));
    assert.match(text, /graft about web/);
  }
  assert.match(formatAbout("graft", "1.2.3", null), /falls back to the fork homepage/);
  assert.equal(FORK_HOMEPAGE_URL, "https://github-ct.int.automotive-wan.com/pages/suciui/Graft/");
  assert.ok(FORK_RELEASES_URL.startsWith(`${FORK_REPO_URL}/`));
});

test("the publish script serves the changelog at the fork homepage", async () => {
  const { pagesUrl } = await import("../scripts/publish-changelog.mjs");
  assert.equal(pagesUrl(`${FORK_REPO_URL}.git`), FORK_HOMEPAGE_URL);
});

test("formatAbout lists the fork's issue tracker and how to open it", () => {
  for (const changelog of [join(repoRoot, "docs", "changelog.html"), null]) {
    const text = formatAbout("graft", "1.2.3", changelog);
    assert.ok(text.includes(ISSUES_URL));
    assert.match(text, /graft issues/);
  }
  assert.equal(ISSUES_URL, "https://github-ct.int.automotive-wan.com/suciui/graft/issues");
});

test("formatAbout prints no path when the installation has no changelog copy", () => {
  const text = formatAbout("graft", "1.2.3", null);
  assert.ok(!/not found in this installation/.test(text));
  assert.ok(!text.includes("file:///"));
});
