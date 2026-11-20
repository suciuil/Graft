/**
 * The boundary of one part of a repository built in parts
 * (`graph/parts-build.ts`): what the link step (`graph/parts-link.ts`) needs to
 * resolve, against every part at once, the edges this part could not settle by
 * itself — without loading any part's map.
 *
 *   <part map>/.cache/boundary.<stamp>.json
 *
 * - `nodes`: every node of the part, as the few fields resolution reads (the
 *   name, kind, owner, path, origin, arity; the signature only where it decides
 *   something: a Java `@interface`). Paths are the part's own, relative to its
 *   folder; the link step prefixes them with the part. No line numbers: an edit
 *   that only moves code leaves the boundary, and so the links, as they were.
 * - `heritage`: every other `extends`/`implements` edge of the part (those not
 *   in `pending` or `inferred`), so a member call is followed up a class chain
 *   that crosses parts.
 * - `pending`: the edges the resolver found nothing for (`ResolveCollector`),
 *   with the target the part's map kept them pointing at, when it kept one.
 * - `inferred`: the edges resolved by a name unique in the part alone, which a
 *   name defined again in another part would have made ambiguous.
 * - `data`: the files whose data nodes (the keys of a JSON or YAML file, the
 *   elements of an XML file, ...) are kept apart, in
 *   `<part map>/.cache/boundary-data.<stamp>.json`, with that file's hash; null
 *   when the part has none. Nothing resolves to such a node by its name alone
 *   (each data language is a family of its own, and none of them has edges that
 *   look a name up), only a named import of the file (`import { version } from
 *   "./package.json"`) does, so the link step reads them only for the files such
 *   an import names. They are most of the nodes of a part that holds data.
 * - `hash`: a hash of all of the above (the data file's through its hash), so
 *   the link layer can tell whether it was made from the boundaries the parts
 *   have now.
 *
 * The stamp is the extractor's (`extract-cache.ts`), which covers the resolver:
 * a boundary written by other code is not read. A part built without one (an
 * older build, a graft with no stamp) has none, and the link layer is not made.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR } from "../context/node-file.js";
import { readJson, writeTextAtomic } from "../util/state.js";
import { extractorStamp, pruneSidecars } from "./extract-cache.js";
import { languageOf, type Language, type RawEdge } from "./extract.js";
import type { GoModule, ResolveCollector } from "./resolve.js";
import type { Kind, NodeV1 } from "./types.js";

/** Bump when the shape below changes. */
const BOUNDARY_VERSION = 3;
const BOUNDARY_PREFIX = "boundary";
const BOUNDARY_DATA_PREFIX = "boundary-data";

/** Languages that hold data, not code: no edge looks one of their nodes up by
 * its name alone (`resolve.ts` keeps every one of them a family of its own). */
const DATA_LANGUAGES: ReadonlySet<Language> = new Set<Language>(["json", "yaml", "xml", "csv", "html", "css", "markdown", "text"]);
/** The kinds of node those languages' extractors make, other than the file. */
const DATA_KINDS: ReadonlySet<Kind> = new Set<Kind>(["variable", "element", "rule", "heading", "chunk"]);

/** A node as resolution reads it. */
export type BoundaryNode = Pick<NodeV1, "id" | "name" | "kind" | "path" | "origin"> &
  Partial<Pick<NodeV1, "owner" | "arity" | "variadic">> & { signature?: string };

export interface PendingEdge {
  edge: RawEdge;
  /** What the part's map points the edge at instead (a specifier, a bare name). */
  kept?: string;
}

export interface InferredEdge {
  edge: RawEdge;
  target: string;
}

/** Where a part's data nodes are, and what they hash to. */
export interface BoundaryData {
  hash: string;
  /** The files they are in, sorted. */
  files: string[];
}

export interface PartBoundary {
  version: number;
  extractor: string;
  hash: string;
  goModules: GoModule[];
  nodes: BoundaryNode[];
  heritage: RawEdge[];
  pending: PendingEdge[];
  inferred: InferredEdge[];
  data: BoundaryData | null;
}

/** The data nodes of a part, kept apart from its boundary. */
interface PartBoundaryData {
  version: number;
  extractor: string;
  hash: string;
  nodes: BoundaryNode[];
}

const sidecar = (mapDir: string, prefix: string): string | null => {
  const stamp = extractorStamp();
  return stamp === null ? null : join(mapDir, CACHE_DIR, `${prefix}.${stamp}.json`);
};

/** Where this graft keeps a map's boundary; null when it has no stamp. */
export function boundaryPath(mapDir: string): string | null {
  return sidecar(mapDir, BOUNDARY_PREFIX);
}

/** Where this graft keeps the data nodes of a map's boundary; null when it has no stamp. */
export function boundaryDataPath(mapDir: string): string | null {
  return sidecar(mapDir, BOUNDARY_DATA_PREFIX);
}

/** True when the map has a boundary of any graft's: a part of a repository built
 * in parts, which a rebuild (the refresh before a query) keeps writing. */
export function hasBoundary(mapDir: string): boolean {
  try {
    return readdirSync(join(mapDir, CACHE_DIR)).some((f) => f.startsWith(`${BOUNDARY_PREFIX}.`) && f.endsWith(".json"));
  } catch {
    return false;
  }
}

/** A collector recording what a part's resolver could not settle, for {@link writeBoundary}. */
export function boundaryCollector(): ResolveCollector & { collected: Collected } {
  const collected: Collected = { pending: [], inferred: [] };
  return {
    collected,
    unresolved: (edge, kept) => {
      collected.pending.push(kept === undefined ? { edge } : { edge, kept });
    },
    inferred: (edge, target) => {
      collected.inferred.push({ edge, target });
    },
  };
}

/** What a part's resolver could not settle. */
export interface Collected {
  pending: PendingEdge[];
  inferred: InferredEdge[];
}

function stub(n: NodeV1): BoundaryNode {
  const s: BoundaryNode = { id: n.id, name: n.name, kind: n.kind, path: n.path, origin: n.origin };
  if (n.owner !== undefined) s.owner = n.owner;
  if (n.arity !== undefined) s.arity = n.arity;
  if (n.variadic) s.variadic = true;
  if (n.signature?.includes("@interface")) s.signature = n.signature;
  return s;
}

/** A boundary serialized, as {@link writeBoundary} writes it. */
export interface BoundaryText {
  hash: string;
  /** The whole file: a {@link PartBoundary} as compact JSON, the hash near the head. */
  text: string;
  /** The data nodes' file, the same way; undefined when the part has none. */
  data?: string;
}

/** `body` (a JSON object) with a head carrying its hash, which `boundaryHash`
 * reads without parsing the rest. */
function withHead(body: string): { hash: string; text: string } {
  const version = BOUNDARY_VERSION;
  const extractor = extractorStamp() ?? "";
  const hash = createHash("sha256").update(`${version}\0${extractor}\0`).update(body).digest("hex").slice(0, 16);
  const head = JSON.stringify({ version, extractor, hash });
  return { hash, text: `${head.slice(0, -1)},${body.slice(1)}` };
}

/**
 * The boundary of a part from what its build resolved, serialized once: the
 * same string is hashed and written, which on a big part is most of the cost
 * (and twice the memory, if done twice).
 *
 * `heritage` holds only the base-type edges the collector did not already put in
 * `pending` or `inferred`: the link step resolves every edge it is given, and a
 * base type given twice reads as two (a PHP trait used twice makes each of its
 * methods ambiguous).
 */
export function makeBoundary(
  nodes: readonly NodeV1[],
  rawEdges: readonly RawEdge[],
  collected: Collected,
  goModules: GoModule[],
): BoundaryText {
  const reported = new Set<RawEdge>();
  for (const p of collected.pending) reported.add(p.edge);
  for (const i of collected.inferred) reported.add(i.edge);
  const dataPath = new Map<string, boolean>();
  const isData = (n: NodeV1): boolean => {
    if (!DATA_KINDS.has(n.kind)) return false;
    let yes = dataPath.get(n.path);
    if (yes === undefined) {
      const lang = languageOf(n.path);
      dataPath.set(n.path, (yes = lang !== null && DATA_LANGUAGES.has(lang)));
    }
    return yes;
  };
  const kept: BoundaryNode[] = [];
  const apart: BoundaryNode[] = [];
  const files = new Set<string>();
  for (const n of nodes) {
    if (isData(n)) {
      apart.push(stub(n));
      files.add(n.path);
    } else kept.push(stub(n));
  }
  const side = apart.length > 0 ? withHead(JSON.stringify({ nodes: apart })) : undefined;
  const main = withHead(
    JSON.stringify({
      goModules,
      nodes: kept,
      heritage: rawEdges.filter((e) => (e.relation === "extends" || e.relation === "implements") && !reported.has(e)),
      pending: collected.pending,
      inferred: collected.inferred,
      data: side ? ({ hash: side.hash, files: [...files].sort() } satisfies BoundaryData) : null,
    }),
  );
  return side ? { ...main, data: side.text } : main;
}

/** Write a part's boundary. Best-effort: false when nothing was written (no
 * stamp, an unwritable folder); the link layer then leaves that part out. The
 * data nodes go first: a link step reading in between finds the boundary it
 * had with data nodes of another hash, leaves them out, and the boundary
 * written next makes its links stale. `null` (none could be made for the map
 * just written) removes the one there, so that map's part is left out rather
 * than linked as it was before; false then too. */
export function writeBoundary(mapDir: string, boundary: BoundaryText | null): boolean {
  const path = boundaryPath(mapDir);
  const dataPath = boundaryDataPath(mapDir);
  if (path === null || dataPath === null) return false;
  try {
    if (boundary === null) {
      rmSync(path, { force: true });
      rmSync(dataPath, { force: true });
      return false;
    }
    const cache = join(mapDir, CACHE_DIR);
    if (boundary.data !== undefined) {
      writeTextAtomic(dataPath, boundary.data);
      pruneSidecars(cache, BOUNDARY_DATA_PREFIX);
    } else rmSync(dataPath, { force: true });
    writeTextAtomic(path, boundary.text);
    pruneSidecars(cache, BOUNDARY_PREFIX);
    return true;
  } catch {
    return false;
  }
}

const validData = (d: unknown): d is BoundaryData | null =>
  d === null || (typeof d === "object" && typeof (d as BoundaryData).hash === "string" && Array.isArray((d as BoundaryData).files));

/** A map's boundary written by this graft, or null. */
export function readBoundary(mapDir: string): PartBoundary | null {
  const path = boundaryPath(mapDir);
  if (path === null) return null;
  const b = readJson<PartBoundary>(path);
  if (!b || b.version !== BOUNDARY_VERSION || b.extractor !== extractorStamp() || !Array.isArray(b.nodes) || !validData(b.data)) {
    return null;
  }
  return b;
}

/** The data nodes of a map's boundary, when they are the ones of hash `hash`
 * (the boundary's `data.hash`); null otherwise (being rewritten, or gone). */
export function readBoundaryData(mapDir: string, hash: string): BoundaryNode[] | null {
  const path = boundaryDataPath(mapDir);
  if (path === null) return null;
  const d = readJson<PartBoundaryData>(path);
  if (!d || d.version !== BOUNDARY_VERSION || d.extractor !== extractorStamp() || d.hash !== hash || !Array.isArray(d.nodes)) {
    return null;
  }
  return d.nodes;
}

/** Just the hash of a map's boundary written by this graft, or null: what the
 * freshness check of the link layer compares, before every query. Read from the
 * head of the file, where {@link makeBoundary} puts it, not by parsing it all. */
export function boundaryHash(mapDir: string): string | null {
  const path = boundaryPath(mapDir);
  if (path === null) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(256);
    const len = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, len).toString("utf8");
    const m = head.match(/^\{"version":(\d+),"extractor":"([^"]*)","hash":"([0-9a-f]+)"/);
    if (!m || Number(m[1]) !== BOUNDARY_VERSION || m[2] !== extractorStamp()) return null;
    return m[3];
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
