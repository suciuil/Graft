/**
 * The Databricks AI Gateway: graft's default LLM endpoint.
 *
 * One workspace host serves several wire formats under different paths, and the
 * model id decides which one a request takes:
 *   - Claude models:  <host>/ai-gateway/anthropic   (Anthropic Messages API)
 *   - OpenAI models:  <host>/ai-gateway/openai/v1   (OpenAI-compatible)
 *   - Qwen and other open models: <host>/ai-gateway/mlflow/v1 (OpenAI-compatible)
 *   - `databricks-*` serving endpoints (GPT, Claude, Gemini, Qwen, Llama, …):
 *     <host>/serving-endpoints (OpenAI-compatible; the endpoint name is the model id)
 *
 * Every route authenticates with a Databricks personal access token as
 * `Authorization: Bearer` and carries the `Databricks-Ai-Gateway-Request-Tags`
 * header. A bare Claude id (`claude-sonnet-5-5`) also needs the
 * `Databricks-Model-Provider-Service` header; a `model_service.models.1adp-*` id
 * names the service itself and does not.
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
  serving: "Workspace serving endpoints (GPT, Claude, Gemini, Qwen, Llama, …)",
};

/** Serving-endpoint names are prefixed with this; such an id always takes the `serving` route. */
export const DATABRICKS_SERVING_PREFIX = "databricks-";

export const DATABRICKS_TAGS_HEADER = "Databricks-Ai-Gateway-Request-Tags";
export const DATABRICKS_TAGS = '{"registry_id": "personal"}';
export const DATABRICKS_PROVIDER_SERVICE_HEADER = "Databricks-Model-Provider-Service";
export const DATABRICKS_PROVIDER_SERVICE = "model_service.models.gcp-models";

/** Used when GRAFT_MODEL is unset: mid-tier, which is all summaries need. */
export const DATABRICKS_DEFAULT_MODEL = "claude-sonnet-5-5";

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
  if (id.startsWith(DATABRICKS_SERVING_PREFIX)) return "serving";
  if (/claude|opus|sonnet|haiku/.test(id)) return "anthropic";
  if (/gpt|codex|(^|[-./_])o\d/.test(id)) return "openai";
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

/** The other name of `model` in {@link DATABRICKS_MODEL_MAP}, as a fallback list. */
export function databricksModelFallbacks(model: string): string[] | undefined {
  const id = normalizeDatabricksModel(model);
  const mapped = DATABRICKS_MODEL_MAP[id] ?? Object.keys(DATABRICKS_MODEL_MAP).find((k) => DATABRICKS_MODEL_MAP[k] === id);
  return mapped ? [mapped] : undefined;
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

/** Endpoint records read at once: a workspace lists dozens, and a burst of them is answered with 429. */
const RECORD_CONCURRENCY = 4;
const LIST_ATTEMPTS = 4;

/**
 * The chat serving endpoints of the workspace this key may query: `GET /api/2.0/serving-endpoints`,
 * keeping ready `llm/v1/chat` endpoints, then dropping those whose AI Gateway rate limit is 0. The list
 * omits rate limits, so each candidate's own record is read, a few at a time, retrying a 429 or 5xx.
 * One that still cannot be read is dropped: it may well be blocked, and offering (or recommending) a
 * model whose every call is refused is worse than leaving it out.
 */
export async function listServingEndpoints(
  root: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  retryDelayMs = 300,
): Promise<string[]> {
  const base = `${root.replace(/\/+$/, "")}/api/2.0/serving-endpoints`;
  const get = async (url: string): Promise<unknown> => {
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined;
      try {
        res = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
      } catch (err) {
        if (attempt >= LIST_ATTEMPTS) throw err;
      }
      if (res?.ok) return res.json();
      if (res && ((res.status !== 429 && res.status < 500) || attempt >= LIST_ATTEMPTS)) {
        throw Object.assign(new Error(`${res.status} ${(await res.text()).slice(0, 300)}`), { status: res.status });
      }
      await res?.body?.cancel();
      await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** (attempt - 1)));
    }
  };
  const listed = ((await get(base)) as { endpoints?: ServingEndpoint[] }).endpoints ?? [];
  const chat = listed.filter(
    (e) => e.name && e.task === "llm/v1/chat" && (e.state?.ready ?? "READY") === "READY" && e.permission_level !== "CAN_VIEW",
  );
  const usable: (string | undefined)[] = new Array(chat.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < chat.length) {
      const i = next++;
      const name = chat[i]!.name!;
      try {
        usable[i] = isBlocked((await get(`${base}/${encodeURIComponent(name)}`)) as ServingEndpoint) ? undefined : name;
      } catch {
        usable[i] = undefined;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RECORD_CONCURRENCY, chat.length) }, worker));
  return usable.filter((n): n is string => n !== undefined);
}

const defaultLister: DatabricksLister = async (route, url, apiKey) => {
  const headers = databricksHeaders();
  if (route === "serving") return listServingEndpoints(url.slice(0, -ROUTE_PATH.serving.length), apiKey);
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
