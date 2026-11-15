/**
 * Automatic `graft prices update`, for a call that names a model graft has no
 * price for.
 *
 * Without this, such a call ended its savings tally with "⚠️ Run the 'graft
 * prices update' command — recommended", and the user had to run it by hand
 * before the next prompts were priced in dollars. When the user agreed to these
 * downloads, that step is pointless friction: graft downloads the list itself,
 * right then, prices the very call that needed it (or, when the download is slow,
 * a later one), and the tally says that the prices were updated for that model.
 *
 * It runs only when the user asked for it, in one of two ways:
 *
 *  - they answered "yes" to the Windows installer's question about automatic
 *    price updates (START-HERE-install-graft.cmd records the answer in
 *    ~/.graft/installer-choices.json, keyed on the download address; a "yes" to
 *    its one-off price list download alone does not count), and `graft prices
 *    auto` (GRAFT_PRICES_AUTO_UPDATE) is not off — on by default;
 *  - or they turned it on themselves with `graft prices auto on`.
 *
 * `graft prices auto off` turns it off whatever the installer recorded.
 *
 * The request is the same one `graft prices update` makes (`updatePriceCatalog`):
 * one anonymous GET of LiteLLM's WHOLE public catalog, so not even the model
 * being priced leaves the machine. It is fetching public data in, at the user's
 * request (docs/no-cloud-policy.md, "Not covered").
 *
 * Downloads are rationed, so a model LiteLLM does not list either does not cost
 * a 3 MB download on every call: at most one per model a day after a download
 * that did not price it, one an hour after a failed one, and none while the local
 * catalog is less than an hour old (somebody just updated it). The record of
 * those attempts sits next to the price catalog, and is ignored once the catalog
 * is newer than it (a `graft prices update` run by hand since). Graft processes
 * started side by side (an agent running several commands at once) share one
 * download through a lock file next to the catalog: the others wait for it.
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from '../util/state.js';
import { LITELLM_PRICES_URL, priceCatalogPath, readPriceCatalog, updatePriceCatalog } from './price-catalog.js';
import { canonicalModelKey, listRate, type Pricing } from './price.js';

/** The option: `graft prices auto [on|off]`. */
export const PRICES_AUTO_ENV = 'GRAFT_PRICES_AUTO_UPDATE';

/**
 * Set by the hooks on the graft processes they start (claude/hook-io.ts). Such a
 * process never downloads prices: the hook kills it after a few seconds (the prompt
 * hook's `graft ask` gets under 4 s), sooner than a download may take, so a download
 * there would only cost the prompt its graph context. The MCP server and the
 * agent's own CLI calls download instead.
 */
export const HOOK_CHILD_ENV = 'GRAFT_HOOK_CHILD';

/**
 * The installer's id for its price list question (`$PricesAnswerId` in
 * install-graft-helper.ps1). Keyed on the address, like the installer's: a "yes"
 * to downloading from one address is not a "yes" to another. A "yes" here is a
 * one-off download at install time only; it does not turn automatic updates on.
 */
export const INSTALLER_PRICES_ANSWER_ID = `prices-download|${LITELLM_PRICES_URL}`;

/**
 * The installer's id for its separate question about automatic updates
 * (`$PricesAutoAnswerId` in install-graft-helper.ps1), the only installer answer
 * that turns them on. Separate from {@link INSTALLER_PRICES_ANSWER_ID} because
 * "yes" to that one was given (or carried over from a downloaded price list, or
 * implied by `-Yes`) by users who were never told that graft would then download
 * by itself, in the background, whenever an agent names a new model.
 */
export const INSTALLER_PRICES_AUTO_ANSWER_ID = `prices-auto-update|${LITELLM_PRICES_URL}`;

const HOUR_MS = 3_600_000;
/** After a download that did not price the model: LiteLLM changes daily at most. */
export const MODEL_RETRY_MS = 24 * HOUR_MS;
/** After a failed download (offline, a proxy): try again, but not on every call. */
export const FAILED_RETRY_MS = HOUR_MS;
/** A local catalog younger than this is as current as a new download would be. */
export const FRESH_CATALOG_MS = HOUR_MS;
/** Shorter than `graft prices update`'s 30 s: a download that has not finished by then fails. */
const AUTO_TIMEOUT_MS = 15_000;
/**
 * How long the call being answered waits for a download. A download still
 * running after that goes on in the background (it is recorded when it ends)
 * and the call is answered without it, so a slow network costs a query at most
 * this much instead of the whole download timeout.
 */
export const AUTO_WAIT_MS = 3_000;
/** A lock older than this was left by a process that died mid-download. */
export const LOCK_STALE_MS = AUTO_TIMEOUT_MS + 15_000;
const LOCK_POLL_MS = 200;
/** The reason a download whose process ended before it did is reported with. */
const PENDING_REASON = 'the download did not finish: the graft process running it ended first';

const OFF_WORDS = new Set(['0', 'false', 'off', 'no']);

/** Where START-HERE-install-graft.cmd keeps the answers given to it. */
export function installerChoicesPath(home: string = homedir()): string {
  return join(home, '.graft', 'installer-choices.json');
}

/**
 * The day the user answered "yes" to the installer's question about automatic
 * price updates (`yyyy-MM-dd`, or "" when the installer recorded none), or null
 * when they did not: answered "no", were never asked (an installer from before
 * that question, or `-Yes`), never ran the installer, or the file cannot be read.
 */
export function installerPricesConsent(path: string = installerChoicesPath()): { date: string } | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(raw.replace(/^\uFEFF/, '')) as { answers?: Record<string, { value?: unknown; date?: unknown }> };
    const a = j?.answers?.[INSTALLER_PRICES_AUTO_ANSWER_ID];
    if (!a || typeof a.value !== 'string' || a.value.trim().toLowerCase() !== 'yes') return null;
    return { date: typeof a.date === 'string' ? a.date : '' };
  } catch {
    return null;
  }
}

/** Whether automatic price updates run here, and why. */
export interface AutoPricesState {
  on: boolean;
  /**
   * - `off`: `graft prices auto off` (GRAFT_PRICES_AUTO_UPDATE=0);
   * - `explicit`: `graft prices auto on`;
   * - `installer`: the option is at its default and the installer's question
   *   about automatic price updates was answered "yes" (on {@link date});
   * - `no-consent`: the option is at its default and nobody asked for downloads.
   */
  why: 'off' | 'explicit' | 'installer' | 'no-consent';
  /** `installer`: the day of that answer, when recorded. */
  date?: string;
}

export function autoPricesState(
  env: NodeJS.ProcessEnv = process.env,
  choicesPath: string = installerChoicesPath(),
): AutoPricesState {
  const raw = env[PRICES_AUTO_ENV]?.trim().toLowerCase();
  if (raw && OFF_WORDS.has(raw)) return { on: false, why: 'off' };
  if (raw) return { on: true, why: 'explicit' };
  const consent = installerPricesConsent(choicesPath);
  if (!consent) return { on: false, why: 'no-consent' };
  return { on: true, why: 'installer', ...(consent.date ? { date: consent.date } : {}) };
}

/** One model's last automatic attempt. */
interface Attempt {
  /** ISO time of the attempt. */
  at: string;
  ok: boolean;
  /**
   * Written as the download starts, and replaced by its result when it ends. One
   * left behind while no live process holds the lock is a download whose process
   * was killed first (a hook's child, a closed terminal): it counts as a failed
   * attempt, so the next calls do not each start, and lose, the same download.
   */
  pending?: boolean;
  /** `ok`: the fetch date of the catalog it stored. */
  fetchedAt?: string;
  /** not `ok`: why it failed. */
  reason?: string;
}

interface AttemptLog {
  version: 1;
  /** Keyed by {@link canonicalModelKey}. */
  models: Record<string, Attempt>;
}

/** Next to the price catalog, so `GRAFT_PRICES_FILE` moves both. */
export function autoPricesLogPath(pricesPath: string = priceCatalogPath()): string {
  return join(dirname(pricesPath), 'prices-auto-update.json');
}

function readLog(path: string): AttemptLog {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as Partial<AttemptLog>;
    if (j && j.version === 1 && j.models && typeof j.models === 'object') return { version: 1, models: j.models };
  } catch {
    // missing or unreadable: no attempts on record
  }
  return { version: 1, models: {} };
}

function writeLog(path: string, key: string, attempt: Attempt): void {
  try {
    const log = readLog(path);
    log.models[key] = attempt;
    writeJsonAtomic(path, log);
  } catch {
    // Not worth failing a query over: the worst case is one download too many.
  }
}

/** The lock graft processes take around a download, next to the catalog. */
export function autoPricesLockPath(pricesPath: string = priceCatalogPath()): string {
  return join(dirname(pricesPath), 'prices-auto-update.lock');
}

/** Whether a live process holds the lock (it exists and is not stale). */
function lockIsHeld(path: string): boolean {
  try {
    statSync(path);
  } catch {
    return false;
  }
  return !lockIsStale(path);
}

function lockIsStale(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS;
  } catch {
    return true; // gone in the meantime
  }
}

/**
 * Take the lock, or return false when another live process holds it. A lock
 * that cannot be taken at all (a read-only folder) does not stop the download:
 * that is the behaviour without a lock, one download too many at worst.
 */
function takeLock(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      closeSync(openSync(path, 'wx'));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return true;
      if (!lockIsStale(path)) return false;
      try {
        unlinkSync(path);
      } catch {
        // another process removed or replaced it first; try again
      }
    }
  }
  return false;
}

function releaseLock(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/**
 * Until the other process's download ends (its lock goes) or its lock goes
 * stale: true then, false when `maxMs` ran out first with the other download
 * still running.
 */
async function waitForLock(path: string, maxMs: number): Promise<boolean> {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    try {
      statSync(path);
    } catch {
      return true;
    }
    if (lockIsStale(path)) return true;
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  return false;
}

/**
 * A download of our own; `waited` when another process made one meanwhile;
 * `busy` when that other download was still running after as long as this
 * process would have given its own (it records its result itself).
 */
type DownloadResult = { fetchedAt: string } | { waited: true } | { busy: true };

/** One download at a time in this process: two overlapping MCP calls share it. */
let inFlight: Promise<DownloadResult> | null = null;

function download(opts: AutoPricesOptions, lockPath: string, onStart: () => void): Promise<DownloadResult> {
  if (!inFlight) {
    inFlight = (async (): Promise<DownloadResult> => {
      const timeoutMs = opts.timeoutMs ?? AUTO_TIMEOUT_MS;
      if (!takeLock(lockPath)) {
        return (await waitForLock(lockPath, Math.min(LOCK_STALE_MS, timeoutMs + 1_000))) ? { waited: true } : { busy: true };
      }
      try {
        onStart();
        const { catalog } = await updatePriceCatalog({
          fetchImpl: opts.fetchImpl,
          timeoutMs,
          now: opts.now,
        });
        return { fetchedAt: catalog.fetchedAt };
      } finally {
        releaseLock(lockPath);
      }
    })().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

export interface AutoPricesOptions {
  env?: NodeJS.ProcessEnv;
  /** The installer's answers file; tests point it elsewhere. */
  choicesPath?: string;
  fetchImpl?: typeof fetch;
  now?: number;
  /** When the download itself gives up (default 15 s). */
  timeoutMs?: number;
  /** How long the call waits for the download (default {@link AUTO_WAIT_MS}). */
  waitMs?: number;
}

/**
 * `pricing`, priced by a fresh download of LiteLLM's catalog when it names a
 * model graft has no price for and automatic updates are on. `autoUpdate` on
 * the result says what happened, for the savings tally:
 *
 *  - `updated`: downloaded just now (the rate is set when that priced the model);
 *  - `current`: not downloaded, because the catalog was updated recently and
 *    still lists no price for the model;
 *  - `pending`: the download took longer than `waitMs` and goes on in the
 *    background; a later call is priced (or told why not) once it has ended;
 *  - `failed`: the download failed, so the model stays unpriced.
 *
 * Returned unchanged — no network, no `autoUpdate` — whenever a rate is already
 * known, nothing named the model, automatic updates are off, or this process is a
 * hook's child ({@link HOOK_CHILD_ENV}). Never throws.
 */
export async function withAutoPrices(pricing: Pricing, opts: AutoPricesOptions = {}): Promise<Pricing> {
  try {
    const model = pricing.model;
    if (pricing.rate !== null || model.confidence !== 'certain' || !model.id) return pricing;
    const env = opts.env ?? process.env;
    if (env[HOOK_CHILD_ENV]) return pricing;
    if (!autoPricesState(env, opts.choicesPath ?? installerChoicesPath()).on) return pricing;
    const key = canonicalModelKey(model.id);
    if (!key) return pricing;
    const now = opts.now ?? Date.now();
    const pricesPath = priceCatalogPath();
    const logPath = autoPricesLogPath(pricesPath);
    const lockPath = autoPricesLockPath(pricesPath);

    const local = readPriceCatalog(pricesPath);
    const localAt = local ? Date.parse(local.fetchedAt) : NaN;

    const recorded = readLog(logPath).models[key];
    // A download still running in another process is waited for below, not
    // reported as failed: only one whose process died first counts as an attempt.
    const last = recorded?.pending && lockIsHeld(lockPath) ? undefined : recorded;
    const lastAt = last ? Date.parse(last.at) : NaN;
    // What the entry knew: the catalog its download stored, or the moment it
    // failed. A catalog newer than that came from somewhere else (a `graft prices
    // update` run by hand, mostly the one a failure line told the user to run),
    // so the entry no longer describes it.
    const lastSaw = last ? (last.ok ? Date.parse(last.fetchedAt ?? last.at) : lastAt) : NaN;
    const superseded = Number.isFinite(localAt) && Number.isFinite(lastSaw) && localAt > lastSaw;
    if (
      last &&
      !superseded &&
      Number.isFinite(lastAt) &&
      now - lastAt >= 0 &&
      now - lastAt < (last.ok ? MODEL_RETRY_MS : FAILED_RETRY_MS)
    ) {
      return last.ok
        ? { ...pricing, autoUpdate: { outcome: 'current', fetchedAt: last.fetchedAt ?? last.at } }
        : { ...pricing, autoUpdate: { outcome: 'failed', reason: last.reason ?? 'the download failed' } };
    }
    if (local) {
      const age = now - localAt;
      if (age >= 0 && age < FRESH_CATALOG_MS) {
        return { ...pricing, autoUpdate: { outcome: 'current', fetchedAt: local.fetchedAt } };
      }
    }

    const pending: Pricing = { ...pricing, autoUpdate: { outcome: 'pending' } };
    // Records its own result whenever it ends, so a download that outlives the
    // wait below still leaves the log (and the catalog) for the next call.
    const settled = (async (): Promise<Pricing> => {
      try {
        const result = await download(opts, lockPath, () =>
          writeLog(logPath, key, { at: new Date(now).toISOString(), ok: false, pending: true, reason: PENDING_REASON }),
        );
        if ('busy' in result) return pending;
        if ('fetchedAt' in result) {
          writeLog(logPath, key, { at: new Date(now).toISOString(), ok: true, fetchedAt: result.fetchedAt });
          return { rate: listRate(model), model, autoUpdate: { outcome: 'updated', fetchedAt: result.fetchedAt } };
        }
        // Another graft process downloaded while this one waited: its catalog is
        // the update, if it stored one.
        const after = readPriceCatalog(pricesPath);
        if (after && !(Date.parse(after.fetchedAt) <= localAt)) {
          writeLog(logPath, key, { at: new Date(now).toISOString(), ok: true, fetchedAt: after.fetchedAt });
          return { rate: listRate(model), model, autoUpdate: { outcome: 'updated', fetchedAt: after.fetchedAt } };
        }
        throw new Error('another graft process was updating the model prices, and they did not change');
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        writeLog(logPath, key, { at: new Date(now).toISOString(), ok: false, reason });
        return { ...pricing, autoUpdate: { outcome: 'failed', reason } };
      }
    })().catch(() => pending);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, opts.waitMs ?? AUTO_WAIT_MS));
      // The download, not this timer, decides whether the process stays up.
      timer.unref?.();
    });
    try {
      return (await Promise.race([settled, waited])) ?? pending;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return pricing;
  }
}
