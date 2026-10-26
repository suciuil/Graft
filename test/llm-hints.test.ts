import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyLlmError,
  envSetExample,
  isTopTierModel,
  llmFailureHints,
  llmProblems,
  modelVersion,
  rankModelsForHint,
  suggestModel,
} from "../src/ai/llm-hints.js";

test("classifyLlmError: unreachable endpoints", () => {
  for (const m of [
    "Connection error.",
    "Request timed out.",
    "fetch failed",
    "getaddrinfo ENOTFOUND llm.example",
    "connect ECONNREFUSED 127.0.0.1:9",
    "404 status code (no body)",
    "405 Method Not Allowed",
  ]) {
    assert.equal(classifyLlmError(m), "unreachable", m);
  }
});

test("classifyLlmError: rejected keys", () => {
  for (const m of [
    "401 Incorrect API key provided: sk-****",
    "403 Forbidden",
    "Unauthorized",
    "401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}",
    "the API key has expired",
  ]) {
    assert.equal(classifyLlmError(m), "auth", m);
  }
});

test("classifyLlmError: unknown models", () => {
  for (const m of [
    "404 The model `gpt-x` does not exist or you do not have access to it.",
    "400 Invalid model name passed in model=foo",
    "400 foo/bar is not a valid model ID",
    "404 {\"type\":\"error\",\"error\":{\"type\":\"not_found_error\",\"message\":\"model: claude-x\"}}",
  ]) {
    assert.equal(classifyLlmError(m), "model", m);
  }
});

test("classifyLlmError: quota and balance are not something a setting fixes", () => {
  assert.equal(classifyLlmError("429 You exceeded your current quota"), null);
  assert.equal(classifyLlmError("403 Insufficient account balance"), null);
  assert.equal(classifyLlmError("crux: model returned no tool call"), null);
});

test("llmProblems: a file path prefix is not read as part of the message", () => {
  assert.deepEqual(llmProblems(["src/model/not-found.ts: Connection error."]), ["unreachable"]);
  assert.deepEqual(
    llmProblems([undefined, "a.ts: 401 Unauthorized", "the provider rejected the API key — First error: 401 x", "b.ts: Connection error."]),
    ["unreachable", "auth"],
  );
});

test("rankModelsForHint: chat models only, top tier last; suggestion is mid-tier", () => {
  const ranked = rankModelsForHint(["claude-opus-5", "text-embedding-3", "gpt-6-sol", "gemini-3.8-flash", "claude-sonnet-5.5", "gemini-3.8-flash"]);
  assert.deepEqual(ranked, ["gemini-3.8-flash", "claude-sonnet-5.5", "claude-opus-5", "gpt-6-sol"]);
  assert.equal(suggestModel(ranked), "claude-sonnet-5.5");
  assert.ok(isTopTierModel("gpt-6-astra"));
  assert.ok(isTopTierModel("google/gemini-3-pro"));
  assert.ok(!isTopTierModel("gpt-5.5-terra"));
  assert.ok(!isTopTierModel("solar-mini"));
});

test("suggestModel: latest Claude Haiku, else latest Claude Sonnet, else latest Gemini Flash, else latest GPT terra", () => {
  // From a real gateway list: Flash-Lite used to win only because it came first.
  const gateway = [
    "grok-4.3-2",
    "gemini-3.1-flash-lite",
    "claude-5-0-sonnet-v1:0",
    "gemini-3.7-flash",
    "claude-4-6-sonnet-v1:0",
    "gpt-5.6-luna",
    "gpt-5.5-terra",
    "gpt-5.6-terra",
    "gemini-3.8-flash",
    "gemini-2.5-flash-preview-05-20",
    "claude-haiku-4-5-20251001",
  ];
  assert.equal(suggestModel(rankModelsForHint(gateway)), "claude-haiku-4-5-20251001", "Haiku, the default's family, comes first");
  assert.equal(
    suggestModel(rankModelsForHint(["claude-haiku-4-5-20251001", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-haiku-5-5-latest"])),
    "claude-haiku-5-5",
  );
  const noHaiku = gateway.filter((id) => !/haiku/.test(id));
  assert.equal(suggestModel(rankModelsForHint(noHaiku)), "claude-5-0-sonnet-v1:0");
  const noSonnet = noHaiku.filter((id) => !/sonnet/.test(id));
  assert.equal(suggestModel(rankModelsForHint(noSonnet)), "gemini-3.8-flash");
  const noGemini = noSonnet.filter((id) => !/gemini-\d\.\d-flash$|flash-preview/.test(id));
  assert.equal(suggestModel(rankModelsForHint(noGemini)), "gpt-5.6-terra", "Flash-Lite does not count as a Flash");
  // The gateway from the bug report: Sonnet 5.5 over GPT terra.
  assert.equal(
    suggestModel(rankModelsForHint(["gpt-5-6-terra", "claude-sonnet-5-5", "claude-sonnet-5-0", "claude-sonnet-4-6-20250514", "claude-sonnet-5-5-latest"])),
    "claude-sonnet-5-5",
  );
  assert.equal(suggestModel(["anthropic/claude-sonnet-4-5-20250929", "anthropic/claude-sonnet-5.5", "claude-3-7-sonnet-20250219"]), "anthropic/claude-sonnet-5.5");
  assert.equal(suggestModel(["gemini-3.8-flash-preview", "google/gemini-3.8-flash"]), "google/gemini-3.8-flash", "a tie goes to the plain id");
  assert.equal(suggestModel(["claude-opus-5", "gpt-5-mini"]), "gpt-5-mini", "none of the three: any mid-tier model");
});

test("modelVersion reads the version, not dates or provider suffixes", () => {
  assert.deepEqual(modelVersion("google/gemini-3.8-flash"), [3, 8]);
  assert.deepEqual(modelVersion("claude-sonnet-5-5"), [5, 5]);
  assert.deepEqual(modelVersion("claude-4-6-sonnet-v1:0"), [4, 6]);
  assert.deepEqual(modelVersion("claude-3-7-sonnet-20250219"), [3, 7]);
  assert.deepEqual(modelVersion("gemini-2.5-flash-preview-05-20"), [2, 5]);
});

test("modelVersion: a Databricks service or endpoint prefix is not the version", () => {
  assert.deepEqual(modelVersion("model_service.models.1adp-gpt-5-6-terra"), [5, 6]);
  assert.deepEqual(modelVersion("databricks-gpt-5-6-terra"), [5, 6]);
  assert.deepEqual(modelVersion("model_service.models.1adp-qwen3-5-122b"), [3, 5, 122]);
  assert.equal(
    suggestModel(["model_service.models.1adp-gpt-5-6-terra", "databricks-gpt-6-2-terra", "model_service.models.1adp-gpt-6-1-sol"]),
    "databricks-gpt-6-2-terra",
    "the latest terra, whichever name the gateway knows it by",
  );
});

test("envSetExample matches the user's shell", () => {
  assert.equal(envSetExample("GRAFT_MODEL", "m", "win32"), `$env:GRAFT_MODEL = "m"`);
  assert.equal(envSetExample("GRAFT_MODEL", "m", "linux"), `export GRAFT_MODEL="m"`);
});

const env = { GRAFT_BASE_URL: "https://gw.example/v1", GRAFT_API_KEY: "secret-key" };

test("hints: unreachable names GRAFT_BASE_URL and where the URL came from", async () => {
  const lines = (await llmFailureHints(["Connection error."], { config: {}, env, platform: "linux" })).join("\n");
  assert.match(lines, /https:\/\/gw\.example\/v1 could not be reached \(from GRAFT_BASE_URL\)/);
  assert.match(lines, /export GRAFT_BASE_URL=/);
  assert.doesNotMatch(lines, /secret-key/);
});

test("hints: unreachable default endpoint says GRAFT_BASE_URL is not set", async () => {
  const lines = (await llmFailureHints(["Connection error."], { config: { apiKey: "k" }, env: {}, platform: "linux" })).join("\n");
  assert.match(lines, /GRAFT_BASE_URL is not set, so graft used the Databricks AI Gateway default/);
  assert.match(lines, /dbc-b40437c6-87d6\.cloud\.databricks\.com\/ai-gateway\/anthropic could not be reached/);
});

test("hints: rejected key names GRAFT_API_KEY and never echoes the key", async () => {
  const lines = (await llmFailureHints(["401 Unauthorized"], { config: {}, env, platform: "linux" })).join("\n");
  assert.match(lines, /rejected the API key \(from GRAFT_API_KEY\)/);
  assert.match(lines, /export GRAFT_API_KEY="<your-api-key>"/);
  assert.doesNotMatch(lines, /secret-key/);
  assert.doesNotMatch(lines, /dbx\.1adp\.automotive\.cloud/, "the Databricks token page is only for the Databricks gateway");
});

test("hints: a key rejected by the Databricks gateway points at the token page", async () => {
  const lines = (await llmFailureHints(["401 Unauthorized"], { config: { apiKey: "k" }, env: {}, platform: "linux" })).join("\n");
  assert.match(lines, /rejected the API key/);
  assert.match(lines, /https:\/\/dbx\.1adp\.automotive\.cloud\/login/);
});

test("hints: unknown model lists what the endpoint serves and suggests a mid-tier one", async () => {
  const lines = (
    await llmFailureHints(["404 The model `nope` does not exist"], {
      config: {},
      env: { ...env, GRAFT_MODEL: "nope" },
      platform: "linux",
      listModels: async () => ["claude-opus-5", "claude-sonnet-5.5", "gpt-5.5-terra"],
    })
  ).join("\n");
  assert.match(lines, /Model "nope" \(from GRAFT_MODEL\) was not found/);
  assert.match(lines, /Models this endpoint serves: claude-sonnet-5\.5, gpt-5\.5-terra, claude-opus-5/);
  assert.match(lines, /export GRAFT_MODEL="claude-sonnet-5\.5"/, "the Claude Sonnet is recommended first");
  assert.match(lines, /top-tier model .* is not necessary/);
});

test("hints: unknown default model, listing unavailable → example ids", async () => {
  const lines = (
    await llmFailureHints(["404 The model `claude-haiku-5-5` does not exist"], {
      config: {},
      env,
      platform: "linux",
      listModels: async () => {
        throw new Error("404 Not Found");
      },
    })
  ).join("\n");
  assert.match(lines, /Model "claude-haiku-5-5" \(graft's default model — GRAFT_MODEL is not set\)/);
  assert.match(lines, /Could not list the models this endpoint serves \(404 Not Found\)/);
  assert.match(lines, /claude-haiku-5\.5, gpt-5\.5-terra, gemini-3\.8-flash/);
  assert.match(lines, /top-tier model .* is not necessary/);
});

test("hints: nothing to say for a quota failure", async () => {
  assert.deepEqual(await llmFailureHints(["429 quota exceeded"], { config: {}, env }), []);
});
