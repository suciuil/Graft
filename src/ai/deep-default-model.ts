/**
 * The model `graft build --deep` uses when none is configured (no `--model`, and
 * GRAFT_MODEL unset): the latest Claude Haiku the endpoint serves, found in its
 * model listing. Haiku is small and fast, which is all summaries need, and an
 * endpoint gains a newer Haiku sooner than graft's built-in default changes.
 * When the endpoint lists no Haiku, or will not list its models at all, graft's
 * built-in default (`DEFAULT_MODEL` in src/ai/providers.ts) stays.
 *
 * The listing asks only the endpoint the user configured, with the key every
 * LLM call of the build sends to it anyway; nothing else is contacted. A listing
 * the auth check before it already made (src/ai/llm-auth.ts) is reused.
 */
import { resolveConfig, type EngineConfig, type ResolvedConfig } from "./providers.js";
import { defaultBaseUrl, isClaudeHaiku, latestModel, listEndpointModels } from "./llm-hints.js";
import {
  databricksRoute,
  databricksRouteUrl,
  listDatabricksRoute,
  type DatabricksLister,
  type DatabricksListing,
} from "./llm/databricks.js";

/**
 * The newest Claude Haiku among `ids`, by version number (a release date or a
 * Bedrock-style `-v1:0` suffix does not count); on a tie the plainest id. Undefined
 * when there is none.
 */
export function latestHaiku(ids: readonly string[]): string | undefined {
  return latestModel(ids.filter(isClaudeHaiku));
}

export interface DeepDefaultDeps {
  /** The config from the global CLI flags. */
  config: EngineConfig;
  env: NodeJS.ProcessEnv;
  /** Model ids the auth check already listed: not listed again. */
  ids?: string[];
  /** Databricks listings the auth check already made: not listed again. */
  listings?: DatabricksListing[];
  /** The auth check already tried to list the models and got none: not asked again. */
  listingFailed?: boolean;
  /** Overrides the live `GET /models` (tests). */
  listModels?: (cfg: ResolvedConfig) => Promise<string[]>;
  /** Overrides the live Databricks listing (tests). */
  databricksLister?: DatabricksLister;
}

export interface DeepDefault {
  /** The latest Claude Haiku the endpoint serves. */
  model: string;
  /** The endpoint (for Databricks, the gateway route) that listed it, for display. */
  endpoint: string;
}

/**
 * The latest Claude Haiku the configured endpoint serves, for a deep build that
 * has no model configured. Undefined when a model is configured, no API key is
 * set, or the endpoint lists no Haiku or no models at all: graft's built-in
 * default applies then. Never throws.
 */
export async function detectDeepDefaultModel(deps: DeepDefaultDeps): Promise<DeepDefault | undefined> {
  const cfg = resolveConfig(deps.config, deps.env);
  if (!cfg.modelDefaulted || !cfg.apiKey) return undefined;
  let ids: string[];
  try {
    ids = await endpointIds(deps, cfg);
  } catch {
    return undefined;
  }
  const model = latestHaiku(ids);
  if (!model) return undefined;
  const endpoint = cfg.databricks
    ? databricksRouteUrl(cfg.databricks.root, databricksRoute(model))
    : (cfg.baseUrl ?? defaultBaseUrl(cfg.provider));
  return { model, endpoint };
}

async function endpointIds(deps: DeepDefaultDeps, cfg: ResolvedConfig): Promise<string[]> {
  if (deps.listings) return deps.listings.flatMap((l) => l.ids);
  if (deps.ids) return deps.ids;
  if (deps.listingFailed) return [];
  if (cfg.databricks) {
    // Claude Haiku is served on the gateway's Anthropic route: no need to ask every route.
    return (await listDatabricksRoute(cfg.databricks.root, cfg.apiKey!, "anthropic", deps.databricksLister)).ids;
  }
  return (deps.listModels ?? listEndpointModels)(cfg);
}
