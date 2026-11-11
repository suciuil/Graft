/**
 * Stop a build early when its graph could never be written, and say which parts
 * of the repo to build instead.
 *
 * `wiring.json` is written (`write.ts`) and read back (every query) as ONE string,
 * and V8 caps a string at ~536.8M characters. A repo past that ran the whole parse
 * (half an hour on ~77k C files) and then died with "Invalid string length". The
 * guard here estimates the map's size file by file while the parse runs and stops
 * as soon as it is over the limit, or plainly on its way there, with a list of the
 * repo's folders sized against the limit so `--only-dir` can build one part.
 *
 * The estimate per file is the compact JSON of its nodes, less their `body_text`
 * (never written to wiring.json), plus the compact JSON of its raw edges. On a
 * 2,661-file C/XML component that came to 0.96× the real wiring.json (370 MB).
 */
import type { RawEdge } from "./extract.js";
import type { NodeV1 } from "./types.js";

/** V8's longest string on 64-bit (`String::kMaxLength`, 2^29 - 24 characters). */
export const MAX_STRING_CHARS = 0x1fffffe8;

/** The most a map may hold: a margin under the string limit for the estimate's error. */
export const GRAPH_CHAR_BUDGET = Math.floor(MAX_STRING_CHARS * 0.9);

/** Share of the source bytes parsed before the total is extrapolated from them. */
export const EXTRAPOLATE_AFTER = 0.1;

/** How far over the budget an extrapolated total must be to stop on it: the density
 * of the parsed part may not hold for the rest, so only a clear overshoot counts. */
export const EXTRAPOLATE_MARGIN = 1.5;

/** Exit code of a `graft build` stopped by this guard (init tells it from a crash). */
export const GRAPH_TOO_LARGE_EXIT = 3;

/** First line of the guard's report: init passes the whole block on from here. */
export const TOO_LARGE_HEADLINE = "✗ this repository is too big for one graft map";

/** Most folders the report lists; the rest are counted. */
const MAX_PARTS = 40;

/** Estimated characters one file adds to wiring.json. */
export function estimateFileChars(nodes: readonly NodeV1[], rawEdges: readonly RawEdge[]): number {
  if (nodes.length === 0 && rawEdges.length === 0) return 0;
  let body = 0;
  for (const n of nodes) body += n.body_text?.length ?? 0;
  return JSON.stringify(nodes).length - body + JSON.stringify(rawEdges).length;
}

/** One folder offered as an `--only-dir` scope. */
export interface ScopePart {
  /** Repo-relative posix path. */
  path: string;
  /** Nesting under the listed folder: 0 for its own folders, 1 for theirs, ... */
  depth: number;
  files: number;
  bytes: number;
  /** Estimated wiring.json characters for a build of this folder alone. */
  chars: number;
  fits: boolean;
  /** Share of its source bytes already parsed (0 to 1): the rest of `chars` is a guess. */
  measured: number;
}

/** A part at least this much parsed has a measured size; below it the size is a guess. */
const MEASURED = 0.9;

/** Source bytes of one extension parsed before its own ratio is trusted over the average. */
const EXT_MIN_BYTES = 1e6;

const extOf = (rel: string): string => {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

export interface TooLargeReport {
  /** Estimated characters of the whole map (extrapolated when `projected`). */
  estimatedChars: number;
  projected: boolean;
  budget: number;
  filesSeen: number;
  totalFiles: number;
  bytesSeen: number;
  totalBytes: number;
  /** The folder whose parts are listed ("" for the repo root). */
  parent: string;
  /** Every part, in list order (the report shows the first {@link MAX_PARTS}). */
  parts: ScopePart[];
  /** Files directly in `parent`, which no listed part covers. */
  looseFiles: number;
  /** Folders beside the ones stepped down through to `parent` (`Tools` beside
   * `Src`): not listed, but built by "all" too. */
  others: ScopePart[];
  /** Files directly in the folders stepped down through, which no part covers. */
  outsideLoose: number;
}

export class GraphTooLargeError extends Error {
  readonly code = "GRAPH_TOO_LARGE";
  constructor(readonly report: TooLargeReport) {
    super(`${TOO_LARGE_HEADLINE}: its map would be about ${mb(report.estimatedChars)}, more than the ${mb(report.budget)} one map can hold`);
    this.name = "GraphTooLargeError";
  }
}

interface FileSize {
  rel: string;
  size: number;
}

/**
 * The running estimate for one build. {@link add} once per file, in parse order;
 * it throws {@link GraphTooLargeError} as soon as the map is over the budget, or
 * when, after {@link EXTRAPOLATE_AFTER} of the source, the projection for the whole
 * of it is over the budget by {@link EXTRAPOLATE_MARGIN}.
 */
export class SizeGuard {
  private chars = 0;
  private bytesSeen = 0;
  private filesSeen = 0;
  private readonly perFile: Float64Array;
  private readonly totalBytes: number;

  constructor(
    private readonly files: readonly FileSize[],
    readonly budget: number = GRAPH_CHAR_BUDGET,
  ) {
    this.perFile = new Float64Array(files.length).fill(-1);
    this.totalBytes = files.reduce((s, f) => s + f.size, 0);
  }

  /** Count file `i` (its nodes and raw edges; none when it failed or was skipped). */
  add(i: number, nodes: readonly NodeV1[] = [], rawEdges: readonly RawEdge[] = []): void {
    this.addChars(i, estimateFileChars(nodes, rawEdges));
  }

  /** {@link add} with the file's {@link estimateFileChars} already known (a replayed
   * parse keeps it in its cache entry, so its nodes are not serialized again). */
  addChars(i: number, c: number): void {
    this.perFile[i] = c;
    this.chars += c;
    this.bytesSeen += this.files[i]!.size;
    this.filesSeen++;
    if (this.chars > this.budget) throw this.tooLarge(false);
    if (this.totalBytes > 0 && this.bytesSeen >= this.totalBytes * EXTRAPOLATE_AFTER && this.bytesSeen > 0) {
      const projected = (this.chars * this.totalBytes) / this.bytesSeen;
      if (projected > this.budget * EXTRAPOLATE_MARGIN) throw this.tooLarge(true);
    }
  }

  /**
   * The error for this build as it stands: `projected` extrapolates the total.
   * `atLeast` is a size the map is known to reach (it failed to serialize), which
   * scales the estimate, and every folder's share of it, up to that size.
   */
  tooLarge(projected: boolean, atLeast = 0): GraphTooLargeError {
    const ratio = this.bytesSeen > 0 ? this.chars / this.bytesSeen : 1;
    // Files not parsed yet are sized by what their extension came to so far (a .c is
    // not an .arxml), or by the average for an extension too little seen.
    const byExt = new Map<string, { chars: number; bytes: number }>();
    this.files.forEach((f, i) => {
      if (this.perFile[i]! < 0) return;
      const e = extOf(f.rel);
      const s = byExt.get(e) ?? { chars: 0, bytes: 0 };
      s.chars += this.perFile[i]!;
      s.bytes += f.size;
      byExt.set(e, s);
    });
    const guess = (f: FileSize): number => {
      const s = byExt.get(extOf(f.rel));
      return f.size * (s && s.bytes >= EXT_MIN_BYTES ? s.chars / s.bytes : ratio);
    };
    let rest = 0;
    if (projected) this.files.forEach((f, i) => this.perFile[i]! < 0 && (rest += guess(f)));
    const estimate = projected ? Math.round(this.chars + rest) : this.chars;
    const scale = atLeast > estimate && estimate > 0 ? atLeast / estimate : 1;
    const estimatedChars = Math.max(estimate, atLeast);
    const files = this.files.map((f, i) => {
      const seen = this.perFile[i]! >= 0;
      return { rel: f.rel, size: f.size, chars: (seen ? this.perFile[i]! : guess(f)) * scale, measured: seen };
    });
    const s = suggestScopes(files, this.budget);
    return new GraphTooLargeError({
      estimatedChars,
      projected,
      budget: this.budget,
      filesSeen: this.filesSeen,
      totalFiles: this.files.length,
      bytesSeen: this.bytesSeen,
      totalBytes: this.totalBytes,
      ...s,
    });
  }
}

interface DirStat {
  files: number;
  bytes: number;
  chars: number;
  /** Bytes of its files already parsed. */
  seen: number;
  /** Direct sub-folders, by name. */
  dirs: Set<string>;
  /** Files directly in this folder. */
  loose: number;
}

/**
 * Folders to build one at a time. Starts at the repo root and steps down through
 * folders that hold nearly all of it (`Src` → `Src/EBS` in a repo whose code is all
 * under `Src/EBS`), then lists that folder's folders. One too big for a map is
 * followed by its own folders, two levels at most.
 */
export function suggestScopes(
  files: readonly { rel: string; size: number; chars: number; measured?: boolean }[],
  budget: number = GRAPH_CHAR_BUDGET,
): Pick<TooLargeReport, "parent" | "parts" | "looseFiles" | "others" | "outsideLoose"> {
  const dirs = new Map<string, DirStat>();
  const stat = (d: string): DirStat => {
    let s = dirs.get(d);
    if (!s) dirs.set(d, (s = { files: 0, bytes: 0, chars: 0, seen: 0, dirs: new Set(), loose: 0 }));
    return s;
  };
  for (const f of files) {
    const segs = f.rel.split("/");
    segs.pop();
    let d = "";
    const seen = f.measured === false ? 0 : f.size;
    const root = stat("");
    root.files++;
    root.bytes += f.size;
    root.chars += f.chars;
    root.seen += seen;
    if (segs.length === 0) root.loose++;
    for (let k = 0; k < segs.length; k++) {
      const child = d === "" ? segs[k]! : `${d}/${segs[k]}`;
      stat(d).dirs.add(child);
      const s = stat(child);
      s.files++;
      s.bytes += f.size;
      s.chars += f.chars;
      s.seen += seen;
      if (k === segs.length - 1) s.loose++;
      d = child;
    }
  }
  const root = dirs.get("");
  if (!root) return { parent: "", parts: [], looseFiles: 0, others: [], outsideLoose: 0 };

  const part = (k: string, depth: number): ScopePart => {
    const s = dirs.get(k)!;
    const measured = s.bytes > 0 ? s.seen / s.bytes : 1;
    return { path: k, depth, files: s.files, bytes: s.bytes, chars: Math.round(s.chars), fits: s.chars <= budget, measured };
  };
  const byName = (a: string, b: string) => a.localeCompare(b);

  // Step down while one folder holds nearly all of the current one; what is
  // beside the way down is kept for "all".
  let parent = "";
  const others: ScopePart[] = [];
  let outsideLoose = 0;
  for (;;) {
    const cur = dirs.get(parent)!;
    const big = [...cur.dirs].find((c) => dirs.get(c)!.bytes >= cur.bytes * 0.9);
    if (!big || cur.dirs.size === 0) break;
    for (const c of [...cur.dirs].sort(byName)) if (c !== big) others.push(part(c, 0));
    outsideLoose += cur.loose;
    parent = big;
  }

  const parts: ScopePart[] = [];
  const visit = (d: string, depth: number): void => {
    for (const k of [...dirs.get(d)!.dirs].sort(byName)) {
      const p = part(k, depth);
      parts.push(p);
      if (!p.fits && depth < 2 && dirs.get(k)!.dirs.size > 0) visit(k, depth + 1);
    }
  };
  visit(parent, 0);
  return { parent, parts, looseFiles: dirs.get(parent)!.loose, others, outsideLoose };
}

/** The listed parts a too-big part's own parts stand in for. */
const partsOf = (r: Pick<TooLargeReport, "parts">, p: ScopePart): ScopePart[] =>
  r.parts.filter((q) => q.depth === p.depth + 1 && q.path.startsWith(`${p.path}/`));

/**
 * What "all" builds, each into its own map: every listed part that fits, the
 * parts of those that do not (a too-big part without listed parts as it is: its
 * own build splits it further), and the folders beside the way down to the
 * listed ones. `uncovered` counts the files in none of them: those directly in
 * the folders above a part.
 */
export function allPartsPlan(r: Pick<TooLargeReport, "parts" | "others" | "looseFiles" | "outsideLoose">): {
  parts: string[];
  files: number;
  uncovered: number;
} {
  const plan: ScopePart[] = [...r.others];
  let uncovered = r.looseFiles + r.outsideLoose;
  for (const p of r.parts) {
    const kids = partsOf(r, p);
    if (p.fits || kids.length === 0) {
      // A part listed under one that is built whole is in that build already.
      if (!plan.some((q) => p.path.startsWith(`${q.path}/`))) plan.push(p);
    } else {
      uncovered += p.files - kids.reduce((s, q) => s + q.files, 0);
    }
  }
  plan.sort((a, b) => a.path.localeCompare(b.path));
  return { parts: plan.map((p) => p.path), files: plan.reduce((s, p) => s + p.files, 0), uncovered };
}

/** Characters of (ASCII) JSON as megabytes, for people. */
export function mb(chars: number): string {
  return `${Math.round(chars / 1e6).toLocaleString("en-US")} MB`;
}

const n = (x: number) => x.toLocaleString("en-US");

/**
 * The report as terminal lines, plus the folder each numbered line stands for
 * (`choices[k - 1]` for line `k`), so a picker can offer them, and the folders
 * line 0, "all", builds one map each (empty when it is not offered). `buildCmd`
 * is the command to suggest (`graft build`, `graft build --deep`, ...).
 */
export function formatTooLarge(r: TooLargeReport, buildCmd: string): { lines: string[]; choices: string[]; all: string[] } {
  const lines: string[] = [];
  const exclude = `${buildCmd.split(" ")[0]} config exclude-dirs add <path>`;
  const plan = allPartsPlan(r);
  const all = plan.parts.length >= 2 ? plan.parts : [];
  lines.push(`${TOO_LARGE_HEADLINE}: its map would be about ${mb(r.estimatedChars)}, and one map can hold at most ${mb(r.budget)} (a Node.js limit).`);
  const pct = r.totalBytes > 0 ? Math.round((r.bytesSeen / r.totalBytes) * 100) : 100;
  lines.push(
    r.projected
      ? `  Estimated from the first ${n(r.filesSeen)} of ${n(r.totalFiles)} files (${pct}% of the source), so the build stopped early.`
      : `  The build stopped after ${n(r.filesSeen)} of ${n(r.totalFiles)} files, where the map went over the limit.`,
  );
  lines.push(`  Build one part at a time with --only-dir. Each such build replaces this repository's previous map.`);
  const choices: string[] = [];
  if (r.parts.length === 0) {
    lines.push(`  Leave folders out of every build: ${exclude}`);
    return { lines, choices, all };
  }
  lines.push(`  Parts of ${r.parent === "" ? "the repository" : r.parent} (estimated map size; a map holds up to ${mb(r.budget)}):`);
  const shown = r.parts.slice(0, MAX_PARTS);
  const width = Math.min(60, Math.max(...shown.map((p) => p.path.length + 2 * p.depth)));
  const numW = String(shown.length).length;
  if (all.length > 0) {
    const others = r.others.filter((o) => all.includes(o.path));
    const beside = others.length > 0
      ? `, and ${others.length} folder(s) outside ${r.parent} (${others.slice(0, 3).map((o) => o.path).join(", ")}${others.length > 3 ? ", …" : ""})`
      : "";
    lines.push(`  ${"0".padStart(numW + 2)}  ${"all".padEnd(width)}  ${all.length} maps, one per part, built one after another and searched together from here: the parts that fit and the parts of those too big${beside}`);
  }
  for (const p of shown) {
    choices.push(p.path);
    const name = `${"  ".repeat(p.depth)}${p.path}`.padEnd(width);
    const files = `${n(p.files)} files`.padStart(12);
    const src = `${mb(p.bytes)} source`.padStart(16);
    const map = `~${mb(p.chars)} map`.padStart(14);
    const likely = p.measured < MEASURED ? "likely " : "";
    const verdict = p.fits ? `${likely}fits` : `${likely}too big${p.depth < 2 && r.parts.some((q) => q.depth === p.depth + 1 && q.path.startsWith(`${p.path}/`)) ? ", its parts:" : ""}`;
    lines.push(`  ${String(choices.length).padStart(numW + 2)}  ${name}  ${files}  ${src}  ${map}  ${verdict}`);
  }
  if (r.parts.length > shown.length) lines.push(`  … and ${n(r.parts.length - shown.length)} more folder(s) not listed.`);
  if (r.looseFiles > 0) lines.push(`  ${n(r.looseFiles)} file(s) directly in ${r.parent === "" ? "the repository root" : r.parent} are in none of these parts.`);
  if (r.parts.some((p) => p.measured < MEASURED)) {
    lines.push(`  "likely": a guess from the files parsed so far (generated code can make a far bigger map). A part that turns out too big stops early with a list of its own folders.`);
  }
  const firstFit = r.parts.find((p) => p.fits);
  const fitting = r.parts.filter((p) => p.fits && p.depth === 0);
  if (firstFit) lines.push(`  For example: ${buildCmd} --only-dir ${firstFit.path}`);
  const a = fitting[0];
  const b = a && fitting.find((p) => p !== a && a.chars + p.chars <= r.budget);
  if (a && b) {
    lines.push(`  Parts that fit together can share one map: repeat it (${buildCmd} --only-dir ${a.path} --only-dir ${b.path}).`);
  }
  if (all.length > 0) {
    const missed = plan.uncovered > 0 ? ` (${n(plan.uncovered)} file(s) directly in the folders above them are in no map)` : "";
    lines.push(`  Or all of them, one map each${missed}: ${buildCmd} --all-parts`);
  }
  lines.push(`  Or leave folders out of every build: ${exclude}`);
  return { lines, choices, all };
}
