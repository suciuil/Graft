/**
 * Vendors the Oracle driver (`oracledb`) into `vendor/oracledb/`, so the remote
 * savings report (src/reporting/) works from an offline install: nothing is
 * resolved or downloaded on the target machine.
 *
 * Downloaded from the OFFICIAL npm registry on purpose (owner's decision,
 * docs/no-cloud-policy.md), never from the fork's registry or the user's
 * .npmrc: the URL below is fixed and the tarball's sha512 is pinned, so a
 * re-run either reproduces the committed copy byte for byte or fails.
 *
 * Kept: the JavaScript driver (`index.js`, `lib/`), its licences, and the
 * prebuilt thick-mode bindings (`build/Release/*.node`). Thick mode is not
 * optional here: the target database requires Oracle Native Network
 * Encryption, which only thick mode (an installed Oracle Client) supports.
 * Dropped: install scripts (`package/`), examples, cloud config-provider
 * plugins and docs — none is loaded by `require("oracledb")`.
 *
 * Run by hand, never by `npm run build`: it is the only step that touches the
 * network. Usage: node scripts/vendor-oracledb.mjs
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const VERSION = "26.0.0";
const URL = `https://registry.npmjs.org/oracledb/-/oracledb-${VERSION}.tgz`;
const INTEGRITY = "sha512-ywUqFidj/mPjRjfpOQdzcXT98lhiJzavPCbyPF9JYivcgrpHx7ENj4ZGQDclrpGXeozUBLc5BNXV7yj5qTMxDw==";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(repoRoot, "vendor", "oracledb");

const KEEP = [
  /^index\.js$/,
  /^package\.json$/,
  /^(LICENSE|NOTICE|THIRD_PARTY_LICENSES)\.txt$/,
  /^lib\/.+\.js$/,
  /^build\/Release\/oracledb-[\w.-]+\.node$/,
];

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** Minimal ustar reader: regular files only, with pax / GNU long-name support. */
function* untar(buf) {
  let longName = null;
  for (let off = 0; off + 512 <= buf.length; ) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (a, b) => header.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(345, 500);
    let name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      if (m) longName = m[1];
      continue;
    }
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (longName) {
      name = longName;
      longName = null;
    }
    if (type === "0" || type === "\0") yield { name, body };
  }
}

const res = await fetch(URL);
if (!res.ok) die(`${URL}: HTTP ${res.status}`);
const tgz = Buffer.from(await res.arrayBuffer());
const got = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;
if (got !== INTEGRITY) die(`integrity mismatch for ${URL}: expected ${INTEGRITY}, got ${got}`);

rmSync(dest, { recursive: true, force: true });
let files = 0;
let bytes = 0;
for (const { name, body } of untar(gunzipSync(tgz))) {
  const rel = name.replace(/^package\//, "");
  if (!KEEP.some((re) => re.test(rel))) continue;
  const out = normalize(join(dest, rel));
  if (!out.startsWith(dest + sep)) die(`refusing to write outside vendor/oracledb: ${name}`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body);
  files++;
  bytes += body.length;
}
writeFileSync(
  join(dest, "VENDORED.json"),
  `${JSON.stringify({ package: "oracledb", version: VERSION, source: URL, integrity: INTEGRITY }, null, 2)}\n`,
);
console.log(`✓ vendor/oracledb: oracledb ${VERSION} from registry.npmjs.org, ${files} files (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
