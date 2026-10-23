/**
 * The top-level help has to answer "how do I use --model?": global options
 * configure a command and never run anything alone, and the LLM options belong
 * to `build --deep`. `graft --model x` used to dump the whole help as an error.
 */
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

  const heads = help.stdout.split("\n").filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim().split(" ")[0]!);
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
  assert.doesNotMatch(entry("upgrade"), /--dir|Options:/, "no options listed where none apply");

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

test("an unknown command prints the error, the suggestion, then the full help — on stderr, exit 1", () => {
  const r = runCli(["buld"]);
  assert.equal(r.status, 1, r.describe());
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^error: unknown command 'buld'\n\(Did you mean build\?\)\n\nCommands:\n/);
  assert.equal(r.stderr.slice(r.stderr.indexOf("Commands:")), runCli(["--help"]).stdout, "the same help as graft --help");

  const group = runCli(["api", "nope"]);
  assert.equal(group.status, 1, group.describe());
  assert.match(group.stderr, /^error: unknown command 'nope'\n\n {2}graft api [a-z-]+ /, "a group shows its own commands");
  assert.match(group.stderr, /^ {2}graft api key /m, "api key among them");

  const missing = runCli(["ask"]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr.trim(), "error: missing required argument 'query'", "other errors stay one line");
});

test("trail keeps its grouped help", () => {
  const help = runCli(["--help"], { env: { TRAIL_INVOKED_AS: "trail" } });
  assert.equal(help.status, 0, help.describe());
  assert.match(help.stdout, /Usage: trail \[global options\]/);
  assert.match(help.stdout, /Global options \(before or after the command\):/);
});
