/**
 * Vendors Oracle's ODP.NET Managed Driver (`Oracle.ManagedDataAccess.dll`) into
 * `vendor/odpnet/`, so the remote savings report (src/reporting/) can reach the
 * database from a Windows machine that has no Oracle Client installed.
 *
 * Why: the target database requires Oracle Native Network Encryption. node-
 * oracledb supports it only in thick mode (an installed Oracle Client); the
 * managed driver implements it itself (AES + SHA checksums), runs on the .NET
 * Framework that ships with Windows, and is one 4.7 MB file instead of the tens
 * of MB of Instant Client. Windows only: the owner's decision, recorded with
 * the download source in docs/no-cloud-policy.md.
 *
 * The 19.x line on purpose: 23.x needs six extra NuGet assemblies to load in
 * Windows PowerShell 5.1, 19.x loads alone (its listed dependencies are only
 * touched by JSON / wallet features the report does not use).
 *
 * Downloaded from nuget.org, the URL is fixed and the package's sha512 is
 * pinned (it equals the `packageHash` nuget.org publishes for this version),
 * so a re-run either reproduces the committed copy byte for byte or fails.
 * Kept: the .NET Framework DLL and Oracle's LICENSE.txt, which its terms
 * require to travel with every redistributed copy.
 *
 * Run by hand, never by `npm run build`: it is the only step that touches the
 * network. Usage: node scripts/vendor-odpnet.mjs
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const VERSION = "19.33.0";
const URL = `https://www.nuget.org/api/v2/package/Oracle.ManagedDataAccess/${VERSION}`;
const INTEGRITY = "sha512-n7tpOvDnvVuu+Zo0kf6uYK1r8slP8Y/Mv1JXsjx7k4FaW6rmV/tSWS9nfX9AB+XP9djlXajbCOvUVw7sP9Amlw==";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(repoRoot, "vendor", "odpnet");

/** Entry in the package → file name under vendor/odpnet/. */
const KEEP = new Map([
  ["lib/net462/Oracle.ManagedDataAccess.dll", "Oracle.ManagedDataAccess.dll"],
  ["LICENSE.txt", "LICENSE.txt"],
]);

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** Minimal zip reader over the central directory: stored and deflated entries. */
function* unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) die("not a zip file (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) die("corrupt zip central directory");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    off += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(local) !== 0x04034b50) die(`corrupt zip local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    if (method === 0) yield { name, body: raw };
    else if (method === 8) yield { name, body: inflateRawSync(raw) };
    else die(`unsupported zip compression ${method} for ${name}`);
  }
}

const res = await fetch(URL, { redirect: "follow" });
if (!res.ok) die(`${URL}: HTTP ${res.status}`);
const nupkg = Buffer.from(await res.arrayBuffer());
const got = `sha512-${createHash("sha512").update(nupkg).digest("base64")}`;
if (got !== INTEGRITY) die(`integrity mismatch for ${URL}: expected ${INTEGRITY}, got ${got}`);

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
let bytes = 0;
const written = new Set();
// SHA-256 of each kept file: scripts/pack-bundle.mjs refuses to pack a changed
// copy and install-graft-helper.ps1 checks the installed one against the same list.
const files = {};
for (const { name, body } of unzip(nupkg)) {
  const out = KEEP.get(name);
  if (!out) continue;
  writeFileSync(join(dest, out), body);
  files[out] = createHash("sha256").update(body).digest("hex");
  written.add(name);
  bytes += body.length;
}
for (const name of KEEP.keys()) if (!written.has(name)) die(`${name} missing from the package`);
writeFileSync(
  join(dest, "VENDORED.json"),
  `${JSON.stringify({ package: "Oracle.ManagedDataAccess", version: VERSION, source: URL, integrity: INTEGRITY, files }, null, 2)}\n`,
);
console.log(`✓ vendor/odpnet: Oracle.ManagedDataAccess ${VERSION} from nuget.org, ${written.size} files (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
