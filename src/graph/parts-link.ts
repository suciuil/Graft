/**
 * The links between the parts of a repository built in parts
 * (`graph/parts-build.ts`): the calls, imports, references and base types that
 * cross from one part's map into another's, which no part's own build can see.
 *
 *   <repository map>/.cache/links.json
 *
 * Made from the parts' boundaries (`graph/boundary.ts`), never from their maps,
 * so it holds only the few fields resolution reads of every part at once. The
 * boundaries' nodes are put together under paths prefixed with their part
 * (`app.ts` of `Src/App` → `Src/App/app.ts`), and the edges each part could not
 * settle (`pending`) or settled by a name unique in that part alone (`inferred`)
 * are resolved again against all of them, by the same resolver a single map uses
 * (`resolveEdges`), with every part's base types in view. The data nodes a
 * boundary keeps apart are read only for the files a named import names.
 *
 * - `links`: an edge from a node of one part to a node of another, in each
 *   part's own ids (`from` + `source`, `to` + `target`), as a single map holding
 *   both parts would have it; or to a node of the same part, for an edge the
 *   part could not settle alone (a path that leaves its folder and comes back).
 * - `voids`: edges a part's map has that a single map would not: the bare name
 *   or specifier a part kept for what turns out to be in another part (now a
 *   link), and a name-guessed edge the other parts make ambiguous.
 * - `parts`: the hash of the boundary each part had (null: none), so a query can
 *   tell whether the links still match the parts' maps.
 *
 * Out of scope: Go modules spanning parts are resolved only as far as each
 * part's `go.mod` reaches, links found by `--lsp` are not made, and a folder of
 * separate repos (a workspace without `kind: "parts"`) gets no links.
 */
import { closeSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, contextDirFor } from "../context/node-file.js";
import { readJson, writeJsonAtomic } from "../util/state.js";
import { boundaryHash, readBoundary, readBoundaryData, type BoundaryNode } from "./boundary.js";
import { extractorStamp } from "./extract-cache.js";
import type { RawEdge } from "./extract.js";
import { moduleBySuffix, resolveEdges, resolveImport, type GoModule } from "./resolve.js";
import type { EdgeV1, NodeV1, Relation } from "./types.js";
import { isPartsWorkspace, readWorkspace } from "./workspace.js";

/** Bump when the shape below changes. */
const LINKS_VERSION = 1;
const LINKS_FILE = "links.json";

/** An edge from one part into another, in each part's own ids; from a part into
 * itself (`from` = `to`) for an edge the part could not settle alone. */
export interface PartLink {
  from: string;
  source: string;
  to: string;
  target: string;
  relation: Relation;
  confidence: EdgeV1["confidence"];
}

/** An edge of a part's map that a single map would not have. */
export interface VoidEdge {
  part: string;
  source: string;
  target: string;
  relation: Relation;
}

export interface LinksV1 {
  version: number;
  extractor: string;
  /** Each listed part and the hash of the boundary its links were made from; null: it had none. */
  parts: Record<string, string | null>;
  links: PartLink[];
  voids: VoidEdge[];
}

export interface LinkResult {
  /** Parts whose boundary went in. */
  linked: number;
  /** Parts with no boundary (built by an older graft, or not built): not linked. */
  missing: string[];
  links: number;
  voids: number;
  /** Where the links were written; undefined when no part had a boundary. */
  path?: string;
}

/** Where a repository built in parts keeps its links. */
export function linksPath(root: string, override?: string): string {
  return join(contextDirFor(root, override), CACHE_DIR, LINKS_FILE);
}

/** A part's own id, prefixed with the part. */
const prefix = (part: string, id: string): string => `${part}/${id}`;

function asNode(n: BoundaryNode, part: string): NodeV1 {
  return {
    ...n,
    id: prefix(part, n.id),
    path: prefix(part, n.path),
    span: "", // resolution reads no line
    signature: n.signature ?? null,
    exported: true,
    body_hash: "",
    summary_state: "none",
    summary: null,
    crux: null,
  };
}

function asEdge(e: RawEdge, part: string): RawEdge {
  const out: RawEdge = { ...e, source: prefix(part, e.source), file: prefix(part, e.file) };
  if (e.targetId !== undefined) out.targetId = prefix(part, e.targetId);
  return out;
}

type Role = { part: string; kept?: string; pending: true } | { part: string; target: string; pending: false };

/**
 * Add to `nodes` the data nodes (`boundary.ts`) the edges can reach: those of a
 * file a named import names (`import { version } from "../Lib/package.json"`),
 * found as `resolveEdges` finds it, and the node a part's guess points at (no
 * guess points at a data node, as no edge looks one up by its name; read all the
 * same, so such a guess is not made void for a node left out). Only those files'
 * nodes are added, so a data file of a part that other code does not import
 * changes nothing; a part whose data nodes are being rewritten gives none.
 */
function addDataNodes(
  root: string,
  nodes: NodeV1[],
  partOf: Map<string, string>,
  raws: readonly RawEdge[],
  roles: ReadonlyMap<RawEdge, Role>,
  dataFile: ReadonlyMap<string, string>,
  dataHash: ReadonlyMap<string, string>,
): void {
  const wanted = new Map<string, Set<string>>();
  const want = (path: string): void => {
    const part = dataFile.get(path);
    if (part === undefined) return;
    let set = wanted.get(part);
    if (!set) wanted.set(part, (set = new Set()));
    set.add(path);
  };
  const files = new Set<string>();
  for (const n of nodes) if (n.kind === "file") files.add(n.id);
  for (const e of raws) {
    // A module found by a path suffix is always a file of the importing language.
    if (e.relation !== "references" || !e.name || !e.specifier || moduleBySuffix(e.file)) continue;
    want(resolveImport(e.specifier, e.file, files));
  }
  for (const role of roles.values()) {
    if (role.pending) continue;
    const hash = role.target.indexOf("#");
    if (hash > 0) want(prefix(role.part, role.target.slice(0, hash)));
  }
  for (const [part, paths] of wanted) {
    for (const n of readBoundaryData(contextDirFor(join(root, part)), dataHash.get(part)!) ?? []) {
      if (!paths.has(prefix(part, n.path))) continue;
      const node = asNode(n, part);
      nodes.push(node);
      partOf.set(node.id, part);
    }
  }
}

/**
 * Make the links of the repository at `root` from its parts' boundaries and
 * write them. Null when `root` is not a repository built in parts. When no part
 * has a boundary, any links written before are removed and none are written.
 */
export function linkParts(root: string, override?: string): LinkResult | null {
  const ws = readWorkspace(root, override);
  if (!ws || !isPartsWorkspace(ws)) return null;
  const children = [...ws.children].sort();
  // No prototype: a part may have any name, `__proto__` too.
  const parts: Record<string, string | null> = Object.create(null);
  const missing: string[] = [];
  const nodes: NodeV1[] = [];
  const partOf = new Map<string, string>();
  const raws: RawEdge[] = [];
  const roles = new Map<RawEdge, Role>();
  const goModules: GoModule[] = [];
  /** Each part's data nodes' hash, and the part each file of them is in (by its path here). */
  const dataHash = new Map<string, string>();
  const dataFile = new Map<string, string>();
  for (const part of children) {
    const b = readBoundary(contextDirFor(join(root, part)));
    parts[part] = b?.hash ?? null;
    if (!b) {
      missing.push(part);
      continue;
    }
    for (const n of b.nodes) {
      const node = asNode(n, part);
      nodes.push(node);
      partOf.set(node.id, part);
    }
    if (b.data) {
      dataHash.set(part, b.data.hash);
      for (const f of b.data.files) dataFile.set(prefix(part, f), part);
    }
    for (const m of b.goModules) goModules.push({ module: m.module, dir: m.dir === "." ? part : prefix(part, m.dir) });
    // Every part's base types, so a member call is followed up a class chain across parts.
    for (const e of b.heritage) raws.push(asEdge(e, part));
    for (const p of b.pending) {
      const e = asEdge(p.edge, part);
      raws.push(e);
      roles.set(e, p.kept === undefined ? { part, pending: true } : { part, kept: p.kept, pending: true });
    }
    for (const i of b.inferred) {
      const e = asEdge(i.edge, part);
      raws.push(e);
      roles.set(e, { part, target: i.target, pending: false });
    }
  }
  const path = linksPath(root, override);
  if (lastRead?.path === path) lastRead = undefined;
  if (missing.length === children.length) {
    rmSync(path, { force: true });
    return { linked: 0, missing, links: 0, voids: 0 };
  }
  if (dataFile.size > 0) addDataNodes(root, nodes, partOf, raws, roles, dataFile, dataHash);

  const results = new Map<RawEdge, EdgeV1[]>();
  resolveEdges(nodes, raws, {
    goModules,
    onEdge: (raw, edge) => {
      if (!roles.has(raw)) return;
      const list = results.get(raw);
      if (list) list.push(edge);
      else results.set(raw, [edge]);
    },
  });

  const links = new Map<string, PartLink>();
  const voids = new Map<string, VoidEdge>();
  const local = (part: string, id: string): string => id.slice(part.length + 1);
  const addVoid = (v: VoidEdge): void => {
    voids.set(`${v.part}\0${v.source}\0${v.relation}\0${v.target}`, v);
  };
  /**
   * Link what `made` points at, but `has` (the edge the part's map already has);
   * true when it linked any. An edge the part could not settle alone may lead back
   * into the part itself (`../App/util` from `Src/App`, or a base type in another
   * part whose member is in this one): it is linked there, from the part to itself.
   */
  const linkAll = (part: string, source: string, made: readonly EdgeV1[], has?: string): boolean => {
    let linked = false;
    for (const e of made) {
      const to = partOf.get(e.target);
      if (to === undefined || e.target === has) continue;
      const link: PartLink = { from: part, source, to, target: local(to, e.target), relation: e.relation, confidence: e.confidence };
      links.set(`${link.from}\0${link.source}\0${link.relation}\0${link.to}\0${link.target}`, link);
      linked = true;
    }
    return linked;
  };
  for (const [raw, role] of roles) {
    const made = results.get(raw) ?? [];
    const source = local(role.part, raw.source);
    if (role.pending) {
      // The part's map points the edge at a bare name or specifier: the link replaces it.
      if (linkAll(role.part, source, made) && role.kept !== undefined) {
        addVoid({ part: role.part, source, target: role.kept, relation: raw.relation });
      }
    } else {
      // A name unique in the part alone: kept only when every part together still
      // picks it. Every part together may pick one in another part instead (one
      // the caller's file imports), which a single map would link.
      const want = prefix(role.part, role.target);
      if (!made.some((e) => e.target === want)) addVoid({ part: role.part, source, target: role.target, relation: raw.relation });
      linkAll(role.part, source, made, want);
    }
  }

  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const out: LinksV1 = {
    version: LINKS_VERSION,
    extractor: extractorStamp() ?? "",
    parts,
    links: [...links.entries()].sort(([a], [b]) => order(a, b)).map(([, l]) => l),
    voids: [...voids.entries()].sort(([a], [b]) => order(a, b)).map(([, v]) => v),
  };
  writeJsonAtomic(path, out, true);
  return { linked: children.length - missing.length, missing, links: out.links.length, voids: out.voids.length, path };
}

/** The `parts` of the links written for `root`, read from the head of the file
 * (where {@link linkParts} puts it) instead of parsing every link; null when there
 * are none, or they were written by other code. */
function linkedParts(path: string): Record<string, string | null> | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    let head = "";
    const buf = Buffer.alloc(64 * 1024);
    for (let at = 0; ; ) {
      const len = readSync(fd, buf, 0, buf.length, at);
      if (len === 0) return null;
      head += buf.subarray(0, len).toString("latin1");
      at += len;
      const end = head.indexOf(',"links":');
      if (end < 0) continue;
      const h = JSON.parse(Buffer.from(head.slice(0, end), "latin1").toString("utf8") + "}") as Partial<LinksV1>;
      if (h.version !== LINKS_VERSION || h.extractor !== (extractorStamp() ?? "") || !h.parts) return null;
      return h.parts;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export type LinksState =
  /** Links match every part's map as it is now. */
  | { state: "current"; missing: string[] }
  /** Links were made from other maps than the parts have now, or none were made. */
  | { state: "stale" | "none" };

/**
 * Whether the links of `root` match its parts' maps: each listed part has the
 * boundary its links were made from (or still has none, which `missing` names).
 * Reads only the head of each boundary and of the links.
 */
export function linksState(root: string, override?: string): LinksState {
  const ws = readWorkspace(root, override);
  if (!ws || !isPartsWorkspace(ws)) return { state: "none" };
  const recorded = linkedParts(linksPath(root, override));
  if (!recorded) return { state: "none" };
  const children = ws.children;
  if (Object.keys(recorded).length !== children.length) return { state: "stale" };
  const missing: string[] = [];
  for (const part of children) {
    if (!Object.hasOwn(recorded, part)) return { state: "stale" };
    const now = boundaryHash(contextDirFor(join(root, part)));
    if (now !== recorded[part]) return { state: "stale" };
    if (now === null) missing.push(part);
  }
  return { state: "current", missing: missing.sort() };
}

/** The links file last parsed, kept while it is unchanged: a long-lived process
 * (the MCP server) asks again and again, and parsing them costs as much each
 * time. `linkParts` drops it when it writes the file. */
let lastRead: { path: string; mtimeMs: number; size: number; links: LinksV1 } | undefined;

/** The links of `root` when they match its parts' maps, or null. While the file
 * is unchanged, each call hands back the same `links` and `voids` arrays. */
export function readLinks(root: string, override?: string): (LinksV1 & { missing: string[] }) | null {
  const s = linksState(root, override);
  if (s.state !== "current") return null;
  const path = linksPath(root, override);
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  if (lastRead?.path !== path || lastRead.mtimeMs !== st.mtimeMs || lastRead.size !== st.size) {
    lastRead = undefined;
    const l = readJson<LinksV1>(path);
    if (!l || l.version !== LINKS_VERSION || !Array.isArray(l.links) || !Array.isArray(l.voids)) return null;
    lastRead = { path, mtimeMs: st.mtimeMs, size: st.size, links: l };
  }
  return { ...lastRead.links, missing: s.missing };
}

/**
 * The hash of every part's boundary, as one key that changes whenever any part's
 * map does (`refresh.ts` `refreshLinks` remembers a failed link step by it).
 * Null when `root` is not a repository built in parts, or none of its parts has
 * a boundary (all built by an older graft): there is nothing to link.
 */
export function boundaryKey(root: string, override?: string): string | null {
  const ws = readWorkspace(root, override);
  if (!ws || !isPartsWorkspace(ws)) return null;
  let any = false;
  const key = [...ws.children]
    .sort()
    .map((part) => {
      const hash = boundaryHash(contextDirFor(join(root, part)));
      if (hash !== null) any = true;
      return `${part}\0${hash ?? ""}`;
    })
    .join("\n");
  return any ? key : null;
}
