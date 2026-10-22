/**
 * What graft has saved this repo, per day and per model, for as long as it has
 * been installed here.
 *
 * `session-metrics.ts` answers "what did THIS session save"; a session file is
 * keyed by the host's session id, carries no dates, and is the wrong shape to
 * ask "what did graft save us in March". So the same two facts — tokens kept out
 * of the context, and what the tokens that WERE sent cost — are also appended
 * here, bucketed by local calendar day and by the model that was running. Days
 * are the finest bucket `graft savings` can be asked for, so nothing finer is
 * stored, and a day-by-model row is a few dozen bytes: a year of daily use is a
 * file measured in kilobytes.
 *
 * The model is the key because the price is per model, and a repo worked on with
 * two of them saved different amounts of money for the same tokens. When no
 * model can be named — a host that reports none and a repo that declares none —
 * the saving is filed under {@link UNKNOWN_MODEL} and reported in tokens alone,
 * never priced at a guess (see `context/price.ts` for why).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { cacheDir, readJson, writeJsonAtomic } from '../util/state.js';
import { locateLedger, pathKey, readRepoRegistry, registerRepo, repoRegistryPath } from './repo-registry.js';
import {
  NO_MODEL,
  blendedRate,
  canonicalModelKey,
  formatDollars,
  listRate,
  normalizeModelId,
  refinesModelId,
  valueSaved,
  type AgentModel,
  type InputRate,
} from '../context/price.js';
import { formatCount } from '../context/savings.js';
import { callScope } from '../context/call-scope.js';
import type { ModelUsage } from './tally.js';

/** One model's running totals within one day. */
export interface ModelLedger {
  /** Tokens graft's retrieval kept out of the context (est.). */
  savedTokens: number;
  /** Micro-dollars this model's input tokens actually cost that day, and the
   * tokens that bought — the pair a measured rate is made of. Zero when the host
   * reports no billing, which reads as "not measured" everywhere downstream. */
  costMicros: number;
  tokensBilled: number;
}

/** `days[YYYY-MM-DD][model]`. A plain nested record so a period query is a
 * prefix match on the key and needs no index. */
export interface SavingsLedger {
  days: Record<string, Record<string, ModelLedger>>;
}

/** Filed under this when nothing names the model. Not a model id, so it can
 * never collide with one, and never priced. */
export const UNKNOWN_MODEL = 'unknown';

/**
 * Retired. `GRAFT_AGENT_MODEL` no longer takes part in pricing a saving.
 *
 * It was a standing declaration — a variable exported into a shell profile once,
 * still naming a model months after the user switched away from it. So was the
 * `model` field in `.graft/config.json`, and both are now ignored for the same
 * reason: a stale price renders exactly like a correct one, so the user has no
 * way to notice it has gone wrong.
 *
 * What names the model now is either the host itself (a transcript stamp) or the
 * agent on the call (`--agent-model`) — both facts about the turn being priced,
 * neither able to outlive it. Nothing else names one, and a saving nothing names
 * is reported in tokens.
 *
 * The name is kept exported so an importer fails loudly at the type level rather
 * than reading an env var nothing writes; see `resolveModel`.
 *
 * @deprecated Ignored since 0.18.0. Pass `--agent-model <id>` instead.
 */
export const AGENT_MODEL_ENV = 'GRAFT_AGENT_MODEL';

/**
 * Record the model the agent says it is running for THIS call — `--agent-model`
 * on the CLI, the `model` tool argument over MCP.
 *
 * Held in the call scope, not a module-level slot. The distinction is invisible
 * on the CLI (one process, one query) and load-bearing on the MCP server, which
 * is long-lived and serves `async` calls that interleave at every `await`: a
 * module slot let one tool call read the model another had just set, pricing and
 * FILING a saving under a model that never ran it. See `context/call-scope.ts`.
 *
 * Blank and undefined both clear it, so a host that interpolates an empty
 * variable names no model rather than naming the empty string.
 */
export function setAgentModel(model?: string | null): void {
  callScope().agentModel = model && model.trim() ? model.trim() : null;
}

/**
 * Record the model the HOST says this session is running — read from the host's
 * own live session record rather than reported by the agent.
 *
 * The distinction from {@link setAgentModel} is one of provenance, not of
 * trust. Over MCP the agent is asked to name itself on every call, and measured
 * against real usage it mostly does not: the ask is honoured on a fraction of
 * calls by a strong model and on none at all by a fast one, so the majority of
 * savings were filed under {@link UNKNOWN_MODEL} and reported in tokens. This is
 * the channel that closes that gap where a host keeps the answer somewhere
 * readable (today: Kilo Code — see `hosts/kilo-session.ts`).
 *
 * It is NOT the standing declaration this module removed in 0.18.0. That was a
 * value written once into a config file, still pricing months later with no way
 * for the user to see it had gone stale. A host's session record is written by
 * the host, per session, for the conversation now making the call — the same
 * class of evidence as a transcript stamp, and it goes stale by disappearing
 * rather than by lying.
 *
 * Held in the call scope for exactly the reason the agent's model is: the MCP
 * server is long-lived and serves interleaving async calls.
 */
export function setHostModel(model?: string | null): void {
  callScope().hostModel = model && model.trim() ? model.trim() : null;
}

/** The local calendar day, which is the day the user means when they type one. */
export function dayKey(when: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/** Where {@link resolveModel} got its answer. Every real source names the model
 * the turn ACTUALLY ran — 'stamped' from the host's own transcript, 'flag' from
 * the agent naming itself on this call, 'host' from the host's live session
 * record. What is deliberately absent is a model standing in a config file: that
 * is a guess which outlives its session, and pricing from one is what this
 * design removed. */
export type ModelSource = 'stamped' | 'flag' | 'host' | 'none';

/**
 * Which model a saving belongs to, and how sure we are of it.
 *
 * Three sources, in falling order of directness:
 *
 *  1. `stamped` — the host's transcript says what the session ran.
 *  2. `flag` — the agent named itself on this very call (`--agent-model`, or the
 *     `model` tool argument over MCP).
 *  3. `host` — the host's own live session record names the model of the session
 *     this call belongs to (`hosts/kilo-session.ts`, `hosts/vscode-session.ts`).
 *
 * All three are facts about the turn being priced, so all three rank `certain`.
 * The agent's own word outranks the host record because it is scoped to the call
 * rather than to the session: a host that lets the model change mid-session, or
 * runs two sessions in one directory, is described more precisely by the agent
 * than by a row matched on a path.
 *
 * ## The one exception: a vaguer self-report
 *
 * An agent running behind a router — Copilot's "Auto", where the picker holds
 * `copilot/auto` — genuinely does not know which model it is. Asked to name
 * itself it answers with the FAMILY: observed in the field, `--agent-model
 * gpt-5` for a turn VS Code recorded as `gpt-5.6-luna`. Taking the agent's word
 * there is not preferring a better source, it is discarding the only precise
 * observation available: it filed the saving under `gpt-5` and priced it at
 * $1.25/Mtok when the model actually running lists at $0.20 — a 6x overstatement
 * presented with exactly the confidence of a correct figure.
 *
 * So when the host's record is the SAME model named more precisely
 * ({@link refinesModelId}), the precise form wins. This is not the host
 * overriding the agent: both are saying "a gpt-5", and only one of them says
 * which. A host record naming a genuinely DIFFERENT model still loses, because
 * that is a real conflict and the agent is the better authority on its own call.
 *
 * Anything else is `none`: the saving is filed under {@link UNKNOWN_MODEL} and
 * reported in tokens alone, never priced at a guess.
 */
export function resolveModel(dir: string, stamped?: string | null): { model: string; source: ModelSource } {
  if (stamped && stamped.trim()) return { model: stamped.trim(), source: 'stamped' };
  const scope = callScope();
  if (scope.agentModel) {
    const host = scope.hostModel;
    // The host saw `gpt-5.6-luna`; the agent could only say `gpt-5`. Same claim,
    // one decimal place better — take the one that can actually be priced.
    if (host && refinesModelId(host, scope.agentModel)) return { model: host, source: 'host' };
    return { model: scope.agentModel, source: 'flag' };
  }
  if (scope.hostModel) return { model: scope.hostModel, source: 'host' };
  return { model: UNKNOWN_MODEL, source: 'none' };
}

/** The model a saving belongs to in the shape the pricing layer wants: the id,
 * or null when nothing named one, plus how sure we are. */
export function agentModel(dir: string, stamped?: string | null): AgentModel {
  const { model, source } = resolveModel(dir, stamped);
  return source === 'none' ? NO_MODEL : { id: model, confidence: 'certain' };
}

/** The model alone, for the ledger key and every caller that does not care where
 * it came from. */
export function currentModel(dir: string, stamped?: string | null): string {
  return resolveModel(dir, stamped).model;
}

/** One file for the whole history. Measured at ten years of daily use (7,300
 * day/model rows, ~900 kB): under 10ms to rewrite, ~4ms to read. Both are noise
 * beside the retrieval that triggered them, so the simpler layout wins. */
export function ledgerPath(d: string): string {
  return join(cacheDir(d), 'savings.json');
}

export function readLedger(d: string): SavingsLedger {
  return readLedgerFile(ledgerPath(d));
}

/** {@link readLedger} by file path, for ledgers found through the user's repo
 * registry rather than resolved from a repo root. */
export function readLedgerFile(p: string): SavingsLedger {
  const l = readJson<SavingsLedger>(p);
  return l && typeof l.days === 'object' && l.days !== null ? l : { days: {} };
}

/**
 * The key a saving is filed under: the model id reduced to its canonical form,
 * so `vertex_ai/claude-opus-5`, `anthropic/claude-opus-5` and a bare
 * `claude-opus-5` are one row rather than three — and so are `gemini-3.7-flash`
 * and `gemini-3-7-flash`.
 *
 * The routing prefix names who SERVES the model, not which model it is, and the
 * version separator is pure spelling. Keeping either split the lifetime totals:
 * the same model, named two ways, reported as two unrelated lines in
 * `graft savings`, which answers a question nobody asked at the cost of the one
 * they did — what has this model saved me.
 *
 * The separator case is not hypothetical. A real ledger accumulated both
 * `gemini-3.7-flash` (from one source) and `gemini-3-7-flash` (from another)
 * side by side, each with its own dollar figure. See {@link canonicalModelKey}.
 *
 * {@link UNKNOWN_MODEL} passes through unchanged (there is nothing to fold), and
 * a value that reduces to nothing falls back to it rather than creating an
 * empty-string row.
 */
function ledgerKey(model: string): string {
  return canonicalModelKey(model).trim() || UNKNOWN_MODEL;
}

/** Read-modify-write of one day/model bucket. Best-effort and never throwing:
 * every caller is on a tool-call path, and a ledger entry is not worth failing a
 * turn over. Unlocked like `patchStats`, so a race loses a count, never the
 * file.
 *
 * The single funnel every writer passes through, which is why the key is
 * normalised HERE: a writer that forgot would silently start a second row for a
 * model already in the file. */
function patchBucket(d: string, model: string, when: Date, patch: (b: ModelLedger) => void): void {
  try {
    const ledger = readLedger(d);
    const day = (ledger.days[dayKey(when)] ??= {});
    const key = ledgerKey(model);
    const bucket = (day[key] ??= { savedTokens: 0, costMicros: 0, tokensBilled: 0 });
    patch(bucket);
    const file = ledgerPath(d);
    writeJsonAtomic(file, ledger);
    // Note the folder in the user's profile so `graft savings --all` can find
    // this ledger from anywhere. Throttled to one write per repo per day, and
    // never throws.
    registerRepo(d, file, { when });
  } catch {
    // A lifetime total is never worth failing a hook over.
  }
}

/** Fold one retrieval's saving into today's bucket for `model`. */
export function recordSavedTokens(d: string, model: string, savedTokens: number, when: Date = new Date()): void {
  if (!(savedTokens > 0)) return;
  patchBucket(d, model, when, (b) => { b.savedTokens += savedTokens; });
}

/** Fold one turn's input spend into today's buckets, one per model the turn ran.
 * Unpriced models are recorded at zero cost: their presence names the model, and
 * a zero pair reads as "not measured" to {@link blendedRate}. */
export function recordTurnBilling(d: string, models: ModelUsage[], when: Date = new Date()): void {
  for (const m of models) {
    const model = m.model.trim() || UNKNOWN_MODEL;
    patchBucket(d, model, when, (b) => {
      if (m.costMicros === null) return;
      b.costMicros += m.costMicros;
      b.tokensBilled += m.tokens;
    });
  }
}

/** A `yyyy`, `yyyy-mm` or `yyyy-mm-dd` filter — a literal prefix of a day key,
 * which is why the keys are stored in that order. */
const PERIOD = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

export function isPeriod(arg: string): boolean {
  return PERIOD.test(arg);
}

/** One model's savings over the queried period, priced when a rate exists. */
export interface ModelSavings extends ModelLedger {
  model: string;
  /** What those tokens were worth, or null when nothing prices this model. */
  value: { usd: number; measured: boolean } | null;
}

export interface SavingsReport {
  period: string | null;
  /** Days with at least one entry in range — how much history the totals rest on. */
  days: number;
  models: ModelSavings[];
  savedTokens: number;
  /** Dollars across the models that could be priced, or null when none could. */
  usd: number | null;
  /** Whether every priced model's rate was measured rather than declared. */
  measured: boolean;
  /** Tokens belonging to models with no rate at all — excluded from `usd`, and
   * named in the report so the dollar figure is never read as the whole story. */
  unpricedTokens: number;
}

/**
 * Roll the ledger up over a period, newest facts and oldest alike.
 *
 * A model's rate is its own measured one when the host billed it, and only then
 * its published list price — the same order every other surface uses, so a repo
 * with one measured model and one unpriced one reports each honestly instead of
 * pricing both at whichever rate was handy.
 */
export function aggregateSavings(ledger: SavingsLedger, period?: string | null): SavingsReport {
  const byModel = new Map<string, ModelLedger>();
  let days = 0;
  for (const [day, models] of Object.entries(ledger.days)) {
    if (period && !day.startsWith(period)) continue;
    days++;
    for (const [model, b] of Object.entries(models)) {
      // Canonicalised on READ as well as on write, so a file already carrying
      // `gemini-3.7-flash` and `gemini-3-7-flash` as separate rows reports them
      // as the one model they are. Fixing only the write path would leave every
      // existing ledger permanently split — the rows are historical facts and
      // nothing rewrites them — and this is where they are added up anyway.
      const key = model === UNKNOWN_MODEL ? model : canonicalModelKey(model) || UNKNOWN_MODEL;
      const acc = byModel.get(key) ?? { savedTokens: 0, costMicros: 0, tokensBilled: 0 };
      acc.savedTokens += b.savedTokens ?? 0;
      acc.costMicros += b.costMicros ?? 0;
      acc.tokensBilled += b.tokensBilled ?? 0;
      byModel.set(key, acc);
    }
  }

  const models: ModelSavings[] = [];
  let savedTokens = 0;
  let usd = 0;
  let priced = false;
  let measured = true;
  let unpricedTokens = 0;
  for (const [model, b] of byModel) {
    // A model this table cannot price reports tokens alone. The UNKNOWN_MODEL
    // sentinel is never priced at all: it is a placeholder, not a model id.
    // Rows are `certain` by construction — a saving is only ever FILED under a
    // model the agent named, so a ledger key is as good as a stamp.
    const known: AgentModel =
      model === UNKNOWN_MODEL ? NO_MODEL : { id: model, confidence: 'certain' };
    const rate: InputRate | null = blendedRate(b.costMicros, b.tokensBilled) ?? listRate(known);
    const value = valueSaved(b.savedTokens, rate);
    models.push({ model, ...b, value });
    savedTokens += b.savedTokens;
    if (value) {
      priced = true;
      usd += value.usd;
      if (!value.measured) measured = false;
    } else {
      unpricedTokens += b.savedTokens;
    }
  }
  models.sort((a, b) => b.savedTokens - a.savedTokens || a.model.localeCompare(b.model));
  return {
    period: period ?? null,
    days,
    models,
    savedTokens,
    usd: priced ? usd : null,
    measured: priced && measured,
    unpricedTokens,
  };
}

const NOTHING_YET =
  'graft savings: nothing recorded yet — use graft in an agent session, then look again.';

/** The rendered readout `graft savings` prints. Tokens always, dollars only
 * where a rate exists, and a caveat wherever the rate was a list price rather
 * than something this repo was billed. */
export function formatSavingsReport(r: SavingsReport): string {
  const scope = r.period ? `— ${r.period}` : '— all time';
  if (r.models.length === 0) {
    return r.period
      ? `graft savings ${scope}: nothing recorded in that period.`
      : NOTHING_YET;
  }

  const rows = r.models.map((m) => ({
    model: m.model,
    tokens: `~${formatCount(m.savedTokens)} tokens`,
    value: m.value ? `~${formatDollars(m.value.usd)}` : '',
    note: m.value ? (m.value.measured ? '' : '(list rate)') : '(no rate — tokens only)',
  }));
  rows.push({
    model: 'total',
    tokens: `~${formatCount(r.savedTokens)} tokens`,
    value: r.usd === null ? '' : `~${formatDollars(r.usd)}`,
    note: r.unpricedTokens > 0 ? `(excludes ~${formatCount(r.unpricedTokens)} unpriced tokens)` : '',
  });

  const modelWidth = Math.max(...rows.map((x) => x.model.length));
  const tokenWidth = Math.max(...rows.map((x) => x.tokens.length));
  const valueWidth = Math.max(...rows.map((x) => x.value.length));
  const line = (x: (typeof rows)[number]) =>
    `  ${x.model.padEnd(modelWidth)}  ${x.tokens.padStart(tokenWidth)}  ${x.value.padStart(valueWidth)}${x.note ? `  ${x.note}` : ''}`.trimEnd();

  const dayCount = `${r.days} day${r.days === 1 ? '' : 's'} recorded`;
  const body = rows.slice(0, -1).map(line);
  return [
    `graft savings ${scope} · ${dayCount}`,
    ...body,
    `  ${'─'.repeat(modelWidth + tokenWidth + valueWidth + 4)}`,
    line(rows[rows.length - 1]),
  ].join('\n');
}

// ── every repo on this machine ────────────────────────────────────────────

/** One registered folder's share of a cross-repo report. */
export interface RepoSavings {
  root: string;
  /** The ledger file read, or null when none of its known places holds one. */
  ledger: string | null;
  report: SavingsReport;
}

export interface AllSavingsReport {
  period: string | null;
  /** The registry file the folder list came from. */
  registry: string;
  /** Folders with something recorded in the period, biggest saving first. */
  repos: RepoSavings[];
  /** Registered folders whose ledger is gone (deleted, moved, cache cleared). */
  missing: string[];
  /** Every repo added up. Each repo is priced at ITS OWN rate first — a model
   * billed cheaply in one repo is not re-priced at another repo's rate — so the
   * per-repo dollars and the per-model dollars both add up to this total. */
  total: AllReportTotal;
}

/** A model's savings summed across repos. `unpricedTokens` is the share no repo
 * could price — non-zero only for a model with no list price that some repos
 * were billed for and others were not. */
export interface TotalModelSavings extends ModelSavings {
  unpricedTokens: number;
}

export interface AllReportTotal extends SavingsReport {
  models: TotalModelSavings[];
}

/**
 * Roll up every ledger the user's registry lists, over a period.
 *
 * Each repo is aggregated on its own (its own measured rates, its own list-rate
 * fallbacks), and the results are summed — never a merged ledger re-priced as
 * one, which would blend one repo's billing into another's figures and leave the
 * per-repo lines not adding up to the total printed under them.
 */
export function aggregateAllSavings(
  period?: string | null,
  file: string = repoRegistryPath(),
): AllSavingsReport {
  const registry = readRepoRegistry(file);
  const repos: RepoSavings[] = [];
  const missing: string[] = [];
  const seenLedgers = new Set<string>();
  const days = new Set<string>();

  for (const entry of registry.repos) {
    const ledgerFile = locateLedger(entry);
    if (!ledgerFile) {
      missing.push(entry.root);
      continue;
    }
    // Two entries reaching the same file (a repo registered under two
    // spellings, or a GRAFT_DIR shared by both) must count once.
    const k = pathKey(ledgerFile);
    if (seenLedgers.has(k)) continue;
    seenLedgers.add(k);

    const ledger = readLedgerFile(ledgerFile);
    const report = aggregateSavings(ledger, period);
    if (report.models.length === 0) continue;
    for (const day of Object.keys(ledger.days)) {
      if (!period || day.startsWith(period)) days.add(day);
    }
    repos.push({ root: entry.root, ledger: ledgerFile, report });
  }
  repos.sort((a, b) => b.report.savedTokens - a.report.savedTokens || a.root.localeCompare(b.root));

  return { period: period ?? null, registry: file, repos, missing, total: sumReports(repos.map((r) => r.report), period ?? null, days.size) };
}

/** Add per-repo reports up model by model, keeping each repo's own pricing. */
function sumReports(reports: SavingsReport[], period: string | null, days: number): AllReportTotal {
  const byModel = new Map<string, TotalModelSavings & { allMeasured: boolean }>();
  let savedTokens = 0;
  let usd = 0;
  let priced = false;
  let measured = true;
  let unpricedTokens = 0;

  for (const r of reports) {
    savedTokens += r.savedTokens;
    unpricedTokens += r.unpricedTokens;
    if (r.usd !== null) {
      priced = true;
      usd += r.usd;
      if (!r.measured) measured = false;
    }
    for (const m of r.models) {
      const acc = byModel.get(m.model) ?? {
        model: m.model, savedTokens: 0, costMicros: 0, tokensBilled: 0, value: null, unpricedTokens: 0, allMeasured: true,
      };
      acc.savedTokens += m.savedTokens;
      acc.costMicros += m.costMicros;
      acc.tokensBilled += m.tokensBilled;
      if (m.value) {
        acc.allMeasured &&= m.value.measured;
        acc.value = { usd: (acc.value?.usd ?? 0) + m.value.usd, measured: acc.allMeasured };
      } else {
        // A model with no list price that one repo was billed for (and so
        // priced) and another was not: only the priced share is in the dollars.
        acc.unpricedTokens += m.savedTokens;
      }
      byModel.set(m.model, acc);
    }
  }

  const models: TotalModelSavings[] = [...byModel.values()].map(({ allMeasured: _ignored, ...m }) => m);
  models.sort((a, b) => b.savedTokens - a.savedTokens || a.model.localeCompare(b.model));
  return {
    period,
    days,
    models,
    savedTokens,
    usd: priced ? usd : null,
    measured: priced && measured,
    unpricedTokens,
  };
}

/** A folder as people read it: `~/…` under the home folder, as given otherwise. */
function shownRoot(p: string, home: string = homedir()): string {
  const rel = relative(home, p);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? `~${sep}${rel}` : p;
}

/** The rendered readout of `graft savings --all`: one line per repo, then the
 * same per-model table a single repo prints, totalled across all of them. */
export function formatAllSavingsReport(r: AllSavingsReport): string {
  const scope = r.period ? `— ${r.period}` : '— all time';
  const gone = r.missing.length
    ? [
        `  (${r.missing.length} registered folder${r.missing.length === 1 ? ' has' : 's have'} no savings ledger any more: ${r.missing.map((m) => shownRoot(m)).join(', ')})`,
      ]
    : [];
  if (r.repos.length === 0) {
    const head = r.period
      ? `graft savings --all ${scope}: nothing recorded in that period in any repo.`
      : 'graft savings --all: nothing recorded yet in any repo — use graft in an agent session, then look again.';
    return [head, ...gone].join('\n');
  }

  type Row = { label: string; tokens: string; value: string; note: string };
  const priceNote = (v: { usd: number; measured: boolean } | null, unpriced = 0): string => {
    if (!v) return '(no rate — tokens only)';
    const notes = [v.measured ? '' : 'list rate', unpriced > 0 ? `excludes ~${formatCount(unpriced)} unpriced tokens` : ''].filter(Boolean);
    return notes.length ? `(${notes.join('; ')})` : '';
  };
  const repoRows: Row[] = r.repos.map((x) => ({
    label: shownRoot(x.root),
    tokens: `~${formatCount(x.report.savedTokens)} tokens`,
    value: x.report.usd === null ? '' : `~${formatDollars(x.report.usd)}`,
    note: priceNote(x.report.usd === null ? null : { usd: x.report.usd, measured: x.report.measured }, x.report.unpricedTokens),
  }));
  const modelRows: Row[] = r.total.models.map((m) => ({
    label: m.model,
    tokens: `~${formatCount(m.savedTokens)} tokens`,
    value: m.value ? `~${formatDollars(m.value.usd)}` : '',
    note: priceNote(m.value, m.unpricedTokens),
  }));
  const totalRow: Row = {
    label: 'total',
    tokens: `~${formatCount(r.total.savedTokens)} tokens`,
    value: r.total.usd === null ? '' : `~${formatDollars(r.total.usd)}`,
    note: r.total.unpricedTokens > 0 ? `(excludes ~${formatCount(r.total.unpricedTokens)} unpriced tokens)` : '',
  };

  const all = [...repoRows, ...modelRows, totalRow];
  const labelWidth = Math.max(...all.map((x) => x.label.length));
  const tokenWidth = Math.max(...all.map((x) => x.tokens.length));
  const valueWidth = Math.max(...all.map((x) => x.value.length));
  const line = (x: Row) =>
    `    ${x.label.padEnd(labelWidth)}  ${x.tokens.padStart(tokenWidth)}  ${x.value.padStart(valueWidth)}${x.note ? `  ${x.note}` : ''}`.trimEnd();

  const repoCount = `${r.repos.length} repo${r.repos.length === 1 ? '' : 's'}`;
  const dayCount = `${r.total.days} day${r.total.days === 1 ? '' : 's'} recorded`;
  return [
    `graft savings --all ${scope} · ${repoCount} · ${dayCount}`,
    '  per repo',
    ...repoRows.map(line),
    '  per model',
    ...modelRows.map(line),
    `    ${'─'.repeat(labelWidth + tokenWidth + valueWidth + 4)}`,
    line(totalRow),
    ...gone,
  ].join('\n');
}

/**
 * Make sure a repo whose ledger predates the registry is listed in it, without
 * moving its `lastSeen`. `graft savings` calls this for the repo it reports on,
 * so a repo used before cross-repo totals existed joins them the first time
 * anyone looks at its savings — the next saving filed there would add it anyway.
 */
export function registerExistingLedger(d: string): void {
  const file = ledgerPath(d);
  if (!existsSync(file)) return;
  registerRepo(d, file, { touch: false });
}
