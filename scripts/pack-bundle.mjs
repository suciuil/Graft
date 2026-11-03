/**
 * Packs graft plus every optional native grammar into ONE installable tarball.
 *
 * Normally the 19 depth-tier grammars reach graft through
 * `optionalDependencies: {"tree-sitter-cpp": "file:../tree-sitter-cpp", …}` — sibling
 * working copies that exist only on the machine they were cloned onto. Anywhere else
 * npm skips all 19 (they are *optional*, so it does not even error) and graft quietly
 * loses C#, Groovy, PL/SQL, C, C++, CMake, Bash, Perl, Make, CSS, HTML, Razor, XML, JSON,
 * YAML, Markdown, SCSS and CSV, and falls back to the older registry Kotlin grammar. The output of
 * this script has them baked in:
 *
 *     npm i -g ./nanonets-graft-<version>-win32-x64.tgz --ignore-scripts
 *
 * What makes that possible is that a prebuilt grammar `.node` needs nothing around it
 * — `require()` it and hand the result to `parser.setLanguage()`. So the bundle ships
 * the bare binaries under `vendor/<grammarKey>/prebuilds/<platform>-<arch>/`, and
 * `loadOptionalGrammar` (src/graph/extract.ts) looks there once normal package
 * resolution comes up empty. No `file:` specs for npm to re-resolve on the target
 * machine, no compiler required there.
 *
 * The ordinary `dependencies` get the same treatment by a different mechanism: they are
 * installed into the staging tree here and shipped as `bundleDependencies`, so the
 * target resolves and downloads nothing at all. The result is one offline-installable
 * artifact whose contents are fixed at pack time.
 *
 * Keyed by graft's grammar key (`cpp`, `xml`, …) rather than package name, because the
 * package name is not a stable handle: the groovy grammar publishes itself as
 * `@bootswithdefer/tree-sitter-groovy` while graft asks for `tree-sitter-groovy`.
 *
 * Usage: node scripts/pack-bundle.mjs [--skip-build]
 *   --skip-build  reuse the current dist/ and prebuilds instead of rebuilding first;
 *                 refused when either is older than its sources
 *
 * On Windows it also writes graft-<version>.<build>-win-<arch>.zip, the offline installer kit
 * (<build> counts the packs of this graft version: 0, 1, 2, … and back to 0 for a new version;
 * see scripts/kit-build.mjs; the last kit is recorded in kit-build.json, which is committed
 * together with docs/changelog.html so every clone continues the same numbering):
 * the tarball, START-HERE-install-graft.cmd, install-graft-helper.ps1, docs/changelog.html (as
 * changelog.html, whose path the installer shows) and the latest LTS node-vX.Y.Z-win-<arch>.zip,
 * downloaded from nodejs.org into the repo root (SHA-256 checked, reused when already
 * there). Offline, it falls back to the newest such zip already in the repo root. The
 * standalone tarball is then deleted, together with kits and tarballs left by earlier
 * packs (any version): the new kit is the only artifact left.
 *
 * The fork changelog's "Not yet bundled" entries are dated with this build (today's date
 * and the package version) in the shipped copies, and in docs/changelog.html once
 * the build has succeeded.
 *
 * Either way vendor/ is re-staged from the sibling repos' prebuilds (build:vendor) and
 * verified byte-for-byte against them before packing, so the tarball cannot carry
 * grammars older than the ones graft itself is running.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { localDate, stampChangelog } from "./stamp-changelog.mjs";
import { kitFileName, kitVersion, latestKitInChangelog, nextKitBuild, parseKitName, parseKitRecord } from "./kit-build.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stagingDir = join(repoRoot, "build-bundle");
/** The graft version and build number of the last kit written (see scripts/kit-build.mjs); committed. */
const kitRecordPath = join(repoRoot, "kit-build.json");
const skipBuild = process.argv.includes("--skip-build");
const PLATFORM = `${process.platform}-${process.arch}`;

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/**
 * The previous kit ({ version, build } or null), from the committed kit-build.json the last
 * successful pack wrote. A record that exists but cannot be read stops the pack rather than
 * guess a number. Only when there is no record: the newest build group of docs/changelog.html
 * named by a kit version, then the newest numbered kit in the repo root.
 */
function previousKit() {
  if (existsSync(kitRecordPath)) {
    let rec = null;
    try {
      rec = parseKitRecord(readFileSync(kitRecordPath, "utf8"));
    } catch (err) {
      die(`could not read ${kitRecordPath} (${err.message}) — restore it from git (git checkout -- kit-build.json) so the kit build number continues from the last kit`);
    }
    if (!rec) die(`${kitRecordPath} has no valid "version" and "build" (0 or more) — restore it from git (git checkout -- kit-build.json)`);
    return rec;
  }
  const fromChangelog = latestKitInChangelog(readFileSync(join(repoRoot, "docs", "changelog.html"), "utf8"));
  if (fromChangelog) {
    console.warn(`! no ${kitRecordPath} — continuing from the newest kit build in docs/changelog.html (${kitVersion(fromChangelog.version, fromChangelog.build)})`);
    return fromChangelog;
  }
  const kits = readdirSync(repoRoot)
    .map((name) => ({ kit: parseKitName(name, process.arch), name }))
    .filter(({ kit }) => kit)
    .map(({ kit, name }) => ({ ...kit, mtime: statSync(join(repoRoot, name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime || a.build - b.build);
  const newest = kits.at(-1);
  if (newest) console.warn(`! no ${kitRecordPath} — continuing from the newest kit in the repo root (${kitVersion(newest.version, newest.build)})`);
  else console.warn(`! no ${kitRecordPath} and no earlier numbered kit — this kit is build 0`);
  return newest ? { version: newest.version, build: newest.build } : null;
}

/** Same shell-free npm invocation as build-grammars.mjs: the `.cmd` shim cannot be
 * spawned directly (EINVAL) and `shell: true` concatenates arguments (DEP0190).
 * Prefer the npm that launched us — a different npm version would reject the
 * npm_config_* env vars this one exported ("Unknown env config" warnings). */
function npm(args, cwd) {
  const fromNpm = process.env.npm_execpath;
  const roots = [join(dirname(process.execPath), "node_modules", "npm"), join(process.env.APPDATA ?? "", "npm", "node_modules", "npm")];
  const cli =
    fromNpm?.endsWith(".js") && existsSync(fromNpm) ? fromNpm : roots.map((r) => join(r, "bin", "npm-cli.js")).find((p) => existsSync(p));
  const [exe, argv] = cli ? [process.execPath, [cli, ...args]] : ["npm", args];
  return spawnSync(exe, argv, { cwd, env: npmEnv(), stdio: "inherit", shell: !cli && process.platform === "win32" });
}

/**
 * The environment for a nested npm. `npm run pack:bundle` exports every non-default
 * config as an `npm_config_*` variable, so an `allow-scripts` set in the user's or
 * global .npmrc reaches the child as `npm_config_allow_scripts`. npm 12 treats that env
 * layer like the `--allow-scripts` flag and rejects the project-scoped `npm install` in
 * the staging tree with EALLOWSCRIPTS ("--allow-scripts is not allowed in project-scoped
 * installs"). Dropping the variable lets the child read the same setting from .npmrc,
 * where it is allowed — and the staging install passes `--ignore-scripts` regardless.
 */
function npmEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^npm_config_allow_scripts$/i.test(key)) delete env[key];
  return env;
}

if (!skipBuild) {
  console.log("• building grammars and TypeScript …");
  for (const script of ["build:grammars", "build:ts"]) {
    const r = npm(["run", script], repoRoot);
    if (r.status !== 0) die(`npm run ${script} failed — fix that before packing a bundle`);
  }
} else {
  // --skip-build reuses what is built, but only if it is current: a bundle is copied to
  // other machines and nobody re-checks it there.
  console.log("• checking that the existing build is current (--skip-build) …");
  const r = npm(["run", "build:grammars", "--", "--check"], repoRoot);
  if (r.status !== 0) die("grammar bindings are older than their sources — run without --skip-build");
  // tsc leaves no content stamp to compare, so mtime it is; a false alarm (checkout,
  // copy) costs one TypeScript build.
  const newest = (dir, re) => {
    let at = 0;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (re.test(e.name)) at = Math.max(at, statSync(p).mtimeMs);
      }
    };
    if (existsSync(dir)) walk(dir);
    return at;
  };
  if (newest(join(repoRoot, "src"), /\.ts$/) > newest(join(repoRoot, "dist"), /\.js$/)) {
    die("src/ has changes newer than dist/ — run without --skip-build (or npm run build:ts first)");
  }
}

// Always, --skip-build included: staging only copies the prebuilds that exist, and
// skipping it is how a bundle used to ship the previous parsers next to fresh ones.
console.log("• staging grammar bindings into vendor/ …");
{
  const r = npm(["run", "build:vendor", "--", "--no-bundle-check"], repoRoot);
  if (r.status !== 0) die("npm run build:vendor failed");
}

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
if (!existsSync(join(repoRoot, "dist", "cli.js"))) die("dist/cli.js is missing — run npm run build:ts first");

// vendor/ must now hold exactly the sibling repos' current prebuilds. build:vendor never
// fails (it keeps an older copy when a running graft holds the file), so check here.
{
  const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
  const nodeIn = (dir) => {
    try {
      const f = readdirSync(dir).find((n) => n.endsWith(".node") && !n.includes(".superseded-"));
      return f ? join(dir, f) : null;
    } catch {
      return null;
    }
  };
  const extractMod = await import(pathToFileURL(join(repoRoot, "dist", "graph", "extract.js")).href);
  const drift = [];
  for (const [key, pkgName] of Object.entries(extractMod.optionalGrammarPackages())) {
    const spec = pkg.optionalDependencies?.[pkgName];
    if (typeof spec !== "string" || !spec.startsWith("file:")) continue;
    const source = nodeIn(join(resolve(repoRoot, spec.slice("file:".length)), "prebuilds", PLATFORM));
    if (!source) continue; // sibling repo absent: the committed vendor/ copy is the source of truth
    const vendored = nodeIn(join(repoRoot, "vendor", key, "prebuilds", PLATFORM));
    if (!vendored || sha(source) !== sha(vendored)) drift.push(`${key} (${pkgName})`);
  }
  if (drift.length > 0) {
    die(
      `vendor/ does not match the current grammar prebuilds for: ${drift.join(", ")} — ` +
        "a running graft (editor / MCP server) probably holds the old binding; close it and retry",
    );
  }
}

// The grammar-key → package-name map lives in extract.ts, the same table the runtime
// loader uses, so the bundle layout cannot drift from where the loader looks.
const extract = await import(pathToFileURL(join(repoRoot, "dist", "graph", "extract.js")).href);
const keyToPkg = extract.optionalGrammarPackages();

rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

for (const entry of ["dist", "scripts", "README.md", "LICENSE"]) {
  const from = join(repoRoot, entry);
  if (existsSync(from)) cpSync(from, join(stagingDir, entry), { recursive: true });
}
// docs/changelog.html rides along so `graft about fork` can open it after install,
// with its not-yet-bundled entries dated by this build.
const changelogPath = join(repoRoot, "docs", "changelog.html");
const bundleDate = localDate();
// On Windows the build is named by its kit version (a.b.c.d, d counting the packs of this
// graft version), so each kit gets its own changelog group; elsewhere by the package version.
const kitBuild = process.platform === "win32" ? nextKitBuild(pkg.version, previousKit()) : null;
// kitBuild starts at 0, so test for null, not truthiness.
const buildVersion = kitBuild !== null ? kitVersion(pkg.version, kitBuild) : pkg.version;
const changelog = stampChangelog(readFileSync(changelogPath, "utf8"), { date: bundleDate, version: buildVersion });
mkdirSync(join(stagingDir, "docs"), { recursive: true });
writeFileSync(join(stagingDir, "docs", "changelog.html"), changelog.html);

// Each grammar's compiled binding, already laid out by scripts/vendor-optional-grammars.mjs
// (run as build:vendor) in exactly the shape the loader's fallback expects. Copied
// rather than re-derived from the sibling repos so the bundle and the published package
// ship byte-identical grammars.
const included = [];
const missing = [];
for (const [key, pkgName] of Object.entries(keyToPkg)) {
  const srcDir = join(repoRoot, "vendor", key, "prebuilds", PLATFORM);
  let file;
  try {
    file = readdirSync(srcDir).find((f) => f.endsWith(".node"));
  } catch {
    file = undefined;
  }
  if (!file) {
    missing.push(`${key} (${pkgName}): no vendor/${key}/prebuilds/${PLATFORM}/*.node — run npm run build:vendor`);
    continue;
  }
  const destDir = join(stagingDir, "vendor", key, "prebuilds", PLATFORM);
  mkdirSync(destDir, { recursive: true });
  cpSync(join(srcDir, file), join(destDir, file));
  included.push({ key, bytes: statSync(join(srcDir, file)).size });
}

if (included.length === 0) die("no grammars could be bundled — is this the machine with the sibling grammar repos?");

// The Oracle driver for the opt-in savings report (src/reporting/), vendored by
// scripts/vendor-oracledb.mjs from registry.npmjs.org. Only this platform's
// thick-mode binding goes in, like the grammars: the tarball is per platform.
const oracleSrc = join(repoRoot, "vendor", "oracledb");
if (!existsSync(join(oracleSrc, "index.js"))) die("vendor/oracledb is missing — run npm run vendor:oracledb");
{
  const oracleDest = join(stagingDir, "vendor", "oracledb");
  cpSync(oracleSrc, oracleDest, {
    recursive: true,
    filter: (src) => !src.endsWith(".node") || src.endsWith(`-${PLATFORM}.node`),
  });
  if (!readdirSync(join(oracleDest, "build", "Release")).some((f) => f.endsWith(".node"))) {
    console.warn(`! vendor/oracledb has no thick-mode binding for ${PLATFORM}: the savings report can only use thin mode there`);
  }
}

// Oracle's managed .NET driver, vendored by scripts/vendor-odpnet.mjs from
// nuget.org: the savings report's sender on Windows machines with no Oracle
// Client (the database requires Native Network Encryption, which thin mode
// cannot do). Windows bundles only, and required there: a kit without it cannot
// report from most PCs. Its LICENSE.txt must travel with it, and both files must
// match the SHA-256 list the vendoring script wrote, the same list
// install-graft-helper.ps1 checks the installed copy against.
const odpnetFiles = [];
if (PLATFORM.startsWith("win32-")) {
  const odpSrc = join(repoRoot, "vendor", "odpnet");
  const manifestPath = join(odpSrc, "VENDORED.json");
  if (!existsSync(manifestPath)) die("vendor/odpnet is missing — run npm run vendor:odpnet");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expected = manifest.files ?? {};
  for (const name of ["Oracle.ManagedDataAccess.dll", "LICENSE.txt"]) {
    const file = join(odpSrc, name);
    if (!existsSync(file)) die(`vendor/odpnet/${name} is missing — run npm run vendor:odpnet`);
    if (!expected[name]) die(`vendor/odpnet/VENDORED.json lists no SHA-256 for ${name} — run npm run vendor:odpnet`);
    if (createHash("sha256").update(readFileSync(file)).digest("hex") !== expected[name]) {
      die(`vendor/odpnet/${name} does not match its SHA-256 in VENDORED.json — run npm run vendor:odpnet`);
    }
  }
  const odpDest = join(stagingDir, "vendor", "odpnet");
  mkdirSync(odpDest, { recursive: true });
  for (const name of ["Oracle.ManagedDataAccess.dll", "LICENSE.txt", "VENDORED.json"]) {
    cpSync(join(odpSrc, name), join(odpDest, name));
    odpnetFiles.push(`vendor/odpnet/${name}`);
  }
  console.log(`• bundling ${manifest.package} ${manifest.version} (vendor/odpnet) for the savings report`);
}

// The savings-report database config. The real one carries a password, so it is
// git-ignored and copied only when present here; the example always ships.
mkdirSync(join(stagingDir, "config"), { recursive: true });
for (const f of ["savings-report.json", "savings-report.example.json"]) {
  const from = join(repoRoot, "config", f);
  if (existsSync(from)) cpSync(from, join(stagingDir, "config", f));
}
if (!existsSync(join(repoRoot, "config", "savings-report.json"))) {
  console.warn("! config/savings-report.json is missing: the bundle's savings report has no database until a user adds ~/.graft/savings-report.json");
}

// A published bundle must not carry the `file:../…` specs: on the target machine those
// paths do not exist, and npm would report a resolution failure for each. The grammars
// are already inside, so the entries have no job left to do. devDependencies and the
// build lifecycle scripts go for the same reason — nothing on the target compiles.
//
// `allowScripts` is dropped for a different reason: npm 12 skips the package.json layer
// altogether when `npm.global` is set (its lib/utils/resolve-allow-scripts.js), so no
// manifest field can pre-approve install scripts for an `npm i -g` of this tarball —
// shipping one would only imply a promise npm never reads. The install line printed at
// the end passes `--ignore-scripts` instead, which is a statement of fact rather than a
// workaround: every binding in the bundled tree is a compiled `.node` put there below,
// so there is nothing left for an install script to do. The only thing skipped is
// graft's own postinstall, which prints the `graft init` hint.
const staged = { ...pkg };
delete staged.optionalDependencies;
delete staged.devDependencies;
delete staged.allowScripts;
staged.scripts = pkg.scripts?.postinstall ? { postinstall: pkg.scripts.postinstall } : {};
staged.files = ["dist", "scripts", "vendor", "config", "README.md", "LICENSE", "docs/changelog.html"];
writeFileSync(join(stagingDir, "package.json"), `${JSON.stringify(staged, null, 2)}\n`);

// The 19 optional grammars are in `vendor/` by now, but `dependencies` — tree-sitter
// itself and the nine registry-published grammars among them — would still be resolved
// against the registry on the target machine. That reopens on every install the exact
// uncertainty this bundle exists to close: a `^` range floats, the target's global tree
// gets re-resolved and rehoisted around graft, and a machine with no network installs
// nothing at all. So the tree is resolved HERE, once, and shipped.
//
// `bundleDependencies` is what carries it: npm packs `node_modules/<name>` for each
// listed dep plus everything those pull in, and on the target it unpacks that tree
// verbatim instead of resolving. Nothing is fetched, nothing is hoisted into the global
// root, and the `overrides` pin below is baked into the shipped layout rather than being
// re-litigated by the target's resolver.
console.log("• resolving runtime dependencies into the staging tree …");
const installed = npm(["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stagingDir);
if (installed.status !== 0) die("npm install failed in the staging directory — cannot bundle dependencies");
rmSync(join(stagingDir, "package-lock.json"), { force: true });

// `--ignore-scripts` above means node-gyp-build never ran in the staging tree, so a
// native dep is only usable on the target if a binding for this platform is sitting in
// the package already. Most ship one under `prebuilds/`; tree-sitter-kotlin ships none
// at all and is normally compiled at install time by the `allowScripts` allowlist, which
// is why it works in this repo's own node_modules and nowhere else. For those, the
// already-compiled binding from this machine is copied across — same platform, same Node
// ABI, and it is exactly what the target would have ended up with.
//
// It lands in `prebuilds/<platform>-<arch>/` rather than the `build/Release/` it came
// from, because npm-packlist applies each bundled dependency's OWN `files` allowlist:
// kotlin's lists `prebuilds/**` and not `build/**`, so a binding left in `build/` is
// silently dropped from the tarball and the package explodes on first require. Untagged
// filenames match any runtime/ABI in node-gyp-build's resolver, so the name carries over
// unchanged.
const unprebuilt = [];
function bindingDir(dir) {
  for (const rel of [["prebuilds", PLATFORM], ["build", "Release"]]) {
    const at = join(dir, ...rel);
    if (existsSync(at) && readdirSync(at).some((f) => f.endsWith(".node"))) return at;
  }
  return null;
}

function repairBindings(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (!existsSync(join(path, "binding.gyp"))) {
      repairBindings(path);
      continue;
    }
    const rel = path.slice(stagingDir.length + 1);
    const source = bindingDir(path) ?? bindingDir(join(repoRoot, rel));
    const dest = join(path, "prebuilds", PLATFORM);
    if (!source) {
      unprebuilt.push(rel.replaceAll("node_modules\\", "").replaceAll("node_modules/", ""));
    } else if (source !== dest) {
      mkdirSync(dest, { recursive: true });
      // Only the binding: a node-gyp `build/Release` is mostly linker intermediates
      // (.obj, .pdb, .iobj) that outweigh the .node several times over.
      for (const f of readdirSync(source)) if (f.endsWith(".node")) cpSync(join(source, f), join(dest, f));
      rmSync(join(path, "build"), { recursive: true, force: true });
      const manifestPath = join(path, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (Array.isArray(manifest.files) && !manifest.files.some((f) => f.startsWith("prebuilds"))) {
        manifest.files.push("prebuilds/**");
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
    }
    repairBindings(path);
  }
}
repairBindings(join(stagingDir, "node_modules"));

// Prebuilds for the other twelve platforms are dead weight in a tarball already named
// for one, and the generated parser sources are build inputs whose output is already
// here — swift alone carries two ABI variants of a 17 MB `parser_abi*.c`. Between them
// they are ~90% of the tree.
const DROP = /^(?:parser|scanner)\w*\.(?:c|cc|cpp)$|^(?:grammar|node-types)\.json$/;
function prune(dir, inNative = false) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (!entry.isDirectory()) {
      if (inNative && DROP.test(entry.name)) rmSync(path, { force: true });
      continue;
    }
    if (entry.name === "prebuilds") {
      for (const target of readdirSync(path)) if (target !== PLATFORM) rmSync(join(path, target), { recursive: true, force: true });
      continue;
    }
    prune(path, inNative || existsSync(join(dir, "binding.gyp")));
  }
}
prune(join(stagingDir, "node_modules"));

// tree-sitter-wasm carries 109 grammars; graft asks for the ones its two wasm-backed
// registries name. Read from the built tables rather than a list here, so adding a
// language row cannot silently ship a bundle that is missing its grammar.
const generic = await import(pathToFileURL(join(repoRoot, "dist", "graph", "generic.js")).href);
const container = await import(pathToFileURL(join(repoRoot, "dist", "graph", "container.js")).href);
const wasmNeeded = new Set([...generic.GENERIC_LANGS, ...container.CONTAINER_LANGS].map((l) => l.wasm));
const wasmOut = join(stagingDir, "node_modules", "tree-sitter-wasm", "out");
const wasmMissing = [...wasmNeeded].filter((w) => !existsSync(join(wasmOut, w)));
if (wasmMissing.length > 0) die(`tree-sitter-wasm has no grammar for: ${wasmMissing.join(", ")}`);
for (const entry of readdirSync(wasmOut)) if (!wasmNeeded.has(entry)) rmSync(join(wasmOut, entry), { recursive: true, force: true });

staged.bundleDependencies = Object.keys(staged.dependencies ?? {});
writeFileSync(join(stagingDir, "package.json"), `${JSON.stringify(staged, null, 2)}\n`);

const packed = npm(["pack", "--pack-destination", repoRoot], stagingDir);
if (packed.status !== 0) die("npm pack failed in the staging directory");

const defaultName = `${pkg.name.replace(/^@/, "").replace(/\//g, "-")}-${pkg.version}.tgz`;
const produced = join(repoRoot, defaultName);
if (!existsSync(produced)) die(`npm pack produced no ${defaultName}`);
// Renamed so it cannot be mistaken for a plain registry pack: this one is
// platform-specific, because the grammars inside it are.
const finalName = `${pkg.name.replace(/^@/, "").replace(/\//g, "-")}-${pkg.version}-${PLATFORM}.tgz`;
rmSync(join(repoRoot, finalName), { force: true });
renameSync(produced, join(repoRoot, finalName));

/** Paths (without the leading `package/`) of the regular files in a .tgz. */
function tarballFiles(tgz) {
  const tar = gunzipSync(readFileSync(tgz));
  const out = new Set();
  let longName = null;
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, len) => header.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1) || "0";
    const body = tar.subarray(off + 512, off + 512 + size);
    if (type === "L") longName = body.toString("utf8").replace(/\0.*$/s, "");
    else {
      const prefix = field(345, 155);
      const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
      longName = null;
      if (type === "0") out.add(name.replace(/^package\//, ""));
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

// npm pack applies `files` and ignore rules of its own; check the result rather than
// trusting the staging tree, so a kit can never ship without the savings report's driver.
if (odpnetFiles.length > 0) {
  const inTarball = tarballFiles(join(repoRoot, finalName));
  const lost = odpnetFiles.filter((f) => !inTarball.has(f));
  if (lost.length > 0) die(`${finalName} is missing ${lost.join(", ")} — check package.json "files" in the staging tree`);
}

const mb = (statSync(join(repoRoot, finalName)).size / 1024 / 1024).toFixed(1);
console.log(
  `\n✓ ${finalName} (${mb} MB) — ${included.length} grammars vendored, ${staged.bundleDependencies.length} dependencies bundled` +
    (odpnetFiles.length > 0 ? ", ODP.NET managed driver included" : ""),
);
if (missing.length > 0) {
  console.log(`  ${missing.length} grammars not bundled:`);
  for (const m of missing) console.log(`    ${m}`);
}
if (unprebuilt.length > 0) {
  console.log(`  ${unprebuilt.length} native deps ship no prebuilds/${PLATFORM} — they will fail to load on the target:`);
  for (const u of unprebuilt) console.log(`    ${u}`);
}

// Same pattern and minimum major (20) as $OfflineNodeRegex / $MinNodeMajor in install-graft-helper.ps1.
const nodeZipRe = new RegExp(`^node-v(\\d+)\\.(\\d+)\\.(\\d+)-win-${process.arch}(.*)\\.zip$`, "i");
const cmpVersion = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const localNodeZips = () =>
  readdirSync(repoRoot)
    .map((name) => ({ name, v: nodeZipRe.exec(name)?.slice(1, 4).map(Number) }))
    .filter(({ v }) => v)
    .sort((a, b) => cmpVersion(a.v, b.v));

/** Removes node-v*-win-<arch>*.zip files in the repo root older than `keep`. */
function removeOlderNodeZips(keep) {
  const keepVersion = nodeZipRe.exec(keep).slice(1, 4).map(Number);
  for (const { name, v } of localNodeZips()) {
    if (cmpVersion(v, keepVersion) >= 0) continue;
    rmSync(join(repoRoot, name), { force: true });
    console.log(`• removed older ${name}`);
  }
}

/**
 * Removes earlier pack outputs from the repo root once `keep` (the kit just written) is
 * there: every other graft-X.Y.Z[.D]-win-<arch>*.zip kit, and every
 * <pkg>-X.Y.Z-win32-<arch>*.tgz/.zip tarball, whatever its version — the current one is
 * inside `keep`. The trailing (.*) also catches "- Copy" / " (1)" duplicates, as the
 * installer's own patterns do.
 */
function removeStaleArtifacts(keep) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ver = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
  // Kits carry a build number after a.b.c (graft-0.28.0.3-win-x64.zip); older ones did not
  const kitVer = String.raw`\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?`;
  const kitRe = new RegExp(`^graft-${kitVer}-win-${escape(process.arch)}(.*)\\.zip$`, "i");
  const pkgPrefix = escape(pkg.name.replace(/^@/, "").replace(/\//g, "-"));
  const tarballRe = new RegExp(`^${pkgPrefix}-${ver}-${escape(PLATFORM)}(.*)\\.(?:tgz|zip)$`, "i");
  for (const name of readdirSync(repoRoot)) {
    if (name === keep || !(kitRe.test(name) || tarballRe.test(name))) continue;
    try {
      rmSync(join(repoRoot, name), { force: true });
      console.log(`• removed previous ${name}`);
    } catch (err) {
      console.warn(`! could not remove previous ${name} (${err.message})`);
    }
  }
}

/** Downloads the newest LTS node-vX.Y.Z-win-<arch>.zip into the repo root, verified against SHASUMS256.txt. */
async function downloadLtsNodeZip(arch) {
  const dist = "https://nodejs.org/dist";
  const index = await fetch(`${dist}/index.json`);
  if (!index.ok) throw new Error(`${dist}/index.json: HTTP ${index.status}`);
  // index.json lists releases newest first.
  const release = (await index.json()).find((r) => r.lts && r.files?.includes(`win-${arch}-zip`));
  if (!release) throw new Error(`no LTS release ships win-${arch}-zip`);
  const name = `node-${release.version}-win-${arch}.zip`;
  const sums = await fetch(`${dist}/${release.version}/SHASUMS256.txt`);
  if (!sums.ok) throw new Error(`SHASUMS256.txt for ${release.version}: HTTP ${sums.status}`);
  const expected = (await sums.text())
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === name)?.[0];
  if (!expected) throw new Error(`${name} is not listed in SHASUMS256.txt`);
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  const dest = join(repoRoot, name);
  if (existsSync(dest) && sha(readFileSync(dest)) === expected) {
    console.log(`• Node.js ${release.version} LTS (${release.lts}) already downloaded: ${name}`);
    return name;
  }
  console.log(`• downloading Node.js ${release.version} LTS (${release.lts}): ${name} …`);
  const zip = await fetch(`${dist}/${release.version}/${name}`);
  if (!zip.ok) throw new Error(`${name}: HTTP ${zip.status}`);
  const buf = Buffer.from(await zip.arrayBuffer());
  if (sha(buf) !== expected) throw new Error(`${name}: SHA-256 mismatch`);
  writeFileSync(`${dest}.part`, buf);
  renameSync(`${dest}.part`, dest);
  removeOlderNodeZips(name);
  return name;
}

const kitName = kitBuild !== null ? kitFileName(pkg.version, kitBuild, process.arch) : null;
if (kitName) {
  let nodeZipSource;
  let nodeZipName;
  try {
    nodeZipSource = nodeZipName = await downloadLtsNodeZip(process.arch);
  } catch (err) {
    console.warn(`! could not download the latest Node.js LTS zip (${err.message}) — using the newest one in the repo root`);
    const nodeZip = localNodeZips()
      .filter(({ v }) => v[0] >= 20)
      .at(-1);
    if (!nodeZip) {
      die(`${finalName} was built, but ${kitName} was not: no node-vX.Y.Z-win-${process.arch}.zip (v20+) in ${repoRoot} — download one from https://nodejs.org/dist/`);
    }
    nodeZipSource = nodeZip.name;
    nodeZipName = `node-v${nodeZip.v.join(".")}-win-${process.arch}.zip`;
  }
  const kitDir = mkdtempSync(join(tmpdir(), "graft-kit-"));
  try {
    cpSync(join(repoRoot, nodeZipSource), join(kitDir, nodeZipName));
    for (const f of [finalName, "install-graft-helper.ps1", "START-HERE-install-graft.cmd"]) cpSync(join(repoRoot, f), join(kitDir, f));
    // The installer shows the path of this fork's changelog of its changes, looked up next to itself
    writeFileSync(join(kitDir, "changelog.html"), changelog.html);
    const zipped = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; " +
          "Get-ChildItem -LiteralPath $env:GRAFT_KIT_DIR | Compress-Archive -DestinationPath $env:GRAFT_KIT_ZIP -Force",
      ],
      { env: { ...process.env, GRAFT_KIT_DIR: kitDir, GRAFT_KIT_ZIP: join(repoRoot, kitName) }, stdio: "inherit" },
    );
    if (zipped.status !== 0) die(`Compress-Archive failed — ${kitName} was not written`);
  } finally {
    rmSync(kitDir, { recursive: true, force: true });
  }
  // The kit now carries the tarball, so the standalone copy goes, and with it any
  // tarballs and kits left by earlier packs (another version, a "- Copy" duplicate):
  // the new kit is the only artifact left in the repo root.
  rmSync(join(repoRoot, finalName), { force: true });
  removeStaleArtifacts(kitName);
  // The next pack, on any clone, numbers its kit from this one
  const record = {
    $comment: "Last offline kit written by npm run pack:bundle; the next kit's build number continues from it. Commit this file. See scripts/kit-build.mjs.",
    version: pkg.version,
    build: kitBuild,
    kit: kitName,
    date: bundleDate,
  };
  writeFileSync(kitRecordPath, `${JSON.stringify(record, null, 2)}\n`);
  const kitMb = (statSync(join(repoRoot, kitName)).size / 1024 / 1024).toFixed(1);
  console.log(`\n✓ ${kitName} (${kitMb} MB, build ${kitBuild} of graft ${pkg.version}) — ${nodeZipName}, ${finalName}, install-graft-helper.ps1, START-HERE-install-graft.cmd, changelog.html`);
}

if (changelog.count > 0) {
  writeFileSync(changelogPath, changelog.html);
  console.log(`\n✓ docs/changelog.html: ${changelog.count} not-yet-bundled entr${changelog.count === 1 ? "y" : "ies"} dated ${bundleDate} (build ${buildVersion})`);
}

if (kitName) console.log(`\n  Commit kit-build.json${changelog.count > 0 ? " and docs/changelog.html" : ""}, so the next kit continues from build ${kitBuild}.`);
if (kitName) console.log(`\n  Install on another ${PLATFORM} machine: unzip ${kitName} and double-click START-HERE-install-graft.cmd, or from the unzipped folder:`);
else console.log(`\n  Install on another ${PLATFORM} machine with:`);
console.log(`    npm i -g ./${finalName} --ignore-scripts\n`);
console.log("  (--ignore-scripts: every binding in here is prebuilt, so nothing compiles on the\n   target. Without it npm 12 warns about unapproved install scripts, then installs anyway.)\n");
