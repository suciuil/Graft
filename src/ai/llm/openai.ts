/**
 * OpenAI-compatible transport. Wraps the `openai` SDK pointed at any
 * OpenAI-compatible endpoint (OpenAI, OpenRouter, Fireworks, a LiteLLM proxy,
 * Groq, Together, DeepSeek, a local server, …) — the user picks the endpoint
 * with `baseUrl` and authenticates with their own key.
 *
 * This adapter reproduces graft's historical wire behavior exactly: temperature
 * is forwarded, cache breakpoints become `cache_control` content parts (which
 * OpenRouter forwards to Anthropic), and cached tokens are subtracted out of the
 * input count so {@link Usage.input} is uncached-only.
 */
import OpenAI from "openai";
import { transportRetries } from "./types.js";
import type { ChatModel, ChatRequest, ChatResponse, Message, ToolCall, ToolSpec, Usage } from "./types.js";

const PROVIDER = "openai";
/** Synthetic tool used to coerce a plain JSON object out of `{ kind: "json" }`. */
const JSON_TOOL = "emit_json";

export interface OpenAIChatModelOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Stable manifest label; defaults to `openai:<model>`. */
  label?: string;
  /** Extra default headers (e.g. OpenRouter's `X-Title`). */
  headers?: Record<string, string>;
  /** Model ids tried in order when the endpoint reports `model` as unknown. */
  modelFallbacks?: string[];
  /** Inject a pre-built client (tests pass a stub; production omits it). */
  client?: OpenAI;
}

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** A text content part, optionally carrying a cache breakpoint (OpenRouter passthrough). */
function textPart(text: string, cache: boolean | undefined) {
  return cache
    ? [{ type: "text" as const, text, cache_control: { type: "ephemeral" as const } }]
    : text;
}

function toChatMessage(m: Message): ChatMessage {
  switch (m.role) {
    case "system":
      return { role: "system", content: textPart(m.content, m.cacheBreakpoint) } as ChatMessage;
    case "user":
      return { role: "user", content: textPart(m.content, m.cacheBreakpoint) } as ChatMessage;
    case "tool":
      return {
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        content: textPart(m.content, m.cacheBreakpoint),
      } as ChatMessage;
    case "assistant": {
      if (m.providerRaw?.provider === PROVIDER) return m.providerRaw.raw as ChatMessage;
      const tool_calls = m.toolCalls?.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
      }));
      return {
        role: "assistant",
        content: m.content || null,
        ...(tool_calls?.length ? { tool_calls } : {}),
      } as ChatMessage;
    }
  }
}

function toChatTool(t: ToolSpec): OpenAI.Chat.Completions.ChatCompletionTool {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
}

/**
 * Some OpenAI-compatible servers — LM Studio's local server, at least as of
 * 2026 — reject the object form of `tool_choice` outright with a 400
 * ("Invalid tool_choice type: 'object'. Supported string values: none, auto,
 * required"), even though the upstream OpenAI spec allows it.
 */
function isRejectedObjectToolChoice(err: unknown): boolean {
  return (
    err instanceof OpenAI.APIError &&
    err.status === 400 &&
    /tool_choice/i.test(String((err as { message?: string }).message ?? ""))
  );
}

/**
 * Newer reasoning-family models (o1/o3/o4, the gpt-5.x line, …) reject the
 * classic `max_tokens` param outright and require `max_completion_tokens`
 * instead, even though both are still in wide use across OpenAI-compatible
 * servers. Detect the specific 400 rather than guessing from the model name,
 * so older endpoints that still expect `max_tokens` are untouched.
 */
function isRejectedMaxTokens(err: unknown): boolean {
  return (
    err instanceof OpenAI.APIError &&
    err.status === 400 &&
    /max_tokens.*not supported.*max_completion_tokens/i.test(String((err as { message?: string }).message ?? ""))
  );
}

/** Same reasoning-family models: temperature is fixed at 1, not caller-settable. */
function isRejectedTemperature(err: unknown): boolean {
  return (
    err instanceof OpenAI.APIError &&
    err.status === 400 &&
    /temperature.*does not support/i.test(String((err as { message?: string }).message ?? ""))
  );
}

/**
 * Same models again: function tools are rejected on /v1/chat/completions while
 * the model's default reasoning effort is active. The API's own error message
 * names the fix — `reasoning_effort: "none"` — so apply exactly that.
 *
 * DeepSeek's v4 line refuses the same combination ("Thinking mode does not
 * support this tool_choice") for every tool_choice except "auto", and accepts
 * the identical `reasoning_effort: "none"` remedy. Matching both phrasings here
 * keeps a forced tool_choice working rather than degrading it to "auto", which
 * would leave the model free not to call the tool the caller asked for.
 */
function isRejectedToolsWithReasoning(err: unknown): boolean {
  const message = String((err as { message?: string }).message ?? "");
  return (
    err instanceof OpenAI.APIError &&
    err.status === 400 &&
    (/function tools with reasoning_effort/i.test(message) ||
      /thinking mode does not support this tool_choice/i.test(message))
  );
}

/** The remedy above refused: the model cannot turn reasoning off (e.g. gpt-6.1-sol: only low…xhigh). */
function isRejectedReasoningNone(err: unknown): boolean {
  return (
    err instanceof OpenAI.APIError &&
    err.status === 400 &&
    /reasoning_effort[^.]*does not support 'none'/i.test(String((err as { message?: string }).message ?? ""))
  );
}

/**
 * Models that always think refuse every forcing `tool_choice` — Claude behind a
 * Databricks serving endpoint answers "tool_choice: type "tool" and "any" are
 * not supported for this model" to both the object form and "required".
 */
function isRejectedForcedToolChoice(err: unknown): boolean {
  return (
    err instanceof OpenAI.APIError &&
    err.status === 400 &&
    /tool_choice[^.]*\bany\b[^.]*not supported/i.test(String((err as { message?: string }).message ?? ""))
  );
}

/**
 * The single tool `params` forces, by name or via "required", offered with
 * `auto` instead and with a system instruction to answer only through it.
 */
function asAutoToolChoice(params: ChatParams): ChatParams | undefined {
  const choice = params.tool_choice;
  if (!choice || choice === "auto" || choice === "none" || params.tools?.length !== 1) return undefined;
  const tool = params.tools[0]!;
  if (tool.type !== "function") return undefined;
  const nudge = `Respond only by calling the \`${tool.function.name}\` tool; do not answer in plain text.`;
  const [first, ...rest] = params.messages;
  const messages: ChatParams["messages"] =
    first?.role === "system" && typeof first.content === "string"
      ? [{ ...first, content: `${first.content}\n\n${nudge}` }, ...rest]
      : [{ role: "system", content: nudge }, ...params.messages];
  return { ...params, tool_choice: "auto", messages };
}

/** The single forced function of `params`, when there is exactly one. */
function forcedSingleTool(params: ChatParams): OpenAI.Chat.Completions.ChatCompletionFunctionTool | undefined {
  const choice = params.tool_choice;
  if (!choice || typeof choice !== "object" || choice.type !== "function" || params.tools?.length !== 1) return undefined;
  const tool = params.tools[0]!;
  return tool.type === "function" && tool.function.name === choice.function.name ? tool : undefined;
}

/**
 * A forced single tool rewritten as structured output: the tool's parameters
 * become a `json_schema` response format. Used only for models that refuse
 * function tools while reasoning and cannot turn reasoning off.
 */
function asResponseFormat(params: ChatParams, tool: OpenAI.Chat.Completions.ChatCompletionFunctionTool): ChatParams {
  const { tools: _tools, tool_choice: _choice, reasoning_effort: _effort, ...rest } = params;
  const fn = tool.function;
  const instruction = fn.description ? `Answer with a JSON object for \`${fn.name}\`: ${fn.description}` : `Answer with a JSON object for \`${fn.name}\`.`;
  return {
    ...rest,
    messages: [{ role: "system", content: instruction }, ...params.messages],
    response_format: {
      type: "json_schema",
      json_schema: { name: fn.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64), schema: (fn.parameters ?? { type: "object" }) as Record<string, unknown>, strict: false },
    },
  } as ChatParams;
}

/** The structured-output reply presented as the tool call the caller forced. */
function asToolCallResponse(
  resp: OpenAI.Chat.Completions.ChatCompletion,
  name: string,
): OpenAI.Chat.Completions.ChatCompletion {
  const choice = resp.choices[0];
  if (!choice) return resp;
  const args = contentText(choice.message.content as unknown).trim() || "{}";
  return {
    ...resp,
    choices: [
      {
        ...choice,
        finish_reason: "tool_calls",
        message: {
          ...choice.message,
          content: null,
          tool_calls: [{ id: `call_${resp.id ?? "structured"}`, type: "function", function: { name, arguments: args } }],
        },
      },
      ...resp.choices.slice(1),
    ],
  };
}

/**
 * The endpoint does not serve the requested model id. Phrasings seen: OpenAI
 * (404 "The model `x` does not exist"), LiteLLM (400 "Invalid model name"),
 * OpenRouter (400 "x is not a valid model ID").
 */
export function isModelNotFound(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError) || (err.status !== 400 && err.status !== 404)) return false;
  if (err.code === "model_not_found") return true;
  const message = String(err.message ?? "");
  return (
    /model/i.test(message) &&
    /(does not exist|not found|invalid model|not a valid model|no such model|unknown model|not available)/i.test(message)
  );
}

/** A 404/405 that is not about the model: the base URL points at the wrong path. */
function isRouteNotFound(err: unknown): boolean {
  return (
    err instanceof OpenAI.APIError &&
    (err.status === 404 || err.status === 405) &&
    !isModelNotFound(err)
  );
}

/**
 * Some gateways (Databricks) answer errors as `{"error_code": …, "message": …}`.
 * The SDK reads only `{"error": {…}}` and would report "400 status code (no body)",
 * losing the message every fallback below matches on — so such a body is
 * rewritten into the shape the SDK reads. Any other response passes through untouched.
 */
export function errorEnvelopeFetch(base?: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await (base ?? globalThis.fetch)(input, init);
    if (res.ok || !/json/i.test(res.headers.get("content-type") ?? "")) return res;
    let body: unknown;
    try {
      body = JSON.parse(await res.clone().text());
    } catch {
      return res;
    }
    const b = body as { error?: unknown; error_code?: unknown; message?: unknown } | null;
    if (!b || typeof b !== "object" || "error" in b || b.error_code === undefined || typeof b.message !== "string") return res;
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    const code = String(b.error_code);
    return new Response(JSON.stringify({ error: { message: b.message, type: code, code } }), {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }) as typeof fetch;
}

/**
 * The text of a reply's `content`: a string, or (some gateways, e.g. Databricks
 * serving Qwen) a list of parts whose `text` parts carry the answer and whose
 * `reasoning` parts do not.
 */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type?: string; text: string } => !!p && typeof p.text === "string" && (p.type === undefined || p.type === "text" || p.type === "output_text"))
    .map((p) => p.text)
    .join("");
}

/** Base URLs to try in order: exactly as configured, then with the `/v1` suffix toggled. */
export function baseUrlCandidates(baseUrl: string | undefined): (string | undefined)[] {
  if (!baseUrl?.trim()) return [undefined];
  const configured = baseUrl.trim();
  const trimmed = configured.replace(/\/+$/, "");
  const toggled = /\/v1$/i.test(trimmed) ? trimmed.slice(0, -3) : `${trimmed}/v1`;
  return [configured, toggled];
}

export class OpenAIChatModel implements ChatModel {
  readonly label: string;
  private clients: (OpenAI | undefined)[];
  private baseUrls: (string | undefined)[];
  private models: string[];
  // Sticky across calls: once a fallback works, later calls skip the failing attempt.
  private routeIdx = 0;
  private modelIdx = 0;
  // Sticky: the model refuses function tools while reasoning and cannot stop reasoning.
  private toolsAsResponseFormat = false;
  // Sticky: the model accepts only `tool_choice: "auto"` (Claude 5.x behind Databricks serving endpoints).
  private forcedToolUnsupported = false;

  constructor(opts: OpenAIChatModelOptions) {
    this.models = [opts.model, ...(opts.modelFallbacks ?? []).filter((m) => m && m !== opts.model)];
    this.label = opts.label ?? `${PROVIDER}:${opts.model}`;
    this.baseUrls = baseUrlCandidates(opts.baseUrl);
    const first =
      opts.client ??
      new OpenAI({
        apiKey: opts.apiKey,
        baseURL: this.baseUrls[0],
        defaultHeaders: opts.headers,
        maxRetries: transportRetries(),
        fetch: errorEnvelopeFetch(),
      });
    this.clients = this.baseUrls.map((_, i) => (i === 0 ? first : undefined));
  }

  private clientAt(i: number): OpenAI {
    let c = this.clients[i];
    if (!c) {
      c = this.clients[0]!.withOptions({ baseURL: this.baseUrls[i] });
      this.clients[i] = c;
    }
    return c;
  }

  async create(req: ChatRequest): Promise<ChatResponse> {
    const messages = req.messages.map(toChatMessage);
    const tools = req.tools ? req.tools.map(toChatTool) : undefined;
    const params: ChatParams = { model: this.models[0]!, messages };
    if (req.temperature !== undefined) params.temperature = req.temperature;
    if (req.maxTokens !== undefined) params.max_tokens = req.maxTokens;

    const fmt = req.responseFormat ?? { kind: "text" };
    if (fmt.kind === "json") {
      // Coerce JSON via a forced synthetic tool — the one structured-output
      // mechanism shared with Anthropic (no reliance on `response_format`).
      params.tools = [
        ...(tools ?? []),
        { type: "function", function: { name: JSON_TOOL, description: "Return the answer as a JSON object.", parameters: { type: "object", additionalProperties: true } } },
      ];
      params.tool_choice = { type: "function", function: { name: JSON_TOOL } };
    } else if (fmt.kind === "tool") {
      params.tools = tools;
      params.tool_choice = { type: "function", function: { name: fmt.name } };
    } else if (tools) {
      params.tools = tools;
    }

    const resp = await this.createChatCompletion(params);
    return this.fromResponse(resp, fmt.kind);
  }

  /**
   * Walks the base-URL and model fallbacks: a route-level 404/405 advances to
   * the next base URL, an unknown-model error to the next model id. Each step
   * only moves forward, so the loop is bounded by the two candidate lists.
   */
  private async createChatCompletion(params: ChatParams): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    for (;;) {
      const ri = this.routeIdx;
      const mi = this.modelIdx;
      try {
        return await this.sendWithCompat(this.clientAt(ri), { ...params, model: this.models[mi]! });
      } catch (err) {
        if (isModelNotFound(err) && mi + 1 < this.models.length) {
          if (this.modelIdx === mi) {
            this.modelIdx = mi + 1;
            console.error(`⚠ model "${this.models[mi]}" not available; retrying as "${this.models[mi + 1]}"`);
          }
          continue;
        }
        if (isRouteNotFound(err) && ri + 1 < this.baseUrls.length) {
          if (this.routeIdx === ri) {
            this.routeIdx = ri + 1;
            console.error(`⚠ ${this.baseUrls[ri]} returned ${(err as { status?: number }).status}; retrying at ${this.baseUrls[ri + 1]}`);
          }
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Wraps `chat.completions.create` with a narrow, safe fallback: if the
   * server rejects an object-form `tool_choice` and exactly one tool was
   * offered, "required" is behaviorally identical (the model has nothing
   * else to pick), so retry once with the string form instead of failing
   * the whole build. Left alone when more than one tool is offered, since
   * "required" would then let the model choose freely instead of the
   * caller-specified tool — that ambiguity isn't safe to paper over
   * automatically.
   */
  private async sendWithCompat(
    client: OpenAI,
    params: ChatParams,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    let attempt = params;
    let structured: string | undefined;
    const forced = forcedSingleTool(params);
    if (this.toolsAsResponseFormat && forced) {
      attempt = asResponseFormat(params, forced);
      structured = forced.function.name;
    } else if (this.forcedToolUnsupported) {
      attempt = asAutoToolChoice(params) ?? params;
    }
    const finish = (resp: OpenAI.Chat.Completions.ChatCompletion) => (structured ? asToolCallResponse(resp, structured) : resp);
    // Bounded: one retry per known incompatibility below, never an open loop.
    for (let i = 0; i < 5; i++) {
      try {
        return finish(await client.chat.completions.create(attempt));
      } catch (err) {
        // Checked before the tool_choice fallback below: a reasoning refusal
        // also names tool_choice, and turning reasoning off keeps the caller's
        // chosen tool instead of loosening the choice to work around it.
        if (isRejectedToolsWithReasoning(err) && attempt.reasoning_effort === undefined) {
          attempt = { ...attempt, reasoning_effort: "none" } as ChatParams;
          continue;
        }
        // Reasoning cannot be turned off either: ask for the forced tool's
        // arguments as structured output instead, and keep doing so.
        if (isRejectedReasoningNone(err) && attempt.reasoning_effort === "none" && forced && !structured) {
          attempt = asResponseFormat(attempt, forced);
          structured = forced.function.name;
          this.toolsAsResponseFormat = true;
          continue;
        }
        // Checked before the object-form fallback below, which would only swap in
        // "required" — refused by these models just the same.
        if (isRejectedForcedToolChoice(err)) {
          const auto = asAutoToolChoice(attempt);
          if (auto) {
            attempt = auto;
            this.forcedToolUnsupported = true;
            continue;
          }
        }
        if (isRejectedObjectToolChoice(err) && typeof attempt.tool_choice === "object" && attempt.tools?.length === 1) {
          attempt = { ...attempt, tool_choice: "required" };
          continue;
        }
        if (isRejectedMaxTokens(err) && attempt.max_tokens !== undefined) {
          const { max_tokens, ...rest } = attempt;
          attempt = { ...rest, max_completion_tokens: max_tokens } as ChatParams;
          continue;
        }
        if (isRejectedTemperature(err) && attempt.temperature !== undefined) {
          const { temperature, ...rest } = attempt;
          attempt = rest as ChatParams;
          continue;
        }
        throw err;
      }
    }
    return finish(await client.chat.completions.create(attempt));
  }

  private fromResponse(
    resp: OpenAI.Chat.Completions.ChatCompletion,
    format: "text" | "json" | "tool",
  ): ChatResponse {
    const choice = resp.choices[0];
    const msg = choice?.message;
    const rawCalls = (msg?.tool_calls ?? []).filter(
      (c): c is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & { type: "function" } =>
        c.type === "function",
    );
    const parse = (s: string): unknown => {
      try {
        return JSON.parse(s || "{}");
      } catch {
        return {};
      }
    };

    let text = contentText(msg?.content);
    let toolCalls: ToolCall[] = rawCalls.map((c) => ({
      id: c.id,
      name: c.function.name,
      args: parse(c.function.arguments),
    }));

    if (format === "json") {
      // Surface the synthetic tool's object as JSON text; hide it from `toolCalls`.
      const jsonCall = toolCalls.find((c) => c.name === JSON_TOOL);
      if (jsonCall) text = JSON.stringify(jsonCall.args);
      toolCalls = toolCalls.filter((c) => c.name !== JSON_TOOL);
    }

    // A parts-list reply is replayed as plain text: its reasoning parts are not valid input.
    const raw = msg && Array.isArray(msg.content as unknown) ? { ...msg, content: contentText(msg.content) } : msg;
    return {
      text,
      toolCalls,
      usage: normalizeUsage(resp.usage),
      stopReason: choice?.finish_reason ?? null,
      assistant: {
        role: "assistant",
        content: contentText(msg?.content),
        toolCalls: toolCalls.length ? toolCalls : undefined,
        providerRaw: { provider: PROVIDER, raw },
      },
    };
  }
}

/** Cached tokens are inside `prompt_tokens`; subtract so `input` is uncached-only. */
function normalizeUsage(u: OpenAI.Completions.CompletionUsage | undefined): Usage {
  const prompt = u?.prompt_tokens ?? 0;
  const cacheRead = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input: Math.max(0, prompt - cacheRead),
    output: u?.completion_tokens ?? 0,
    cacheRead,
    cacheCreate: 0,
  };
}
