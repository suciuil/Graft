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
 *
 * Past that, everything here is tolerance rather than preference. An
 * OpenAI-compatible endpoint is a gateway whose own upstream calls can fail
 * while the HTTP status stays 200, and whose support for a forced `tool_choice`
 * — the one structured-output mechanism graft can rely on across providers —
 * ranges from exact to none. Each way that goes wrong gets its own narrow
 * recovery: {@link ProviderResponseError} for a 200 that is not a completion,
 * and a bounded rung ladder in {@link OpenAIChatModel.structured} for a
 * structured reply the endpoint answers some other way. None of it changes the
 * bytes on the wire for an endpoint that behaves.
 */
import OpenAI from "openai";
import { transportRetries } from "./types.js";
import { unwrapMarkdownFence } from "./recover-tool.js";
import { reasoningTokenAllowance } from "./effort.js";
import type { ChatModel, ChatRequest, ChatResponse, Message, ToolCall, ToolSpec, Usage } from "./types.js";

const PROVIDER = "openai";
/** Synthetic tool used to coerce a plain JSON object out of `{ kind: "json" }`. */
const JSON_TOOL = "emit_json";

/** How one attempt asks for the tool the caller needs. See the rung ladder. */
type ToolChoiceMode = "forced" | "required" | "auto";

/** Backoff before re-sending a 200 that carried an error instead of a completion. */
const EMPTY_RESPONSE_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

/** How many nested emulated `{name, parameters}` wrappers to unwrap before stopping. */
const MAX_UNWRAP_DEPTH = 2;

/** Stand-in id for a payload lifted out of `content` — no wire call ever had one. */
const CONTENT_CALL_ID = "from-content";

/**
 * Endpoints already seen to answer a forced `tool_choice` with something other
 * than a tool call, keyed `<baseUrl>|<model>`. Process-local on purpose: it
 * describes one gateway's current behaviour, the rung that works costs at most
 * one extra call, and the next run re-probes for free.
 *
 * Two observations are proof, because neither survives a retry: a reply the
 * endpoint did serve that just doesn't carry the asked-for call (prose where a
 * tool call was forced), and — counted over {@link forcedFallbackThreshold}
 * separate calls by {@link forcedToolChoiceRescues} — errored bodies on every
 * forced-family rung of a call that a lower rung then answered.
 */
const forcedToolChoiceIgnored = new Set<string>();

/**
 * Rescued calls per `<baseUrl>|<model>`: structured calls where every
 * forced-family rung failed with an errored body and the final "auto" rung then
 * answered. One such call is a hiccup — the upstream behind the gateway may
 * already be back, and a healthy endpoint must not spend the rest of the run
 * on the slow rungs — so the downgrade waits for
 * {@link forcedFallbackThreshold} of them, and a forced call that succeeds
 * resets the count.
 */
const forcedToolChoiceRescues = new Map<string, number>();

/**
 * Rescued calls it takes to stop probing the forced rung on an endpoint +
 * model (`GRAFT_LLM_FORCED_RESCUES`). Two by default: the first errored body
 * says the endpoint's upstream blinked; a second call walking the same ladder
 * to the same answer says the endpoint itself cannot serve the ask.
 */
function forcedFallbackThreshold(): number {
  const raw = Number(process.env.GRAFT_LLM_FORCED_RESCUES);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
}

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
  /** Wait between retries of a 200-that-is-an-error (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Thinking / reasoning effort sent as `reasoning_effort` on every request
   * (`GRAFT_REASONING_EFFORT`). Unset: the field is omitted and the model uses
   * its own default.
   */
  reasoningEffort?: string;
  /**
   * Throw when the endpoint rejects {@link reasoningEffort} instead of warning
   * once and dropping it. Only the probe behind `graft effort` sets this.
   */
  strictEffort?: boolean;
  /**
   * {@link reasoningEffort} is graft's default ("high" while
   * GRAFT_REASONING_EFFORT is not set), not the user's choice: a model that
   * does not take it runs at its own default. Any 400 left after the other
   * remedies drops it for the rest of the run, with a one-line note instead of
   * a warning.
   */
  effortOptional?: boolean;
  /** Transport retries; default {@link transportRetries}. A one-off probe passes 0. */
  maxRetries?: number;
  /** Per-request timeout in ms; default the SDK's. A one-off probe passes a short one. */
  timeoutMs?: number;
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
 * The endpoint refused the `reasoning_effort` graft sent: the level is not one
 * this model takes ("Unsupported value: 'reasoning_effort' does not support
 * 'xhigh' with this model"), or the model takes no effort at all
 * ("Unrecognized request argument supplied: reasoning_effort",
 * "reasoning is not supported"). A 400 naming reasoning is enough, unless it
 * names another parameter graft has its own remedy for: a thinking/tool_choice
 * clash (below) is about the forced tool, not the level.
 */
export function isRejectedReasoningEffort(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (status !== 400 && status !== 422) return false;
  const message = String((err as { message?: string })?.message ?? "");
  return (
    /reasoning|thinking/i.test(message) &&
    !/tool_choice/i.test(message) &&
    !isRejectedMaxTokens(err) &&
    !isRejectedTemperature(err) &&
    !isMaxTokensTooLarge(err)
  );
}

/** The token cap is above what the model can write ("max_tokens is too large", "… > 32000, which is the maximum allowed"). */
function isMaxTokensTooLarge(err: unknown): boolean {
  const message = String((err as { message?: string })?.message ?? "");
  return (
    (err as { status?: unknown })?.status === 400 &&
    /max_(completion_)?tokens/i.test(message) &&
    /too large|at most|maximum allowed|exceeds?\b|supports up to/i.test(message)
  );
}

/** A request the endpoint refused as malformed, whatever the wording. */
function isBadRequest(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  return status === 400 || status === 422;
}

/**
 * Thinking — switched on by the effort graft sent — rules out a forced tool:
 * Claude behind an OpenAI-compatible gateway answers "Thinking may not be
 * enabled when tool_choice forces tool use".
 */
function isThinkingToolChoiceConflict(err: unknown): boolean {
  const message = String((err as { message?: string })?.message ?? "");
  return (err as { status?: unknown })?.status === 400 && /tool_choice/i.test(message) && /thinking|reasoning/i.test(message);
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

/**
 * The endpoint knows the model but will not run it for this key: Databricks
 * answers 403 "This user's rate limit is set to 0." (or "Endpoint has a rate
 * limit set to 0.") for a model name it blocks, while serving the same model
 * under its other name. Only a model fallback can get past it.
 */
export function isModelRefused(err: unknown): boolean {
  return err instanceof OpenAI.APIError && err.status === 403 && /rate limit (is )?set to 0/i.test(String(err.message ?? ""));
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
 * serving Qwen, GLM-5.3 on Mistral's platform) a list of parts whose `text`
 * parts carry the answer and whose `reasoning` and image parts do not. Null is
 * an empty reply. Any other shape throws: coercing it to "" or
 * "[object Object]" would hide a provider format change instead of flagging it.
 */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) throw new Error(`Unsupported message.content type from provider: ${typeof content}`);
  return content
    .map((p) => (typeof p === "string" ? { text: p } : p))
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

/**
 * A 200 that is not a completion.
 *
 * A proxy in front of a model can answer HTTP 200 with
 * `{"error": {...}}` and no `choices` when the upstream call fails, because the
 * failure belongs to a server the proxy itself did not talk to. The SDK's retry
 * policy only ever sees the status, so it returns that body as a success, and
 * the first `choices[0]` used to turn it into a TypeError naming nothing a user
 * could act on. Retryable by construction — the request was never served — and
 * carrying the provider's own message and code so the failure that does reach
 * the caller says what the endpoint said.
 */
export class ProviderResponseError extends Error {
  /** The status the provider actually sent. 200: that is the whole surprise. */
  readonly status = 200;
  /** Always true — the same request can succeed on a later attempt. */
  readonly retryable = true;
  constructor(
    message: string,
    /** The provider's own error code, when the body carried one. */
    readonly code?: string | number,
  ) {
    super(message);
    this.name = "ProviderResponseError";
  }
}

/**
 * The completion inside a 200 body, or a typed error saying what came back
 * instead. The only gate onto the response fields: no caller downstream of it
 * may touch `choices` before this has decided the body holds one.
 */
function completionOrThrow(resp: unknown): OpenAI.Chat.Completions.ChatCompletion {
  const body = resp as { choices?: unknown; error?: unknown } | null | undefined;
  const err = body?.error as { message?: unknown; code?: unknown } | undefined;
  if (err) {
    const message =
      typeof err.message === "string" && err.message.trim()
        ? err.message
        : "the provider returned an error body with no choices";
    const code = typeof err.code === "string" || typeof err.code === "number" ? err.code : undefined;
    throw new ProviderResponseError(message, code);
  }
  if (!Array.isArray(body?.choices) || body.choices.length === 0) {
    throw new ProviderResponseError("the provider returned a successful response with no choices");
  }
  return body as OpenAI.Chat.Completions.ChatCompletion;
}

/**
 * A JSON value the model wrote into `content` instead of a tool call: fenced or
 * bare, or wrapped in a sentence around it. Object before array, the same order
 * the content recovery in ./recover-tool.ts uses, so both agree on what a
 * half-written reply contains.
 */
function jsonFromContent(text: string): unknown {
  const raw = unwrapMarkdownFence((text ?? "").trim());
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    /* a sentence around the payload — try the outermost braces/brackets */
  }
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = raw.indexOf(open);
    const end = raw.lastIndexOf(close);
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      /* not a single well-formed value — the caller judges it as prose */
    }
  }
  return undefined;
}

/**
 * The `{name, parameters|arguments|args}` call a model wrote into `content`
 * instead of `tool_calls` (#129) — alone, emulated in an array, or wrapped in a
 * sentence — and failing that a plain JSON object, which is what a gateway that
 * ignored a forced `tool_choice` writes when one tool was offered.
 *
 * Deliberately conservative: only the tool the caller named is accepted, and
 * the caller still validates the shape it asked for.
 */
function payloadFromContent(text: string, toolName: string, depth = 0): Record<string, unknown> | undefined {
  const value = jsonFromContent(text);
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = item && typeof item === "object" ? payloadOf(item as Record<string, unknown>, toolName, depth) : undefined;
      if (hit) return hit;
    }
    return undefined;
  }
  return payloadOf(value as Record<string, unknown>, toolName, depth);
}

/** One emulated call object, at whatever depth of nesting it sits. */
function payloadOf(obj: Record<string, unknown>, toolName: string, depth: number): Record<string, unknown> | undefined {
  // A wrapper naming a different tool is not this caller's payload.
  if (typeof obj.name === "string" && obj.name !== toolName) return undefined;
  const params = obj.parameters ?? obj.arguments ?? obj.args;
  if (params === undefined) return Object.keys(obj).length ? obj : undefined;
  const parsed = typeof params === "string" ? tryParse(params) : params;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return depth < MAX_UNWRAP_DEPTH
    ? payloadOf(parsed as Record<string, unknown>, toolName, depth + 1)
    : (parsed as Record<string, unknown>);
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
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
  private sleep: (ms: number) => Promise<void>;
  /** Key into {@link forcedToolChoiceIgnored}: one entry per endpoint + model. */
  private choiceKey: string;
  private forcedIgnored: boolean;
  /** The configured `reasoning_effort`, or undefined once the endpoint refused it (non-strict). */
  private effort: string | undefined;
  private strictEffort: boolean;
  private effortOptional: boolean;
  // Sticky: the endpoint refused the larger token cap that leaves room for reasoning.
  private reasoningAllowanceRefused = false;
  // Sticky: toolsAsResponseFormat was turned on only to keep the effort alongside a forced tool.
  private structuredForEffort = false;
  private maxRetries: number | undefined;

  constructor(opts: OpenAIChatModelOptions) {
    this.maxRetries = opts.maxRetries;
    this.effort = opts.reasoningEffort?.trim() || undefined;
    this.strictEffort = opts.strictEffort ?? false;
    this.effortOptional = opts.effortOptional ?? false;
    this.models = [opts.model, ...(opts.modelFallbacks ?? []).filter((m) => m && m !== opts.model)];
    this.label = opts.label ?? `${PROVIDER}:${opts.model}`;
    this.baseUrls = baseUrlCandidates(opts.baseUrl);
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.choiceKey = `${opts.baseUrl ?? ""}|${opts.model}`;
    this.forcedIgnored = forcedToolChoiceIgnored.has(this.choiceKey);
    const first =
      opts.client ??
      new OpenAI({
        apiKey: opts.apiKey,
        baseURL: this.baseUrls[0],
        defaultHeaders: opts.headers,
        maxRetries: opts.maxRetries ?? transportRetries(),
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
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
    if (this.effort) params.reasoning_effort = this.effort as ChatParams["reasoning_effort"];

    const fmt = req.responseFormat ?? { kind: "text" };
    // The tool whose call answers the request, and the format that needs one.
    let structured: { tool: string; kind: "json" | "tool" } | null = null;
    if (fmt.kind === "json") {
      // Coerce JSON via a forced synthetic tool — the one structured-output
      // mechanism shared with Anthropic (no reliance on `response_format`).
      params.tools = [
        ...(tools ?? []),
        { type: "function", function: { name: JSON_TOOL, description: "Return the answer as a JSON object.", parameters: { type: "object", additionalProperties: true } } },
      ];
      structured = { tool: JSON_TOOL, kind: "json" };
    } else if (fmt.kind === "tool") {
      params.tools = tools;
      structured = { tool: fmt.name, kind: "tool" };
    } else if (tools) {
      params.tools = tools;
    }

    if (!structured) return this.fromResponse(await this.complete(params, true), "text");
    return this.structured(params, structured.tool, structured.kind);
  }

  /**
   * A structured reply, however the endpoint is willing to produce one.
   *
   * A forced `tool_choice` is the only structured-output mechanism graft can
   * rely on across providers, and it is the least portable corner of the
   * OpenAI-compatible spec: an endpoint can reject the object form (handled one
   * layer down), answer 200 with an error object, or quietly answer in prose.
   * So walk a bounded ladder — the object form, then `"required"`, then
   * `"auto"` with the tool named in the prompt — and take the payload from
   * `content` if that is where it landed. `"required"` only stands in for the
   * object form when one tool was offered, the same rule the 400 fallback
   * applies: with several tools it would let the model pick freely rather than
   * honour the caller's choice.
   *
   * An endpoint that honours the forced form never sees rung two — the first
   * attempt answers the question and the ladder ends.
   *
   * An errored body is a weaker signal than a served-but-wrong reply, since it
   * may belong to an upstream that a retry would reach, so it never downgrades
   * on its own: it is counted instead. A call where every forced-family rung
   * failed that way and the final "auto" rung then answered is a rescue, and
   * the second rescue with no successful forced call in between is the
   * endpoint's pattern, not its upstream's — that, and only that, switches
   * later calls straight to "auto".
   */
  private async structured(base: ChatParams, tool: string, kind: "json" | "tool"): Promise<ChatResponse> {
    const rungs: ToolChoiceMode[] = this.forcedIgnored
      ? ["auto"]
      : base.tools?.length === 1
        ? ["forced", "required", "auto"]
        : ["forced", "auto"];

    // How many rungs of this call have answered with an errored body so far.
    // The rescue judgement needs the whole call: forced-family rungs errored,
    // and the rung that finally answered being the one below all of them.
    let erroredAbove = 0;

    for (const rung of rungs.slice(0, -1)) {
      // sendWithCompat learned mid-call that this endpoint takes only "auto" (a 400 on the forced choice): a
      // further forced-family rung would go out as that same "auto" request, so go straight to the last rung.
      if (this.forcedToolUnsupported) break;
      let res: ChatResponse;
      try {
        // No empty-response retry on a rung with a successor: changing the ask
        // is a better next move than re-sending a request the endpoint cannot
        // serve, and it costs the same one call.
        res = this.fromResponse(await this.complete(this.attempt(base, rung, tool), false), kind);
      } catch (err) {
        if (!(err instanceof ProviderResponseError)) throw err;
        erroredAbove += 1;
        continue;
      }
      if (this.delivered(res, kind, tool)) {
        // The forced rung answering is the strongest counter-evidence there
        // is: whatever errored bodies came before, this endpoint serves the
        // ask, and the count starts over.
        if (rung === "forced") forcedToolChoiceRescues.delete(this.choiceKey);
        return fromContentAsPayload(res, kind, tool);
      }
      this.rememberForcedIgnored();
    }

    // Last rung: "auto" plus the tool named in the prompt, retried on an
    // errored body. Whatever comes back is the answer — the payload from
    // `content` when that is where it landed, the raw reply otherwise, so the
    // caller's own miss classification still sees exactly what the model said.
    const last = this.fromResponse(await this.complete(this.attempt(base, "auto", tool), true), kind);
    if (this.delivered(last, kind, tool) && erroredAbove === rungs.length - 1) this.noteForcedRescue();
    return fromContentAsPayload(last, kind, tool);
  }

  /** One rung: the forced object form, its equivalent string form, or "auto" plus a prompt. */
  private attempt(base: ChatParams, rung: ToolChoiceMode, tool: string): ChatParams {
    if (rung === "forced") return { ...base, tool_choice: { type: "function", function: { name: tool } } };
    if (rung === "required") return { ...base, tool_choice: "required" };
    return { ...base, tool_choice: "auto", messages: withToolInstruction(base.messages, tool) };
  }

  /** Did the reply carry the payload the caller forced a tool for? */
  private delivered(res: ChatResponse, kind: "json" | "tool", tool: string): boolean {
    if (kind === "json") return jsonFromContent(res.text) !== undefined;
    return res.toolCalls.some((c) => c.name === tool) || payloadFromContent(res.text, tool) !== undefined;
  }

  /**
   * One more rescued call for this endpoint + model. When the count reaches
   * the threshold with no successful forced call in between, the endpoint is
   * marked the same way a served-but-wrong reply marks it.
   */
  private noteForcedRescue(): void {
    if (this.forcedIgnored) return;
    const rescues = (forcedToolChoiceRescues.get(this.choiceKey) ?? 0) + 1;
    forcedToolChoiceRescues.set(this.choiceKey, rescues);
    if (rescues >= forcedFallbackThreshold()) this.rememberForcedIgnored();
  }

  /**
   * Remember, for this process, that the endpoint did not answer a forced
   * `tool_choice` with a tool call, so later requests go straight to the rung
   * that works. Logged once per endpoint + model — the set is shared by every
   * instance, so a second adapter for the same endpoint never repeats it: it
   * changes the bytes on the wire, which is exactly what someone reading a
   * failing build needs told.
   */
  private rememberForcedIgnored(): void {
    this.forcedIgnored = true;
    if (forcedToolChoiceIgnored.has(this.choiceKey)) return;
    forcedToolChoiceIgnored.add(this.choiceKey);
    console.error(
      `⚠ ${this.label}: the endpoint did not honor a forced tool_choice — asking for the tool in the prompt instead (tool_choice "auto") for the rest of this run.`,
    );
  }

  /**
   * One completion, with the transport's retry policy extended to a 200 that
   * carried an error instead of one. The SDK retries 429, 5xx and connection
   * failures but never a successful status, and that body is the endpoint
   * reporting a failed upstream call — the same judgement, so the same
   * `GRAFT_LLM_RETRIES` budget and backoff apply, and the typed error is what
   * reaches the caller once that budget is spent.
   */
  private async complete(params: ChatParams, retryErroredBody: boolean): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const retries = retryErroredBody ? (this.maxRetries ?? transportRetries()) : 0;
    for (let attempt = 0; ; attempt++) {
      let failure: ProviderResponseError;
      try {
        return completionOrThrow(await this.createChatCompletion(params));
      } catch (err) {
        if (!(err instanceof ProviderResponseError)) throw err;
        failure = err;
      }
      if (attempt >= retries) throw failure;
      const wait = EMPTY_RESPONSE_BACKOFF_MS[Math.min(attempt, EMPTY_RESPONSE_BACKOFF_MS.length - 1)]!;
      await this.sleep(wait);
    }
  }

  /**
   * Walks the base-URL and model fallbacks: a route-level 404/405 advances to
   * the next base URL, an unknown or refused model ({@link isModelRefused}) to
   * the next model id. Each step only moves forward, so the loop is bounded by
   * the two candidate lists.
   */
  private async createChatCompletion(params: ChatParams): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    for (;;) {
      const ri = this.routeIdx;
      const mi = this.modelIdx;
      try {
        return await this.sendWithCompat(this.clientAt(ri), { ...params, model: this.models[mi]! });
      } catch (err) {
        if ((isModelNotFound(err) || isModelRefused(err)) && mi + 1 < this.models.length) {
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
    // The forced tool as structured output, keeping a configured effort: only
    // function tools clash with reasoning, a response format does not.
    const asStructured = (p: ChatParams, tool: OpenAI.Chat.Completions.ChatCompletionFunctionTool): ChatParams => {
      const rf = asResponseFormat(p, tool);
      return this.effort ? ({ ...rf, reasoning_effort: this.effort } as ChatParams) : rf;
    };
    if (this.toolsAsResponseFormat && forced) {
      attempt = asStructured(params, forced);
      structured = forced.function.name;
    } else if (this.forcedToolUnsupported) {
      attempt = asAutoToolChoice(params) ?? params;
    }
    // Reasoning tokens count against the cap on this wire: leave room for them
    // on top of what the caller asked for, so thinking cannot crowd out the answer.
    let allowance =
      this.effort && !this.reasoningAllowanceRefused && attempt.max_tokens != null ? reasoningTokenAllowance(this.effort) : 0;
    if (allowance) attempt = { ...attempt, max_tokens: attempt.max_tokens! + allowance };
    // Stop sending the effort: a warning for the user's own level, a note for graft's default.
    const dropEffort = (p: ChatParams): ChatParams => {
      console.error(
        this.effortOptional
          ? `· ${this.label}: the model does not take thinking effort "${this.effort}" (graft's default) — using its own default.`
          : `⚠ ${this.label}: the endpoint refused reasoning effort "${this.effort}" — using the model's default for the rest of this run. Run \`graft effort\` to pick a level this model accepts.`,
      );
      this.effort = undefined;
      const { reasoning_effort: _dropped, ...rest } = p;
      return rest as ChatParams;
    };
    const finish = (resp: OpenAI.Chat.Completions.ChatCompletion) => (structured ? asToolCallResponse(resp, structured) : resp);
    // Bounded: one retry per known incompatibility below, never an open loop.
    for (let i = 0; i < 9; i++) {
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
        // The same refusal with an effort the user chose: keep the effort and
        // ask for the forced tool's arguments as structured output instead.
        // Only with no single forced tool to rewrite does reasoning go off.
        if (
          (isRejectedToolsWithReasoning(err) || isThinkingToolChoiceConflict(err)) &&
          this.effort &&
          attempt.reasoning_effort === this.effort &&
          this.effort !== "none"
        ) {
          if (forced && !structured) {
            attempt = asStructured(attempt, forced);
            structured = forced.function.name;
            this.toolsAsResponseFormat = true;
            this.structuredForEffort = true;
            continue;
          }
          if (!forced) {
            attempt = { ...attempt, reasoning_effort: "none" } as ChatParams;
            continue;
          }
        }
        // Reasoning cannot be turned off either: ask for the forced tool's
        // arguments as structured output instead, and keep doing so.
        if (isRejectedReasoningNone(err) && attempt.reasoning_effort === "none" && this.effort !== "none" && forced && !structured) {
          attempt = asStructured(attempt, forced);
          structured = forced.function.name;
          this.toolsAsResponseFormat = true;
          continue;
        }
        // The configured effort itself was refused: the level is not one this
        // model takes. The probe wants that as an error; a build warns once and
        // carries on at the model's default rather than failing every call.
        if (this.effort && attempt.reasoning_effort === this.effort && isRejectedReasoningEffort(err)) {
          if (this.strictEffort) throw err;
          attempt = dropEffort(attempt);
          continue;
        }
        // The room left for reasoning is more than the model can write: back to the caller's cap.
        if (allowance && isMaxTokensTooLarge(err)) {
          this.reasoningAllowanceRefused = true;
          attempt =
            attempt.max_tokens != null
              ? { ...attempt, max_tokens: attempt.max_tokens - allowance }
              : attempt.max_completion_tokens != null
                ? { ...attempt, max_completion_tokens: attempt.max_completion_tokens - allowance }
                : attempt;
          allowance = 0;
          continue;
        }
        // Checked before the object-form fallback below, which would only swap in
        // "required" — refused by these models just the same.
        if (isRejectedForcedToolChoice(err)) {
          const auto = asAutoToolChoice(attempt);
          if (auto) {
            attempt = auto;
            this.forcedToolUnsupported = true;
            // Tell structured()'s rung ladder too: every forced or "required" rung would now go out as this same
            // "auto" request, so it should start at "auto" instead of re-sending it once per rung.
            this.rememberForcedIgnored();
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
        // Graft's default effort, and a refusal nothing above explains: the
        // model may not take an effort at all, in words no check knows. Try once
        // without it — the caller's own request, as before effort existed —
        // and keep going without it when that works.
        if (this.effortOptional && !this.strictEffort && this.effort && attempt.reasoning_effort === this.effort && isBadRequest(err)) {
          if (structured && this.structuredForEffort) {
            // The structured-output rewrite was only there to keep the effort.
            structured = undefined;
            this.toolsAsResponseFormat = false;
            this.structuredForEffort = false;
            attempt = dropEffort(params);
          } else {
            attempt = dropEffort(attempt);
          }
          if (allowance) {
            const cap = attempt.max_tokens ?? attempt.max_completion_tokens;
            if (cap != null && cap > (params.max_tokens ?? 0)) {
              attempt = attempt.max_tokens != null
                ? { ...attempt, max_tokens: attempt.max_tokens - allowance }
                : { ...attempt, max_completion_tokens: attempt.max_completion_tokens! - allowance };
            }
            allowance = 0;
          }
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
    // `resp` came through `completionOrThrow`, so `choices` holds at least one
    // entry by now: this is a peek at the first one, not a dereference of a
    // possibly-missing array.
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

/**
 * Name the tool in a system turn of its own, so an "auto" rung has something to
 * act on. A separate message leaves every part the caller wrote — including a
 * cache breakpoint — byte-for-byte as it was, so this costs no cache.
 */
function withToolInstruction(messages: ChatMessage[], tool: string): ChatMessage[] {
  const line: ChatMessage = {
    role: "system",
    content: `Answer by calling the ${tool} tool. Put your entire answer in that tool's arguments and reply with nothing else.`,
  } as ChatMessage;
  // After the last system turn, or first when the caller sent none.
  const at = messages.map((m) => m.role).lastIndexOf("system") + 1;
  return [...messages.slice(0, at), line, ...messages.slice(at)];
}

/**
 * An accepted rung's answer, put in the shape the caller asked for. A model that
 * ignored a forced `tool_choice` often produced the payload anyway, as text
 * (#129) — so surface it as the JSON text a `{ kind: "json" }` caller expects,
 * or as a call to the named tool a `{ kind: "tool" }` caller expects, rather
 * than reporting an empty turn. A reply with no recognizable payload is passed
 * through untouched, so the caller's own miss classification still sees exactly
 * what the model said.
 */
function fromContentAsPayload(res: ChatResponse, kind: "json" | "tool", tool: string): ChatResponse {
  if (kind === "json") {
    const value = jsonFromContent(res.text);
    if (value === undefined) return res;
    const text = JSON.stringify(value);
    return { ...res, text, assistant: { ...res.assistant, content: text } };
  }
  if (res.toolCalls.some((c) => c.name === tool)) return res;
  const args = payloadFromContent(res.text, tool);
  if (!args) return res;
  const call: ToolCall = { id: CONTENT_CALL_ID, name: tool, args };
  return {
    ...res,
    toolCalls: [...res.toolCalls, call],
    assistant: { ...res.assistant, toolCalls: [...(res.assistant.toolCalls ?? []), call] },
  };
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
