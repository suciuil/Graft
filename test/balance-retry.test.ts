/**
 * Relay "insufficient balance" rejections are retried with backoff; everything
 * else passes straight through to the failure gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BalanceRetryChatModel,
  balanceRetryDelayMs,
  isRelayBalanceError,
  withBalanceRetry,
} from "../src/ai/llm/balance-retry.js";
import { ProviderFallbackChatModel } from "../src/ai/llm/factory.js";
import { LlmFailureGate, terminalReason } from "../src/ai/failure.js";
import type { ChatModel, ChatResponse } from "../src/ai/llm/types.js";

const OK: ChatResponse = {
  text: "ok",
  toolCalls: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
  stopReason: "stop",
  assistant: { role: "assistant", content: "ok" },
};
const balance = () => Object.assign(new Error("403 Insufficient account balance"), { status: 403 });
const noSleep = { sleep: async () => {}, onRetry: () => {}, random: () => 0 };

test("balance wording is recognised; auth, quota, and plain 403s are not", () => {
  for (const m of [
    "403 Insufficient account balance",
    "insufficient_balance",
    "Your account balance is insufficient",
    "balance not enough",
    "not enough balance to complete the request",
    "403 用户余额不足",
  ]) {
    assert.ok(isRelayBalanceError(new Error(m)), m);
  }
  for (const m of ["403 Forbidden", "401 invalid api key", "429 insufficient_quota", "500 upstream error"]) {
    assert.ok(!isRelayBalanceError(new Error(m)), m);
  }
});

test("backoff doubles per attempt, is capped, and jitters over the upper half", () => {
  assert.equal(balanceRetryDelayMs(0, 1000, 60_000, () => 0), 500);
  assert.equal(balanceRetryDelayMs(0, 1000, 60_000, () => 1), 1000);
  assert.equal(balanceRetryDelayMs(3, 1000, 60_000, () => 1), 8000);
  assert.equal(balanceRetryDelayMs(10, 1000, 60_000, () => 1), 60_000);
});

test("a transient balance rejection is retried until the call succeeds", async () => {
  let calls = 0;
  const delays: number[] = [];
  const out = await withBalanceRetry(
    async () => {
      if (++calls < 3) throw balance();
      return "done";
    },
    { retries: 5, baseMs: 100, maxMs: 1000, random: () => 1, sleep: async (ms) => void delays.push(ms), onRetry: () => {} },
  );
  assert.equal(out, "done");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("the balance error that outlives the last retry is rethrown unchanged", async () => {
  let calls = 0;
  const err = balance();
  await assert.rejects(
    withBalanceRetry(async () => {
      calls++;
      throw err;
    }, { retries: 2, ...noSleep }),
    (e) => e === err,
  );
  assert.equal(calls, 3);
});

test("non-balance errors are never retried here", async () => {
  let calls = 0;
  await assert.rejects(
    withBalanceRetry(async () => {
      calls++;
      throw Object.assign(new Error("401 invalid api key"), { status: 401 });
    }, { retries: 5, ...noSleep }),
  );
  assert.equal(calls, 1);
});

test("BalanceRetryChatModel wraps create() and forwards the live label", async () => {
  let calls = 0;
  const inner: ChatModel = {
    label: "relay:m",
    create: async () => {
      if (++calls === 1) throw balance();
      return OK;
    },
  };
  const m = new BalanceRetryChatModel(inner, { retries: 3, ...noSleep });
  assert.equal(m.label, "relay:m");
  assert.equal(await m.create({ messages: [{ role: "user", content: "hi" }] }), OK);
  assert.equal(calls, 2);
});

test("a balance 403 is not a wire rejection: the provider fallback is neither used nor burned", async () => {
  let fallbackCalls = 0;
  const primary: ChatModel = { label: "openai:m", create: async () => { throw balance(); } };
  const fallback: ChatModel = { label: "anthropic:m", create: async () => (fallbackCalls++, OK) };
  const m = new ProviderFallbackChatModel(primary, fallback);
  await assert.rejects(m.create({ messages: [{ role: "user", content: "hi" }] }), /Insufficient account balance/);
  assert.equal(fallbackCalls, 0);
  assert.equal(m.label, "openai:m");
});

test("an exhausted balance error is terminal with its own reason, not 'rejected the API key'", () => {
  assert.match(terminalReason("403 Insufficient account balance") ?? "", /insufficient account balance/);
  assert.match(terminalReason("403 Forbidden") ?? "", /rejected the API key/);
  const gate = new LlmFailureGate("batch");
  gate.record("403 Insufficient account balance");
  assert.ok(gate.stopped);
  assert.match(gate.fatal ?? "", /stopped after 1 failed batch\(s\)/);
});
