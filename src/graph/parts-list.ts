/**
 * `graft parts`: the parts a repository too big for one map was built in
 * (`graph/parts-build.ts`), listed by the names a query takes with
 * `--in <part>/` and a prompt to an AI assistant can use, with what each part's
 * map holds. A folder of separate repos (a workspace) is listed the same way,
 * since `--in <repo>/` narrows a query there too.
 *
 * Cheap on purpose: it reads the parts index, stats each part's graph and reads
 * each part's fingerprint for its file count. It never loads a part's graph,
 * which on a repository big enough to be built in parts can take a gigabyte.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, relative, resolve, join } from "node:path";
import { cmd } from "../brand.js";
import { contextDirFor } from "../context/node-file.js";
import { readFingerprint } from "./fingerprint.js";
import { boundaryKey, linksState } from "./parts-link.js";
import { isPartsWorkspace, readWorkspace } from "./workspace-index.js";
import { wiringPath } from "./write.js";

export interface PartInfo {
  /** The part's folder from the repository root, `/`-separated: the name `--in` takes (with a trailing `/`). */
  part: string;
  /** `built`: its map is there. `not-built`: listed, but its build failed or never
   * ran (the next `graft build` at the root tries it again). `gone`: its folder no
   * longer exists (the next `graft build` at the root drops it). */
  state: "built" | "not-built" | "gone";
  /** The folder its map is kept in. */
  map: string;
  /** Files its last build indexed, when known. */
  files?: number;
  /** Size of its graph on disk, in bytes. */
  bytes?: number;
  /** When its graph was last written (ISO 8601). */
  builtAt?: string;
}

export interface PartsReport {
  /** The repository (or workspace folder) reported on. */
  root: string;
  /** `parts`: built in parts. `repos`: a folder of separate repos, one map each.
   * `single`: one map holds the whole repository. `none`: no map at all. */
  kind: "parts" | "repos" | "single" | "none";
  /** `parts` / `repos`: each listed part or repo, sorted. Empty otherwise. */
  parts: PartInfo[];
  /** `parts`: whether the links between the parts (the calls, imports and
   * references that cross from one part into another) match their maps.
   * `unavailable`: no part's map has what links are made from (all built by an
   * older graft). */
  links?: "current" | "stale" | "none" | "unavailable";
  /** `parts`, links current: the parts left out of the links (not built, or built by an older graft). */
  unlinked?: string[];
  /** The part the command was run in, when it was run inside one: a query run
   * there searches that part alone. */
  here?: string;
  /** `single` / `none`: the repository's map folder. */
  map?: string;
  /** `single`: files the map holds, when known. */
  files?: number;
  /** `single`: the folders a map built with `--only-dir` is limited to. */
  onlyDirs?: string[];
}

const posix = (p: string): string => p.replace(/\\/g, "/");

/**
 * The root `graft parts` reports on for `start`, and the part `start` is in.
 * The nearest folder at or above `start` whose parts index lists a part holding
 * `start` (a part's own map is found first by a plain walk, so a session inside
 * a part would otherwise list nothing); else the nearest folder at or above it
 * with a map or an index, as every query finds it (`graph/root.ts`); else
 * `start`. A `--dir` override is taken for `start`'s own map: no walk.
 */
export function partsRootFor(start: string, override?: string): { root: string; here?: string } {
  const from = resolve(start);
  if (override) return { root: from };
  let nearest: string | undefined;
  for (let dir = from; ; ) {
    const ws = readWorkspace(dir);
    if (ws) {
      if (dir === from) return { root: from };
      const rel = posix(relative(dir, from));
      const part = isPartsWorkspace(ws) ? ws.children.find((p) => rel === p || rel.startsWith(`${p}/`)) : undefined;
      if (part) return { root: dir, here: part };
      nearest ??= dir;
    } else if (!nearest && existsSync(wiringPath(contextDirFor(dir)))) {
      nearest = dir;
    }
    const up = dirname(dir);
    if (up === dir) return { root: nearest ?? from };
    dir = up;
  }
}

function partInfo(root: string, part: string): PartInfo {
  const dir = join(root, part);
  const map = contextDirFor(dir);
  const info: PartInfo = { part, state: existsSync(dir) ? "built" : "gone", map };
  try {
    const st = statSync(wiringPath(map));
    info.bytes = st.size;
    info.builtAt = st.mtime.toISOString();
    const fp = readFingerprint(map);
    if (fp) info.files = Object.keys(fp.files).length;
  } catch {
    if (info.state === "built") info.state = "not-built";
  }
  return info;
}

/** What `graft parts` reports for `root` (see {@link partsRootFor}); `here`: the part it was run in. */
export function partsReport(root: string, override?: string, here?: string): PartsReport {
  const ws = readWorkspace(root, override);
  if (ws) {
    const parts = [...ws.children].sort().map((p) => partInfo(root, p));
    if (!isPartsWorkspace(ws)) return { root, kind: "repos", parts };
    const report: PartsReport = { root, kind: "parts", parts };
    const links = linksState(root, override);
    if (links.state === "current") {
      report.links = "current";
      if (links.missing.length) report.unlinked = links.missing;
    } else {
      report.links = links.state === "none" && boundaryKey(root, override) === null ? "unavailable" : links.state;
    }
    if (here) report.here = here;
    return report;
  }
  const map = contextDirFor(root, override);
  if (!existsSync(wiringPath(map))) return { root, kind: "none", parts: [], map };
  const report: PartsReport = { root, kind: "single", parts: [], map };
  const fp = readFingerprint(map);
  if (fp) {
    report.files = Object.keys(fp.files).length;
    if (fp.onlyDirs?.length) report.onlyDirs = [...fp.onlyDirs];
  }
  return report;
}

const count = (n: number): string => n.toLocaleString("en-US");

function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function when(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A path for a command line: quoted when it holds a space. */
const arg = (p: string): string => (/\s/.test(p) ? `"${p}"` : p);

/** The human-readable report: what `graft parts` prints. */
export function formatPartsReport(r: PartsReport): string {
  const out: string[] = [`${cmd("graft parts")} — ${r.root}`, ""];
  if (r.kind === "none") {
    out.push(`No map here yet: run \`${cmd("graft build")}\` first.`);
    return out.join("\n") + "\n";
  }
  if (r.kind === "single") {
    const files = r.files !== undefined ? ` (${count(r.files)} file${r.files === 1 ? "" : "s"})` : "";
    if (r.onlyDirs?.length) {
      out.push(`Not built in parts: one map${files}, limited to the folders \`--only-dir\` named:`);
      for (const d of r.onlyDirs) out.push(`  ${posix(d).replace(/\/?$/, "/")}`);
      out.push("", "Files outside them are not in the map.");
    } else {
      out.push(`Not built in parts: one map holds the whole repository${files}, so queries search all of it.`);
    }
    out.push(`\`${cmd("graft build")}\` builds a repository in parts only when it is too big for one map.`);
    return out.join("\n") + "\n";
  }

  const unit = r.kind === "parts" ? "part" : "repo";
  const n = r.parts.length;
  out.push(
    r.kind === "parts"
      ? `Built in parts, as it is too big for one map: ${n} part${n === 1 ? "" : "s"}, one map each.`
      : `A folder of ${n} separate repo${n === 1 ? "" : "s"}, one map each.`,
  );
  out.push("");
  const rows: [string, string, string, string][] = [[unit.toUpperCase(), "FILES", "MAP SIZE", "BUILT"]];
  for (const p of r.parts) {
    const name = `${p.part}/${p.part === r.here ? "  (you are here)" : ""}`;
    if (p.state === "gone") {
      rows.push([name, "–", "–", `folder gone: the next \`${cmd("graft build")}\` here drops it`]);
    } else if (p.state === "not-built") {
      rows.push([name, "–", "–", `not built: the next \`${cmd("graft build")}\` here tries it again`]);
    } else {
      rows.push([
        name,
        p.files !== undefined ? count(p.files) : "?",
        p.bytes !== undefined ? size(p.bytes) : "?",
        p.builtAt ? when(p.builtAt) : "?",
      ]);
    }
  }
  const w = [0, 1, 2].map((i) => Math.max(...rows.map((row) => row[i]!.length)));
  for (const [a, b, c, d] of rows) out.push(`  ${a.padEnd(w[0]!)}  ${b.padStart(w[1]!)}  ${c.padStart(w[2]!)}  ${d}`.trimEnd());

  if (r.kind === "parts") {
    out.push("");
    const reread = `the next \`${cmd("graft callers")}\`, \`${cmd("graft grep")}\` or \`${cmd("graft map")}\` at the repo root makes them again`;
    if (r.links === "current") {
      const left = r.unlinked?.length ? ` (not linked, as not built or built by an older graft: ${r.unlinked.map((p) => `${p}/`).join(", ")})` : "";
      out.push(`Links between the parts: up to date${left}.`);
    } else if (r.links === "unavailable") {
      out.push(`Links between the parts: none, as the parts were built by an older graft; the next \`${cmd("graft build")}\` here adds them.`);
    } else {
      out.push(`Links between the parts: ${r.links === "stale" ? "out of date" : "not made yet"}; ${reread}.`);
    }
  }

  const example = r.parts.find((p) => p.state === "built")?.part ?? r.parts[0]?.part;
  if (example) {
    out.push(
      "",
      `To work in one ${unit}, name it by its path from the repo root, as listed above:`,
      `  ${cmd("graft ask")} "<question>" --in ${arg(`${example}/`)}    (${cmd("graft grep")} and ${cmd("graft callers")} take --in too; over MCP, pass in: "${example}")`,
      `  in a prompt to your AI assistant: "In the ${example} ${unit}, find where <something> is handled."`,
      `Without --in, a query run at the repo root searches every ${unit}.`,
    );
  }
  if (r.here) {
    out.push(
      "",
      `You are inside the ${r.here}/ ${unit}: a query run here searches that ${unit} alone. Run it from ${r.root} to search every ${unit}.`,
    );
  }
  out.push("", `The folder each ${unit}'s map is kept in: \`${cmd("graft parts --json")}\`.`);
  return out.join("\n") + "\n";
}
