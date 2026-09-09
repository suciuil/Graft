/**
 * Materialises the 14 optional grammars into `vendor/<grammarKey>/prebuilds/<platform>-<arch>/`,
 * the layout `loadOptionalGrammar` (src/graph/extract.ts) falls back to when normal
 * package resolution comes up empty.
 *
 * This is what lets a plain `npm i -g @nanonets/graft` carry those grammars. They are
 * declared as `optionalDependencies: {"tree-sitter-cpp": "file:../tree-sitter-cpp", …}`
 * — sibling working copies that exist only on the machine they were cloned onto — so
 * anywhere else npm skips all 14 without even erroring, and graft quietly loses C#,
 * Groovy, PL/SQL, C, C++, CSS, HTML, Razor, XML, JSON, YAML, Markdown, SCSS and CSV.
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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(repoRoot, "vendor");
const PLATFORM = `${process.platform}-${process.arch}`;

const extractPath = join(repoRoot, "dist", "graph", "extract.js");
if (!existsSync(extractPath)) {
  console.log("  vendor: skipped (dist/ not built yet)");
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const { optionalGrammarPackages } = await import(pathToFileURL(extractPath).href);

const included = [];
const missing = [];
for (const [key, pkgName] of Object.entries(optionalGrammarPackages())) {
  const spec = pkg.optionalDependencies?.[pkgName];
  const destDir = join(vendorDir, key, "prebuilds", PLATFORM);
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
  // Replaced wholesale: a rename upstream would otherwise leave two .node files here,
  // and the loader takes the first one it finds.
  rmSync(join(vendorDir, key), { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  cpSync(join(srcDir, file), join(destDir, file));
  included.push(key);
}

const mb = included.length === 0 ? 0 : included.reduce((n, key) => {
  const dir = join(vendorDir, key, "prebuilds", PLATFORM);
  return n + readdirSync(dir).reduce((s, f) => s + statSync(join(dir, f)).size, 0);
}, 0) / 1024 / 1024;

console.log(`  vendor: ${included.length} grammars staged for ${PLATFORM} (${mb.toFixed(1)} MB)`);
if (missing.length > 0) {
  console.log(`  vendor: ${missing.length} unavailable (their languages stay unclaimed):`);
  for (const m of missing) console.log(`    ${m}`);
}
