/**
 * The MCP tools, as pure functions over the existing engine.
 * `callTool` never throws — hosts get soft errors as isError content.
 */
import { Graft } from '../engine.js';
import { formatAsk, skeleton, formatSkeleton } from '../ask/ask.js';
import { formatCheckReport } from '../context/check.js';
import { formatGraphCheckReport } from '../graph/check.js';
import { loadGraphCached } from '../graph/load.js';
import { ensureFreshChildren, ensureFreshGraph, refreshNote } from '../graph/refresh.js';
import { contextDirFor } from '../context/node-file.js';
import { resolveSymbol, edgeWalk, type Direction, type EdgeHit } from '../graph/traverse.js';
import { callersSavings, headerOf, hitLine, looseNoteFor } from '../graph/traverse-cli.js';
import { withSavings, setPricing, setRepoRoot, setMcpSurface, setModelTable, sumSavingsFooters } from '../context/savings.js';
import { runInCallScope } from '../context/call-scope.js';
import { latestSession, sessionPricing } from '../claude/session-metrics.js';
import { kiloModelRows } from '../hosts/models.js';
import { isKiloClient } from './client.js';
import { UNKNOWN_MODEL, currentModel, recordSavedTokens, setAgentModel, setHostModel } from '../claude/ledger.js';
import { kiloSessionModel } from '../hosts/kilo-session.js';
import { grepGraph } from '../search/grep.js';
import { formatGrepResult, zeroHitNote } from '../search/grep-cli.js';
import { buildRepoMap, formatRepoMap } from '../graph/map.js';
import {
  federateAsk,
  federateCallers,
  federateCheck,
  federateGrep,
  federateMap,
  readWorkspace,
} from '../graph/workspace.js';
import type { NodeV1 } from '../graph/types.js';
import { canonicalToolName } from './tool-names.js';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

const NO_GRAPH = 'no graph found — run `graft build` first';

function unknownSymbolText(query: string): string {
  return `no symbol "${query}" in the graph — check spelling or run \`graft build\``;
}

/**
 * The `model` argument every tool accepts — MCP's equivalent of the CLI's
 * `--agent-model`.
 *
 * It exists because over MCP nothing else can name the model: no flag can be
 * passed and no transcript is stamped, so a saving would otherwise be priced at
 * nothing and filed in the lifetime ledger under `unknown`. The agent, however,
 * knows perfectly well what it is running — it simply had no way to say so.
 * This is that way.
 *
 * Deliberately on EVERY tool rather than in a one-off "declare your model" call:
 * a separate handshake tool is one the agent forgets, and a session that forgets
 * it silently reverts to unattributed savings. Riding along on the call that
 * already happens cannot be forgotten halfway.
 *
 * Optional throughout. An agent that omits it falls back to whatever the host's
 * own session record can say (`hosts/kilo-session.ts`), and to an unpriced token
 * count where even that is unavailable.
 *
 * The description is written as an instruction rather than a definition because
 * that is what it has to be: measured against real usage, a description that
 * merely NAMED the field was honoured on a small minority of calls. It is
 * phrased for an agent deciding what to put in an optional argument — say what
 * to send, give the shape of a valid value, and say what is lost by omitting it.
 */
const MODEL_PROP = {
  model: {
    type: 'string',
    description:
      'REQUIRED IN PRACTICE — send your own model id on every call, e.g. "claude-opus-5", "gpt-5.6-sol", "gemini-3.8-flash". This is the model YOU are running right now, not a model to use for anything: graft cannot see it, and uses it only to price the tokens this call saved and file them under that model. Omitting it files the saving as "unknown" and the user gets no dollar figure. Copy the id verbatim from your own configuration; do not guess a version number and do not leave it blank.',
  },
} as const;

/** Every tool's schema, with {@link MODEL_PROP} folded in. Applied here rather
 * than written into each schema by hand so a tool added later cannot quietly
 * miss it — the one property that must be on all of them. */
function withModelParam(tools: ToolDef[]): ToolDef[] {
  return tools.map((t) => {
    const schema = t.inputSchema as { properties?: Record<string, unknown> };
    return {
      ...t,
      inputSchema: {
        ...schema,
        properties: { ...(schema.properties ?? {}), ...MODEL_PROP },
      },
    };
  });
}

export const TOOLS: ToolDef[] = withModelParam([
  {
    name: 'graft_find_code',
    description:
      'Query the repo context graph in plain words. Returns ranked nodes with exact file:line spans and the relevant source inlined — usually the full answer, no file reads needed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'what you want to understand, in plain words' },
        limit: { type: 'number', description: 'max results (default 5)' },
        full: {
          type: 'boolean',
          description: 'inline whole definition spans instead of the default ≤8-line crux excerpts',
        },
        in: {
          type: 'string',
          description: 'narrow to nodes under this path prefix, filtered before scoring (segment-aware, like scopeOf)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'graft_file_api',
    description:
      "Signatures-only view of one file — every definition's signature + line span, ~10× cheaper than reading the file ($0, no LLM).",
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'repo-relative path (or unique basename) of the file' },
      },
      required: ['file'],
    },
  },
  {
    name: 'graft_check_freshness',
    description: 'Report whether the committed graph is in sync with the code (drift check).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'graft_trace_calls',
    description:
      'Structural edges for a symbol, over call/reference/import/implements/extends ($0, no LLM). Defaults to direct callers (who depends on it). Set direction:"out" for callees (what it calls); set depth>1 (or depth:"all" for the full closure) to walk transitively for the full blast radius — every source that breaks if it changes. Run before a multi-file refactor to find ALL affected files.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'bare name, qualified (Class.method), or package-qualified (pkg.Fn); a file path also works' },
        direction: {
          type: 'string',
          enum: ['in', 'out'],
          description: '"in" (default) = callers/dependents; "out" = callees/dependencies',
        },
        depth: { description: 'transitive walk depth for blast radius (default 1 = direct edges only); pass "all" for the full connected closure — every source that would be affected' },
        in: { type: 'string', description: 'narrow matches to nodes at or under this repo-relative path prefix, e.g. server/src' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'graft_find_all',
    description:
      'Regex search over the graph\'s indexed files, hits grouped by innermost enclosing symbol and ranked by incoming-edge count (coupling) — which hit matters, not just where it is.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'regex pattern (or literal string with fixed: true)' },
        in: { type: 'string', description: 'narrow to files at or under this repo-relative path prefix, e.g. server/src' },
        ignore_case: { type: 'boolean', description: 'case-insensitive match' },
        fixed: { type: 'boolean', description: 'treat pattern as a literal string, not a regex' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'graft_repo_map',
    description:
      'Token-budgeted repo orientation — directory clusters, per-directory hubs, and global hotspots computed purely from the wiring graph ($0, no LLM). Use this to get oriented in an unfamiliar repo before diving into files.',
    inputSchema: {
      type: 'object',
      properties: {
        max_dirs: { type: 'number', description: 'max directory entries shown, rest counted into dropped (default 16)' },
      },
    },
  },
]);

/** Render every resolved match's header + edge report (or the loud zero-edge
 * note), one block per match, joined with a blank line — the same grouping
 * `graft callers` uses for multi-match symbols. `showDepth` tags each hit with
 * its BFS depth (for transitive `depth>1` walks). */
function renderMatches(
  direction: Direction,
  showDepth: boolean,
  matches: NodeV1[],
  hitsFor: (n: NodeV1) => EdgeHit[],
): string {
  return matches
    .map((m) => {
      const hits = hitsFor(m);
      const lines = [headerOf(m)];
      if (hits.length === 0) lines.push(looseNoteFor(direction, m.name, matches.length));
      else for (const h of hits) lines.push(hitLine(direction, h, showDepth));
      return lines.join('\n');
    })
    .join('\n\n');
}

/** When the MCP server is rooted at a workspace parent, the ask/callers/grep/
 * map/check tools federate across the children — identical to the CLI. Returns
 * null for tools that don't federate (skeleton is per-file), so the caller
 * falls through to the normal single-graph path. */
async function callWorkspaceTool(
  root: string,
  dirOverride: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean } | null> {
  switch (name) {
    case 'graft_find_code': {
      const query = String(args.query ?? '');
      if (!query) return { text: 'graft_find_code requires a query', isError: true };
      const limit = typeof args.limit === 'number' ? args.limit : 5;
      const inArg = typeof args.in === 'string' && args.in ? args.in : undefined;
      const r = federateAsk(root, dirOverride, query, { limit, source: true, full: args.full === true, in: inArg });
      return { text: formatAsk(r), isError: false };
    }
    case 'graft_trace_calls': {
      const symbol = String(args.symbol ?? args.file ?? '');
      if (!symbol) return { text: 'graft_trace_calls requires a symbol', isError: true };
      const { text, found } = federateCallers(root, dirOverride, symbol, {
        direction: args.direction === 'out' ? 'out' : 'in',
        depth: typeof args.depth === 'number' && Number.isFinite(args.depth) ? args.depth : undefined,
        in: typeof args.in === 'string' && args.in ? args.in : undefined,
      });
      return { text, isError: !found };
    }
    case 'graft_find_all': {
      const pattern = String(args.pattern ?? '');
      if (!pattern) return { text: 'graft_find_all requires a pattern', isError: true };
      const { result, coverage } = federateGrep(root, dirOverride, pattern, {
        ignoreCase: typeof args.ignore_case === 'boolean' ? args.ignore_case : undefined,
        fixed: typeof args.fixed === 'boolean' ? args.fixed : undefined,
      });
      const text = result.totalHits === 0 ? zeroHitNote(result) : formatGrepResult(result);
      return { text: coverage ? `${text}\n${coverage}` : text, isError: false };
    }
    case 'graft_repo_map': {
      const maxDirs = typeof args.max_dirs === 'number' && Number.isFinite(args.max_dirs) && args.max_dirs > 0 ? args.max_dirs : undefined;
      return { text: federateMap(root, dirOverride, { maxDirs }), isError: false };
    }
    case 'graft_check_freshness': {
      const { text } = await federateCheck(root, dirOverride);
      return { text, isError: false };
    }
    default:
      return null;
  }
}

/** Tools whose whole job is to REPORT drift. Rebuilding first would make
 * `graft_check_freshness` answer about a graph it just fixed, i.e. always "OK". */
const NO_REFRESH_TOOLS = new Set(['graft_check_freshness']);

/**
 * The pre-0.8.1 tool names, still accepted, live in the dependency-free
 * `tool-names.ts` (shared with the engine-free session hooks). The names were the
 * reason for renaming: when a host defers graft's schemas it shows the model the
 * *names alone* — no descriptions — so `graft_ask` had to compete with `Grep` on
 * 9 characters. The new names say what they do; the aliases keep old callers
 * (skills, saved prompts, notes) from 404-ing. Re-exported here so existing
 * importers of `canonicalToolName` from this module keep working.
 */
export { canonicalToolName };

/**
 * One tool call, in its own state scope.
 *
 * The scope is what makes concurrent calls safe. This server is long-lived and
 * this function is `async`, so a client issuing two tool calls at once — which
 * JSON-RPC ids exist to permit — interleaves them at every `await`. With the
 * per-call facts (the model the agent named, the rate, the model table) in
 * module-level slots, the second call's model landed before the first had read
 * its own, and the first was priced, reported and filed under a model that never
 * ran it. `runInCallScope` gives each call storage its awaits can see and its
 * siblings cannot.
 */
export async function callTool(
  root: string,
  requestedName: string,
  args: Record<string, unknown>,
  dirOverride?: string,
): Promise<{ text: string; isError: boolean }> {
  return runInCallScope(() => callToolScoped(root, requestedName, args, dirOverride));
}

async function callToolScoped(
  root: string,
  requestedName: string,
  args: Record<string, unknown>,
  dirOverride?: string,
): Promise<{ text: string; isError: boolean }> {
  try {
    const name = canonicalToolName(requestedName);
    const ws = readWorkspace(root, dirOverride);
    // The agent naming itself on this call — MCP's `--agent-model`. Recorded
    // before pricing is resolved, because it is the highest-confidence thing
    // available on this surface: the model the agent says it is running, for the
    // very call being priced.
    setAgentModel(typeof args.model === 'string' ? args.model : null);
    // The backstop for when it doesn't, which measured against real usage is
    // most calls: a strong model sends `model` while the rule file is fresh in
    // context and stops as the conversation grows, and a fast model never sends
    // it at all. Kilo records the running model in its own session database, so
    // on that host the saving can be filed correctly regardless of whether the
    // agent cooperated. Gated on the client actually BEING Kilo for the same
    // reason the model table is: this reads Kilo's schema and nothing else's.
    // Ranked below the agent's own word (see `resolveModel`), so a cooperating
    // agent is unaffected by this line.
    setHostModel(isKiloClient() ? kiloSessionModel(root) : null);
    // Freshness first: an answer that cites file:line has to be about the code as
    // it is right now, including edits nobody has committed (or even saved through
    // this agent). ~3ms when nothing moved; a structural, $0 rebuild when it did.
    // Same reason as the CLI's `noteQuery`: price this session's tokens once,
    // here, so the formatters downstream can put a dollar figure in the nudge.
    setPricing(sessionPricing(root));
    setRepoRoot(root);
    // The unpriced nudge must not advise `--agent-model`, a CLI flag this
    // surface does not have — it advertises the `model` ARGUMENT instead.
    setMcpSurface(true);
    // The fallback for when no single model could be named at all: price the
    // saving under every model the host offers and let the user read their own
    // row. Gated on the client actually BEING Kilo, not merely on a Kilo config
    // existing — `readHostModels` can only read Kilo's config shapes, so on any
    // other client that config describes somebody else's models. Skipped once
    // anything has named the model, whether that was the agent or the host's own
    // session record above, since one exact figure beats a menu.
    const named = currentModel(root, latestSession(root)?.model) !== UNKNOWN_MODEL;
    setModelTable(!named && isKiloClient() ? kiloModelRows() : null);
    let note: string | null = null;
    if (!NO_REFRESH_TOOLS.has(name)) {
      const r = ws
        ? await ensureFreshChildren(root, ws.children, { contextDir: dirOverride })
        : await ensureFreshGraph(root, { contextDir: dirOverride });
      note = refreshNote(r);
    }
    const fed = ws ? await callWorkspaceTool(root, dirOverride, name, args) : null;
    const res = fed ?? (await callSingleTool(root, name, args, dirOverride));
    recordMcpSavings(root, res);
    return note ? { ...res, text: `${note}\n${res.text}` } : res;
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
}

/**
 * File this call's saving in the repo's lifetime ledger, the one `graft savings`
 * reads back.
 *
 * Here rather than in the hooks because this is the only place an MCP-driven
 * host reaches: Kilo and the other plain MCP clients expose no hook surface at
 * all, so a saving they made would otherwise never be recorded. (A host that
 * drives graft from a terminal instead — Copilot, which graft registers no MCP
 * server for — is covered by the CLI's own `postAction` writer.) The hooks skip
 * MCP calls for the ledger (`viaMcp` in session-metrics.ts) precisely so the two
 * can't both count the same call.
 *
 * The footer we just wrote is the source of the number, so no host cooperation
 * is needed to read it back.
 */
function recordMcpSavings(root: string, res: { text: string; isError: boolean }): void {
  // No accumulator reset needed: each call runs in its own scope (see
  // `runInCallScope` above), so its claimed-token counter starts at zero and
  // dies with the call. This used to be a manual `resetClaimedSavings()`, which
  // worked only because calls were assumed never to overlap.
  if (res.isError) return;
  const saved = sumSavingsFooters(res.text);
  if (saved > 0) recordSavedTokens(root, currentModel(root, latestSession(root)?.model), saved);
}

/** The single-graph path: every tool, answered from one repo's graph. */
async function callSingleTool(
  root: string,
  name: string,
  args: Record<string, unknown>,
  dirOverride?: string,
): Promise<{ text: string; isError: boolean }> {
  switch (name) {
      case 'graft_find_code': {
        const query = String(args.query ?? '');
        if (!query) return { text: 'graft_find_code requires a query', isError: true };
        const limit = typeof args.limit === 'number' ? args.limit : 5;
        const engine = new Graft({ contextDir: dirOverride });
        const inArg = typeof args.in === 'string' && args.in ? args.in : undefined;
        const r = engine.ask(root, query, { limit, source: true, full: args.full === true, in: inArg });
        return { text: formatAsk(r), isError: false };
      }
      case 'graft_file_api': {
        const file = String(args.file ?? '');
        if (!file) return { text: 'graft_file_api requires a file', isError: true };
        const r = skeleton(root, file, { contextDir: dirOverride });
        return { text: formatSkeleton(r), isError: !r.entries.length && !!r.note };
      }
      case 'graft_check_freshness': {
        const engine = new Graft({ contextDir: dirOverride });
        const r = engine.check(root);
        const g = await engine.checkGraph(root);
        const parts = [formatCheckReport(r)];
        if (!g.missing) parts.push(formatGraphCheckReport(g));
        return { text: parts.join('\n\n'), isError: false };
      }
      case 'graft_trace_calls': {
        // One tool covers callers (direction:in, the default), callees
        // (direction:out), and blast radius (depth>1). edgeWalk handles the
        // file-seed aggregation that the old graft_blast_radius did: for a
        // file at depth>1 it walks the file node AND every symbol defined in
        // it, so dependents that call into a symbol (targeting the SYMBOL id,
        // never the FILE id) aren't silently dropped.
        const symbol = String(args.symbol ?? args.file ?? '');
        if (!symbol) return { text: 'graft_trace_calls requires a symbol', isError: true };
        const w = loadGraphCached(contextDirFor(root, dirOverride));
        if (!w) return { text: NO_GRAPH, isError: true };
        const inOpt = typeof args.in === 'string' && args.in ? { in: args.in } : {};
        const matches = resolveSymbol(w, symbol, inOpt);
        if (matches.length === 0) return { text: unknownSymbolText(symbol), isError: true };
        const direction: Direction = args.direction === 'out' ? 'out' : 'in';
        // `depth: "all"` (or a huge number) walks the full transitive closure —
        // every connected source — terminating when no new node is reached.
        const depth =
          args.depth === 'all' || args.depth === 'full'
            ? Number.POSITIVE_INFINITY
            : typeof args.depth === 'number' && Number.isFinite(args.depth) && args.depth >= 1
              ? Math.floor(args.depth)
              : 1;
        const results = matches.map((m) => ({ symbol: m, hits: edgeWalk(w, m, direction, depth) }));
        const byId = new Map(results.map((r) => [r.symbol.id, r.hits]));
        const body = renderMatches(direction, depth > 1, matches, (m) => byId.get(m.id) ?? []);
        const text = withSavings(body, callersSavings(w, results));
        return { text, isError: false };
      }
      case 'graft_find_all': {
        const pattern = String(args.pattern ?? '');
        if (!pattern) return { text: 'graft_find_all requires a pattern', isError: true };
        const w = loadGraphCached(contextDirFor(root, dirOverride));
        if (!w) return { text: NO_GRAPH, isError: true };
        const result = grepGraph(w, root, pattern, {
          ignoreCase: typeof args.ignore_case === 'boolean' ? args.ignore_case : undefined,
          fixed: typeof args.fixed === 'boolean' ? args.fixed : undefined,
          in: typeof args.in === 'string' && args.in ? args.in : undefined,
        });
        if (result.totalHits === 0) return { text: zeroHitNote(result), isError: false };
        return { text: formatGrepResult(result), isError: false };
      }
      case 'graft_repo_map': {
        const w = loadGraphCached(contextDirFor(root, dirOverride));
        if (!w) return { text: NO_GRAPH, isError: true };
        const maxDirs = typeof args.max_dirs === 'number' && Number.isFinite(args.max_dirs) && args.max_dirs > 0 ? args.max_dirs : undefined;
        const map = buildRepoMap(w, { maxDirs });
        return { text: formatRepoMap(map), isError: false };
      }
    default:
      return { text: `unknown tool: ${name}`, isError: true };
  }
}
