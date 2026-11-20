/**
 * Workspace federation — a "workspace" is a parent directory that holds two or
 * more immediate git-repo children and has no source graph of its own. Instead
 * of one mega-graph pooling every repo, each child keeps its OWN committable
 * `graft/` (byte-identical to building that child standalone), and the parent
 * holds a single `graft/workspace.json` index:
 *
 *   { "version": 1, "children": ["repoA", "repoB"] }
 *
 * Queries run at the parent federate across the children: `ask` fuses every
 * child's ranked hits with `fuseScopes`, reciprocal-rank fusion, so the big
 * repo can't drown the small one. Scopes INSIDE one repo no longer take that
 * path — they share corpus statistics and a normalization denominator, so they
 * are combined by score (see `ask/fuse.ts`). Separate child repositories have
 * no such shared scale, which is exactly the case rank fusion is for.
 * `grep`/`map`/`check`/`callers` run per child and merge, always labeled
 * `<child>/`.
 *
 * This module owns the pure/core pieces (graph loading and the federated command
 * bodies that return renderable data; the index format and its readers/writers
 * are in `workspace-index.ts`, re-exported here). The
 * CLI print/exit wrappers and the per-child build orchestration live in
 * `workspace-cli.ts`; `mcp/tools.ts` calls the federate* functions directly.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { checkGraph } from "./check.js";
import { doneWithMap, loadGraphCached, startMapCommand, tooBigToKeep } from "./load.js";
import { buildRepoMap, repoMapBody } from "./map.js";
import { discoverWorkspaceChildren } from "./scopes.js";
import {
  headerOf,
  hitLine,
  looseNoteFor,
} from "./traverse-cli.js";
import { edgeWalk, resolveSymbol, walkSeeds, type Adjacency, type Direction } from "./traverse.js";
import { readLinks, type LinksV1 } from "./parts-link.js";
import { adjacencyOf, crossWalk, LinkIndex, type PartHit } from "./parts-walk.js";
import { wiringPath } from "./write.js";
import type { EdgeV1, GraphV1, NodeV1, Relation } from "./types.js";
import {
  ask,
  byPointer,
  dressHits,
  fallthroughNoteFor,
  findSubjectNodes,
  hitFiles,
  skeleton,
  structuralHit,
  structuralHits,
  structuralIntent,
  structuralNote,
  type AskHit,
  type AskRankingMetadata,
  type AskResult,
  type SkeletonResult,
  type StructuralIntent,
} from "../ask/ask.js";
import {
  fileFirstRoundRobin,
  roundRobinQueues,
} from "../ask/file-selection.js";
import { fuseScopes, STRONG_FLOOR, HIGH_FLOOR, type ScopedDoc } from "../ask/fuse.js";
import { grepGraph, type GrepGroup, type GrepResult } from "../search/grep.js";
import { formatGrepResult, zeroHitNote } from "../search/grep-cli.js";
import { knownSizes, savingsFromSizes, withSavings, type Savings } from "../context/savings.js";
import { cmd } from "../brand.js";

// The index format, reader and writers live apart so light code can read it
// without loading the query stack below (see workspace-index.ts).
import { isPartsWorkspace, readWorkspace, writeWorkspace, type WorkspaceV1 } from "./workspace-index.js";
export {
  isPartsWorkspace,
  isSafePart,
  PARTS_INDEX_VERSION,
  readWorkspace,
  removeWorkspace,
  workspacePath,
  writeWorkspace,
  type WorkspaceV1,
} from "./workspace-index.js";

/**
 * The child a root-relative path belongs to, and the path inside it: the longest
 * child that is the path or a folder above it (`Src/EBS/StateP/CoDeg/a.c` →
 * `Src/EBS/StateP/CoDeg` + `a.c`). Null when no child holds it.
 */
export function childFor(children: readonly string[], path: string): { child: string; rest: string } | null {
  const p = path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  let best: string | undefined;
  for (const c of children) {
    if ((p === c || p.startsWith(`${c}/`)) && (best === undefined || c.length > best.length)) best = c;
  }
  return best === undefined ? null : { child: best, rest: p.slice(best.length + 1) };
}

/**
 * How an `--in` path from the workspace root narrows each child, for `callers`
 * and `grep`: one under a child narrows to that child (and to the rest of the
 * path inside it); one above children searches just those; anything else is
 * passed to every child unchanged. Without `--in`, every child is searched.
 */
export function inScope(children: readonly string[], inPath: string | undefined): (child: string) => { skip: boolean; in?: string } {
  const prefix = inPath?.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  const hit = prefix ? childFor(children, prefix) : null;
  const below = prefix && !hit ? children.filter((c) => c.startsWith(`${prefix}/`)) : [];
  return (child) => {
    if (!prefix) return { skip: false };
    if (hit) return hit.child === child ? { skip: false, in: hit.rest || undefined } : { skip: true };
    if (below.length > 0) return { skip: !below.includes(child) };
    return { skip: false, in: inPath };
  };
}

/** A parent is a workspace BUILD target when it has no own `.git` and ≥2 git
 * children — or it was already split (a `workspace.json` is present). The
 * no-own-`.git` guard keeps a normal repo with git submodules from being
 * mistaken for a workspace. A repository built as one map per part is not one:
 * its parts are folders, not repos (see `graph/parts-build.ts`). */
export function isWorkspaceBuildRoot(root: string, override?: string): boolean {
  const ws = readWorkspace(root, override);
  if (ws) return !isPartsWorkspace(ws);
  if (existsSync(join(root, ".git"))) return false;
  return discoverWorkspaceChildren(root).length >= 2;
}

/** True when the parent has a mega-graph from an older single-graph build
 * (`graft/.graph/wiring.json`) — the thing a workspace build migrates away. */
export function hasMegaGraph(root: string, override?: string): boolean {
  return existsSync(wiringPath(contextDirFor(root, override)));
}

/** The EXACT split warning printed once, when a mega-graph parent is first
 * built as a workspace. Templated on the child list so it names the real repos. */
export function migrationNote(children: string[]): string {
  const dirs = children.map((c) => `${c}/graft/`).join(", ");
  return (
    `⚠ this folder contains ${children.length} separate git repos — splitting: ` +
    `each repo now gets its own committable graft/ (${dirs}); the combined graph ` +
    `here is replaced by a workspace index. Queries from here now search all repos, fairly.`
  );
}

/** Remove the parent's entire `graft/` tree — the mega-graph, its `.cache`, and
 * any stale cards — so after `writeWorkspace` the parent holds ONLY
 * workspace.json. Child graphs live in sibling `<child>/graft/`, never under
 * this dir, so they are untouched. */
export function clearParentGraft(root: string, override?: string): void {
  rmSync(contextDirFor(root, override), { recursive: true, force: true });
}

export interface LoadedChild {
  child: string;
  /** The child's map folder; its graph is loaded when a command needs it
   * (`withChildGraph`). */
  dir: string;
}

export interface WorkspaceGraphs {
  /** Children (from workspace.json when present, else discovered) that have a
   * built graph, in sorted child order. */
  loaded: LoadedChild[];
  /** Listed children with no built graph yet — surfaced, never silently skipped. */
  missing: string[];
  /** What a child is called in messages: "repo", or "part" for one map per part. */
  unit: "repo" | "part";
  /** The children's maps together are too big to keep in memory: each is
   * dropped from the graph cache once used (`doneWithMap`), so a command holds
   * one at a time, but for those a long-lived process keeps within its budget.
   * Loading the children starts a command of their maps (`startMapCommand`). */
  release: boolean;
}

/** List each child and whether it has a built graph. Children come from
 * workspace.json when present, otherwise from live git-child discovery (a
 * not-yet-built workspace). A child without a built graph is counted into
 * `missing`, not dropped. Nothing is parsed here: commands load each child's
 * graph as they reach it. */
export function loadWorkspaceGraphs(root: string, override?: string): WorkspaceGraphs {
  const ws = readWorkspace(root, override);
  const children = (ws ? ws.children : discoverWorkspaceChildren(root)).slice().sort();
  const loaded: LoadedChild[] = [];
  const missing: string[] = [];
  for (const child of children) {
    const dir = contextDirFor(join(root, child));
    if (existsSync(wiringPath(dir))) loaded.push({ child, dir });
    else missing.push(child);
  }
  const release = tooBigToKeep(loaded.map((l) => l.dir));
  // Each command that loads the children is one walk over their maps.
  if (release) startMapCommand();
  return { loaded, missing, unit: isPartsWorkspace(ws) ? "part" : "repo", release };
}

/** Run `fn` on one child's graph (skipped, `undefined`, when it cannot be read),
 * then let it go from the cache when the workspace's maps are too big to keep. */
function withChildGraph<T>(wg: WorkspaceGraphs, c: LoadedChild, fn: (graph: GraphV1) => T): T | undefined {
  try {
    const graph = loadGraphCached(c.dir);
    return graph ? fn(graph) : undefined;
  } finally {
    if (wg.release) doneWithMap(c.dir);
  }
}

/** `fn` for a child whose graph a callee loads itself (`ask`, `skeleton`,
 * `checkGraph`), let go afterwards like `withChildGraph`. */
function withChild<T>(wg: WorkspaceGraphs, c: LoadedChild, fn: () => T): T {
  try {
    return fn();
  } finally {
    if (wg.release) doneWithMap(c.dir);
  }
}

/** "2 of 3 workspace repos have graphs; run graft build to cover repoC" — the
 * coverage line federated commands append when some listed child is unbuilt.
 * Empty string when every child has a graph. */
export function coverageNote(g: WorkspaceGraphs): string {
  if (g.missing.length === 0) return "";
  const total = g.loaded.length + g.missing.length;
  return `${g.loaded.length} of ${total} workspace ${g.unit}s have graphs; run ${cmd("graft build")} to cover ${g.missing.join(", ")}`;
}

/** Prefix a hit pointer with its child dir so a `path:span` (or concept path
 * list) opens correctly from the parent. Leaves free-text fragments alone. */
function prefixPointer(child: string, pointer: string): string {
  return pointer
    .split(",")
    .map((part) => {
      const t = part.trim();
      if (!t || t.includes(" ")) return part;
      return `${child}/${t}`;
    })
    .join(", ");
}

/** The exact child-relative file owning a lexical symbol hit. File nodes use a
 * bare path; definition hits append `:Lx-Ly`. */
function hitFile(pointer: string): string {
  return pointer.match(/^(.*):L\d+-L\d+$/)?.[1] ?? pointer;
}

/**
 * Note in `into` the sizes the map of `child` (`graph`) knows for `paths`, which
 * are `child`'s own, keyed by their paths from the workspace root. A federated
 * answer's "tokens saved" estimate is over the files of what it finally shows,
 * which can come from every child: each child's sizes are noted while its map
 * is loaded anyway, so none is loaded again to add them up
 * ({@link savingsFromSizes}, {@link savingsOf}).
 */
function noteSizes(into: Map<string, number>, child: string, graph: GraphV1 | null | undefined, paths: Iterable<string>): void {
  if (!graph) return;
  for (const [path, chars] of knownSizes(graph, paths)) into.set(`${child}/${path}`, chars);
}

/** Every file noted in `sizes`, as one "tokens saved" baseline. */
function savingsOf(sizes: ReadonlyMap<string, number>): Savings | undefined {
  let baselineChars = 0;
  for (const chars of sizes.values()) baselineChars += chars;
  return sizes.size > 0 ? { files: sizes.size, baselineChars } : undefined;
}

/** Every hit a child's `ask` may hand the workspace ranking: its hits, and the
 * file groups and exact baseline the file-aware path ranks from. */
function candidateHits(r: AskResult): AskHit[] {
  if (!r.ranking) return r.hits;
  return [
    ...r.hits,
    ...r.ranking.groups.flatMap((group) => [...group.hits, ...(group.baselineHits ?? [])]),
    ...r.ranking.baseline.map((entry) => entry.hit),
  ];
}

export interface FederateAskOptions {
  limit?: number;
  source?: boolean;
  full?: boolean;
  graphRank?: boolean;
  /** Narrow to one child (`repoA`) or a sub-scope within it (`repoA/backend`).
   * A prefix matching NO child throws, listing the repos. */
  in?: string;
  /** @internal File-level child RRF plus an exact workspace baseline top lock. */
  fileTopLock?: boolean;
}

interface ChildRun {
  child: string;
  hits: AskHit[];
  /** The child's top-hit idf-weighted matched share over name+path+body — a
   * RAW, cross-child-comparable magnitude (NOT per-child normalized). */
  coverage: number;
  /** Same, but over name+path ONLY (body dropped) — the match-STRENGTH signal.
   * A body-only incidental collision has `coverageStrong === 0`. */
  coverageStrong: number;
  /** Exact baseline top-hit coverage used only to compute the workspace top lock. */
  baselineCoverage: number;
  baselineCoverageStrong: number;
  /** Present only for the internal file-aware path. */
  ranking?: AskRankingMetadata;
}

// STRONG_FLOOR / HIGH_FLOOR (a child federates if its top hit matched a
// query term in a NAME/PATH field ≥ STRONG_FLOOR, OR its overall name+path+
// body coverage is broad enough to be real even body-only, ≥ HIGH_FLOOR) are
// defined ONCE in `../ask/fuse.js` and imported here. This is now their only
// caller: a share-of-the-query threshold is the best available signal when the
// candidates carry no common score scale, which is the situation across child
// repositories. `rankScopesAndFuse` used to gate on them for the same reason
// and no longer needs to — within one repo the scores are comparable, so a
// weak scope is held back by scoring low rather than by a strength floor.

/**
 * Federated `ask` across a workspace: run each child's own ask pipeline, then
 * fuse ALL the children's scope lists with `fuseScopes` (reciprocal rank). Each
 * child contributes one fusion scope per intra-child scope, labeled
 * `<child>/<scope>` (or just `<child>` for a child's root scope), so a big repo
 * can't drown a small one — rank positions are comparable across repos where
 * raw scores are not.
 *
 * Rank fusion is still right HERE, and only here: each child was scored against
 * its own corpus, so cross-child scores share no scale. Within a single repo
 * that is no longer true — `rankScopesAndFuse` gives every scope the same
 * statistics and the same denominator and combines them by score.
 *
 * Returns a normal `AskResult`; `formatAsk` renders it unchanged, labeling each
 * hit `[<child>/…]` via the standard multi-scope path.
 */
export function federateAsk(
  root: string,
  override: string | undefined,
  query: string,
  opts: FederateAskOptions = {},
): AskResult {
  const wg = loadWorkspaceGraphs(root, override);
  const limit = opts.limit ?? 8;
  const fileTopLock = opts.fileTopLock ?? true;

  // `--in` scopes to a single child (and, past it, a sub-scope within it). A
  // child may span several segments (`Src/EBS/ActP` in a repository built as one
  // map per part), so the longest child holding the prefix wins. A prefix naming
  // no known child at all is a caller mistake. A prefix above several children
  // (`Src/EBS`) searches just those.
  let onlyChild: string | undefined;
  let below: string[] | undefined;
  let childIn: string | undefined;
  if (opts.in) {
    const allChildren = [...wg.loaded.map((l) => l.child), ...wg.missing].sort();
    const hit = childFor(allChildren, opts.in);
    const prefix = opts.in.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (hit) {
      onlyChild = hit.child;
      childIn = hit.rest || undefined;
    } else {
      below = allChildren.filter((c) => c.startsWith(`${prefix}/`));
      if (below.length === 0) {
        throw new Error(`no workspace ${wg.unit} "${prefix.split("/")[0]}" - ${wg.unit}s: ${allChildren.join(", ")}`);
      }
    }
  }

  const scoped = wg.loaded.filter((c) => (!onlyChild || c.child === onlyChild) && (!below || below.includes(c.child)));

  // The sizes of the files the children's hits point into, from the workspace
  // root: the "tokens saved" baseline of the hits finally shown. Only with the
  // spans inlined, as one map's `ask` reports it.
  const sizes = new Map<string, number>();
  const withSaved = (result: AskResult): AskResult => {
    if (opts.source) {
      const saved = savingsFromSizes(sizes, hitFiles(result.hits));
      if (saved) result.saved = saved;
    }
    return result;
  };
  /** One child's own ask, for the ranking below; null when it cannot answer (a
   * corrupt child, or a sub-scope `--in` matching nothing there). */
  const askChild = (c: LoadedChild): AskResult | null => {
    try {
      // Over-fetch per child so cross-child fusion has enough candidates to
      // rank before the final `limit` slice.
      const res = ask(join(root, c.child), query, {
        limit: Math.max(limit * 4, 20),
        source: opts.source,
        full: opts.full,
        graphRank: opts.graphRank,
        in: childIn,
        // The parent owns the final cross-repo ranking. Selecting inside each
        // child would be undone by fusion and could truncate a hybrid list.
        fileFirst: false,
        fileComplement: fileTopLock,
        includeRankingMetadata: fileTopLock,
        // Answered across the children above: a child answering it alone could
        // pick a shorter word of the query as its subject, which one map does not.
        structural: false,
      });
      // The child's map `ask` has just read, from the cache: not read again.
      if (opts.source) noteSizes(sizes, c.child, loadGraphCached(c.dir), hitFiles(candidateHits(res)));
      return res;
    } catch {
      return null;
    }
  };

  // A structural question ("who calls X") is answered across the children as
  // one map would answer it, before any ranking: its hits carry no score, so
  // the gate below would hold every one of them back.
  const intent = structuralIntent(query);
  // Maps too big to keep are each dropped once used: while no child has named the
  // subject (the question then falls through to the ranking), each child's ask
  // runs while the structural pass has its map, rather than reading it again.
  const early = new Map<LoadedChild, AskResult | null>();
  const whileLoaded = wg.release ? (c: LoadedChild) => void early.set(c, askChild(c)) : undefined;
  const structured = intent ? federateStructural(wg, root, override, query, intent, scoped, childIn, limit, opts, whileLoaded) : null;
  if (structured && "result" in structured) return structured.result;
  // A structural question no child could answer still says so on its ranked
  // matches, as one map's `ask` does.
  const fallthroughNote = structured?.fallthroughNote;
  const withNotes = (result: AskResult): AskResult => {
    if (fallthroughNote) result.note = result.note ? `${fallthroughNote}\n${result.note}` : fallthroughNote;
    const cov = coverageNote(wg);
    if (cov) result.note = result.note ? `${result.note}\n${cov}` : cov;
    return result;
  };

  // Pass 1: run each child's ask; keep its hits + RAW top-hit coverage.
  const runs: ChildRun[] = [];
  for (const c of scoped) {
    const { child } = c;
    const r = early.has(c) ? early.get(c) : withChild(wg, c, () => askChild(c));
    if (!r || r.hits.length === 0) continue;
    const topGroup = r.ranking?.groups[0];
    runs.push({
      child,
      hits: r.hits,
      coverage: topGroup?.coverage ?? r.coverage ?? 0,
      coverageStrong: topGroup?.coverageStrong ?? r.coverageStrong ?? 0,
      baselineCoverage: r.ranking?.baselineCoverage ?? r.coverage ?? 0,
      baselineCoverageStrong:
        r.ranking?.baselineCoverageStrong ?? r.coverageStrong ?? 0,
      ranking: r.ranking,
    });
  }

  // Cross-child participation gate on match STRENGTH, not a lenient ratio.
  // Per-child hit scores are each per-child-normalized (top ~1.0 everywhere),
  // so feeding them to fuseScopes makes its gate vacuous across repos — a junk
  // body-token collision would federate beside another repo's genuine hits.
  // Gate: a child federates iff its top hit matched a query term in a NAME/PATH
  // field (coverageStrong ≥ STRONG_FLOOR — not just an incidental body token)
  // OR its overall coverage is broad enough to be real (≥ HIGH_FLOOR). A
  // body-only collision has coverageStrong 0 and coverage ~0.3 → gated to
  // alsoMatched. Both floors are absolute + scale-invariant (see their docs).
  // The gate is a cross-child FAIRNESS mechanism: it stops a weak body-token
  // collision in one repo from federating beside another repo's genuine hits.
  // An explicit `--in <child>` removes all cross-child competition — the caller
  // has already chosen the scope — so the gate must NOT apply there, or the
  // `also matched: <child> — narrow with --in <child>` hint would lead to an
  // empty result for exactly the weak child it points at. With `onlyChild` set,
  // every run (there is at most one) survives, matching a standalone child ask.
  const gatedOut: { scope: string; bestId: string }[] = [];
  const survivors: ChildRun[] = [];
  const baselineSurvivors: ChildRun[] = [];
  for (const run of runs) {
    const baselineEligible =
      onlyChild ||
      run.baselineCoverageStrong >= STRONG_FLOOR ||
      run.baselineCoverage >= HIGH_FLOOR;
    const fileEligible =
      onlyChild ||
      run.coverageStrong >= STRONG_FLOOR ||
      run.coverage >= HIGH_FLOOR;
    if (baselineEligible) baselineSurvivors.push(run);
    // Distributed file evidence may admit a child, but the exact baseline
    // top lock must never resurrect a child that the final stream calls gated
    // out. The production survivor set is therefore the union of both gates;
    // baselineSurvivors remains the strict baseline subset used only to choose the
    // locked pointer.
    if (baselineEligible || fileEligible) survivors.push(run);
    else {
      const best = run.ranking?.groups[0]?.hits[0] ?? run.hits[0];
      gatedOut.push({ scope: run.child, bestId: prefixPointer(run.child, best.pointer) });
    }
  }

  if (fileTopLock) {
    type WorkspaceGroup = {
      key: string;
      child: string;
      hits: AskHit[];
      baselineHits: AskHit[];
    };
    const qualifyHit = (
      child: string,
      hit: AskHit,
      score = hit.score,
      scope = hit.scope ? `${child}/${hit.scope}` : child,
    ): AskHit => ({
      ...hit,
      score,
      scope,
      pointer: prefixPointer(child, hit.pointer),
    });
    const sameHit = (a: AskHit, b: AskHit): boolean =>
      a.kind === b.kind && a.pointer === b.pointer && a.title === b.title;

    // Baseline workspace stream: reproduce the all-span RRF exactly so the
    // final lock owns the same concrete pointer and fused score as the baseline.
    const baselineDocs: ScopedDoc[] = [];
    const baselineBack = new Map<
      string,
      { child: string; group: string; hit: AskHit }
    >();
    for (const run of baselineSurvivors) {
      const entries = run.ranking?.baseline ?? run.hits.map((hit, index) => ({
        group: `singleton:${index}`,
        hit,
      }));
      entries.forEach((entry, index) => {
        // Keep the legacy id shape so equal-score baseline ties remain exact.
        const id = `${run.child} ${index}`;
        const scope = entry.hit.scope
          ? `${run.child}/${entry.hit.scope}`
          : run.child;
        baselineDocs.push({ id, scope, score: entry.hit.score });
        baselineBack.set(id, {
          child: run.child,
          group: `${run.child}\0${entry.group}`,
          hit: entry.hit,
        });
      });
    }
    const baselineFused = fuseScopes(baselineDocs);
    const baselineTopRanked = baselineFused.ranked[0];
    const baselineTopBack = baselineTopRanked
      ? baselineBack.get(baselineTopRanked.id)
      : undefined;
    const baselineTop = baselineTopRanked && baselineTopBack
      ? qualifyHit(
          baselineTopBack.child,
          baselineTopBack.hit,
          baselineTopRanked.score,
          baselineTopRanked.scope,
        )
      : undefined;

    // File-aware workspace stream: exactly one leader per child/file (concepts stay
    // singleton groups) participates in RRF. Span queues remain in a side map
    // and cannot consume reciprocal-rank positions.
    const fileDocs: ScopedDoc[] = [];
    const fileBack = new Map<string, WorkspaceGroup>();
    for (const run of survivors) {
      const groups = run.ranking?.groups ?? run.hits.map((hit, index) => ({
        key: `singleton:${index}`,
        hits: [hit],
        baselineHits: [hit],
        coverage: 0,
        coverageStrong: 0,
      }));
      groups.forEach((group, index) => {
        const leader = group.hits[0];
        if (!leader) return;
        const id = `${run.child} file ${String(index).padStart(8, "0")}`;
        const scope = leader.scope ? `${run.child}/${leader.scope}` : run.child;
        const key = `${run.child}\0${group.key}`;
        fileDocs.push({ id, scope, score: leader.score });
        fileBack.set(id, {
          key,
          child: run.child,
          hits: group.hits,
          baselineHits: group.baselineHits ?? [leader],
        });
      });
    }
    const fileFused = fuseScopes(fileDocs);
    const rankedGroups: WorkspaceGroup[] = fileFused.ranked.flatMap((ranked) => {
      const group = fileBack.get(ranked.id);
      if (!group) return [];
      return [{
        ...group,
        // These spans are projections of one cross-child file document. Keep
        // their public score on that same RRF scale; child-local tail scores are
        // not comparable after workspace fusion and downstream re-sorting would
        // otherwise silently undo the file ordering.
        hits: group.hits.map((hit) =>
          qualifyHit(
            group.child,
            hit,
            ranked.score,
            hit.scope ? `${group.child}/${hit.scope}` : group.child,
          ),
        ),
        baselineHits: group.baselineHits.map((hit) => qualifyHit(group.child, hit)),
      }];
    });

    let projectedGroups = rankedGroups;
    if (baselineTop && baselineTopBack) {
      const key = baselineTopBack.group;
      const existing = rankedGroups.find((group) => group.key === key);
      const baselineQueue = existing?.baselineHits ?? [baselineTop];
      const projectedScore = existing?.hits[0]?.score ?? baselineTop.score;
      const locked: WorkspaceGroup = existing
        ? {
            ...existing,
            hits: [
              baselineTop,
              ...baselineQueue
                .filter((hit) => !sameHit(hit, baselineTop))
                .map((hit) => ({ ...hit, score: projectedScore })),
            ],
          }
        : {
            key,
            child: baselineTopBack.child,
            hits: [baselineTop],
            baselineHits: [baselineTop],
          };
      projectedGroups = [
        locked,
        ...rankedGroups.filter((group) => group.key !== key),
      ];
    }

    const hits = roundRobinQueues(
      projectedGroups.map((group) => group.hits),
      limit,
    );
    const unmatched = [...fileFused.alsoMatched, ...gatedOut];
    const result: AskResult = {
      query,
      mode: hits.length ? "lexical" : "empty",
      hits,
    };
    if (hits.length) {
      const lockedScope = baselineTop?.scope;
      const federated = [
        ...new Set([
          ...(lockedScope ? [lockedScope] : []),
          ...fileFused.federated,
        ]),
      ];
      const federatedSet = new Set(federated);
      result.scopes = {
        federated,
        alsoMatched: unmatched.filter((match) => !federatedSet.has(match.scope)),
      };
    } else {
      result.note = `no matching nodes across ${wg.loaded.length} workspace ${wg.unit}(s) — try different words, or \`${cmd("graft build")}\` at a child`;
    }
    return withSaved(withNotes(result));
  }

  // Fuse the survivors' scope lists (within-child fusion is left untouched —
  // each child already ran its own per-scope RRF).
  const docs: ScopedDoc[] = [];
  const back = new Map<string, { child: string; hit: AskHit }>();
  for (const { child, hits } of survivors) {
    hits.forEach((hit, i) => {
      const scope = hit.scope ? `${child}/${hit.scope}` : child;
      const id = `${child} ${i}`;
      docs.push({ id, scope, score: hit.score });
      back.set(id, { child, hit });
    });
  }

  const fused = fuseScopes(docs);
  const rankedHits = fused.ranked.map((rd) => {
    const { child, hit } = back.get(rd.id)!;
    const value: AskHit = {
      ...hit,
      score: rd.score,
      scope: rd.scope,
      pointer: prefixPointer(child, hit.pointer),
    };
    return {
      // Lexical symbols share a file queue. Concepts and structural neighbours
      // remain singleton partitions, so this lexical selection layer cannot
      // reorder `who calls` / `dependencies of` answers.
      group: hit.kind === "symbol"
        ? `file:${child}/${hitFile(hit.pointer)}`
        : `singleton:${child}:${rd.id}`,
      value,
    };
  });
  const hits = fileFirstRoundRobin(rankedHits, limit);

  const alsoMatched = [...fused.alsoMatched, ...gatedOut];
  const result: AskResult = { query, mode: hits.length ? "lexical" : "empty", hits };
  if (hits.length) {
    const federated = fused.federated.length ? fused.federated : [...new Set(hits.map((h) => h.scope!))];
    result.scopes = { federated, alsoMatched };
  } else {
    result.note = `no matching nodes across ${wg.loaded.length} workspace ${wg.unit}(s) — try different words, or \`${cmd("graft build")}\` at a child`;
  }
  return withSaved(withNotes(result));
}

/** The links of a repository built in parts, indexed, when they match its parts'
 * maps as they are now; null for a folder of repos, or links not made or stale
 * (the queries that read them make them again first: `refresh.ts` `refreshLinks`). */
function currentLinks(
  wg: WorkspaceGraphs,
  root: string,
  override: string | undefined,
): { links: LinksV1 & { missing: string[] }; idx: LinkIndex } | null {
  if (wg.unit !== "part") return null;
  const links = readLinks(root, override);
  if (!links) return null;
  // The same links read again (`readLinks` keeps them while the file is
  // unchanged) are not indexed again.
  let idx = linkIndexes.get(links.links);
  if (!idx) linkIndexes.set(links.links, (idx = new LinkIndex(links)));
  return { links, idx };
}

/** Each links list indexed, while it is still read (see {@link currentLinks}). */
const linkIndexes = new WeakMap<LinksV1["links"], LinkIndex>();

/** A structural hit of `child`, its pointer opening from the workspace root.
 * The raw target of an unresolved import is left as it is. */
function childHit(child: string, h: AskHit): AskHit {
  return /:L\d+-L\d+$/.test(h.pointer) ? { ...h, pointer: `${child}/${h.pointer}` } : h;
}

/** The first `limit` structural hits of `child` in the order of their pointers
 * from the workspace root (an unresolved import's raw target is not prefixed,
 * so it may sort apart from the rest), as they are: still the child's own. */
function topOfChild(child: string, hits: readonly AskHit[], limit: number): AskHit[] {
  return hits
    .map((h) => ({ h, at: childHit(child, h).pointer }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, limit)
    .map((x) => x.h);
}

/** A grep group of `child`, its paths from the workspace root. */
function childGroup(child: string, g: GrepGroup): GrepGroup {
  return {
    ...g,
    path: `${child}/${g.path}`,
    symbol: g.symbol ? { ...g.symbol, path: `${child}/${g.symbol.path}` } : null,
  };
}

/** Grep groups most coupled first, as one map's `grep` lists them. */
const byCoupling = (a: GrepGroup, b: GrepGroup): number => b.inDegree - a.inDegree || a.path.localeCompare(b.path);

function addRelation(ids: Map<string, Set<Relation>>, id: string, relation: Relation): void {
  let rels = ids.get(id);
  if (!rels) ids.set(id, (rels = new Set()));
  rels.add(relation);
}

/** The structural hits of the nodes of `graph` a link reaches (`ids`, with the
 * relations of the links), one per relation. */
function linkedHits(graph: GraphV1, ids: ReadonlyMap<string, ReadonlySet<Relation>>, outgoing: boolean): AskHit[] {
  const got: AskHit[] = [];
  if (ids.size === 0) return got;
  for (const n of graph.nodes) {
    for (const relation of ids.get(n.id) ?? []) got.push(structuralHit(n, n.id, relation, outgoing));
  }
  return got;
}

/**
 * A structural question ("who calls X", "what does X import") answered across
 * the children as one map answers it. The subject is the query's longest word
 * naming a symbol in any child, as `findSubjectNodes` picks it in one map. Its
 * edges come from every child naming it and, in a repository built in parts
 * whose links are current, from the links between parts, less the part edges
 * those links void. A `fallthroughNote` when the subject is named nowhere or no
 * child has an edge for it: the caller then ranks matches, as one map does.
 * `whileLoaded` runs on each child that does not name the subject, while its
 * map is loaded, as long as no child before it has named the subject.
 */
function federateStructural(
  wg: WorkspaceGraphs,
  root: string,
  override: string | undefined,
  query: string,
  intent: StructuralIntent,
  children: readonly LoadedChild[],
  childIn: string | undefined,
  limit: number,
  opts: FederateAskOptions,
  whileLoaded?: (c: LoadedChild) => void,
): { result: AskResult } | { fallthroughNote: string } {
  const idx = currentLinks(wg, root, override)?.idx;
  const direction: Direction = intent.outgoing ? "out" : "in";
  type Cross = { part: string; id: string; relation: Relation };
  type Found = { order: number; subject: string; hits: AskHit[]; cross: Cross[] };
  let found: Found[] = [];
  let best = Infinity;
  let unnamed = query;
  // The sizes of the hits' files, from the workspace root, noted while each map
  // is loaded: the "tokens saved" baseline, with the spans inlined (as in `ask`).
  const sizes = new Map<string, number>();
  for (const c of children) {
    const f = withChildGraph(wg, c, (graph): Found | undefined => {
      const s = findSubjectNodes(query, graph, childIn);
      if (s.nodes.length === 0) {
        unnamed = s.tried;
        if (found.length === 0) whileLoaded?.(c);
        return undefined;
      }
      // A longer word named in another child is the subject, and a name matched
      // whole there (`Cache.get`) wins over its last segment matched here
      // (`get`): one map picks it.
      const order = s.rank * 3 + s.tier;
      if (order > best) return undefined;
      const ids = new Set(s.nodes.map((n) => n.id));
      const keep = idx ? (e: EdgeV1): boolean => !idx.isVoid(c.child, e) : undefined;
      // A link back into this part (an edge its map could not settle alone) ends
      // in this map; the other ends in other parts are read after.
      const own = new Map<string, Set<Relation>>();
      const cross: Cross[] = [];
      for (const id of idx ? ids : []) {
        for (const st of idx!.across(c.child, id, direction)) {
          if (!intent.rels.has(st.relation)) continue;
          if (st.part === c.child) addRelation(own, st.id, st.relation);
          else cross.push(st);
        }
      }
      const hits = topOfChild(c.child, [...structuralHits(graph, ids, intent, keep), ...linkedHits(graph, own, intent.outgoing)], limit);
      dressHits(join(root, c.child), hits, graph, opts);
      if (opts.source) noteSizes(sizes, c.child, graph, hitFiles(hits));
      return { order, subject: s.nodes[0]!.name, hits: hits.map((h) => childHit(c.child, h)), cross };
    });
    if (!f) continue;
    if (f.order < best) {
      best = f.order;
      found = [];
    }
    found.push(f);
  }
  if (found.length === 0) return { fallthroughNote: fallthroughNoteFor(unnamed) };
  const subject = found[0]!.subject;

  // The other ends in other parts, read from those parts' maps.
  const wanted = new Map<string, Map<string, Set<Relation>>>();
  for (const f of found) {
    for (const st of f.cross) {
      let ids = wanted.get(st.part);
      if (!ids) wanted.set(st.part, (ids = new Map()));
      addRelation(ids, st.id, st.relation);
    }
  }
  const hits = found.flatMap((f) => f.hits);
  for (const [part, ids] of wanted) {
    const c = wg.loaded.find((l) => l.child === part);
    if (!c) continue;
    withChildGraph(wg, c, (graph) => {
      const top = topOfChild(part, linkedHits(graph, ids, intent.outgoing), limit);
      dressHits(join(root, part), top, graph, opts);
      if (opts.source) noteSizes(sizes, part, graph, hitFiles(top));
      hits.push(...top.map((h) => childHit(part, h)));
    });
  }

  // One map holds one edge where a part's own edge and a link reach the same
  // node; two nodes at one span (a class and its constructor) stay two.
  const seen = new Set<string>();
  const unique = hits.filter((h) => {
    const key = `${h.pointer}\0${h.title}\0${h.relation ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) return { fallthroughNote: fallthroughNoteFor(subject) };
  unique.sort(byPointer);
  const cov = coverageNote(wg);
  const note = structuralNote(subject, intent.outgoing);
  const result: AskResult = {
    query,
    mode: "structural",
    subject,
    hits: unique.slice(0, limit),
    note: cov ? `${note}\n${cov}` : note,
  };
  const saved = opts.source ? savingsFromSizes(sizes, hitFiles(result.hits)) : undefined;
  if (saved) result.saved = saved;
  return { result };
}

/** Merge every child's `GrepResult` into one, prefixing group paths with the
 * child dir and re-sorting by coupling (inDegree desc, path asc) across repos.
 * In-degree is each child's own, from that child's graph; in a repository built
 * in parts with current links, the links into a part count too, and the edges
 * they void do not, as in one map of the repository. `in` is a path from the
 * workspace root, narrowing the children searched as {@link inScope} says. */
export function federateGrep(
  root: string,
  override: string | undefined,
  pattern: string,
  opts: { ignoreCase?: boolean; fixed?: boolean; in?: string } = {},
): { result: GrepResult; coverage: string } {
  const wg = loadWorkspaceGraphs(root, override);
  const idx = currentLinks(wg, root, override)?.idx;
  const scopeFor = inScope(wg.loaded.map((l) => l.child), opts.in);
  const groups: GrepGroup[] = [];
  let filesSearched = 0;
  let totalHits = 0;
  const truncated = { files: 0, hits: 0 };
  let savedFiles = 0;
  let savedChars = 0;

  for (const c of wg.loaded) {
    const { child } = c;
    const scope = scopeFor(child);
    if (scope.skip) continue;
    const r = withChildGraph(wg, c, (graph) => grepGraph(graph, join(root, child), pattern, {
      ignoreCase: opts.ignoreCase,
      fixed: opts.fixed,
      in: scope.in,
      inDegreeDelta: idx?.inDegreeDelta(child),
    }));
    if (!r) continue;
    filesSearched += r.filesSearched;
    totalHits += r.totalHits;
    truncated.files += r.truncated.files;
    truncated.hits += r.truncated.hits;
    if (r.saved) {
      savedFiles += r.saved.files;
      savedChars += r.saved.baselineChars;
    }
    for (const g of r.groups) groups.push(childGroup(child, g));
  }

  groups.sort(byCoupling);
  const saved: Savings | undefined = savedChars > 0 ? { files: savedFiles, baselineChars: savedChars } : undefined;
  const result: GrepResult = { pattern, filesSearched, totalHits, groups, truncated, saved };
  return { result, coverage: coverageNote(wg) };
}

/** One `graft map` section per child (each child's own map, budget split evenly
 * across the loaded children), joined under `<child>/` headers, with one
 * "tokens saved" line for the whole report, over every child's files (as one
 * map's line is over all of its files). The hubs of a part of a repository
 * built in parts with current links count the links into it, as
 * `federateGrep` does. */
export function federateMap(
  root: string,
  override: string | undefined,
  opts: { maxDirs?: number } = {},
): string {
  const wg = loadWorkspaceGraphs(root, override);
  const idx = currentLinks(wg, root, override)?.idx;
  const perChild = opts.maxDirs !== undefined && wg.loaded.length > 0
    ? Math.max(1, Math.floor(opts.maxDirs / wg.loaded.length))
    : undefined;

  let savedFiles = 0;
  let savedChars = 0;
  const sections = wg.loaded.flatMap((c) => {
    const mapOpts = {
      ...(perChild !== undefined ? { maxDirs: perChild } : {}),
      ...(idx ? { inDegreeDelta: idx.inDegreeDelta(c.child) } : {}),
    };
    const map = withChildGraph(wg, c, (graph) => buildRepoMap(graph, mapOpts));
    if (map === undefined) return [];
    if (map.saved) {
      savedFiles += map.saved.files;
      savedChars += map.saved.baselineChars;
    }
    return [`## ${c.child}/\n${repoMapBody(map).trimEnd()}`];
  });
  const head = `workspace map — ${wg.loaded.length} ${wg.unit}(s)`;
  const parts = [head, "", sections.join("\n\n")];
  const cov = coverageNote(wg);
  if (cov) parts.push("", cov);
  const saved: Savings | undefined = savedChars > 0 ? { files: savedFiles, baselineChars: savedChars } : undefined;
  return withSavings(parts.join("\n"), saved) + "\n";
}

/** Per-child drift status. `ok` is false when any BUILT child is stale — an
 * unbuilt child is surfaced (coverage), never a failure. */
export async function federateCheck(
  root: string,
  override?: string,
): Promise<{ text: string; ok: boolean }> {
  const wg = loadWorkspaceGraphs(root, override);
  const lines = [`workspace check — ${wg.loaded.length + wg.missing.length} ${wg.unit}(s)`, ""];
  let ok = true;
  for (const { child, dir } of wg.loaded) {
    let g: Awaited<ReturnType<typeof checkGraph>>;
    try {
      g = await checkGraph(join(root, child));
    } finally {
      if (wg.release) doneWithMap(dir);
    }
    if (g.ok) {
      lines.push(`${child}/: OK`);
    } else {
      ok = false;
      const bits: string[] = [];
      if (g.added.length) bits.push(`${g.added.length} added`);
      if (g.removed.length) bits.push(`${g.removed.length} removed`);
      if (g.changed.length) bits.push(`${g.changed.length} changed`);
      if (g.stale.length) bits.push(`${g.stale.length} stale`);
      lines.push(`${child}/: STALE (${bits.join(", ")})`);
    }
  }
  for (const child of wg.missing) lines.push(`${child}/: not built (run ${cmd("graft build")})`);
  const cov = coverageNote(wg);
  if (cov) lines.push("", cov);
  return { text: lines.join("\n") + "\n", ok };
}

/** `skeleton` from the workspace root: a path under a child is looked up in that
 * child's map; a bare name in every child, and must be unique across them. The
 * returned `file` is root-relative. */
export function federateSkeleton(root: string, override: string | undefined, file: string): SkeletonResult {
  const wg = loadWorkspaceGraphs(root, override);
  const children = wg.loaded.map((l) => l.child);
  const qualify = (child: string, r: SkeletonResult): SkeletonResult =>
    r.entries.length ? { ...r, file: `${child}/${r.file}` } : r;
  const look = (c: LoadedChild, path: string): SkeletonResult => withChild(wg, c, () => skeleton(join(root, c.child), path));
  const hit = childFor(children, file);
  if (hit && hit.rest) return qualify(hit.child, look(wg.loaded.find((l) => l.child === hit.child)!, hit.rest));
  const found = wg.loaded
    .map((c) => ({ child: c.child, r: look(c, file) }))
    .filter(({ r }) => r.entries.length > 0);
  if (found.length === 1) return qualify(found[0]!.child, found[0]!.r);
  if (found.length > 1) {
    return { file, entries: [], note: `ambiguous — matches: ${found.map(({ child, r }) => `${child}/${r.file}`).sort().join(", ")}` };
  }
  const cov = coverageNote(wg);
  return { file, entries: [], note: `no definitions indexed for this file in any of the ${wg.loaded.length} workspace ${wg.unit}(s)${cov ? `\n${cov}` : ""}` };
}

/** Resolve a symbol across every child, grouped per child. Reuses the shared
 * traverse-cli formatters so each block reads exactly like `graft callers`. */
export function federateCallers(
  root: string,
  override: string | undefined,
  symbol: string,
  opts: { direction?: Direction; depth?: number; in?: string } = {},
): { text: string; found: boolean } {
  const wg = loadWorkspaceGraphs(root, override);
  const direction: Direction = opts.direction ?? "in";
  const depth = opts.depth && opts.depth >= 1 ? Math.floor(opts.depth) : 1;
  const showDepth = depth > 1;

  const scopeFor = inScope(wg.loaded.map((l) => l.child), opts.in);

  // A repository built in parts with current links: each part's edges less the
  // ones the links void, and the walk carried on through the links into the
  // other parts (`parts-walk.ts`). At most two parts' maps are read at a time.
  const current = currentLinks(wg, root, override);
  const links = current?.links;
  const idx = current?.idx;
  const byChild = new Map(wg.loaded.map((c) => [c.child, c]));
  // Each part's walk edges, read once and kept for the walks of the parts after
  // it; when the repository's maps are too big to keep, only for the walks of
  // one part's matches, so they never add up to the edges of every part.
  const adjacency = new Map<string, Adjacency | undefined>();
  const edgesOf = (part: string) => {
    if (!adjacency.has(part)) {
      const c = byChild.get(part);
      adjacency.set(part, c && idx ? withChildGraph(wg, c, (g) => adjacencyOf(idx, part, g, direction)) : undefined);
    }
    return adjacency.get(part);
  };
  /** The sizes of the files every block shows (the matched symbols' and their
   * callers' or callees', in this part or another), from the root: the one
   * "tokens saved" baseline of the whole answer, as `callersSavings` makes it
   * for one map. */
  const sizes = new Map<string, number>();
  /** The line of each hit in another part than the walk's, with its path from
   * the root, and the hits still waiting for their part's map, by part. A part's
   * hits are rendered when the loop below reads its map anyway, or after it,
   * once for all the walks that reached the part before. */
  const line = new Map<PartHit, string>();
  const waiting = new Map<string, PartHit[]>();
  const renderWaiting = (part: string, g: GraphV1): void => {
    const hits = waiting.get(part);
    if (!hits) return;
    waiting.delete(part);
    const wanted = new Set(hits.map((h) => h.id));
    const nodes = new Map<string, NodeV1>();
    for (const n of g.nodes) if (wanted.has(n.id)) nodes.set(n.id, n);
    noteSizes(sizes, part, g, [...nodes.values()].map((n) => n.path));
    for (const h of hits) {
      const n = nodes.get(h.id);
      const node = n ? { ...n, path: `${part}/${n.path}` } : null;
      line.set(h, hitLine(direction, { node, id: node ? h.id : `${part}/${h.id}`, relation: h.relation, depth: h.depth }, showDepth));
    }
  };

  /** One matched symbol's lines: its header, its hits in its own part (or the
   * note for none), and its hits in other parts, rendered at the end. */
  type Result = { header: string; own: string[]; loose: string; across: PartHit[] };
  const blocks: { child: string; results: Result[] }[] = [];
  const defParts = new Set<string>();
  /** True while every match is a file: other parts then name its module. */
  let filesOnly = true;
  for (const c of wg.loaded) {
    const { child } = c;
    const scope = scopeFor(child);
    if (scope.skip) continue;
    const results = withChildGraph(wg, c, (full): Result[] | undefined => {
      // The hits the walks before this part reached in it.
      renderWaiting(child, full);
      const matches = resolveSymbol(full, symbol, scope.in ? { in: scope.in } : {});
      if (matches.length === 0) return undefined;
      defParts.add(child);
      if (matches.some((m) => m.kind !== "file")) filesOnly = false;
      const graph = idx ? idx.withoutVoids(child, full) : full;
      if (idx && depth > 1 && !adjacency.has(child)) adjacency.set(child, adjacencyOf(idx, child, full, direction));
      const walks = matches.map((m) => {
        const hits = edgeWalk(graph, m, direction, depth);
        if (!idx) return { symbol: m, hits, reached: [] as PartHit[] };
        const local = new Set(hits.map((h) => h.id));
        const seeds = walkSeeds(graph, m, depth).map((n) => n.id);
        const reached = crossWalk(idx, child, seeds, direction, depth, edgesOf)
          .filter((h) => h.part !== child || !local.has(h.id));
        return { symbol: m, hits, reached };
      });
      // A node of this part reached over a link (an edge its map could not settle
      // alone, or a walk out of the part and back) is listed with the part's own,
      // as one map lists it; the nodes of other parts wait for their part's map.
      const mine = new Set(walks.flatMap((w) => w.reached.filter((h) => h.part === child).map((h) => h.id)));
      const nodes = new Map<string, NodeV1>();
      if (mine.size) for (const n of graph.nodes) if (mine.has(n.id)) nodes.set(n.id, n);
      const paths: string[] = [];
      const out = walks.map(({ symbol: sym, hits, reached }): Result => {
        const own = [...hits];
        const across: PartHit[] = [];
        for (const h of reached) {
          if (h.part === child) own.push({ node: nodes.get(h.id) ?? null, id: h.id, relation: h.relation, depth: h.depth });
          else {
            across.push(h);
            const list = waiting.get(h.part);
            if (list) list.push(h);
            else waiting.set(h.part, [h]);
          }
        }
        if (own.length > hits.length) own.sort((a, b) => a.depth - b.depth);
        paths.push(sym.path);
        for (const h of own) if (h.node) paths.push(h.node.path);
        return {
          header: headerOf(sym, graph),
          own: own.map((h) => hitLine(direction, h, showDepth, undefined, graph)),
          loose: looseNoteFor(direction, sym.name, matches.length, graph),
          across,
        };
      });
      noteSizes(sizes, child, full, paths);
      return out;
    });
    if (wg.release) adjacency.clear();
    if (results === undefined) continue;
    blocks.push({ child, results });
  }
  // The hits of the parts read before the walk that reached them (or left out
  // of the loop by `--in`): each such part read once more, for all of them.
  for (const part of [...waiting.keys()]) {
    const c = byChild.get(part);
    if (c) withChildGraph(wg, c, (g) => renderWaiting(part, g));
  }
  const found = blocks.length > 0;

  const cov = coverageNote(wg);
  if (!found) {
    const base = `no symbol "${symbol}" in any of the ${wg.loaded.length} workspace ${wg.unit}(s) — check spelling or run ${cmd("graft build")}`;
    return { text: cov ? `${base}\n${cov}` : base, found: false };
  }
  let text = blocks
    .map(({ child, results }) => {
      const lines = [`## ${child}/`];
      for (const r of results) {
        lines.push(r.header);
        const across = r.across.map((h) => line.get(h)).filter((l): l is string => l !== undefined);
        if (r.own.length === 0 && across.length === 0) lines.push(r.loose);
        else lines.push(...r.own);
        if (across.length) lines.push(`  across parts:`, ...across);
      }
      return lines.join("\n");
    })
    .join("\n\n");
  const label = direction === "in" ? "callers" : "callees";
  if (wg.unit === "part" && !links) {
    // No links (parts built by an older graft): a caller in another part has no edge.
    text += `\n\n${label} in other parts are not tracked (${cmd("graft build --all-parts")} links the parts)`;
    if (direction === "in") {
      const others = wg.loaded.filter((c) => !defParts.has(c.child));
      const guess = textCallersIn(root, wg, others, symbol, filesOnly);
      if (guess) text += `\n${guess}`;
    }
  } else if (links && links.missing.length) {
    const unlinked = new Set(links.missing);
    text += `\n\n${label} in ${links.missing.map((p) => `${p}/`).join(", ")} are not tracked: not linked (built by an older graft, or not built)`;
    if (direction === "in") {
      const others = wg.loaded.filter((c) => unlinked.has(c.child) && !defParts.has(c.child));
      const guess = textCallersIn(root, wg, others, symbol, filesOnly);
      if (guess) text += `\n${guess}`;
    }
  }
  if (cov) text += `\n\n${cov}`;
  return { text: withSavings(text, savingsOf(sizes)), found: true };
}

/** How many enclosing symbols {@link textCallersIn} lists at most. */
const TEXT_CALLERS_MAX = 10;
/** Hits collected per part by {@link textCallersIn}, whose files are read no
 * further once found, so a common name stays cheap. */
const TEXT_CALLERS_HITS_PER_PART = 200;

/** The bare name a callers query is about, as code elsewhere names it:
 * `Cache.get` → `get`, `a.ts#f` → `f`, and for a query that matched files only
 * (`file`) the file's name less its extension, `src/cache.ts` → `cache`. */
function bareName(symbol: string, file: boolean): string {
  const tail = symbol.slice(symbol.lastIndexOf("#") + 1);
  if (!file) return tail.slice(tail.lastIndexOf(".") + 1);
  const base = tail.slice(Math.max(tail.lastIndexOf("/"), tail.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * "Possible callers in other parts (text match, unverified)": the symbols in
 * `parts` whose code names `symbol` (a file's module, when it matched files
 * only: `file`) as a whole word, found with `grepGraph` one part at a time
 * (like {@link federateGrep}), most coupled first. A text match, not an edge: it
 * may be a comment, a string, or a same-named symbol. Empty when nothing matches.
 */
function textCallersIn(root: string, wg: WorkspaceGraphs, parts: LoadedChild[], symbol: string, file: boolean): string {
  const name = bareName(symbol, file);
  if (!/^[\p{L}\p{N}_$]+$/u.test(name)) return "";
  const word = new RegExp(`(^|[^\\p{L}\\p{N}_$])${name.replace(/\$/g, "\\$")}($|[^\\p{L}\\p{N}_$])`, "u");
  const groups: GrepGroup[] = [];
  for (const c of parts) {
    const r = withChildGraph(wg, c, (graph) =>
      grepGraph(graph, join(root, c.child), name, { match: word, maxHits: TEXT_CALLERS_HITS_PER_PART, stopAtMax: true }));
    for (const g of r?.groups ?? []) groups.push(childGroup(c.child, g));
  }
  if (groups.length === 0) return "";
  groups.sort(byCoupling);
  const lines = ["possible callers in other parts (text match, unverified):"];
  for (const g of groups.slice(0, TEXT_CALLERS_MAX)) {
    const at = g.hits[0]!.line;
    lines.push(g.symbol
      ? `  ~ ${g.symbol.name} (${g.symbol.path}:${g.symbol.span})  line ${at}`
      : `  ~ ${g.path}:${at} (module level)`);
  }
  if (groups.length > TEXT_CALLERS_MAX) lines.push(`  … and ${groups.length - TEXT_CALLERS_MAX} more: ${cmd("graft grep")} "${name}"`);
  return lines.join("\n");
}

/**
 * Split a parent into a workspace: build each git child (via the supplied
 * `buildChild` callback, so this stays free of any engine/LLM dependency),
 * then REPLACE the parent's `graft/` with just `workspace.json`. `onStart`
 * fires once — before any child is built — carrying whether this build is a
 * mega-graph migration, so the caller can print the one-time split warning
 * first, exactly as the spec requires.
 *
 * The child build writes into `<child>/graft/` and is byte-identical to
 * building that child standalone (`buildChild` is just `buildGraph(childDir)`),
 * because nothing about the parent path enters the child's build.
 */
export async function splitWorkspace(
  root: string,
  override: string | undefined,
  buildChild: (childDir: string, childName: string) => Promise<void>,
  onStart?: (info: { children: string[]; migrated: boolean }) => void,
): Promise<{ children: string[]; migrated: boolean }> {
  const children = discoverWorkspaceChildren(root).slice().sort();
  const migrated = hasMegaGraph(root, override);
  onStart?.({ children, migrated });
  for (const child of children) await buildChild(join(root, child), child);
  clearParentGraft(root, override); // drop the mega-graph/.cache/cards…
  writeWorkspace(root, { version: 1, children }, override); // …leaving ONLY workspace.json
  return { children, migrated };
}

export { formatGrepResult, zeroHitNote };
