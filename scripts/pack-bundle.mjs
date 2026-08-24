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
 * resolution comes up empty. No `bundleDependencies`, no `file:` specs for npm to
 * re-resolve on the target machine, no compiler required there.
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
 * spawned directly (EINVAL) and `shell: true` concatenates arguments (DEP0190). */
function npm(args, cwd) {
  const roots = [join(dirname(process.execPath), "node_modules", "npm"), join(process.env.APPDATA ?? "", "npm", "node_modules", "npm")];
  const cli = roots.map((r) => join(r, "bin", "npm-cli.js")).find((p) => existsSync(p));
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

// Each grammar's compiled binding, copied out of the sibling repo that build-grammars
// just refreshed. vendor/*.tgz holds the same binaries as standalone npm packages, but
// the bundle takes the bare files: it needs no tar, and there is nothing in a grammar
// package the loader would read besides the .node itself.
const included = [];
const missing = [];
for (const [key, pkgName] of Object.entries(keyToPkg)) {
  const spec = pkg.optionalDependencies?.[pkgName];
  if (typeof spec !== "string" || !spec.startsWith("file:")) {
    missing.push(`${key} (${pkgName}): not declared as a local optionalDependency`);
    continue;
  }
  const srcDir = join(resolve(repoRoot, spec.slice("file:".length)), "prebuilds", PLATFORM);
  let file;
  try {
    file = readdirSync(srcDir).find((f) => f.endsWith(".node") && !f.includes(".superseded-"));
  } catch {
    file = undefined;
  }
  if (!file) {
    missing.push(`${key} (${pkgName}): no prebuilds/${PLATFORM}/*.node`);
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
// workaround: every binding in the dependency tree ships a prebuilt `.node`, so
// `node-gyp-build` exits without compiling either way. The only thing skipped is graft's
// own postinstall, which prints the `graft init` hint.
const staged = { ...pkg };
delete staged.optionalDependencies;
delete staged.devDependencies;
delete staged.allowScripts;
staged.scripts = pkg.scripts?.postinstall ? { postinstall: pkg.scripts.postinstall } : {};
staged.files = ["dist", "scripts", "vendor", "README.md", "LICENSE"];
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
console.log(`\n✓ ${finalName} (${mb} MB) — ${included.length} grammars bundled`);
if (missing.length > 0) {
  console.log(`  ${missing.length} not bundled:`);
  for (const m of missing) console.log(`    ${m}`);
}
console.log(`\n  Install on another ${PLATFORM} machine with:\n    npm i -g ./${finalName} --ignore-scripts\n`);
console.log("  (--ignore-scripts: every binding in here is prebuilt, so nothing compiles on the\n   target. Without it npm 12 warns about unapproved install scripts, then installs anyway.)\n");
