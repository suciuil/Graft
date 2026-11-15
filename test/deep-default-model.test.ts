import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDeepDefaultModel, latestHaiku } from "../src/ai/deep-default-model.js";
import { resolveConfig, DEFAULT_MODEL } from "../src/ai/providers.js";
import { chooseDatabricksDeepModel } from "../src/ai/databricks-setup.js";
import { DATABRICKS_BASE_URL, type DatabricksLister } from "../src/ai/llm/databricks.js";

const GW = "https://gw.example/v1";
const gw = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ GRAFT_API_KEY: "k", GRAFT_BASE_URL: GW, ...extra });
const dbx = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ GRAFT_API_KEY: "dapi1", GRAFT_BASE_URL: DATABRICKS_BASE_URL, ...extra });

test("latestHaiku: the newest Claude Haiku, whatever the spelling", () => {
  const ids = ["claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-3-5-haiku-20241022", "claude-haiku-5-5", "gpt-5-6-terra"];
  assert.equal(latestHaiku(ids), "claude-haiku-5-5");
  assert.equal(latestHaiku([...ids, "claude-haiku-6"]), "claude-haiku-6");
  assert.equal(latestHaiku(["anthropic/claude-haiku-4-5", "anthropic/claude-haiku-5.5"]), "anthropic/claude-haiku-5.5");
  assert.equal(latestHaiku(["us.anthropic.claude-haiku-4-5-20251001-v1:0", "us.anthropic.claude-haiku-5-5"]), "us.anthropic.claude-haiku-5-5");
  // A tie: the plainest id (the bare one falls back to the service id by itself).
  assert.equal(latestHaiku(["model_service.models.1adp-haiku-5-5", "claude-haiku-5-5"]), "claude-haiku-5-5");
  assert.equal(latestHaiku(["claude-sonnet-5-5", "gpt-5-6-terra"]), undefined);
  assert.equal(latestHaiku([]), undefined);
});

test("resolveConfig: defaultModel replaces the built-in default only when no model is configured", () => {
  const plain = resolveConfig({}, gw());
  assert.equal(plain.model, DEFAULT_MODEL);
  assert.equal(plain.modelDefaulted, true);
  const detected = resolveConfig({ defaultModel: "claude-haiku-6" }, gw());
  assert.equal(detected.model, "claude-haiku-6");
  assert.equal(detected.modelDefaulted, true);
  const set = resolveConfig({ defaultModel: "claude-haiku-6" }, gw({ GRAFT_MODEL: "gpt-5-6-terra" }));
  assert.equal(set.model, "gpt-5-6-terra");
  assert.equal(set.modelDefaulted, false);
  assert.equal(resolveConfig({ model: "m", defaultModel: "claude-haiku-6" }, gw()).model, "m");
  const onDbx = resolveConfig({ defaultModel: "claude-haiku-6" }, dbx());
  assert.equal(onDbx.model, "claude-haiku-6");
  assert.equal(onDbx.modelDefaulted, true);
  assert.equal(resolveConfig({ defaultModel: "claude-haiku-6" }, dbx({ GRAFT_MODEL: "claude-opus-5-5" })).model, "claude-opus-5-5");
});

test("detect: the latest Claude Haiku the endpoint lists", async () => {
  let asked = 0;
  const r = await detectDeepDefaultModel({
    config: {},
    env: gw(),
    listModels: async () => (asked++, ["claude-haiku-4-5", "claude-haiku-5-5", "claude-opus-5-5"]),
  });
  assert.deepEqual(r, { model: "claude-haiku-5-5", endpoint: GW });
  assert.equal(asked, 1);
});

test("detect: a configured model, or no key, is left alone and nothing is listed", async () => {
  const listModels = async () => assert.fail("listed");
  assert.equal(await detectDeepDefaultModel({ config: {}, env: gw({ GRAFT_MODEL: "gpt-5-6-terra" }), listModels }), undefined);
  assert.equal(await detectDeepDefaultModel({ config: { model: "claude-opus-5" }, env: gw(), listModels }), undefined);
  assert.equal(await detectDeepDefaultModel({ config: {}, env: { GRAFT_BASE_URL: GW }, listModels }), undefined);
});

test("detect: no Haiku listed, or no listing at all, keeps the built-in default", async () => {
  assert.equal(await detectDeepDefaultModel({ config: {}, env: gw(), listModels: async () => ["claude-sonnet-5-5"] }), undefined);
  const failing = async (): Promise<string[]> => {
    throw new Error("404 Not Found");
  };
  assert.equal(await detectDeepDefaultModel({ config: {}, env: gw(), listModels: failing }), undefined);
});

test("detect: the auth check's listing is reused, and a failed one is not retried", async () => {
  const listModels = async () => assert.fail("listed again");
  const reused = await detectDeepDefaultModel({ config: {}, env: gw(), ids: ["claude-haiku-6", "claude-haiku-5-5"], listModels });
  assert.equal(reused?.model, "claude-haiku-6");
  assert.equal(await detectDeepDefaultModel({ config: {}, env: gw(), listingFailed: true, listModels }), undefined);
});

test("detect: on the Databricks gateway only the Anthropic route is asked", async () => {
  const routes: string[] = [];
  const lister: DatabricksLister = async (route) => {
    routes.push(route);
    return route === "anthropic" ? ["claude-opus-5-5", "model_service.models.1adp-haiku-6"] : [];
  };
  const r = await detectDeepDefaultModel({ config: {}, env: dbx(), databricksLister: lister });
  assert.deepEqual(routes, ["anthropic"]);
  assert.equal(r?.model, "model_service.models.1adp-haiku-6");
  assert.match(r!.endpoint, /\/ai-gateway\/anthropic$/);

  // Listings an auth check made are reused.
  const listings = [{ route: "anthropic" as const, url: "u", ids: ["claude-haiku-5-5", "claude-haiku-6"] }];
  const again = await detectDeepDefaultModel({ config: {}, env: dbx(), listings, databricksLister: async () => assert.fail("listed again") });
  assert.equal(again?.model, "claude-haiku-6");
});

test("Databricks model choice: the detected Haiku is used without asking, and says where it came from", async () => {
  const lines: string[] = [];
  const listings = [{ route: "anthropic" as const, url: "u", ids: ["claude-haiku-5-5", "claude-haiku-6"] }];
  const r = await chooseDatabricksDeepModel({
    config: { defaultModel: "claude-haiku-6" },
    env: dbx(),
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    prompt: { ask: async () => assert.fail("asked"), askHidden: async () => assert.fail("asked") },
    listings,
  });
  assert.deepEqual(r, { config: { defaultModel: "claude-haiku-6", model: "claude-haiku-6" } });
  assert.match(lines.join("\n"), /→ claude-haiku-6 \(from graft's default: the latest Claude Haiku the gateway serves\)/);
});
