import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateEfforts, isEffortName, normalizeEffort, sortEfforts } from "../src/ai/llm/effort.js";
import { acceptedEfforts, probeEfforts } from "../src/ai/llm-effort.js";
import type { ChatModelConfig } from "../src/ai/llm/factory.js";
import type { ChatModel } from "../src/ai/llm/types.js";
import type { ResolvedConfig } from "../src/ai/providers.js";

test("normalizeEffort: lower-cases, resolves aliases, and reads default words as unset", () => {
  assert.equal(normalizeEffort(" High "), "high");
  assert.equal(normalizeEffort("off"), "none");
  assert.equal(normalizeEffort("x-high"), "xhigh");
  assert.equal(normalizeEffort("maximum"), "max");
  assert.equal(normalizeEffort("default"), undefined);
  assert.equal(normalizeEffort("auto"), undefined);
  assert.equal(normalizeEffort(""), undefined);
  assert.equal(normalizeEffort(undefined), undefined);
  assert.equal(normalizeEffort("turbo"), "turbo", "a level graft does not know is kept for the endpoint to judge");
});

test("isEffortName / sortEfforts", () => {
  assert.ok(isEffortName("xhigh"));
  assert.ok(!isEffortName("very much"));
  assert.ok(!isEffortName("1high"));
  assert.deepEqual(sortEfforts(["max", "turbo", "low", "none", "low"]), ["none", "low", "max", "turbo"]);
});

test("candidateEfforts: per model family, gateways' prefixes ignored", () => {
  assert.deepEqual(candidateEfforts("claude-sonnet-5.5", "openai"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(candidateEfforts("databricks-claude-haiku-5-5", "openai"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(candidateEfforts("anything", "anthropic"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(candidateEfforts("openai/o4-mini", "openai"), ["low", "medium", "high"]);
  assert.deepEqual(candidateEfforts("gpt-5-6-terra", "openai"), ["none", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(candidateEfforts("google/gemini-3.8-flash", "openai"), ["none", "minimal", "low", "medium", "high"]);
  assert.deepEqual(candidateEfforts("deepseek-r2", "openai"), ["none", "low", "medium", "high"]);
  assert.deepEqual(candidateEfforts("my-local-model", "openai"), ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

const CFG = { provider: "openai", apiKey: "k", model: "m", baseUrl: "https://gw.example/v1" } as unknown as ResolvedConfig;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** A factory whose model answers or throws per effort level; records every config it was built with. */
function stubFactory(answer: (level: string | undefined) => Error | undefined) {
  const built: ChatModelConfig[] = [];
  const make = (cfg: ChatModelConfig): ChatModel => {
    built.push(cfg);
    return {
      create: async () => {
        const err = answer(cfg.reasoningEffort);
        if (err) throw err;
        return { content: "OK" };
      },
    } as unknown as ChatModel;
  };
  return { built, make };
}

test("probeEfforts: a 4xx after a good baseline is a refusal; auth/limits/5xx are unknown", async () => {
  const { built, make } = stubFactory((level) => {
    if (level === "minimal") return httpError(400, "Unsupported value: 'reasoning_effort' does not support 'minimal' with this model.");
    if (level === "xhigh") return httpError(429, "rate limited");
    if (level === "max") return httpError(503, "overloaded");
    return undefined;
  });
  const probe = await probeEfforts(CFG, ["none", "minimal", "low", "xhigh", "max"], make);
  assert.equal(probe.baselineError, undefined);
  assert.deepEqual(
    probe.results.map((r) => [r.level, r.verdict]),
    [
      ["none", "accepted"],
      ["minimal", "rejected"],
      ["low", "accepted"],
      ["xhigh", "unknown"],
      ["max", "unknown"],
    ],
  );
  assert.deepEqual(acceptedEfforts(probe), ["none", "low"]);
  // Baseline first (no effort), then one request per level; strict, and never through a fallback model.
  assert.equal(built[0]!.reasoningEffort, undefined);
  assert.equal(built.length, 6);
  for (const cfg of built) {
    assert.equal(cfg.strictEffort, true);
    assert.equal(cfg.modelFallbacks, undefined);
    assert.equal(cfg.providerFallback, undefined);
  }
});

test("probeEfforts: when the baseline fails, nothing is judged", async () => {
  const { built, make } = stubFactory(() => httpError(401, "401 Incorrect API key provided"));
  const probe = await probeEfforts(CFG, ["low", "high"], make);
  assert.match(probe.baselineError ?? "", /Incorrect API key/);
  assert.deepEqual(
    probe.results.map((r) => r.verdict),
    ["unknown", "unknown"],
  );
  assert.equal(built.length, 1, "no level is sent after a failed baseline");
});
