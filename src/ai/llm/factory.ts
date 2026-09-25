/**
 * One place that turns resolved config into a {@link ChatModel}. `provider` names
 * the WIRE FORMAT, not a vendor: `openai` speaks the OpenAI-compatible API (point
 * `baseUrl` at OpenRouter, Fireworks, a LiteLLM proxy, Groq, a local server, …),
 * `anthropic` speaks the native Messages API. Adding a vendor is a base URL, not
 * a code change; adding a wire format is one new adapter here.
 *
 * `litellm` is a convenience over `openai`: same wire format, but pointed at a
 * LiteLLM proxy by default and paired with `/v1/models` auto-discovery
 * (see litellm.ts), so one endpoint reaches 100+ providers.
 *
 * `orcarouter` is the same kind of convenience over `openai`, pointed at the
 * OrcaRouter AI gateway by default (see orcarouter.ts) so its users get the
 * gateway's routing, failover, and guardrails behind a named provider instead
 * of a bare custom base URL.
 *
 * `llm-incubator` is the same over `openai`, pointed at the LLM Incubator
 * gateway; it is also the default when no provider and no base URL are configured.
 */
import type { ChatModel, ChatRequest, ChatResponse } from "./types.js";
import { OpenAIChatModel, isModelNotFound } from "./openai.js";
import { AnthropicChatModel } from "./anthropic.js";
import { LiteLLMChatModel } from "./litellm.js";
import { OrcaRouterChatModel } from "./orcarouter.js";

export type ProviderKind = "openai" | "anthropic" | "litellm" | "orcarouter" | "llm-incubator";

export const LLM_INCUBATOR_BASE_URL = "https://llm-gateway.ve42034x.automotive-wan.com";

export interface ChatModelConfig {
  provider: ProviderKind;
  apiKey: string;
  model: string;
  /** Model ids tried in order when the endpoint does not serve `model`. */
  modelFallbacks?: string[];
  baseUrl?: string;
  /** Extra default headers for OpenAI-compatible endpoints (e.g. OpenRouter `X-Title`). */
  headers?: Record<string, string>;
  /** Second wire format to try, same key and base URL, when `provider` is rejected outright. */
  providerFallback?: { provider: ProviderKind; model: string };
  /** Send the key as `Authorization: Bearer` on the Anthropic wire (an ANTHROPIC_AUTH_TOKEN), not `x-api-key`. */
  bearerAuth?: boolean;
}

/** Rejections that say "wrong wire format / endpoint", not "bad request" or "unknown model". */
function isWireRejection(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  return (status === 401 || status === 403 || status === 404 || status === 405) && !isModelNotFound(err);
}

/**
 * Tries `primary`; on a wire-level rejection tries `fallback` once. The first
 * fallback success makes it the active model; a fallback failure disables it
 * and the primary's original error is rethrown.
 */
export class ProviderFallbackChatModel implements ChatModel {
  private state: "primary" | "fallback" | "primary-only" = "primary";

  constructor(
    private primary: ChatModel,
    private fallback: ChatModel,
  ) {}

  get label(): string {
    return this.state === "fallback" ? this.fallback.label : this.primary.label;
  }

  async create(req: ChatRequest): Promise<ChatResponse> {
    if (this.state === "fallback") return this.fallback.create(req);
    try {
      return await this.primary.create(req);
    } catch (err) {
      if (this.state !== "primary" || !isWireRejection(err)) throw err;
      try {
        const res = await this.fallback.create(req);
        if (this.state === "primary") {
          this.state = "fallback";
          console.error(
            `⚠ ${this.primary.label} was rejected (${(err as { status?: number }).status}); using ${this.fallback.label} instead`,
          );
        }
        return res;
      } catch {
        if (this.state === "primary") this.state = "primary-only";
        throw err;
      }
    }
  }
}

/** The id without its routing prefix (`google/gemini-x` → `gemini-x`), as a fallback list. */
export function bareModelFallbacks(model: string): string[] | undefined {
  const slash = model.lastIndexOf("/");
  return slash >= 0 && slash < model.length - 1 ? [model.slice(slash + 1)] : undefined;
}

export function createChatModel(cfg: ChatModelConfig): ChatModel {
  const primary = createSingleChatModel(cfg);
  const fb = cfg.providerFallback;
  if (!fb || fb.provider === cfg.provider) return primary;
  const fallback = createSingleChatModel({
    ...cfg,
    provider: fb.provider,
    model: fb.model,
    modelFallbacks: bareModelFallbacks(fb.model),
  });
  return new ProviderFallbackChatModel(primary, fallback);
}

function createSingleChatModel(cfg: ChatModelConfig): ChatModel {
  switch (cfg.provider) {
    case "anthropic":
      return new AnthropicChatModel({
        apiKey: cfg.apiKey,
        authToken: cfg.bearerAuth ? cfg.apiKey : undefined,
        model: cfg.model,
        modelFallbacks: cfg.modelFallbacks,
        baseUrl: cfg.baseUrl,
      });
    case "openai":
      return new OpenAIChatModel({
        apiKey: cfg.apiKey,
        model: cfg.model,
        modelFallbacks: cfg.modelFallbacks,
        baseUrl: cfg.baseUrl,
        headers: cfg.headers,
      });
    case "litellm":
      return new LiteLLMChatModel({
        apiKey: cfg.apiKey,
        model: cfg.model,
        modelFallbacks: cfg.modelFallbacks,
        baseUrl: cfg.baseUrl,
        headers: cfg.headers,
      });
    case "orcarouter":
      return new OrcaRouterChatModel({
        apiKey: cfg.apiKey,
        model: cfg.model,
        modelFallbacks: cfg.modelFallbacks,
        baseUrl: cfg.baseUrl,
        headers: cfg.headers,
      });
    case "llm-incubator":
      return new OpenAIChatModel({
        apiKey: cfg.apiKey,
        model: cfg.model,
        modelFallbacks: cfg.modelFallbacks,
        baseUrl: cfg.baseUrl ?? LLM_INCUBATOR_BASE_URL,
        headers: cfg.headers,
        label: `llm-incubator:${cfg.model}`,
      });
    default: {
      const _exhaustive: never = cfg.provider;
      throw new Error(`unknown provider: ${String(_exhaustive)}`);
    }
  }
}
