import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySavedSettings,
  withSavedSettings,
  maskSecret,
  parseRegQuery,
  posixUserEnv,
  PromptCancelled,
  runEffortCommand,
  runSettingCommand,
  windowsUserEnv,
  type Prompter,
  type SettingDeps,
  type UserEnvStore,
} from "../src/ai/llm-settings.js";

function memoryStore(initial: Record<string, string> = {}): UserEnvStore & { vars: Map<string, string> } {
  const vars = new Map(Object.entries(initial));
  return {
    vars,
    where: "test store",
    read: (n) => vars.get(n),
    write: (n, v) => (v === undefined ? vars.delete(n) : vars.set(n, v)),
  };
}

function deps(over: Partial<SettingDeps> = {}): SettingDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    store: memoryStore(),
    env: {},
    platform: "linux",
    config: {},
    cwd: mkdtempSync(join(tmpdir(), "graft-settings-")),
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    listModels: async () => ["claude-opus-5", "claude-sonnet-5.5", "gemini-3.8-flash"],
    // Never the network: by default the model takes every level it is asked about.
    probeEfforts: async (_cfg, levels) => ({ results: levels.map((level) => ({ level, verdict: "accepted" as const })) }),
    ...over,
    lines,
  };
}

function scripted(answers: string[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = async (q: string) => {
    asked.push(q);
    const a = answers.shift();
    if (a === undefined) throw new PromptCancelled();
    return a;
  };
  return { asked, ask: next, askHidden: next };
}

test("posix store: values live in a 0600 env file sourced once from the profile", () => {
  const home = mkdtempSync(join(tmpdir(), "graft-home-"));
  writeFileSync(join(home, ".zshrc"), "alias ll='ls -l'\n");
  const store = posixUserEnv({ home, shell: "/bin/zsh", platform: "linux" });
  store.write("GRAFT_API_KEY", "sk-it's-secret");
  store.write("GRAFT_MODEL", "claude-sonnet-5.5");
  store.write("GRAFT_MODEL", "gemini-3.8-flash");

  assert.equal(store.read("GRAFT_API_KEY"), "sk-it's-secret");
  assert.equal(store.read("GRAFT_MODEL"), "gemini-3.8-flash");
  const envFile = join(home, ".graft", "env.sh");
  assert.match(readFileSync(envFile, "utf8"), /export GRAFT_MODEL='gemini-3\.8-flash'/);
  if (process.platform !== "win32") assert.equal(statSync(envFile).mode & 0o777, 0o600);
  const profile = readFileSync(join(home, ".zshrc"), "utf8");
  assert.ok(profile.startsWith("alias ll='ls -l'\n"), "existing profile content is kept");
  assert.equal(profile.split(".graft/env.sh").length - 1, 2, "one hook block (test + source)");
  assert.doesNotMatch(profile, /secret/, "the key never lands in the profile");

  store.write("GRAFT_API_KEY", undefined);
  assert.equal(store.read("GRAFT_API_KEY"), undefined);
  assert.equal(store.read("GRAFT_MODEL"), "gemini-3.8-flash");
});

test("posix store: fish gets a conf.d file and no profile edit", () => {
  const home = mkdtempSync(join(tmpdir(), "graft-home-"));
  const store = posixUserEnv({ home, shell: "/usr/bin/fish", platform: "linux" });
  store.write("GRAFT_BASE_URL", "https://gw.example/v1");
  assert.equal(store.read("GRAFT_BASE_URL"), "https://gw.example/v1");
  assert.match(readFileSync(join(home, ".config", "fish", "conf.d", "graft-env.fish"), "utf8"), /set -gx GRAFT_BASE_URL 'https:\/\/gw\.example\/v1'/);
});

test("windows store: reads reg query output; writes pass the value via env, not argv", () => {
  assert.equal(
    parseRegQuery("\r\nHKEY_CURRENT_USER\\Environment\r\n    GRAFT_MODEL    REG_SZ    claude-sonnet-5.5\r\n\r\n", "GRAFT_MODEL"),
    "claude-sonnet-5.5",
  );
  assert.equal(parseRegQuery("", "GRAFT_MODEL"), undefined);
  const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const store = windowsUserEnv((_c, args, env) => {
    calls.push({ args, env });
    return { status: 0, stdout: "", stderr: "" };
  });
  store.write("GRAFT_API_KEY", "sk-secret-value");
  assert.ok(!calls[0]!.args.join(" ").includes("sk-secret-value"));
  assert.equal(calls[0]!.env?.GRAFT_SET_VALUE, "sk-secret-value");
  store.write("GRAFT_API_KEY", undefined);
  assert.match(calls[1]!.args.join(" "), /\$null/);
});

test("maskSecret never shows the middle of a key", () => {
  assert.equal(maskSecret("short"), "*****");
  assert.equal(maskSecret("sk-abcdefghijklmnop"), "sk-…mnop (19 chars)");
});

test("show without a terminal: status only, nothing saved", async () => {
  const d = deps({ env: { GRAFT_MODEL: "gemini-3.8-flash", GRAFT_API_KEY: "k" } });
  assert.equal(await runSettingCommand("model", undefined, {}, d), 0);
  const out = d.lines.join("\n");
  assert.match(out, /GRAFT_MODEL — model id/);
  assert.match(out, /current:\s+gemini-3\.8-flash/);
  assert.match(out, /saved:\s+not set/);
  assert.match(out, /in effect:\s+gemini-3\.8-flash \(from GRAFT_MODEL\)/);
  assert.equal((d.store as ReturnType<typeof memoryStore>).vars.size, 0);
});

test("set a URL: validated, saved, verified", async () => {
  const d = deps({ env: { GRAFT_API_KEY: "k" } });
  assert.equal(await runSettingCommand("url", "not a url", {}, d), 1);
  assert.equal(await runSettingCommand("url", "https://gw.example/v1", {}, d), 0);
  assert.equal(d.store.read("GRAFT_BASE_URL"), "https://gw.example/v1");
  const out = d.lines.join("\n");
  assert.match(out, /✓ saved GRAFT_BASE_URL = https:\/\/gw\.example\/v1/);
  assert.match(out, /export GRAFT_BASE_URL="https:\/\/gw\.example\/v1"/);
  assert.match(out, /✓ https:\/\/gw\.example\/v1 answered with this key \(3 models listed\)/);
});

test("set a key: masked in output, and a rejected key is reported", async () => {
  const d = deps({
    env: { GRAFT_BASE_URL: "https://gw.example/v1" },
    listModels: async () => {
      throw new Error("401 Incorrect API key provided");
    },
  });
  assert.equal(await runSettingCommand("key", "sk-abcdefghijklmnop", {}, d), 0);
  const out = d.lines.join("\n");
  assert.doesNotMatch(out, /abcdefghijkl/);
  assert.match(out, /saved GRAFT_API_KEY = sk-…mnop/);
  assert.match(out, /rejected the API key/);
});

test("set a model the endpoint does not list: warns with the ones it does", async () => {
  const d = deps({ env: { GRAFT_API_KEY: "k", GRAFT_BASE_URL: "https://gw.example/v1" } });
  await runSettingCommand("model", "no-such-model", {}, d);
  const out = d.lines.join("\n");
  assert.match(out, /no-such-model is not in the models this endpoint lists/);
  assert.match(out, /claude-sonnet-5\.5 {2}\(recommended\)\n.*gemini-3\.8-flash\n.*claude-opus-5.*top tier/);
});

test("set a top-tier model: saved, with a mid-tier suggestion", async () => {
  const d = deps({ env: { GRAFT_API_KEY: "k", GRAFT_BASE_URL: "https://gw.example/v1" } });
  await runSettingCommand("model", "claude-opus-5", {}, d);
  assert.match(d.lines.join("\n"), /a mid-tier model such as claude-sonnet-5\.5 is enough/);
});

test("interactive model: pick by number from the endpoint's list", async () => {
  const prompt = scripted(["2"]);
  const d = deps({ env: { GRAFT_API_KEY: "k", GRAFT_BASE_URL: "https://gw.example/v1" }, prompt });
  assert.equal(await runSettingCommand("model", undefined, { verify: false }, d), 0);
  // ranked: claude-sonnet-5.5, gemini-3.8-flash, claude-opus-5
  assert.equal(d.store.read("GRAFT_MODEL"), "gemini-3.8-flash");
  assert.match(d.lines.join("\n"), /top-tier model .* is not necessary/);
  assert.match(prompt.asked[0]!, /recommended: claude-sonnet-5\.5/);
});

test("a saved model is in effect even when this terminal predates it", async () => {
  // The bug: `graft model` saved GRAFT_MODEL, but a terminal opened earlier lacks
  // it, so "in effect" (and `build --deep`) fell back to graft's default.
  const d = deps({
    store: memoryStore({ GRAFT_MODEL: "gpt-5-6-terra" }),
    env: { GRAFT_API_KEY: "k", GRAFT_BASE_URL: "https://gw.example/v1" },
  });
  assert.equal(await runSettingCommand("model", undefined, {}, d), 0);
  const out = d.lines.join("\n");
  assert.match(out, /current:\s+not set/);
  assert.match(out, /saved:\s+gpt-5-6-terra/);
  assert.match(out, /in effect:\s+gpt-5-6-terra \(from the saved GRAFT_MODEL\)/);
});

test("nothing set or saved: the default model is claude-haiku-5-5", async () => {
  const d = deps({ env: { GRAFT_API_KEY: "k", GRAFT_BASE_URL: "https://gw.example/v1" } });
  assert.equal(await runSettingCommand("model", undefined, {}, d), 0);
  assert.match(d.lines.join("\n"), /in effect:\s+claude-haiku-5-5 \(graft's default model\)/);
});

test("withSavedSettings: fills only what the process lacks; the process value wins", () => {
  const store = memoryStore({ GRAFT_MODEL: "saved-model", GRAFT_API_KEY: "saved-key", GRAFT_BASE_URL: "https://saved" });
  const { env, applied } = withSavedSettings({ GRAFT_MODEL: "shell-model" }, store);
  assert.equal(env.GRAFT_MODEL, "shell-model");
  assert.equal(env.GRAFT_API_KEY, "saved-key");
  assert.equal(env.GRAFT_BASE_URL, "https://saved");
  assert.deepEqual(applied.sort(), ["GRAFT_API_KEY", "GRAFT_BASE_URL"]);
  // Opt-out, used by the test runner.
  const off = withSavedSettings({ GRAFT_NO_SAVED_SETTINGS: "1" }, store);
  assert.equal(off.env.GRAFT_MODEL, undefined);
  assert.deepEqual(off.applied, []);
});

test("applySavedSettings: mutates the given env in place; an unreadable store is ignored", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.deepEqual(applySavedSettings(env, memoryStore({ GRAFT_MODEL: "m" })), ["GRAFT_MODEL"]);
  assert.equal(env.GRAFT_MODEL, "m");
  const broken: UserEnvStore = {
    where: "x",
    read: () => {
      throw new Error("boom");
    },
    write: () => {},
  };
  const env2: NodeJS.ProcessEnv = {};
  assert.deepEqual(applySavedSettings(env2, broken), []);
  assert.equal(env2.GRAFT_MODEL, undefined);
});

test("windows store: readMany reads every name from one reg query", () => {
  const calls: string[][] = [];
  const store = windowsUserEnv((_c, args) => {
    calls.push(args);
    return {
      status: 0,
      stdout: "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\x\r\n    GRAFT_MODEL    REG_SZ    gpt-5-6-terra\r\n\r\n",
      stderr: "",
    };
  });
  assert.deepEqual(store.readMany!(["GRAFT_MODEL", "GRAFT_API_KEY"]), { GRAFT_MODEL: "gpt-5-6-terra" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["query", "HKCU\\Environment"]);
});

test("interactive key: hidden prompt; Enter keeps; Ctrl+C cancels", async () => {
  const keep = deps({ prompt: scripted([""]) });
  assert.equal(await runSettingCommand("key", undefined, {}, keep), 0);
  assert.match(keep.lines.join("\n"), /Kept the current value/);
  const cancel = deps({ prompt: scripted([]) });
  assert.equal(await runSettingCommand("key", undefined, {}, cancel), 130);
  assert.equal(cancel.store.read("GRAFT_API_KEY"), undefined);
});

test("--unset removes the saved value; --list prints models", async () => {
  const d = deps({ store: memoryStore({ GRAFT_MODEL: "x" }), env: { GRAFT_API_KEY: "k" } });
  assert.equal(await runSettingCommand("model", undefined, { unset: true }, d), 0);
  assert.equal(d.store.read("GRAFT_MODEL"), undefined);
  assert.match(d.lines.join("\n"), /unset GRAFT_MODEL/);
  assert.equal(await runSettingCommand("model", "y", { unset: true }, d), 1);
  const l = deps({ env: { GRAFT_API_KEY: "k" } });
  assert.equal(await runSettingCommand("model", undefined, { list: true }, l), 0);
  assert.match(l.lines.join("\n"), /claude-sonnet-5\.5/);
});

// ── thinking effort ──

/** A probe stub: the model takes `accepts` and refuses every other level; records what was asked. */
function probeAccepting(accepts: string[]) {
  const asked: string[][] = [];
  const probeEfforts: SettingDeps["probeEfforts"] = async (_cfg, levels) => {
    asked.push([...levels]);
    return {
      results: levels.map((level) =>
        accepts.includes(level)
          ? { level, verdict: "accepted" as const }
          : { level, verdict: "rejected" as const, detail: `400 reasoning effort '${level}' is not supported` },
      ),
    };
  };
  return { asked, probeEfforts };
}

const ENDPOINT = { GRAFT_API_KEY: "k", GRAFT_BASE_URL: "https://gw.example/v1" };

test("interactive model: after the model, offers only the effort levels it accepts", async () => {
  const probe = probeAccepting(["low", "medium", "high"]);
  const prompt = scripted(["1", "2"]);
  const d = deps({ env: ENDPOINT, prompt, probeEfforts: probe.probeEfforts });
  assert.equal(await runSettingCommand("model", undefined, {}, d), 0);
  assert.equal(d.store.read("GRAFT_MODEL"), "claude-sonnet-5.5");
  // Claude: low…max asked about; xhigh and max refused, so not offered.
  assert.deepEqual(probe.asked, [["low", "medium", "high", "xhigh", "max"]]);
  const out = d.lines.join("\n");
  assert.match(out, /1\. low .*\n.*2\. medium .*\n.*3\. high /);
  assert.doesNotMatch(out, /\d\. (xhigh|max) /);
  assert.equal(d.store.read("GRAFT_REASONING_EFFORT"), "medium");
  assert.match(out, /✓ saved GRAFT_REASONING_EFFORT = medium/);
});

test("interactive model: Ctrl+C at the effort step keeps the model and the effort", async () => {
  const d = deps({ env: ENDPOINT, prompt: scripted(["1"]) });
  assert.equal(await runSettingCommand("model", undefined, {}, d), 0);
  assert.equal(d.store.read("GRAFT_MODEL"), "claude-sonnet-5.5");
  assert.equal(d.store.read("GRAFT_REASONING_EFFORT"), undefined);
  assert.match(d.lines.join("\n"), /Thinking effort unchanged\./);
});

test("interactive model with --no-verify: no effort step, no probe", async () => {
  const probe = probeAccepting(["low"]);
  const d = deps({ env: ENDPOINT, prompt: scripted(["1"]), probeEfforts: probe.probeEfforts });
  assert.equal(await runSettingCommand("model", undefined, { verify: false }, d), 0);
  assert.deepEqual(probe.asked, []);
});

test("model without a terminal: a saved effort the new model refuses is flagged", async () => {
  const probe = probeAccepting(["low", "medium", "high"]);
  const d = deps({
    store: memoryStore({ GRAFT_REASONING_EFFORT: "max" }),
    env: ENDPOINT,
    probeEfforts: probe.probeEfforts,
  });
  assert.equal(await runSettingCommand("model", "gemini-3.8-flash", {}, d), 0);
  assert.deepEqual(probe.asked, [["max"]]);
  assert.match(d.lines.join("\n"), /⚠ gemini-3\.8-flash refused reasoning effort "max"/);
  assert.equal(d.store.read("GRAFT_REASONING_EFFORT"), "max", "nothing is changed without asking");
});

test("model without a terminal and no effort: one hint about graft's default, no probe", async () => {
  const probe = probeAccepting([]);
  const d = deps({ env: ENDPOINT, probeEfforts: probe.probeEfforts });
  assert.equal(await runSettingCommand("model", "claude-sonnet-5.5", {}, d), 0);
  assert.deepEqual(probe.asked, []);
  assert.match(
    d.lines.join("\n"),
    /Thinking effort: graft's default, "high" where the model takes it, else the model's own default\. Pick a level with `graft effort`/,
  );

  // A saved "default" sends no effort: nothing to check either.
  const none = deps({ store: memoryStore({ GRAFT_REASONING_EFFORT: "default" }), env: ENDPOINT, probeEfforts: probe.probeEfforts });
  assert.equal(await runSettingCommand("model", "claude-sonnet-5.5", {}, none), 0);
  assert.deepEqual(probe.asked, []);
  assert.match(none.lines.join("\n"), /Thinking effort: the model's default\. Pick a level with `graft effort`/);
});

test("graft effort status: graft's default while nothing is set; a saved default sends none", async () => {
  const d = deps({ env: ENDPOINT });
  assert.equal(await runEffortCommand(undefined, {}, d), 0);
  assert.match(d.lines.join("\n"), /in effect:\s+not set — graft's default: "high" where the model takes it, else the model's own default/);

  const none = deps({ store: memoryStore({ GRAFT_REASONING_EFFORT: "default" }), env: ENDPOINT });
  assert.equal(await runEffortCommand(undefined, {}, none), 0);
  assert.match(none.lines.join("\n"), /in effect:\s+none sent — the model's own default \(from the saved GRAFT_REASONING_EFFORT\)/);
});

test("interactive graft effort with nothing set: high is marked graft's default; a model without high gets a note", async () => {
  const env = { ...ENDPOINT, GRAFT_MODEL: "claude-sonnet-5.5" };
  const keep = deps({ env, prompt: scripted([""]), probeEfforts: probeAccepting(["low", "medium", "high"]).probeEfforts });
  assert.equal(await runEffortCommand(undefined, {}, keep), 0);
  const out = keep.lines.join("\n");
  assert.match(out, /high — .*\(current, graft's default\)/);
  assert.doesNotMatch(out, /0\. default .*\(current\)/);
  assert.equal(keep.store.read("GRAFT_REASONING_EFFORT"), undefined, "Enter keeps graft's default: nothing saved");

  const noHigh = deps({ env, prompt: scripted([""]), probeEfforts: probeAccepting(["low"]).probeEfforts });
  assert.equal(await runEffortCommand(undefined, {}, noHigh), 0);
  assert.match(noHigh.lines.join("\n"), /note: claude-sonnet-5\.5 does not take graft's default "high"/);
  assert.doesNotMatch(noHigh.lines.join("\n"), /⚠/);

  const unset = deps({ env, store: memoryStore({ GRAFT_REASONING_EFFORT: "low" }), prompt: scripted(["unset"]), probeEfforts: probeAccepting(["low"]).probeEfforts });
  assert.equal(await runEffortCommand(undefined, {}, unset), 0);
  assert.equal(unset.store.read("GRAFT_REASONING_EFFORT"), undefined, "typing unset goes back to graft's default");
});

test("graft effort <level>: saved when the model accepts it, refused otherwise", async () => {
  const probe = probeAccepting(["low", "high"]);
  const d = deps({ env: { ...ENDPOINT, GRAFT_MODEL: "gpt-5-6-terra" }, probeEfforts: probe.probeEfforts });
  assert.equal(await runEffortCommand("High", {}, d), 0);
  assert.equal(d.store.read("GRAFT_REASONING_EFFORT"), "high");
  assert.match(d.lines.join("\n"), /✓ gpt-5-6-terra accepts reasoning effort "high"/);
  assert.match(d.lines.join("\n"), /export GRAFT_REASONING_EFFORT="high"/);

  assert.equal(await runEffortCommand("minimal", {}, d), 1);
  assert.equal(d.store.read("GRAFT_REASONING_EFFORT"), "high", "a refused level is not saved");
  assert.match(d.lines.join("\n"), /✗ gpt-5-6-terra refused reasoning effort "minimal".*nothing saved/);

  assert.equal(await runEffortCommand("minimal", { verify: false }, d), 0, "--no-verify saves without asking");
  assert.equal(d.store.read("GRAFT_REASONING_EFFORT"), "minimal");
  assert.deepEqual(probe.asked, [["high"], ["minimal"]]);
});

test("graft effort: aliases, default, --unset, and bad names", async () => {
  const d = deps({ env: ENDPOINT });
  assert.equal(await runEffortCommand("off", {}, d), 0);
  assert.equal(d.store.read("GRAFT_REASONING_EFFORT"), "none");
  // "default" is saved as is: send no effort, unlike removing it (graft's default, high).
  assert.equal(await runEffortCommand("default", {}, d), 0);
  assert.equal(d.store.read("GRAFT_REASONING_EFFORT"), "default");
  assert.match(d.lines.join("\n"), /sends no effort; the model uses its own default/);
  assert.equal(await runEffortCommand("high", {}, d), 0);
  assert.equal(await runEffortCommand("low", { unset: true }, d), 1, "a level and --unset together");
  assert.equal(await runEffortCommand(undefined, { unset: true }, d), 0);
  assert.equal(d.store.read("GRAFT_REASONING_EFFORT"), undefined);
  assert.match(d.lines.join("\n"), /uses graft's default: "high" where the model takes it/);
  assert.equal(await runEffortCommand("low", {}, d), 0);
  assert.equal(await runEffortCommand("unset", {}, d), 0, "the word unset is --unset");
  assert.equal(d.store.read("GRAFT_REASONING_EFFORT"), undefined);
  assert.equal(await runEffortCommand("very much", {}, d), 1);
  assert.match(d.lines.join("\n"), /"very much" is not a level name/);
});

test("graft effort without an API key: saved, marked not verified, no probe", async () => {
  const probe = probeAccepting([]);
  const d = deps({ env: { GRAFT_BASE_URL: "https://gw.example/v1" }, probeEfforts: probe.probeEfforts });
  assert.equal(await runEffortCommand("low", {}, d), 0);
  assert.equal(d.store.read("GRAFT_REASONING_EFFORT"), "low");
  assert.deepEqual(probe.asked, []);
  assert.match(d.lines.join("\n"), /not verified: no API key yet/);
});

test("graft effort --list: asks the model and marks each level", async () => {
  const probe = probeAccepting(["low", "medium"]);
  const d = deps({ env: { ...ENDPOINT, GRAFT_MODEL: "o4-mini" }, probeEfforts: probe.probeEfforts });
  assert.equal(await runEffortCommand(undefined, { list: true }, d), 0);
  assert.deepEqual(probe.asked, [["low", "medium", "high"]]);
  const out = d.lines.join("\n");
  assert.match(out, /low\s+✓ accepted/);
  assert.match(out, /high\s+✗ refused/);

  const broken = deps({
    env: ENDPOINT,
    probeEfforts: async (_c, levels) => ({
      baselineError: "401 invalid key",
      results: levels.map((level) => ({ level, verdict: "unknown" as const })),
    }),
  });
  assert.equal(await runEffortCommand(undefined, { list: true }, broken), 1);
  assert.match(broken.lines.join("\n"), /could not ask .*401 invalid key/);
});

test("graft effort without a terminal: status only, nothing asked or saved", async () => {
  const d = deps({ store: memoryStore({ GRAFT_REASONING_EFFORT: "high" }), env: ENDPOINT });
  assert.equal(await runEffortCommand(undefined, {}, d), 0);
  const out = d.lines.join("\n");
  assert.match(out, /saved:\s+high/);
  assert.match(out, /in effect:\s+high \(from the saved GRAFT_REASONING_EFFORT\)/);
});

test("interactive graft effort: pick by number or name; 0 is the model's default; Ctrl+C cancels", async () => {
  const probe = probeAccepting(["low", "medium", "high"]);
  const env = { ...ENDPOINT, GRAFT_MODEL: "claude-sonnet-5.5" };
  const pick = deps({ env, prompt: scripted(["3"]), probeEfforts: probe.probeEfforts });
  assert.equal(await runEffortCommand(undefined, {}, pick), 0);
  assert.equal(pick.store.read("GRAFT_REASONING_EFFORT"), "high");

  const refused = deps({ env, prompt: scripted(["max"]), probeEfforts: probe.probeEfforts });
  assert.equal(await runEffortCommand(undefined, {}, refused), 1);
  assert.match(refused.lines.join("\n"), /does not accept "max"/);

  const clear = deps({ env, store: memoryStore({ GRAFT_REASONING_EFFORT: "low" }), prompt: scripted(["0"]), probeEfforts: probe.probeEfforts });
  assert.equal(await runEffortCommand(undefined, {}, clear), 0);
  assert.equal(clear.store.read("GRAFT_REASONING_EFFORT"), "default");

  const cancel = deps({ env, prompt: scripted([]), probeEfforts: probe.probeEfforts });
  assert.equal(await runEffortCommand(undefined, {}, cancel), 130);
});
