/**
 * `graft api url`, `graft api key`, `graft model`, `graft effort`: show, pick,
 * and persist the settings `graft build --deep` uses (GRAFT_BASE_URL,
 * GRAFT_API_KEY, GRAFT_MODEL, and the optional GRAFT_REASONING_EFFORT) as USER
 * environment variables, so every new terminal, IDE and
 * MCP host sees them — not just the current shell, which a child process can
 * never change.
 *
 * Where "user environment" lives:
 *   - Windows: HKCU\Environment, written through .NET so Explorer is told to
 *     reload it (new terminals see it without a logoff).
 *   - macOS/Linux: `~/.graft/env.sh` (mode 600, because it can hold the key),
 *     sourced from the shell's profile by one marked block; fish gets
 *     `~/.config/fish/conf.d/graft-env.fish` instead, which fish sources itself.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { resolveConfig, type EngineConfig, type ResolvedConfig } from "./providers.js";
import {
  classifyLlmError,
  defaultBaseUrl,
  envSetExample,
  EXAMPLE_MODELS,
  isTopTierModel,
  listEndpointModels,
  rankModelsForHint,
  settingSource,
  SETTINGS,
  shortError,
  suggestModel,
  type SettingKind,
} from "./llm-hints.js";
import { bareModelFallbacks } from "./llm/factory.js";
import { databricksTokenHint } from "./llm/databricks.js";
import {
  candidateEfforts,
  describeEffort,
  EFFORT_LEVELS,
  isEffortName,
  normalizeEffort,
  REASONING_EFFORT_ENV,
  DEFAULT_REASONING_EFFORT,
  MODEL_DEFAULT_EFFORT,
} from "./llm/effort.js";
import { acceptedEfforts, probeEfforts, type EffortProbe } from "./llm-effort.js";
import { cmd } from "../brand.js";

// ---------------------------------------------------------------------------
// Persistent user environment
// ---------------------------------------------------------------------------

export interface UserEnvStore {
  /** Human-readable location, e.g. `HKCU\Environment` or `~/.graft/env.sh`. */
  readonly where: string;
  read(name: string): string | undefined;
  /** Several variables in one lookup (one `reg query` on Windows); falls back to {@link read} per name when absent. */
  readMany?(names: readonly string[]): Record<string, string>;
  /** `undefined` removes the variable. */
  write(name: string, value: string | undefined): void;
}

/** The variables `graft api url` / `graft api key` / `graft model` / `graft effort` save. */
export const SAVED_SETTING_NAMES = ["GRAFT_BASE_URL", "GRAFT_API_KEY", "GRAFT_MODEL", REASONING_EFFORT_ENV] as const;

/** Set in the environment to ignore saved settings (the test runner sets it, so a developer's own setup never leaks in). */
export const NO_SAVED_SETTINGS_ENV = "GRAFT_NO_SAVED_SETTINGS";

/** The saved values of `names`; a store that cannot be read yields nothing. */
export function readSaved(store: UserEnvStore, names: readonly string[]): Record<string, string> {
  try {
    if (store.readMany) return store.readMany(names);
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const name of names) {
    try {
      const v = store.read(name);
      if (v !== undefined && v !== "") out[name] = v;
    } catch {
      // unreadable: treated as not saved
    }
  }
  return out;
}

/**
 * `env` with every saved setting it does not define filled in from `store`.
 *
 * A saved setting reaches new terminals only: one opened before `graft model`
 * ran (or an IDE that was not restarted) still lacks it, and graft silently fell
 * back to its default model even though `graft model` reported the saved value.
 * A value this process does define (shell, `.env`) still wins, exactly as it
 * would in a fresh terminal.
 */
export function withSavedSettings(
  env: NodeJS.ProcessEnv,
  store: UserEnvStore,
): { env: NodeJS.ProcessEnv; applied: string[] } {
  if (env[NO_SAVED_SETTINGS_ENV]) return { env, applied: [] };
  const missing = SAVED_SETTING_NAMES.filter((n) => !env[n]);
  if (missing.length === 0) return { env, applied: [] };
  const saved = readSaved(store, missing);
  const applied = missing.filter((n) => saved[n]);
  if (applied.length === 0) return { env, applied };
  const next: NodeJS.ProcessEnv = { ...env };
  for (const n of applied) next[n] = saved[n];
  return { env: next, applied };
}

/** Fill this process's environment from the saved settings, in place; best effort. */
export function applySavedSettings(env: NodeJS.ProcessEnv = process.env, store?: UserEnvStore): string[] {
  if (env[NO_SAVED_SETTINGS_ENV]) return [];
  try {
    const { env: filled, applied } = withSavedSettings(env, store ?? userEnvStore());
    for (const n of applied) env[n] = filled[n];
    return applied;
  } catch {
    return [];
  }
}

export type Runner = (
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => { status: number | null; stdout: string; stderr: string };

const defaultRunner: Runner = (command, args, env) => {
  const r = spawnSync(command, args, { encoding: "utf8", env: env ?? process.env, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") };
};

/** The value of `name` in `reg query HKCU\Environment /v <name>` output. */
export function parseRegQuery(output: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^\\s*${escaped}\\s+REG_(?:EXPAND_)?SZ\\s+(.*?)\\s*$`, "im").exec(output);
  return m ? m[1] : undefined;
}

/** Windows: the user's registry environment. */
export function windowsUserEnv(run: Runner = defaultRunner): UserEnvStore {
  return {
    where: "user environment variables (HKCU\\Environment)",
    read(name) {
      const r = run("reg", ["query", "HKCU\\Environment", "/v", name]);
      return r.status === 0 ? parseRegQuery(r.stdout, name) : undefined;
    },
    readMany(names) {
      const r = run("reg", ["query", "HKCU\\Environment"]);
      const out: Record<string, string> = {};
      if (r.status !== 0) return out;
      for (const name of names) {
        const v = parseRegQuery(r.stdout, name);
        if (v !== undefined && v !== "") out[name] = v;
      }
      return out;
    },
    write(name, value) {
      // Name and value travel in the child's environment, never on its command line,
      // so an API key does not show up in a process listing.
      const script =
        value === undefined
          ? "[Environment]::SetEnvironmentVariable($env:GRAFT_SET_NAME, $null, 'User')"
          : "[Environment]::SetEnvironmentVariable($env:GRAFT_SET_NAME, $env:GRAFT_SET_VALUE, 'User')";
      const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        ...process.env,
        GRAFT_SET_NAME: name,
        GRAFT_SET_VALUE: value ?? "",
      });
      if (r.status !== 0) throw new Error(`could not update the user environment: ${r.stderr.trim() || `exit ${r.status}`}`);
    },
  };
}

const BLOCK_START = "# >>> graft: LLM settings (graft api url / api key / model) >>>";
const BLOCK_END = "# <<< graft: LLM settings <<<";

function shQuote(v: string): string {
  return `'${v.replace(/'/g, `'"'"'`)}'`;
}

function fishQuote(v: string): string {
  return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** The shell profile that sources `~/.graft/env.sh` for `shell`. */
export function profileFor(home: string, shell: string | undefined, platform: NodeJS.Platform): string {
  const name = basename(shell ?? "");
  if (name === "zsh") return join(home, ".zshrc");
  if (name === "bash") return join(home, platform === "darwin" ? ".bash_profile" : ".bashrc");
  return join(home, ".profile");
}

function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort: a filesystem without POSIX modes still gets the file.
  }
}

/**
 * macOS/Linux: an env file graft owns, plus one hook block in the profile.
 * Keeping the values out of the profile keeps the key out of a world-readable file.
 */
export function posixUserEnv(opts: { home?: string; shell?: string; platform?: NodeJS.Platform } = {}): UserEnvStore {
  const home = opts.home ?? homedir();
  const shell = opts.shell ?? process.env.SHELL;
  const platform = opts.platform ?? process.platform;
  const fish = basename(shell ?? "") === "fish";
  const file = fish ? join(home, ".config", "fish", "conf.d", "graft-env.fish") : join(home, ".graft", "env.sh");
  const profile = profileFor(home, shell, platform);
  const lineRe = fish ? /^set -gx ([A-Za-z_][A-Za-z0-9_]*) (.*)$/ : /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

  const readAll = (): Map<string, string> => {
    const vars = new Map<string, string>();
    if (!existsSync(file)) return vars;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = lineRe.exec(line.trim());
      if (m) vars.set(m[1]!, unquote(m[2]!, fish));
    }
    return vars;
  };

  const ensureHook = () => {
    if (fish) return; // conf.d is sourced by fish itself
    const current = existsSync(profile) ? readFileSync(profile, "utf8") : "";
    if (current.includes(BLOCK_START)) return;
    const hook = `${BLOCK_START}\n[ -f "$HOME/.graft/env.sh" ] && . "$HOME/.graft/env.sh"\n${BLOCK_END}\n`;
    const sep = current === "" || current.endsWith("\n") ? "" : "\n";
    writeFileSync(profile, `${current}${sep}${current ? "\n" : ""}${hook}`);
  };

  return {
    where: fish ? file.replace(home, "~") : `${file.replace(home, "~")} (sourced from ${profile.replace(home, "~")})`,
    read: (name) => readAll().get(name),
    readMany(names) {
      const vars = readAll();
      const out: Record<string, string> = {};
      for (const name of names) {
        const v = vars.get(name);
        if (v !== undefined && v !== "") out[name] = v;
      }
      return out;
    },
    write(name, value) {
      const vars = readAll();
      if (value === undefined) vars.delete(name);
      else vars.set(name, value);
      const header = "# Written by `graft env`, `graft api url` / `graft api key` / `graft model`. Edit with those commands.\n";
      const body = [...vars]
        .map(([k, v]) => (fish ? `set -gx ${k} ${fishQuote(v)}` : `export ${k}=${shQuote(v)}`))
        .join("\n");
      writePrivate(file, `${header}${body}${body ? "\n" : ""}`);
      ensureHook();
    },
  };
}

function unquote(raw: string, fish: boolean): string {
  const v = raw.trim();
  if (fish) {
    if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/\\(['\\])/g, "$1");
    return v;
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/'"'"'/g, "'");
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

export function userEnvStore(platform: NodeJS.Platform = process.platform): UserEnvStore {
  return platform === "win32" ? windowsUserEnv() : posixUserEnv({ platform });
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export class PromptCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

export interface Prompter {
  ask(question: string): Promise<string>;
  /** Input is not echoed (API keys). */
  askHidden(question: string): Promise<string>;
}

/** A readline prompter on the real terminal; Ctrl+C cancels. */
export function terminalPrompter(): Prompter {
  const once = async (question: string, hidden: boolean): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const cancel = new Promise<never>((_, reject) => {
      rl.on("SIGINT", () => {
        process.stdout.write("\n");
        reject(new PromptCancelled());
      });
      rl.on("close", () => reject(new PromptCancelled()));
    });
    if (hidden) {
      process.stdout.write(question);
      // readline echoes through _writeToOutput; swallowing it hides the key as typed.
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (/[\r\n]/.test(s)) process.stdout.write("\n");
      };
    }
    try {
      return await Promise.race([rl.question(hidden ? "" : question), cancel]);
    } finally {
      rl.removeAllListeners("close");
      rl.close();
    }
  };
  return { ask: (q) => once(q, false), askHidden: (q) => once(q, true) };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface SettingDeps {
  store: UserEnvStore;
  /** The current process environment (this terminal). */
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Global CLI flags (`--base-url`, `--api-key`, `--model`, `--provider`). */
  config: EngineConfig;
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Absent when stdin/stdout is not a terminal: nothing is asked. */
  prompt?: Prompter;
  listModels?: (cfg: ResolvedConfig) => Promise<string[]>;
  /** Asks the endpoint which effort levels the model accepts (tests inject a stub). */
  probeEfforts?: (cfg: ResolvedConfig, levels: readonly string[]) => Promise<EffortProbe>;
}

export interface SettingOptions {
  unset?: boolean;
  /** Default true: one `GET /models` after saving. */
  verify?: boolean;
  /** `graft model --list`: print the endpoint's models and stop. */
  list?: boolean;
}

const DESCRIPTION: Record<SettingKind, string> = {
  url: "base URL of the LLM endpoint used by `graft build --deep`",
  key: "API key for the LLM endpoint used by `graft build --deep`",
  model: "model id used by `graft build --deep`",
};

export function maskSecret(v: string): string {
  if (v.length <= 8) return "*".repeat(v.length);
  return `${v.slice(0, 3)}…${v.slice(-4)} (${v.length} chars)`;
}

const show = (kind: SettingKind, v: string | undefined) => (v === undefined || v === "" ? "not set" : kind === "key" ? maskSecret(v) : v);

/** A `.env` in the working directory that also defines `name` (dotenv never overrides a real env var). */
function dotenvDefines(cwd: string, name: string): boolean {
  const p = join(cwd, ".env");
  if (!existsSync(p)) return false;
  try {
    return new RegExp(`^\\s*(export\\s+)?${name}\\s*=`, "m").test(readFileSync(p, "utf8"));
  } catch {
    return false;
  }
}

function validate(kind: SettingKind, value: string): string | null {
  if (value.trim() === "") return "the value is empty";
  if (/\s/.test(value.trim()) && kind !== "key") return "the value contains spaces";
  if (kind === "url") {
    try {
      const u = new URL(value);
      if (u.protocol !== "http:" && u.protocol !== "https:") return `"${value}" is not an http(s) URL`;
    } catch {
      return `"${value}" is not a valid URL (expected e.g. https://my-gateway.example.com/v1)`;
    }
  }
  return null;
}

/** `env` as `graft build --deep` sees it: the saved settings fill what this process does not set. */
function effectiveEnv(deps: SettingDeps, env: NodeJS.ProcessEnv = deps.env): NodeJS.ProcessEnv {
  return withSavedSettings(env, deps.store).env;
}

/** What `build --deep` would use right now, and where it comes from. */
function effective(kind: SettingKind, deps: SettingDeps, env: NodeJS.ProcessEnv): string {
  const { env: full, applied } = withSavedSettings(env, deps.store);
  const cfg = resolveConfig(deps.config, full);
  const s = settingSource(kind, deps.config, cfg, full);
  const savedNote = s.env && applied.includes(s.env) ? `saved ${s.env}` : "";
  const from = s.flag ? `from ${s.flag}` : savedNote ? `from the ${savedNote}` : s.env ? `from ${s.env}` : "";
  if (kind === "url") {
    return from ? `${cfg.baseUrl} (${from})` : `${cfg.baseUrl ?? defaultBaseUrl(cfg.provider)} (graft's default for the ${cfg.provider} provider)`;
  }
  if (kind === "key") return cfg.apiKey ? `${maskSecret(cfg.apiKey)} (${from || "from the environment"})` : "none — `graft build --deep` falls back to the structural build";
  return from ? `${cfg.model} (${from})` : `${cfg.model} (graft's default model)`;
}

function printStatus(kind: SettingKind, deps: SettingDeps, saved: string | undefined): void {
  const name = SETTINGS[kind].env;
  deps.out(`${name} — ${DESCRIPTION[kind]}`);
  deps.out(`  current:       ${show(kind, deps.env[name])}  [this process: shell environment or ./.env]`);
  deps.out(`  saved:         ${show(kind, saved)}  [${deps.store.where}]`);
  deps.out(`  in effect:     ${effective(kind, deps, deps.env)}`);
}

async function fetchModels(deps: SettingDeps, cfg: ResolvedConfig): Promise<{ ids: string[]; error?: string }> {
  if (!cfg.apiKey) {
    const where = cfg.databricks ? `; ${databricksTokenHint()}` : "";
    return { ids: [], error: `no API key — set one with \`${cmd(SETTINGS.key.command)}\`${where}` };
  }
  try {
    return { ids: rankModelsForHint(await (deps.listModels ?? listEndpointModels)(cfg)) };
  } catch (err) {
    return { ids: [], error: shortError(err) };
  }
}

const TOP_TIER_NOTE =
  "A top-tier model (Claude Opus, GPT astra/sol, Gemini Pro, …) is not necessary: summaries work well with a mid-tier model, which is cheaper and faster.";

function printModelList(deps: SettingDeps, ids: string[], numbered: boolean): void {
  const recommended = suggestModel(ids);
  ids.forEach((id, i) => {
    const tag = id === recommended ? "  (recommended)" : isTopTierModel(id) ? "  (top tier — not needed)" : "";
    deps.out(numbered ? `  ${String(i + 1).padStart(3)}. ${id}${tag}` : `  ${id}${tag}`);
  });
}

/** Interactive input for `kind`; `undefined` = keep the current value. */
async function promptFor(kind: SettingKind, deps: SettingDeps, prompt: Prompter): Promise<string | undefined> {
  if (kind === "key") {
    if (resolveConfig(deps.config, effectiveEnv(deps)).databricks) deps.out(`${databricksTokenHint()}.`);
    const v = (await prompt.askHidden("New API key (input hidden; Enter keeps the current one): ")).trim();
    return v || undefined;
  }
  if (kind === "url") {
    const v = (await prompt.ask("New base URL, e.g. https://my-gateway.example.com/v1 (Enter keeps the current one): ")).trim();
    return v || undefined;
  }
  const cfg = resolveConfig(deps.config, effectiveEnv(deps));
  deps.out(`Asking ${cfg.baseUrl ?? defaultBaseUrl(cfg.provider)} which models it serves…`);
  const { ids, error } = await fetchModels(deps, cfg);
  if (ids.length > 0) {
    deps.out(`Models it serves (mid-tier first):`);
    printModelList(deps, ids, true);
    deps.out(TOP_TIER_NOTE);
    const suggestion = suggestModel(ids);
    const v = (await prompt.ask(`Pick a number or type a model id${suggestion ? ` (recommended: ${suggestion})` : ""}; Enter keeps the current one: `)).trim();
    if (!v) return undefined;
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= ids.length) return ids[n - 1];
    return v;
  }
  deps.out(`Could not list the endpoint's models (${error}).`);
  deps.out(`Type a model id it serves — for example ${EXAMPLE_MODELS.join(", ")} (some gateways need a prefix such as anthropic/ or google/).`);
  deps.out(TOP_TIER_NOTE);
  const v = (await prompt.ask("Model id (Enter keeps the current one): ")).trim();
  return v || undefined;
}

/** One cheap `GET /models` with the new value in place; warnings only, the value is saved either way. */
async function verifySetting(kind: SettingKind, deps: SettingDeps, env: NodeJS.ProcessEnv): Promise<void> {
  const cfg = resolveConfig(deps.config, effectiveEnv(deps, env));
  const url = cfg.baseUrl ?? defaultBaseUrl(cfg.provider);
  if (!cfg.apiKey) {
    deps.out(`  not verified: no API key yet — set one with \`${cmd(SETTINGS.key.command)}\`.`);
    if (cfg.databricks) deps.out(`  ${databricksTokenHint()}.`);
    return;
  }
  let ids: string[];
  try {
    ids = await (deps.listModels ?? listEndpointModels)(cfg);
  } catch (err) {
    const message = shortError(err);
    const problem = classifyLlmError(message);
    if (problem === "auth") {
      deps.err(`⚠ ${url} rejected the API key (${message}) — set a valid one with \`${cmd(SETTINGS.key.command)}\`.`);
      if (cfg.databricks) deps.err(`  ${databricksTokenHint()}.`);
    } else if (problem === "unreachable" && !/^40[45]\b/.test(message)) {
      deps.err(`⚠ ${url} could not be reached (${message}) — check it with \`${cmd(SETTINGS.url.command)}\`.`);
    } else {
      deps.out(`  not verified: ${url} did not list its models (${message}); that is common for gateways and not an error.`);
    }
    return;
  }
  deps.out(`  ✓ ${url} answered with this key (${ids.length} models listed).`);
  if (kind !== "model") return;
  const candidates = [cfg.model, ...(bareModelFallbacks(cfg.model) ?? [])];
  if (ids.some((id) => candidates.includes(id))) {
    deps.out(`  ✓ ${cfg.model} is served by this endpoint.`);
    if (isTopTierModel(cfg.model)) {
      const mid = suggestModel(rankModelsForHint(ids));
      if (mid && !isTopTierModel(mid)) deps.out(`  note: a mid-tier model such as ${mid} is enough for summaries, and cheaper.`);
    }
  } else {
    const ranked = rankModelsForHint(ids);
    deps.err(`⚠ ${cfg.model} is not in the models this endpoint lists. Some it does serve:`);
    printModelList(deps, ranked.slice(0, 15), false);
    deps.err(`  Run \`${cmd(SETTINGS.model.command)}\` to pick one.`);
  }
}

/**
 * The whole command: show, prompt (interactive), set or unset, then verify.
 * Returns the process exit code.
 */
export async function runSettingCommand(
  kind: SettingKind,
  valueArg: string | undefined,
  opts: SettingOptions,
  deps: SettingDeps,
): Promise<number> {
  const name = SETTINGS[kind].env;
  const command = cmd(SETTINGS[kind].command);

  if (opts.list) {
    const cfg = resolveConfig(deps.config, effectiveEnv(deps));
    const { ids, error } = await fetchModels(deps, cfg);
    if (ids.length === 0) {
      deps.err(`✗ could not list the models of ${cfg.baseUrl ?? defaultBaseUrl(cfg.provider)}: ${error ?? "it listed none"}`);
      deps.err(`  Examples of model ids: ${EXAMPLE_MODELS.join(", ")}. ${TOP_TIER_NOTE}`);
      return 1;
    }
    printModelList(deps, ids, false);
    deps.out(TOP_TIER_NOTE);
    return 0;
  }

  if (opts.unset && valueArg !== undefined) {
    deps.err(`${command}: pass a value or --unset, not both`);
    return 1;
  }

  let saved: string | undefined;
  try {
    saved = deps.store.read(name);
  } catch {
    saved = undefined;
  }

  let value = valueArg;
  if (!opts.unset && value === undefined) {
    printStatus(kind, deps, saved);
    if (!deps.prompt) {
      deps.out(`Set it with \`${command} <${kind === "url" ? "url" : kind === "key" ? "key" : "id"}>\`${kind === "key" ? " (or run it in a terminal to type the key hidden)" : ""}, remove it with \`${command} --unset\`.`);
      return 0;
    }
    deps.out("");
    try {
      value = await promptFor(kind, deps, deps.prompt);
    } catch (err) {
      if (err instanceof PromptCancelled) {
        deps.out("Cancelled — nothing changed.");
        return 130;
      }
      throw err;
    }
    if (value === undefined) {
      deps.out("Kept the current value.");
      return 0;
    }
  }

  if (value !== undefined) {
    value = value.trim();
    const problem = validate(kind, value);
    if (problem) {
      deps.err(`✗ ${command}: ${problem}`);
      return 1;
    }
  }

  try {
    deps.store.write(name, opts.unset ? undefined : value);
  } catch (err) {
    deps.err(`✗ ${command}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (opts.unset) {
    deps.out(`✓ removed ${name} from ${deps.store.where}.`);
  } else {
    deps.out(`✓ saved ${name} = ${show(kind, value)} to ${deps.store.where}.`);
  }
  deps.out(
    `  New terminals see it; restart your IDE so its terminals and MCP servers do too. For this terminal run:`,
  );
  deps.out(
    `    ${opts.unset ? (deps.platform === "win32" ? `Remove-Item Env:${name}` : `unset ${name}`) : envSetExample(name, kind === "key" ? "<your-api-key>" : value!, deps.platform)}`,
  );
  if (dotenvDefines(deps.cwd, name)) {
    deps.out(`  note: ./.env also sets ${name}; an environment variable takes precedence over it.`);
  }
  const flagValue = kind === "url" ? deps.config.baseUrl : kind === "key" ? deps.config.apiKey : deps.config.model;
  if (flagValue) deps.out(`  note: ${SETTINGS[kind].flag} on this command line overrides ${name}.`);

  if (opts.verify !== false && !opts.unset) {
    const env: NodeJS.ProcessEnv = { ...deps.env, [name]: value };
    deps.out("Checking the endpoint…");
    await verifySetting(kind, deps, env);
    // A new model takes its own set of effort levels: offer them now, or check the saved one still fits.
    if (kind === "model") await effortAfterModelChange(deps, env);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Thinking effort: `graft effort`, and the last step of `graft model`
// ---------------------------------------------------------------------------

const EFFORT_COMMAND = "graft effort";

type EffortChoice = { action: "keep" } | { action: "invalid" } | { action: "set"; level: string | undefined };

function readSavedValue(store: UserEnvStore, name: string): string | undefined {
  try {
    return store.read(name);
  } catch {
    return undefined;
  }
}

/** What graft does with no effort set, in words. */
const GRAFT_DEFAULT_EFFORT_TEXT = `"${DEFAULT_REASONING_EFFORT}" where the model takes it, else the model's own default`;

/**
 * The effort `build --deep` would use with `env` (undefined: none sent), where
 * it comes from, whether it is graft's default rather than the user's choice,
 * and the config it resolves to.
 */
function effortInEffect(
  deps: SettingDeps,
  env: NodeJS.ProcessEnv = deps.env,
): { level?: string; from: string; defaulted: boolean; cfg: ResolvedConfig } {
  const { env: full, applied } = withSavedSettings(env, deps.store);
  const cfg = resolveConfig(deps.config, full);
  const defaulted = !!cfg.reasoningEffortDefaulted;
  const from = defaulted
    ? "graft's default"
    : deps.config.reasoningEffort !== undefined
      ? "the config"
      : applied.includes(REASONING_EFFORT_ENV)
        ? `the saved ${REASONING_EFFORT_ENV}`
        : REASONING_EFFORT_ENV;
  return { level: cfg.reasoningEffort, from, defaulted, cfg };
}

function effortCandidates(cfg: ResolvedConfig): string[] {
  return candidateEfforts(cfg.model, cfg.provider === "anthropic" ? "anthropic" : "openai");
}

function runEffortProbe(deps: SettingDeps, cfg: ResolvedConfig, levels: readonly string[]): Promise<EffortProbe> {
  return (deps.probeEfforts ?? probeEfforts)(cfg, levels);
}

function printEffortStatus(deps: SettingDeps, saved: string | undefined): void {
  const { level, from, defaulted, cfg } = effortInEffect(deps);
  deps.out(`${REASONING_EFFORT_ENV} — thinking / reasoning effort used by \`graft build --deep\``);
  deps.out(`  current:       ${deps.env[REASONING_EFFORT_ENV] || "not set"}  [this process: shell environment or ./.env]`);
  deps.out(`  saved:         ${saved || "not set"}  [${deps.store.where}]`);
  deps.out(
    `  in effect:     ${
      defaulted
        ? `not set — graft's default: ${GRAFT_DEFAULT_EFFORT_TEXT}`
        : level
          ? `${level} (from ${from})`
          : `none sent — the model's own default (from ${from})`
    }`,
  );
  deps.out(`  for model:     ${cfg.model}`);
}

/**
 * Interactive pick of an effort level for `cfg.model`: probe the levels its
 * family usually takes, list the ones the endpoint accepted, and ask.
 * Throws {@link PromptCancelled} on Ctrl+C.
 */
async function chooseEffort(
  deps: SettingDeps,
  cfg: ResolvedConfig,
  prompt: Prompter,
  current: string | undefined,
  defaulted = false,
): Promise<EffortChoice> {
  const candidates = effortCandidates(cfg);
  let offered = candidates;
  let unverified = new Set(candidates);
  if (!cfg.apiKey) {
    deps.out(`Not verified (no API key yet). Levels models like ${cfg.model} usually take:`);
  } else {
    deps.out(`Asking ${cfg.model} which thinking effort levels it accepts (${candidates.length + 1} tiny requests)…`);
    const probe = await runEffortProbe(deps, cfg, candidates);
    if (probe.baselineError) {
      deps.out(`  could not verify: ${probe.baselineError}`);
      deps.out(`  Levels models like ${cfg.model} usually take:`);
    } else {
      offered = probe.results.filter((r) => r.verdict !== "rejected").map((r) => r.level);
      unverified = new Set(probe.results.filter((r) => r.verdict === "unknown").map((r) => r.level));
      if (offered.length === 0) {
        deps.out(`  ${cfg.model} accepts no thinking effort setting: it always runs at its own default.`);
        if (!current || defaulted) return { action: "keep" };
        deps.err(`⚠ the current effort "${current}" would be dropped at build time with a warning.`);
        const yes = (await prompt.ask(`Use the model's own default instead (${REASONING_EFFORT_ENV}=${MODEL_DEFAULT_EFFORT})? [Y/n] `))
          .trim()
          .toLowerCase();
        return yes === "" || yes.startsWith("y") ? { action: "set", level: MODEL_DEFAULT_EFFORT } : { action: "keep" };
      }
      if (acceptedEfforts(probe).length === 0) deps.out("  none could be confirmed; the levels below are unverified.");
    }
  }

  const explicitDefault = !current && !defaulted;
  deps.out("Thinking effort levels:");
  deps.out(`    0. default — let the model decide (no effort sent)${explicitDefault ? "  (current)" : ""}`);
  offered.forEach((level, i) => {
    const tags = [
      level === current ? (defaulted ? "current, graft's default" : "current") : "",
      unverified.has(level) && cfg.apiKey ? "not verified" : "",
    ].filter(Boolean);
    deps.out(`  ${String(i + 1).padStart(3)}. ${level} — ${describeEffort(level)}${tags.length ? `  (${tags.join(", ")})` : ""}`);
  });
  const verified = !!cfg.apiKey && offered.some((l) => !unverified.has(l));
  if (current && verified && !offered.includes(current)) {
    if (defaulted) {
      deps.out(`  note: ${cfg.model} does not take graft's default "${current}"; it runs at its own default unless you pick a level.`);
    } else {
      deps.err(`⚠ the current effort "${current}" is not accepted by ${cfg.model}; pick another level, or 0 for the model's default.`);
    }
  }

  const keeps = defaulted ? `graft's default (${GRAFT_DEFAULT_EFFORT_TEXT})` : current ? `"${current}"` : "the model's default";
  const answer = (await prompt.ask(`Pick a number or type a level; Enter keeps ${keeps}: `)).trim();
  if (!answer) return { action: "keep" };
  if (/^\d+$/.test(answer)) {
    const n = Number(answer);
    if (n === 0) return { action: "set", level: MODEL_DEFAULT_EFFORT };
    if (n >= 1 && n <= offered.length) return { action: "set", level: offered[n - 1] };
    deps.err(`✗ ${answer} is not in the list.`);
    return { action: "invalid" };
  }
  // "unset" goes back to graft's default; "default" / "auto" send no effort at all.
  if (answer.toLowerCase() === "unset") return { action: "set", level: undefined };
  const level = normalizeEffort(answer);
  if (level === undefined) return { action: "set", level: MODEL_DEFAULT_EFFORT };
  if (!isEffortName(level)) {
    deps.err(`✗ "${answer}" is not a level name (expected one of ${EFFORT_LEVELS.join(", ")}).`);
    return { action: "invalid" };
  }
  if (verified && !offered.includes(level)) {
    deps.err(`✗ ${cfg.model} does not accept "${level}" — nothing changed.`);
    return { action: "invalid" };
  }
  return { action: "set", level };
}

/**
 * Save the effort and say how this terminal picks it up. `undefined` removes
 * the variable (graft's default applies again); {@link MODEL_DEFAULT_EFFORT}
 * is saved as is and means "send no effort".
 */
function saveEffort(deps: SettingDeps, level: string | undefined): number {
  const name = REASONING_EFFORT_ENV;
  try {
    deps.store.write(name, level);
  } catch (err) {
    deps.err(`✗ ${cmd(EFFORT_COMMAND)}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  deps.out(
    level === undefined
      ? `✓ removed ${name} from ${deps.store.where} — \`graft build --deep\` uses graft's default: ${GRAFT_DEFAULT_EFFORT_TEXT}.`
      : level === MODEL_DEFAULT_EFFORT
        ? `✓ saved ${name} = ${level} to ${deps.store.where} — \`graft build --deep\` sends no effort; the model uses its own default.`
        : `✓ saved ${name} = ${level} to ${deps.store.where}.`,
  );
  deps.out(`  New terminals see it; restart your IDE so its terminals and MCP servers do too. For this terminal run:`);
  deps.out(
    `    ${level === undefined ? (deps.platform === "win32" ? `Remove-Item Env:${name}` : `unset ${name}`) : envSetExample(name, level, deps.platform)}`,
  );
  if (dotenvDefines(deps.cwd, name)) deps.out(`  note: ./.env also sets ${name}; an environment variable takes precedence over it.`);
  return 0;
}

/**
 * After `graft model` saved a new model: in a terminal, offer the effort levels
 * it accepts; otherwise check that a saved effort still fits it.
 */
async function effortAfterModelChange(deps: SettingDeps, env: NodeJS.ProcessEnv): Promise<void> {
  const { level: current, defaulted, cfg } = effortInEffect(deps, env);
  if (!cfg.apiKey) return;
  if (deps.prompt) {
    deps.out("");
    try {
      const choice = await chooseEffort(deps, cfg, deps.prompt, current, defaulted);
      if (choice.action === "set") saveEffort(deps, choice.level);
      else
        deps.out(
          defaulted
            ? `Kept graft's default thinking effort (${GRAFT_DEFAULT_EFFORT_TEXT}).`
            : current
              ? `Kept thinking effort "${current}".`
              : "Kept the model's default thinking effort.",
        );
    } catch (err) {
      if (!(err instanceof PromptCancelled)) throw err;
      deps.out("Thinking effort unchanged.");
    }
    return;
  }
  // Graft's default needs no check: a model that does not take it runs at its own default.
  if (defaulted) {
    deps.out(`  Thinking effort: graft's default, ${GRAFT_DEFAULT_EFFORT_TEXT}. Pick a level with \`${cmd(EFFORT_COMMAND)}\`.`);
    return;
  }
  if (!current) {
    deps.out(`  Thinking effort: the model's default. Pick a level with \`${cmd(EFFORT_COMMAND)}\`.`);
    return;
  }
  const r = (await runEffortProbe(deps, cfg, [current])).results[0];
  if (r?.verdict === "rejected") {
    deps.err(
      `⚠ ${cfg.model} refused reasoning effort "${current}" (${REASONING_EFFORT_ENV}); \`graft build --deep\` would drop it. Run \`${cmd(EFFORT_COMMAND)}\` to pick a level it accepts.`,
    );
  } else if (r?.verdict === "accepted") {
    deps.out(`  ✓ ${cfg.model} accepts reasoning effort "${current}".`);
  }
}

/**
 * `graft effort [level]`: show, pick (interactive), set after checking the
 * model accepts it, list, or unset. Returns the process exit code.
 */
export async function runEffortCommand(levelArg: string | undefined, opts: SettingOptions, deps: SettingDeps): Promise<number> {
  const command = cmd(EFFORT_COMMAND);
  const { cfg, defaulted } = effortInEffect(deps);

  if (opts.list) {
    const candidates = effortCandidates(cfg);
    if (opts.verify === false || !cfg.apiKey) {
      deps.out(`Levels models like ${cfg.model} usually take (not verified${cfg.apiKey ? "" : ": no API key yet"}):`);
      for (const l of candidates) deps.out(`  ${l} — ${describeEffort(l)}`);
      return 0;
    }
    const probe = await runEffortProbe(deps, cfg, candidates);
    if (probe.baselineError) {
      deps.err(`✗ could not ask ${cfg.model}: ${probe.baselineError}`);
      deps.err(`  Levels models like it usually take: ${candidates.join(", ")}.`);
      return 1;
    }
    deps.out(`Thinking effort levels for ${cfg.model}:`);
    for (const r of probe.results) {
      const mark = r.verdict === "accepted" ? "✓ accepted" : r.verdict === "rejected" ? "✗ refused" : `? not verified (${r.detail ?? "no answer"})`;
      deps.out(`  ${r.level.padEnd(8)} ${mark}  — ${describeEffort(r.level)}`);
    }
    if (!probe.results.some((r) => r.verdict !== "rejected")) {
      deps.out(`${cfg.model} accepts no thinking effort setting: it always runs at its own default.`);
    }
    return 0;
  }

  if (opts.unset && levelArg !== undefined) {
    deps.err(`${command}: pass a level or --unset, not both`);
    return 1;
  }
  if (opts.unset) return saveEffort(deps, undefined);

  if (levelArg === undefined) {
    printEffortStatus(deps, readSavedValue(deps.store, REASONING_EFFORT_ENV));
    if (!deps.prompt) {
      deps.out(
        `Set it with \`${command} <level>\` (${EFFORT_LEVELS.join(", ")} — which ones depend on the model; \`${command} --list\` asks it), \`${command} default\` to send none, or \`${command} --unset\` for graft's default (${GRAFT_DEFAULT_EFFORT_TEXT}).`,
      );
      return 0;
    }
    deps.out("");
    let choice: EffortChoice;
    try {
      choice = await chooseEffort(deps, cfg, deps.prompt, cfg.reasoningEffort, defaulted);
    } catch (err) {
      if (err instanceof PromptCancelled) {
        deps.out("Cancelled — nothing changed.");
        return 130;
      }
      throw err;
    }
    if (choice.action === "invalid") return 1;
    if (choice.action === "keep") {
      deps.out("Kept the current value.");
      return 0;
    }
    return saveEffort(deps, choice.level);
  }

  // "unset" is --unset spelled as a level: back to graft's default.
  if (levelArg.trim().toLowerCase() === "unset") return saveEffort(deps, undefined);
  const level = normalizeEffort(levelArg);
  if (level === undefined) return saveEffort(deps, MODEL_DEFAULT_EFFORT);
  if (!isEffortName(level)) {
    deps.err(`✗ ${command}: "${levelArg}" is not a level name (expected one of ${EFFORT_LEVELS.join(", ")})`);
    return 1;
  }
  if (!(EFFORT_LEVELS as readonly string[]).includes(level)) {
    deps.out(`  note: graft does not know the level "${level}"; it is sent to the model as typed.`);
  }
  if (opts.verify !== false) {
    if (!cfg.apiKey) {
      deps.out(`  not verified: no API key yet — set one with \`${cmd(SETTINGS.key.command)}\`.`);
    } else {
      deps.out(`Checking that ${cfg.model} accepts reasoning effort "${level}"…`);
      const probe = await runEffortProbe(deps, cfg, [level]);
      const r = probe.results[0];
      if (r?.verdict === "rejected") {
        deps.err(`✗ ${cfg.model} refused reasoning effort "${level}" (${r.detail ?? "rejected"}) — nothing saved.`);
        deps.err(`  Run \`${command} --list\` to see the levels it accepts.`);
        return 1;
      }
      if (r?.verdict === "accepted") deps.out(`  ✓ ${cfg.model} accepts reasoning effort "${level}".`);
      else {
        deps.out(
          `  not verified: ${probe.baselineError ?? r?.detail ?? "no answer"}. Saving it anyway — a level the model refuses is dropped at build time with a warning.`,
        );
      }
    }
  }
  return saveEffort(deps, level);
}
