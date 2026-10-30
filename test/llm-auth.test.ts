import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkLlmAuth,
  commitEndpointChoice,
  endpointConflict,
  ensureLlmAuth,
  resolveEndpointConflict,
  sameEndpoint,
  type AuthCheck,
  type AuthRecoveryDeps,
} from "../src/ai/llm-auth.js";
import { ENDPOINT_CHOICE_ENV, PromptCancelled, type Prompter, type UserEnvStore } from "../src/ai/llm-settings.js";
import type { ResolvedConfig } from "../src/ai/providers.js";

function memoryStore(initial: Record<string, string> = {}): UserEnvStore & { vars: Map<string, string> } {
  const vars = new Map(Object.entries(initial));
  return {
    vars,
    where: "test store",
    read: (n) => vars.get(n),
    write: (n, v) => (v === undefined ? vars.delete(n) : vars.set(n, v)),
  };
}

function scripted(answers: string[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = async (q: string) => {
    asked.push(q);
    const a = answers.shift();
    if (a === undefined) throw new PromptCancelled();
    return a;
  };
  return { asked, ask: next, askHidden: next };
}

function deps(over: Partial<AuthRecoveryDeps> = {}): AuthRecoveryDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    config: {},
    env: {},
    store: memoryStore(),
    platform: "linux",
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    ...over,
    lines,
  };
}

const CUSTOM = "https://gw.example.com/v1";

// ---- provider endpoint vs custom endpoint ----

test("sameEndpoint ignores case, trailing slashes and a trailing /v1", () => {
  assert.ok(sameEndpoint("https://API.anthropic.com/", "https://api.anthropic.com/v1"));
  assert.ok(!sameEndpoint("https://gw.example.com", "https://api.anthropic.com"));
});

test("conflict: only an explicit provider with its own endpoint next to a different custom URL", () => {
  assert.equal(endpointConflict({}, { GRAFT_BASE_URL: CUSTOM }), undefined, "provider defaulted: no conflict");
  assert.equal(endpointConflict({}, { GRAFT_PROVIDER: "llm-incubator", GRAFT_BASE_URL: CUSTOM }), undefined, "no built-in endpoint");
  assert.equal(endpointConflict({}, { GRAFT_PROVIDER: "anthropic" }), undefined, "no custom URL");
  assert.equal(endpointConflict({}, { GRAFT_PROVIDER: "anthropic", GRAFT_BASE_URL: "https://api.anthropic.com/" }), undefined);
  const c = endpointConflict({}, { GRAFT_PROVIDER: "anthropic", ANTHROPIC_BASE_URL: CUSTOM });
  assert.deepEqual(c && { url: c.customUrl, from: c.urlFrom, own: c.providerUrl }, {
    url: CUSTOM,
    from: "ANTHROPIC_BASE_URL",
    own: "https://api.anthropic.com",
  });
  assert.equal(endpointConflict({ provider: "anthropic", baseUrl: CUSTOM }, {})?.urlFrom, "--base-url");
  assert.equal(endpointConflict({}, { GRAFT_PROVIDER: "orcarouter", GRAFT_BASE_URL: CUSTOM })?.providerFrom, "GRAFT_PROVIDER");
});

test("conflict: openai and litellm name a wire format, so a custom URL is never a conflict", () => {
  assert.equal(endpointConflict({}, { GRAFT_PROVIDER: "openai", GRAFT_BASE_URL: "https://openrouter.ai/api/v1" }), undefined);
  assert.equal(endpointConflict({ provider: "openai", baseUrl: CUSTOM }, {}), undefined);
  assert.equal(endpointConflict({}, { GRAFT_PROVIDER: "litellm", GRAFT_BASE_URL: "http://proxy.corp:4000" }), undefined);
});

test("conflict: asks which endpoint, saves the choice once committed, and does not ask again for the same pair", async () => {
  const store = memoryStore({ GRAFT_PROVIDER: "anthropic", GRAFT_BASE_URL: CUSTOM });
  const prompt = scripted(["2"]);
  const d = deps({ store, prompt });
  const r = await resolveEndpointConflict(d);
  assert.ok(!("cancelled" in r));
  assert.equal(r.changes.env.GRAFT_BASE_URL, "https://api.anthropic.com");
  assert.equal(store.vars.get("GRAFT_BASE_URL"), CUSTOM, "nothing is saved before the endpoint passed its check");
  assert.equal(store.vars.get(ENDPOINT_CHOICE_ENV), undefined);
  commitEndpointChoice(d, r.saves);
  assert.equal(store.vars.get("GRAFT_BASE_URL"), "https://api.anthropic.com", "the provider's endpoint replaces the saved custom one");
  assert.equal(store.vars.get(ENDPOINT_CHOICE_ENV), `anthropic|${CUSTOM}|provider`);
  assert.equal(prompt.asked.length, 1);

  // Choosing the custom endpoint is remembered as well: no second question.
  const store2 = memoryStore({ GRAFT_PROVIDER: "anthropic", GRAFT_BASE_URL: CUSTOM });
  const d2 = deps({ store: store2, prompt: scripted([""]) });
  const r1 = await resolveEndpointConflict(d2);
  assert.ok(!("cancelled" in r1));
  commitEndpointChoice(d2, r1.saves);
  assert.equal(store2.vars.get(ENDPOINT_CHOICE_ENV), `anthropic|${CUSTOM}|custom`);
  const again = scripted([]);
  const r2 = await resolveEndpointConflict(deps({ store: store2, prompt: again }));
  assert.equal(again.asked.length, 0);
  assert.ok(!("cancelled" in r2) && r2.changes.env.GRAFT_BASE_URL === CUSTOM);

  // A different URL is a new pair: asked again.
  const changed = scripted(["1"]);
  await resolveEndpointConflict(deps({ store: store2, env: { GRAFT_BASE_URL: "https://other.example.com" }, prompt: changed }));
  assert.equal(changed.asked.length, 1);
});

test("conflict without a terminal: says which endpoint is used, how to choose, saves nothing, and says it once", async () => {
  const store = memoryStore();
  const env = { GRAFT_PROVIDER: "anthropic", GRAFT_BASE_URL: "https://once.example.com/v1" };
  const d = deps({ store, env });
  const r = await resolveEndpointConflict(d);
  assert.ok(!("cancelled" in r) && r.changes.env.GRAFT_BASE_URL === env.GRAFT_BASE_URL);
  assert.deepEqual(r.saves, {});
  assert.equal(store.vars.size, 0);
  const text = d.lines.join("\n");
  assert.match(text, /Using the custom endpoint/);
  assert.match(text, /run this command once in a terminal/);
  assert.ok(text.includes(`${ENDPOINT_CHOICE_ENV}=anthropic|https://once.example.com/v1|custom`));
  const d2 = deps({ store, env });
  await resolveEndpointConflict(d2);
  assert.equal(d2.lines.length, 0, "not repeated before every call of the same process");
});

test("conflict: a Databricks gateway URL is never one (graft ignores the provider there)", () => {
  assert.equal(
    endpointConflict({}, { GRAFT_PROVIDER: "anthropic", GRAFT_BASE_URL: "https://dbc-1.cloud.databricks.com/ai-gateway/anthropic" }),
    undefined,
  );
});

test("conflict: a skip during the recovery saves no endpoint choice", async () => {
  const store = memoryStore();
  const r = await ensureLlmAuth(
    deps({
      store,
      env: { GRAFT_PROVIDER: "anthropic", GRAFT_API_KEY: "sk-bad-1234567890" },
      prompt: scripted(["https://typed.example.com", "", "2", "s"]),
      check: gate("x", "y"),
    }),
  );
  assert.equal(r.status, "skipped");
  assert.equal(store.vars.size, 0);
});

test("conflict from --base-url: the choice replaces the flag for this run only", async () => {
  const store = memoryStore();
  const r = await resolveEndpointConflict(
    deps({ store, config: { provider: "anthropic", baseUrl: CUSTOM }, prompt: scripted(["2"]) }),
  );
  assert.ok(!("cancelled" in r));
  assert.equal(r.changes.config.baseUrl, "https://api.anthropic.com");
  assert.equal(store.vars.get("GRAFT_BASE_URL"), undefined);
});

// ---- auth check ----

const cfgFor = (over: Partial<ResolvedConfig>): ResolvedConfig =>
  ({ provider: "openai", model: "m", apiKey: "sk-test-123456789", baseUrl: CUSTOM, ...over }) as ResolvedConfig;

test("checkLlmAuth: listing ok, rejected chat, unreachable, unknown", async () => {
  const status = (n: number, m: string) => Object.assign(new Error(m), { status: n });
  assert.equal((await checkLlmAuth(cfgFor({ apiKey: undefined }))).status, "missing");
  assert.equal((await checkLlmAuth(cfgFor({}), { listModels: async () => ["m"] })).status, "ok");
  const rejected = await checkLlmAuth(cfgFor({}), {
    listModels: async () => {
      throw status(404, "404 not found");
    },
    chat: async () => {
      throw status(401, "401 invalid api key");
    },
  });
  assert.equal(rejected.status, "rejected");
  const unreachable = await checkLlmAuth(cfgFor({}), {
    listModels: async () => {
      throw new Error("fetch failed: getaddrinfo ENOTFOUND gw.example.com");
    },
    chat: async () => assert.fail("no chat request to a host that did not answer"),
  });
  assert.equal(unreachable.status, "unreachable");
  const unknown = await checkLlmAuth(cfgFor({}), {
    listModels: async () => {
      throw status(404, "404 not found");
    },
    chat: async () => {
      throw status(400, "400 unsupported parameter: max_tokens");
    },
  });
  assert.equal(unknown.status, "unknown", "an answer no URL or key fixes is not an auth failure");
});

test("checkLlmAuth: a slow or HTML /models listing still lets one chat request decide", async () => {
  for (const listed of ["Request timed out.", "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"]) {
    let chats = 0;
    const r = await checkLlmAuth(cfgFor({}), {
      listModels: async () => {
        throw new Error(listed);
      },
      chat: async () => {
        chats++;
      },
    });
    assert.equal(r.status, "ok", listed);
    assert.equal(chats, 1, `${listed}: the chat request decides`);
  }
  const slowChat = await checkLlmAuth(cfgFor({}), {
    listModels: async () => {
      throw new Error("Request timed out.");
    },
    chat: async () => {
      throw new Error("Request timed out.");
    },
  });
  assert.equal(slowChat.status, "unknown", "a probe cut off by its short timeout does not block the build");
});

// ---- auth recovery ----

/** A check that accepts only `goodKey` at `goodUrl`. */
function gate(goodUrl: string, goodKey: string): (cfg: ResolvedConfig) => Promise<AuthCheck> {
  return async (cfg) =>
    cfg.baseUrl && sameEndpoint(cfg.baseUrl, goodUrl) && cfg.apiKey === goodKey
      ? { status: "ok" }
      : { status: "rejected", message: "401 invalid api key" };
}

test("recovery: asks for URL and key, re-checks, and saves what passed", async () => {
  const store = memoryStore();
  const prompt = scripted(["https://good.example.com/v1", "sk-good-123456789"]);
  const d = deps({
    store,
    env: { GRAFT_BASE_URL: CUSTOM, GRAFT_API_KEY: "sk-bad-1234567890" },
    prompt,
    check: gate("https://good.example.com/v1", "sk-good-123456789"),
  });
  const r = await ensureLlmAuth(d);
  assert.equal(r.status, "ok");
  assert.ok(r.status === "ok" && r.changes.env.GRAFT_BASE_URL === "https://good.example.com/v1");
  assert.equal(store.vars.get("GRAFT_BASE_URL"), "https://good.example.com/v1");
  assert.equal(store.vars.get("GRAFT_API_KEY"), "sk-good-123456789");
  assert.equal(prompt.asked.length, 2, "one URL and one key question");
});

test("recovery: Enter keeps a value; a wrong new key is asked for again", async () => {
  const store = memoryStore();
  const prompt = scripted(["", "sk-wrong-123456789", "", "sk-good-123456789"]);
  const r = await ensureLlmAuth(
    deps({ store, env: { GRAFT_BASE_URL: CUSTOM, GRAFT_API_KEY: "sk-bad-1234567890" }, prompt, check: gate(CUSTOM, "sk-good-123456789") }),
  );
  assert.equal(r.status, "ok");
  assert.equal(store.vars.get("GRAFT_BASE_URL"), undefined, "the kept URL is not re-saved");
  assert.equal(store.vars.get("GRAFT_API_KEY"), "sk-good-123456789");
  assert.equal(prompt.asked.length, 4);
});

test("recovery: s skips and keeps everything as it is", async () => {
  const store = memoryStore();
  const r = await ensureLlmAuth(
    deps({ store, env: { GRAFT_BASE_URL: CUSTOM, GRAFT_API_KEY: "sk-bad-1234567890" }, prompt: scripted(["s"]), check: gate("x", "y") }),
  );
  assert.equal(r.status, "skipped");
  assert.equal(store.vars.size, 0);
});

test("recovery: Enter on both stops asking", async () => {
  const prompt = scripted(["", ""]);
  const r = await ensureLlmAuth(
    deps({ env: { GRAFT_BASE_URL: CUSTOM, GRAFT_API_KEY: "sk-bad-1234567890" }, prompt, check: gate("x", "y") }),
  );
  assert.equal(r.status, "skipped");
  assert.equal(prompt.asked.length, 2);
});

test("recovery without a terminal: reports the failure and asks nothing", async () => {
  const d = deps({ env: { GRAFT_BASE_URL: CUSTOM, GRAFT_API_KEY: "sk-bad-1234567890" }, check: gate("x", "y") });
  const r = await ensureLlmAuth(d);
  assert.equal(r.status, "failed");
  assert.match(d.lines.join("\n"), /rejected the API key/);
});

test("recovery: a key from ANTHROPIC_AUTH_TOKEN is replaced there, keeping its Bearer auth", async () => {
  const store = memoryStore();
  await ensureLlmAuth(
    deps({
      store,
      env: { GRAFT_PROVIDER: "anthropic", ANTHROPIC_BASE_URL: CUSTOM, ANTHROPIC_AUTH_TOKEN: "sk-bad-1234567890", [ENDPOINT_CHOICE_ENV]: `anthropic|${CUSTOM}|custom` },
      prompt: scripted(["", "sk-good-123456789"]),
      check: gate(CUSTOM, "sk-good-123456789"),
    }),
  );
  assert.equal(store.vars.get("ANTHROPIC_AUTH_TOKEN"), "sk-good-123456789");
  assert.equal(store.vars.get("GRAFT_API_KEY"), undefined);
});

test("recovery: a typed URL that disagrees with the provider asks which endpoint to use", async () => {
  const store = memoryStore();
  const prompt = scripted(["https://typed.example.com", "", "2"]);
  const r = await ensureLlmAuth(
    deps({
      store,
      env: { GRAFT_PROVIDER: "anthropic", GRAFT_API_KEY: "sk-good-123456789" },
      prompt,
      // The first check fails (the gate wants an explicit URL), so the URL is asked for.
      check: gate("https://api.anthropic.com", "sk-good-123456789"),
    }),
  );
  assert.equal(r.status, "ok");
  assert.equal(store.vars.get("GRAFT_BASE_URL"), "https://api.anthropic.com");
  assert.equal(store.vars.get(ENDPOINT_CHOICE_ENV), "anthropic|https://typed.example.com|provider");
});

test("checkLlmAuth: no endpoint URL and a provider without one → no-url, nothing is sent", async () => {
  const r = await checkLlmAuth(cfgFor({ provider: "llm-incubator" as ResolvedConfig["provider"], baseUrl: undefined }), {
    listModels: async () => assert.fail("no request without an endpoint"),
    chat: async () => assert.fail("no request without an endpoint"),
  });
  assert.equal(r.status, "no-url");
  assert.match(r.message ?? "", /no default one/);
});

test("checkLlmAuth: the caller's failed listing is not repeated", async () => {
  const r = await checkLlmAuth(
    cfgFor({}),
    { listModels: async () => assert.fail("listed again"), chat: async () => {} },
    { listingError: Object.assign(new Error("404 not found"), { status: 404 }) },
  );
  assert.equal(r.status, "ok");
});

test("checkLlmAuth on Databricks: only the configured model's route, unless every route is wanted", async () => {
  const root = "https://dbc-1.cloud.databricks.com";
  const cfg = cfgFor({
    baseUrl: `${root}/ai-gateway/anthropic`,
    databricks: { root, route: "anthropic" },
  } as Partial<ResolvedConfig>);
  const routes: string[] = [];
  const databricksLister = async (route: string) => (routes.push(route), route === "anthropic" ? ["claude-haiku-5-5"] : []);
  const one = await checkLlmAuth(cfg, { databricksLister });
  assert.equal(one.status, "ok");
  assert.deepEqual(routes, ["anthropic"]);
  assert.deepEqual(one.ids, ["claude-haiku-5-5"]);
  assert.equal(one.listings, undefined);
  routes.length = 0;
  const all = await checkLlmAuth(cfg, { databricksLister }, { allRoutes: true });
  assert.ok(routes.length > 1, "every route listed");
  assert.equal(all.listings?.length, routes.length);
});

test("recovery: a new key for a legacy OPENROUTER_API_KEY keeps the endpoint it used", async () => {
  const store = memoryStore();
  const d = deps({
    store,
    env: { OPENROUTER_API_KEY: "sk-or-bad-123456789", OPENROUTER_BASE_URL: CUSTOM, ANTHROPIC_BASE_URL: "https://elsewhere.example.com" },
    prompt: scripted(["", "sk-good-123456789"]),
    check: gate(CUSTOM, "sk-good-123456789"),
  });
  const r = await ensureLlmAuth(d);
  assert.equal(r.status, "ok");
  assert.equal(store.vars.get("GRAFT_API_KEY"), "sk-good-123456789");
  assert.equal(store.vars.get("GRAFT_BASE_URL"), CUSTOM, "pinned: with GRAFT_API_KEY, ANTHROPIC_BASE_URL would win otherwise");
  assert.match(d.lines.join("\n"), /would otherwise send it elsewhere/);
});

test("recovery: a new key for a legacy key that reached the provider's own endpoint keeps that endpoint", async () => {
  const store = memoryStore();
  const own = "http://localhost:4000"; // the litellm provider's own endpoint
  const d = deps({
    store,
    env: { GRAFT_PROVIDER: "litellm", ORCAROUTER_API_KEY: "sk-or-bad-123456789", ANTHROPIC_BASE_URL: "https://elsewhere.example.com" },
    prompt: scripted(["", "sk-good-123456789"]),
    check: gate(own, "sk-good-123456789"),
  });
  const r = await ensureLlmAuth(d);
  assert.equal(r.status, "ok");
  assert.equal(store.vars.get("GRAFT_API_KEY"), "sk-good-123456789");
  assert.equal(store.vars.get("GRAFT_BASE_URL"), own, "pinned: with GRAFT_API_KEY, ANTHROPIC_BASE_URL would win otherwise");
});

test("recovery: the caller's endpoint choice is saved once the endpoint passes", async () => {
  const store = memoryStore();
  const pendingSaves = { [ENDPOINT_CHOICE_ENV]: `anthropic|${CUSTOM}|custom` };
  const r = await ensureLlmAuth(
    deps({ store, env: { GRAFT_BASE_URL: CUSTOM, GRAFT_API_KEY: "sk-good-123456789" }, check: gate(CUSTOM, "sk-good-123456789") }),
    { pendingSaves },
  );
  assert.equal(r.status, "ok");
  assert.equal(store.vars.get(ENDPOINT_CHOICE_ENV), `anthropic|${CUSTOM}|custom`);
});

test("recovery: a URL typed meanwhile replaces the caller's endpoint choice instead of being overwritten by it", async () => {
  const store = memoryStore();
  const other = "https://other.example.com";
  // The caller picked the provider's endpoint for CUSTOM (and applied it); that endpoint rejects the key.
  const pendingSaves = { [ENDPOINT_CHOICE_ENV]: `anthropic|${CUSTOM}|provider`, GRAFT_BASE_URL: "https://api.anthropic.com" };
  const r = await ensureLlmAuth(
    deps({
      store,
      env: { GRAFT_PROVIDER: "anthropic", GRAFT_BASE_URL: "https://api.anthropic.com", GRAFT_API_KEY: "sk-good-123456789" },
      prompt: scripted([other, "", "1"]),
      check: gate(other, "sk-good-123456789"),
    }),
    { pendingSaves },
  );
  assert.equal(r.status, "ok");
  assert.equal(store.vars.get("GRAFT_BASE_URL"), other);
  assert.equal(store.vars.get(ENDPOINT_CHOICE_ENV), `anthropic|${other}|custom`);
});

test("checkLlmAuth on Databricks: the caller's failed listing of every route is judged, not repeated", async () => {
  const root = "https://dbc-1.cloud.databricks.com";
  const cfg = cfgFor({ baseUrl: `${root}/ai-gateway/anthropic`, databricks: { root, route: "anthropic" } } as Partial<ResolvedConfig>);
  const databricksLister = async () => assert.fail("listed again");
  const rejected = await checkLlmAuth(cfg, { databricksLister }, { listingError: Object.assign(new Error("401 invalid token"), { status: 401 }) });
  assert.equal(rejected.status, "rejected");
  const forbidden = await checkLlmAuth(cfg, { databricksLister }, { listingError: Object.assign(new Error("403 forbidden"), { status: 403 }) });
  assert.equal(forbidden.status, "unknown", "a 403 may only forbid the listing");
});
