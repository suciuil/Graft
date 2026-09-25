/**
 * Network-free adapter tests. Each adapter is handed a STUB SDK client that
 * records the request it received and returns a canned response, so we assert
 * both directions of the translation (neutral → wire, wire → neutral) with no
 * key and no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import AnthropicSDK from "@anthropic-ai/sdk";
import { OpenAIChatModel, baseUrlCandidates } from "../src/ai/llm/openai.js";
import { resolveConfig, DEFAULT_MODELS } from "../src/ai/providers.js";
import { ProviderFallbackChatModel, createChatModel, LLM_INCUBATOR_BASE_URL } from "../src/ai/llm/factory.js";
import type { ChatModel } from "../src/ai/llm/types.js";
import { AnthropicChatModel, anthropicBaseUrl } from "../src/ai/llm/anthropic.js";
import type { ChatRequest } from "../src/ai/llm/types.js";

// --- OpenAI adapter ---------------------------------------------------------

function fakeOpenAI(resp: unknown) {
  const box: { params?: any } = {};
  const client = {
    chat: { completions: { create: async (params: any) => ((box.params = params), resp) } },
  } as unknown as OpenAI;
  return { client, box };
}

function openAiResp(over: Partial<any> = {}): any {
  return {
    choices: [{ message: { content: "hello", tool_calls: [] }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } },
    ...over,
  };
}

const REJECTED_OBJECT_TOOL_CHOICE = "Invalid tool_choice type: 'object'. Supported string values: none, auto, required";

test("openai: plain text — system/user map to strings, usage is uncached-only", async () => {
  const { client, box } = fakeOpenAI(openAiResp());
  const m = new OpenAIChatModel({ apiKey: "x", model: "gpt-x", client });
  const res = await m.create({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    temperature: 0,
  });
  assert.equal(box.params.model, "gpt-x");
  assert.equal(box.params.messages[0].content, "sys"); // plain string, no cache parts
  assert.equal(box.params.temperature, 0); // forwarded on OpenAI-compatible
  assert.equal(box.params.tools, undefined);
  assert.equal(res.text, "hello");
  assert.deepEqual(res.usage, { input: 70, output: 20, cacheRead: 30, cacheCreate: 0 });
});

test("openai: cacheBreakpoint turns content into a cache_control part", async () => {
  const { client, box } = fakeOpenAI(openAiResp());
  const m = new OpenAIChatModel({ apiKey: "x", model: "gpt-x", client });
  await m.create({ messages: [{ role: "user", content: "hi", cacheBreakpoint: true }] });
  const part = box.params.messages[0].content[0];
  assert.equal(part.type, "text");
  assert.deepEqual(part.cache_control, { type: "ephemeral" });
});

test("openai: forced tool — args come back PARSED", async () => {
  const resp = openAiResp({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "record_graph", arguments: '{"nodes":[1,2]}' } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  const { client, box } = fakeOpenAI(resp);
  const m = new OpenAIChatModel({ apiKey: "x", model: "gpt-x", client });
  const res = await m.create({
    messages: [{ role: "user", content: "go" }],
    tools: [{ name: "record_graph", description: "d", parameters: { type: "object" } }],
    responseFormat: { kind: "tool", name: "record_graph" },
  });
  assert.deepEqual(box.params.tool_choice, { type: "function", function: { name: "record_graph" } });
  assert.equal(res.toolCalls.length, 1);
  assert.deepEqual(res.toolCalls[0].args, { nodes: [1, 2] });
});

test("openai: json mode routes through a synthetic forced tool and returns JSON text", async () => {
  const resp = openAiResp({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "emit_json", arguments: '{"correct":true}' } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  const { client, box } = fakeOpenAI(resp);
  const m = new OpenAIChatModel({ apiKey: "x", model: "gpt-x", client });
  const res = await m.create({ messages: [{ role: "user", content: "grade" }], responseFormat: { kind: "json" } });
  assert.equal(box.params.tool_choice.function.name, "emit_json");
  assert.equal(res.text, '{"correct":true}');
  assert.equal(res.toolCalls.length, 0); // synthetic tool hidden
});

test("openai: assistant providerRaw replays verbatim", async () => {
  const { client, box } = fakeOpenAI(openAiResp());
  const m = new OpenAIChatModel({ apiKey: "x", model: "gpt-x", client });
  const raw = { role: "assistant", content: "verbatim", extra: 1 };
  await m.create({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "reconstructed", providerRaw: { provider: "openai", raw } },
    ],
  });
  assert.deepEqual(box.params.messages[1], raw);
});

test("openai: retries with tool_choice \"required\" when the server rejects the object form (single tool)", async () => {
  const calls: any[] = [];
  const resp = openAiResp({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "emit_json", arguments: '{"correct":true}' } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  const client = {
    chat: {
      completions: {
        create: async (params: any) => {
          calls.push(params);
          if (calls.length === 1) {
            throw new OpenAI.APIError(400, { message: REJECTED_OBJECT_TOOL_CHOICE }, REJECTED_OBJECT_TOOL_CHOICE, new Headers());
          }
          return resp;
        },
      },
    },
  } as unknown as OpenAI;
  const m = new OpenAIChatModel({ apiKey: "x", model: "local-model", client });
  const res = await m.create({ messages: [{ role: "user", content: "grade" }], responseFormat: { kind: "json" } });

  assert.equal(calls.length, 2); // first attempt (object form) + retry (string form)
  assert.deepEqual(calls[0].tool_choice, { type: "function", function: { name: "emit_json" } });
  assert.equal(calls[1].tool_choice, "required");
  assert.equal(res.text, '{"correct":true}');
});

test("openai: does NOT paper over a rejected object tool_choice when multiple tools are offered", async () => {
  let callCount = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          callCount++;
          throw new OpenAI.APIError(400, { message: REJECTED_OBJECT_TOOL_CHOICE }, REJECTED_OBJECT_TOOL_CHOICE, new Headers());
        },
      },
    },
  } as unknown as OpenAI;
  const m = new OpenAIChatModel({ apiKey: "x", model: "local-model", client });
  await assert.rejects(
    () =>
      m.create({
        messages: [{ role: "user", content: "go" }],
        tools: [
          { name: "a", description: "d", parameters: { type: "object" } },
          { name: "b", description: "d", parameters: { type: "object" } },
        ],
        responseFormat: { kind: "tool", name: "a" },
      }),
    OpenAI.APIError,
  );
  assert.equal(callCount, 1); // no ambiguous retry — the caller asked for "a" specifically
});

test("openai: baseUrlCandidates keeps the configured URL first, then toggles /v1", () => {
  assert.deepEqual(baseUrlCandidates("https://gw.example/v1"), ["https://gw.example/v1", "https://gw.example"]);
  assert.deepEqual(baseUrlCandidates("https://gw.example/v1/"), ["https://gw.example/v1/", "https://gw.example"]);
  assert.deepEqual(baseUrlCandidates("https://gw.example"), ["https://gw.example", "https://gw.example/v1"]);
  assert.deepEqual(baseUrlCandidates("https://gw.example/"), ["https://gw.example/", "https://gw.example/v1"]);
  assert.deepEqual(baseUrlCandidates(undefined), [undefined]);
});

/** A stub whose behavior depends on the base URL it was cloned with via `withOptions`. */
function routedClient(handler: (baseURL: string | undefined, params: any) => unknown, calls: any[]) {
  const make = (baseURL: string | undefined): OpenAI =>
    ({
      withOptions: (o: { baseURL?: string }) => make(o.baseURL),
      chat: {
        completions: {
          create: async (params: any) => {
            calls.push({ baseURL, model: params.model });
            return handler(baseURL, params);
          },
        },
      },
    }) as unknown as OpenAI;
  return make;
}

test("openai: an unknown prefixed model falls back to the bare id, and sticks", async () => {
  const calls: any[] = [];
  const unknown = "Invalid model name passed in model=google/gemini-x";
  const make = routedClient((_b, p) => {
    if (p.model === "google/gemini-x") throw new OpenAI.APIError(400, { message: unknown }, unknown, new Headers());
    return openAiResp();
  }, calls);
  const m = new OpenAIChatModel({ apiKey: "x", model: "google/gemini-x", modelFallbacks: ["gemini-x"], client: make("u/v1") });
  const { err } = await captureStderr(async () => {
    await m.create({ messages: [{ role: "user", content: "hi" }] });
    await m.create({ messages: [{ role: "user", content: "hi" }] });
  });
  assert.deepEqual(calls.map((c) => c.model), ["google/gemini-x", "gemini-x", "gemini-x"]);
  assert.ok(err.some((l) => /not available; retrying as "gemini-x"/.test(l)));
});

test("openai: a route 404 on the configured base URL retries with /v1 added, and sticks", async () => {
  const calls: any[] = [];
  const make = routedClient((b) => {
    if (b === "https://gw.example") throw new OpenAI.APIError(404, undefined, "Not Found", new Headers());
    return openAiResp();
  }, calls);
  const m = new OpenAIChatModel({ apiKey: "x", model: "m", baseUrl: "https://gw.example", client: make("https://gw.example") });
  await captureStderr(async () => {
    await m.create({ messages: [{ role: "user", content: "hi" }] });
    await m.create({ messages: [{ role: "user", content: "hi" }] });
  });
  assert.deepEqual(calls.map((c) => c.baseURL), ["https://gw.example", "https://gw.example/v1", "https://gw.example/v1"]);
});

test("openai: an unknown model with no fallback left is rethrown", async () => {
  const msg = "The model `m` does not exist";
  const make = routedClient(() => {
    throw new OpenAI.APIError(404, { message: msg }, msg, new Headers());
  }, []);
  const m = new OpenAIChatModel({ apiKey: "x", model: "m", client: make(undefined) });
  await assert.rejects(() => m.create({ messages: [{ role: "user", content: "hi" }] }), OpenAI.APIError);
});

test("resolveConfig: any provider-prefixed model gets its bare id as a fallback", () => {
  const keys = ["GRAFT_PROVIDER", "GRAFT_MODEL", "GRAFT_OPENROUTER_MODEL", "ORCAROUTER_MODEL", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] as const;
  const saved = keys.map((k) => process.env[k]);
  for (const k of keys) delete process.env[k];
  try {
    const def = resolveConfig({ provider: "openai" });
    assert.equal(def.model, DEFAULT_MODELS.openai);
    assert.deepEqual(def.modelFallbacks, [DEFAULT_MODELS.openai.slice(DEFAULT_MODELS.openai.lastIndexOf("/") + 1)]);
    assert.deepEqual(resolveConfig({ provider: "openai", model: "vendor/custom" }).modelFallbacks, ["custom"]);
    process.env.GRAFT_MODEL = "google/gemini-x";
    assert.deepEqual(resolveConfig({ provider: "openai" }).modelFallbacks, ["gemini-x"]);
    delete process.env.GRAFT_MODEL;
    assert.equal(resolveConfig({ provider: "openai", model: "gemini-x" }).modelFallbacks, undefined);
  } finally {
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }
});

const CONFIG_ENV = [
  "GRAFT_PROVIDER", "GRAFT_MODEL", "GRAFT_OPENROUTER_MODEL", "ORCAROUTER_MODEL",
  "GRAFT_BASE_URL", "ANTHROPIC_BASE_URL", "OPENROUTER_BASE_URL", "ORCAROUTER_BASE_URL",
  "GRAFT_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "ORCAROUTER_API_KEY",
] as const;

/** Run `fn` with every config env var cleared, then `vars` applied; restores the real env after. */
function withEnv(vars: Partial<Record<(typeof CONFIG_ENV)[number], string>>, fn: () => void): void {
  const saved = CONFIG_ENV.map((k) => process.env[k]);
  for (const k of CONFIG_ENV) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    fn();
  } finally {
    CONFIG_ENV.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }
}

test("resolveConfig: an unset provider gets an anthropic fallback only when the key stays on a safe host", () => {
  withEnv({}, () => {
    const gw = resolveConfig({ apiKey: "k", baseUrl: "https://gw.example/v1" });
    assert.deepEqual(gw.providerFallback, { provider: "anthropic", model: DEFAULT_MODELS.anthropic });
    assert.deepEqual(resolveConfig({ apiKey: "k", baseUrl: "https://gw", model: "m" }).providerFallback, { provider: "anthropic", model: "m" });
    assert.equal(resolveConfig({ provider: "openai", apiKey: "sk-openai" }).providerFallback, undefined, "explicit provider: no fallback");
  });
  withEnv({ ORCAROUTER_API_KEY: "orca" }, () => {
    assert.equal(resolveConfig().baseUrl, undefined, "a legacy key keeps its old routing");
    assert.equal(resolveConfig().providerFallback, undefined, "no base URL: never send a non-Anthropic key to api.anthropic.com");
  });
});

test("resolveConfig: nothing configured → the LLM Incubator gateway, with the anthropic fallback on the same host", () => {
  withEnv({ GRAFT_API_KEY: "k" }, () => {
    const c = resolveConfig();
    assert.equal(c.provider, "llm-incubator");
    assert.equal(c.baseUrl, LLM_INCUBATOR_BASE_URL);
    assert.equal(c.model, "gemini-3.8-flash");
    assert.deepEqual(c.providerFallback, { provider: "anthropic", model: DEFAULT_MODELS.anthropic });
  });
  withEnv({ GRAFT_API_KEY: "k", GRAFT_PROVIDER: "openai" }, () => {
    const c = resolveConfig();
    assert.equal(c.provider, "openai", "an explicit openai provider is not redirected");
    assert.equal(c.baseUrl, undefined);
  });
});

test("resolveConfig: GRAFT_BASE_URL → ANTHROPIC_BASE_URL → LLM Incubator", () => {
  withEnv({ GRAFT_API_KEY: "k", GRAFT_BASE_URL: "https://graft", ANTHROPIC_BASE_URL: "https://anthropic-gw" }, () => {
    assert.equal(resolveConfig().baseUrl, "https://graft");
  });
  withEnv({ GRAFT_API_KEY: "k", ANTHROPIC_BASE_URL: "https://anthropic-gw" }, () => {
    const c = resolveConfig();
    assert.equal(c.baseUrl, "https://anthropic-gw");
    assert.equal(c.provider, "openai");
  });
  withEnv({ GRAFT_API_KEY: "k" }, () => assert.equal(resolveConfig().baseUrl, LLM_INCUBATOR_BASE_URL));
});

test("resolveConfig: GRAFT_API_KEY → ANTHROPIC_AUTH_TOKEN (sent as Bearer on the anthropic wire) → legacy keys", () => {
  withEnv({ GRAFT_API_KEY: "graft", ANTHROPIC_AUTH_TOKEN: "tok" }, () => {
    const c = resolveConfig();
    assert.equal(c.apiKey, "graft");
    assert.equal(c.bearerAuth, undefined);
  });
  withEnv({ ANTHROPIC_AUTH_TOKEN: "tok", OPENROUTER_API_KEY: "or" }, () => {
    const c = resolveConfig();
    assert.equal(c.apiKey, "tok");
    assert.equal(c.bearerAuth, true);
    assert.equal(c.usedLegacyEnv, false);
  });
  withEnv({ OPENROUTER_API_KEY: "or", ANTHROPIC_BASE_URL: "https://anthropic-gw" }, () => {
    const c = resolveConfig();
    assert.equal(c.apiKey, "or");
    assert.equal(c.baseUrl, "https://openrouter.ai/api/v1", "legacy OpenRouter setup unchanged");
  });
});

test("factory: llm-incubator speaks the OpenAI wire with its own label", () => {
  const m = createChatModel({ provider: "llm-incubator", apiKey: "x", model: "gemini-3.8-flash" });
  assert.ok(m instanceof OpenAIChatModel);
  assert.equal(m.label, "llm-incubator:gemini-3.8-flash");
});

test("factory: an ANTHROPIC_AUTH_TOKEN key goes out as a Bearer token, not x-api-key", () => {
  const bearer = createChatModel({ provider: "anthropic", apiKey: "tok", model: "m", bearerAuth: true }) as any;
  assert.equal(bearer.client.authToken, "tok");
  assert.equal(bearer.client.apiKey, null);
  const plain = createChatModel({ provider: "anthropic", apiKey: "key", model: "m" }) as any;
  assert.equal(plain.client.apiKey, "key");
});

function scripted(label: string, fn: () => Promise<any>): ChatModel & { calls: number } {
  const m = { label, calls: 0, create: async () => (m.calls++, fn()) };
  return m;
}
const ok = { text: "ok", toolCalls: [], usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, stopReason: "stop", assistant: { role: "assistant", content: "ok" } };
const rejected = (status: number) => Object.assign(new Error(`${status}`), { status });

test("provider fallback: a wire rejection switches to the fallback, and sticks", async () => {
  const primary = scripted("openai:m", async () => { throw rejected(404); });
  const fallback = scripted("anthropic:m", async () => ok);
  const m = new ProviderFallbackChatModel(primary, fallback);
  await captureStderr(async () => {
    await m.create({ messages: [{ role: "user", content: "hi" }] });
    await m.create({ messages: [{ role: "user", content: "hi" }] });
  });
  assert.equal(primary.calls, 1);
  assert.equal(fallback.calls, 2);
  assert.equal(m.label, "anthropic:m");
});

test("provider fallback: a failing fallback rethrows the primary error and is not retried", async () => {
  const primaryErr = rejected(401);
  const primary = scripted("openai:m", async () => { throw primaryErr; });
  const fallback = scripted("anthropic:m", async () => { throw rejected(401); });
  const m = new ProviderFallbackChatModel(primary, fallback);
  await assert.rejects(() => m.create({ messages: [{ role: "user", content: "hi" }] }), (e) => e === primaryErr);
  await assert.rejects(() => m.create({ messages: [{ role: "user", content: "hi" }] }), (e) => e === primaryErr);
  assert.equal(fallback.calls, 1);
});

test("provider fallback: other errors (429, 500, 400) never trigger it", async () => {
  for (const status of [400, 429, 500]) {
    const primary = scripted("openai:m", async () => { throw rejected(status); });
    const fallback = scripted("anthropic:m", async () => ok);
    const m = new ProviderFallbackChatModel(primary, fallback);
    await assert.rejects(() => m.create({ messages: [{ role: "user", content: "hi" }] }));
    assert.equal(fallback.calls, 0, `status ${status}`);
  }
});

async function captureStderr(fn: () => Promise<void>): Promise<{ err: string[] }> {
  const err: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return { err };
}

// --- Anthropic adapter ------------------------------------------------------

function fakeAnthropic(resp: unknown) {
  const box: { params?: any } = {};
  const client = {
    messages: { create: async (params: any) => ((box.params = params), resp) },
  } as unknown as Anthropic;
  return { client, box };
}

function anthropicResp(over: Partial<any> = {}): any {
  return {
    content: [{ type: "text", text: "hi there" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 70, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 },
    ...over,
  };
}

test("anthropic: system is hoisted, temperature dropped, max_tokens defaulted", async () => {
  const { client, box } = fakeAnthropic(anthropicResp());
  const m = new AnthropicChatModel({ apiKey: "x", model: "claude-x", client });
  const res = await m.create({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    temperature: 0, // must NOT be forwarded
  });
  assert.equal(box.params.system[0].text, "sys");
  assert.equal(box.params.messages.length, 1);
  assert.equal(box.params.messages[0].role, "user");
  assert.equal(box.params.temperature, undefined);
  assert.equal(box.params.max_tokens, 4096);
  assert.deepEqual(res.usage, { input: 70, output: 20, cacheRead: 30, cacheCreate: 5 });
});

test("anthropic: consecutive tool results coalesce into ONE user turn", async () => {
  const { client, box } = fakeAnthropic(anthropicResp());
  const m = new AnthropicChatModel({ apiKey: "x", model: "claude-x", client });
  const req: ChatRequest = {
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "t", args: {} }, { id: "b", name: "t", args: {} }] },
      { role: "tool", toolCallId: "a", content: "ra" },
      { role: "tool", toolCallId: "b", content: "rb" },
    ],
  };
  await m.create(req);
  const msgs = box.params.messages;
  const lastUser = msgs[msgs.length - 1];
  assert.equal(lastUser.role, "user");
  assert.equal(lastUser.content.length, 2); // both tool_result blocks in one turn
  assert.equal(lastUser.content[0].tool_use_id, "a");
  assert.equal(lastUser.content[1].tool_use_id, "b");
});

test("anthropic: tool_use input is an object (no JSON.parse round-trip)", async () => {
  const resp = anthropicResp({
    content: [{ type: "tool_use", id: "u1", name: "record_graph", input: { nodes: [1] } }],
    stop_reason: "tool_use",
  });
  const { client } = fakeAnthropic(resp);
  const m = new AnthropicChatModel({ apiKey: "x", model: "claude-x", client });
  const res = await m.create({
    messages: [{ role: "user", content: "go" }],
    tools: [{ name: "record_graph", description: "d", parameters: { type: "object" } }],
    responseFormat: { kind: "tool", name: "record_graph" },
  });
  assert.deepEqual(res.toolCalls[0].args, { nodes: [1] });
});

test("anthropic: a trailing /v1 is stripped from the base URL (the SDK appends /v1/messages)", () => {
  assert.equal(anthropicBaseUrl("https://gw.example/v1"), "https://gw.example");
  assert.equal(anthropicBaseUrl("https://gw.example/v1/"), "https://gw.example");
  assert.equal(anthropicBaseUrl("https://gw.example"), "https://gw.example");
  assert.equal(anthropicBaseUrl(undefined), undefined);
});

function modelGatedAnthropic(accepts: string, models: string[]): Anthropic {
  return {
    messages: {
      create: async (p: any) => {
        models.push(p.model);
        if (p.model !== accepts) throw new AnthropicSDK.APIError(404, undefined, `model: ${p.model}`, new Headers());
        return anthropicResp();
      },
    },
  } as unknown as Anthropic;
}

test("anthropic: an unknown prefixed model falls back to the bare id, and sticks", async () => {
  const models: string[] = [];
  const m = new AnthropicChatModel({
    apiKey: "x",
    model: "anthropic/claude-x",
    modelFallbacks: ["claude-x"],
    client: modelGatedAnthropic("claude-x", models),
  });
  const { err } = await captureStderr(async () => {
    await m.create({ messages: [{ role: "user", content: "hi" }] });
    await m.create({ messages: [{ role: "user", content: "hi" }] });
  });
  assert.deepEqual(models, ["anthropic/claude-x", "claude-x", "claude-x"]);
  assert.ok(err.some((l) => /not available; retrying as "claude-x"/.test(l)));
});

test("anthropic: an unknown model with no fallback left is rethrown", async () => {
  const models: string[] = [];
  const m = new AnthropicChatModel({ apiKey: "x", model: "claude-nope", client: modelGatedAnthropic("other", models) });
  await assert.rejects(() => m.create({ messages: [{ role: "user", content: "hi" }] }), AnthropicSDK.APIError);
  assert.deepEqual(models, ["claude-nope"]);
});

test("anthropic: reconstructed assistant tool_use carries the object input", async () => {
  const { client, box } = fakeAnthropic(anthropicResp());
  const m = new AnthropicChatModel({ apiKey: "x", model: "claude-x", client });
  await m.create({
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "u1", name: "t", args: { k: 1 } }] },
      { role: "tool", toolCallId: "u1", content: "res" },
    ],
  });
  const asst = box.params.messages[1];
  assert.equal(asst.content[0].type, "tool_use");
  assert.deepEqual(asst.content[0].input, { k: 1 });
});

test("anthropic: json mode forces emit_json and returns serialized text", async () => {
  const resp = anthropicResp({
    content: [{ type: "tool_use", id: "j1", name: "emit_json", input: { correct: true } }],
    stop_reason: "tool_use",
  });
  const { client, box } = fakeAnthropic(resp);
  const m = new AnthropicChatModel({ apiKey: "x", model: "claude-x", client });
  const res = await m.create({ messages: [{ role: "user", content: "grade" }], responseFormat: { kind: "json" } });
  assert.deepEqual(box.params.tool_choice, { type: "tool", name: "emit_json" });
  assert.equal(res.text, '{"correct":true}');
  assert.equal(res.toolCalls.length, 0);
});
