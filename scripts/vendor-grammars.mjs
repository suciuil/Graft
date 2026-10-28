/**
 * Materialises the optional grammars (18 languages, plus the newer Kotlin grammar) into `vendor/<grammarKey>/prebuilds/<platform>-<arch>/`,
 * the layout `loadOptionalGrammar` (src/graph/extract.ts) falls back to when normal
 * package resolution comes up empty.
 *
 * This is what lets a plain `npm i -g @nanonets/graft` carry those grammars. They are
 * declared as `optionalDependencies: {"tree-sitter-cpp": "file:../tree-sitter-cpp", …}`
 * — sibling working copies that exist only on the machine they were cloned onto — so
 * anywhere else npm skips them all without even erroring, and graft quietly loses C#,
 * Groovy, PL/SQL, C, C++, CMake, Bash, Perl, Make, CSS, HTML, Razor, XML, JSON, YAML,
 * Markdown, SCSS and CSV.
 * A bare prebuilt `.node` needs nothing around it (`require()` it and hand the result
 * to `parser.setLanguage()`), so the binding travels in the package itself.
 *
 * The output is platform-specific, and `files` ships it unconditionally, so a package
 * published from Windows carries win32-x64 bindings that no macOS or Linux install can
 * load. That is deliberate and costs those installs nothing: the loader caches the null
 * and the affected extensions go unclaimed, which is exactly where they are today.
 *
 * Keyed by grammar key (`cpp`, `xml`, …) rather than package name, because the package
 * name is not a stable handle: the groovy grammar publishes itself as
 * `@bootswithdefer/tree-sitter-groovy` while graft asks for `tree-sitter-groovy`. The
 * map is read from the built extractor, so the layout cannot drift from the loader.
 *
 * Runs after build:ts (it needs dist/) and is never fatal — a clone without the sibling
 * repos is a normal state.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(repoRoot, "vendor");
const PLATFORM = `${process.platform}-${process.arch}`;

/**
 * Clear `vendor/<key>`, renaming aside any `.node` a running process (typically graft's
 * own MCP server) still has loaded: Windows lets a loaded DLL be renamed but not deleted.
 * Same holding pen as build-grammars.mjs; leftovers are swept once nothing holds them.
 */
function clearVendored(key) {
  const dir = join(vendorDir, key);
  const quarantine = join(repoRoot, "node_modules", ".cache", "graft-superseded", `vendor-${key}`);
  try {
    for (const f of readdirSync(quarantine)) rmSync(join(quarantine, f), { force: true });
  } catch {
    /* nothing parked, or still loaded */
  }
  const nodes = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".node")) nodes.push(p);
    }
  };
  walk(dir);
  for (const file of nodes) {
    try {
      rmSync(file, { force: true });
    } catch {
      mkdirSync(quarantine, { recursive: true });
      renameSync(file, join(quarantine, `${basename(file)}.${process.pid}.${Date.now()}`));
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

function sameBytes(a, b) {
  try {
    if (statSync(a).size !== statSync(b).size) return false;
    const hash = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
    return hash(a) === hash(b);
  } catch {
    return false;
  }
}

/** Newest mtime of the files under `dir` whose name passes `keep`; 0 when none. */
function newestMtime(dir, keep) {
  let newest = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (keep(e.name)) newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

/**
 * The offline bundle (scripts/pack-bundle.mjs) is a snapshot of dist/ and vendor/. Once
 * either is newer than it, installing that tarball silently ships the old parsers or
 * code, so say so here — this script runs last in `npm run build`.
 */
function warnIfBundleStale() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const bundle = `${pkg.name.replace(/^@/, "").replace(/\//g, "-")}-${pkg.version}-${PLATFORM}.tgz`;
  const bundlePath = join(repoRoot, bundle);
  if (!existsSync(bundlePath)) return;
  const packedAt = statSync(bundlePath).mtimeMs;
  const vendorAt = newestMtime(vendorDir, (n) => n.endsWith(".node"));
  const distAt = newestMtime(join(repoRoot, "dist"), (n) => n.endsWith(".js"));
  const newer = [vendorAt > packedAt && "vendored grammars", distAt > packedAt && "dist/"].filter(Boolean);
  if (newer.length > 0) {
    console.warn(`⚠ ${bundle} is stale (${newer.join(" and ")} changed since it was packed) — rebuild it: npm run pack:bundle`);
  }
}

const extractPath = join(repoRoot, "dist", "graph", "extract.js");
if (!existsSync(extractPath)) {
  console.log("  vendor: skipped (dist/ not built yet)");
  process.exit(0);
}

try {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const { optionalGrammarPackages } = await import(pathToFileURL(extractPath).href);

  const included = [];
  const kept = [];
  /** Sibling repo not checked out, committed vendor/<key> binding used as is: the
   * normal state of a fresh clone, so one summary line rather than a line each. */
  const committed = [];
  const missing = [];
  const optedOut = [];
  for (const [key, pkgName] of Object.entries(optionalGrammarPackages())) {
    const spec = pkg.optionalDependencies?.[pkgName];
    const destDir = join(vendorDir, key, "prebuilds", PLATFORM);
    // A copy staged by an earlier build is left alone when the sibling repo is gone:
    // it is still a working grammar, and deleting it would lose the language for nothing.
    const hasStaged = () => {
      try {
        return readdirSync(destDir).some((f) => f.endsWith(".node"));
      } catch {
        return false;
      }
    };
    // Absent from optionalDependencies is a deliberate opt-out (a grammar whose sibling
    // repo this machine does not build), not a broken setup.
    if (spec === undefined) {
      optedOut.push(key);
      continue;
    }
    if (typeof spec !== "string" || !spec.startsWith("file:")) {
      missing.push(`${key} (${pkgName}): not declared as a local optionalDependency`);
      continue;
    }
    const repoDir = resolve(repoRoot, spec.slice("file:".length));
    const srcDir = join(repoDir, "prebuilds", PLATFORM);
    let file;
    try {
      file = readdirSync(srcDir).find((f) => f.endsWith(".node") && !f.includes(".superseded-"));
    } catch {
      file = undefined;
    }
    if (!file) {
      const present = existsSync(repoDir);
      const why = present ? `no prebuilds/${PLATFORM}/*.node in ${repoDir}` : `${repoDir} not present`;
      if (hasStaged() && !present) committed.push(key);
      else if (hasStaged()) kept.push(`${key} (${pkgName}): ${why} — keeping the copy staged earlier`);
      else missing.push(`${key} (${pkgName}): ${why}`);
      continue;
    }
    // Byte-identical copy already staged: leave it, mtime included, so an unchanged
    // grammar neither churns the quarantine nor makes the bundle look stale below.
    try {
      const staged = readdirSync(destDir).filter((f) => f.endsWith(".node"));
      if (staged.length === 1 && staged[0] === file && sameBytes(join(srcDir, file), join(destDir, file))) {
        included.push(key);
        continue;
      }
    } catch {
      /* nothing staged yet */
    }
    // Replaced wholesale: a rename upstream would otherwise leave two .node files here,
    // and the loader takes the first one it finds.
    try {
      clearVendored(key);
      mkdirSync(destDir, { recursive: true });
      cpSync(join(srcDir, file), join(destDir, file));
      included.push(key);
    } catch (err) {
      if (hasStaged()) kept.push(`${key} (${pkgName}): could not replace (${err.code ?? err.message}) — keeping the copy staged earlier`);
      else missing.push(`${key} (${pkgName}): could not stage (${err.code ?? err.message})`);
    }
  }

  const mb = included.length === 0 ? 0 : included.reduce((n, key) => {
    const dir = join(vendorDir, key, "prebuilds", PLATFORM);
    return n + readdirSync(dir).reduce((s, f) => s + statSync(join(dir, f)).size, 0);
  }, 0) / 1024 / 1024;

  console.log(`  vendor: ${included.length} grammars staged for ${PLATFORM} (${mb.toFixed(1)} MB)`);
  if (optedOut.length > 0) {
    console.log(`  vendor: not vendored (absent from optionalDependencies): ${optedOut.join(", ")}`);
  }
  if (committed.length > 0) {
    console.log(`  vendor: ${committed.length} prebuilt in vendor/ (sibling repo not checked out): ${committed.join(", ")}`);
  }
  if (kept.length > 0) {
    console.log(`  vendor: ${kept.length} kept from an earlier build:`);
    for (const k of kept) console.log(`    ${k}`);
  }
  if (missing.length > 0) {
    console.warn(`⚠ vendor: ${missing.length} grammar(s) unavailable — their languages stay unclaimed (warning only):`);
    for (const m of missing) console.warn(`    ${m}`);
  }
  if (!process.argv.includes("--no-bundle-check")) warnIfBundleStale();
} catch (err) {
  // Staging is a convenience for the published package; it must never fail a build.
  console.warn(`⚠ vendor: grammar staging skipped (${err.message})`);
}
