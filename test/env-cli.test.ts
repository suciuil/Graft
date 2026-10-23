/**
 * The environment-variable commands: each variable graft reads that a person
 * would set has its own command (`graft refresh auto`, `graft files store`, …),
 * and `graft env` lists them and sets one by its name. Run against an in-memory
 * store, so nothing touches the real registry or profile.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { UserEnvStore } from "../src/ai/llm-settings.js";
import {
  ENV_GROUPS,
  ENV_VARS,
  describeValue,
  findEnvVar,
  normalizeEnvValue,
  runEnvGet,
  runEnvList,
  runEnvSet,
  runEnvUnset,
  runVarCommand,
  type EnvDeps,
} from "../src/env-cli.js";

function memoryStore(initial: Record<string, string> = {}): UserEnvStore & { vars: Map<string, string> } {
  const vars = new Map(Object.entries(initial));
  return { vars, where: "test store", read: (n) => vars.get(n), write: (n, v) => (v === undefined ? vars.delete(n) : vars.set(n, v)) };
}

function deps(store = memoryStore(), env: NodeJS.ProcessEnv = {}): EnvDeps & { lines: string[]; errs: string[]; store: ReturnType<typeof memoryStore> } {
  const lines: string[] = [];
  const errs: string[] = [];
  return { store, env, platform: "win32", out: (l) => lines.push(l), err: (l) => errs.push(l), lines, errs };
}

const v = (name: string) => findEnvVar(name)!;

test("every variable has its own command, in a known group, each command once", () => {
  const commands = ENV_VARS.map((x) => x.command);
  assert.equal(new Set(commands).size, commands.length, "no two variables share a command");
  for (const x of ENV_VARS) {
    const [group, sub] = x.command.split(" ");
    if (x.builtin) continue;
    assert.ok(sub, `${x.name}: a group and a subcommand`);
    assert.ok(group! in ENV_GROUPS || group === "api" || group === "prices", `${x.name}: unknown group ${group}`);
    assert.ok(x.title.startsWith(`Show or set ${x.name}`), `${x.name}: its title names the variable`);
    assert.ok(x.help.length > 60, `${x.name}: a real description`);
    assert.ok(x.examples.length >= 1 && x.examples.every((e) => e.startsWith(`graft ${x.command}`)), `${x.name}: examples of its own command`);
  }
});

test("files store: on/off/folder are saved as 1/0/the folder; a relative folder is refused", async () => {
  const d = deps();
  assert.equal(await runVarCommand(v("GRAFT_PROFILE_STORE"), "off", {}, d), 0);
  assert.equal(d.store.vars.get("GRAFT_PROFILE_STORE"), "0");
  assert.match(d.lines.join("\n"), /\$env:GRAFT_PROFILE_STORE = "0"/, "prints the line for this terminal");
  await runVarCommand(v("GRAFT_PROFILE_STORE"), "on", {}, d);
  assert.equal(d.store.vars.get("GRAFT_PROFILE_STORE"), "1");
  if (process.platform === "win32") {
    await runVarCommand(v("GRAFT_PROFILE_STORE"), "D:\\graft-maps", {}, d);
    assert.equal(d.store.vars.get("GRAFT_PROFILE_STORE"), "D:\\graft-maps");
  }
  assert.equal(await runVarCommand(v("GRAFT_PROFILE_STORE"), "maps", {}, d), 1);
  assert.match(d.errs.join("\n"), /absolute folder/);
});

test("a switch is phrased as its feature: refresh auto off saves GRAFT_NO_REFRESH=1, on removes it", async () => {
  const d = deps();
  await runVarCommand(v("GRAFT_NO_REFRESH"), "off", {}, d);
  assert.equal(d.store.vars.get("GRAFT_NO_REFRESH"), "1");
  await runVarCommand(v("GRAFT_NO_REFRESH"), "on", {}, d);
  assert.equal(d.store.vars.has("GRAFT_NO_REFRESH"), false);
});

test("a switch whose default is off: refresh hash on saves hash, agents npx on saves 1", async () => {
  const d = deps();
  await runVarCommand(v("GRAFT_REFRESH"), "on", {}, d);
  assert.equal(d.store.vars.get("GRAFT_REFRESH"), "hash");
  await runVarCommand(v("GRAFT_MCP_NPX"), "yes", {}, d);
  assert.equal(d.store.vars.get("GRAFT_MCP_NPX"), "1");
  await runVarCommand(v("GRAFT_MCP_NPX"), "off", {}, d);
  assert.equal(d.store.vars.has("GRAFT_MCP_NPX"), false);
});

test("a switch shows what graft will do, read the way its code reads the variable", () => {
  assert.match(describeValue(v("GRAFT_NO_REFRESH"), "1"), /^off/);
  assert.match(describeValue(v("GRAFT_NO_REFRESH"), "0"), /^on/, "GRAFT_NO_REFRESH=0 leaves refresh on");
  assert.match(describeValue(v("GRAFT_NO_GATE"), "true"), /^on/, "the gate only stops for exactly 1");
  assert.match(describeValue(v("GRAFT_SYSTEM_CA"), "off"), /^off/);
  assert.match(describeValue(v("GRAFT_REFRESH"), "hash"), /^on/);
  assert.match(describeValue(v("GRAFT_REFRESH"), "1"), /^off/, "only hash turns it on");
});

test("values are checked before saving: url, whole number, choice, absolute path", () => {
  const p = (name: string, raw: string) => normalizeEnvValue(v(name), raw);
  assert.deepEqual(p("GRAFT_BASE_URL", "https://gw.example.com/v1"), { value: "https://gw.example.com/v1" });
  assert.ok("problem" in p("GRAFT_BASE_URL", "ftp://x"));
  assert.deepEqual(p("GRAFT_LLM_RETRIES", "8"), { value: "8" });
  assert.ok("problem" in p("GRAFT_LLM_RETRIES", "-1"));
  assert.ok("problem" in p("GRAFT_LLM_FORCED_RESCUES", "0"), "below its minimum");
  assert.deepEqual(p("GRAFT_PROVIDER", "Anthropic"), { value: "anthropic" });
  assert.ok("problem" in p("GRAFT_PROVIDER", "bedrock"));
  assert.ok("problem" in p("GRAFT_REPOS_FILE", "repos.json"));
  assert.ok("problem" in p("GRAFT_NO_GATE", "maybe"));
});

test("without a value the command shows the variable; --unset removes it; a value and --unset is refused", async () => {
  const d = deps(memoryStore({ GRAFT_DIR: "ctx" }));
  assert.equal(await runVarCommand(v("GRAFT_DIR"), undefined, {}, d), 0);
  assert.match(d.lines.join("\n"), /saved after this terminal started/);
  assert.equal(await runVarCommand(v("GRAFT_DIR"), "x", { unset: true }, d), 1);
  assert.equal(await runVarCommand(v("GRAFT_DIR"), undefined, { unset: true }, d), 0);
  assert.equal(d.store.vars.has("GRAFT_DIR"), false);
});

test("env set/unset by name do what the variable's own command does; unknown names are refused", async () => {
  const d = deps();
  assert.equal(await runEnvSet("graft_no_refresh", "off", d), 0, "names are case-insensitive");
  assert.equal(d.store.vars.get("GRAFT_NO_REFRESH"), "1");
  assert.equal(runEnvUnset("GRAFT_NO_REFRESH", d), 0);
  assert.equal(d.store.vars.has("GRAFT_NO_REFRESH"), false);
  assert.equal(await runEnvSet("PATH", "x", d), 1);
  assert.equal(runEnvUnset("GRAFT_SET_NAME", d), 1, "internal handoffs are not offered");
  assert.equal(await runEnvSet("GRAFT_MODEL", undefined, d), 1, "a value is needed");
  assert.equal(d.store.vars.size, 0);
});

test("no switch that sends data off the machine is offered", () => {
  for (const name of ["TRAIL_NO_LOOK_BACK", "TRAIL_NO_FETCH", "TRAIL_CLOUD", "TRAIL_URL", "GRAFT_BRAIN_URL", "GRAFT_POSTHOG_KEY", "GRAFT_POSTHOG_HOST", "DO_NOT_TRACK"]) {
    assert.equal(findEnvVar(name), undefined, name);
  }
});

test("a secret is shown masked, and asked for hidden in a terminal when no value is given", async () => {
  const d = deps(memoryStore({ GRAFT_API_KEY: "sk-abcdefghijklmnop" }));
  runEnvGet("GRAFT_API_KEY", d);
  runEnvList(d);
  d.prompt = { ask: async () => "", askHidden: async () => "sk-qrstuvwxyz123456" };
  assert.equal(await runEnvSet("GRAFT_API_KEY", undefined, d), 0);
  assert.equal(d.store.vars.get("GRAFT_API_KEY"), "sk-qrstuvwxyz123456");
  const all = d.lines.join("\n");
  assert.doesNotMatch(all, /abcdefghijklmnop|qrstuvwxyz123456/);
  assert.match(all, /<your-secret>/);
});

test("env list names each variable's command; --set keeps only those with a value; --json lists all", () => {
  const d = deps(memoryStore({ GRAFT_MODEL: "m" }), { GRAFT_NO_REFRESH: "1" });
  runEnvList(d, { setOnly: true });
  const text = d.lines.join("\n");
  assert.match(text, /graft model +GRAFT_MODEL = m \(saved, new terminals\)/);
  assert.match(text, /graft refresh auto +GRAFT_NO_REFRESH = off/);
  assert.doesNotMatch(text, /GRAFT_PROFILE_STORE/);

  const j = deps();
  runEnvList(j, { json: true });
  const parsed = JSON.parse(j.lines.join("\n")) as { variables: { name: string; command: string }[] };
  assert.equal(parsed.variables.length, ENV_VARS.length);
  assert.equal(parsed.variables.find((x) => x.name === "GRAFT_PROFILE_STORE")?.command, "graft files store");
});

test("every listed variable is one graft's source actually reads", () => {
  const src = join(process.cwd(), "src");
  const text: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && e.name !== "env-cli.ts" && e.name !== "cli-help-graft.ts") text.push(readFileSync(p, "utf8"));
    }
  };
  walk(src);
  const all = text.join("\n");
  for (const x of ENV_VARS) assert.ok(all.includes(x.name), `${x.name} is not read anywhere in src/`);
});
