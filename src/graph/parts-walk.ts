/**
 * Walking callers and callees across the parts of a repository built in parts,
 * with the links between them (`parts-link.ts`): the edges of each part's map,
 * less those the links void, plus the links, as if the parts were one map.
 *
 * The walk never holds more than the edges of the parts it reaches: each part's
 * map is read once, its walk edges kept as plain id lists, and the map itself
 * let go by the loader when the repository's maps are too big to keep (a
 * long-lived process keeps some within its budget: `load.ts` `doneWithMap`).
 */
import type { LinksV1 } from "./parts-link.js";
import { WALK_RELATIONS } from "./relations.js";
import { walkAdjacency, type Adjacency, type Direction } from "./traverse.js";
import type { EdgeV1, GraphV1, Relation } from "./types.js";

/** A node reached in some part. */
export interface PartHit {
  part: string;
  id: string;
  relation: Relation;
  depth: number;
}

type Step = { part: string; id: string; relation: Relation };

const voidKey = (source: string, relation: Relation, target: string): string => `${source}\0${relation}\0${target}`;
const nodeKey = (part: string, id: string): string => `${part}\0${id}`;
const NO_DELTA: ReadonlyMap<string, number> = new Map();

/** The links of a repository built in parts, indexed for walking. */
export class LinkIndex {
  private readonly voids = new Map<string, Set<string>>();
  private readonly into = new Map<string, Step[]>();
  private readonly outOf = new Map<string, Step[]>();
  private readonly delta = new Map<string, Map<string, number>>();

  constructor(links: Pick<LinksV1, "links" | "voids">) {
    const bump = (part: string, id: string, by: number): void => {
      let m = this.delta.get(part);
      if (!m) this.delta.set(part, (m = new Map()));
      m.set(id, (m.get(id) ?? 0) + by);
    };
    for (const v of links.voids) {
      let set = this.voids.get(v.part);
      if (!set) this.voids.set(v.part, (set = new Set()));
      set.add(voidKey(v.source, v.relation, v.target));
      if (WALK_RELATIONS.has(v.relation)) bump(v.part, v.target, -1);
    }
    for (const l of links.links) {
      if (!WALK_RELATIONS.has(l.relation)) continue;
      push(this.into, nodeKey(l.to, l.target), { part: l.from, id: l.source, relation: l.relation });
      push(this.outOf, nodeKey(l.from, l.source), { part: l.to, id: l.target, relation: l.relation });
      bump(l.to, l.target, 1);
    }
  }

  /** What to add to the in-degree of the nodes of `part`'s map (counted over
   * its walk edges) for the in-degree one map would give them: the links into
   * them, less the edges into them the links void. */
  inDegreeDelta(part: string): ReadonlyMap<string, number> {
    return this.delta.get(part) ?? NO_DELTA;
  }

  /** True when `part`'s map has an edge a single map would not. */
  isVoid(part: string, e: Pick<EdgeV1, "source" | "relation" | "target">): boolean {
    return this.voids.get(part)?.has(voidKey(e.source, e.relation, e.target)) ?? false;
  }

  /** `graph` (of `part`) less the edges the links void; the same graph when none. */
  withoutVoids(part: string, graph: GraphV1): GraphV1 {
    const set = this.voids.get(part);
    if (!set?.size) return graph;
    return { ...graph, edges: graph.edges.filter((e) => !set.has(voidKey(e.source, e.relation, e.target))) };
  }

  /** The nodes one link away from `id` of `part`: in other parts, or in `part`
   * itself for an edge its map could not settle alone. */
  across(part: string, id: string, direction: Direction): readonly Step[] {
    return (direction === "in" ? this.into : this.outOf).get(nodeKey(part, id)) ?? [];
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

/** The walk edges of one part's map, less its voids, keyed for `direction`. */
export function adjacencyOf(idx: LinkIndex, part: string, graph: GraphV1, direction: Direction): Adjacency {
  return walkAdjacency(graph, direction, (e) => idx.isVoid(part, e));
}

/**
 * Breadth-first from `seeds` (ids of `part`) up to `depth` hops, over every
 * part's edges and the links, each node reported once at the depth it was first
 * reached, like `impactOfMany`. At depth 1 only the links are followed: the
 * part's own edges are what its map's walk already gives. `edgesOf` hands back a
 * part's walk edges, or undefined for a part with no map.
 */
export function crossWalk(
  idx: LinkIndex,
  part: string,
  seeds: readonly string[],
  direction: Direction,
  depth: number,
  edgesOf: (part: string) => Adjacency | undefined,
): PartHit[] {
  const visited = new Set(seeds.map((id) => nodeKey(part, id)));
  const hits: PartHit[] = [];
  let frontier: { part: string; id: string }[] = seeds.map((id) => ({ part, id }));
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: { part: string; id: string }[] = [];
    const reach = (s: Step): void => {
      const k = nodeKey(s.part, s.id);
      if (visited.has(k)) return;
      visited.add(k);
      hits.push({ ...s, depth: d });
      next.push({ part: s.part, id: s.id });
    };
    for (const at of frontier) {
      for (const s of idx.across(at.part, at.id, direction)) reach(s);
      if (depth <= 1) continue;
      for (const { other, relation } of edgesOf(at.part)?.get(at.id) ?? []) reach({ part: at.part, id: other, relation });
    }
    frontier = next;
  }
  return hits;
}
