/**
 * Builds and packs the optional native tree-sitter grammars that live in sibling
 * repositories, so `npm run build` keeps them in step with graft's own code.
 *
 * Graft's depth tier covers 14 languages (C#, Groovy, PL/SQL, C, C++, CSS, HTML,
 * Razor, XML, JSON, YAML, Markdown, SCSS, CSV) through native grammars declared as
 * `optionalDependencies: {"tree-sitter-cpp": "file:../tree-sitter-cpp", …}`. Those
 * are working copies on this machine, not registry packages, and nothing used to
 * rebuild them: editing a grammar left graft parsing with the previously compiled
 * `.node` until someone remembered to run prebuildify by hand.
 *
 * For each grammar this script:
 *   1. skips it outright when the sibling directory is absent — which is what makes
 *      `npm run build` safe on a machine that has only graft;
 *   2. rebuilds the native binding only when a source file is newer than the compiled
 *      `.node`, so the common case costs a handful of stat calls rather than minutes
 *      of compiling large generated parsers (PL/SQL's parser.c alone is ~9.7 MB);
 *   3. re-packs it into vendor/ when the tarball is older than the `.node`.
 *
 * vendor/*.tgz is then the input to scripts/pack-bundle.mjs, which turns graft plus
 * these grammars into a single installable tarball.
 *
 * Usage: node scripts/build-grammars.mjs [--force] [--quiet]
 *   --force  rebuild and repack every grammar, ignoring the staleness checks
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(repoRoot, "vendor");
/** Content hashes of each grammar's sources as of its last successful build. */
const stampFile = join(vendorDir, ".grammar-stamps.json");
const force = process.argv.includes("--force");
const quiet = process.argv.includes("--quiet");

/** Prebuilds are per platform+arch; this is the only tuple graft's bundle ships. */
const PLATFORM = `${process.platform}-${process.arch}`;

/** Directories never worth walking when timestamping a grammar's sources: build
 * outputs and dependency trees change constantly and would force endless rebuilds. */
const SKIP_DIRS = new Set(["node_modules", ".git", "build", "prebuilds", "target", "examples", "test"]);

/** The files that decide whether a grammar needs recompiling. `src/` holds the
 * generated parser.c/scanner.c, `bindings/` the node glue, and grammar.js/binding.gyp
 * are the inputs those are generated from. */
const SOURCE_ENTRIES = ["grammar.js", "binding.gyp", "package.json", "src", "bindings"];

function log(...args) {
  if (!quiet) console.log(...args);
}

/**
 * A content hash of everything that can affect a grammar's compiled output.
 *
 * Deliberately content, not mtime. A git checkout, a branch switch or a file copy
 * rewrites mtimes without changing a byte, and trusting them made every grammar look
 * stale on a machine that had merely pulled — turning a no-op build into minutes of
 * recompiling. graft's own extractor cache learned the same lesson (see the comment
 * on reading-vs-stat in src/graph/build.ts). Reading ~80 MB of generated parser.c
 * across all 14 grammars costs well under a second.
 */
function sourceHash(dir) {
  const hash = createHash("sha256");
  const walk = (path) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return; // an absent optional entry contributes nothing
    }
    if (stat.isDirectory()) {
      // Sorted: readdir order is filesystem-dependent, and the hash must not be.
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
        walk(join(path, entry.name));
      }
      return;
    }
    hash.update(relative(dir, path).replace(/\\/g, "/"));
    hash.update(readFileSync(path));
  };
  for (const entry of SOURCE_ENTRIES) walk(join(dir, entry));
  return hash.digest("hex");
}

function readStamps() {
  try {
    return JSON.parse(readFileSync(stampFile, "utf8"));
  } catch {
    return {};
  }
}

/** The compiled binding for a grammar, or null when it has never been built. */
function prebuiltNode(dir) {
  const prebuilds = join(dir, "prebuilds", PLATFORM);
  try {
    const file = readdirSync(prebuilds).find((f) => f.endsWith(".node"));
    return file ? join(prebuilds, file) : null;
  } catch {
    return null;
  }
}

/**
 * Locate npm's or npx's JavaScript entry point, so it can be run as `node <cli.js>`.
 *
 * On Windows both are `.cmd` shims, and neither way of launching one is clean:
 * spawning the `.cmd` directly throws EINVAL (Node refuses since the 2024 argument-
 * injection fix), while `shell: true` concatenates arguments instead of escaping them
 * (DEP0190) — a real hazard here, where one argument is a path containing a space and
 * a `!`. Running the CLI's own .js under the current node avoids the shim entirely.
 * Returns null if it can't be found, and the caller falls back to a shell.
 */
function cliEntry(command) {
  const fromNpm = process.env.npm_execpath; // set when npm itself invoked this script
  if (command === "npm" && fromNpm && fromNpm.endsWith(".js") && existsSync(fromNpm)) return fromNpm;
  const roots = [join(dirname(process.execPath), "node_modules", "npm"), join(process.env.APPDATA ?? "", "npm", "node_modules", "npm")];
  for (const root of roots) {
    const cli = join(root, "bin", `${command}-cli.js`);
    if (existsSync(cli)) return cli;
  }
  return null;
}

function run(command, args, cwd) {
  const cli = cliEntry(command);
  const [exe, argv] = cli ? [process.execPath, [cli, ...args]] : [command, args];
  const result = spawnSync(exe, argv, {
    cwd,
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    // Only when we could not find the CLI's .js and must go through the shim.
    shell: !cli && process.platform === "win32",
    encoding: "utf8",
  });
  if (result.error) return { ok: false, message: result.error.message, stdout: "" };
  if (result.status !== 0) return { ok: false, message: `exit ${result.status}`, stdout: result.stdout ?? "" };
  return { ok: true, message: "", stdout: result.stdout ?? "" };
}

/**
 * Rebuild one grammar's native binding.
 *
 * The 14 repos are not uniform — some define `prebuild`, some `prebuildify`, several
 * only an `install: node-gyp-build` hook — so prefer whatever the repo defines and
 * fall back to invoking prebuildify directly. prebuildify is right for all of them,
 * including the multi-grammar repos (csv → csv/psv/tsv, markdown → block + inline,
 * xml → xml/dtd): each already emits one `.node` exposing its grammars as properties,
 * which is exactly what the loader's `prop` field selects.
 */
function rebuild(dir, scripts) {
  if (scripts.prebuild) return run("npm", ["run", "prebuild"], dir);
  if (scripts.prebuildify) return run("npm", ["run", "prebuildify"], dir);
  return run("npx", ["--yes", "prebuildify", "--napi", "--strip"], dir);
}

/** The freshly compiled binding node-gyp leaves behind, or null. */
function compiledNode(dir) {
  const release = join(dir, "build", "Release");
  try {
    const file = readdirSync(release).find((f) => f.endsWith(".node"));
    return file ? join(release, file) : null;
  } catch {
    return null;
  }
}

/** Move a `.node` out of the way even if a process has it loaded. Windows permits
 * renaming a loaded module — the holder keeps its handle to the renamed file — but
 * refuses to unlink or overwrite one, which is how the lock manifests. `quarantine`
 * must be a directory on the same volume that the caller's toolchain will not visit;
 * renaming within build/Release is not enough, because node-gyp then tries to unlink
 * the renamed file too and fails identically. */
function moveAside(file, quarantine) {
  try {
    rmSync(file, { force: true });
    return;
  } catch {
    /* loaded — fall through to the rename */
  }
  mkdirSync(quarantine, { recursive: true });
  renameSync(file, join(quarantine, `${basename(file)}.${process.pid}.${counter++}`));
}
let counter = 0;

/** Sweep quarantined binaries once whatever held them has exited. Best-effort: one
 * still held by a long-running process simply waits for the run after that. */
function sweepQuarantine(quarantine) {
  try {
    for (const f of readdirSync(quarantine)) {
      try {
        rmSync(join(quarantine, f), { force: true });
      } catch {
        /* still loaded — next run */
      }
    }
  } catch {
    /* nothing quarantined yet */
  }
}

/**
 * Clear the previous build output so node-gyp has a free path to write to.
 *
 * Without this, gyp dies with `EPERM: unlink build/Release/*.node` whenever a running
 * graft holds the old binding open — and graft's loader scans build/Release first, so
 * any editor session that indexed a repo with these languages is holding one. Worse
 * than the error is the near miss: gyp can fail this way *after* deciding the target
 * is up to date, leaving a stale .node that looks like a successful build.
 */
function clearBuildOutput(dir) {
  const quarantine = quarantineDir(dir);
  sweepQuarantine(quarantine);
  const existing = compiledNode(dir);
  if (existing) moveAside(existing, quarantine);
}

/** Holding pen for binaries a running process will not let us delete. Under `build/`
 * (which every one of these repos gitignores) but outside `Release/`, where node-gyp
 * would try to unlink it. */
function quarantineDir(dir) {
  return join(dir, "build", ".graft-superseded");
}

/** What prebuildify would call this grammar's binding: the package name with the
 * scope separator swapped, since `/` cannot appear in a filename. */
function prebuildName(pkgName) {
  return `${pkgName.replace(/\//g, "+")}.node`;
}

/**
 * Install a compiled binding as the grammar's prebuild, replacing a loaded one.
 *
 * Windows refuses to overwrite a `.node` that any process has loaded, which is not an
 * edge case here: graft's own MCP server runs for the length of an editor session and
 * loads these grammars as it indexes. prebuildify hits exactly this and dies with
 * `EPERM: rename` after a successful compile, so we place the file ourselves.
 *
 * A loaded DLL *can* be renamed, only not replaced — so move the old one aside and
 * copy the new one into place. The running process keeps its handle to the renamed
 * file and carries on with the old grammar; every process started afterwards gets the
 * new one. Leftovers are swept on the next run, once nothing holds them.
 */
function installPrebuild(dir, pkgName, compiled) {
  const destDir = join(dir, "prebuilds", PLATFORM);
  mkdirSync(destDir, { recursive: true });
  // Keep an existing binding's filename; node-gyp-build and graft both scan the
  // directory rather than expecting a fixed name, but churn here is pointless.
  // Anything quarantined here by an earlier run has to go: prebuilds/ is inside the
  // package's `files` allowlist, so a stray copy would be packed into the tarball and
  // shipped — and the loader takes the first *.node it finds, which might be that one.
  for (const stray of readdirSync(destDir).filter((f) => f.includes(".superseded-"))) {
    moveAside(join(destDir, stray), quarantineDir(dir));
  }
  const existing = readdirSync(destDir).find((f) => f.endsWith(".node"));
  const dest = join(destDir, existing ?? prebuildName(pkgName));
  if (existsSync(dest)) moveAside(dest, quarantineDir(dir));
  copyFileSync(compiled, dest);
  return dest;
}

/** The grammars to process: every optionalDependency pointing at a local directory. */
function grammarTargets() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  return Object.entries(pkg.optionalDependencies ?? {})
    .filter(([, spec]) => typeof spec === "string" && spec.startsWith("file:"))
    .map(([name, spec]) => ({ name, dir: resolve(repoRoot, spec.slice("file:".length)) }));
}

const targets = grammarTargets();
if (targets.length === 0) {
  log("no local grammar dependencies declared — nothing to build");
  process.exit(0);
}

mkdirSync(vendorDir, { recursive: true });

const tally = { built: 0, packed: 0, current: 0, skipped: 0 };
const failures = [];
const stamps = readStamps();

for (const { name, dir } of targets) {
  if (!existsSync(dir)) {
    // Not an error: a checkout without the sibling grammar repos is a normal state,
    // and the affected languages simply stay unclaimed at runtime.
    log(`  ${name}: skipped (${dir} not present)`);
    tally.skipped++;
    continue;
  }

  let meta;
  try {
    meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch (err) {
    failures.push(`${name}: unreadable package.json — ${err.message}`);
    continue;
  }
  // The tarball is named after the package's OWN name, which is not always the
  // dependency key graft uses: the groovy grammar publishes as @bootswithdefer/…
  const pkgName = meta.name ?? name;
  const version = meta.version ?? "0.0.0";
  const tarballBase = `${pkgName.replace(/^@/, "").replace(/\//g, "-")}-`;
  const tarball = join(vendorDir, `${tarballBase}${version}.tgz`);

  const hash = sourceHash(dir);
  let nodeFile = prebuiltNode(dir);
  let didBuild = false;

  if (force || !nodeFile || stamps[pkgName] !== hash) {
    const why = !nodeFile ? "never built" : force ? "forced" : "sources changed";
    log(`  ${name}: building (${why}) …`);
    clearBuildOutput(dir);
    const startedAt = Date.now();
    const built = rebuild(dir, meta.scripts ?? {});
    // Judge the build by what landed on disk, not by the exit code alone. On success
    // prebuildify MOVES the binding into prebuilds/ and build/Release keeps only MSVC
    // intermediates; when its final rename hits EPERM — the old binding being loaded
    // by a running graft — the compile still succeeded and the artifact is sitting in
    // build/Release. So: place a leftover build/Release artifact ourselves if there is
    // one, otherwise accept whatever prebuildify managed to install.
    const compiled = compiledNode(dir);
    try {
      nodeFile = compiled ? installPrebuild(dir, pkgName, compiled) : prebuiltNode(dir);
    } catch (err) {
      failures.push(`${name}: could not install prebuild — ${err.message}`);
      continue;
    }
    if (!nodeFile) {
      failures.push(`${name}: build failed — ${built.ok ? `produced no prebuilds/${PLATFORM}/*.node` : built.message}`);
      continue;
    }
    // The binding must post-date the compile. Anything older is a leftover from a
    // previous build that the toolchain could not replace, and stamping it would
    // record this grammar as current while it silently keeps the old parser.
    if (statSync(nodeFile).mtimeMs < startedAt) {
      failures.push(
        `${name}: build produced no new binding (${relative(repoRoot, nodeFile)} predates the build) — ` +
          "a running graft process is probably holding it; close the editor or restart the MCP server and retry",
      );
      continue;
    }
    didBuild = true;
    tally.built++;
    stamps[pkgName] = hash;
  }

  // Drop tarballs left over from an earlier version so vendor/ holds exactly one per
  // grammar and the bundle can glob it without ambiguity. The remainder after the name
  // must look like a version: one package's prefix is another's — `tree-sitter-c-` also
  // matches `tree-sitter-c-sharp-0.23.5.tgz`, and a plain startsWith deleted C#'s
  // tarball every time the C grammar was processed.
  for (const old of readdirSync(vendorDir)) {
    if (!old.endsWith(".tgz") || !old.startsWith(tarballBase) || join(vendorDir, old) === tarball) continue;
    if (/^\d/.test(old.slice(tarballBase.length))) rmSync(join(vendorDir, old), { force: true });
  }

  const fresh = existsSync(tarball) && statSync(tarball).mtimeMs >= statSync(nodeFile).mtimeMs;
  if (force || !fresh) {
    const result = run("npm", ["pack", "--pack-destination", vendorDir], dir);
    if (!result.ok) {
      failures.push(`${name}: npm pack failed — ${result.message}`);
      continue;
    }
    if (!existsSync(tarball)) {
      failures.push(`${name}: npm pack produced no ${tarball}`);
      continue;
    }
    log(`  ${name}: ${didBuild ? "built + packed" : "packed"}`);
    tally.packed++;
  } else if (didBuild) {
    log(`  ${name}: built`);
  } else {
    log(`  ${name}: up to date`);
    tally.current++;
  }
}

writeFileSync(stampFile, `${JSON.stringify(stamps, null, 2)}\n`);

const summary = `grammars: ${tally.built} built, ${tally.packed} packed, ${tally.current} up to date, ${tally.skipped} skipped`;

if (failures.length > 0) {
  console.error(`\n✗ ${summary}, ${failures.length} failed`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "\n  Native grammar builds need the MSVC C++ toolchain and Python on PATH.\n" +
      "  To carry on without them, run the TypeScript build alone: npm run build:ts\n",
  );
  process.exit(1);
}

// Always printed, even under --quiet: this one line is the script's whole report to
// whoever ran `npm run build`.
console.log(`✓ ${summary}`);
