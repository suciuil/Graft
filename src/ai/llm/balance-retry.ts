/**
 * Survive relay "insufficient balance" rejections instead of failing the build.
 *
 * API relays (one-api / new-api style resellers) answer
 * `403 Insufficient account balance` when the account has no usable tokens left.
 * The balance is often shared with other consumers — coding-agent sessions on the
 * same key can drain it in minutes — and refilled later by a top-up or a grant, so
 * the condition is real but temporary. Neither SDK retries a 403, and the failure
 * gate reads a 403 as a rejected key, so one such rejection aborted a `--deep`
 * build halfway through its synthesis batches.
 *
 * Two layers, both only for balance wording (a plain 403 is still a rejected key,
 * a quota/billing error is still terminal):
 *   1. A short exponential backoff, for a blip or a refill that is already on its way.
 *   2. A wait for a refill, up to GRAFT_BALANCE_WAIT_MS. Once the backoff is spent,
 *      ONE of the rejected calls is re-sent every poll interval and every other LLM
 *      call pauses on that same episode ({@link BalanceWaiter}); all resume the
 *      moment the relay accepts a call again. A balance rejection is refused by the
 *      relay before any model runs, so a re-send spends nothing.
 */
import type { ChatModel, ChatRequest, ChatResponse } from "./types.js";
import { transportRetries } from "./types.js";

/** Relay balance wording. Underscores/dashes cover error codes (`insufficient_balance`). */
const BALANCE_RE =
  /insufficient[\s_-]*(?:account[\s_-]*)?balance|balance[\s_-]*(?:is[\s_-]*)?(?:insufficient|not[\s_-]*enough)|not[\s_-]*enough[\s_-]*balance|余额不足/i;

/** True when an error (or its message) is a relay's insufficient-balance rejection. */
export function isRelayBalanceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return BALANCE_RE.test(message);
}

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A short relay name for the notices: the host of `baseUrl`, when it parses. */
export function relayName(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).hostname || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Waiting for a refill.
// ---------------------------------------------------------------------------

/** How a wait episode ended, for the callers waiting on it. */
type EpisodeOutcome = "restored" | "timeout";

/** What {@link BalanceWaiter.retryUntilRefilled} ended with: the re-sent call's own
 * result (this caller led the wait), a refill another caller saw, or a timeout. */
export type RefillResult<T> = { outcome: "done"; value: T } | { outcome: "restored" } | { outcome: "timeout" };

export interface BalanceWaiterOptions {
  /** Poll interval. Default 30s; env GRAFT_BALANCE_POLL_MS. */
  pollMs?: number;
  /** Longest one empty-balance episode is waited out. Default 30 min; env
   * GRAFT_BALANCE_WAIT_MS; 0 disables waiting (backoff only). */
  maxWaitMs?: number;
  /** Relay name for the notices. */
  name?: string;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  notice?: (line: string) => void;
}

/**
 * One wait per empty-balance episode, shared by every caller that hits the
 * rejection while it runs: the crux pass has several calls in flight, and they
 * should all resume together off one re-sent call rather than each polling the
 * relay on its own.
 */
export class BalanceWaiter {
  private episode: Promise<EpisodeOutcome> | null = null;
  /** Set when an episode timed out; cleared as soon as a call succeeds. */
  private gaveUp = false;
  private readonly pollMs: number;
  private readonly maxWaitMs: number;
  private readonly name: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly notice: (line: string) => void;

  constructor(opts: BalanceWaiterOptions = {}) {
    this.pollMs = Math.max(1, opts.pollMs ?? envMs("GRAFT_BALANCE_POLL_MS", 30_000));
    this.maxWaitMs = opts.maxWaitMs ?? envMs("GRAFT_BALANCE_WAIT_MS", 30 * 60_000);
    this.name = opts.name ?? "The relay";
    this.sleep = opts.sleep ?? sleepMs;
    this.now = opts.now ?? Date.now;
    // Leading newline: the build's progress line is `\r`-rewritten and has none.
    this.notice = opts.notice ?? ((line) => console.error(`\n${line}`));
  }

  /** True while an episode is running: a newly rejected call should join it. */
  get waiting(): boolean {
    return this.episode !== null;
  }

  /** A call went through: the balance is not empty, so a later empty episode is
   * waited out again rather than short-circuited by an earlier timeout. */
  succeeded(): void {
    this.gaveUp = false;
  }

  /**
   * Wait out an empty balance by re-sending the rejected call `fn` every poll
   * interval. The first caller leads: its re-sent call is the poll, and its result
   * is returned to it as `done`. Every caller that arrives while it runs waits on
   * the same episode and gets `restored` (retry at once) or `timeout`. A
   * non-balance error from the re-send ends the episode as `restored` for the
   * others (the balance is no longer what blocks them) and is thrown to the leader.
   */
  async retryUntilRefilled<T>(fn: () => Promise<T>): Promise<RefillResult<T>> {
    if (this.episode) return { outcome: await this.episode };
    // Disabled, or a previous episode already waited the full limit and no call has
    // gone through since: do not sit through another full wait for the same account.
    if (this.maxWaitMs <= 0 || this.gaveUp) return { outcome: "timeout" };

    let settle!: (outcome: EpisodeOutcome) => void;
    this.episode = new Promise<EpisodeOutcome>((resolve) => {
      settle = resolve;
    });
    const name = this.name;
    let outcome: EpisodeOutcome = "timeout";
    try {
      this.notice(
        `⏸ ${name} rejects calls for insufficient balance — pausing LLM calls until it is refilled ` +
          `(re-sending one call every ${formatDuration(this.pollMs)}, for up to ${formatDuration(this.maxWaitMs)}; ` +
          `GRAFT_BALANCE_WAIT_MS changes the limit). Nothing done so far is lost.`,
      );
      const started = this.now();
      const deadline = started + this.maxWaitMs;
      while (this.now() < deadline) {
        await this.sleep(Math.min(this.pollMs, deadline - this.now()));
        let value: T;
        try {
          value = await fn();
        } catch (err) {
          if (isRelayBalanceError(err)) continue;
          outcome = "restored";
          throw err;
        }
        outcome = "restored";
        this.gaveUp = false;
        this.notice(`▶ ${name} accepts calls again after ${formatDuration(this.now() - started)} — resuming.`);
        return { outcome: "done", value };
      }
      this.notice(
        `✗ ${name} still rejects calls for insufficient balance after ${formatDuration(this.maxWaitMs)} — ` +
          `giving up on the waiting calls.`,
      );
      this.gaveUp = true;
      return { outcome: "timeout" };
    } finally {
      this.episode = null;
      settle(outcome);
    }
  }
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const min = ms / 60_000;
  return `${Number.isInteger(min) ? min : min.toFixed(1)} min`;
}

// ---------------------------------------------------------------------------
// Retry loop.
// ---------------------------------------------------------------------------

export interface BalanceRetryOptions {
  /** Backoff retries after the first attempt. Default: {@link transportRetries} (GRAFT_LLM_RETRIES). */
  retries?: number;
  /** First backoff step. Default 2s; env GRAFT_BALANCE_RETRY_BASE_MS. */
  baseMs?: number;
  /** Cap on one backoff step. Default 60s; env GRAFT_BALANCE_RETRY_MAX_MS. */
  maxMs?: number;
  /** Waits out an empty balance by re-sending a rejected call once the backoff is
   * spent. Absent → backoff only. */
  waiter?: BalanceWaiter;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Called before each backoff; defaults to a one-line stderr notice. */
  onRetry?: (info: { attempt: number; retries: number; delayMs: number; error: unknown }) => void;
}

/**
 * Exponential backoff, capped, with jitter over the upper half of the step so
 * concurrent workers that were rejected together do not retry in lockstep.
 */
export function balanceRetryDelayMs(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const step = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(step / 2 + (random() * step) / 2);
}

/**
 * Run `fn`, handling ONLY relay balance errors: back off, then — with a waiter —
 * wait for a refill by re-sending (a refill retries at once and costs no retry).
 * Any other error — or the balance error once the wait times out or the retries
 * run out — is rethrown unchanged so the caller's failure gate classifies it.
 */
export async function withBalanceRetry<T>(fn: () => Promise<T>, opts: BalanceRetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? transportRetries();
  const baseMs = opts.baseMs ?? envMs("GRAFT_BALANCE_RETRY_BASE_MS", 2_000);
  const maxMs = opts.maxMs ?? envMs("GRAFT_BALANCE_RETRY_MAX_MS", 60_000);
  const sleep = opts.sleep ?? sleepMs;
  const waiter = opts.waiter;
  let attempt = 0;
  for (;;) {
    try {
      const value = await fn();
      waiter?.succeeded();
      return value;
    } catch (err) {
      if (!isRelayBalanceError(err)) throw err;
      // Once this call's backoff is spent — or at once when another call is already
      // waiting — wait for a refill by re-sending a rejected call.
      if (waiter && (waiter.waiting || attempt >= retries)) {
        const r = await waiter.retryUntilRefilled(fn);
        if (r.outcome === "done") return r.value;
        // Real tokens arrived: the call deserves a fresh try, not one of its retries.
        // Bounded by the balance itself — a new "restored" needs another drain+refill.
        if (r.outcome === "restored") continue;
        throw err;
      }
      if (attempt >= retries) throw err;
      const delayMs = balanceRetryDelayMs(attempt, baseMs, maxMs, opts.random);
      attempt++;
      (opts.onRetry ?? defaultNotice)({ attempt, retries, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}

function defaultNotice(info: { attempt: number; retries: number; delayMs: number; error: unknown }): void {
  const message = info.error instanceof Error ? info.error.message : String(info.error);
  console.error(
    `\n⚠ relay balance rejected the request (${message}) — retry ${info.attempt}/${info.retries} in ${(info.delayMs / 1000).toFixed(1)}s`,
  );
}

/** A {@link ChatModel} whose every call gets {@link withBalanceRetry}. */
export class BalanceRetryChatModel implements ChatModel {
  constructor(
    private inner: ChatModel,
    private opts: BalanceRetryOptions = {},
  ) {}

  /** Forwarded live: a provider-fallback model changes its label after switching. */
  get label(): string {
    return this.inner.label;
  }

  create(req: ChatRequest): Promise<ChatResponse> {
    return withBalanceRetry(() => this.inner.create(req), this.opts);
  }
}
