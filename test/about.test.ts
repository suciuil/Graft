import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROJECT_URL, fileUri, findForkReport, formatAbout, parseAboutTarget } from "../src/about.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

test("parseAboutTarget accepts home and fork, case-insensitively, and nothing else", () => {
  assert.equal(parseAboutTarget("home"), "home");
  assert.equal(parseAboutTarget(" FORK "), "fork");
  assert.equal(parseAboutTarget("homepage"), null);
  assert.equal(parseAboutTarget(undefined), null);
});

test("findForkReport finds docs/fork-report.html next to package.json, then the kit layout", () => {
  const pkg = join("root", "package.json");
  const docs = join("root", "docs", "fork-report.html");
  const kit = join("root", "fork-report.html");
  assert.equal(findForkReport(pkg, (p) => p === docs || p === kit), docs);
  assert.equal(findForkReport(pkg, (p) => p === kit), kit);
  assert.equal(findForkReport(pkg, () => false), null);
});

test("the repo ships the fork report where findForkReport looks", () => {
  assert.ok(existsSync(join(repoRoot, "docs", "fork-report.html")));
  assert.equal(findForkReport(join(repoRoot, "package.json")), join(repoRoot, "docs", "fork-report.html"));
});

test("formatAbout names the homepage, the report path and its file URI, and how to open each", () => {
  const report = join(repoRoot, "docs", "fork-report.html");
  const text = formatAbout("graft", "1.2.3", report);
  assert.match(text, /^graft 1\.2\.3: /);
  assert.ok(text.includes(PROJECT_URL));
  assert.ok(text.includes(report));
  assert.ok(text.includes(fileUri(report)));
  assert.ok(fileUri(report).startsWith("file:///"));
  assert.match(text, /graft about home/);
  assert.match(text, /graft about fork/);
  assert.match(text, /Nothing is sent/);
});

test("formatAbout says when the report is missing instead of printing a dead path", () => {
  const text = formatAbout("graft", "1.2.3", null);
  assert.match(text, /not found in this installation/);
  assert.ok(!text.includes("file:///"));
});
