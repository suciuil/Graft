/**
 * Two interactive guards in front of every LLM call graft makes on the user's
 * behalf (`graft build --deep`, `graft api url|key|model`, `graft api provider`):
 *
 *   1. Endpoint choice. GRAFT_PROVIDER (or --provider) can name a provider that has
 *      one fixed endpoint of its own (anthropic → https://api.anthropic.com,
 *      orcarouter → its gateway) while a custom endpoint URL is set as well
 *      (GRAFT_BASE_URL, ANTHROPIC_BASE_URL, --base-url, …). `openai` and `litellm`
 *      only name a wire format, so a custom URL is never a conflict there. Graft never picks one
 *      silently: in a terminal it asks which to use, and remembers the answer for
 *      that provider + URL pair (GRAFT_ENDPOINT_CHOICE) once the endpoint passes its
 *      check, asking again once either changes. Without a terminal it says which
 *      one it uses and how to choose. A Databricks gateway URL is never a conflict:
 *      graft speaks each of its routes' own wire format whatever the provider says.
 *
 *   2. Auth recovery. When the endpoint rejects the key, cannot be reached, or no
 *      key (or no URL) is set, graft asks for both the endpoint URL and the API key
 *      — Enter keeps a value, typing replaces it, `s` skips — then checks again with
 *      the new or kept values, until the check passes or the user skips. Typed
 *      values are saved for new terminals once the endpoint accepts them, or
 *      answers without a verdict on the key (an unknown model, a spent quota); a
 *      skip saves nothing.
 */
import { resolveConfig, type EngineConfig, type ResolvedConfig } from "./providers.js";
import {
  classifyLlmError,
  envSetExample,
  listEndpointModels,
  missingEndpointUrl,
  NO_ENDPOINT_URL,
  providerEndpoint,
  settingSource,
  shortError,
} from "./llm-hints.js";
import {
  ENDPOINT_CHOICE_ENV,
  maskSecret,
  PromptCancelled,
  urlProblem,
  withSavedSettings,
  type Prompter,
  type UserEnvStore,
} from "./llm-settings.js";
import { isRejectedKey } from "./databricks-setup.js";
import { createChatModel, type ProviderKind } from "./llm/factory.js";
import {
  databricksTokenHint,
  isDatabricksGatewayUrl,
  listDatabricksModels,
  listDatabricksRoute,
  type DatabricksLister,
  type DatabricksListing,
} from "./llm/databricks.js";

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

export interface LlmGuardDeps {
  /** The global CLI flags (`--provider`, `--base-url`, `--api-key`, `--model`). */
  config: EngineConfig;
  /** This process's environment; saved settings fill what it lacks. */
  env: NodeJS.ProcessEnv;
  /** Where choices and new values are saved; absent: nothing is saved. */
  store?: UserEnvStore;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Absent when stdin/stdout is not a terminal: nothing is asked. */
  prompt?: Prompter;
  platform?: NodeJS.Platform;
}

/**
 * What the caller applies to its own run: env vars to set and flag values to
 * replace. A value that came from a CLI flag is replaced in `config` (the flag
 * would win over any env var); everything else in `env`.
 */
export interface LlmChanges {
  env: Record<string, string>;
  config: Pick<EngineConfig, "baseUrl" | "apiKey">;
}

const noChanges = (): LlmChanges => ({ env: {}, config: {} });

function mergeChanges(a: LlmChanges, b: LlmChanges): LlmChanges {
  return { env: { ...a.env, ...b.env }, config: { ...a.config, ...b.config } };
}

/** `deps.env` with the saved settings filled in and `changes` applied, and the config with `changes` applied. */
function current(deps: LlmGuardDeps, changes: LlmChanges): { config: EngineConfig; env: NodeJS.ProcessEnv } {
  const base = deps.store ? withSavedSettings(deps.env, deps.store).env : deps.env;
  return { config: { ...deps.config, ...changes.config }, env: { ...base, ...changes.env } };
}

function save(deps: LlmGuardDeps, name: string, value: string | undefined): boolean {
  if (!deps.store) return false;
  try {
    deps.store.write(name, value);
    return true;
  } catch (err) {
    deps.err(`⚠ could not save ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1. Provider endpoint vs custom endpoint
// ---------------------------------------------------------------------------

/** For comparing endpoints: case, trailing slashes and a trailing `/v1` do not make two URLs differ. */
export function sameEndpoint(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/\/+$/, "").replace(/\/v1$/i, "").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export interface EndpointConflict {
  provider: ProviderKind;
  /** `--provider` or `GRAFT_PROVIDER`. */
  providerFrom: string;
  /** The provider's own endpoint. */
  providerUrl: string;
  /** The custom endpoint URL that is set as well. */
  customUrl: string;
  /** `--base-url` or the env var it came from. */
  urlFrom: string;
}

/** The custom endpoint URL in effect, in resolveConfig's order, and where it came from. */
function customUrlOf(config: EngineConfig, env: NodeJS.ProcessEnv): { url: string; from: string } | undefined {
  if (config.baseUrl) return { url: config.baseUrl, from: "--base-url" };
  // A key from the legacy OPENROUTER_/ORCAROUTER_ variables keeps its own routing: resolveConfig ignores ANTHROPIC_BASE_URL then.
  const legacyRouting =
    !(config.apiKey ?? env.GRAFT_API_KEY) && !env.ANTHROPIC_AUTH_TOKEN && !!(env.OPENROUTER_API_KEY ?? env.ORCAROUTER_API_KEY);
  for (const name of ["GRAFT_BASE_URL", "ANTHROPIC_BASE_URL", "OPENROUTER_BASE_URL", "ORCAROUTER_BASE_URL"]) {
    if (name === "ANTHROPIC_BASE_URL" && legacyRouting) continue;
    const v = env[name];
    if (v) return { url: v, from: name };
  }
  return undefined;
}

/**
 * Providers that stand for one service with one endpoint. `openai` and `litellm`
 * name a wire format instead: GRAFT_BASE_URL pointing them at OpenRouter, Groq, a
 * LiteLLM proxy… is how they are meant to be used (README), not a conflict.
 */
const FIXED_ENDPOINT_PROVIDERS: ReadonlySet<string> = new Set<ProviderKind>(["anthropic", "orcarouter"]);

/**
 * Set when a provider with its own fixed endpoint is named explicitly AND a
 * different custom endpoint URL is set: the two say different things about where
 * to send the requests. Never for a Databricks gateway URL: resolveConfig ignores
 * the provider there, so nothing disagrees.
 */
export function endpointConflict(config: EngineConfig, env: NodeJS.ProcessEnv): EndpointConflict | undefined {
  const provider = (config.provider ?? env.GRAFT_PROVIDER) as ProviderKind | undefined;
  if (!provider || !FIXED_ENDPOINT_PROVIDERS.has(provider)) return undefined;
  const providerUrl = providerEndpoint(provider);
  if (!providerUrl) return undefined;
  const custom = customUrlOf(config, env);
  if (!custom || sameEndpoint(custom.url, providerUrl) || isDatabricksGatewayUrl(custom.url)) return undefined;
  return {
    provider,
    providerFrom: config.provider ? "--provider" : "GRAFT_PROVIDER",
    providerUrl,
    customUrl: custom.url,
    urlFrom: custom.from,
  };
}

type EndpointPick = "custom" | "provider";

/** The GRAFT_ENDPOINT_CHOICE value that records `pick` for this provider + URL pair. */
function endpointChoiceValue(c: EndpointConflict, pick: EndpointPick): string {
  return `${c.provider}|${c.customUrl.trim().replace(/\/+$/, "")}|${pick}`;
}

function rememberedPick(c: EndpointConflict, env: NodeJS.ProcessEnv): EndpointPick | undefined {
  const v = env[ENDPOINT_CHOICE_ENV]?.trim();
  if (!v) return undefined;
  const [p, url, k] = v.split("|");
  for (const pick of ["custom", "provider"] as const) {
    const [wp, wurl, wk] = endpointChoiceValue(c, pick).split("|");
    if (p === wp && k === wk && url && wurl && sameEndpoint(url, wurl)) return pick;
  }
  return undefined;
}

/** Point this run at `url`: the flag when the custom URL came from one, else GRAFT_BASE_URL (which wins over every other URL variable). */
function useUrl(c: EndpointConflict, url: string): LlmChanges {
  return c.urlFrom === "--base-url" ? { env: {}, config: { baseUrl: url } } : { env: { GRAFT_BASE_URL: url }, config: {} };
}

export interface EndpointResult {
  /** Points this run at the chosen endpoint. */
  changes: LlmChanges;
  /**
   * Settings that remember a choice just made. Not saved yet: the caller saves
   * them ({@link commitEndpointChoice}) once the endpoint passed its check, so a
   * skip leaves every saved setting as it was.
   */
  saves: Record<string, string>;
}

/** Conflicts already announced in this process (without a terminal): said once, not before every call. */
const announced = new Set<string>();

/**
 * Settle a provider-endpoint vs custom-endpoint conflict: the remembered choice
 * for this pair, else ask (in a terminal), else announce that the custom
 * endpoint is used. `changes` point this run at the chosen endpoint.
 */
export async function resolveEndpointConflict(
  deps: LlmGuardDeps,
  base: LlmChanges = noChanges(),
): Promise<EndpointResult | { cancelled: true }> {
  const { config, env } = current(deps, base);
  const c = endpointConflict(config, env);
  if (!c) return { changes: noChanges(), saves: {} };

  const remembered = rememberedPick(c, env);
  if (remembered) return { changes: useUrl(c, remembered === "custom" ? c.customUrl : c.providerUrl), saves: {} };

  const providerLine = `${c.providerFrom}=${c.provider}`;
  if (!deps.prompt) {
    const key = endpointChoiceValue(c, "custom");
    if (!announced.has(key)) {
      announced.add(key);
      deps.err(
        `⚠ ${providerLine} has its own endpoint (${c.providerUrl}), but a custom endpoint is set too: ${c.customUrl} (from ${c.urlFrom}).`,
      );
      deps.err(
        `  Using the custom endpoint. To choose (and stop this warning), run this command once in a terminal, or set ${ENDPOINT_CHOICE_ENV}=${key} ` +
          `(keep the custom endpoint) or ${ENDPOINT_CHOICE_ENV}=${endpointChoiceValue(c, "provider")} (use ${c.providerUrl}).`,
      );
    }
    return { changes: useUrl(c, c.customUrl), saves: {} };
  }

  deps.out("");
  deps.out("The LLM provider and the endpoint URL point to different endpoints:");
  deps.out(`  provider:         ${c.provider} (from ${c.providerFrom}) — its own endpoint is ${c.providerUrl}`);
  deps.out(`  custom endpoint:  ${c.customUrl} (from ${c.urlFrom})`);
  deps.out("Which endpoint should graft use?");
  deps.out(`  1. ${c.customUrl}  (the custom endpoint, spoken to in the ${c.provider} wire format)`);
  deps.out(`  2. ${c.providerUrl}  (the ${c.provider} provider's own endpoint)`);
  let pick: EndpointPick | undefined;
  while (!pick) {
    let answer: string;
    try {
      answer = (await deps.prompt.ask("Pick 1 or 2 (Enter = 1): ")).trim();
    } catch (err) {
      if (err instanceof PromptCancelled) return { cancelled: true };
      throw err;
    }
    if (answer === "" || answer === "1") pick = "custom";
    else if (answer === "2") pick = "provider";
    else deps.err(`✗ "${answer}" is not 1 or 2.`);
  }

  const url = pick === "custom" ? c.customUrl : c.providerUrl;
  const saves: Record<string, string> = { [ENDPOINT_CHOICE_ENV]: endpointChoiceValue(c, pick) };
  // The provider's endpoint replaces the saved custom one, so every graft (and the installer) agrees on it.
  if (pick === "provider" && c.urlFrom !== "--base-url") saves.GRAFT_BASE_URL = url;
  deps.out(`✓ graft uses ${url}.`);
  if (pick === "provider" && c.urlFrom !== "--base-url" && c.urlFrom !== "GRAFT_BASE_URL") {
    deps.out(`  (${c.urlFrom} is still set; GRAFT_BASE_URL = ${url} takes precedence over it.)`);
  }
  return { changes: useUrl(c, url), saves };
}

/** Save the settings {@link resolveEndpointConflict} returned, once the chosen endpoint passed its check. */
export function commitEndpointChoice(deps: LlmGuardDeps, saves: Record<string, string>): void {
  if (!deps.store) return;
  let savedChoice = false;
  for (const [name, value] of Object.entries(saves)) {
    if (save(deps, name, value) && name === ENDPOINT_CHOICE_ENV) savedChoice = true;
  }
  if (savedChoice) {
    deps.out(`✓ saved the endpoint choice to ${deps.store.where} — asked again only when the provider or the endpoint URL changes.`);
  }
}

// ---------------------------------------------------------------------------
// 2. Auth check and recovery
// ---------------------------------------------------------------------------

/**
 * ok: the endpoint accepted the key. rejected: it refused the key. unreachable:
 * no answer at that URL. missing: no key at all. no-url: no endpoint URL, and
 * the provider has none of its own. unknown: it answered, but with something no
 * URL or key fixes (an unknown model, a spent quota) — not an auth failure, so
 * nothing is asked.
 */
export type AuthStatus = "ok" | "rejected" | "unreachable" | "missing" | "no-url" | "unknown";

export interface AuthCheck {
  status: AuthStatus;
  message?: string;
  /** The model ids the endpoint listed, when the check listed them. */
  ids?: string[];
  /** Databricks, every route checked: the per-route listings, reusable by the model choice. */
  listings?: DatabricksListing[];
}

export interface AuthProbes {
  /** `GET /models` (tests inject a stub). */
  listModels?: (cfg: ResolvedConfig) => Promise<string[]>;
  /** One tiny chat request (tests inject a stub). */
  chat?: (cfg: ResolvedConfig) => Promise<void>;
  /** The per-route `GET /models` on the Databricks gateway (tests inject a stub). */
  databricksLister?: DatabricksLister;
}

export interface AuthCheckOptions {
  /**
   * Databricks: list every gateway route (the caller reuses the listings for its
   * model choice). Otherwise only the route of the configured model is asked —
   * one request instead of several.
   */
  allRoutes?: boolean;
  /** The caller's own `GET /models` already failed with this: it is not repeated. */
  listingError?: unknown;
}

const PROBE_MAX_TOKENS = 64;
/** The chat probe is one question, not a build: no retries, and a short wait. */
const PROBE_TIMEOUT_MS = 20_000;

async function chatProbe(cfg: ResolvedConfig): Promise<void> {
  await createChatModel({
    provider: cfg.provider,
    apiKey: cfg.apiKey ?? "",
    model: cfg.model,
    // The model's other spellings and the second wire format stay: without them a
    // gateway the build reaches fine could look like it refused the key.
    modelFallbacks: cfg.modelFallbacks,
    baseUrl: cfg.baseUrl,
    headers: cfg.headers,
    modelHeaders: cfg.modelHeaders,
    providerFallback: cfg.providerFallback,
    bearerAuth: cfg.bearerAuth,
    maxRetries: 0,
    timeoutMs: PROBE_TIMEOUT_MS,
  }).create({ messages: [{ role: "user", content: "Reply with OK." }], maxTokens: PROBE_MAX_TOKENS });
}

/** A refusal of the credential itself (not of a model, a quota or a balance). */
function isAuthFailure(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  const message = shortError(err);
  if (status === 401) return true;
  if (status === 403 && !/balance|quota|credit|rate.?limit/i.test(message)) return true;
  return classifyLlmError(message) === "auth";
}

const ROUTE_NOT_FOUND_RE = /(^|: )40[45]\b/;
/** The host answered, or was only slow: an HTML / non-JSON listing or a timeout says nothing about chat. */
const LISTING_ONLY_RE = /unexpected token|is not valid json/i;
const TIMEOUT_RE = /timed out|ETIMEDOUT/i;

/** Before any request: a missing URL (nothing to ask) or a missing key (nothing to send). */
function precheck(cfg: ResolvedConfig): AuthCheck | undefined {
  const noUrl = missingEndpointUrl(cfg);
  if (noUrl) return { status: "no-url", message: noUrl };
  if (!cfg.apiKey) return { status: "missing" };
  return undefined;
}

/**
 * Does the configured endpoint accept the configured key? One `GET /models`;
 * when that does not list (many gateways do not, or answer slowly or with HTML),
 * one tiny chat request decides, unless the host could not be reached at all.
 * Never throws.
 */
export async function checkLlmAuth(cfg: ResolvedConfig, probes: AuthProbes = {}, opts: AuthCheckOptions = {}): Promise<AuthCheck> {
  const early = precheck(cfg);
  if (early) return early;
  const apiKey = cfg.apiKey!;
  if (cfg.databricks) {
    const { root, route } = cfg.databricks;
    // The caller's own listing of every route just found nothing: judge by its error instead of asking again.
    if (!opts.allRoutes && opts.listingError !== undefined) return databricksVerdict([opts.listingError], 1, {});
    const listings = opts.allRoutes
      ? await listDatabricksModels(root, apiKey, probes.databricksLister)
      : [await listDatabricksRoute(root, apiKey, route, probes.databricksLister)];
    const kept = opts.allRoutes ? { listings } : {};
    const ids = listings.flatMap((l) => l.ids);
    if (ids.length > 0) return { status: "ok", ids, ...kept };
    const errors = listings.map((l) => l.error).filter((e) => e !== undefined);
    return databricksVerdict(errors, listings.length, kept);
  }
  let listingError = opts.listingError;
  if (listingError === undefined) {
    try {
      const ids = await (probes.listModels ?? listEndpointModels)(cfg);
      return { status: "ok", ids };
    } catch (err) {
      listingError = err;
    }
  }
  const listed = shortError(listingError);
  // Nothing answered at all (no such host, connection refused): a chat request to it would fail the same way.
  // A slow or non-JSON listing does not count: many gateways serve chat fine without a usable /models.
  const noHost = classifyLlmError(listed) === "unreachable" && ![ROUTE_NOT_FOUND_RE, LISTING_ONLY_RE, TIMEOUT_RE].some((re) => re.test(listed));
  if (noHost) return { status: "unreachable", message: listed };
  try {
    await (probes.chat ?? chatProbe)(cfg);
    return { status: "ok" };
  } catch (err) {
    const message = shortError(err);
    if (isAuthFailure(err)) return { status: "rejected", message };
    // A probe cut off by its own short timeout: the build, with its retries and longer timeout, may still get through.
    if (TIMEOUT_RE.test(message)) return { status: "unknown", message };
    if (classifyLlmError(message) === "unreachable") return { status: "unreachable", message };
    return { status: "unknown", message };
  }
}

/** The verdict on a Databricks key from the errors of the `asked` route listings, none of which listed a model. */
function databricksVerdict(errors: unknown[], asked: number, kept: { listings?: DatabricksListing[] }): AuthCheck {
  const message = errors.length ? shortError(errors[0]) : "the gateway listed no models";
  if (errors.length === asked && errors.every(isRejectedKey)) return { status: "rejected", message, ...kept };
  if (errors.length === asked && errors.every((e) => classifyLlmError(shortError(e)) === "unreachable")) {
    return { status: "unreachable", message, ...kept };
  }
  // Some routes refuse the listing while serving chat: not a verdict on the key.
  return { status: "unknown", message, ...kept };
}

/** True for a check that a different URL or key could fix. */
function authFailed(check: AuthCheck): boolean {
  return check.status !== "ok" && check.status !== "unknown";
}

export interface AuthRecoveryDeps extends LlmGuardDeps {
  /** Replaces {@link checkLlmAuth} (tests). */
  check?: (cfg: ResolvedConfig, opts: AuthCheckOptions) => Promise<AuthCheck>;
  probes?: AuthProbes;
  /** Databricks: check every gateway route, for a model choice that reuses the listings (see {@link AuthCheckOptions}). */
  allRoutes?: boolean;
}

export type AuthRecovery =
  /** The endpoint accepts the key (possibly new values: apply `changes`). */
  | { status: "ok"; changes: LlmChanges; ids?: string[]; listings?: DatabricksListing[] }
  /** Could not tell (see {@link AuthStatus} "unknown"); go on with `changes`. */
  | { status: "unverified"; changes: LlmChanges; message?: string; listings?: DatabricksListing[] }
  /** Auth failed and nothing was asked (no terminal): the failure was reported. */
  | { status: "failed"; changes: LlmChanges; check: AuthCheck }
  /** The user skipped: the current values stay, the LLM step does not run. */
  | { status: "skipped"; reason: string }
  | { status: "cancelled" };

/** Where requests go: the Databricks workspace (not one of its routes), else the base URL, else the provider's own endpoint. */
function endpointOf(cfg: ResolvedConfig): string | undefined {
  return cfg.databricks?.root ?? cfg.baseUrl ?? providerEndpoint(cfg.provider);
}

/** The endpoint as the user knows it. */
function shownUrl(cfg: ResolvedConfig): string {
  return endpointOf(cfg) ?? NO_ENDPOINT_URL;
}

function describeFailure(check: AuthCheck, cfg: ResolvedConfig, keyFrom: string): string {
  const url = shownUrl(cfg);
  if (check.status === "no-url") return check.message ?? "no endpoint URL is set";
  if (check.status === "missing") return `no API key is set for the LLM endpoint ${url}`;
  if (check.status === "unreachable") return `the LLM endpoint ${url} could not be reached (${check.message})`;
  return `the LLM endpoint ${url} rejected the API key ${maskSecret(cfg.apiKey ?? "")} (${keyFrom}): ${check.message}`;
}

/** The env var a new key is stored under: ANTHROPIC_AUTH_TOKEN keeps its Bearer auth, everything else is GRAFT_API_KEY. */
function keyVarFor(cfg: ResolvedConfig, env: NodeJS.ProcessEnv, config: EngineConfig): string {
  const s = settingSource("key", config, cfg, env);
  return s.env === "ANTHROPIC_AUTH_TOKEN" && !cfg.databricks ? "ANTHROPIC_AUTH_TOKEN" : "GRAFT_API_KEY";
}

/** Prompts before the recovery gives up (the installer stops at the same count). */
const MAX_ROUNDS = 10;

function isSkip(answer: string): boolean {
  return /^(s|skip)$/i.test(answer);
}

export interface AuthRecoveryOptions {
  /** The caller's own `GET /models` just failed with this: the first check does not list again. */
  listingError?: unknown;
  /**
   * The {@link EndpointResult.saves} of the caller's endpoint choice, made before
   * this check: saved here once the endpoint passes, unless the user typed another
   * URL meanwhile (that URL's own choice is saved instead). The caller does not
   * save them itself.
   */
  pendingSaves?: Record<string, string>;
}

/**
 * Check the endpoint and key; on a failure a URL or key can fix, ask for both
 * (keep / change / skip each) and check again, until it passes or the user
 * skips. Without a terminal the failure is only reported.
 */
export async function ensureLlmAuth(deps: AuthRecoveryDeps, opts: AuthRecoveryOptions = {}): Promise<AuthRecovery> {
  let changes: LlmChanges = noChanges();
  /** The URL to save: one the user typed (or the endpoint choice for it picked), or the endpoint pinned for a new key. */
  let typedUrl: string | undefined;
  /** The user typed a URL: the caller's endpoint choice no longer applies. */
  let urlTyped = false;
  let typedKey: { name: string; value: string } | undefined;
  /** An endpoint choice made for a typed URL: saved with the typed values, once they pass. */
  let choiceSaves: Record<string, string> = {};
  let listingError = opts.listingError;
  let check: AuthCheck | undefined;
  let rounds = 0;
  const runCheck = deps.check ?? ((cfg: ResolvedConfig, o: AuthCheckOptions) => checkLlmAuth(cfg, deps.probes, o));

  for (;;) {
    const { config, env } = current(deps, changes);
    const cfg = resolveConfig(config, env);
    if (!check) {
      const early = precheck(cfg);
      if (!early && (typedUrl || typedKey)) deps.out(`Checking ${shownUrl(cfg)} with ${typedKey ? "the new key" : "the key"}…`);
      check = early ?? (await runCheck(cfg, { allRoutes: deps.allRoutes, listingError }));
      listingError = undefined;
    }

    if (!authFailed(check)) {
      if (typedUrl || typedKey) saveTyped(deps, typedUrl, typedKey, check.status === "ok");
      // The endpoint choice for what passed: the caller's, or the one made for a typed URL. GRAFT_BASE_URL
      // was just saved with the typed values when there were any.
      const saves = urlTyped ? choiceSaves : (opts.pendingSaves ?? {});
      const { GRAFT_BASE_URL: _saved, ...choice } = saves;
      commitEndpointChoice(deps, typedUrl ? choice : saves);
      if (check.status === "ok") {
        if (typedUrl || typedKey) deps.out(`✓ ${shownUrl(cfg)} accepted the key.`);
        return { status: "ok", changes, ids: check.ids, listings: check.listings };
      }
      return { status: "unverified", changes, message: check.message, listings: check.listings };
    }

    const src = settingSource("key", config, cfg, env);
    const keyFrom = typedKey ? "the key you typed" : `from ${src.flag ?? src.env ?? "the environment"}`;
    deps.err(`⚠ ${describeFailure(check, cfg, keyFrom)}.`);
    if (cfg.databricks && (check.status === "rejected" || check.status === "missing")) deps.err(`  ${databricksTokenHint()}.`);
    if (!deps.prompt) return { status: "failed", changes, check };
    if (++rounds > MAX_ROUNDS) {
      deps.err("Too many attempts.");
      return skipped(deps, check, cfg);
    }

    let url: string | undefined;
    let key: string | undefined;
    try {
      deps.out("Change the endpoint URL and/or the API key — Enter keeps a value, s skips the LLM step:");
      for (;;) {
        const a = (await deps.prompt.ask(`  LLM endpoint URL [${shownUrl(cfg)}]: `)).trim();
        if (isSkip(a)) return skipped(deps, check, cfg);
        if (!a) break;
        // The same rule `graft api url` applies: what one refuses, the other must not save.
        const problem = urlProblem(a);
        if (!problem) {
          url = a.replace(/\/+$/, "");
          break;
        }
        deps.err(`  ✗ ${problem}`);
      }
      const keyNow = cfg.apiKey ? maskSecret(cfg.apiKey) : "not set";
      const k = (await deps.prompt.askHidden(`  API key [${keyNow}] (input hidden): `)).trim();
      if (isSkip(k)) return skipped(deps, check, cfg);
      if (k) key = k;
    } catch (err) {
      if (err instanceof PromptCancelled) return { status: "cancelled" };
      throw err;
    }

    // Enter on both: keep what is set — asking again would only fail again.
    if (!url && !key) return skipped(deps, check, cfg);

    if (url) {
      typedUrl = url;
      urlTyped = true;
      changes = mergeChanges(
        changes,
        deps.config.baseUrl ? { env: {}, config: { baseUrl: url } } : { env: { GRAFT_BASE_URL: url }, config: {} },
      );
      // A typed URL can disagree with the provider just as a saved one can: ask which one, as always.
      const endpoint = await resolveEndpointConflict(deps, changes);
      if ("cancelled" in endpoint) return { status: "cancelled" };
      changes = mergeChanges(changes, endpoint.changes);
      choiceSaves = endpoint.saves;
      const chosen = endpoint.changes.config.baseUrl ?? endpoint.changes.env.GRAFT_BASE_URL;
      if (chosen) typedUrl = chosen;
    }
    if (key) {
      const name = keyVarFor(cfg, env, config);
      typedKey = { name, value: key };
      changes = mergeChanges(changes, deps.config.apiKey ? { env: {}, config: { apiKey: key } } : { env: { [name]: key }, config: {} });
      // Where a key lives can decide where it is sent (a legacy OPENROUTER_/ORCAROUTER_ key keeps
      // OpenRouter/OrcaRouter; GRAFT_API_KEY does not): keep the endpoint the user just kept.
      const before = endpointOf(cfg);
      if (!url && !typedUrl && before) {
        const next = current(deps, changes);
        if (endpointOf(resolveConfig(next.config, next.env)) !== before) {
          typedUrl = before;
          changes = mergeChanges(changes, { env: { GRAFT_BASE_URL: before }, config: {} });
          deps.out(`  (GRAFT_BASE_URL = ${before} is set too: with the key in ${name}, graft would otherwise send it elsewhere.)`);
        }
      }
    }
    check = undefined;
  }
}

function skipped(deps: LlmGuardDeps, check: AuthCheck, cfg: ResolvedConfig): AuthRecovery {
  deps.out("Skipped — the endpoint URL and API key stay as they are.");
  const why =
    check.status === "no-url"
      ? (check.message ?? "no endpoint URL is set")
      : check.status === "missing"
        ? `no API key for ${shownUrl(cfg)}`
        : check.status === "unreachable"
          ? `${shownUrl(cfg)} could not be reached`
          : `${shownUrl(cfg)} rejected the API key`;
  return { status: "skipped", reason: why };
}

/** Save values the user typed, and say how the current terminal picks them up. */
function saveTyped(
  deps: LlmGuardDeps,
  url: string | undefined,
  key: { name: string; value: string } | undefined,
  verified: boolean,
): void {
  if (!deps.store) return;
  const platform = deps.platform ?? process.platform;
  const lines: string[] = [];
  if (url && save(deps, "GRAFT_BASE_URL", url)) lines.push(envSetExample("GRAFT_BASE_URL", url, platform));
  if (key && save(deps, key.name, key.value)) lines.push(envSetExample(key.name, "<your-api-key>", platform));
  if (lines.length === 0) return;
  const what = [url ? "GRAFT_BASE_URL" : "", key ? key.name : ""].filter(Boolean).join(" and ");
  deps.out(`✓ saved ${what} to ${deps.store.where}${verified ? "" : " (not verified: the endpoint did not say)"}.`);
  // A value this terminal (or ./.env) sets itself still wins over the saved one here.
  const shadowed = [url && deps.env.GRAFT_BASE_URL && deps.env.GRAFT_BASE_URL !== url ? "GRAFT_BASE_URL" : "", key && deps.env[key.name] && deps.env[key.name] !== key.value ? key.name : ""].filter(Boolean);
  if (shadowed.length) {
    deps.out(`  This terminal still sets ${shadowed.join(" and ")} itself; new terminals use the saved value. For this one run:`);
    for (const l of lines) deps.out(`    ${l}`);
  }
}
