/**
 * MATLAB and Simulink packages: models (`.slx`), data dictionaries (`.sldd`) and live
 * scripts (`.mlx`) are ZIP archives (Open Packaging Conventions) of XML parts. Graft
 * reads them as one text:
 * - a model or dictionary as the parts it understands, unpacked and joined in a fixed
 *   order, each introduced by a marker line;
 * - a live script as plain MATLAB: its code as written, its text, headings and
 *   equations as `%` comments, so the MATLAB extractor reads it like any script.
 * Every reader of a source file (`readSourceFile`) gets that same text, so the build,
 * the freshness check, `graft grep` and `ask --source` agree on its content and on
 * the line numbers a span names.
 *
 * Nothing here leaves the machine: the archive is read from disk and inflated with
 * node's zlib. A `.sldd` saved in the text format (JSON, newer releases) and a `.mdl`
 * model are not ZIPs and are read as ordinary text.
 */
import { inflateRawSync } from "node:zlib";
import { parseXml, type XmlEl } from "./xml.js";

/** Package extensions read through {@link renderSimulinkPackage}. */
export const SIMULINK_PACKAGE = /\.(slx|sldd|mlx)$/i;

/** On-disk size limit for a Simulink package. Models are compressed binary archives,
 * so the walker's limit for hand-written text (1 MB) would drop most real ones. */
export const MAX_SIMULINK_PACKAGE_BYTES = 50_000_000;

/** Unpacked text graft keeps from one package; parts past it are left out. */
const MAX_RENDERED_CHARS = 40_000_000;

/** The line that starts each part in the rendered text: `<!-- graft-part: <name> -->`. */
export const PART_MARKER = /^<!-- graft-part: (.+) -->$/;
const marker = (name: string): string => `<!-- graft-part: ${name} -->`;

/** True for the local-file-header signature a ZIP archive starts with ("PK\x03\x04"). */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** The archive's central directory, or null when the bytes are not a readable ZIP.
 * ZIP64 and encrypted entries are listed but never read (see {@link readEntry}). */
function centralDirectory(buf: Buffer): ZipEntry[] | null {
  // End of central directory: 22 bytes plus a comment of up to 65535.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      name: buf.toString("utf8", p + 46, p + 46 + nameLen),
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** One entry's bytes, or null when it cannot be read safely: encrypted, ZIP64
 * (sizes of 0xFFFFFFFF), an unsupported method, or more than `limit` bytes inflated. */
function readEntry(buf: Buffer, e: ZipEntry, limit: number): Buffer | null {
  if (e.flags & 1 || e.size === 0xffffffff || e.compressedSize === 0xffffffff || e.size > limit) return null;
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) return null;
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  try {
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRawSync(data, { maxOutputLength: Math.max(1, limit) });
  } catch {
    /* corrupt or over the limit */
  }
  return null;
}

/** Rank of a part in the rendered text, or -1 to leave it out. A model keeps what
 * describes its structure: the block diagram (XML, or JSON in newer releases), its
 * systems (root first) and its Stateflow charts. A dictionary keeps its data parts.
 * Layout, thumbnails, metadata and package plumbing (`_rels/`, `[Content_Types].xml`)
 * are left out. */
export function partRank(name: string, kind: "slx" | "sldd"): number {
  const n = name.replace(/^\//, "").toLowerCase();
  if (kind === "sldd") return /^data\/[^/]+\.xml$/.test(n) ? 1 : -1;
  if (n === "simulink/blockdiagram.xml" || n === "simulink/blockdiagram.json" || n === "slcoreproperties.json") return 0;
  if (n === "simulink/systems/system_root.xml") return 1;
  if (/^simulink\/systems\/[^/]+\.xml$/.test(n)) return 2;
  if (/^simulink\/stateflow\/chart_[^/]+\.xml$/.test(n)) return 3;
  return -1;
}

/** Natural order, so `system_9` sorts before `system_10`. */
const natural = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

const normalize = (text: string): string => text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");

/**
 * The text graft reads for a package. A model or dictionary: its parts, in a fixed
 * order, each preceded by a marker line. A live script: MATLAB source (see
 * {@link renderLiveScript}). Null when the bytes are not a readable ZIP. A part that
 * cannot be read (encrypted, ZIP64, corrupt, over the size limit) is left out.
 */
export function renderSimulinkPackage(bytes: Buffer, path: string): string | null {
  const entries = centralDirectory(bytes);
  if (!entries) return null;
  if (/\.mlx$/i.test(path)) {
    const doc = entries.find((e) => e.name.toLowerCase() === "matlab/document.xml");
    const data = doc ? readEntry(bytes, doc, MAX_RENDERED_CHARS) : null;
    return data ? renderLiveScript(data.toString("utf8")) : null;
  }
  const kind = /\.sldd$/i.test(path) ? "sldd" : "slx";
  const parts = entries
    .map((e) => ({ e, rank: partRank(e.name, kind) }))
    .filter((p) => p.rank >= 0)
    .sort((a, b) => a.rank - b.rank || natural(a.e.name, b.e.name));
  const out: string[] = [];
  let total = 0;
  for (const { e } of parts) {
    const data = readEntry(bytes, e, MAX_RENDERED_CHARS - total);
    if (!data) continue;
    const text = normalize(data.toString("utf8"));
    total += text.length;
    if (total > MAX_RENDERED_CHARS) break;
    out.push(marker(e.name), text);
  }
  return `${out.join("\n")}\n`;
}

/** Paragraph styles of a live script's prose that read best as a section title. */
const LIVE_HEADING = /^(?:title|heading\d*)$/i;

/**
 * A live script's `matlab/document.xml` (Office Open XML) as MATLAB source: each code
 * paragraph as written, each heading or title as a `%%` section line and every other
 * paragraph (text, lists, equations) as a one-line `%` comment. Images, controls and
 * output carry no code and are left out. The result is what MATLAB itself runs, plus
 * comments, so line numbers in it are stable for the same document.
 */
export function renderLiveScript(documentXml: string): string {
  const out: string[] = [];
  const textOf = (el: XmlEl): string => {
    if (el.name === "w:t") return el.text;
    if (el.name === "w:br" || el.name === "w:cr") return "\n";
    if (el.name === "w:tab") return "\t";
    if (el.name === "w:pPr" || el.name === "w:rPr" || el.name === "w:customXmlPr") return "";
    return el.children.map(textOf).join("");
  };
  const paragraphs = (els: XmlEl[]): void => {
    for (const el of els) {
      if (el.name !== "w:p") {
        paragraphs(el.children);
        continue;
      }
      const style = el.children.find((c) => c.name === "w:pPr")?.children.find((c) => c.name === "w:pStyle")?.attrs["w:val"] ?? "";
      const text = normalize(textOf(el));
      if (style === "code") {
        out.push(text);
      } else if (text.trim()) {
        const line = text.replace(/\s+/g, " ").trim();
        out.push(LIVE_HEADING.test(style) ? `%% ${line}` : `% ${line}`);
      }
    }
  };
  paragraphs(parseXml(documentXml));
  return `${out.join("\n")}\n`;
}

/** One part of a rendered package: its name, its text, and the 0-based row of its
 * first line in the rendered text (the line after its marker). `encoded` parts (a
 * text package's BASE64 parts) are binary and carry no text graft reads. */
export interface PackagePart {
  name: string;
  text: string;
  row: number;
  encoded?: boolean;
}

/** The part markers graft splits on: its own (an unpacked `.slx`/`.sldd`), and the
 * two MathWorks text packages a `.mdl` can be (`__MWOPC_PART_BEGIN__ /simulink/…`,
 * since R2015a; `__MWSL_PART_BEGIN__ /simulink/…`, the newer Simulink text format). */
const ANY_PART = /^(?:<!-- graft-part: (.+) -->|__MW(?:OPC|SL)_PART_BEGIN__ \/?(\S+)( BASE64)?\s*)$/;
const PACKAGE_END = /^__MW(?:OPC|SL)_PACKAGE_END__/;

/** True when `text` is split into parts: an unpacked package or a `.mdl` text package. */
export function isPartedText(text: string): boolean {
  return PART_MARKER.test(text.split("\n", 1)[0] ?? "") || /^__MW(?:OPC|SL)_PART_BEGIN__ /m.test(text);
}

/** Split a rendered package (or a `.mdl` text package) back into its parts. */
export function packageParts(rendered: string): PackagePart[] {
  const lines = rendered.split("\n");
  const parts: PackagePart[] = [];
  let current: { name: string; row: number; lines: string[]; encoded: boolean } | null = null;
  const close = (): void => {
    if (current) parts.push({ name: current.name, text: current.lines.join("\n"), row: current.row, ...(current.encoded ? { encoded: true } : {}) });
    current = null;
  };
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    const m = ANY_PART.exec(line);
    if (m) {
      close();
      current = { name: m[1] ?? m[2]!, row: i + 1, lines: [], encoded: !!m[3] };
    } else if (PACKAGE_END.test(line)) {
      close();
    } else {
      (current as { lines: string[] } | null)?.lines.push(line);
    }
  });
  close();
  return parts;
}
