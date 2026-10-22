/**
 * The Databricks AI Gateway: per-model routing, headers, the bare ↔ service id
 * mapping, model listing, and the `build --deep` key check + model choice.
 * Network-free: listings and SDK clients are stubs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import { resolveConfig } from "../src/ai/providers.js";
import { AnthropicChatModel } from "../src/ai/llm/anthropic.js";
import { OpenAIChatModel, contentText, errorEnvelopeFetch } from "../src/ai/llm/openai.js";
import { createChatModel } from "../src/ai/llm/factory.js";
import {
  DATABRICKS_BASE_URL,
  DATABRICKS_KNOWN_MODELS,
  databricksModelFallbacks,
  databricksModelHeaders,
  databricksRoute,
  databricksRouteUrl,
  isDatabricksGatewayUrl,
  listDatabricksModels,
  listServingEndpoints,
  parseDatabricksRoot,
  type DatabricksLister,
} from "../src/ai/llm/databricks.js";
import { chooseDatabricksDeepModel, type DeepModelDeps } from "../src/ai/databricks-setup.js";
import { listEndpointModels } from "../src/ai/llm-hints.js";
import { PromptCancelled, type Prompter, type UserEnvStore } from "../src/ai/llm-settings.js";

const ENV_KEYS = [
  "GRAFT_PROVIDER", "GRAFT_MODEL", "GRAFT_OPENROUTER_MODEL", "ORCAROUTER_MODEL",
  "GRAFT_BASE_URL", "ANTHROPIC_BASE_URL", "OPENROUTER_BASE_URL", "ORCAROUTER_BASE_URL",
  "GRAFT_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "ORCAROUTER_API_KEY",
];
const env = (vars: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ENV_KEYS) delete e[k];
  return { ...e, ...vars };
};

test("databricks: any workspace on cloud.databricks.com is recognised, nothing else", () => {
  assert.ok(isDatabricksGatewayUrl(DATABRICKS_BASE_URL));
  assert.ok(isDatabricksGatewayUrl("https://other-workspace.cloud.databricks.com"));
  assert.ok(isDatabricksGatewayUrl("https://DBC-1234.Cloud.Databricks.com/ai-gateway/mlflow/v1"));
  assert.ok(!isDatabricksGatewayUrl("https://cloud.databricks.com"), "a workspace label is required");
  assert.ok(!isDatabricksGatewayUrl("https://a.b.cloud.databricks.com"));
  assert.ok(!isDatabricksGatewayUrl("https://x.cloud.databricks.com.evil.example"));
  assert.ok(!isDatabricksGatewayUrl("https://x.cloud.databricks.com:8443"));
  assert.ok(!isDatabricksGatewayUrl("ftp://x.cloud.databricks.com"));
  assert.ok(!isDatabricksGatewayUrl("https://llm-gateway.example.com"));
  assert.ok(!isDatabricksGatewayUrl("not a url"));
  assert.ok(!isDatabricksGatewayUrl(undefined));
});

test("databricks: whatever the URL ends with, the root is kept and the route rebuilt", () => {
  const root = DATABRICKS_BASE_URL;
  const host = new URL(root).host;
  for (const url of [
    root,
    `${root}/`,
    `${root}//`,
    `${root}/ai-gateway`,
    `${root}/ai-gateway/`,
    `${root}/ai-gateway/anthropic`,
    `${root}/ai-gateway/anthropic/`,
    `${root}/ai-gateway/anthropic/v1`,
    `${root}/ai-gateway/anthropic/v1/messages`,
    `${root}/ai-gateway/openai/v1`,
    `${root}/ai-gateway/openai/v1/responses`,
    `${root}/ai-gateway/mlflow/v1/`,
    `${root}/ai-gateway/mlflow/v1/chat/completions?x=1`,
    `${root}/v1`,
    `${root}/serving-endpoints`,
    `  ${root}/ai-gateway/anthropic  `,
    `http://${host}/ai-gateway/`,
    host,
    `${host}/ai-gateway/openai/v1`,
    `HTTPS://${host.toUpperCase()}/AI-GATEWAY/ANTHROPIC`,
  ]) {
    assert.equal(parseDatabricksRoot(url), root, url);
  }
  assert.equal(databricksRouteUrl(root, "anthropic"), `${root}/ai-gateway/anthropic`);
  assert.equal(databricksRouteUrl(root, "openai"), `${root}/ai-gateway/openai/v1`);
  assert.equal(databricksRouteUrl(root, "mlflow"), `${root}/ai-gateway/mlflow/v1`);
  assert.equal(databricksRouteUrl(`${root}/`, "openai"), `${root}/ai-gateway/openai/v1`);
});

test("resolveConfig: a route-suffixed base URL still sends each model to its own route", () => {
  for (const baseUrl of [`${DATABRICKS_BASE_URL}/ai-gateway/`, `${DATABRICKS_BASE_URL}/ai-gateway/anthropic`, `${DATABRICKS_BASE_URL}/ai-gateway/mlflow/v1/`]) {
    const claude = resolveConfig({ baseUrl, apiKey: "dapi1", model: "claude-sonnet-5-5" }, env());
    assert.equal(claude.baseUrl, `${DATABRICKS_BASE_URL}/ai-gateway/anthropic`, baseUrl);
    const gpt = resolveConfig({ baseUrl, apiKey: "dapi1", model: "model_service.models.1adp-gpt-6-1-sol" }, env());
    assert.equal(gpt.baseUrl, `${DATABRICKS_BASE_URL}/ai-gateway/openai/v1`, baseUrl);
    const qwen = resolveConfig({ baseUrl, apiKey: "dapi1", model: "model_service.models.1adp-qwen3-5-122b" }, env());
    assert.equal(qwen.baseUrl, `${DATABRICKS_BASE_URL}/ai-gateway/mlflow/v1`, baseUrl);
  }
});

test("resolveConfig: another workspace keeps its own host on the routes", () => {
  const c = resolveConfig({ baseUrl: "https://dbc-other.cloud.databricks.com/ai-gateway/openai/v1", apiKey: "dapi1" }, env());
  assert.deepEqual(c.databricks, { root: "https://dbc-other.cloud.databricks.com", route: "anthropic" });
  assert.equal(c.baseUrl, "https://dbc-other.cloud.databricks.com/ai-gateway/anthropic");
});

test("adapters: the SDKs reach exactly the URLs of the gateway examples", () => {
  const anth = createChatModel({
    provider: "anthropic", apiKey: "dapi1", model: "claude-opus-5-5", bearerAuth: true,
    baseUrl: resolveConfig({ baseUrl: `${DATABRICKS_BASE_URL}/ai-gateway/anthropic/v1`, apiKey: "dapi1", model: "claude-opus-5-5" }, env()).baseUrl,
  }) as any;
  // The SDK appends /v1/messages: …/ai-gateway/anthropic/v1/messages, as in the curl example.
  assert.equal(anth.client.buildURL("/v1/messages", null), `${DATABRICKS_BASE_URL}/ai-gateway/anthropic/v1/messages`);
  const qwen = createChatModel({
    provider: "openai", apiKey: "dapi1", model: "q",
    baseUrl: resolveConfig({ baseUrl: `${DATABRICKS_BASE_URL}/ai-gateway`, apiKey: "dapi1", model: "model_service.models.1adp-qwen3-5-122b" }, env()).baseUrl,
  }) as any;
  assert.equal(qwen.clients[0].buildURL("/chat/completions", null), `${DATABRICKS_BASE_URL}/ai-gateway/mlflow/v1/chat/completions`);
});

test("databricks: the model id picks the route", () => {
  assert.equal(databricksRoute("claude-sonnet-5-5"), "anthropic");
  assert.equal(databricksRoute("model_service.models.1adp-opus-5-5"), "anthropic");
  assert.equal(databricksRoute("model_service.models.1adp-gpt-6-1-sol"), "openai");
  assert.equal(databricksRoute("model_service.models.1adp-qwen3-5-122b"), "mlflow");
});

test("databricks: bare Claude ids get the provider-service header and map to the service ids", () => {
  assert.deepEqual(databricksModelHeaders("claude-opus-5-5"), { "Databricks-Model-Provider-Service": "model_service.models.gcp-models" });
  assert.equal(databricksModelHeaders("model_service.models.1adp-opus-5-5"), undefined);
  assert.equal(databricksModelHeaders("model_service.models.1adp-qwen3-5-122b"), undefined);
  assert.deepEqual(databricksModelFallbacks("claude-opus-5-5[1m]"), ["model_service.models.1adp-opus-5-5"]);
  assert.deepEqual(databricksModelFallbacks("model_service.models.1adp-haiku-4-5"), ["claude-haiku-4-5-20251001"]);
  assert.equal(databricksModelFallbacks("model_service.models.1adp-qwen3-5-122b"), undefined);
});

test("resolveConfig: GRAFT_BASE_URL / ANTHROPIC_BASE_URL on the gateway route by model", () => {
  const anth = resolveConfig({}, env({ GRAFT_API_KEY: "dapi1", GRAFT_BASE_URL: DATABRICKS_BASE_URL, GRAFT_MODEL: "claude-opus-5-5[1m]" }));
  assert.equal(anth.provider, "anthropic");
  assert.equal(anth.model, "claude-opus-5-5");
  assert.equal(anth.baseUrl, `${DATABRICKS_BASE_URL}/ai-gateway/anthropic`);
  assert.deepEqual(anth.headers, { "Databricks-Ai-Gateway-Request-Tags": '{"registry_id": "personal"}' });
  assert.equal(anth.bearerAuth, true);

  const gpt = resolveConfig(
    { model: "model_service.models.1adp-gpt-6-1-sol" },
    env({ ANTHROPIC_AUTH_TOKEN: "dapi1", ANTHROPIC_BASE_URL: `${DATABRICKS_BASE_URL}/ai-gateway/anthropic` }),
  );
  assert.equal(gpt.provider, "openai");
  assert.equal(gpt.baseUrl, `${DATABRICKS_BASE_URL}/ai-gateway/openai/v1`);
  assert.equal(gpt.modelHeaders, undefined);

  const qwen = resolveConfig({ baseUrl: DATABRICKS_BASE_URL, apiKey: "dapi1", model: "model_service.models.1adp-qwen3-5-122b" }, env());
  assert.equal(qwen.provider, "openai");
  assert.equal(qwen.baseUrl, `${DATABRICKS_BASE_URL}/ai-gateway/mlflow/v1`);
});

test("anthropic adapter: gateway headers by default, the provider-service header per model", async () => {
  const calls: { model: string; opts?: any }[] = [];
  const client = {
    messages: {
      create: async (params: any, opts?: any) => {
        calls.push({ model: params.model, opts });
        if (calls.length === 1) {
          const err: any = new Error("404 model not found");
          throw Object.assign(err, { status: 404 });
        }
        return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  } as unknown as Anthropic;
  const m = new AnthropicChatModel({
    apiKey: "k",
    model: "claude-opus-5-5",
    modelFallbacks: ["model_service.models.1adp-opus-5-5"],
    modelHeaders: databricksModelHeaders,
    client,
  });
  // A plain Error is not the SDK's model-not-found, so the first call's failure is rethrown.
  await assert.rejects(() => m.create({ messages: [{ role: "user", content: "hi" }] }));
  assert.deepEqual(calls[0]!.opts, { headers: { "Databricks-Model-Provider-Service": "model_service.models.gcp-models" } });

  const res = await m.create({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.text, "ok");

  const svc = new AnthropicChatModel({ apiKey: "k", model: "model_service.models.1adp-opus-5-5", modelHeaders: databricksModelHeaders, client });
  await svc.create({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(calls.at(-1)!.opts, undefined, "a service id needs no provider-service header");

  const real = createChatModel({
    provider: "anthropic",
    apiKey: "dapi1",
    model: "claude-sonnet-5-5",
    baseUrl: `${DATABRICKS_BASE_URL}/ai-gateway/anthropic`,
    headers: { "Databricks-Ai-Gateway-Request-Tags": "{}" },
    bearerAuth: true,
  }) as any;
  assert.equal(real.client.authToken, "dapi1");
  assert.equal(real.client.baseURL, `${DATABRICKS_BASE_URL}/ai-gateway/anthropic`);
});

test("listDatabricksModels: each route keeps its own chat models; failures are per route", async () => {
  const lister: DatabricksLister = async (route) => {
    if (route === "openai") throw Object.assign(new Error("403 forbidden"), { status: 403 });
    if (route === "anthropic") return ["claude-sonnet-5-5", "claude-opus-5-5", "model_service.models.1adp-qwen3-5-122b"];
    return ["model_service.models.1adp-qwen3-5-122b", "model_service.models.1adp-text-embedding-3-small"];
  };
  const l = await listDatabricksModels(DATABRICKS_BASE_URL, "dapi1", lister);
  assert.deepEqual(l.map((x) => x.route), ["anthropic", "openai", "mlflow", "serving"]);
  assert.deepEqual(l[0]!.ids, ["claude-sonnet-5-5", "claude-opus-5-5"]);
  assert.deepEqual(l[1]!.ids, []);
  assert.ok(l[1]!.error);
  assert.deepEqual(l[2]!.ids, ["model_service.models.1adp-qwen3-5-122b"]);
  assert.equal(l[2]!.url, `${DATABRICKS_BASE_URL}/ai-gateway/mlflow/v1`);
});

test("listEndpointModels: routes that will not list fall back to their known ids once another route lists", async () => {
  const cfg = resolveConfig({ baseUrl: `${DATABRICKS_BASE_URL}/ai-gateway`, apiKey: "dapi1" }, env());
  const unmanaged = () => {
    throw new Error("400 Request path '/ai-gateway/openai/v1/models' doesn't match any known API type and is classified as an unmanaged api request.");
  };
  const ids = await listEndpointModels(cfg, async (route) => (route === "anthropic" ? ["claude-sonnet-5-5"] : unmanaged()));
  assert.deepEqual(ids, [
    "claude-sonnet-5-5",
    ...DATABRICKS_KNOWN_MODELS.openai,
    ...DATABRICKS_KNOWN_MODELS.mlflow,
  ]);
  assert.deepEqual(DATABRICKS_KNOWN_MODELS.serving, [], "a serving endpoint is never guessed: it may be rate-limited to 0");

  const rejected = Object.assign(new Error("401 invalid token"), { status: 401 });
  await assert.rejects(
    listEndpointModels(cfg, async () => {
      throw rejected;
    }),
    (err) => err === rejected,
    "a key no route accepts is still reported, not masked by the known ids",
  );
});

test("serving route: databricks-* ids go to <root>/serving-endpoints over the OpenAI wire, without the provider header", () => {
  for (const id of ["databricks-gpt-5-4-nano", "databricks-claude-sonnet-5-5", "databricks-gemini-3-8-flash", "databricks-qwen35-122b-a10b"]) {
    assert.equal(databricksRoute(id), "serving", id);
  }
  assert.equal(databricksRoute("claude-sonnet-5-5"), "anthropic");
  const c = resolveConfig({ baseUrl: `${DATABRICKS_BASE_URL}/ai-gateway`, apiKey: "dapi1", model: "databricks-claude-sonnet-5-5" }, env());
  assert.equal(c.provider, "openai");
  assert.equal(c.baseUrl, `${DATABRICKS_BASE_URL}/serving-endpoints`);
  assert.deepEqual(c.databricks, { root: DATABRICKS_BASE_URL, route: "serving" });
  assert.equal(c.modelHeaders, undefined);
});

test("listServingEndpoints: ready chat endpoints the key may query, minus those rate-limited to 0", async () => {
  const urls: string[] = [];
  const auth = new Set<string>();
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fake = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    auth.add(new Headers(init?.headers).get("authorization") ?? "");
    if (url.endsWith("/api/2.0/serving-endpoints")) {
      return json({
        endpoints: [
          { name: "databricks-gpt-5-4-nano", task: "llm/v1/chat", state: { ready: "READY" }, permission_level: "CAN_QUERY" },
          { name: "databricks-gpt-6-1-sol", task: "llm/v1/chat", state: { ready: "READY" }, permission_level: "CAN_QUERY" },
          { name: "databricks-gemini-3-8-flash", task: "llm/v1/chat", state: { ready: "READY" }, permission_level: "CAN_QUERY" },
          { name: "databricks-gte-large-en", task: "llm/v1/embeddings", state: { ready: "READY" }, permission_level: "CAN_QUERY" },
          { name: "databricks-llama-4-maverick", task: "llm/v1/chat", state: { ready: "NOT_READY" }, permission_level: "CAN_QUERY" },
          { name: "databricks-view-only", task: "llm/v1/chat", state: { ready: "READY" }, permission_level: "CAN_VIEW" },
          { name: "my-agent", task: "agent/v1/responses", state: { ready: "READY" }, permission_level: "CAN_MANAGE" },
        ],
      });
    }
    if (url.endsWith("/databricks-gpt-6-1-sol")) {
      return json({ ai_gateway: { rate_limits: [{ calls: 0, key: "endpoint", renewal_period: "minute" }] } });
    }
    if (url.endsWith("/databricks-gemini-3-8-flash")) return new Response("boom", { status: 500 });
    return json({ ai_gateway: { rate_limits: [{ calls: 100, key: "user", renewal_period: "minute" }] } });
  }) as typeof fetch;
  const ids = await listServingEndpoints(DATABRICKS_BASE_URL, "dapi1", fake, 0);
  assert.deepEqual(ids, ["databricks-gpt-5-4-nano"], "a record that cannot be read is dropped: it may be blocked");
  assert.equal(urls[0], `${DATABRICKS_BASE_URL}/api/2.0/serving-endpoints`);
  assert.equal(urls.filter((u) => u.endsWith("/databricks-gemini-3-8-flash")).length, 4, "a 5xx is retried before giving up");
  assert.deepEqual([...auth], ["Bearer dapi1"]);

  const denied = (async () => new Response('{"error_code":"PERMISSION_DENIED"}', { status: 403 })) as typeof fetch;
  await assert.rejects(listServingEndpoints(DATABRICKS_BASE_URL, "dapi1", denied, 0), /403/);
});

test("listServingEndpoints: reads records a few at a time and retries a 429 instead of offering a blocked endpoint", async () => {
  const names = Array.from({ length: 12 }, (_, i) => `databricks-model-${i}`);
  let inFlight = 0;
  let peak = 0;
  const throttled = new Set<string>();
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fake = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith("/api/2.0/serving-endpoints")) {
      return json({ endpoints: names.map((name) => ({ name, task: "llm/v1/chat", state: { ready: "READY" }, permission_level: "CAN_QUERY" })) });
    }
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    const name = url.slice(url.lastIndexOf("/") + 1);
    if (!throttled.has(name)) {
      throttled.add(name);
      return new Response('{"error_code":"RESOURCE_EXHAUSTED"}', { status: 429 });
    }
    const calls = name === "databricks-model-3" ? 50 : 0;
    return json({ ai_gateway: { rate_limits: [{ calls, key: "endpoint", renewal_period: "minute" }] } });
  }) as typeof fetch;
  const ids = await listServingEndpoints(DATABRICKS_BASE_URL, "dapi1", fake, 0);
  assert.deepEqual(ids, ["databricks-model-3"], "every endpoint rate-limited to 0 stays out, even after a 429");
  assert.ok(peak <= 4, `at most 4 records read at once (saw ${peak})`);
});

// --- GRAFT_MODEL → the request that actually goes out ------------------------

interface Sent { url: string; headers: Record<string, string>; model: string }

/** Every HTTP request made while `fn` runs, answered with a canned reply for its wire format. */
async function capture(fn: () => Promise<unknown>): Promise<Sent[]> {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = JSON.parse(String(init?.body ?? "{}"));
    sent.push({ url, headers, model: body.model });
    const reply = url.includes("/messages")
      ? { id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
      : { id: "c", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return sent;
}

/** What `build --deep` does with these env vars: resolveConfig, then the engine's createChatModel call. */
async function sendOnce(vars: Record<string, string>): Promise<Sent> {
  const cfg = resolveConfig({}, env(vars));
  // The SDKs read globalThis.fetch when the client is built, so it is built inside capture().
  const sent = await capture(() =>
    createChatModel({
      provider: cfg.provider, apiKey: cfg.apiKey!, model: cfg.model, modelFallbacks: cfg.modelFallbacks, baseUrl: cfg.baseUrl,
      headers: cfg.headers, modelHeaders: cfg.modelHeaders, providerFallback: cfg.providerFallback, bearerAuth: cfg.bearerAuth,
    }).create({ messages: [{ role: "user", content: "hi" }], maxTokens: 10 }),
  );
  assert.equal(sent.length, 1);
  return sent[0]!;
}

const GW = `${DATABRICKS_BASE_URL}/ai-gateway`;
const TAGS = '{"registry_id": "personal"}';
const SERVICE = "model_service.models.gcp-models";

const MODEL_CASES: { model: string; url: string; sentModel: string; service: boolean }[] = [
  { model: "claude-opus-5-5", url: `${GW}/anthropic/v1/messages`, sentModel: "claude-opus-5-5", service: true },
  { model: "claude-sonnet-5-5[1m]", url: `${GW}/anthropic/v1/messages`, sentModel: "claude-sonnet-5-5", service: true },
  { model: "claude-haiku-4-5-20251001", url: `${GW}/anthropic/v1/messages`, sentModel: "claude-haiku-4-5-20251001", service: true },
  { model: "model_service.models.1adp-opus-5-5", url: `${GW}/anthropic/v1/messages`, sentModel: "model_service.models.1adp-opus-5-5", service: false },
  { model: "model_service.models.1adp-gpt-6-1-sol", url: `${GW}/openai/v1/chat/completions`, sentModel: "model_service.models.1adp-gpt-6-1-sol", service: false },
  { model: "model_service.models.1adp-qwen3-5-122b", url: `${GW}/mlflow/v1/chat/completions`, sentModel: "model_service.models.1adp-qwen3-5-122b", service: false },
];

const URL_SOURCES: Record<string, string>[] = [
  { GRAFT_API_KEY: "dapi-test" }, // nothing set: the default URL
  { GRAFT_API_KEY: "dapi-test", GRAFT_BASE_URL: DATABRICKS_BASE_URL },
  { GRAFT_API_KEY: "dapi-test", GRAFT_BASE_URL: `${GW}/` },
  { GRAFT_API_KEY: "dapi-test", GRAFT_BASE_URL: `${GW}/openai/v1` },
  { ANTHROPIC_AUTH_TOKEN: "dapi-test", ANTHROPIC_BASE_URL: `${GW}/anthropic` },
  { ANTHROPIC_AUTH_TOKEN: "dapi-test", ANTHROPIC_BASE_URL: `${GW}/mlflow/v1/` },
];

test("GRAFT_MODEL: each model family's request goes to its own route, whatever URL was configured", async () => {
  for (const source of URL_SOURCES) {
    for (const c of MODEL_CASES) {
      const what = `${c.model} with ${JSON.stringify(source)}`;
      const sent = await sendOnce({ ...source, GRAFT_MODEL: c.model });
      assert.equal(sent.url, c.url, what);
      assert.equal(sent.model, c.sentModel, what);
      assert.equal(sent.headers["authorization"], "Bearer dapi-test", what);
      assert.equal(sent.headers["x-api-key"], undefined, what);
      assert.equal(sent.headers["databricks-ai-gateway-request-tags"], TAGS, what);
      assert.equal(sent.headers["databricks-model-provider-service"], c.service ? SERVICE : undefined, what);
      if (c.url.includes("/anthropic/")) assert.equal(sent.headers["anthropic-version"], "2023-06-01", what);
    }
  }
});

test("GRAFT_MODEL: a non-Databricks gateway URL keeps plain OpenAI requests", async () => {
  const sent = await sendOnce({ GRAFT_API_KEY: "k", GRAFT_BASE_URL: "https://llm-gateway.example.com/v1", GRAFT_MODEL: "claude-sonnet-5-5" });
  assert.equal(sent.url, "https://llm-gateway.example.com/v1/chat/completions");
  assert.equal(sent.model, "claude-sonnet-5-5");
  assert.equal(sent.headers["databricks-ai-gateway-request-tags"], undefined);
});

// --- the build --deep step --------------------------------------------------

// --- gateway quirks found against the live Databricks gateway ----------------

test("errorEnvelopeFetch: a Databricks error body keeps its message for the SDK", async () => {
  const msg = "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.";
  const base = (async () =>
    new Response(JSON.stringify({ error_code: "BAD_REQUEST", message: msg }), { status: 400, headers: { "content-type": "application/json" } })) as typeof fetch;
  const res = await errorEnvelopeFetch(base)("https://x");
  assert.deepEqual(await res.json(), { error: { message: msg, type: "BAD_REQUEST", code: "BAD_REQUEST" } });
  const ok = (async () => new Response('{"error":{"message":"m"}}', { status: 400, headers: { "content-type": "application/json" } })) as typeof fetch;
  assert.deepEqual(await (await errorEnvelopeFetch(ok)("https://x")).json(), { error: { message: "m" } }, "the standard shape is untouched");
});

test("errorEnvelopeFetch: the SDK then sees the message and graft's max_completion_tokens retry works", async () => {
  const bodies: any[] = [];
  const sent = await capture(async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if ("max_tokens" in body) {
        return new Response(JSON.stringify({ error_code: "BAD_REQUEST", message: "Model Service returned error with status code 400: Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return real(input, init);
    }) as typeof fetch;
    const m = createChatModel({ provider: "openai", apiKey: "k", model: "gpt", baseUrl: `${GW}/openai/v1` });
    await m.create({ messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].max_completion_tokens, 10);
  assert.equal(sent.length, 1);
});

test("contentText: a parts-list reply yields its text parts, not its reasoning", () => {
  assert.equal(contentText("plain"), "plain");
  assert.equal(contentText([{ type: "reasoning", summary: [{ type: "summary_text", text: "thinking…" }] }, { type: "text", text: "Test OK" }]), "Test OK");
  assert.equal(contentText(null), "");
});

test("openai adapter: a parts-list reply (Qwen on Databricks) is read as its text", async () => {
  const client = {
    chat: { completions: { create: async () => ({ id: "c", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: [{ type: "reasoning", summary: [] }, { type: "text", text: "Test OK" }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } },
  } as unknown as OpenAI;
  const res = await new OpenAIChatModel({ apiKey: "k", model: "q", client }).create({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.text, "Test OK");
  assert.equal(res.assistant.content, "Test OK");
  assert.equal((res.assistant.providerRaw!.raw as any).content, "Test OK", "replayed as plain text");
});

test("openai adapter: tools refused while reasoning, reasoning not switchable → the forced tool via json_schema, sticky", async () => {
  const err = (m: string) => new OpenAI.APIError(400, { message: m }, m, new Headers());
  const seen: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (p: any) => {
          seen.push(p);
          if (p.tools && p.reasoning_effort === undefined) throw err("Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions.");
          if (p.reasoning_effort === "none") throw err("Unsupported value: 'reasoning_effort' does not support 'none' with this model.");
          return { id: "r1", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"summary":"adds"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
        },
      },
    },
  } as unknown as OpenAI;
  const m = new OpenAIChatModel({ apiKey: "k", model: "gpt", client });
  const tool = { name: "record", description: "Record it.", parameters: { type: "object", properties: { summary: { type: "string" } } } };
  const req = { messages: [{ role: "user" as const, content: "x" }], tools: [tool], responseFormat: { kind: "tool" as const, name: "record" } };
  const res = await m.create(req);
  assert.deepEqual(res.toolCalls.map((c) => ({ name: c.name, args: c.args })), [{ name: "record", args: { summary: "adds" } }]);
  const last = seen.at(-1);
  assert.equal(last.tools, undefined);
  assert.equal(last.reasoning_effort, undefined);
  assert.equal(last.response_format.type, "json_schema");
  assert.deepEqual(last.response_format.json_schema.schema, tool.parameters);
  assert.equal(seen.length, 3);

  const json = await m.create({ messages: [{ role: "user", content: "x" }], responseFormat: { kind: "json" } });
  assert.equal(json.text, '{"summary":"adds"}');
  assert.equal(seen.length, 4, "sticky: the next call goes straight to structured output");
});

test("anthropic adapter: a refused forced tool_choice is retried as auto with an instruction, sticky", async () => {
  const seen: any[] = [];
  const client = {
    messages: {
      create: async (p: any) => {
        seen.push(p);
        if (p.tool_choice?.type === "tool") {
          throw Object.assign(new Error('400 Model Provider Service returned error with status code 400: tool_choice: type "tool" and "any" are not supported for this model.'), { status: 400 });
        }
        return { content: [{ type: "tool_use", id: "t", name: "emit_json", input: { status: "ok" } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  } as unknown as Anthropic;
  const m = new AnthropicChatModel({ apiKey: "k", model: "claude-sonnet-5-5", client });
  const res = await m.create({ messages: [{ role: "system", content: "sys" }, { role: "user", content: "x" }], responseFormat: { kind: "json" } });
  assert.equal(res.text, '{"status":"ok"}');
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].tool_choice, { type: "auto" });
  assert.equal(seen[1].system.length, 2);
  assert.match(seen[1].system[1].text, /calling the `emit_json` tool/);
  await m.create({ messages: [{ role: "user", content: "x" }], responseFormat: { kind: "json" } });
  assert.equal(seen.length, 3, "sticky: no second refused attempt");
  assert.deepEqual(seen[2].tool_choice, { type: "auto" });
});

function scriptedPrompter(answers: string[]): Prompter & { asked: string[]; hidden: string[] } {
  const p = {
    asked: [] as string[],
    hidden: [] as string[],
    ask: async (q: string) => (p.asked.push(q), answers.shift() ?? ""),
    askHidden: async (q: string) => (p.hidden.push(q), answers.shift() ?? ""),
  };
  return p;
}

function memoryStore(): UserEnvStore & { vars: Map<string, string> } {
  const vars = new Map<string, string>();
  return { vars, where: "test store", read: (n) => vars.get(n), write: (n, v) => (v === undefined ? vars.delete(n) : vars.set(n, v), undefined) };
}

function deps(over: Partial<DeepModelDeps>): DeepModelDeps & { lines: string[] } {
  const lines: string[] = [];
  return { config: {}, env: env(), out: (l) => lines.push(l), err: (l) => lines.push(l), lines, ...over };
}

const rejecting: DatabricksLister = async () => {
  throw Object.assign(new Error("401 Credential was not sent or was of an unsupported type for this API."), { status: 401 });
};

test("deep model choice: other endpoints and an explicit --model are left alone", async () => {
  const p = scriptedPrompter([]);
  const other = deps({ config: { baseUrl: "https://llm-gateway.example.com" }, env: env({ GRAFT_API_KEY: "k" }), prompt: p });
  assert.deepEqual(await chooseDatabricksDeepModel(other), { config: other.config });
  const flagged = deps({ config: { model: "claude-opus-5" }, env: env({ GRAFT_API_KEY: "k" }), prompt: p });
  assert.deepEqual(await chooseDatabricksDeepModel(flagged), { config: flagged.config });
  assert.equal(p.asked.length + p.hidden.length, 0);
});

test("deep model choice: not on a terminal, nothing is asked", async () => {
  const d = deps({ env: env({ GRAFT_API_KEY: "dapi1" }), lister: rejecting });
  assert.deepEqual(await chooseDatabricksDeepModel(d), { config: {} });
  assert.match(d.lines.join("\n"), /using claude-sonnet-5-5/);
});

test("deep model choice: asks for a missing key first, then lists every route and takes a number", async () => {
  const seenKeys: string[] = [];
  const lister: DatabricksLister = async (route, _url, key) => {
    seenKeys.push(key);
    if (route === "anthropic") return ["claude-sonnet-5-5", "claude-opus-5-5"];
    if (route === "openai") return ["model_service.models.1adp-gpt-6-1-sol"];
    throw new Error("Connection error.");
  };
  const store = memoryStore();
  const p = scriptedPrompter(["dapi-new", "y", "3", "n"]);
  // GRAFT_MODEL names a model the gateway does not list for this key, so it asks.
  const d = deps({ env: env({ GRAFT_MODEL: "claude-haiku-5-5" }), prompt: p, store, lister });
  const r = await chooseDatabricksDeepModel(d);
  assert.match(d.lines.join("\n"), /claude-haiku-5-5 \(from GRAFT_MODEL\) is not among the models/);
  assert.equal(p.hidden.length, 1, "the key is asked hidden, before any listing");
  assert.deepEqual([...new Set(seenKeys)], ["dapi-new"]);
  assert.equal(store.vars.get("GRAFT_API_KEY"), "dapi-new");
  // anthropic: sonnet (1), opus (2); openai: gpt (3); mlflow falls back to the known ids.
  assert.deepEqual(r, { config: { model: "model_service.models.1adp-gpt-6-1-sol", apiKey: "dapi-new" } });
  const text = d.lines.join("\n");
  assert.match(text, /ai-gateway\/openai\/v1/);
  assert.match(text, /could not list its models \(Connection error\.\)/);
  assert.ok(text.includes(DATABRICKS_KNOWN_MODELS.mlflow[0]!));
  assert.equal(store.vars.get("GRAFT_MODEL"), undefined, "declined");
});

test("deep model choice: a rejected key is reported and a new one asked for", async () => {
  let calls = 0;
  const lister: DatabricksLister = async (route, url, key) => {
    calls++;
    if (key === "gAAAA-old") return rejecting(route, url, key);
    return route === "anthropic" ? ["claude-sonnet-5-5"] : [];
  };
  const p = scriptedPrompter(["dapi-good", ""]);
  const store = memoryStore();
  const d = deps({ env: env({ GRAFT_API_KEY: "gAAAA-old" }), prompt: p, store, lister });
  const r = await chooseDatabricksDeepModel(d);
  assert.match(d.lines.join("\n"), /rejected .*from GRAFT_API_KEY/);
  assert.match(d.lines.join("\n"), /https:\/\/dbx\.1adp\.automotive\.cloud\/login/, "the rejection points at the token page");
  assert.equal(p.hidden.length, 1);
  assert.deepEqual(r, { config: { model: "claude-sonnet-5-5", apiKey: "dapi-good" } });
  assert.equal(p.asked.length, 1, "only whether to save the typed key: the default model is served, so no model is asked");
  assert.equal(store.vars.get("GRAFT_MODEL"), undefined);
  assert.equal(calls, 8, "two keys × four routes");
});

test("deep model choice: the model already set is used without asking when the gateway serves it", async () => {
  const lister: DatabricksLister = async (route) =>
    route === "anthropic" ? ["model_service.models.1adp-sonnet-5-5", "claude-opus-5-5"] : route === "openai" ? ["model_service.models.1adp-gpt-6-1-sol"] : [];

  // The default, listed under its service id.
  const p1 = scriptedPrompter([]);
  const d1 = deps({ env: env({ GRAFT_API_KEY: "dapi1" }), prompt: p1, store: memoryStore(), lister });
  assert.deepEqual(await chooseDatabricksDeepModel(d1), { config: { model: "claude-sonnet-5-5" } });
  assert.equal(p1.asked.length + p1.hidden.length, 0, "nothing asked");
  assert.match(d1.lines.join("\n"), /→ claude-sonnet-5-5 \(from graft's default\) via .*ai-gateway\/anthropic/);

  // GRAFT_MODEL, on another route.
  const p2 = scriptedPrompter([]);
  const d2 = deps({ env: env({ GRAFT_API_KEY: "dapi1", GRAFT_MODEL: "model_service.models.1adp-gpt-6-1-sol" }), prompt: p2, lister });
  assert.deepEqual(await chooseDatabricksDeepModel(d2), { config: { model: "model_service.models.1adp-gpt-6-1-sol" } });
  assert.equal(p2.asked.length, 0);
  assert.match(d2.lines.join("\n"), /\(from GRAFT_MODEL\)/);

  // A route that lists nothing cannot contradict GRAFT_MODEL: it is trusted.
  const p3 = scriptedPrompter([]);
  const d3 = deps({ env: env({ GRAFT_API_KEY: "dapi1", GRAFT_MODEL: "model_service.models.1adp-qwen-9" }), prompt: p3, lister });
  assert.deepEqual(await chooseDatabricksDeepModel(d3), { config: { model: "model_service.models.1adp-qwen-9" } });
  assert.equal(p3.asked.length, 0);
});

test("deep model choice: a default the gateway does not serve is not used silently", async () => {
  const lister: DatabricksLister = async (route) => (route === "anthropic" ? ["claude-opus-5-5"] : []);
  const p = scriptedPrompter(["", "n"]);
  const d = deps({ env: env({ GRAFT_API_KEY: "dapi1" }), prompt: p, store: memoryStore(), lister });
  await chooseDatabricksDeepModel(d);
  assert.match(d.lines.join("\n"), /claude-sonnet-5-5 \(from graft's default\) is not among the models/);
  assert.match(d.lines.join("\n"), /Which model should/);
});

test("deep model choice: no key typed, or every key rejected → the structural build", async () => {
  const none = deps({ prompt: scriptedPrompter([""]) });
  assert.deepEqual(await chooseDatabricksDeepModel(none), { skip: "no API key for the Databricks AI Gateway" });
  assert.match(none.lines.join("\n"), /Generate a Databricks personal access token at https:\/\/dbx\.1adp\.automotive\.cloud\/login/);
  const r = await chooseDatabricksDeepModel(
    deps({ env: env({ GRAFT_API_KEY: "bad" }), prompt: scriptedPrompter(["bad2", "bad3"]), lister: rejecting }),
  );
  assert.deepEqual(r, { skip: "the Databricks AI Gateway rejected the API key" });
});

test("deep model choice: Ctrl+C cancels", async () => {
  const p: Prompter = { ask: async () => "", askHidden: async () => { throw new PromptCancelled(); } };
  assert.deepEqual(await chooseDatabricksDeepModel(deps({ prompt: p })), { cancelled: true });
});
