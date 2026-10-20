/**
 * A local copy of LiteLLM's public model price catalog, for the models graft's
 * built-in table (`price.ts`) has never heard of.
 *
 * Fetched only by an explicit `graft prices update`. Nothing here ever reaches
 * the network on its own, and the request itself carries nothing about the user:
 * it is one anonymous GET of the WHOLE catalog, so not even the model being
 * priced leaves the machine. Every lookup afterwards is local.
 *
 * Only the input-side rates are kept (input, cache read, cache write, in $/Mtok)
 * because that is all graft prices: what it saves is context the agent would
 * otherwise have read IN. The ~3 MB catalog reduces to well under 100 KB.
 *
 * A stored catalog is used until the next `graft prices update` replaces it,
 * whatever its age; its fetch date travels with every price it supplies, so the
 * wording can say how old the figure is.
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../util/state.js';
import { canonicalModelKey } from './price.js';

export const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const DAY_MS = 86_400_000;

/** Input-side list rates for one model, in $/Mtok. */
export interface CatalogPrice {
  input: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PriceCatalog {
  version: 1;
  source: 'LiteLLM';
  url: string;
  /** ISO timestamp of the fetch. */
  fetchedAt: string;
  /** Keyed by {@link canonicalModelKey}. */
  models: Record<string, CatalogPrice>;
}

export type PriceCatalogState = 'missing' | 'stored';

export interface PriceCatalogStatus {
  state: PriceCatalogState;
  path: string;
  fetchedAt?: string;
  ageDays?: number;
  models?: number;
}

/** `GRAFT_PRICES_FILE` wins, so tests and unusual setups can point elsewhere. */
export function priceCatalogPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.GRAFT_PRICES_FILE?.trim();
  return override ? override : join(home, '.graft', 'prices.json');
}

/** Per-process cache, keyed by path and mtime so a long-running MCP server picks
 * up a `graft prices update` run in another terminal without re-reading the file
 * on every lookup. */
let memo: { path: string; mtimeMs: number; catalog: PriceCatalog | null } | null = null;

function isCatalog(v: unknown): v is PriceCatalog {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<PriceCatalog>;
  return (
    c.version === 1 &&
    typeof c.fetchedAt === 'string' &&
    Number.isFinite(Date.parse(c.fetchedAt)) &&
    !!c.models &&
    typeof c.models === 'object'
  );
}

/** The stored catalog whatever its age, or null when there is none or it is unreadable. */
export function readPriceCatalog(path: string = priceCatalogPath()): PriceCatalog | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    memo = { path, mtimeMs: -1, catalog: null };
    return null;
  }
  if (memo && memo.path === path && memo.mtimeMs === mtimeMs) return memo.catalog;
  const raw = readJson<unknown>(path);
  const catalog = isCatalog(raw) ? raw : null;
  memo = { path, mtimeMs, catalog };
  return catalog;
}

export function priceCatalogStatus(now: number = Date.now(), path: string = priceCatalogPath()): PriceCatalogStatus {
  const catalog = readPriceCatalog(path);
  if (!catalog) return { state: 'missing', path };
  return {
    state: 'stored',
    path,
    fetchedAt: catalog.fetchedAt,
    ageDays: Math.floor(Math.max(0, (now - Date.parse(catalog.fetchedAt)) / DAY_MS)),
    models: Object.keys(catalog.models).length,
  };
}

/** The catalog's rates for `model`, or null when no catalog is stored or it does
 * not list the model. */
export function catalogPrice(model: string): (CatalogPrice & { fetchedAt: string }) | null {
  const catalog = readPriceCatalog();
  if (!catalog) return null;
  const key = canonicalModelKey(model);
  if (!key) return null;
  const hit = catalog.models[key];
  if (!hit || !validRate(hit.input) || hit.input <= 0) return null;
  return { ...hit, fetchedAt: catalog.fetchedAt };
}

/** Text-generation modes only: an embedding or image model sharing a name with a
 * chat model must not lend it a price. */
const PRICED_MODES = new Set(['chat', 'responses', 'completion']);

/** $1,000/Mtok: no text model lists anywhere near it, so anything above is a
 * typo or a unit change upstream, not a price. */
const MAX_USD_PER_MTOK = 1000;

function validRate(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_USD_PER_MTOK;
}

/** Per-token dollars → $/Mtok, rounded off the float noise (`5e-6 * 1e6` is
 * 4.999999999999999). */
function perMtok(perToken: unknown): number | undefined {
  if (typeof perToken !== 'number' || !Number.isFinite(perToken)) return undefined;
  const v = Math.round(perToken * 1e12) / 1e6;
  return validRate(v) ? v : undefined;
}

function samePrice(a: CatalogPrice, b: CatalogPrice): boolean {
  return a.input === b.input && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;
}

/** One price per key, or null when the entries disagree — an ambiguous name is
 * left unpriced rather than settled by whichever entry came first. */
function agreed(prices: CatalogPrice[]): CatalogPrice | null {
  if (prices.length === 0) return null;
  return prices.every((p) => samePrice(p, prices[0]!)) ? prices[0]! : null;
}

/**
 * Reduce LiteLLM's catalog to graft's per-model input rates.
 *
 * LiteLLM lists one model under several keys: the vendor's own
 * (`claude-opus-4-5`) and one per gateway that serves it
 * (`vertex_ai/claude-opus-4-5`, `openrouter/anthropic/claude-opus-4.5`, …),
 * whose prices can differ. The vendor's own key wins. A model listed ONLY
 * behind gateways is priced only when every gateway agrees.
 */
export function parseLiteLlmCatalog(json: unknown, fetchedAt: string, url: string = LITELLM_PRICES_URL): PriceCatalog {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('the LiteLLM price catalog is not a JSON object');
  }
  const direct = new Map<string, CatalogPrice[]>();
  const routed = new Map<string, CatalogPrice[]>();
  for (const [name, entry] of Object.entries(json as Record<string, unknown>)) {
    if (name === 'sample_spec' || !entry || typeof entry !== 'object') continue;
    // `ft:gpt-4o` is a fine-tune of the model, priced differently, and would
    // otherwise normalise onto the base model's key.
    if (/^[A-Za-z]+\s*:/.test(name.trim())) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.mode !== 'string' || !PRICED_MODES.has(e.mode)) continue;
    const input = perMtok(e.input_cost_per_token);
    if (input === undefined || input <= 0) continue;
    const price: CatalogPrice = { input };
    const cacheRead = perMtok(e.cache_read_input_token_cost);
    const cacheWrite = perMtok(e.cache_creation_input_token_cost);
    if (cacheRead !== undefined) price.cacheRead = cacheRead;
    if (cacheWrite !== undefined) price.cacheWrite = cacheWrite;
    const key = canonicalModelKey(name);
    if (!key) continue;
    const bucket = name.includes('/') ? routed : direct;
    const list = bucket.get(key);
    if (list) list.push(price);
    else bucket.set(key, [price]);
  }
  const models: Record<string, CatalogPrice> = {};
  for (const key of new Set([...direct.keys(), ...routed.keys()])) {
    const ownKey = direct.get(key);
    const price = ownKey ? agreed(ownKey) : agreed(routed.get(key) ?? []);
    if (price) models[key] = price;
  }
  if (Object.keys(models).length === 0) {
    throw new Error('the LiteLLM price catalog lists no priced text models');
  }
  return { version: 1, source: 'LiteLLM', url, fetchedAt, models };
}

export interface UpdateOptions {
  fetchImpl?: typeof fetch;
  path?: string;
  now?: number;
  timeoutMs?: number;
}

/**
 * Download LiteLLM's catalog, reduce it and store it. The previous copy is kept
 * whenever anything goes wrong — a failed update never leaves graft with fewer
 * prices than it had.
 *
 * The request sends no credentials and no identifying headers of graft's own;
 * the server sees an anonymous GET for a public file.
 */
export async function updatePriceCatalog(
  opts: UpdateOptions = {},
): Promise<{ catalog: PriceCatalog; path: string }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const path = opts.path ?? priceCatalogPath();
  const res = await doFetch(LITELLM_PRICES_URL, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${LITELLM_PRICES_URL}`);
  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch {
    throw new Error(`${LITELLM_PRICES_URL} did not return valid JSON`);
  }
  const catalog = parseLiteLlmCatalog(json, new Date(opts.now ?? Date.now()).toISOString());
  writeJsonAtomic(path, catalog, true);
  memo = null;
  return { catalog, path };
}
