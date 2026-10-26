/**
 * The Databricks AI Gateway: graft's default LLM endpoint.
 *
 * One workspace host serves several wire formats under different paths, and the
 * model id decides which one a request takes:
 *   - Claude models:  <host>/ai-gateway/anthropic   (Anthropic Messages API)
 *   - OpenAI models:  <host>/ai-gateway/openai/v1   (OpenAI-compatible), under
 *     either the service id `model_service.models.1adp-gpt-*` or the serving
 *     endpoint name `databricks-gpt-*`
 *   - Qwen and other open models: <host>/ai-gateway/mlflow/v1 (OpenAI-compatible)
 *   - other `databricks-*` serving endpoints (Claude, Gemini, Qwen, Llama, …):
 *     <host>/serving-endpoints (OpenAI-compatible; the endpoint name is the model id)
 *
 * Every route authenticates with a Databricks personal access token as
 * `Authorization: Bearer` and carries the `Databricks-Ai-Gateway-Request-Tags`
 * header. A bare Claude id (`claude-sonnet-5-5`) also needs the
 * `Databricks-Model-Provider-Service` header; a `model_service.models.1adp-*` id
 * names the service itself and does not.
 *
 * Not every GPT model has both names: `databricks-gpt-6-astra` and
 * `databricks-gpt-5-mini` have no service id, while `databricks-gpt-5-5` is
 * rate-limited to 0 for a key that may call `model_service.models.1adp-gpt-5-5`.
 * Each name is therefore the other's fallback ({@link databricksModelFallbacks}),
 * and the OpenAI route's models are found by asking ({@link listOpenAiGatewayModels}).
 */
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { errorEnvelopeFetch } from "./openai.js";

export const DATABRICKS_BASE_URL = "https://dbc-b40437c6-87d6.cloud.databricks.com";

/** Where a user signs in to generate a Databricks personal access token for the gateway. */
export const DATABRICKS_TOKEN_URL = "https://dbx.1adp.automotive.cloud/login";

/** The one-line pointer shown whenever a Databricks token is missing or rejected. */
export function databricksTokenHint(): string {
  return `Generate a Databricks personal access token at ${DATABRICKS_TOKEN_URL}`;
}

export type DatabricksRoute = "anthropic" | "openai" | "mlflow" | "serving";

export const DATABRICKS_ROUTES: readonly DatabricksRoute[] = ["anthropic", "openai", "mlflow", "serving"];

const ROUTE_PATH: Record<DatabricksRoute, string> = {
  anthropic: "/ai-gateway/anthropic",
  openai: "/ai-gateway/openai/v1",
  mlflow: "/ai-gateway/mlflow/v1",
  serving: "/serving-endpoints",
};

export const DATABRICKS_ROUTE_LABEL: Record<DatabricksRoute, string> = {
  anthropic: "Anthropic (Claude) models",
  openai: "OpenAI (GPT) models",
  mlflow: "Qwen and other open models",
  serving: "Workspace serving endpoints (Claude, Gemini, Qwen, Llama, …)",
};

/**
 * Serving-endpoint names are prefixed with this. Such an id takes the `serving`
 * route, except an OpenAI model's (`databricks-gpt-*`), which the `openai` route
 * serves: `/serving-endpoints` refuses those with "rate limit set to 0" for keys
 * the gateway route answers.
 */
export const DATABRICKS_SERVING_PREFIX = "databricks-";

/** The gateway's own service ids for vendor models: `model_service.models.1adp-gpt-6-1-sol`. */
export const DATABRICKS_SERVICE_PREFIX = "model_service.models.1adp-";

/** OpenAI model names: GPT (including open-weight `gpt-oss`), Codex and the o-series. */
const OPENAI_RE = /gpt|codex|(^|[-./_])o\d/;

export const DATABRICKS_TAGS_HEADER = "Databricks-Ai-Gateway-Request-Tags";
export const DATABRICKS_TAGS = '{"registry_id": "personal"}';
export const DATABRICKS_PROVIDER_SERVICE_HEADER = "Databricks-Model-Provider-Service";
export const DATABRICKS_PROVIDER_SERVICE = "model_service.models.gcp-models";

/** Used when GRAFT_MODEL is unset: small and fast, which is all summaries need. */
export const DATABRICKS_DEFAULT_MODEL = "claude-haiku-5-5";

/**
 * Bare Claude ids and the gateway's own service ids for the same model, as in
 * Claude Code's `modelOverrides` for this gateway. Each side is the other's
 * fallback when the gateway does not know the one asked for.
 */
export const DATABRICKS_MODEL_MAP: Readonly<Record<string, string>> = {
  "claude-opus-5-5": "model_service.models.1adp-opus-5-5",
  "claude-opus-5": "model_service.models.1adp-opus-5",
  "claude-sonnet-5-5": "model_service.models.1adp-sonnet-5-5",
  "claude-sonnet-5": "model_service.models.1adp-sonnet-5",
  "claude-opus-4-8": "model_service.models.1adp-opus-4-8",
  "claude-opus-4-7": "model_service.models.1adp-opus-4-7",
  "claude-opus-4-6": "model_service.models.1adp-opus-4-6",
  "claude-sonnet-4-6": "model_service.models.1adp-sonnet-4-6",
  "claude-haiku-5-5": "model_service.models.1adp-haiku-5-5",
  "claude-haiku-4-5-20251001": "model_service.models.1adp-haiku-4-5",
};

/**
 * Offered when a route will not list its models. None for `serving`: its listing is
 * the only way to tell a usable endpoint from one rate-limited to 0, so a guessed
 * id there would be offered (and recommended) while every call to it is refused.
 */
export const DATABRICKS_KNOWN_MODELS: Readonly<Record<DatabricksRoute, readonly string[]>> = {
  anthropic: Object.keys(DATABRICKS_MODEL_MAP),
  openai: ["model_service.models.1adp-gpt-6-1-sol"],
  mlflow: ["model_service.models.1adp-qwen3-5-122b"],
  serving: [],
};

/**
 * The workspace root `https://<workspace>.cloud.databricks.com` of a Databricks
 * URL, or undefined for any other URL. The workspace label (e.g.
 * `dbc-b40437c6-87d6`) is not checked, and whatever follows the host is
 * dropped — `/`, `/ai-gateway`, `/ai-gateway/anthropic`, `/ai-gateway/openai/v1/…`,
 * `/v1`, a query — because graft rebuilds the route for the model itself
 * ({@link databricksRouteUrl}). A missing scheme or `http://` still yields https.
 */
export function parseDatabricksRoot(url: string | undefined): string | undefined {
  const raw = url?.trim();
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  if (u.username || u.password || (u.port && u.port !== "443")) return undefined;
  const domain = new URL(DATABRICKS_BASE_URL).hostname.replace(/^[^.]+\./, "");
  const [workspace, ...rest] = u.hostname.toLowerCase().split(".");
  if (!workspace || rest.join(".") !== domain) return undefined;
  return `https://${u.hostname.toLowerCase()}`;
}

/** Any URL on a Databricks workspace (see {@link parseDatabricksRoot}); other URLs keep graft's generic handling. */
export function isDatabricksGatewayUrl(url: string | undefined): boolean {
  return parseDatabricksRoot(url) !== undefined;
}

/** The workspace root of a Databricks URL, whatever path it ends with. */
export function databricksRoot(url: string): string {
  const root = parseDatabricksRoot(url);
  if (!root) throw new Error(`not a Databricks URL: ${url}`);
  return root;
}

/** `<root>/ai-gateway/anthropic`, `<root>/ai-gateway/openai/v1`, `<root>/ai-gateway/mlflow/v1` or `<root>/serving-endpoints`. */
export function databricksRouteUrl(root: string, route: DatabricksRoute): string {
  return `${root.replace(/\/+$/, "")}${ROUTE_PATH[route]}`;
}

/** Drops Claude Code's context-window suffix: `claude-opus-5-5[1m]` → `claude-opus-5-5`. */
export function normalizeDatabricksModel(model: string): string {
  return model.trim().replace(/\[[^\]]*\]$/, "");
}

/** Which gateway route serves `model`, judged from its id. */
export function databricksRoute(model: string): DatabricksRoute {
  const id = normalizeDatabricksModel(model).toLowerCase();
  if (id.startsWith(DATABRICKS_SERVING_PREFIX)) {
    return OPENAI_RE.test(id.slice(DATABRICKS_SERVING_PREFIX.length)) ? "openai" : "serving";
  }
  if (/claude|opus|sonnet|haiku/.test(id)) return "anthropic";
  if (OPENAI_RE.test(id)) return "openai";
  return "mlflow";
}

/** Headers every gateway request carries (the per-model one is {@link databricksModelHeaders}). */
export function databricksHeaders(): Record<string, string> {
  return { [DATABRICKS_TAGS_HEADER]: DATABRICKS_TAGS };
}

/** The provider-service header a bare Claude id needs on the Anthropic route. */
export function databricksModelHeaders(model: string): Record<string, string> | undefined {
  const id = normalizeDatabricksModel(model);
  if (databricksRoute(id) !== "anthropic" || id.startsWith("model_service.")) return undefined;
  return { [DATABRICKS_PROVIDER_SERVICE_HEADER]: DATABRICKS_PROVIDER_SERVICE };
}

/**
 * The other name of `model`, as a fallback list: its partner in
 * {@link DATABRICKS_MODEL_MAP} for Claude, and for an OpenAI model the serving
 * endpoint name for a service id and back (`model_service.models.1adp-gpt-5-5` ↔
 * `databricks-gpt-5-5`). The gateway knows some GPT models under one name only,
 * and may refuse one name to a key it serves the other to.
 */
export function databricksModelFallbacks(model: string): string[] | undefined {
  const id = normalizeDatabricksModel(model);
  const mapped = DATABRICKS_MODEL_MAP[id] ?? Object.keys(DATABRICKS_MODEL_MAP).find((k) => DATABRICKS_MODEL_MAP[k] === id);
  if (mapped) return [mapped];
  const other = otherOpenAiName(id);
  return other ? [other] : undefined;
}

/** `model_service.models.1adp-<name>` ↔ `databricks-<name>` for an OpenAI model, else undefined. */
function otherOpenAiName(id: string): string | undefined {
  if (databricksRoute(id) !== "openai") return undefined;
  const lower = id.toLowerCase();
  if (lower.startsWith(DATABRICKS_SERVICE_PREFIX)) return DATABRICKS_SERVING_PREFIX + id.slice(DATABRICKS_SERVICE_PREFIX.length);
  if (lower.startsWith(DATABRICKS_SERVING_PREFIX)) return DATABRICKS_SERVICE_PREFIX + id.slice(DATABRICKS_SERVING_PREFIX.length);
  return undefined;
}

const LIST_TIMEOUT_MS = 10_000;
const NON_CHAT_RE = /embed|tts|whisper|dall-e|image|moderation|audio|transcri|rerank|speech|realtime/i;

export interface DatabricksListing {
  route: DatabricksRoute;
  url: string;
  /** Chat models this route lists (empty when the listing failed). */
  ids: string[];
  error?: unknown;
}

export type DatabricksLister = (route: DatabricksRoute, url: string, apiKey: string) => Promise<string[]>;

interface ServingEndpoint {
  name?: string;
  task?: string;
  state?: { ready?: string };
  permission_level?: string;
  ai_gateway?: { rate_limits?: { calls?: number; tokens?: number; key?: string }[] };
}

/** A rate limit of 0 that applies to everyone (`endpoint`) or to each user (`user`): every call is refused. */
function isBlocked(e: ServingEndpoint): boolean {
  return (e.ai_gateway?.rate_limits ?? []).some((r) => (r.key === "endpoint" || r.key === "user") && (r.calls === 0 || r.tokens === 0));
}

/** Endpoint records read (or models probed) at once: a workspace lists dozens, and a burst of them is answered with 429. */
const RECORD_CONCURRENCY = 4;
const LIST_ATTEMPTS = 4;

/**
 * `fetchImpl(url, init)`, retrying a network error, a 429 or a 5xx with exponential backoff.
 * Returns the first other response, or the last one once the attempts run out; a network
 * error on the last attempt is thrown.
 */
async function fetchRetrying(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  retryDelayMs: number,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    } catch (err) {
      if (attempt >= LIST_ATTEMPTS) throw err;
    }
    if (res && ((res.status !== 429 && res.status < 500) || attempt >= LIST_ATTEMPTS)) return res;
    await res?.body?.cancel();
    await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** (attempt - 1)));
  }
}

/** A JSON GET with {@link fetchRetrying}; a final non-2xx is thrown with its status. */
async function getJson(fetchImpl: typeof fetch, url: string, apiKey: string, retryDelayMs: number): Promise<unknown> {
  const res = await fetchRetrying(fetchImpl, url, { headers: { Authorization: `Bearer ${apiKey}` } }, retryDelayMs);
  if (res.ok) return res.json();
  throw Object.assign(new Error(`${res.status} ${(await res.text()).slice(0, 300)}`), { status: res.status });
}

/** Runs `fn` over `items`, at most {@link RECORD_CONCURRENCY} at once, keeping the input order. */
async function mapLimited<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RECORD_CONCURRENCY, items.length) }, worker));
  return out;
}

/** The ready chat endpoints in `GET /api/2.0/serving-endpoints` (errors propagate: they say whether the key works). */
async function listChatEndpoints(base: string, apiKey: string, fetchImpl: typeof fetch, retryDelayMs: number): Promise<ServingEndpoint[]> {
  const listed = ((await getJson(fetchImpl, base, apiKey, retryDelayMs)) as { endpoints?: ServingEndpoint[] }).endpoints ?? [];
  return listed.filter((e) => e.name && e.task === "llm/v1/chat" && (e.state?.ready ?? "READY") === "READY");
}

/**
 * The chat serving endpoints of the workspace this key may query: `GET /api/2.0/serving-endpoints`,
 * keeping ready `llm/v1/chat` endpoints the `serving` route is used for (not `databricks-gpt-*`, which
 * {@link listOpenAiGatewayModels} covers), then dropping those whose AI Gateway rate limit is 0. The
 * list omits rate limits, so each candidate's own record is read, a few at a time, retrying a 429 or
 * 5xx. One that still cannot be read is dropped: it may well be blocked, and offering (or
 * recommending) a model whose every call is refused is worse than leaving it out.
 */
export async function listServingEndpoints(
  root: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  retryDelayMs = 300,
): Promise<string[]> {
  const base = `${root.replace(/\/+$/, "")}/api/2.0/serving-endpoints`;
  const chat = (await listChatEndpoints(base, apiKey, fetchImpl, retryDelayMs)).filter(
    (e) => e.permission_level !== "CAN_VIEW" && databricksRoute(e.name!) === "serving",
  );
  const usable = await mapLimited(chat, async (e) => {
    try {
      return isBlocked((await getJson(fetchImpl, `${base}/${encodeURIComponent(e.name!)}`, apiKey, retryDelayMs)) as ServingEndpoint)
        ? undefined
        : e.name!;
    } catch {
      return undefined;
    }
  });
  return usable.filter((n): n is string => n !== undefined);
}

/** A 400 that still means the model cannot be used through Chat Completions. */
const PROBE_UNUSABLE_RE = /does not exist|not supported|only supports|not found|rate limit/i;

/**
 * Whether the `openai` route answers `model` through Chat Completions, asked for free: a request with
 * no messages is refused before any token is spent, with a 400 about the messages when the model is
 * there, and a 404 "does not exist", a 403 "rate limit is set to 0" or a 400 "only supports the
 * Responses API" when it cannot be used. A 429 or 5xx is retried; one that persists counts as unusable.
 */
async function probeOpenAiModel(url: string, apiKey: string, model: string, fetchImpl: typeof fetch, retryDelayMs: number): Promise<boolean> {
  let res: Response;
  try {
    res = await fetchRetrying(
      fetchImpl,
      `${url}/chat/completions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...databricksHeaders() },
        body: JSON.stringify({ model, messages: [] }),
      },
      retryDelayMs,
    );
  } catch {
    return false;
  }
  if (res.ok) {
    await res.body?.cancel();
    return true;
  }
  const text = res.status === 400 ? await res.text().catch(() => "") : (await res.body?.cancel(), "");
  return res.status === 400 && !PROBE_UNUSABLE_RE.test(text);
}

/**
 * The models the `openai` route serves this key. The route has no working `GET /models` (it answers
 * "unmanaged api request"), so the GPT endpoints in the workspace's serving registry are the
 * candidates, together with {@link DATABRICKS_KNOWN_MODELS}. Each is asked for by its service id
 * (`model_service.models.1adp-<name>`) and, when the gateway does not serve that, by its endpoint name
 * (`databricks-<name>`), with a zero-token request ({@link probeOpenAiModel}). The registry's errors
 * propagate, so a rejected key is still reported as one; when no candidate answers, nothing is listed.
 */
export async function listOpenAiGatewayModels(
  root: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  retryDelayMs = 300,
): Promise<string[]> {
  const trimmed = root.replace(/\/+$/, "");
  const chat = await listChatEndpoints(`${trimmed}/api/2.0/serving-endpoints`, apiKey, fetchImpl, retryDelayMs);
  const names = new Set<string>();
  for (const id of [...chat.map((e) => e.name!), ...DATABRICKS_KNOWN_MODELS.openai]) {
    const lower = id.toLowerCase();
    if (databricksRoute(lower) !== "openai") continue;
    if (lower.startsWith(DATABRICKS_SERVING_PREFIX)) names.add(lower.slice(DATABRICKS_SERVING_PREFIX.length));
    else if (lower.startsWith(DATABRICKS_SERVICE_PREFIX)) names.add(lower.slice(DATABRICKS_SERVICE_PREFIX.length));
  }
  const url = databricksRouteUrl(trimmed, "openai");
  const found = await mapLimited([...names], async (name) => {
    for (const id of [DATABRICKS_SERVICE_PREFIX + name, DATABRICKS_SERVING_PREFIX + name]) {
      if (await probeOpenAiModel(url, apiKey, id, fetchImpl, retryDelayMs)) return id;
    }
    return undefined;
  });
  return found.filter((id): id is string => id !== undefined);
}

const defaultLister: DatabricksLister = async (route, url, apiKey) => {
  const headers = databricksHeaders();
  if (route === "serving") return listServingEndpoints(url.slice(0, -ROUTE_PATH.serving.length), apiKey);
  if (route === "openai") return listOpenAiGatewayModels(url.slice(0, -ROUTE_PATH.openai.length), apiKey);
  if (route === "anthropic") {
    // The Anthropic route lists its models only when told which provider service to ask.
    const client = new Anthropic({
      apiKey: null,
      authToken: apiKey,
      baseURL: url,
      defaultHeaders: { ...headers, [DATABRICKS_PROVIDER_SERVICE_HEADER]: DATABRICKS_PROVIDER_SERVICE },
      maxRetries: 0,
      timeout: LIST_TIMEOUT_MS,
    });
    const page = await client.models.list({ limit: 1000 });
    return page.data.map((m) => m.id);
  }
  const client = new OpenAI({ apiKey, baseURL: url, defaultHeaders: headers, maxRetries: 0, timeout: LIST_TIMEOUT_MS, fetch: errorEnvelopeFetch() });
  const page = await client.models.list();
  return page.data.map((m) => m.id);
};

/**
 * `GET /models` on every gateway route, in parallel. A route keeps only the chat
 * models it would actually be sent to (a route that lists everything does not
 * duplicate another's models).
 */
export async function listDatabricksModels(
  root: string,
  apiKey: string,
  lister: DatabricksLister = defaultLister,
): Promise<DatabricksListing[]> {
  return Promise.all(
    DATABRICKS_ROUTES.map(async (route): Promise<DatabricksListing> => {
      const url = databricksRouteUrl(root, route);
      try {
        const listed = await lister(route, url, apiKey);
        const ids = [...new Set(listed.filter((id) => id && !NON_CHAT_RE.test(id) && databricksRoute(id) === route))];
        return { route, url, ids };
      } catch (error) {
        return { route, url, ids: [], error };
      }
    }),
  );
}
