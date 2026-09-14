/**
 * What a saving would be worth under each model the user's agent can actually
 * run — read from the agent's own config, priced from graft's table.
 *
 * This exists because of a gap nothing else can close. On a host that reports no
 * billing and names no model, graft cannot price a saving at all: the model is
 * simply unknown, and inventing one (or reading a stale field out of a config
 * file) is the failure mode `context/price.ts` exists to prevent. But "no dollar
 * figure" is a poor answer when the set of models the user might be running is
 * sitting right there in their agent's own configuration.
 *
 * So this does not guess. It lists every model the agent offers with what THIS
 * saving is worth under each, and lets the reader pick their own row. A table of
 * honest alternatives beats one confident wrong figure.
 *
 * Two Kilo Code generations are read, because both are in the field:
 *   - 7.x — `~/.config/kilo/kilo.jsonc`, models under `provider.<id>.models`.
 *   - 5.x — the VS Code extension's `secrets.json`, where the model list lives
 *     inside a JSON-ENCODED string under `roo_cline_config_api_config`, one
 *     entry per configured API profile.
 * Both are merged into one list, de-duplicated by model id: a user mid-upgrade
 * has both files on disk and should see one table, not two.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatDollars, inputUsdPerMtok, normalizeModelId } from '../context/price.js';
import { formatCount, type ModelTable } from '../context/savings.js';
import { stripJsonc } from './kilo.js';

/** One model the host offers, priced if graft's table knows it. */
export interface HostModel {
  /** The id as the host writes it, kept verbatim so the user can match it up. */
  id: string;
  /** The host's display name, when it gives one. */
  name?: string;
  /** List $/Mtok, or null for a model graft has no price for. */
  usdPerMtok: number | null;
  /** The host's configured default — NOT necessarily the model now running. */
  isDefault: boolean;
}

export interface HostModels {
  host: string;
  /** Every config file the list was read from, in precedence order. */
  paths: string[];
  models: HostModel[];
}

/** Profile-level config locations for Kilo 7.x, highest precedence first. The
 * repo-level `.kilo/kilo.jsonc` is deliberately absent: it carries wiring
 * (instructions, mcp), never the model list. */
function kilo7Candidates(home: string): string[] {
  return [
    join(home, '.config', 'kilo', 'kilo.jsonc'),
    join(home, '.config', 'kilo', 'kilo.json'),
    join(home, '.kilo', 'kilo.jsonc'),
    join(home, '.kilo', 'kilo.json'),
  ];
}

/**
 * Where Kilo Code 5.x (the VS Code extension) keeps its API profiles.
 *
 * The extension writes a `secrets.json` whose top level is keyed by extension id
 * — the id has been spelled both with a dot and with a space across releases, so
 * both are accepted rather than pinned. `~/.kilocode/` is the extension's own
 * data dir; the VS Code `globalStorage` path is the fallback for installs that
 * never migrated out of it.
 */
function kilo5Candidates(home: string): string[] {
  return [
    join(home, '.kilocode', 'secrets.json'),
    join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'secrets.json'),
    join(home, '.config', 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'secrets.json'),
    join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'secrets.json'),
  ];
}

/** Parse strict JSON, then JSONC. Null on anything unreadable — a table is never
 * worth failing a command over. */
function parseConfig(raw: string): Record<string, any> | null {
  for (const text of [raw, stripJsonc(raw)]) {
    try {
      const v = JSON.parse(text);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      /* try the next form */
    }
  }
  return null;
}

function readParsed(path: string): Record<string, any> | null {
  try {
    return parseConfig(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** A raw (id, name) pair harvested from a host config, before pricing. */
interface RawModel {
  id: string;
  name?: string;
}

/**
 * Kilo 7.x: providers keyed by id, each with a `models` map of model-id →
 * `{ name }`. Shape confirmed against a real config rather than assumed; an
 * unrecognised shape yields nothing rather than a guess.
 */
function readKilo7(cfg: Record<string, any>): { models: RawModel[]; defaultId: string | null } {
  const models: RawModel[] = [];
  const providers = cfg.provider;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const provider of Object.values<any>(providers)) {
      const bucket = provider?.models;
      if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
      for (const [id, meta] of Object.entries<any>(bucket)) {
        models.push({
          id,
          name: typeof meta?.name === 'string' && meta.name.trim() ? meta.name : undefined,
        });
      }
    }
  }
  const defaultId =
    typeof cfg.model === 'string' && cfg.model.trim() ? normalizeModelId(cfg.model) : null;
  return { models, defaultId };
}

/** The extension-id keys Kilo 5.x's secrets file has shipped under. */
const KILO5_EXTENSION_KEYS = ['kilo code.kilo-code', 'kilocode.kilo-code'];

/**
 * Kilo 5.x: one API profile per configured model, under a JSON-encoded string.
 *
 * The double encoding is the extension's own doing — `roo_cline_config_api_config`
 * is a string containing JSON, not an object — so it is parsed twice. Each
 * profile names its model in a provider-specific field (`openAiModelId` for
 * OpenAI-compatible gateways, `apiModelId` elsewhere), and the profile NAME is
 * not a model id, so it is never used as one.
 */
function readKilo5(cfg: Record<string, any>): { models: RawModel[]; defaultId: string | null } {
  const bucket = KILO5_EXTENSION_KEYS.map((k) => cfg[k]).find((v) => v && typeof v === 'object');
  const raw = bucket?.roo_cline_config_api_config;
  if (typeof raw !== 'string') return { models: [], defaultId: null };

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { models: [], defaultId: null };
  }
  const profiles = parsed?.apiConfigs;
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    return { models: [], defaultId: null };
  }

  const models: RawModel[] = [];
  let defaultId: string | null = null;
  const current = typeof parsed.currentApiConfigName === 'string' ? parsed.currentApiConfigName : null;
  for (const [profileName, profile] of Object.entries<any>(profiles)) {
    const id = [profile?.openAiModelId, profile?.apiModelId, profile?.openRouterModelId]
      .find((v) => typeof v === 'string' && v.trim());
    if (!id) continue;
    models.push({ id: id.trim() });
    if (profileName === current) defaultId = normalizeModelId(id.trim());
  }
  return { models, defaultId };
}

/** Vendor a model belongs to, for grouping. Derived from the model id, which is
 * the only thing every config shape carries; the routing prefix a gateway adds
 * (`vertex_ai/claude-opus-5`) is dropped first, so a proxied Claude still groups
 * under Anthropic. */
function vendorOf(id: string): string {
  const n = normalizeModelId(id).toLowerCase();
  if (n.startsWith('claude')) return 'Anthropic';
  if (n.startsWith('gpt') || /^o[13]-/.test(n)) return 'OpenAI';
  if (n.startsWith('gemini')) return 'Google';
  if (n.startsWith('grok')) return 'xAI';
  if (n.startsWith('deepseek')) return 'DeepSeek';
  if (n.startsWith('kimi')) return 'Moonshot';
  if (n.startsWith('llama')) return 'Meta';
  if (n.startsWith('mistral') || n.startsWith('mixtral')) return 'Mistral';
  if (n.startsWith('qwen')) return 'Alibaba';
  const dash = n.indexOf('-');
  const head = dash > 0 ? n.slice(0, dash) : n;
  return head ? head[0].toUpperCase() + head.slice(1) : 'Other';
}

/**
 * The three vendors the user asked for by name, in that order; everything else
 * follows alphabetically. A fixed head rather than a pure sort because the
 * ordering requested is editorial ("Anthropic, then OpenAI, then Google, then
 * the rest"), not something derivable from the data.
 */
const VENDOR_ORDER = ['Anthropic', 'OpenAI', 'Google'];

function vendorRank(vendor: string): number {
  const i = VENDOR_ORDER.indexOf(vendor);
  return i === -1 ? VENDOR_ORDER.length : i;
}

/**
 * Within a vendor, top tier first.
 *
 * Price IS the tier: a vendor's flagship is its most expensive model, and every
 * table in `context/price.ts` reflects that. Using it avoids a second, hand-kept
 * list of which name outranks which — one that would silently mis-sort every
 * model released after it was written. Unpriced models never reach here (they
 * are filtered out), so there is no null case to rank.
 */
function byTier(a: HostModel, b: HostModel): number {
  return (b.usdPerMtok ?? 0) - (a.usdPerMtok ?? 0) || a.id.localeCompare(b.id);
}

/** Every model the user's Kilo Code offers, from whichever generations are
 * installed, priced from graft's table and ordered vendor-then-tier. */
export function readHostModels(opts: { home?: string } = {}): HostModels | null {
  const home = opts.home ?? homedir();

  const paths: string[] = [];
  const raw: RawModel[] = [];
  let defaultId: string | null = null;

  for (const path of kilo7Candidates(home)) {
    if (!existsSync(path)) continue;
    const cfg = readParsed(path);
    if (!cfg) continue;
    const got = readKilo7(cfg);
    if (got.models.length === 0 && got.defaultId === null) continue;
    paths.push(path);
    raw.push(...got.models);
    defaultId ??= got.defaultId;
    break; // highest-precedence 7.x config only
  }

  for (const path of kilo5Candidates(home)) {
    if (!existsSync(path)) continue;
    const cfg = readParsed(path);
    if (!cfg) continue;
    const got = readKilo5(cfg);
    if (got.models.length === 0) continue;
    paths.push(path);
    raw.push(...got.models);
    defaultId ??= got.defaultId;
    break; // highest-precedence 5.x config only
  }

  if (raw.length === 0) return null;

  // De-duplicate on the NORMALIZED id, so `vertex_ai/claude-opus-5` from the 7.x
  // config and a bare `claude-opus-5` from a 5.x profile are one row, not two.
  // First writer wins, which is the 7.x config: it carries display names.
  const seen = new Set<string>();
  const models: HostModel[] = [];
  for (const m of raw) {
    const key = normalizeModelId(m.id).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const usdPerMtok = inputUsdPerMtok(m.id);
    // A model graft cannot price is dropped rather than shown with a dash: this
    // table's whole job is to answer "what was it worth", and a row that cannot
    // is noise in a reply the user reads on every turn.
    if (usdPerMtok === null) continue;
    models.push({
      id: m.id,
      name: m.name,
      usdPerMtok,
      isDefault: defaultId !== null && normalizeModelId(m.id) === defaultId,
    });
  }
  if (models.length === 0) return null;

  models.sort((a, b) => {
    const va = vendorOf(a.id);
    const vb = vendorOf(b.id);
    return vendorRank(va) - vendorRank(vb) || va.localeCompare(vb) || byTier(a, b);
  });
  return { host: 'Kilo Code', paths, models };
}

/** What a saving is worth under one model. */
export function valueUnder(model: HostModel, savedTokens: number): number | null {
  if (model.usdPerMtok === null || savedTokens <= 0) return null;
  return (savedTokens * model.usdPerMtok) / 1_000_000;
}

/**
 * The per-model rows for Kilo Code, as a callback the savings nudge can hold.
 *
 * Returned rather than installed, so the ONE caller that knows it is talking to
 * Kilo decides whether to use it. That asymmetry is the point: this reads Kilo's
 * config shapes and nothing else, so handing the result to any other host would
 * price a saving under models that host cannot run. The only surface allowed to
 * wire it is the MCP dispatch, and only after `isKiloClient()`.
 *
 * The disk read is deferred into the callback and memoised, so a retrieval that
 * never reaches the unpriced branch never touches the filesystem at all.
 */
export function kiloModelRows(opts: { home?: string } = {}): ModelTable {
  let cached: HostModels | null | undefined;
  return (savedTokens: number) => {
    cached ??= readHostModels(opts);
    return cached ? pricedRows(cached, savedTokens) : [];
  };
}

/**
 * The host's display name for a model id — "Claude Opus 5" for
 * `vertex_ai/claude-opus-5` — or undefined when no host config names it.
 *
 * Used to label a model the AGENT named: `--agent-model` carries a wire id, but
 * the user picked that model from a menu showing the pretty name, and a tally
 * they cannot match to their own UI is a tally they have to decode.
 */
export function hostLabelFor(id: string, opts: { home?: string } = {}): string | undefined {
  const host = readHostModels(opts);
  if (!host) return undefined;
  const key = normalizeModelId(id).toLowerCase();
  return host.models.find((m) => normalizeModelId(m.id).toLowerCase() === key)?.name;
}

/** `model` with the host's display name attached when one is known. */
export function withHostLabel<T extends { id: string | null; label?: string }>(
  model: T,
  opts: { home?: string } = {},
): T {
  if (!model.id || model.label) return model;
  const label = hostLabelFor(model.id, opts);
  return label ? { ...model, label } : model;
}

/** The model rows as `label | $value` pairs, ready for any renderer. The label
 * is the host's display name when it gave one, else the raw id — the user picked
 * the model from a menu showing that string. */
export function pricedRows(
  host: HostModels,
  savedTokens: number,
): Array<{ label: string; value: string }> {
  return host.models.flatMap((m) => {
    const usd = valueUnder(m, savedTokens);
    return usd === null ? [] : [{ label: m.name ?? m.id, value: formatDollars(usd) }];
  });
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * The `graft models` table. `savedTokens` is priced under every listed model, so
 * a user whose host names no model can still read off the right figure.
 */
export function formatModelPrices(host: HostModels | null, savedTokens: number): string {
  if (!host) {
    return (
      'graft models: no agent config with a model list found.\n' +
      "  Looked for Kilo Code's config under ~/.config/kilo/ (7.x) and ~/.kilocode/ (5.x).\n" +
      '  Pass --agent-model <id> to have this session\'s savings priced directly.'
    );
  }
  const lines = [
    `graft models — ${host.host} (${host.paths.join(', ')})`,
    `  ~${formatCount(savedTokens)} saved input tokens, priced at each model's list rate:`,
    '',
  ];
  const idWidth = Math.max(5, ...host.models.map((m) => m.id.length));
  const rateWidth = 8;
  lines.push(`  ${pad('MODEL', idWidth)}  ${pad('$/MTOK', rateWidth)}  VALUE`);
  for (const m of host.models) {
    const rate = m.usdPerMtok === null ? '—' : m.usdPerMtok.toFixed(2);
    const usd = valueUnder(m, savedTokens);
    const value = usd === null ? '—' : formatDollars(usd);
    const tail = [m.name, m.isDefault ? 'host default' : null].filter(Boolean).join(', ');
    lines.push(`  ${pad(m.id, idWidth)}  ${pad(rate, rateWidth)}  ${pad(value, 7)}${tail ? `  ${tail}` : ''}`);
  }
  lines.push('');
  lines.push(
    '  The host default is the model a NEW session starts on, not necessarily the',
  );
  lines.push(
    '  one that ran this turn — read the row for the model you actually used.',
  );
  return lines.join('\n');
}
