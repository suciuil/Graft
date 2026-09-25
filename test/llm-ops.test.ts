/**
 * The three engine ops (summarize / synthesize / crux) over a fake transport —
 * proves each builds the right ChatRequest and parses the response, with no key
 * and no network. Structured ops (synthesize, crux) ride forced tool-calling;
 * summarize is plain text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatSummarizer } from "../src/ai/summarize.js";
import { ChatSynthesizer } from "../src/ai/synthesize.js";
import { ChatCruxSummarizer } from "../src/ai/crux.js";
import { recoverToolArgsFromContent } from "../src/ai/llm/recover-tool.js";
import type { ChatModel, ChatRequest, ChatResponse, ToolCall } from "../src/ai/llm/types.js";

/** Records the last request and replays a canned response. */
class FakeChatModel implements ChatModel {
  readonly label = "fake:model";
  last?: ChatRequest;
  constructor(private reply: { text?: string; toolCalls?: ToolCall[]; stopReason?: string }) {}
  async create(req: ChatRequest): Promise<ChatResponse> {
    this.last = req;
    return {
      text: this.reply.text ?? "",
      toolCalls: this.reply.toolCalls ?? [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      stopReason: this.reply.stopReason ?? "stop",
      assistant: { role: "assistant", content: this.reply.text ?? "" },
    };
  }
}

test("ChatSummarizer sends plain text and returns trimmed content", async () => {
  const m = new FakeChatModel({ text: "  a prose summary  " });
  const out = await new ChatSummarizer(m).summarize("code", { path: "a.ts" });
  assert.equal(out, "a prose summary");
  assert.equal(m.last?.responseFormat, undefined); // plain text
  assert.equal(m.last?.messages[0].role, "system");
});

test("ChatSynthesizer forces record_graph and cleans parsed args", async () => {
  const m = new FakeChatModel({
    toolCalls: [
      {
        id: "1",
        name: "record_graph",
        args: { nodes: [{ name: "Auth", type: "system", summary: "s", sources: ["a.ts"], links: [] }] },
      },
    ],
  });
  const nodes = await new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]);
  assert.deepEqual(m.last?.responseFormat, { kind: "tool", name: "record_graph" });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, "Auth");
});

test("ChatCruxSummarizer forces record_symbols and normalizes numbers", async () => {
  const m = new FakeChatModel({
    toolCalls: [
      { id: "1", name: "record_symbols", args: { symbols: [{ id: "sym1", summary: "does x", crux_start: 3.9, crux_end: 5 }] } },
    ],
  });
  const out = await new ChatCruxSummarizer(m).describeFile({
    path: "a.ts",
    source: "l1\nl2\nl3\nl4\nl5\n",
    nodes: [{ id: "sym1", kind: "function", signature: null, startLine: 1, endLine: 5 }],
  });
  assert.deepEqual(m.last?.responseFormat, { kind: "tool", name: "record_symbols" });
  assert.deepEqual(out, [{ id: "sym1", summary: "does x", crux_start: 3, crux_end: 5 }]);
});

test("structured ops degrade gracefully when the model returns no tool call", async () => {
  const empty = new FakeChatModel({ toolCalls: [] });
  const { err } = await withCapturedError(async () => {
    assert.deepEqual(await new ChatSynthesizer(empty).synthesize([{ path: "a.ts", summary: "x" }]), []);
    assert.deepEqual(
      await new ChatCruxSummarizer(empty).describeFile({
        path: "a.ts",
        source: "x",
        nodes: [{ id: "s", kind: "function", signature: null, startLine: 1, endLine: 1 }],
      }),
      [],
    );
  });
  assert.ok(err.some((l) => /synthesize:.*no tool call and no content/.test(l)));
  assert.ok(err.some((l) => /crux:.*no tool call and no content/.test(l)));
  assert.ok(err.some((l) => /\[finish_reason=stop\]/.test(l)));
});

test("empty-reply warning names the finish_reason and a length-exhaustion hint", async () => {
  const truncated = new FakeChatModel({ toolCalls: [], stopReason: "length" });
  const { err } = await withCapturedError(() =>
    new ChatCruxSummarizer(truncated).describeFile({
      path: "a.ts",
      source: "x",
      nodes: [{ id: "s", kind: "function", signature: null, startLine: 1, endLine: 1 }],
    }),
  );
  assert.ok(err.some((l) => /crux:.*token budget exhausted.*\[finish_reason=length\]/.test(l)));
});

/** Answers every target, unless the batch is too big: then an empty `stop` reply that spent the whole budget. */
class OutputCappedModel implements ChatModel {
  readonly label = "fake:capped";
  batches: number[] = [];
  prompts: string[] = [];
  constructor(private maxTargets: number) {}
  async create(req: ChatRequest): Promise<ChatResponse> {
    const prompt = String(req.messages[1]?.content ?? "");
    this.prompts.push(prompt);
    const ids = [...prompt.matchAll(/^- id=(\S+)/gm)].map((m) => m[1]!);
    this.batches.push(ids.length);
    const fits = ids.length <= this.maxTargets;
    const symbols = ids.map((id) => ({ id, summary: `does ${id}`, crux_start: 0, crux_end: 0 }));
    return {
      text: "",
      toolCalls: fits ? [{ id: "c", name: "record_symbols", args: { symbols } }] : [],
      usage: { input: 0, output: fits ? 100 : 8190, cacheRead: 0, cacheCreate: 0 },
      stopReason: "stop",
      assistant: { role: "assistant", content: "" },
    };
  }
}

const targets = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, kind: "function" as const, signature: null, startLine: 1, endLine: 1 }));

test("crux: a reply that spends the whole output budget is split and re-asked, silently", async () => {
  const m = new OutputCappedModel(10);
  const { result, err } = await withCapturedError(() =>
    new ChatCruxSummarizer(m).describeFile({ path: "a.ts", source: "x", nodes: targets(40) }),
  );
  assert.equal(result.length, 40);
  assert.deepEqual(m.batches, [40, 20, 10, 10, 20, 10, 10]);
  assert.deepEqual(err, [], "a split that recovers is not worth a warning");
});

test("crux: splitting stops at a small batch and reports the cap", async () => {
  const m = new OutputCappedModel(0);
  const s = new ChatCruxSummarizer(m);
  const { result, err } = await withCapturedError(() => s.describeFile({ path: "a.ts", source: "x", nodes: targets(5) }));
  assert.equal(result.length, 0);
  assert.deepEqual(m.batches, [5]);
  assert.equal(s.lastMiss?.kind, "truncated");
  assert.ok(err.some((l) => /token budget exhausted/.test(l)));
});

test("crux: a large file shows the lines around each target, not just the file's start", async () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`);
  const m = new OutputCappedModel(10);
  await new ChatCruxSummarizer(m).describeFile({
    path: "big.js",
    source: lines.join("\n"),
    nodes: [{ id: "deep", kind: "function", signature: null, startLine: 4800, endLine: 4805 }],
  });
  const prompt = m.prompts[0]!;
  assert.match(prompt, /^4800\tline 4800 /m);
  assert.match(prompt, /^4805\tline 4805 /m);
  assert.doesNotMatch(prompt, /^1\tline 1 /m);
  assert.match(prompt, /… \(lines 1-4799 omitted\)/);
});

const AUTH_NODE = { name: "Auth", type: "system", summary: "s", sources: ["a.ts"], links: [] as [] };
const AUTH_PAYLOAD = { nodes: [AUTH_NODE] };

test("#129: ChatSynthesizer recovers nodes from content JSON when toolCalls is empty", async () => {
  const m = new FakeChatModel({
    text: JSON.stringify([{ name: "emit_json", parameters: AUTH_PAYLOAD }]),
    toolCalls: [],
  });
  const { result: nodes, err } = await withCapturedError(() =>
    new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]),
  );
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, "Auth");
  assert.equal(err.length, 0);
});

test("#129: ChatSynthesizer recovers a single-object wrapper and a fenced JSON payload", async () => {
  const objectWrap = new FakeChatModel({
    text: JSON.stringify({ name: "record_graph", parameters: AUTH_PAYLOAD }),
    toolCalls: [],
  });
  assert.equal((await new ChatSynthesizer(objectWrap).synthesize([{ path: "a.ts", summary: "x" }]))[0]?.name, "Auth");

  const fenced = new FakeChatModel({
    text: "```json\n" + JSON.stringify(AUTH_PAYLOAD) + "\n```",
    toolCalls: [],
  });
  assert.equal((await new ChatSynthesizer(fenced).synthesize([{ path: "a.ts", summary: "x" }]))[0]?.name, "Auth");
});

test("#129: unparseable content warns and does not throw", async () => {
  const m = new FakeChatModel({ text: "The architecture is a layered monolith.", toolCalls: [] });
  const { result: nodes, err } = await withCapturedError(() =>
    new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]),
  );
  assert.deepEqual(nodes, []);
  assert.ok(err.some((l) => /synthesize:.*not parseable tool-call JSON/.test(l)));
});

test("#129: a real toolCalls payload is preferred over content JSON", async () => {
  const m = new FakeChatModel({
    text: JSON.stringify({ nodes: [{ name: "WRONG", type: "system", summary: "s", sources: ["a.ts"], links: [] }] }),
    toolCalls: [{ id: "1", name: "record_graph", args: AUTH_PAYLOAD }],
  });
  const nodes = await new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, "Auth");
});

const RECOVER_OPTS = { toolNames: ["record_graph", "emit_json"] as const, payloadKey: "nodes" };

test("#129: recoverToolArgsFromContent accepts the three issue shapes and refuses the rest", () => {
  const payload = { nodes: [{ name: "Auth" }] };
  assert.deepEqual(
    recoverToolArgsFromContent(JSON.stringify([{ name: "emit_json", parameters: payload }]), RECOVER_OPTS)?.nodes,
    payload.nodes,
  );
  assert.deepEqual(
    recoverToolArgsFromContent(JSON.stringify({ name: "record_graph", parameters: payload }), RECOVER_OPTS)?.nodes,
    payload.nodes,
  );
  assert.deepEqual(
    recoverToolArgsFromContent("```json\n" + JSON.stringify(payload) + "\n```", RECOVER_OPTS)?.nodes,
    payload.nodes,
  );
  // CodeQL js/polynomial-redos: spaces around a fence must stay linear and still parse.
  const padded =
    " ".repeat(8_000) + "```json" + " ".repeat(8_000) + JSON.stringify(payload) + " ".repeat(8_000) + "```";
  assert.deepEqual(recoverToolArgsFromContent(padded, RECOVER_OPTS)?.nodes, payload.nodes);
  assert.equal(recoverToolArgsFromContent("The architecture is a layered monolith.", RECOVER_OPTS), undefined);
  assert.equal(recoverToolArgsFromContent("", RECOVER_OPTS), undefined);
  assert.equal(
    recoverToolArgsFromContent('[{"name":"emit_json","parameters":{"nodes":[', RECOVER_OPTS),
    undefined,
  );
  assert.equal(
    recoverToolArgsFromContent(JSON.stringify([{ name: "other_tool", parameters: payload }]), RECOVER_OPTS),
    undefined,
  );
});

/** Capture console.error so tests can assert the #129 warnings without leaking them. */
async function withCapturedError<T>(fn: () => Promise<T>): Promise<{ result: T; err: string[] }> {
  const err: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    err.push(args.map((a) => String(a)).join(" "));
  };
  try {
    return { result: await fn(), err };
  } finally {
    console.error = orig;
  }
}
