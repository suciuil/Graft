import type { Summarizer } from "./summarize.js";
import type { Synthesizer } from "./synthesize.js";
import type { CruxSummarizer } from "./crux.js";
import type { ChatModel } from "./llm/types.js";
import type { ProviderKind } from "./llm/factory.js";
import { bareModelFallbacks, LLM_INCUBATOR_BASE_URL } from "./llm/factory.js";

/**
 * User-facing configuration. Anything omitted falls back to environment
 * variables and then to sensible defaults.
 *
 * graft is vendor-neutral: `provider` names only the WIRE FORMAT, not a company.
 * `openai` speaks the OpenAI-compatible API — point `baseUrl` at OpenRouter,
 * Fireworks, a LiteLLM proxy, Groq, a local server, or OpenAI itself, and pass
 * your own key. `anthropic` speaks the native Messages API. Any LLM-backed
 * operation needs an API key.
 */
export interface EngineConfig {
  /** Where the graph lives. Env: GRAFT_DIR. Default: `<repo>/.context`. */
  contextDir?: string;

  /** Wire format / SDK. Env: GRAFT_PROVIDER. Default: `llm-incubator` when no base URL is configured, else `openai`. */
  provider?: ProviderKind;
  /** API key for the chosen provider. Env: GRAFT_API_KEY, then ANTHROPIC_AUTH_TOKEN (legacy: OPENROUTER_API_KEY). */
  apiKey?: string;
  /** Model id. Env: GRAFT_MODEL. Provider-specific default. */
  model?: string;
  /** Base URL of the endpoint. Env: GRAFT_BASE_URL, then ANTHROPIC_BASE_URL. */
  baseUrl?: string;

  // --- advanced: bring your own components ---
  /** Override the whole transport (skips provider/apiKey/baseUrl). */
  chatModel?: ChatModel;
  /** Override the synthesizer. */
  synthesizer?: Synthesizer;
  /** Override the code summarizer. */
  summarizer?: Summarizer;
  /** Override the per-symbol crux summarizer. */
  cruxSummarizer?: CruxSummarizer;
}

/** Fully-resolved configuration with all defaults applied. */
export interface ResolvedConfig {
  contextDir?: string;
  provider: ProviderKind;
  apiKey?: string;
  model: string;
  /** Tried in order when the endpoint does not serve `model` (its id without the routing prefix). */
  modelFallbacks?: string[];
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Second wire format tried when `provider` was defaulted and the endpoint rejects it. */
  providerFallback?: { provider: ProviderKind; model: string };
  /** True when the key came from ANTHROPIC_AUTH_TOKEN: the Anthropic wire sends it as a Bearer token. */
  bearerAuth?: boolean;
  /** True when the key came from the deprecated OPENROUTER_* fallback. */
  usedLegacyEnv: boolean;
  chatModel?: ChatModel;
  synthesizer?: Synthesizer;
  summarizer?: Summarizer;
  cruxSummarizer?: CruxSummarizer;
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";

/** Per-provider default model. */
export const DEFAULT_MODELS: Record<ProviderKind, string> = {
  openai: "google/gemini-3.8-flash",
  anthropic: "claude-sonnet-5",
  // Provider-prefixed so the LiteLLM proxy routes it; override with GRAFT_MODEL.
  litellm: "gemini/gemini-3.8-flash",
  // Provider-prefixed so the OrcaRouter gateway routes it; override with GRAFT_MODEL.
  orcarouter: "google/gemini-3.8-flash",
  // The LLM Incubator gateway lists its models under bare ids.
  "llm-incubator": "gemini-3.8-flash",
};

export const DEFAULTS = {
  provider: "openai" as ProviderKind,
  model: DEFAULT_MODELS.openai,
} as const;

/** Merge user config with environment variables and defaults. */
export function resolveConfig(config: EngineConfig = {}): ResolvedConfig {
  const env = process.env;
  const providerDefaulted = !config.provider && !env.GRAFT_PROVIDER;
  let provider = config.provider ?? (env.GRAFT_PROVIDER as ProviderKind | undefined) ?? DEFAULTS.provider;

  const explicitKey = config.apiKey ?? env.GRAFT_API_KEY;
  const anthropicToken = explicitKey ? undefined : env.ANTHROPIC_AUTH_TOKEN;
  const legacyKey = env.OPENROUTER_API_KEY;
  const apiKey = explicitKey ?? anthropicToken ?? legacyKey ?? env.ORCAROUTER_API_KEY;
  const usedLegacyEnv = !explicitKey && !anthropicToken && !!legacyKey;
  // A legacy OpenRouter/OrcaRouter key keeps its old routing: never redirected to another host.
  const legacyRouting = !!apiKey && !explicitKey && !anthropicToken;

  let baseUrl =
    config.baseUrl ??
    env.GRAFT_BASE_URL ??
    (legacyRouting ? undefined : env.ANTHROPIC_BASE_URL) ??
    env.OPENROUTER_BASE_URL ??
    env.ORCAROUTER_BASE_URL;
  // Back-compat: an existing setup with only OPENROUTER_API_KEY keeps hitting
  // OpenRouter without any config change.
  if (!baseUrl && provider === "openai" && usedLegacyEnv) baseUrl = OPENROUTER_BASE_URL;
  // The orcarouter provider points at the gateway unless a base URL is given.
  if (!baseUrl && provider === "orcarouter") baseUrl = ORCAROUTER_BASE_URL;
  // Nothing configured at all: the LLM Incubator gateway, not api.openai.com.
  if (!baseUrl && provider === "openai" && providerDefaulted && !legacyRouting) provider = "llm-incubator";
  if (!baseUrl && provider === "llm-incubator") baseUrl = LLM_INCUBATOR_BASE_URL;

  const model =
    config.model ??
    env.GRAFT_MODEL ??
    env.GRAFT_OPENROUTER_MODEL ??
    env.ORCAROUTER_MODEL ??
    DEFAULT_MODELS[provider];
  // Gateways disagree on routing prefixes, so a prefixed id also tries its bare form.
  const modelFallbacks = bareModelFallbacks(model);

  const headers =
    provider === "openai" && baseUrl?.includes("openrouter.ai")
      ? { "X-Title": "graft" }
      : undefined;

  // Without a base URL the fallback would reach api.anthropic.com, so only hand it a key that is Anthropic's own.
  const openaiWire = provider === "openai" || provider === "llm-incubator";
  const providerFallback =
    providerDefaulted && openaiWire && (baseUrl || apiKey?.startsWith("sk-ant-"))
      ? { provider: "anthropic" as ProviderKind, model: model === DEFAULT_MODELS[provider] ? DEFAULT_MODELS.anthropic : model }
      : undefined;

  return {
    contextDir: config.contextDir ?? env.GRAFT_DIR,
    provider,
    apiKey,
    model,
    modelFallbacks,
    baseUrl,
    headers,
    providerFallback,
    bearerAuth: anthropicToken ? true : undefined,
    usedLegacyEnv,
    chatModel: config.chatModel,
    synthesizer: config.synthesizer,
    summarizer: config.summarizer,
    cruxSummarizer: config.cruxSummarizer,
  };
}
