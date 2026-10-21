/**
 * Actionable hints for a failed `graft build --deep`.
 *
 * The LLM passes report failures as raw provider messages ("Connection error.",
 * "401 Incorrect API key provided", "404 The model `x` does not exist"). Those say
 * what broke but not which knob fixes it, so this module classifies them and names
 * the environment variable to set: GRAFT_BASE_URL for an unreachable endpoint,
 * GRAFT_API_KEY for a rejected key, GRAFT_MODEL for an unknown model — the last
 * one listing the models the endpoint actually serves when it will say.
 */
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { terminalKind } from "./failure.js";
import { resolveConfig, type EngineConfig, type ResolvedConfig } from "./providers.js";
import { baseUrlCandidates } from "./llm/openai.js";
import { anthropicBaseUrl } from "./llm/anthropic.js";
import { DEFAULT_LITELLM_BASE_URL } from "./llm/litellm.js";
import type { ProviderKind } from "./llm/factory.js";
import {
  DATABRICKS_KNOWN_MODELS,
  databricksRoot,
  isDatabricksGatewayUrl,
  listDatabricksModels,
  normalizeDatabricksModel,
  type DatabricksLister,
} from "./llm/databricks.js";
import { cmd } from "../brand.js";

export type LlmProblem = "unreachable" | "auth" | "model";

/** Shown when the endpoint will not list its models. Mid-tier on purpose. */
export const EXAMPLE_MODELS = ["claude-sonnet-5.5", "gpt-5.5-terra", "gemini-3.8-flash"];

const MODEL_NOT_FOUND_RE =
  /model_not_found|not_found_error|(does not exist|not found|invalid model|not a valid model|no such model|unknown model|unsupported model|not available|no available (channel|provider))/i;
const UNREACHABLE_RE =
  /connection error|request timed out|timed out|fetch failed|socket hang up|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|getaddrinfo|certificate|unexpected token '?<|is not valid json/i;
/** A 404/405 status at the start of a message (or after a `path: ` prefix): wrong URL path. */
const ROUTE_NOT_FOUND_RE = /(^|: )40[45]\b/;

/**
 * What the user has to change for this failure, or null when no setting fixes it
 * (a spent quota or balance, a content-quality miss, a parse error).
 */
export function classifyLlmError(message: string): LlmProblem | null {
  const terminal = terminalKind(message);
  if (terminal === "balance" || terminal === "quota") return null;
  if (/model/i.test(message) && MODEL_NOT_FOUND_RE.test(message)) return "model";
  if (terminal === "auth") return "auth";
  if (/incorrect api key|api key[^.]{0,40}(invalid|expired|not valid)|(key|token)[^.]{0,40}expired|forbidden/i.test(message)) {
    return "auth";
  }
  if (UNREACHABLE_RE.test(message) || ROUTE_NOT_FOUND_RE.test(message)) return "unreachable";
  return null;
}

/** The distinct problems behind a set of failure messages, in fix order. */
export function llmProblems(messages: (string | undefined)[]): LlmProblem[] {
  const found = new Set<LlmProblem>();
  for (const m of messages) {
    // Per-file errors read `src/model.ts: <message>`; the path must not count as a word.
    const p = m ? classifyLlmError(m.replace(/^[^\s:]*[./][^\s:]*: /, "")) : null;
    if (p) found.add(p);
  }
  return (["unreachable", "auth", "model"] as const).filter((p) => found.has(p));
}

/** Top-tier families: fine, but never needed for summaries. */
const TOP_TIER_RE = /opus|astra|(^|[-/_.:])(sol|ultra|pro)($|[-/_.:])/i;
const MID_TIER_RE = /sonnet|flash|terra|haiku|mini|luna|lite/i;
const NON_CHAT_RE = /embed|tts|whisper|dall-e|image|moderation|audio|transcri|rerank|speech|realtime/i;

export function isTopTierModel(id: string): boolean {
  return TOP_TIER_RE.test(id);
}

/** Chat-capable ids, deduped, with the non-top-tier ones first (original order kept). */
export function rankModelsForHint(ids: string[]): string[] {
  const chat = [...new Set(ids.filter((id) => id && !NON_CHAT_RE.test(id)))];
  return [...chat.filter((id) => !isTopTierModel(id)), ...chat.filter(isTopTierModel)];
}

/** The id to put in the `GRAFT_MODEL=` example: a mid-tier one when there is one. */
/**
 * The model to recommend, in this order of preference:
 *   1. the latest Gemini Flash (a full Flash, not Flash-Lite),
 *   2. the latest GPT terra,
 *   3. the latest Claude Sonnet,
 * then any other mid-tier model, then any non-top-tier one.
 */
export function suggestModel(ranked: string[]): string | undefined {
  const families: ((id: string) => boolean)[] = [
    (id) => /gemini/i.test(id) && /flash/i.test(id) && !/lite/i.test(id),
    (id) => /gpt/i.test(id) && /terra/i.test(id),
    (id) => /claude/i.test(id) && /sonnet/i.test(id),
  ];
  for (const inFamily of families) {
    const latest = latestModel(ranked.filter(inFamily));
    if (latest) return latest;
  }
  return ranked.find((id) => !isTopTierModel(id) && MID_TIER_RE.test(id)) ?? ranked.find((id) => !isTopTierModel(id)) ?? ranked[0];
}

/**
 * The version numbers in a model id, for ordering one family's releases:
 * `google/gemini-3.8-flash` → [3, 8], `claude-sonnet-5-5` → [5, 5],
 * `claude-4-6-sonnet-v1:0` → [4, 6]. The routing prefix, a Bedrock-style
 * `-v1:0` suffix and an 8-digit release date are not part of the version.
 */
export function modelVersion(id: string): number[] {
  const bare = id
    .slice(id.lastIndexOf("/") + 1)
    .replace(/-v\d+(:\d+)?$/i, "")
    .replace(/[-@]\d{8}$/, "");
  // The first run of numbers is the version; later ones are dates or preview tags.
  const group = /\d+(?:[.-]\d+)*/.exec(bare)?.[0];
  return group ? group.split(/[.-]/).map(Number) : [];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** The highest-versioned id; on a tie the plainest one (`gemini-3.8-flash` over `gemini-3.8-flash-preview`). */
export function latestModel(ids: string[]): string | undefined {
  return [...ids].sort((a, b) => compareVersions(modelVersion(b), modelVersion(a)) || a.length - b.length)[0];
}

const LIST_TIMEOUT_MS = 10_000;

async function listOpenAiModels(apiKey: string, baseUrl: string | undefined, headers?: Record<string, string>): Promise<string[]> {
  let lastErr: unknown;
  for (const candidate of baseUrlCandidates(baseUrl)) {
    try {
      const client = new OpenAI({ apiKey, baseURL: candidate, defaultHeaders: headers, maxRetries: 0, timeout: LIST_TIMEOUT_MS });
      const page = await client.models.list();
      return page.data.map((m) => m.id);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function listAnthropicModels(cfg: ResolvedConfig): Promise<string[]> {
  const client = new Anthropic({
    ...(cfg.bearerAuth ? { apiKey: null, authToken: cfg.apiKey } : { apiKey: cfg.apiKey }),
    baseURL: anthropicBaseUrl(cfg.baseUrl),
    maxRetries: 0,
    timeout: LIST_TIMEOUT_MS,
  });
  const page = await client.models.list({ limit: 1000 });
  return page.data.map((m) => m.id);
}

/**
 * The model ids the configured endpoint serves (`GET /models`), trying the
 * fallback wire format too when the provider was defaulted. Throws when neither
 * answers — many gateways do not expose the listing.
 */
export async function listEndpointModels(cfg: ResolvedConfig, databricksLister?: DatabricksLister): Promise<string[]> {
  if (!cfg.apiKey) throw new Error("no API key");
  if (cfg.databricks) {
    const listings = await listDatabricksModels(cfg.databricks.root, cfg.apiKey, databricksLister);
    if (listings.some((l) => l.ids.length > 0)) {
      // The gateway refuses `GET /models` on some routes (OpenAI, MLflow) even though it serves chat on
      // them; once one route has accepted the key, offer the known ids for the routes that listed nothing.
      return listings.flatMap((l) => (l.ids.length > 0 ? l.ids : [...DATABRICKS_KNOWN_MODELS[l.route]]));
    }
    throw listings.find((l) => l.error)?.error ?? new Error("the endpoint listed no models");
  }
  const wires: ProviderKind[] = [cfg.provider];
  if (cfg.providerFallback && cfg.providerFallback.provider !== cfg.provider) wires.push(cfg.providerFallback.provider);
  let lastErr: unknown;
  for (const wire of wires) {
    try {
      const ids =
        wire === "anthropic"
          ? await listAnthropicModels(cfg)
          : await listOpenAiModels(cfg.apiKey, cfg.baseUrl ?? (wire === "litellm" ? DEFAULT_LITELLM_BASE_URL : undefined), cfg.headers);
      if (ids.length > 0) return ids;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("the endpoint listed no models");
}

export type SettingKind = "url" | "key" | "model";

/** The env var, CLI flag, and lower-precedence env fallbacks behind each LLM setting. */
export const SETTINGS: Record<SettingKind, { env: string; flag: string; envs: string[]; command: string }> = {
  url: {
    env: "GRAFT_BASE_URL",
    flag: "--base-url",
    envs: ["GRAFT_BASE_URL", "ANTHROPIC_BASE_URL", "OPENROUTER_BASE_URL", "ORCAROUTER_BASE_URL"],
    command: "graft api url",
  },
  key: {
    env: "GRAFT_API_KEY",
    flag: "--api-key",
    envs: ["GRAFT_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "ORCAROUTER_API_KEY"],
    command: "graft api key",
  },
  model: {
    env: "GRAFT_MODEL",
    flag: "--model",
    envs: ["GRAFT_MODEL", "GRAFT_OPENROUTER_MODEL", "ORCAROUTER_MODEL"],
    command: "graft model",
  },
};

/** Where one setting came from: a CLI flag, a named env var, or graft's default. */
export interface Source {
  flag?: string;
  env?: string;
}

/** Which flag or env var supplied the value a resolved config uses for `kind`. */
export function settingSource(kind: SettingKind, config: EngineConfig, cfg: ResolvedConfig, env: NodeJS.ProcessEnv): Source {
  const s = SETTINGS[kind];
  const flagValue = kind === "url" ? config.baseUrl : kind === "key" ? config.apiKey : config.model;
  if (flagValue) return { flag: s.flag };
  const resolved = kind === "url" ? cfg.baseUrl : kind === "key" ? cfg.apiKey : cfg.model;
  const name = s.envs.find(
    (n) =>
      env[n] &&
      (env[n] === resolved ||
        (kind === "url" && cfg.databricks && isDatabricksGatewayUrl(env[n]) && databricksRoot(env[n]!) === cfg.databricks.root) ||
        (kind === "model" && cfg.databricks && normalizeDatabricksModel(env[n]!) === resolved)),
  );
  return name ? { env: name } : {};
}

function fromText(s: Source, primaryEnv: string): string {
  if (s.flag) return `from ${s.flag}`;
  if (s.env) return `from ${s.env}`;
  return `${primaryEnv} is not set`;
}

/** How to set an env var in the user's shell. */
export function envSetExample(name: string, value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `$env:${name} = "${value}"` : `export ${name}="${value}"`;
}

/** The endpoint a provider's SDK reaches when no base URL is configured. */
export function defaultBaseUrl(provider: ProviderKind): string {
  if (provider === "anthropic") return "https://api.anthropic.com";
  if (provider === "litellm") return DEFAULT_LITELLM_BASE_URL;
  return "https://api.openai.com/v1";
}

export function shortError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const line = message.split("\n")[0]!.trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

export interface HintContext {
  /** The config the build ran with (CLI flags only; env and defaults are resolved here). */
  config: EngineConfig;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Overrides the live `GET /models` call (tests). */
  listModels?: (cfg: ResolvedConfig) => Promise<string[]>;
}

const MAX_LISTED = 20;

/**
 * Hint lines (unindented) for the problems behind `messages`; empty when none of
 * them is something a setting fixes. Only the model hint touches the network:
 * one bounded `GET /models` to name ids the endpoint serves.
 */
export async function llmFailureHints(messages: (string | undefined)[], ctx: HintContext): Promise<string[]> {
  const problems = llmProblems(messages);
  if (problems.length === 0) return [];
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const cfg = resolveConfig(ctx.config, env);
  const url = cfg.baseUrl ?? defaultBaseUrl(cfg.provider);
  const lines: string[] = [];
  const set = (name: string, value: string) => `    ${envSetExample(name, value, platform)}`;
  const dropFlag = (s: Source) => (s.flag ? ` (and drop ${s.flag}, which overrides it)` : "");

  for (const problem of problems) {
    if (problem === "unreachable") {
      const s = settingSource("url", ctx.config, cfg, env);
      const fallback = cfg.databricks ? "the Databricks AI Gateway" : `the ${cfg.provider}`;
      const where = s.flag || s.env ? fromText(s, "GRAFT_BASE_URL") : `GRAFT_BASE_URL is not set, so graft used ${fallback} default`;
      lines.push(
        `• The LLM endpoint ${url} could not be reached (${where}).`,
        `  Check the URL, your network/VPN and proxy, then set GRAFT_BASE_URL to a reachable endpoint${dropFlag(s)}`,
        `  — run \`${cmd(SETTINGS.url.command)}\` to save it for every new terminal, or for this one:`,
        set("GRAFT_BASE_URL", "https://<your-llm-endpoint>/v1"),
      );
    } else if (problem === "auth") {
      const s = settingSource("key", ctx.config, cfg, env);
      lines.push(
        `• ${url} rejected the API key (${fromText(s, "GRAFT_API_KEY")}): it is wrong, expired, or not valid for this endpoint.`,
        `  Set GRAFT_API_KEY to a valid key for ${url}${dropFlag(s)}`,
        `  — run \`${cmd(SETTINGS.key.command)}\` to save it for every new terminal, or for this one:`,
        set("GRAFT_API_KEY", "<your-api-key>"),
      );
    } else {
      const s = settingSource("model", ctx.config, cfg, env);
      const which =
        s.flag || s.env
          ? `"${cfg.model}" (${fromText(s, "GRAFT_MODEL")})`
          : `"${cfg.model}" (graft's default for the ${cfg.provider} provider — GRAFT_MODEL is not set)`;
      lines.push(`• Model ${which} was not found at ${url}.`);
      let ranked: string[] = [];
      let listError: string | undefined;
      try {
        ranked = rankModelsForHint(await (ctx.listModels ?? listEndpointModels)(cfg));
      } catch (err) {
        listError = shortError(err);
      }
      if (ranked.length > 0) {
        const shown = ranked.slice(0, MAX_LISTED);
        const more = ranked.length > shown.length ? `, … (${ranked.length - shown.length} more)` : "";
        lines.push(
          `  Models this endpoint serves: ${shown.join(", ")}${more}`,
          `  Set GRAFT_MODEL to one of them${dropFlag(s)} — run \`${cmd(SETTINGS.model.command)}\` to pick and save one, or for this terminal:`,
          set("GRAFT_MODEL", suggestModel(ranked)!),
        );
      } else {
        lines.push(
          `  Could not list the models this endpoint serves${listError ? ` (${listError})` : ""}.`,
          `  Set GRAFT_MODEL to a model id it serves${dropFlag(s)} — for example ${EXAMPLE_MODELS.join(", ")}`,
          `  (exact ids vary by gateway; some need a routing prefix such as anthropic/, openai/ or google/).`,
          `  Run \`${cmd(SETTINGS.model.command)} <id>\` to save it for every new terminal, or for this one:`,
          set("GRAFT_MODEL", EXAMPLE_MODELS[0]!),
        );
      }
      lines.push(
        "  A top-tier model (Claude Opus, GPT astra/sol, Gemini Pro, …) is not necessary: summaries work well",
        "  with a mid-tier model, which is cheaper and faster.",
      );
    }
  }
  lines.push("Set these with the commands above, in your shell, or in a .env file in the directory you run graft from.");
  return lines;
}

/**
 * Print {@link llmFailureHints} to stderr under a "How to fix it:" heading. Best
 * effort: a hint must never turn a reported failure into a different crash.
 */
export async function printLlmFailureHints(messages: (string | undefined)[], config: EngineConfig, indent = "  "): Promise<void> {
  let hints: string[];
  try {
    hints = await llmFailureHints(messages, { config });
  } catch {
    return;
  }
  if (hints.length === 0) return;
  console.error(`${indent}How to fix it:`);
  for (const h of hints) console.error(`${indent}${h}`);
}
