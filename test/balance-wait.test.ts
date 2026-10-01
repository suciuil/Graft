/**
 * Waiting out an empty relay balance: instead of failing a `--deep` build when the
 * account's tokens run out, LLM calls pause on one shared re-sent call and resume
 * as soon as the relay accepts calls again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BalanceWaiter, relayName, withBalanceRetry } from "../src/ai/llm/balance-retry.js";

const balanceErr = () => Object.assign(new Error("403 Insufficient account balance"), { status: 403 });

/** A fake clock whose sleep advances time instantly. */
function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

test("relayName: the host of the base URL, or undefined", () => {
  assert.equal(relayName("https://relay.example.com/v1"), "relay.example.com");
  assert.equal(relayName("not a url"), undefined);
  assert.equal(relayName(undefined), undefined);
});

test("wait: once the backoff is spent, one call is re-sent per poll until the relay accepts it", async () => {
  const c = clock();
  const notices: string[] = [];
  const waiter = new BalanceWaiter({ ...c, pollMs: 30_000, maxWaitMs: 600_000, name: "relay.example.com", notice: (l) => notices.push(l) });
  let calls = 0;
  const backoffs: number[] = [];
  const out = await withBalanceRetry(
    async () => {
      if (++calls <= 5) throw balanceErr();
      return "done";
    },
    { retries: 2, waiter, sleep: c.sleep, random: () => 1, baseMs: 100, maxMs: 1_000, onRetry: (i) => backoffs.push(i.delayMs) },
  );
  assert.equal(out, "done");
  assert.equal(calls, 6, "first try + 2 backoff retries + 3 re-sends");
  assert.deepEqual(backoffs, [100, 200]);
  assert.deepEqual(c.sleeps, [100, 200, 30_000, 30_000, 30_000]);
  assert.match(notices[0], /relay\.example\.com rejects calls for insufficient balance — pausing/);
  assert.match(notices[1], /relay\.example\.com accepts calls again after 1\.5 min — resuming/);
});

test("wait: without a name the notices say 'The relay'", async () => {
  const c = clock();
  const notices: string[] = [];
  const waiter = new BalanceWaiter({ ...c, pollMs: 10, maxWaitMs: 1_000, notice: (l) => notices.push(l) });
  let calls = 0;
  await withBalanceRetry(
    async () => {
      if (++calls === 1) throw balanceErr();
      return "done";
    },
    { retries: 0, waiter, sleep: c.sleep },
  );
  assert.match(notices[0], /^⏸ The relay rejects calls/);
});

test("wait: the re-send that goes through returns its result and costs no backoff retry", async () => {
  const c = clock();
  let calls = 0;
  const waiter = new BalanceWaiter({ ...c, pollMs: 30_000, maxWaitMs: 600_000, notice: () => {} });
  const out = await withBalanceRetry(
    async () => {
      if (++calls === 1) throw balanceErr();
      return "done";
    },
    { retries: 0, waiter, sleep: c.sleep, onRetry: () => assert.fail("no backoff") },
  );
  assert.equal(out, "done");
  assert.equal(calls, 2);
  assert.deepEqual(c.sleeps, [30_000]);
});

test("wait: still rejected at the limit rethrows; the next call does not wait again until one goes through", async () => {
  const c = clock();
  const err = balanceErr();
  const waiter = new BalanceWaiter({ ...c, pollMs: 30_000, maxWaitMs: 90_000, notice: () => {} });
  let calls = 0;
  const failing = () =>
    withBalanceRetry(
      async () => {
        calls++;
        throw err;
      },
      { retries: 0, waiter, sleep: c.sleep },
    );
  await assert.rejects(failing(), (e) => e === err);
  assert.equal(calls, 4, "first try + 3 re-sends");
  assert.deepEqual(c.sleeps, [30_000, 30_000, 30_000], "never sleeps past the deadline");

  const slept = c.sleeps.length;
  await assert.rejects(failing(), (e) => e === err);
  assert.equal(c.sleeps.length, slept, "no second full wait");

  // A call that goes through clears the give-up: the next empty episode waits again.
  assert.equal(await withBalanceRetry(async () => "ok", { waiter }), "ok");
  await assert.rejects(failing());
  assert.equal(c.sleeps.length, slept + 3);
});

test("wait: concurrent rejected calls wait on one re-send loop and all resume", async () => {
  let open = false;
  let sends = 0;
  let wake!: () => void;
  const polled = new Promise<void>((r) => (wake = r));
  const waiter = new BalanceWaiter({
    pollMs: 10,
    maxWaitMs: 1_000,
    notice: () => {},
    sleep: async () => {
      await polled; // hold the leader until every caller has joined
      open = true;
    },
  });
  const call = (id: number) =>
    withBalanceRetry(
      async () => {
        sends++;
        if (!open) throw balanceErr();
        return id;
      },
      { retries: 0, waiter },
    );
  const all = Promise.all([call(1), call(2), call(3)]);
  await new Promise((r) => setImmediate(r));
  assert.equal(waiter.waiting, true);
  const before = sends;
  wake();
  assert.deepEqual(await all, [1, 2, 3]);
  assert.equal(before, 3, "each call was rejected once before the wait");
  assert.equal(sends, 6, "one re-send by the leader + one retry per follower");
});

test("wait: a non-balance error from the re-send is thrown to the leader and releases the others", async () => {
  let wake!: () => void;
  const polled = new Promise<void>((r) => (wake = r));
  let phase: "empty" | "broken" | "ok" = "empty";
  const waiter = new BalanceWaiter({
    pollMs: 10,
    maxWaitMs: 1_000,
    notice: () => {},
    sleep: async () => {
      await polled;
      phase = "broken";
    },
  });
  const call = () =>
    withBalanceRetry(
      async () => {
        if (phase === "empty") throw balanceErr();
        if (phase === "broken") {
          phase = "ok";
          throw Object.assign(new Error("500 upstream error"), { status: 500 });
        }
        return "ok";
      },
      { retries: 0, waiter },
    );
  const leader = call();
  const follower = call();
  await new Promise((r) => setImmediate(r));
  wake();
  await assert.rejects(leader, /500 upstream error/);
  assert.equal(await follower, "ok");
});

test("wait: waiting disabled keeps backoff-only behaviour", async () => {
  const waiter = new BalanceWaiter({ maxWaitMs: 0, notice: () => assert.fail("no wait"), sleep: async () => {} });
  let calls = 0;
  await assert.rejects(
    withBalanceRetry(
      async () => {
        calls++;
        throw balanceErr();
      },
      { retries: 2, waiter, sleep: async () => {}, onRetry: () => {}, random: () => 0 },
    ),
  );
  assert.equal(calls, 3);
});

test("wait: non-balance errors never start a wait", async () => {
  let calls = 0;
  const waiter = new BalanceWaiter({ notice: () => assert.fail("no wait"), sleep: async () => {} });
  await assert.rejects(
    withBalanceRetry(async () => {
      calls++;
      throw Object.assign(new Error("401 invalid api key"), { status: 401 });
    }, { retries: 0, waiter }),
  );
  assert.equal(calls, 1);
  assert.equal(waiter.waiting, false);
});
