/**
 * `graft build --deep` against the Databricks AI Gateway: make sure an API key
 * the gateway accepts is set, then use the model already set (GRAFT_MODEL, or the
 * default) when the gateway serves it. Only when it does not is the user asked
 * which model to use, from the models its Anthropic, OpenAI and MLflow (Qwen, …)
 * routes and the workspace's `databricks-*` serving endpoints serve.
 *
 * Only the Databricks gateway URL goes through here; every other endpoint keeps
 * the plain `GRAFT_MODEL` / `--model` behaviour.
 */
import { resolveConfig, type EngineConfig } from "./providers.js";
import { rankModelsForHint, settingSource, shortError, suggestModel, isTopTierModel } from "./llm-hints.js";
import { PromptCancelled, maskSecret, type Prompter, type UserEnvStore } from "./llm-settings.js";
import {
  DATABRICKS_KNOWN_MODELS,
  DATABRICKS_ROUTE_LABEL,
  databricksModelFallbacks,
  databricksRoute,
  databricksRouteUrl,
  databricksTokenHint,
  listDatabricksModels,
  normalizeDatabricksModel,
  type DatabricksLister,
  type DatabricksListing,
  type DatabricksRoute,
} from "./llm/databricks.js";

export interface DeepModelDeps {
  /** The config from the global CLI flags. */
  config: EngineConfig;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Absent when stdin/stdout is not a terminal: nothing is asked. */
  prompt?: Prompter;
  /** Where a newly typed key or picked model can be saved for future builds. */
  store?: UserEnvStore;
  /** Overrides the live `GET /models` calls (tests). */
  lister?: DatabricksLister;
}

export type DeepModelChoice =
  /** The config the build should use (possibly with the typed key and picked model). */
  | { config: EngineConfig }
  /** Run the structural build only, for this reason. */
  | { skip: string }
  | { cancelled: true };

const MAX_KEY_ATTEMPTS = 3;

/** 401, or a message that says the credential itself is wrong. A 403 may only forbid the listing. */
function isRejectedKey(err: unknown): boolean {
  if ((err as { status?: unknown })?.status === 401) return true;
  return /credential was not sent|unsupported type|invalid (access )?token|invalid api key|unauthori[sz]ed/i.test(shortError(err));
}

/**
 * Interactive (or announced, when not on a terminal) model choice for a deep
 * build on the Databricks gateway. Returns the config untouched for any other
 * endpoint, and when `--model` was given on the command line.
 */
export async function chooseDatabricksDeepModel(deps: DeepModelDeps): Promise<DeepModelChoice> {
  const cfg = resolveConfig(deps.config, deps.env);
  if (!cfg.databricks) return { config: deps.config };
  const { root } = cfg.databricks;

  if (deps.config.model) return { config: deps.config };
  if (!deps.prompt) {
    if (cfg.apiKey) {
      deps.err(
        `ℹ Databricks AI Gateway: using ${cfg.model} at ${cfg.baseUrl} — set GRAFT_MODEL (\`graft model\`) or run in a terminal to pick another.`,
      );
    }
    return { config: deps.config };
  }

  try {
    return await interactive(deps, root);
  } catch (err) {
    if (err instanceof PromptCancelled) return { cancelled: true };
    throw err;
  }
}

async function interactive(deps: DeepModelDeps, root: string): Promise<DeepModelChoice> {
  const prompt = deps.prompt!;
  const cfg = resolveConfig(deps.config, deps.env);
  let apiKey = cfg.apiKey;
  let typedKey = false;
  let listings: DatabricksListing[] | undefined;

  deps.out(`graft build --deep uses the Databricks AI Gateway (${root}).`);
  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS && !listings; attempt++) {
    if (!apiKey) {
      deps.out("It needs a Databricks personal access token (GRAFT_API_KEY or ANTHROPIC_AUTH_TOKEN).");
      deps.out(`${databricksTokenHint()}.`);
      const v = (await prompt.askHidden("Databricks personal access token (input hidden; Enter skips the LLM pass): ")).trim();
      if (!v) return { skip: "no API key for the Databricks AI Gateway" };
      apiKey = v;
      typedKey = true;
    }
    deps.out("Checking the API key and asking the gateway which models it serves…");
    const found = await listDatabricksModels(root, apiKey, deps.lister);
    const rejected = found.every((l) => l.ids.length === 0 && l.error !== undefined && isRejectedKey(l.error));
    if (!rejected) {
      listings = found;
      break;
    }
    const src = settingSource("key", deps.config, cfg, deps.env);
    const s = typedKey ? "the key you typed" : `${maskSecret(apiKey)} (from ${src.flag ?? src.env ?? "the environment"})`;
    deps.err(`⚠ the Databricks AI Gateway rejected ${s}: ${shortError(found[0]!.error)}`);
    deps.err("  It needs a Databricks personal access token (it usually starts with `dapi`), not another gateway's key.");
    deps.err(`  ${databricksTokenHint()}.`);
    apiKey = undefined;
    typedKey = false;
  }
  if (!listings || !apiKey) return { skip: "the Databricks AI Gateway rejected the API key" };

  if (typedKey && deps.store && (await yes(prompt, `Save this token as GRAFT_API_KEY in ${deps.store.where} for future builds? [y/N] `))) {
    deps.store.write("GRAFT_API_KEY", apiKey);
    deps.out("✓ saved GRAFT_API_KEY.");
  }

  const current = cfg.model;
  const src = settingSource("model", deps.config, cfg, deps.env);
  const from = src.env ?? "graft's default";
  const verdict = currentModelVerdict(current, listings, src.env !== undefined);
  if (verdict.usable) {
    // The model already set (GRAFT_MODEL, or the default) is one the gateway serves
    // for this key: use it, as every build after the first wants, without asking.
    deps.out(`→ ${current} (from ${from}) via ${databricksRouteUrl(root, databricksRoute(current))} — \`graft model\` picks another.`);
    return { config: { ...deps.config, model: current, ...(typedKey ? { apiKey } : {}) } };
  }
  deps.err(`⚠ ${current} (from ${from}) ${verdict.why}.`);

  const groups = listings.map((l) => groupFor(l));
  const all = groups.flatMap((g) => g.ids);
  const recommended = suggestModel(rankModelsForHint(all));

  deps.out("");
  deps.out("Which model should `graft build --deep` use?");
  let n = 0;
  for (const g of groups) {
    deps.out(`  ${DATABRICKS_ROUTE_LABEL[g.route]} — ${databricksRouteUrl(root, g.route)}`);
    if (g.note) deps.out(`    ${g.note}`);
    for (const id of g.ids) {
      n++;
      const tags = [id === current ? "current" : "", id === recommended ? "recommended" : "", isTopTierModel(id) ? "top tier — not needed" : ""].filter(Boolean);
      deps.out(`    ${String(n).padStart(3)}. ${id}${tags.length ? `  (${tags.join(", ")})` : ""}`);
    }
  }
  deps.out("A top-tier model is not necessary: summaries work well with a mid-tier one, which is cheaper and faster.");

  const answer = (await prompt.ask(`Pick a number or type a model id; Enter uses ${current}: `)).trim();
  const picked = Number(answer);
  const model = !answer
    ? current
    : Number.isInteger(picked) && picked >= 1 && picked <= all.length
      ? all[picked - 1]!
      : normalizeDatabricksModel(answer);
  deps.out(`→ ${model} via ${databricksRouteUrl(root, databricksRoute(model))}`);

  let saved: string | undefined;
  try {
    saved = deps.store?.read("GRAFT_MODEL");
  } catch {
    saved = undefined;
  }
  if (deps.store && model !== saved && (await yes(prompt, `Save ${model} as GRAFT_MODEL in ${deps.store.where} for future builds? [y/N] `))) {
    deps.store.write("GRAFT_MODEL", model);
    deps.out("✓ saved GRAFT_MODEL.");
  }

  return { config: { ...deps.config, model, ...(typedKey ? { apiKey } : {}) } };
}

/**
 * Whether the model already set can be used without asking. Where its route listed
 * models, it has to be among them (under either of its names, see
 * {@link databricksModelFallbacks}). Where the route lists nothing — some routes
 * refuse `GET /models` while serving chat — there is nothing to check it against, so
 * a model the user chose (`explicit`: GRAFT_MODEL) is trusted, and the default only
 * when it is one of the route's known ids.
 */
export function currentModelVerdict(
  model: string,
  listings: DatabricksListing[],
  explicit: boolean,
): { usable: true } | { usable: false; why: string } {
  const route = databricksRoute(model);
  const listing = listings.find((l) => l.route === route);
  const names = [normalizeDatabricksModel(model), ...(databricksModelFallbacks(model) ?? [])];
  if (listing && listing.ids.length > 0) {
    return names.some((n) => listing.ids.includes(n))
      ? { usable: true }
      : { usable: false, why: `is not among the models the gateway's ${DATABRICKS_ROUTE_LABEL[route]} route serves for this key` };
  }
  if (explicit || names.some((n) => DATABRICKS_KNOWN_MODELS[route].includes(n))) return { usable: true };
  return { usable: false, why: `could not be checked: the gateway's ${DATABRICKS_ROUTE_LABEL[route]} route lists no models` };
}

function groupFor(l: DatabricksListing): { route: DatabricksRoute; ids: string[]; note?: string } {
  if (l.ids.length > 0) return { route: l.route, ids: rankModelsForHint(l.ids) };
  const message = l.error !== undefined ? shortError(l.error) : "";
  const why =
    l.error === undefined
      ? "listed no models"
      : /unmanaged api request|doesn't match any known api type/i.test(message)
        ? "this route does not list its models"
        : `could not list its models (${message})`;
  const known = [...DATABRICKS_KNOWN_MODELS[l.route]];
  return { route: l.route, ids: known, note: known.length ? `${why}; known model ids for it:` : `${why}.` };
}

async function yes(prompt: Prompter, question: string): Promise<boolean> {
  return /^y(es)?$/i.test((await prompt.ask(question)).trim());
}
