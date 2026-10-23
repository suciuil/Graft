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

test("nothing set or saved: the default model is claude-sonnet-5-5", async () => {
  const d = deps({ env: { GRAFT_API_KEY: "k", GRAFT_BASE_URL: "https://gw.example/v1" } });
  assert.equal(await runSettingCommand("model", undefined, {}, d), 0);
  assert.match(d.lines.join("\n"), /in effect:\s+claude-sonnet-5-5 \(graft's default model\)/);
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
