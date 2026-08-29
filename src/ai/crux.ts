/**
 * Tier-2 "meaning" call for the code graph — batched one request per file.
 *
 * Given a source file (with 1-based line numbers) and the list of definitions in
 * it, one call returns, for each definition:
 *   1. `summary` — one plain-English sentence: what the symbol is *for*, at the
 *      business-logic level, not a restatement of its signature.
 *   2. `crux_start`/`crux_end` — the smallest contiguous range of FILE line
 *      numbers (inside that symbol's own span) that a reviewer must read to see
 *      the decision or rule the code encodes. `0/0` means there is no single
 *      crux (a trivial getter, a plain data holder).
 *
 * Batching per file means N definitions cost one request, not N — and the model
 * sees each symbol's neighbours, which sharpens the summaries. Line numbers are
 * consumed once, at write time, to slice the crux text verbatim from source.
 */
import type { ChatModel } from "./llm/types.js";
import { recoverToolArgsFromContent, warnToolChoiceIgnored } from "./llm/recover-tool.js";
import type { Kind } from "../graph/types.js";

/** One definition we want described, located by its line span within the file. */
export interface NodeRef {
  id: string;
  kind: Kind;
  signature: string | null;
  startLine: number; // 1-based file line where the definition starts
  endLine: number;
}

export interface FileCruxInput {
  path: string;
  source: string;
  nodes: NodeRef[];
}

export interface NodeCrux {
  id: string;
  summary: string;
  crux_start: number; // file line, within the symbol's span; 0 = no distinct crux
  crux_end: number;
}

export interface CruxSummarizer {
  describeFile(input: FileCruxInput): Promise<NodeCrux[]>;
}

const SYSTEM_PROMPT = `You explain code definitions for a code graph that helps engineers navigate a codebase.

You are given ONE source file with 1-based line numbers, and a list of TARGET definitions in it. Describe EVERY target via the record_symbols tool.

Rules:
- Return EXACTLY ONE entry for EVERY target id, using that id verbatim. The number of entries you return MUST equal the number of targets. Never omit a target: a reply missing any id is invalid and will be re-requested.
- A trivial symbol is NOT an exception. You still return it — with a one-sentence summary and crux 0/0 (see below). "Skip" means "give it no crux span", NEVER "leave it out".
- summary: ONE sentence — what the symbol is FOR at the business-logic level (the problem it solves or the rule it enforces), not a restatement of its signature.
- crux_start / crux_end: FILE line numbers (as shown), inside that symbol's own line range. Pick the SINGLE most important contiguous span — the core branch, formula, guard, or state change — at most ~8 lines, and NEVER the whole function. When there is no single focal span (a trivial getter, a plain data holder, a one-line delegation, or logic spread evenly), use crux_start: 0 and crux_end: 0. That 0/0 IS the answer — do not drop the entry.`;

const RECORD_TOOL = "record_symbols";

const SYMBOLS_SCHEMA = {
  type: "object",
  properties: {
    symbols: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          summary: { type: "string" },
          crux_start: { type: "number" },
          crux_end: { type: "number" },
        },
        required: ["id", "summary", "crux_start", "crux_end"],
      },
    },
  },
  required: ["symbols"],
} as const;

/** Cap the file text sent per request so one huge file can't blow the context. */
const MAX_CODE_CHARS = 18_000;

function numberLines(source: string, nodes: NodeRef[]): string {
  const lines = source.split("\n");
  const first = Math.max(1, Math.min(...nodes.map((n) => n.startLine)));
  const last = Math.min(lines.length, Math.max(...nodes.map((n) => n.endLine)));
  const excerpt = lines.slice(first - 1, last);
  let chars = 0;
  const numbered: string[] = [];
  for (let i = 0; i < excerpt.length; i++) {
    const line = `${first + i}\t${excerpt[i]}`;
    if (chars + line.length + 1 > MAX_CODE_CHARS) {
      numbered.push("… (excerpt truncated)");
      break;
    }
    numbered.push(line);
    chars += line.length + 1;
  }
  return numbered.join("\n");
}

function userContent(input: FileCruxInput): string {
  const targets = input.nodes
    .map(
      (n) =>
        `- id=${n.id} | ${n.kind} | lines L${n.startLine}-L${n.endLine}` +
        (n.signature ? ` | ${n.signature}` : ""),
    )
    .join("\n");
  const n = input.nodes.length;
  return `FILE: ${input.path}\n\n${numberLines(input.source, input.nodes)}\n\nTARGETS (${n} — return all ${n}, one entry per id):\n${targets}`;
}

/** Normalize the tool's parsed argument object into a {@link NodeCrux} list. */
function parseResults(obj: { symbols?: unknown } | undefined): NodeCrux[] {
  if (!obj || !Array.isArray(obj.symbols)) return [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
  return obj.symbols
    .map((s) => s as Record<string, unknown>)
    .filter((s) => typeof s.id === "string")
    .map((s) => ({
      id: s.id as string,
      summary: typeof s.summary === "string" ? s.summary.trim() : "",
      crux_start: num(s.crux_start),
      crux_end: num(s.crux_end),
    }));
}

/**
 * Some OpenAI-compatible gateways ignore forced `tool_choice` and put the tool
 * payload in `content` instead (plain `{symbols:…}`, fenced JSON, or an emulated
 * `[{name, parameters}]` array). Without this recovery the meaning pass sees an
 * empty `toolCalls` list, leaves every node `pending`, and `graft check` loops
 * on "run --deep" forever (#172; same trigger as #129 for the crux path).
 */
function argsFromResponse(res: { text: string; toolCalls: { name: string; args: unknown }[] }): {
  symbols?: unknown;
} | undefined {
  const call = res.toolCalls.find((c) => c.name === RECORD_TOOL) ?? res.toolCalls[0];
  if (call?.args && typeof call.args === "object" && !Array.isArray(call.args)) {
    return call.args as { symbols?: unknown };
  }
  const recovered = recoverToolArgsFromContent(res.text, {
    toolNames: [RECORD_TOOL, "emit_json"],
    payloadKey: "symbols",
  });
  if (!recovered) warnToolChoiceIgnored("crux", res.text?.trim() ? "unparsed" : "empty");
  return recovered as { symbols?: unknown } | undefined;
}

/**
 * Map a returned `id` back onto a real target id.
 *
 * The targets are listed to the model as `- id=<id> | <kind> | lines L1-L14 | <sig>`,
 * and some models echo that whole descriptor line back as the id instead of the
 * bare value. Exact-matching those entries drops them, and a file where EVERY
 * entry is echoed that way then looks like a total miss — enrich reports "model
 * returned no usable symbol summaries", the failure gate counts the file, and a
 * run of them aborts the whole `--deep` pass, discarding summaries that were
 * perfectly good. Recover the intended target instead: strip an `id=` prefix and
 * anything from the first field separator on. Null when it still matches nothing,
 * so a genuinely hallucinated id is still dropped.
 */
function resolveTargetId(raw: string, valid: ReadonlySet<string>): string | null {
  const direct = raw.trim();
  if (valid.has(direct)) return direct;
  // Peel one layer at a time, re-checking after each: the list marker `userContent`
  // writes (`- `), then the `id=` label, then the trailing ` | kind | lines …`
  // fields. Checking between steps means an id that legitimately contains one of
  // these characters is matched before the next peel can corrupt it.
  let s = direct.replace(/^[-*\u2022]\s+/, "");
  if (valid.has(s)) return s;
  s = s.replace(/^id\s*=\s*/, "");
  if (valid.has(s)) return s;
  const bar = s.indexOf("|");
  if (bar >= 0) s = s.slice(0, bar);
  s = s.trim();
  return valid.has(s) ? s : null;
}

/** Crux summarizer backed by any {@link ChatModel} via forced tool calling. */
export class ChatCruxSummarizer implements CruxSummarizer {
  constructor(private model: ChatModel) {}

  async describeFile(input: FileCruxInput): Promise<NodeCrux[]> {
    if (input.nodes.length === 0) return [];
    const res = await this.model.create({
      temperature: 0,
      maxTokens: 8192,
      tools: [
        {
          name: RECORD_TOOL,
          description: "Record each target definition's purpose and crux line range.",
          parameters: SYMBOLS_SCHEMA as unknown as Record<string, unknown>,
        },
      ],
      responseFormat: { kind: "tool", name: RECORD_TOOL },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent(input) },
      ],
    });
    const valid = new Set(input.nodes.map((n) => n.id));
    const seen = new Set<string>();
    const out: NodeCrux[] = [];
    for (const entry of parseResults(argsFromResponse(res))) {
      const id = resolveTargetId(entry.id, valid);
      if (!id || seen.has(id)) continue;
      // A blank summary is not a result — enrich leaves such a node `pending`
      // (#172). Do NOT claim the target id for one: `collectFileCrux` keys its
      // re-ask off `results.has(id)`, so claiming it here would silently spend
      // the retry that would otherwise fetch a real summary.
      if (!entry.summary.trim()) continue;
      // Keep the first usable entry per target: a model that echoes one id two
      // ways must not overwrite a good summary with a worse duplicate.
      seen.add(id);
      out.push({ ...entry, id });
    }
    return out;
  }
}
