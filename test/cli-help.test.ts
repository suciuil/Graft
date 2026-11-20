/**
 * The top-level help has to answer "how do I use --model?": global options
 * configure a command and never run anything alone, and the LLM options belong
 * to `build --deep`. `graft --model x` used to dump the whole help as an error.
 */
import "./isolate.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { helpExamples, missingCommandHint } from "../src/cli-help.js";
import { runCli } from "./helpers.js";

const VALUE_OPTS = ["--dir", "--provider", "--model", "--api-key", "--base-url", "--agent-model"];
const hint = (...args: string[]) => missingCommandHint(args, VALUE_OPTS, "graft");

test("only global options: a short hint that names the missing command", () => {
  const h = hint("--model", "claude-sonnet-5-5") ?? "";
  assert.match(h, /^error: no command given — --model claude-sonnet-5-5 only configures a command/);
  assert.match(h, /\n  graft --model claude-sonnet-5-5 build --deep\n/, "LLM options point at the command that uses them");
  assert.match(h, /used by `build --deep`/);

  const dirOnly = hint("--dir", "out") ?? "";
  assert.match(dirOnly, /\n  graft --dir out <command>\n/);
  assert.doesNotMatch(dirOnly, /build --deep/, "non-LLM options don't suggest an LLM pass");

  assert.match(hint("--model=x", "--base-url", "http://h/v1") ?? "", /graft --model=x --base-url http:\/\/h\/v1 build --deep/);
  assert.match(hint("--model", "my model") ?? "", /graft --model "my model" build --deep/);
});

test("an API key is never echoed back", () => {
  assert.doesNotMatch(hint("--api-key", "sk-secret") ?? "", /sk-secret/);
  assert.match(hint("--api-key", "sk-secret") ?? "", /--api-key <key>/);
  assert.doesNotMatch(hint("--api-key=sk-secret") ?? "", /sk-secret/);
});

test("everything else is left to the parser: commands, help, version, typos, missing values, no args", () => {
  for (const args of [
    [],
    ["build"],
    ["--model", "x", "build", "--deep"],
    ["build", "--deep", "--model", "x"],
    ["--help"],
    ["--model", "x", "--help"],
    ["-v"],
    ["--model"],
    ["--model", "x", "buld"],
    ["--model", "x", "--nope"],
  ]) {
    assert.equal(hint(...args), null, JSON.stringify(args));
  }
});

test("examples show both placements of a global option and the deep-build check", () => {
  const ex = helpExamples("graft");
  assert.match(ex, /on their own they run nothing/);
  assert.match(ex, /\$ graft --model <id> build --deep/);
  assert.match(ex, /\$ graft build --deep --model <id>/);
  assert.match(ex, /\$ graft staleness/);
  assert.match(ex, /\$ graft <command> --help/);
  assert.doesNotMatch(ex, /^  graft /m, "a `$` prompt, so no example reads as a listed command");
  assert.doesNotMatch(helpExamples("trail", false), /<command> --help/, "trail prints its own line for that");
});

test("graft --help is only the commands, A→Z, each with its own and its global options; -h/-v still work", () => {
  const help = runCli(["--help"]);
  assert.equal(help.status, 0, help.describe());
  assert.ok(help.stdout.startsWith("Commands:\n"), "no usage line, description or option sections");
  assert.doesNotMatch(help.stdout, /Global options|LLM options|Usage:|^Examples:/m);
  assert.doesNotMatch(help.stdout, /-h, --help|-v, --version/, "-h and -v work but are not listed");
  assert.doesNotMatch(help.stdout, /GRAFT_AGENT_MODEL/, "the retired env var is not advertised");

  const commands = help.stdout.slice(0, help.stdout.indexOf("\nCommon commands:\n"));
  const heads = commands.split("\n").filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim().split(" ")[0]!);
  assert.deepEqual(heads, [...heads].sort((a, b) => a.localeCompare(b)), "alphabetical");
  for (const c of ["api", "ask", "build", "help", "model", "viz"]) assert.ok(heads.includes(c), c);
  assert.match(help.stdout, /^ {2}api key \[key\] \[options\]$/m, "a group's commands are listed by their full path");

  const entry = (name: string) => help.stdout.split("\n\n").find((e) => e.startsWith(`  ${name} `)) ?? "";
  assert.match(entry("build"), /--deep\s/);
  assert.match(entry("build"), /--model <id>/, "the LLM options sit on the command that uses them");
  assert.match(entry("build"), /--dir <path>/);
  assert.doesNotMatch(entry("build"), /--agent-model/);
  assert.match(entry("ask"), /--agent-model <id>/);
  assert.match(entry("ask"), /Examples:\n {8}graft ask /);
  assert.doesNotMatch(entry("version"), /--dir|Options:/, "no options listed where none apply");
  assert.equal(entry("upgrade"), "", "upgrade is disabled in this fork: not listed");

  const version = runCli(["-v"]);
  assert.equal(version.status, 0, version.describe());
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);
  assert.equal(runCli(["--version"]).stdout, version.stdout);
  assert.equal(runCli(["-h"]).stdout, help.stdout);

  const build = runCli(["build", "--help"]);
  assert.equal(build.status, 0, build.describe());
  assert.ok(build.stdout.startsWith("  graft build [dir] [options]\n"), "the same entry, named with the program");
  assert.equal(build.stdout.replace("  graft build", "  build").trimEnd(), entry("build").trimEnd());
  assert.equal(runCli(["help", "build"]).stdout, build.stdout);

  const alone = runCli(["--model", "claude-sonnet-5-5"]);
  assert.equal(alone.status, 1);
  assert.match(alone.stderr, /no command given/);
  assert.match(alone.stderr, /--model claude-sonnet-5-5 build --deep/);
  assert.doesNotMatch(alone.stderr, /Commands:/, "not the whole help again");
});

test("graft --help ends with the common commands, then how to get more help on one", () => {
  const help = runCli(["--help"]);
  assert.equal(help.status, 0, help.describe());
  const tail = help.stdout.slice(help.stdout.indexOf("\n\nCommon commands:\n") + 2);
  assert.ok(tail.startsWith("Common commands:\n"), "after the command list");
  const listed = tail
    .split("\n")
    .filter((l) => /^ {2}graft /.test(l))
    .map((l) => l.trim().split(/\s{2,}/));
  assert.deepEqual(
    listed.map(([term]) => term),
    ["find-command", "model", "build", "parts", "deep-threshold", "staleness", "config", "savings", "files location", "about"].map((c) => `graft ${c}`),
  );
  for (const [term, desc] of listed) assert.ok(desc && desc.length <= 60, `${term} has a very short description`);
  assert.match(tail, /\n\nMore about any command: `graft <command> --help` \(or `graft help <command>`\)\.\n$/, "the last line");
  assert.doesNotMatch(runCli(["build", "--help"]).stdout, /Common commands:/, "only on the full list");
});

test("graft /h and graft /help print the same as graft help, and no help lists them", () => {
  const help = runCli(["help"]);
  assert.equal(help.status, 0, help.describe());
  for (const alias of ["/h", "/help"]) {
    const r = runCli([alias]);
    assert.equal(r.status, 0, r.describe());
    assert.equal(r.stdout, help.stdout, alias);
    assert.equal(r.stderr, "", `${alias}: no upkeep notices`);
    assert.doesNotMatch(r.stdout, /\/h\b|\/help\b/, `${alias} lists neither alias`);
  }
  assert.equal(runCli(["/h", "ask"]).stdout, runCli(["help", "ask"]).stdout);
  assert.equal(runCli(["/help", "api", "key"]).stdout, runCli(["api", "key", "--help"]).stdout);
  assert.doesNotMatch(runCli(["--help"]).stdout, /\/h\b|\/help\b/);
});

test("an unknown command prints the error, the suggestion and a pointer to graft help — not the help — on stderr, exit 1", () => {
  const r = runCli(["buld"]);
  assert.equal(r.status, 1, r.describe());
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.trim(), "error: unknown command 'buld'\n(Did you mean build?)\nRun `graft help` for the list of available commands.");

  const unlike = runCli(["xyzzy"]);
  assert.equal(unlike.status, 1, unlike.describe());
  assert.equal(unlike.stderr.trim(), "error: unknown command 'xyzzy'\nRun `graft help` for the list of available commands.");

  const group = runCli(["api", "nope"]);
  assert.equal(group.status, 1, group.describe());
  assert.equal(group.stderr.trim(), "error: unknown command 'nope'\nRun `graft api --help` for the list of available `api` commands.");
  assert.doesNotMatch(group.stderr, /graft api key /, "a group's commands are not listed");

  for (const [args, stderr] of [
    [["help", "nope"], "error: unknown command 'nope'\nRun `graft help` for the list of available commands."],
    [["/h", "nope"], "error: unknown command 'nope'\nRun `graft help` for the list of available commands."],
    [["help", "api", "nope"], "error: unknown command 'nope'\nRun `graft api --help` for the list of available `api` commands."],
  ] as const) {
    const h = runCli([...args]);
    assert.equal(h.status, 1, h.describe());
    assert.equal(h.stdout, "", args.join(" "));
    assert.equal(h.stderr.trim(), stderr, args.join(" "));
  }

  const missing = runCli(["ask"]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr.trim(), "error: missing required argument 'query'", "other errors stay one line");
});

test("an unknown parameter of a known command prints the error and a pointer to that command's --help, exit 1", () => {
  const option = runCli(["build", "--nope"]);
  assert.equal(option.status, 1, option.describe());
  assert.equal(option.stdout, "");
  assert.equal(option.stderr.trim(), "error: unknown option '--nope'\nRun `graft build --help` for more info about this command.");

  const typo = runCli(["build", "--deeep"]);
  assert.equal(typo.status, 1, typo.describe());
  assert.equal(typo.stderr.trim(), "error: unknown option '--deeep'\n(Did you mean --deep?)\nRun `graft build --help` for more info about this command.");

  const nested = runCli(["api", "key", "--nope"]);
  assert.equal(nested.status, 1, nested.describe());
  assert.match(nested.stderr, /\nRun `graft api key --help` for more info about this command\.\n?$/);

  const extra = runCli(["upgrade", "extra"]);
  assert.equal(extra.status, 1, extra.describe());
  assert.match(extra.stderr, /^error: too many arguments for 'upgrade'\..*\nRun `graft upgrade --help` for more info about this command\.\n?$/s);

  const top = runCli(["--nope"]);
  assert.equal(top.status, 1, top.describe());
  assert.equal(top.stderr.trim(), "error: unknown option '--nope'\nRun `graft help` for the list of available commands.");
});

test("graft upgrade is disabled in this fork: it installs nothing, points to the release page and exits 1", () => {
  const r = runCli(["upgrade"]);
  assert.equal(r.status, 1, r.describe());
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /graft upgrade is disabled in this fork/);
  assert.match(r.stderr, /https:\/\/github-ct\.int\.automotive-wan\.com\/suciui\/Graft\/releases/);
  assert.doesNotMatch(r.stderr, /npm install|trail/, "no npm run, no trail package");
  assert.match(runCli(["upgrade", "--help"]).stdout, /Disabled in this fork/, "--help still explains it");
});

test("graft find-command lists the commands whose name or description holds the keyword, then each one's full help", () => {
  const r = runCli(["find-command", "DEEP"]);
  assert.equal(r.status, 0, r.describe());
  assert.match(r.stdout, /^Found \d+ commands matching "deep" \(in the name or description\):\n/);
  const [list, ...entries] = r.stdout.split("\n\n");
  const found = list!.split("\n").slice(1).map((l) => l.trim().split(/\s{2,}/));
  const names = found.map(([path]) => path);
  assert.deepEqual(names.slice(0, 2), ["auto-deep", "deep-threshold"], "name matches come first");
  assert.deepEqual(found[0], ["auto-deep", "name, description"]);
  assert.deepEqual(found[1], ["deep-threshold", "name, description"]);
  for (const c of ["build", "staleness"]) assert.ok(names.includes(c), c);
  assert.deepEqual(found.find(([p]) => p === "build"), ["build", "description"]);
  assert.ok(!names.includes("upgrade"), "a command without the keyword is left out");

  // Each entry is exactly what `graft <command> --help` prints.
  assert.equal(entries.length, names.length);
  assert.equal(entries[0]!.trimEnd(), runCli(["auto-deep", "--help"]).stdout.trimEnd());
  assert.equal(entries[1]!.trimEnd(), runCli(["deep-threshold", "--help"]).stdout.trimEnd());
  const build = entries.find((e) => e.startsWith("  graft build "));
  assert.equal(build?.trimEnd(), runCli(["help", "build"]).stdout.trimEnd());

  // Several words are one phrase; a group's command matches by its full path.
  const phrase = runCli(["find-command", "api", "key"]);
  assert.equal(phrase.status, 0, phrase.describe());
  assert.match(phrase.stdout, /^ {2}api key {2,}name, description$/m);
  assert.match(phrase.stdout, /^ {2}graft api key \[key\] \[options\]$/m);
  assert.doesNotMatch(phrase.stdout, /^ {2}graft api url /m, "\"api url\" holds the words but not the phrase");

  const none = runCli(["find-command", "no-such-keyword-xyz"]);
  assert.equal(none.status, 1, none.describe());
  assert.equal(none.stdout, "");
  assert.match(none.stderr, /No command matches "no-such-keyword-xyz"/);

  assert.match(runCli(["--help"]).stdout, /^ {2}find-command <keyword\.\.\.>$/m, "listed in graft help");
});

test("trail keeps its grouped help", () => {
  const help = runCli(["--help"], { env: { TRAIL_INVOKED_AS: "trail" } });
  assert.equal(help.status, 0, help.describe());
  assert.match(help.stdout, /Usage: trail \[global options\]/);
  assert.match(help.stdout, /Global options \(before or after the command\):/);
});
