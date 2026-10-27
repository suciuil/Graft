import type { Summarizer } from "./summarize.js";
import type { Synthesizer } from "./synthesize.js";
import type { CruxSummarizer } from "./crux.js";
import type { ChatModel } from "./llm/types.js";
import type { ProviderKind } from "./llm/factory.js";
import { bareModelFallbacks, DEFAULT_BASE_URL } from "./llm/factory.js";
import { DEFAULT_REASONING_EFFORT, normalizeEffort } from "./llm/effort.js";
import {
  DATABRICKS_DEFAULT_MODEL,
  databricksHeaders,
  databricksModelFallbacks,
  databricksModelHeaders,
  databricksRoot,
  databricksRoute,
  databricksRouteUrl,
  isDatabricksGatewayUrl,
  normalizeDatabricksModel,
  type DatabricksRoute,
} from "./llm/databricks.js";

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

  /** Wire format / SDK. Env: GRAFT_PROVIDER. Default: the Databricks AI Gateway's route for the model when no base URL is configured, else `openai`. */
  provider?: ProviderKind;
  /** API key for the chosen provider. Env: GRAFT_API_KEY, then ANTHROPIC_AUTH_TOKEN (legacy: OPENROUTER_API_KEY). */
  apiKey?: string;
  /** Model id. Env: GRAFT_MODEL. Provider-specific default. */
  model?: string;
  /** Base URL of the endpoint. Env: GRAFT_BASE_URL, then ANTHROPIC_BASE_URL. Default: the Databricks AI Gateway. */
  baseUrl?: string;
  /**
   * Thinking / reasoning effort level for LLM calls. Env: GRAFT_REASONING_EFFORT.
   * Default: "high" where the model takes it, else the model's own default;
   * "default" sends no effort at all.
   */
  reasoningEffort?: string;

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
  /** Anthropic wire: extra headers for one model id. */
  modelHeaders?: (model: string) => Record<string, string> | undefined;
  /** Set when the endpoint is the Databricks AI Gateway: its workspace root and the route `model` takes. */
  databricks?: { root: string; route: DatabricksRoute };
  /** Second wire format tried when `provider` was defaulted and the endpoint rejects it. */
  providerFallback?: { provider: ProviderKind; model: string };
  /** True when the key came from ANTHROPIC_AUTH_TOKEN: the Anthropic wire sends it as a Bearer token. */
  bearerAuth?: boolean;
  /** True when the key came from the deprecated OPENROUTER_* fallback. */
  usedLegacyEnv: boolean;
  /** Thinking / reasoning effort level, normalized; undefined sends none (the model's own default). */
  reasoningEffort?: string;
  /** True when {@link reasoningEffort} is graft's default, not the user's: a model that refuses it runs at its own default, quietly. */
  reasoningEffortDefaulted?: boolean;
  chatModel?: ChatModel;
  synthesizer?: Synthesizer;
  summarizer?: Summarizer;
  cruxSummarizer?: CruxSummarizer;
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";

/** The model graft uses whenever none is configured (GRAFT_MODEL / --model), on every provider. */
export const DEFAULT_MODEL = "claude-haiku-5-5";

/**
 * Other spellings of {@link DEFAULT_MODEL}, tried in order when an endpoint does
 * not serve it: gateways disagree on the version separator (`5-5` vs `5.5`).
 */
const DEFAULT_MODEL_ALIASES = ["claude-haiku-5.5"];

/** Per-provider default model: {@link DEFAULT_MODEL}, routing-prefixed where the gateway needs it. */
export const DEFAULT_MODELS: Record<ProviderKind, string> = {
  openai: DEFAULT_MODEL,
  anthropic: DEFAULT_MODEL,
  // Provider-prefixed so the LiteLLM proxy routes it; override with GRAFT_MODEL.
  litellm: `anthropic/${DEFAULT_MODEL}`,
  // Provider-prefixed so the OrcaRouter gateway routes it; override with GRAFT_MODEL.
  orcarouter: `anthropic/${DEFAULT_MODEL}`,
  // The LLM Incubator gateway lists its models under bare ids.
  "llm-incubator": DEFAULT_MODEL,
};

/** Fallback ids for `model`: its bare id, and the alternate spellings when it is the default. */
function modelFallbacksFor(model: string, isDefault: boolean): string[] | undefined {
  const list = [...(bareModelFallbacks(model) ?? []), ...(isDefault ? DEFAULT_MODEL_ALIASES : [])].filter((id) => id !== model);
  return list.length > 0 ? [...new Set(list)] : undefined;
}

export const DEFAULTS = {
  provider: "openai" as ProviderKind,
  model: DEFAULT_MODELS.openai,
} as const;

/** Merge user config with environment variables and defaults. */
export function resolveConfig(config: EngineConfig = {}, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  // Nothing set: graft's default level, sent only where the model takes it. A
  // set value, even "default" (no effort sent), is the user's choice.
  const rawEffort = config.reasoningEffort ?? env.GRAFT_REASONING_EFFORT;
  const reasoningEffortDefaulted = !rawEffort?.trim() || rawEffort.trim().toLowerCase() === "unset" || undefined;
  const reasoningEffort = reasoningEffortDefaulted ? DEFAULT_REASONING_EFFORT : normalizeEffort(rawEffort);
  const providerDefaulted = !config.provider && !env.GRAFT_PROVIDER;
  const provider = config.provider ?? (env.GRAFT_PROVIDER as ProviderKind | undefined) ?? DEFAULTS.provider;

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
  // Nothing configured at all: the Databricks AI Gateway, not api.openai.com.
  if (!baseUrl && provider === "openai" && providerDefaulted && !legacyRouting) baseUrl = DEFAULT_BASE_URL;
  // llm-incubator has no built-in URL: the gateway must be configured explicitly.

  // The Databricks gateway serves each model family under its own route and wire format.
  if (isDatabricksGatewayUrl(baseUrl)) {
    const root = databricksRoot(baseUrl!);
    const model = normalizeDatabricksModel(config.model ?? env.GRAFT_MODEL ?? DATABRICKS_DEFAULT_MODEL);
    const route = databricksRoute(model);
    return {
      contextDir: config.contextDir ?? env.GRAFT_DIR,
      provider: route === "anthropic" ? "anthropic" : "openai",
      apiKey,
      model,
      modelFallbacks: databricksModelFallbacks(model),
      baseUrl: databricksRouteUrl(root, route),
      headers: databricksHeaders(),
      modelHeaders: route === "anthropic" ? databricksModelHeaders : undefined,
      databricks: { root, route },
      // Databricks takes its personal access token as a Bearer token on every route.
      bearerAuth: apiKey ? true : undefined,
      usedLegacyEnv,
      reasoningEffort,
      reasoningEffortDefaulted,
      chatModel: config.chatModel,
      synthesizer: config.synthesizer,
      summarizer: config.summarizer,
      cruxSummarizer: config.cruxSummarizer,
    };
  }

  const model =
    config.model ??
    env.GRAFT_MODEL ??
    env.GRAFT_OPENROUTER_MODEL ??
    env.ORCAROUTER_MODEL ??
    DEFAULT_MODELS[provider];
  // Gateways disagree on routing prefixes, so a prefixed id also tries its bare form.
  const modelFallbacks = modelFallbacksFor(model, model === DEFAULT_MODELS[provider]);

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
    reasoningEffort,
    reasoningEffortDefaulted,
    chatModel: config.chatModel,
    synthesizer: config.synthesizer,
    summarizer: config.summarizer,
    cruxSummarizer: config.cruxSummarizer,
  };
}
