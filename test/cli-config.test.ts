/**
 * `graft config`: list and edit `.graft/config.json` one setting at a time, with
 * the same validation `graft build --include-dir/--exclude-dir` applies, and help
 * that says what each setting means and what an entry may look like.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addDirEntries,
  clearDirEntries,
  describeExcludeEntry,
  excludeDirProblem,
  formatConfigList,
  includeDirProblem,
  includeEntryNote,
  parseOnOff,
  readDirList,
  readFlag,
  removeDirEntries,
  writeFlag,
} from "../src/config-cli.js";
import { buildConfigPath } from "../src/util/state.js";
import { runCli, tmpRepo } from "./helpers.js";

const config = (repo: string) => JSON.parse(readFileSync(buildConfigPath(repo), "utf8"));

test("exclude entries: names, root-relative paths and globs pass; absolute paths, .. and empty ones do not", () => {
  for (const ok of ["themes", "src/themes", "src\\themes", "./src/themes/", "src/*-old", "**/generated", ".cache"]) {
    assert.equal(excludeDirProblem(ok), null, ok);
  }
  assert.match(excludeDirProblem("C:\\abs")!, /not an absolute one/);
  assert.match(excludeDirProblem("/abs")!, /not an absolute one/);
  assert.match(excludeDirProblem("src/../x")!, /"\.\." cannot appear/);
  assert.match(excludeDirProblem("./")!, /empty after normalising/);
});

test("include entries: bare names only — no paths, wildcards or dot-directories", () => {
  assert.equal(includeDirProblem("build"), null);
  assert.match(includeDirProblem(".cache")!, /never overridable/);
  assert.match(includeDirProblem("src/build")!, /not a path/);
  assert.match(includeDirProblem("bu*")!, /wildcards are not supported/);
  assert.equal(includeEntryNote("build"), null);
  assert.match(includeEntryNote("tools")!, /changes nothing/, "a name the skip list never held is flagged");
});

test("add, remove and clear keep the other settings and store excludes normalised", () => {
  const repo = tmpRepo("config");
  writeFlag(repo, "followSubmodules", true);
  assert.deepEqual(addDirEntries(repo, "excludeDirs", ["themes", ".\\src\\legacy\\", "themes"]), {
    added: ["themes", "src/legacy"],
    present: ["themes"],
  });
  assert.deepEqual(addDirEntries(repo, "excludeDirs", ["src/legacy"]).present, ["src/legacy"], "either slash is the same entry");
  assert.deepEqual(readDirList(repo, "excludeDirs"), ["themes", "src/legacy"]);
  assert.equal(config(repo).followSubmodules, true, "another setting survives the edit");

  assert.deepEqual(removeDirEntries(repo, "excludeDirs", ["src\\legacy", "nope"]), { removed: ["src/legacy"], missing: ["nope"] });
  assert.deepEqual(readDirList(repo, "excludeDirs"), ["themes"]);
  assert.deepEqual(clearDirEntries(repo, "excludeDirs"), ["themes"]);
  assert.deepEqual(config(repo).excludeDirs, []);
  assert.deepEqual(clearDirEntries(repo, "excludeDirs"), [], "clearing an empty list is a no-op");
});

test("on/off parsing and flag reads tell a default from a value someone set", () => {
  for (const on of ["on", "TRUE", "yes", "1"]) assert.equal(parseOnOff(on), true, on);
  for (const off of ["off", "false", "No", "0"]) assert.equal(parseOnOff(off), false, off);
  assert.equal(parseOnOff("maybe"), null);
  const repo = tmpRepo("config-flag");
  assert.deepEqual(readFlag(repo, "followNestedRepos"), { value: false, set: false });
  writeFlag(repo, "followNestedRepos", false);
  assert.deepEqual(readFlag(repo, "followNestedRepos"), { value: false, set: true });
});

test("config list names every setting, its value or default, how each entry matches, and the command to change it", () => {
  const repo = tmpRepo("config-list");
  const home = tmpRepo("config-home");
  assert.match(formatConfigList(repo, home), /^no .*config\.json yet — every setting is at its default/);
  mkdirSync(join(repo, ".graft"), { recursive: true });
  writeFileSync(buildConfigPath(repo), JSON.stringify({ excludeDirs: ["themes", "src/x", "**/gen"], followSubmodules: true }));
  const out = formatConfigList(repo, home);
  assert.match(out, /^excludeDirs: 3 entries$/m);
  assert.match(out, /^ {4}themes {2}— name, at any depth$/m);
  assert.match(out, /^ {4}src\/x {2}— path from the repo root, with its subtree$/m);
  assert.match(out, /^ {4}\*\*\/gen {2}— glob, from the repo root$/m);
  assert.match(out, /^includeDirs: none \(default\)$/m);
  assert.match(out, /^followSubmodules: on$/m);
  assert.match(out, /^followNestedRepos: off \(default\)$/m);
  assert.match(out, /^deepStaleThreshold: 10% \(default\)$/m);
  assert.match(out, /graft config exclude-dirs add\|remove\|clear/);
  assert.equal(describeExcludeEntry("a?c"), "glob, from the repo root");
});

test("graft --help lists the config commands and no longer lists telemetry, which still runs", () => {
  const help = runCli(["--help"]);
  assert.equal(help.status, 0, help.describe());
  assert.doesNotMatch(help.stdout, /^ {2}telemetry\b/m, "telemetry is hidden from the list");
  for (const c of [
    "config list",
    "config exclude-dirs add <entries...>",
    "config exclude-dirs remove <entries...>",
    "config include-dirs list",
    "config follow-submodules [value]",
    "config follow-nested-repos [value]",
  ]) {
    assert.match(help.stdout, new RegExp(`^ {2}${c.replace(/[.[\]]/g, "\\$&")} `, "m"), c);
  }
  const telemetry = runCli(["telemetry"]);
  assert.equal(telemetry.status, 0, telemetry.describe());
  assert.match(runCli(["telemetry", "--help"]).stdout, /^ {2}graft telemetry \[action\]/);
});

test("a setting's help explains its meaning and syntax, and `graft help` reaches it by its full path", () => {
  const ex = runCli(["config", "exclude-dirs", "--help"]);
  assert.equal(ex.status, 0, ex.describe());
  assert.ok(ex.stdout.startsWith("  graft config exclude-dirs\n"), "the setting's own intro comes first");
  assert.match(ex.stdout, /a NAME with no slash/);
  assert.match(ex.stdout, /a PATH relative to the repo root/);
  assert.match(ex.stdout, /a GLOB \(contains \* or \?\)/);
  assert.match(ex.stdout, /absolute paths \(C:\\…, \/…\) and \.\.\s+are rejected/);
  assert.match(ex.stdout, /^ {2}graft config exclude-dirs remove <entries\.\.\.> \[options\]$/m, "then each of its commands");
  assert.equal(runCli(["help", "config", "exclude-dirs"]).stdout, ex.stdout);
  assert.match(runCli(["config", "include-dirs", "--help"]).stdout, /Dot-directories \(\.git, \.github, …\)\s+are always skipped/);
});

test("the commands edit the repo --repo names and reject what the build would reject", () => {
  const repo = tmpRepo("config-cli");
  const add = runCli(["config", "exclude-dirs", "add", "themes", "src/*-old", "--repo", repo]);
  assert.equal(add.status, 0, add.describe());
  assert.match(add.stdout, /✓ added src\/\*-old {2}— glob, from the repo root/);
  assert.deepEqual(config(repo).excludeDirs, ["themes", "src/*-old"]);

  const bad = runCli(["config", "exclude-dirs", "add", "../up", "--repo", repo]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /"\.\.\/up": "\.\." cannot appear/);
  assert.deepEqual(config(repo).excludeDirs, ["themes", "src/*-old"], "nothing written on a rejected entry");

  const flag = runCli(["config", "follow-nested-repos", "on", "--repo", repo]);
  assert.equal(flag.status, 0, flag.describe());
  assert.equal(config(repo).followNestedRepos, true);
  assert.match(runCli(["config", "followNestedRepos", "--repo", repo]).stdout, /^followNestedRepos: on$/m, "the key name works as an alias");

  const missing = runCli(["config", "exclude-dirs", "remove", "nope", "--repo", repo]);
  assert.equal(missing.status, 1, "removing only absent entries is an error");
});
