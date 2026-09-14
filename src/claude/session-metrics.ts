/**
 * Session usage accounting, shared across every host (Claude Code, Cursor, and
 * plain MCP). It answers the one question the README rests on: when an agent had
 * both graft and grep in front of it, which did it reach for, and how much did
 * that save?
 *
 * The counters (`graftReads`, `sourceReads`, `savedTokens`) already live on
 * {@link SessionState}; before this module nothing ever incremented the first
 * two, so `session_summary` telemetry shipped 0/0 for every session. Everything
 * here is a pure classify + read-modify-write over `graft/.cache/session/`, so a
 * host adapter is a few lines: parse its payload, call {@link recordToolUse}.
 *
 * Two payload shapes feed it, confirmed against the vendor docs rather than
 * guessed (the matcher depends on getting the names right):
 *
 *   - Claude Code `PostToolUse`  — `{ tool_name, tool_input: { command }, tool_response }`.
 *     A graft retrieval prints a `[graft] tokens saved ≈ N` footer into
 *     `tool_response`, which is itself proof graft ran.
 *   - Cursor `postToolUse`       — `{ tool_name, tool_input, tool_output, conversation_id }`
 *     (https://cursor.com/docs/hooks). `tool_output` is the JSON-stringified
 *     result; a Shell `graft …` call carries the same footer inside its stdout.
 *   - Cursor `afterMCPExecution` — `{ tool_name, tool_input, result_json, duration }`.
 *     Fires only for MCP tools, so a graft tool is recognised by its name and
 *     its savings read out of `result_json`.
 *
 * MCP tool names arrive host-prefixed in different shapes (`graft_find_code`,
 * `MCP:graft_find_code`, `mcp__graft__graft_find_code`). {@link isGraftMcpTool}
 * strips the prefix to the last delimited segment and checks it against the real
 * name list (`GRAFT_MCP_TOOL_NAMES`), so a graft tool is recognised across every
 * host format while a third-party tool that merely contains "graft" is not.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { formatCount, sumSavingsFooters } from '../context/savings.js';
import {
  blendedRate,
  formatDollars,
  pricingFor,
  valueSaved,
  type InputRate,
  type Pricing,
} from '../context/price.js';
import { agentModel, currentModel, recordSavedTokens } from './ledger.js';
import { withHostLabel } from '../hosts/models.js';
import { readSession, writeSession, sessionDir, listSessionIds, type SessionState } from './state.js';
import type { AgentHost } from '../telemetry/contract.js';
import { GRAFT_MCP_TOOL_NAMES } from '../mcp/tool-names.js';

export type ToolKind = 'graft' | 'source';

/** Native tools that mean "the agent went to read source itself" — the grep/read
 *  path graft is meant to replace. These are the host tool NAMES (Claude Code and
 *  Cursor both use Read/Grep/Glob; Cursor adds Search); shell builtins like `ls`
 *  are commands, never tool names, so they belong to the Shell branch, not here.
 *  Compared lower-cased. */
const SOURCE_TOOLS = new Set(['read', 'grep', 'glob', 'search']);

/** The host's shell tool, whose `command` we then inspect for a graft invocation. */
function isShellTool(t: string): boolean {
  return t === 'bash' || t === 'shell';
}

/** An MCP-style tool name (server-prefixed), as opposed to a native Read/Shell.
 *  Used to hand graft MCP calls to the dedicated MCP hook so a host that fires
 *  BOTH a generic post-tool hook and an MCP hook can't double-count them. */
export function isMcpToolName(toolName: string): boolean {
  const t = toolName.toLowerCase();
  return t.startsWith('mcp') || t.includes(':') || t.includes('__');
}

/**
 * Whether a tool name is one of graft's MCP tools, across every host prefix.
 * Anchored on the real name list (`graft_find_code`, its legacy aliases, …), not
 * a loose `includes('graft')`: a third-party MCP tool whose name merely contains
 * "graft" (or a repo working on graft itself) must not count as a graft read —
 * the same care `commandInvokesGraft` takes for the CLI side. Strips the host
 * prefix first (`mcp__graft__graft_find_code`, `MCP:graft_find_code`) by taking
 * the last delimited segment. */
export function isGraftMcpTool(toolName: string): boolean {
  const t = toolName.toLowerCase();
  const bare = t.split(/[:./]|__/).pop() ?? t;
  return GRAFT_MCP_TOOL_NAMES.has(bare);
}

/** Whether a shell command line invokes the graft CLI (any of its install shapes). */
export function commandInvokesGraft(command: string): boolean {
  const c = command.trim();
  if (/dist[/\\]cli\.js/.test(c)) return true; // running from a source checkout
  // `graft …`, `graft-dev …`, `npx [-y] [@nanonets/]graft …`, at the start of the
  // line or of a &&/;/| segment — not "mygraft" or a path that merely contains it.
  return /(^|[|&;]\s*)(npx\s+(-y\s+)?(@nanonets\/)?)?graft(-dev)?\b/i.test(c);
}

/**
 * Classify one tool use as a graft retrieval, a source read, or neither
 * (an edit, a task spawn, an unrelated shell command — no retrieval signal).
 * `command` is the shell command line when `toolName` is the host's shell tool.
 */
export function classifyToolUse(toolName?: string, command?: string): ToolKind | null {
  const t = (toolName ?? '').toLowerCase();
  if (!t) return null;
  if (isGraftMcpTool(t)) return 'graft';
  if (SOURCE_TOOLS.has(t)) return 'source';
  if (isShellTool(t) && command && commandInvokesGraft(command)) return 'graft';
  return null;
}

/** Sum every `[graft] tokens saved ≈ N` footer in a blob of tool output. Thin
 *  alias over {@link sumSavingsFooters}, which lives next to the code that writes
 *  the footer so the two can't drift. */
export function parseSavings(blob: string): number {
  return sumSavingsFooters(blob);
}

export interface ToolUse {
  /** 'graft' → graftReads++, 'source' → sourceReads++, null/absent → neither. */
  kind?: ToolKind | null;
  /** Tokens the retrieval saved, parsed from its footer. Added to the running total. */
  savedTokens?: number;
  /** The host recording this use. Stamped on the session file (once) so the
   * `session_summary` is attributed correctly no matter which host later flushes it. */
  host?: AgentHost;
  /** This call went through graft's own MCP server, which files its own ledger
   * entry for it (see `mcp/tools.ts`). The session counters below still want it;
   * the lifetime ledger would count it twice. */
  viaMcp?: boolean;
}

/**
 * Fold one tool use into a session's counters. A no-op when there is nothing to
 * record (kind null and no savings), so a host can call it unconditionally after
 * every tool without first checking whether the tool was interesting — the
 * no-write path is what keeps it cheap on the Write/Edit/Task majority.
 *
 * Best-effort read-modify-write, not locked — mirroring `patchStats` in
 * util/state.ts. Two tool-use hooks racing on the same session file can lose a
 * count; that is acceptable for an episodic usage estimate (worst case is an
 * undercount by one, never corruption thanks to the atomic write), and a lock
 * here would contend with the build lock these hooks also touch.
 */
export function recordToolUse(dir: string, sessionId: string, use: ToolUse): void {
  const saved = use.savedTokens ?? 0;
  if (!use.kind && saved <= 0) return;
  const id = sessionId || 'default';
  const s = readSession(dir, id);
  if (use.kind === 'graft') s.graftReads = (s.graftReads ?? 0) + 1;
  else if (use.kind === 'source') s.sourceReads = (s.sourceReads ?? 0) + 1;
  if (saved > 0) {
    s.savedTokens = (s.savedTokens ?? 0) + saved;
    // Also into the repo's lifetime ledger, under whichever model is running:
    // the session file is what `graft stats` reads, the ledger what `graft
    // savings` reads back months later. MCP calls are excluded because the MCP
    // server already filed them — it runs on every host, hooks only on two.
    if (!use.viaMcp) recordSavedTokens(dir, currentModel(dir, s.model), saved);
  }
  // A graft use owes a tally in this turn's reply; the Stop hook (countTallyTurn)
  // resolves whether it got one and clears the flag. A flag, not a count — a turn
  // with several graft calls is still one reply to the user.
  if (use.kind === 'graft') s.turnUsedGraft = true;
  // Stamp the host once; the first tool use that lands owns the attribution.
  if (use.host && !s.host) s.host = use.host;
  writeSession(dir, id, s);
}

export interface SessionSummary extends SessionState {
  id: string;
}

/** The most-recently-touched session file for a repo, or null when none exist —
 *  what `graft stats` shows by default: the session you were just in. */
export function latestSession(dir: string): SessionSummary | null {
  const sdir = sessionDir(dir);
  let bestId: string | null = null;
  let bestMtime = -Infinity;
  for (const id of listSessionIds(dir)) {
    let mtime: number;
    try { mtime = statSync(join(sdir, `${id}.json`)).mtimeMs; } catch { continue; }
    if (mtime > bestMtime) { bestMtime = mtime; bestId = id; }
  }
  if (bestId === null) return null;
  return { id: bestId, ...readSession(dir, bestId) };
}

/**
 * A one-line-per-fact readout of a session's usage mix — Cursor has no
 * statusline, so this is how you see the numbers the Claude Code bar would show.
 * Reads local JSON only; sends nothing.
 */
/**
 * What this repo's most recent session pays per million input tokens, the model
 * behind that price, and how sure we are of the model.
 *
 * Prefers the session's own blended rate — what the user was actually billed,
 * cache discounts and all, which only Claude Code's transcript exposes — and
 * falls back to the list price for a model the agent NAMED, via `--agent-model`
 * or a transcript stamp. There is no third source: a host that reports no
 * billing and names no model is simply unpriced, and says so. (It used to fall
 * back to a `model` field in `.graft/config.json` or a `$/Mtok` env override;
 * both were removed, because a standing declaration keeps producing confident
 * numbers long after the user has switched models.)
 *
 * The result always carries the model knowledge, even when it carries no rate:
 * "we cannot price this" is only useful to a reader if it also says WHICH model
 * went unpriced — and, on Kilo, it is what selects the per-model table instead.
 *
 * `latestSession` rather than a session id because the callers are CLI and MCP
 * processes answering one query: they know the repo, never the host's session
 * id. The rate belongs to the repo's current session, which is the one whose
 * reply the number is about to appear in.
 */
export function sessionPricing(dir: string): Pricing {
  const s = latestSession(dir);
  // The host's display name is attached here rather than at the naming site:
  // `--agent-model` and a transcript stamp both carry a wire id, while the user
  // picked that model from a menu showing something friendlier.
  const model = withHostLabel(agentModel(dir, s?.model));
  return pricingFor(model, blendedRate(s?.inputCostMicros, s?.inputTokensBilled));
}

/** Just the rate, for the surfaces (stats readout) that show a number and never
 * have to explain its absence. */
export function sessionInputRate(dir: string): InputRate | null {
  return sessionPricing(dir).rate;
}

export function formatSessionStats(s: SessionSummary | null, rate: InputRate | null = null): string {
  if (s === null) {
    return 'graft stats: no session recorded yet — use graft in an agent session, then look again.';
  }
  const graft = s.graftReads ?? 0;
  const source = s.sourceReads ?? 0;
  const saved = s.savedTokens ?? 0;
  const total = graft + source;
  const mix =
    total === 0 ? 'no retrieval yet' : `${Math.round((graft / total) * 100)}% graft`;
  const lines = [
    `graft stats — session ${s.id}`,
    `  graft reads:   ${graft}`,
    `  source reads:  ${source}   (Read / Grep / Glob)`,
    `  mix:           ${mix}`,
    `  tokens saved:  ~${formatCount(saved)}`,
  ];
  // Omitted, not zeroed, when there is no rate at all: a host whose hooks name
  // no transcript can't know what a token costs here, and unless the agent
  // named its model, a made-up rate would be worse than the silence.
  const value = valueSaved(saved, blendedRate(s.inputCostMicros, s.inputTokensBilled) ?? rate);
  if (value !== null) {
    const note = value.measured ? '' : '   (list rate — this host reports no billing)';
    lines.push(`  value saved:   ~${formatDollars(value.usd)}${note}`);
  }
  if (s.lastQuery) lines.push(`  last query:    ${s.lastQuery}`);
  return lines.join('\n');
}
