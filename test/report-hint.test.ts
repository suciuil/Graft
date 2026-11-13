import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ISSUES_URL } from "../src/about.js";
import { REPORT_HINT_ENV, noteChildBuildFailure, reportHintApplies, reportHintDue, reportHintText } from "../src/report-hint.js";
import { REPORT_FAILURES, skillTemplate } from "../src/claude/skill-template.js";
import { copilotInstructions, instructionBody, kiloRule } from "../src/hosts/instructions.js";
import { GRAPH_TOO_LARGE_EXIT } from "../src/graph/size-guard.js";
import { runCli } from "./helpers.js";

test("the closing line is due on an error exit, or on a failure recorded while exiting 0", () => {
  assert.equal(reportHintDue(1, false), true);
  assert.equal(reportHintDue(2, false), true);
  assert.equal(reportHintDue(0, true), true);
  for (const quiet of [0, 130, 143, GRAPH_TOO_LARGE_EXIT]) assert.equal(reportHintDue(quiet, false), false, `exit ${quiet}`);
  assert.equal(reportHintDue(undefined, false), false);
});

test("a child build's failure is recorded for the line, but not a timeout, an interrupt or a too-big repository", () => {
  // Signal/timeout (null), success, Ctrl+C, SIGTERM, too big: nothing to report.
  for (const status of [null, undefined, 0, 130, 143, GRAPH_TOO_LARGE_EXIT]) assert.equal(noteChildBuildFailure(status), false, `status ${status}`);
  assert.equal(noteChildBuildFailure(1), true);
});

test("the closing line is for init and build, not for build --check", () => {
  assert.equal(reportHintApplies("init", {}), true);
  assert.equal(reportHintApplies("build", {}), true);
  assert.equal(reportHintApplies("build", { check: true }), false);
  assert.equal(reportHintApplies("ask", {}), false);
});

test("the closing line names the fork's issue tracker and what to include", () => {
  const text = reportHintText("graft --version");
  assert.ok(text.includes(ISSUES_URL));
  assert.match(text, /graft --version/);
  assert.match(text, /full output/);
  assert.doesNotMatch(text, /operating system/);
});

test("every agent instruction and the skill tell agents where to report init/build failures", () => {
  assert.ok(REPORT_FAILURES.includes(ISSUES_URL));
  for (const [name, text] of Object.entries({
    body: instructionBody("graft"),
    trailBody: instructionBody("trail"),
    copilot: copilotInstructions(),
    kilo: kiloRule(),
    skill: skillTemplate("graft"),
    trailSkill: skillTemplate("trail"),
  })) {
    // The address must survive the trail rename untouched.
    assert.ok(text.includes(ISSUES_URL), `${name} lacks the issue tracker`);
  }
  assert.match(instructionBody("graft"), /If `graft init` or `graft build` \(including `graft build --deep`\) fails/);
});

const home = () => mkdtempSync(join(tmpdir(), "report-hint-home-"));

test("a failed graft build ends with the issue tracker line", () => {
  const r = runCli(["build", ".", "--force"], { home: home(), env: { [REPORT_HINT_ENV]: "" } });
  assert.equal(r.status, 1, r.describe());
  assert.ok(r.stderr.includes(ISSUES_URL), r.describe());
});

test("a build run by a parent graft process leaves the line to the parent", () => {
  const r = runCli(["build", ".", "--force"], { home: home(), env: { [REPORT_HINT_ENV]: "1" } });
  assert.equal(r.status, 1, r.describe());
  assert.ok(!r.stderr.includes(ISSUES_URL), r.describe());
});
