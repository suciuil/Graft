import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isZip, renderSimulinkPackage, SIMULINK_PACKAGE } from "./simulink-package.js";
import { isPlainTextPath } from "./plain-text.js";

/** Read source text, decoding Windows tooling's common UTF-16LE output. UTF-16BE
 * is rare and unsupported by Node's built-in decoders, so callers silently skip it.
 * A MATLAB/Simulink package (`.slx`, `.sldd`, `.mlx` saved as a ZIP) reads as its
 * unpacked parts (see `simulink-package.ts`); one that cannot be unpacked is skipped
 * too, and so is a binary `.mdl` (other tools' model files share the extension). */
export function readSourceFile(path: string): string | null {
  return decodeSource(path, readFileSync(path));
}

/** {@link readSourceFile} over bytes already read. */
export function decodeSource(path: string, bytes: Buffer): string | null {
  if (SIMULINK_PACKAGE.test(path) && isZip(bytes)) return renderSimulinkPackage(bytes, path);
  if (/\.mdl$/i.test(path) && bytes.subarray(0, 8192).includes(0)) return null;
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  // A plain-text file holding NUL bytes (with no UTF-16 mark, handled above) is
  // binary data saved under a text name: chunking it would index noise, so it is skipped.
  if (isPlainTextPath(path) && bytes.subarray(0, 8192).includes(0)) return null;
  return bytes.toString("utf8");
}

/** Computed once per process; `undefined` = not yet, `null` = no identity. */
let renderStamp: string | null | undefined;

/** Identity of the code that turns a package's bytes into text: these modules'
 * contents, hashed. Null when they cannot be read, and then nothing is reused by
 * its raw bytes (see {@link packageHash}). */
function packageRenderStamp(): string | null {
  if (renderStamp !== undefined) return renderStamp;
  try {
    const self = fileURLToPath(import.meta.url);
    const dir = dirname(self);
    const ext = extname(self);
    const h = createHash("sha256");
    for (const f of ["source", "simulink-package", "xml"]) h.update(readFileSync(join(dir, `${f}${ext}`)));
    renderStamp = h.digest("hex").slice(0, 16);
  } catch {
    renderStamp = null;
  }
  return renderStamp;
}

/**
 * For a MATLAB/Simulink package (a ZIP): a hash of its raw bytes and of the code
 * that renders it, so a build can tell an unchanged package without unpacking and
 * rendering it (up to tens of MB of text) on every build. Null for any other file,
 * or when the render code has no identity.
 */
export function packageHash(path: string, bytes: Buffer): string | null {
  if (!SIMULINK_PACKAGE.test(path) || !isZip(bytes)) return null;
  const stamp = packageRenderStamp();
  if (stamp === null) return null;
  return createHash("sha256").update(stamp).update(bytes).digest("hex");
}
