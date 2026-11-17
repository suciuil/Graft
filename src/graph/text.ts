/**
 * Plain-text files (`.txt`): a hand-written line chunker, no grammar.
 *
 * Indexed only when the repository opts in (`graft build --index-text`,
 * `graft config index-text on`; see `BuildConfig.indexText` in util/state.ts):
 * graph/source-files.ts leaves every `.txt` file out of the source set
 * otherwise, so this module is reached only for a repo that asked for it.
 *
 * The point is a large text file — a log, a requirements spec exported to text,
 * a data dump, a protocol trace — that an agent would otherwise read whole. Each
 * file is cut into chunks of a few thousand characters, every chunk a node with
 * its own line span, so `graft ask` ranks the chunk whose words match and
 * `--source` slices just those lines from disk.
 *
 * Where a chunk ends:
 * - at a heading, once the chunk has reached a quarter of the target size: a
 *   line underlined (or over- and underlined) with `===`/`---`/`~~~`…, a
 *   Markdown-style `# Title`, or — after a blank line — a short numbered
 *   (`2.1 Scope`, `IV. Results`) or ALL-CAPS line. A section that is shorter
 *   than that is merged with the next rather than becoming a node of its own;
 * - otherwise, once the chunk reaches the target size, after its last blank line
 *   (a paragraph boundary), or right there when it has none.
 *
 * The target grows with the file so no file yields more than
 * {@link MAX_TEXT_CHUNKS} chunks, and a final merge enforces that cap whatever
 * the headings did: the graph stays bounded for a 50 MB file (the size limit
 * `.txt` gets in ingest/fs.ts), at the cost of chunks bigger than the searchable
 * body ({@link searchBody}'s cap) in files beyond roughly 8 MB.
 *
 * Every node, the file's included, is marked `summary_state: "none"`, like XML:
 * `graft build --deep` never sends a text chunk to the LLM and never reports one
 * as pending, so opting in costs no AI tokens. No edges other than `contains`:
 * prose has no call graph.
 */
import { contentHash } from "../util/id.js";
import { fileNodeOf, MAX_BODY_CHARS, mintId, searchBody, type ExtractResult, type RawEdge } from "./extract.js";
import type { Kind, NodeV1 } from "./types.js";

/** The searchable body of the chunk `lines[first..last]`: what {@link searchBody}
 * gives for the whole chunk, built from only the leading lines it keeps. Collapsing
 * the whole chunk and slicing it would keep the whole collapsed chunk alive behind
 * each node's 5,000 characters (a V8 slice holds its parent), and the chunks of a
 * large file run far past that. */
function chunkSearchBody(lines: readonly string[], first: number, last: number): string {
  const parts: string[] = [];
  let size = 0;
  for (let i = first; i <= last && size <= MAX_BODY_CHARS; i++) {
    const part = lines[i].replace(/\s+/g, " ").trim();
    if (!part) continue;
    parts.push(part);
    size += part.length + 1;
  }
  return searchBody(parts.join(" "));
}

/** Target characters per chunk: about one searchable body ({@link searchBody}
 * keeps 5,000), so a chunk's every word ranks, and a span an agent reads in one go. */
export const TEXT_CHUNK_CHARS = 4000;

/** Target lines per chunk, for files of short lines (number columns, word
 * lists), where the character target alone would let a chunk run to thousands
 * of lines. */
export const TEXT_CHUNK_LINES = 150;

/** The most chunks one file yields. Bounds the graph (each chunk carries up to
 * 5,000 characters of searchable body) and the card, whatever the file's size. */
export const MAX_TEXT_CHUNKS = 2000;

/** How many source files a text file of `bytes` weighs in the build's heap
 * estimate (util/heap.ts `BIG_REPO_FILES`): about one per chunk it will yield,
 * since every chunk is a node carrying its own searchable body. Counted as one
 * file, a few hundred large logs or specs would keep a build that needs a big
 * heap in the default one. */
export function textFileLoad(bytes: number): number {
  return Math.min(MAX_TEXT_CHUNKS, Math.max(1, Math.ceil(bytes / TEXT_CHUNK_CHARS)));
}

/** Longest name a chunk gets; a longer heading or first line is cut with `…`. */
const MAX_NAME = 80;

/** A line that is only a run of one rule character (`=====`, `-----`, `~~~`). */
const RULE = /^\s*([=\-~*#_^+])\1{2,}\s*$/;
/** A Markdown-style heading, common in hand-written text files too. */
const HASH_HEADING = /^\s{0,3}#{1,6}\s+(\S.*?)\s*#*\s*$/;
/** A numbered section title: `3 Overview`, `2.1.4 Limits`, `A. Terms`, `IV. Results`. */
const NUMBERED = /^\s{0,3}(?:\d+(?:\.\d+)*\.?|[A-Z]\.|[IVXLCDM]+\.)\s+\p{L}/u;

/** One chunk: 0-based inclusive line range and, when it opens with one, its heading. */
export interface TextChunk {
  first: number;
  last: number;
  heading: string | null;
}

const blank = (line: string | undefined): boolean => line === undefined || line.trim() === "";

/**
 * The heading that starts at line `i`, or null. An underlined heading starts at
 * its text line, an over- and underlined one at its overline; either way the
 * returned text is the title. Numbered and ALL-CAPS titles must follow a blank
 * line (or open the file) and not end like a sentence, so list items and log
 * lines are mostly not taken for headings — and a false one only moves a cut.
 */
export function headingAt(lines: readonly string[], i: number): string | null {
  const line = lines[i];
  if (blank(line)) return null;
  const t = line.trim();
  // Overline, title, underline: the heading starts at the overline.
  if (RULE.test(line) && !blank(lines[i + 1]) && !RULE.test(lines[i + 1]) && RULE.test(lines[i + 2] ?? "")) {
    const title = lines[i + 1].trim();
    return title.length <= 100 ? title : null;
  }
  if (RULE.test(line) || t.length > 100) return null;
  // Title, underline. The underline must run at least half the title's width, so
  // a `---` separator under the last line of a paragraph is not taken for one.
  if (RULE.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").trim().length * 2 >= t.length) {
    // An underlined title right under an overline is caught at the overline.
    return i > 0 && RULE.test(lines[i - 1]) ? null : t;
  }
  const hash = HASH_HEADING.exec(line);
  if (hash) return hash[1];
  if (!(i === 0 || blank(lines[i - 1])) || t.length > 80 || /[.,;]$/.test(t)) return null;
  if (NUMBERED.test(line)) return t;
  const letters = t.replace(/[^\p{L}]/gu, "");
  const nonSpace = t.replace(/\s/g, "");
  if (letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase() && letters.length * 2 >= nonSpace.length) {
    return t;
  }
  return null;
}

/**
 * Cut `lines` into chunks (see the module comment for where they end). Pure;
 * exported for the tests. Every line belongs to exactly one chunk, blank ones
 * included, so the chunks tile the file.
 */
export function chunkText(lines: readonly string[]): TextChunk[] {
  const n = lines.length;
  if (n === 0) return [];
  // prefix[i] = characters before line i (each line counted with its newline).
  const prefix = new Array<number>(n + 1);
  prefix[0] = 0;
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + lines[i].length + 1;
  const targetChars = Math.max(TEXT_CHUNK_CHARS, Math.ceil(prefix[n] / MAX_TEXT_CHUNKS));
  const targetLines = Math.max(TEXT_CHUNK_LINES, Math.ceil(n / MAX_TEXT_CHUNKS));
  const minChars = Math.floor(targetChars / 4);
  const minLines = Math.floor(targetLines / 4);
  const bigEnough = (from: number, to: number): boolean => prefix[to] - prefix[from] >= minChars || to - from >= minLines;

  const headings = new Map<number, string>();
  for (let i = 0; i < n; i++) {
    const h = headingAt(lines, i);
    if (h !== null) headings.set(i, h);
  }

  const chunks: TextChunk[] = [];
  let start = 0;
  let lastBlank = -1;
  const cut = (end: number): void => {
    chunks.push({ first: start, last: end - 1, heading: headings.get(start) ?? null });
    start = end;
  };
  for (let i = 0; i < n; i++) {
    if (i > start && headings.has(i) && bigEnough(start, i)) cut(i);
    if (blank(lines[i])) lastBlank = i;
    if (prefix[i + 1] - prefix[start] >= targetChars || i + 1 - start >= targetLines) {
      // Past the target: end after the chunk's last paragraph break, unless that
      // would leave it too small to be worth a node; then end right here.
      if (lastBlank >= start && lastBlank < i && bigEnough(start, lastBlank + 1)) cut(lastBlank + 1);
      else cut(i + 1);
    }
  }
  if (start < n) cut(n);
  return capChunks(chunks);
}

/** Merge runs of adjacent chunks until there are at most {@link MAX_TEXT_CHUNKS};
 * a merged chunk keeps the heading of its first part. */
function capChunks(chunks: TextChunk[]): TextChunk[] {
  if (chunks.length <= MAX_TEXT_CHUNKS) return chunks;
  const k = Math.ceil(chunks.length / MAX_TEXT_CHUNKS);
  const out: TextChunk[] = [];
  for (let i = 0; i < chunks.length; i += k) {
    const group = chunks.slice(i, i + k);
    out.push({ first: group[0].first, last: group[group.length - 1].last, heading: group[0].heading });
  }
  return out;
}

const clip = (s: string): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_NAME ? `${t.slice(0, MAX_NAME - 1)}…` : t;
};

/**
 * A `.txt` file's nodes: the file, then one per chunk — kind `heading` (named by
 * its title) for a chunk that opens with a heading, kind `chunk` (named by its
 * first line) for one cut at a paragraph break. A chunk's span leaves out the
 * blank lines at its edges; a chunk of nothing but blank lines gets no node.
 */
export function extractText(rel: string, source: string): ExtractResult {
  // Split once (a text file can be 50 MB): the same array serves the file node's
  // span and the chunker, its CRs stripped in place.
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) if (lines[i].endsWith("\r")) lines[i] = lines[i].slice(0, -1);
  const file = fileNodeOf(rel, source, lines.length);
  file.summary_state = "none";
  const nodes: NodeV1[] = [file];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  for (const c of chunkText(lines)) {
    let first = c.first;
    let last = c.last;
    while (first <= last && blank(lines[first])) first++;
    while (last >= first && blank(lines[last])) last--;
    if (first > last) continue;
    const text = lines.slice(first, last + 1).join("\n");
    const kind: Kind = c.heading !== null ? "heading" : "chunk";
    const name = clip(c.heading ?? lines[first]) || `L${first + 1}`;
    const id = mintId(`${rel}#${name}`, minted);
    nodes.push({
      id,
      name,
      kind,
      path: rel,
      span: `L${first + 1}-L${last + 1}`,
      signature: name,
      exported: true,
      origin: "ast",
      body_hash: contentHash(text),
      body_text: chunkSearchBody(lines, first, last),
      summary_state: "none",
      summary: null,
      crux: null,
    });
    rawEdges.push({ source: rel, relation: "contains", targetId: id, file: rel });
  }
  return { nodes, rawEdges };
}
