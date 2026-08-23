/**
 * Tier-2 pass: attach the LLM meaning layer (`summary` + `crux`) to nodes.
 *
 * graph.json is its own cache — the committed file already holds every node's
 * summary/crux from a prior run. So this pass is diff-driven:
 *
 *   - cache hit  — a prior node with the same id, same `body_hash`, and
 *     `summary_state:"ready"` → carry its summary/crux over, no LLM call.
 *   - stale      — a prior ready summary whose body has since changed → keep the
 *     old text as a hint but mark it "stale". Recomputed only if an LLM is given.
 *   - pending    — new or never-summarized node → one LLM call when an LLM is
 *     given, otherwise left "pending".
 *
 * Passing no summarizer runs the cache/stale bookkeeping alone (no calls, no
 * cost) — which is what a plain `graph` build does, so it never wipes the
 * meaning layer a previous `--llm` run produced.
 *
 * The LLM returns line numbers into the slice it was shown; we consume them here,
 * once, to cut `crux.code` verbatim from the source. `crux.span` is a pointer
 * only and is never used to re-slice.
 */
import type { CruxSummarizer, NodeCrux, NodeRef } from "../ai/crux.js";
import type { Crux, NodeV1 } from "./types.js";

/** Cap on the stored crux: an over-long pick is trimmed to its leading slice. */
const MAX_CRUX_LINES = 12;

/** Files summarized at once. Each file is independent; order is preserved. */
const DEFAULT_CONCURRENCY = 5;
/** Keep forced-tool responses bounded; large generated Kotlin files can expose 800+ symbols. */
const MAX_TARGETS_PER_REQUEST = 40;

export interface EnrichOptions {
  /** When present, (re)compute meaning for stale/pending nodes. Absent → cache only. */
  summarizer?: CruxSummarizer;
  /** Max files summarized in parallel (each is one LLM call). Default {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number;
  /** Progress is reported per file (one LLM call each), as files finish — not per node. */
  onProgress?: (info: { index: number; total: number; node: string }) => void;
}

export interface EnrichStats {
  cached: number; // carried over from a prior identical body
  computed: number; // freshly summarized by the LLM this run
  stale: number; // body changed, left with an outdated summary (no LLM this run)
  pending: number; // never summarized and not computed this run
  errors: string[];
}

export async function enrichGraph(
  nodes: NodeV1[],
  prior: Map<string, NodeV1>,
  sources: Map<string, string>,
  opts: EnrichOptions = {},
): Promise<EnrichStats> {
  const stats: EnrichStats = { cached: 0, computed: 0, stale: 0, pending: 0, errors: [] };

  // Which nodes actually need an LLM call this run (after cache carry-over).
  const dirty: NodeV1[] = [];

  for (const node of nodes) {
    const was = prior.get(node.id);
    if (was?.summary_state === "ready" && was.body_hash === node.body_hash) {
      node.summary = was.summary;
      node.crux = was.crux;
      node.summary_state = "ready";
      stats.cached++;
      continue;
    }
    // needs computing; seed with the old summary as a stale hint when one exists.
    if (was && was.summary) {
      node.summary = was.summary;
      node.crux = was.crux;
      node.summary_state = "stale";
    }
    dirty.push(node);
  }

  if (!opts.summarizer) {
    for (const node of dirty) {
      if (node.summary_state === "stale") stats.stale++;
      else stats.pending++;
    }
    return stats;
  }

  // One LLM call per file: group the dirty nodes by the file they live in.
  const byFile = new Map<string, NodeV1[]>();
  for (const node of dirty) {
    if (!sources.has(node.path)) continue;
    const arr = byFile.get(node.path);
    if (arr) arr.push(node);
    else byFile.set(node.path, [node]);
  }

  // Each file is an independent LLM call, so run several in flight at once —
  // the slow part is the round-trip, not local work. Files never share state:
  // one file's nodes and source stand alone, so parallelism can't corrupt the
  // per-file line numbers the crux slicing depends on. `stats` mutation is safe
  // because JS is single-threaded — increments run between awaits, never during.
  const summarizer = opts.summarizer;
  const files = [...byFile.keys()];
  const limit = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  let done = 0;

  await mapWithConcurrency(files, limit, async (path) => {
    const fileNodes = byFile.get(path)!;
    const source = sources.get(path)!;
    const lineCount = source.split("\n").length;

    const refs: NodeRef[] = fileNodes.map((n) => {
      const [startLine, endLine] = spanLines(n.span, lineCount);
      return { id: n.id, kind: n.kind, signature: n.signature, startLine, endLine };
    });

    const { results, errors } = await collectFileCrux(summarizer, path, source, refs);
    for (const error of errors) stats.errors.push(`${path}: ${error}`);

    for (const node of fileNodes) {
      const r = results.size > 0 ? results.get(node.id) : undefined;
      if (!r) {
        // whole-file call failed, or the model skipped this symbol: keep what it had.
        if (node.summary_state === "stale") stats.stale++;
        else stats.pending++;
        continue;
      }
      node.summary = r.summary || null;
      node.crux = buildCrux(r, node, source, lineCount);
      node.summary_state = "ready";
      stats.computed++;
    }

    // Report on completion so the counter climbs monotonically under concurrency.
    opts.onProgress?.({ index: done++, total: files.length, node: path });
  });

  return stats;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving result order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Describe every requested definition in a file in bounded batches, re-asking
 * once for entries omitted from each batch. Partial results survive a failed
 * batch, so one oversized generated file cannot strand every symbol in it.
 */
async function collectFileCrux(
  summarizer: CruxSummarizer,
  path: string,
  source: string,
  refs: NodeRef[],
): Promise<{ results: Map<string, NodeCrux>; errors: string[] }> {
  const results = new Map<string, NodeCrux>();
  const errors: string[] = [];
  const fileRefs = refs.filter((ref) => ref.kind === "file");
  const symbolRefs = refs.filter((ref) => ref.kind !== "file");
  const batches = [...fileRefs.map((ref) => [ref]), ...chunk(symbolRefs, MAX_TARGETS_PER_REQUEST)];

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    let missing = batch;
    for (let attempt = 0; attempt < 2 && missing.length > 0; attempt++) {
      try {
        const list = await summarizer.describeFile({ path, source, nodes: missing });
        for (const r of list) if (!results.has(r.id)) results.set(r.id, r);
        missing = batch.filter((r) => !results.has(r.id));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        errors.push(`batch ${batchIndex + 1}/${batches.length}: ${detail}`);
        break;
      }
    }
  }
  return { results, errors };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Cut the crux text verbatim from the file using the model's file-absolute line
 * range, clamped to the node's own span. Returns null when the model reported no
 * distinct crux (0/0) or gave an unusable range.
 */
function buildCrux(r: NodeCrux, node: NodeV1, source: string, lineCount: number): Crux | null {
  // 0/0 (or an invalid range) is the model saying "nothing to highlight here".
  if (r.crux_start < 1 || r.crux_end < r.crux_start) return null;
  const [nodeStart, nodeEnd] = spanLines(node.span, lineCount);
  const start = Math.max(nodeStart, Math.min(r.crux_start, nodeEnd));
  let end = Math.max(start, Math.min(r.crux_end, nodeEnd));

  // Keep the crux readable: if the model pointed at a big region, store its
  // leading slice (the anchor it chose) rather than the whole blob — still the
  // most important part, and the full definition is reachable via node.span.
  if (end - start + 1 > MAX_CRUX_LINES) end = start + MAX_CRUX_LINES - 1;

  const code = source.split("\n").slice(start - 1, end).join("\n");
  if (!code.trim()) return null;
  return { code, span: `L${start}-L${end}` };
}

/** Parse a `"L12-L30"` span into a clamped [start, end] line pair (1-based). */
function spanLines(span: string, fileLines: number): [number, number] {
  const m = /^L(\d+)-L(\d+)$/.exec(span);
  if (!m) return [1, fileLines];
  const start = Math.max(1, Math.min(Number(m[1]), fileLines));
  const end = Math.max(start, Math.min(Number(m[2]), fileLines));
  return [start, end];
}
