/**
 * What a saving would be worth under each model the user's agent can actually
 * run — read from the agent's own config, priced from graft's table.
 *
 * This exists because of a gap nothing else can close: on a host that reports no
 * billing, graft prices saved tokens from a DECLARED model
 * (`.graft/config.json`, `--agent-model`, `GRAFT_AGENT_MODEL`), and a
 * declaration goes stale the moment the user picks a different model in the UI.
 * The host's own config is no rescue — Kilo's `model` key is the default for a
 * NEW session, not the one the current turn ran on, so pricing from it would
 * trade a stale number for a differently stale one.
 *
 * So this does not guess at all. It lists every model the agent offers with what
 * THIS saving is worth under each, and lets the reader pick their own row. A
 * table of honest alternatives beats one confident wrong figure — the same rule
 * `context/price.ts` is built on.
 *
 * Deliberately a command, never part of the per-call savings footer: that footer
 * rides on every tool call, and repeating a table there would spend more tokens
 * than the retrieval saved.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatDollars, inputUsdPerMtok, normalizeModelId } from '../context/price.js';
import { formatCount } from '../context/savings.js';
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
  path: string;
  models: HostModel[];
}

/** Profile-level config locations, highest precedence first. The repo-level
 * `.kilo/kilo.jsonc` is deliberately absent: it carries wiring (instructions,
 * mcp), never the model list. */
function kiloCandidates(home: string): string[] {
  return [
    join(home, '.config', 'kilo', 'kilo.jsonc'),
    join(home, '.config', 'kilo', 'kilo.json'),
    join(home, '.kilo', 'kilo.jsonc'),
    join(home, '.kilo', 'kilo.json'),
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

/**
 * Every model Kilo is configured with, from `provider.<id>.models`.
 *
 * Shape confirmed against a real Kilo config rather than assumed: providers keyed
 * by id, each with a `models` map of model-id → `{ name }`. An unrecognised shape
 * yields no models rather than a guess.
 */
export function readHostModels(opts: { home?: string } = {}): HostModels | null {
  const home = opts.home ?? homedir();
  const path = kiloCandidates(home).find((p) => existsSync(p));
  if (!path) return null;

  let cfg: Record<string, any> | null;
  try {
    cfg = parseConfig(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!cfg) return null;

  const declaredDefault =
    typeof cfg.model === 'string' && cfg.model.trim() ? normalizeModelId(cfg.model) : null;

  const models: HostModel[] = [];
  const seen = new Set<string>();
  const providers = cfg.provider;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const provider of Object.values<any>(providers)) {
      const bucket = provider?.models;
      if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
      for (const [id, meta] of Object.entries<any>(bucket)) {
        if (seen.has(id)) continue;
        seen.add(id);
        models.push({
          id,
          name: typeof meta?.name === 'string' && meta.name.trim() ? meta.name : undefined,
          usdPerMtok: inputUsdPerMtok(id),
          isDefault: declaredDefault !== null && normalizeModelId(id) === declaredDefault,
        });
      }
    }
  }
  if (models.length === 0) return null;
  models.sort((a, b) => (b.usdPerMtok ?? -1) - (a.usdPerMtok ?? -1) || a.id.localeCompare(b.id));
  return { host: 'Kilo Code', path, models };
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * The table. `savedTokens` is priced under every listed model, so a user whose
 * declared model is wrong (or absent) can still read off the right figure.
 */
export function formatModelPrices(host: HostModels | null, savedTokens: number): string {
  if (!host) {
    return (
      'graft models: no agent config with a model list found.\n' +
      '  Looked for Kilo Code\'s config under ~/.config/kilo/ and ~/.kilo/.\n' +
      '  Declare a model in .graft/config.json to have savings priced.'
    );
  }
  const lines = [
    `graft models — ${host.host} (${host.path})`,
    `  ~${formatCount(savedTokens)} saved input tokens, priced at each model's list rate:`,
    '',
  ];
  const idWidth = Math.max(5, ...host.models.map((m) => m.id.length));
  const rateWidth = 8;
  lines.push(`  ${pad('MODEL', idWidth)}  ${pad('$/MTOK', rateWidth)}  VALUE`);
  for (const m of host.models) {
    const rate = m.usdPerMtok === null ? '—' : m.usdPerMtok.toFixed(2);
    // An unpriced model shows no value rather than a zero: graft not knowing a
    // price is a different fact from the tokens being worth nothing.
    const value =
      m.usdPerMtok === null || savedTokens <= 0
        ? '—'
        : formatDollars((savedTokens * m.usdPerMtok) / 1_000_000);
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
