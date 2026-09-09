/**
 * Packs graft plus every optional native grammar into ONE installable tarball.
 *
 * Normally the 14 depth-tier grammars reach graft through
 * `optionalDependencies: {"tree-sitter-cpp": "file:../tree-sitter-cpp", …}` — sibling
 * working copies that exist only on the machine they were cloned onto. Anywhere else
 * npm skips all 14 (they are *optional*, so it does not even error) and graft quietly
 * loses C#, Groovy, PL/SQL, C, C++, CSS, HTML, Razor, XML, JSON, YAML, Markdown, SCSS
 * and CSV. The output of this script has them baked in:
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
 *   --skip-build  reuse the current dist/ and prebuilds instead of rebuilding first
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stagingDir = join(repoRoot, "build-bundle");
const skipBuild = process.argv.includes("--skip-build");
const PLATFORM = `${process.platform}-${process.arch}`;

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
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
  return spawnSync(exe, argv, { cwd, stdio: "inherit", shell: !cli && process.platform === "win32" });
}

if (!skipBuild) {
  console.log("• building grammars and TypeScript …");
  for (const script of ["build:grammars", "build:ts"]) {
    const r = npm(["run", script], repoRoot);
    if (r.status !== 0) die(`npm run ${script} failed — fix that before packing a bundle`);
  }
}

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
if (!existsSync(join(repoRoot, "dist", "cli.js"))) die("dist/cli.js is missing — run npm run build:ts first");

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

// Each grammar's compiled binding, already laid out by scripts/vendor-grammars.mjs
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
staged.files = ["dist", "scripts", "vendor", "README.md", "LICENSE"];
writeFileSync(join(stagingDir, "package.json"), `${JSON.stringify(staged, null, 2)}\n`);

// The 14 optional grammars are in `vendor/` by now, but `dependencies` — tree-sitter
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

const mb = (statSync(join(repoRoot, finalName)).size / 1024 / 1024).toFixed(1);
console.log(`\n✓ ${finalName} (${mb} MB) — ${included.length} grammars vendored, ${staged.bundleDependencies.length} dependencies bundled`);
if (missing.length > 0) {
  console.log(`  ${missing.length} grammars not bundled:`);
  for (const m of missing) console.log(`    ${m}`);
}
if (unprebuilt.length > 0) {
  console.log(`  ${unprebuilt.length} native deps ship no prebuilds/${PLATFORM} — they will fail to load on the target:`);
  for (const u of unprebuilt) console.log(`    ${u}`);
}
console.log(`\n  Install on another ${PLATFORM} machine with:\n    npm i -g ./${finalName} --ignore-scripts\n`);
console.log("  (--ignore-scripts: every binding in here is prebuilt, so nothing compiles on the\n   target. Without it npm 12 warns about unapproved install scripts, then installs anyway.)\n");
