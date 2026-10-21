/**
 * Builds and packs the optional native tree-sitter grammars that live in sibling
 * repositories, so `npm run build` keeps them in step with graft's own code.
 *
 * Graft's depth tier covers 15 languages (C#, Groovy, PL/SQL, C, C++, CMake, CSS, HTML,
 * Razor, XML, JSON, YAML, Markdown, SCSS, CSV) through native grammars declared as
 * `optionalDependencies: {"tree-sitter-cpp": "file:../tree-sitter-cpp", …}`, plus a
 * newer Kotlin grammar (`tree-sitter-kotlin-local`, from `../tree-sitter-kotlin-grammar`)
 * that takes over from the registry one when built. Those
 * are working copies on this machine, not registry packages, and nothing used to
 * rebuild them: editing a grammar left graft parsing with the previously compiled
 * `.node` until someone remembered to run prebuildify by hand.
 *
 * The aim: whatever happened to a sibling grammar repo — a local edit, a `git pull`, a
 * branch switch, a dependency bump, a fresh clone — `npm run build` in graft is the only
 * command needed for graft to parse with it. For each grammar this script:
 *   0. reports upstream commits not yet in the working copy (`--pull` fast-forwards a
 *      clean checkout), installs the grammar's own dependencies when package.json asks
 *      for something node_modules lacks (lockfile untouched), and repairs graft's
 *      node_modules link if it points at a different checkout;
 *   1. skips it outright when the sibling directory is absent (or is not a grammar
 *      checkout) — which is what makes `npm run build` safe on a machine that has only
 *      graft. Anything else that is merely *unavailable* (no tree-sitter CLI, deps not
 *      installed) is a warning that keeps the previous build, never a failed build;
 *   2. regenerates the parser (`tree-sitter generate`) for every grammar the binding
 *      compiles — one per `<dir>/src/parser.c` listed in binding.gyp, so xml/dtd,
 *      csv/psv/tsv and markdown/inline each get their own — when its grammar.js (or a
 *      file grammar.js requires, e.g. common/common.js) changed but src/parser.c did
 *      not (local edit, or a pulled commit that skipped regenerating), or when a new
 *      parser.c exceeds the ABI graft's runtime loads. Uses the grammar's own pinned
 *      tree-sitter-cli and keeps the existing ABI, capped at the runtime's;
 *   3. rebuilds the native binding only when a compile input changed (content hash of
 *      parser/scanner sources, bindings, binding.gyp, grammar.js — wherever they live,
 *      including the multi-grammar layouts like xml/src or csv/src), so the common case
 *      costs a hash rather than minutes of compiling large generated parsers (PL/SQL's
 *      parser.c alone is ~9.7 MB);
 *   4. re-packs it into vendor/ when the binding was rebuilt OR when any other local
 *      file of the grammar changed (queries/*.scm, tree-sitter.json, README, …), so
 *      every local edit reaches the tarball, not just the ones that need a compile;
 *   5. deletes a stale build/Release|Debug/*.node that differs from the prebuild —
 *      node-gyp-build (graft's loader) prefers it, so it would shadow every rebuild.
 *
 * vendor/*.tgz is then the input to scripts/pack-bundle.mjs, which turns graft plus
 * these grammars into a single installable tarball.
 *
 * Usage: node scripts/build-grammars.mjs [--force] [--quiet] [--generate | --no-generate] [--strict]
 *   --force        rebuild and repack every grammar, ignoring the staleness checks
 *                  (does not force `tree-sitter generate`: that rewrites committed files)
 *   --generate     regenerate every grammar's src/ regardless of timestamps
 *   --no-generate  never run `tree-sitter generate`; compile src/ as it is
 *   --no-install   never run `npm install` in a grammar repo; only report stale deps
 *   --fetch        `git fetch` each grammar repo first, to report unpulled commits
 *                  (env GRAFT_GRAMMARS_FETCH=1)
 *   --pull         fetch, then fast-forward clean checkouts that are behind
 *                  (env GRAFT_GRAMMARS_PULL=1). Never merges or touches local edits.
 *   --strict       treat warnings (unavailable CLI / deps) as failures
 *
 * Through npm: `npm run build:grammars -- --pull`. `npm run build -- --pull` does NOT
 * work — npm appends the flag to the last script of the `&&` chain (build:vendor) — so
 * for the full build use the env form: `$env:GRAFT_GRAMMARS_PULL=1; npm run build`.
 */
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire, isBuiltin } from "node:module";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(repoRoot, "vendor");
/** Per grammar `{ build, pack }`: content hashes as of its last successful build and
 * pack. (Older versions stored a bare string — the legacy build hash; migrated below.) */
const stampFile = join(vendorDir, ".grammar-stamps.json");
const force = process.argv.includes("--force");
const quiet = process.argv.includes("--quiet");
const generateEnabled = !process.argv.includes("--no-generate");
const forceGenerate = generateEnabled && process.argv.includes("--generate");
const strict = process.argv.includes("--strict");
const installDeps = !process.argv.includes("--no-install");
const pullUpstream = process.argv.includes("--pull") || process.env.GRAFT_GRAMMARS_PULL === "1";
const fetchUpstream = pullUpstream || process.argv.includes("--fetch") || process.env.GRAFT_GRAMMARS_FETCH === "1";

/** Prebuilds are per platform+arch; this is the only tuple graft's bundle ships. */
const PLATFORM = `${process.platform}-${process.arch}`;

/** Directories never worth walking when hashing a grammar: build outputs, dependency
 * trees and VCS metadata change constantly and would force endless rebuilds. The
 * compiled binding in prebuilds/ is tracked separately (by mtime against the tarball). */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "build", "prebuilds", "target", "examples", "test",
  "__pycache__", ".venv", "venv",
]);

/** Legacy compile-input list — only used to migrate stamps written by older versions
 * of this script without forcing a one-off rebuild of every grammar. */
const LEGACY_SOURCE_ENTRIES = ["grammar.js", "binding.gyp", "package.json", "src", "bindings"];

/** Path segments whose files feed the native compile, at any depth: `src/` holds the
 * generated parser.c/scanner.c (also `xml/src`, `csv/src`, `tree-sitter-markdown/src`
 * in the multi-grammar repos), `common/` shared grammar code. `bindings/node/` (the
 * node glue) is matched separately — bindings for C, Go, Rust, Swift… never reach it. */
const BUILD_SEGMENTS = new Set(["src", "common"]);
/** Files that feed the native compile wherever they sit. */
const BUILD_FILES = new Set(["grammar.js", "binding.gyp"]);

function log(...args) {
  if (!quiet) console.log(...args);
}

/** Every file of a grammar worth tracking, as sorted repo-relative `/` paths. */
function grammarFiles(dir) {
  const out = [];
  const walk = (abs) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(abs, entry.name);
      if (entry.isDirectory()) {
        // Dot-directories are tool/VCS state (.git, .github, .kilo worktrees, .vscode),
        // never part of the package — and an agent worktree nests a whole second copy.
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(path);
      } else if (entry.isFile() && !entry.name.endsWith(".tgz")) {
        // *.tgz: some repos keep a stale `npm pack` output in their root.
        out.push(relative(dir, path).replace(/\\/g, "/"));
      }
    }
  };
  walk(dir);
  // Sorted: readdir order is filesystem-dependent, and the hash must not be.
  return out.sort();
}

/** True when a grammar file can change the compiled `.node`. */
function isBuildInput(rel) {
  if (rel === "package.json") return true;
  const parts = rel.split("/");
  if (BUILD_FILES.has(parts[parts.length - 1])) return true;
  const dirs = parts.slice(0, -1);
  return dirs.some((p, i) => BUILD_SEGMENTS.has(p) || (p === "bindings" && dirs[i + 1] === "node"));
}

function hashFiles(dir, rels) {
  const hash = createHash("sha256");
  for (const rel of rels) {
    hash.update(rel);
    hash.update(readFileSync(join(dir, rel)));
  }
  return hash.digest("hex");
}

/**
 * Two content hashes per grammar:
 *   - `build`: only the compile inputs → a change means recompiling the binding;
 *   - `pack`:  every local file (queries/*.scm, tree-sitter.json, docs, …) → a change
 *              means re-packing the tarball, which is cheap, so any local edit ships.
 *
 * Deliberately content, not mtime. A git checkout, a branch switch or a file copy
 * rewrites mtimes without changing a byte, and trusting them made every grammar look
 * stale on a machine that had merely pulled — turning a no-op build into minutes of
 * recompiling. graft's own extractor cache learned the same lesson (see the comment
 * on reading-vs-stat in src/graph/build.ts). Reading ~100 MB across all 14 grammars
 * costs about a second.
 */
function grammarHashes(dir) {
  const files = grammarFiles(dir);
  return { build: hashFiles(dir, files.filter(isBuildInput)), pack: hashFiles(dir, files) };
}

/** The build hash older versions of this script stored, for stamp migration only. */
function legacySourceHash(dir) {
  const hash = createHash("sha256");
  const walk = (path) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && ["node_modules", ".git", "build", "prebuilds", "target", "examples", "test"].includes(entry.name)) continue;
        walk(join(path, entry.name));
      }
      return;
    }
    hash.update(relative(dir, path).replace(/\\/g, "/"));
    hash.update(readFileSync(path));
  };
  for (const entry of LEGACY_SOURCE_ENTRIES) walk(join(dir, entry));
  return hash.digest("hex");
}

function readStamps() {
  try {
    return JSON.parse(readFileSync(stampFile, "utf8"));
  } catch {
    return {};
  }
}

/**
 * The stored `{ build, pack }` stamp for a grammar. A legacy bare-string stamp that
 * still matches the old hash is carried over as the current build hash, so upgrading
 * this script does not recompile all 14 grammars; its missing `pack` hash makes the
 * tarball re-pack once, which is cheap and picks up edits the old check never saw.
 */
function stampFor(stamps, pkgName, dir) {
  const s = stamps[pkgName];
  if (s && typeof s === "object") return s;
  if (typeof s === "string" && s === legacySourceHash(dir)) return { build: grammarHashes(dir).build };
  return {};
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
function moveAside(file, quarantine, { noFallback = false } = {}) {
  try {
    rmSync(file, { force: true });
    return;
  } catch {
    /* loaded — fall through to the rename */
  }
  const name = `${basename(file)}.${process.pid}.${counter++}`;
  try {
    mkdirSync(quarantine, { recursive: true });
    renameSync(file, join(quarantine, name));
  } catch (err) {
    // EXDEV: graft and the grammar repo sit on different volumes, and a rename cannot
    // cross them. Park it inside the repo instead (the pre-existing behaviour).
    if (noFallback || err.code !== "EXDEV") throw err;
    const repoDir = file.split(/[\\/](?:build|prebuilds)[\\/]/)[0];
    const fallback = legacyQuarantineDir(repoDir);
    mkdirSync(fallback, { recursive: true });
    renameSync(file, join(fallback, name));
  }
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
  migrateLegacyQuarantine(dir);
  for (const cfg of ["Release", "Debug"]) {
    let files = [];
    try {
      files = readdirSync(join(dir, "build", cfg)).filter((f) => f.endsWith(".node"));
    } catch {
      /* no such output */
    }
    for (const f of files) moveAside(join(dir, "build", cfg, f), quarantine);
  }
}

/**
 * Holding pen for binaries a running process will not let us delete (on Windows a
 * loaded `.node` can be renamed but not unlinked). It lives in graft's own
 * node_modules/.cache, OUTSIDE the grammar repo:
 *   - not under the repo's build/: `node-gyp rebuild` starts by deleting all of build/,
 *     and one locked file in there fails the whole compile with EPERM (this is what a
 *     running graft MCP server did to the markdown grammar);
 *   - not elsewhere in the repo: a grammar without a `files` allowlist (csv) would pack
 *     it into its tarball.
 * Renames must stay on one volume; when graft and the grammar are on different ones,
 * moveAside() falls back to the legacy in-repo location.
 */
function quarantineDir(dir) {
  return join(repoRoot, "node_modules", ".cache", "graft-superseded", basename(dir));
}
function legacyQuarantineDir(dir) {
  return join(dir, "build", ".graft-superseded");
}

/** Empty the old in-repo holding pen: delete what can be deleted, move the rest (still
 * loaded somewhere) out of build/ so node-gyp's clean step can delete the directory. */
function migrateLegacyQuarantine(dir) {
  const old = legacyQuarantineDir(dir);
  let files;
  try {
    files = readdirSync(old);
  } catch {
    return;
  }
  for (const f of files) moveAside(join(old, f), quarantineDir(dir), { noFallback: true });
  try {
    rmSync(old, { recursive: true, force: true });
  } catch {
    /* something still pinned — node-gyp will report it */
  }
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

// --- tree-sitter generate ----------------------------------------------------------

/** graft's own tree-sitter runtime (node_modules/tree-sitter): the package that loads
 * every grammar at index time, so its ABI range is the one that matters. */
const RUNTIME_DIR = join(repoRoot, "node_modules", "tree-sitter");

/** The parser ABI range graft's runtime loads (`TREE_SITTER_MIN_COMPATIBLE_LANGUAGE_VERSION`
 * – `TREE_SITTER_LANGUAGE_VERSION`). A parser.c outside it compiles fine and then fails
 * at load time, so the language silently drops out of graft. `known: false` when the
 * runtime is not installed (graft's own `npm install` has not run). */
function runtimeAbiRange() {
  try {
    const api = readFileSync(join(RUNTIME_DIR, "vendor", "tree-sitter", "lib", "include", "tree_sitter", "api.h"), "utf8");
    const max = api.match(/#define TREE_SITTER_LANGUAGE_VERSION (\d+)/);
    const min = api.match(/#define TREE_SITTER_MIN_COMPATIBLE_LANGUAGE_VERSION (\d+)/);
    if (max) return { min: min ? Number(min[1]) : 13, max: Number(max[1]), known: true };
  } catch {
    /* runtime not installed yet — fall through */
  }
  return { min: 13, max: 14, known: false };
}
const ABI_RANGE = runtimeAbiRange();
const MAX_ABI = ABI_RANGE.max;
const abiRangeText = `${ABI_RANGE.min}–${ABI_RANGE.max}`;

/** The ABI an existing parser.c was generated at (its `LANGUAGE_VERSION`), or null. */
function parserAbi(parserC) {
  let fd;
  try {
    fd = openSync(parserC, "r");
    const buf = Buffer.alloc(16384); // the define sits in the first few lines
    const n = readSync(fd, buf, 0, buf.length, 0);
    const m = buf.toString("utf8", 0, n).match(/#define LANGUAGE_VERSION (\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The grammars a repo's native binding compiles: one per `<dir>/src/parser.c` named in
 * binding.gyp (`xml/src/parser.c` + `dtd/src/parser.c`, `csv|psv|tsv/src/parser.c`,
 * markdown's block + inline). Grammars the binding does not compile (yaml's schema/*
 * helpers) are not graft's concern. Falls back to the repo root without a binding.gyp.
 */
function grammarUnits(dir) {
  let gyp = "";
  try {
    gyp = readFileSync(join(dir, "binding.gyp"), "utf8");
  } catch {
    /* no binding.gyp — root only */
  }
  const rels = new Set();
  for (const m of gyp.matchAll(/["']((?:[^"'\\/]+[\\/])*?)src[\\/]parser\.c["']/g)) {
    rels.add(m[1].replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""));
  }
  if (rels.size === 0) rels.add("");
  return [...rels]
    .map((rel) => ({ rel: rel || ".", dir: join(dir, rel) }))
    .filter((u) => existsSync(join(u.dir, "grammar.js")) && existsSync(join(u.dir, "src", "parser.c")));
}

/** grammar.js plus every file it pulls in (transitively): `../common/common.js`,
 * `tree-sitter-c/grammar.js` for C++, … — an edit to any of them changes the parser. */
function grammarInputs(unitDir) {
  const seen = new Set();
  const visit = (file, depth) => {
    if (seen.has(file) || seen.size >= 200 || depth > 10) return;
    seen.add(file);
    if (!/\.[cm]?js$/.test(file)) return; // .json and friends: tracked, not parsed
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    const req = createRequire(file);
    for (const m of text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)|\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec || isBuiltin(spec)) continue;
      try {
        visit(req.resolve(spec), depth + 1);
      } catch {
        /* unresolvable: the CLI will report it if it matters */
      }
    }
  };
  visit(join(unitDir, "grammar.js"), 0);
  return [...seen].sort();
}

function hashInputs(unitDir, files) {
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(relative(unitDir, f).replace(/\\/g, "/"));
    try {
      hash.update(readFileSync(f));
    } catch {
      /* vanished mid-run */
    }
  }
  return hash.digest("hex");
}

/** Never let git prompt (credentials, host keys) inside a build. */
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

function git(repo, args, timeout = 60_000) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout, env: gitEnv });
  return { ok: !r.error && r.status === 0, out: `${r.stdout ?? ""}`.trim(), err: `${r.stderr ?? ""}`.trim() || r.error?.message || "" };
}

/**
 * Upstream changes that have not reached the working copy — the one kind of update a
 * local build cannot see by itself. By default only reported, from what git already
 * knows (no network). `--fetch` asks the remote first; `--pull` also fast-forwards a
 * clean checkout (never merges, never touches local edits or a diverged branch).
 */
function checkUpstream(name, dir) {
  if (!git(dir, ["rev-parse", "--is-inside-work-tree"]).ok) return;
  const upstream = git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream.ok) return; // no tracking branch: nothing to compare against
  if (fetchUpstream || pullUpstream) {
    const f = git(dir, ["fetch", "--quiet", "--no-tags"], 120_000);
    if (!f.ok) {
      warnings.push(`${name}: could not fetch ${upstream.out} (${f.err.split("\n").pop()}) — using what git already knows`);
    }
  }
  const counts = git(dir, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
  if (!counts.ok) return;
  const [ahead, behind] = counts.out.split(/\s+/).map(Number);
  if (!behind) return;
  if (pullUpstream) {
    const dirty = git(dir, ["status", "--porcelain", "--untracked-files=no"]).out;
    if (ahead === 0 && !dirty) {
      const p = git(dir, ["merge", "--ff-only", "--quiet", "@{u}"], 120_000);
      if (p.ok) {
        log(`  ${name}: pulled ${behind} commit(s) from ${upstream.out}`);
        return;
      }
      warnings.push(`${name}: fast-forward to ${upstream.out} failed (${p.err.split("\n").pop()})`);
      return;
    }
    notices.push(
      `${name}: ${behind} commit(s) on ${upstream.out} not pulled — ${ahead ? `branch has ${ahead} local commit(s)` : "uncommitted changes"}; merge by hand`,
    );
    return;
  }
  notices.push(`${name}: ${behind} commit(s) on ${upstream.out} not in the working copy (git pull, or GRAFT_GRAMMARS_PULL=1)`);
}

/**
 * Bring a grammar's own node_modules in line with its package.json / lockfile, so a
 * pull that bumps tree-sitter-cli, node-addon-api or prebuildify — or a fresh clone
 * that was never installed — is handled by `npm run build` alone.
 *
 * Only when something declared is missing or at a different version: a full
 * `npm install` costs seconds per repo even when nothing changes. `--no-save` keeps
 * package.json and package-lock.json untouched (they are the grammar repo's committed
 * files), `--ignore-scripts` keeps npm from compiling the binding — the build step
 * below does that, with the lock handling install scripts lack. The tree-sitter CLI's
 * own download (also an install script) happens on demand in treeSitterCli().
 * Returns an error string when dependencies are needed but could not be installed.
 */
function syncDependencies(name, dir, meta) {
  const declared = { ...(meta.dependencies ?? {}), ...(meta.devDependencies ?? {}) };
  const stale = [];
  for (const [dep, range] of Object.entries(declared)) {
    let installed = null;
    try {
      installed = JSON.parse(readFileSync(join(dir, "node_modules", ...dep.split("/"), "package.json"), "utf8")).version;
    } catch {
      /* missing */
    }
    if (!installed) stale.push(`${dep} missing`);
    else if (!satisfies(installed, range)) stale.push(`${dep} ${installed} ∉ ${range}`);
  }
  if (stale.length === 0) return null;
  if (!installDeps) return `dependencies out of date (${stale.slice(0, 3).join(", ")}) — run \`npm install\` in the grammar repo`;
  log(`  ${name}: installing dependencies (${stale.slice(0, 3).join(", ")}${stale.length > 3 ? ", …" : ""}) …`);
  const lock = existsSync(join(dir, "package-lock.json")) ? readFileSync(join(dir, "package-lock.json")) : null;
  const r = run("npm", ["install", "--ignore-scripts", "--no-save", "--no-audit", "--no-fund", "--loglevel=error"], dir);
  // Belt and braces: a lockfile rewrite would show up as a spurious change in their repo.
  if (lock && !readFileSync(join(dir, "package-lock.json")).equals(lock)) writeFileSync(join(dir, "package-lock.json"), lock);
  if (!r.ok) return `npm install failed (${r.message}) — run \`npm install\` in the grammar repo`;
  return null;
}

/** Minimal semver range check for the ranges grammar repos use (^, ~, >=, x, exact,
 * `||`). Anything it does not understand counts as satisfied — this only decides
 * whether to spend an `npm install`, and a false "fine" is what happened before. */
function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v || typeof range !== "string") return true;
  if (/^(file:|link:|git|https?:|npm:|workspace:)/.test(range.trim()) || range.includes("/")) return true;
  return range.split("||").some((alt) => {
    const parts = alt.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0 || parts[0] === "*" || parts[0] === "latest") return true;
    return parts.every((p) => {
      const m = p.match(/^(\^|~|>=|<=|>|<|=)?v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/);
      if (!m) return true;
      const [, op = "", ...nums] = m;
      const want = nums.map((n) => (n === undefined || n === "x" || n === "*" ? null : Number(n)));
      const cmp = compareVersions(v, want.map((n) => n ?? 0));
      if (op === ">=") return cmp >= 0;
      if (op === ">") return cmp > 0;
      if (op === "<=") return cmp <= 0;
      if (op === "<") return cmp < 0;
      if (op === "^") {
        if (cmp < 0) return false;
        const lead = want.findIndex((n) => n !== 0 && n !== null);
        const idx = lead === -1 ? want.filter((n) => n !== null).length - 1 : lead;
        return want.slice(0, idx + 1).every((n, i) => n === null || v[i] === n);
      }
      if (op === "~") return cmp >= 0 && v[0] === (want[0] ?? v[0]) && (want[1] === null || v[1] === want[1]);
      return want.every((n, i) => n === null || v[i] === n);
    });
  });
}
function parseVersion(s) {
  const m = String(s).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Remove compiled bindings in build/Release or build/Debug that differ from the
 * prebuild. node-gyp-build — which graft's loader asks first — returns build/Release
 * ahead of prebuilds/, so a leftover from an earlier `npm install` or manual node-gyp
 * run silently shadows every rebuild (tree-sitter-plsql carried one from Aug 24 that
 * graft loaded instead of the newer prebuild).
 */
function removeShadowingBuilds(name, dir, nodeFile) {
  if (!nodeFile) return;
  const want = hashFile(nodeFile);
  for (const cfg of ["Release", "Debug"]) {
    const out = join(dir, "build", cfg);
    let files;
    try {
      files = readdirSync(out).filter((f) => f.endsWith(".node"));
    } catch {
      continue;
    }
    for (const f of files) {
      if (hashFile(join(out, f)) === want) continue;
      moveAside(join(out, f), quarantineDir(dir));
      log(`  ${name}: removed stale build/${cfg}/${f} (it shadowed the current prebuild)`);
    }
  }
}

/**
 * graft resolves grammars through node_modules/<pkg>, which `npm install` links to the
 * sibling repo. When that link is missing — the sibling was cloned after graft's last
 * `npm install`, or npm skipped the optional dependency — graft falls back to its
 * vendor/ copy, which is refreshed on every build anyway; so only a link pointing
 * somewhere else is repaired here (it would load a different grammar entirely).
 */
function checkGraftLink(name, dir) {
  const link = join(repoRoot, "node_modules", ...name.split("/"));
  let target = null;
  try {
    target = realpathSync(link);
  } catch {
    notices.push(`${name}: not linked in graft's node_modules (graft uses vendor/ instead; \`npm install\` in graft links it)`);
    return;
  }
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return;
  }
  if (target.toLowerCase() === real.toLowerCase()) return;
  try {
    rmSync(link, { recursive: true, force: true });
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    log(`  ${name}: relinked node_modules/${name} → ${real} (it pointed at ${target})`);
  } catch (err) {
    warnings.push(`${name}: node_modules/${name} points at ${target}, not ${real}, and could not be relinked (${err.message})`);
  }
}

const cliCache = new Map();

/**
 * The grammar's OWN pinned tree-sitter CLI (`node_modules/tree-sitter-cli`) — the 14
 * repos pin anything from 0.20 to 0.26, and generating with a different CLI than the
 * one a grammar was written for is how parse trees silently change. The npm package
 * only carries a downloader; the binary arrives via its install script, which
 * `--ignore-scripts` or an offline install skips, so fetch it on first use.
 * Returns `{ error }` when unavailable — the caller turns that into a warning.
 */
function treeSitterCli(dir) {
  const cliDir = join(dir, "node_modules", "tree-sitter-cli");
  if (!existsSync(join(cliDir, "package.json"))) {
    return { error: "tree-sitter-cli is not installed (run `npm install` in the grammar repo)" };
  }
  const exe = join(cliDir, process.platform === "win32" ? "tree-sitter.exe" : "tree-sitter");
  if (!existsSync(exe)) {
    if (!existsSync(join(cliDir, "install.js"))) return { error: `tree-sitter-cli has no binary at ${exe}` };
    log(`    fetching the pinned tree-sitter CLI into ${relative(repoRoot, cliDir)} …`);
    const r = spawnSync(process.execPath, ["install.js"], { cwd: cliDir, encoding: "utf8", stdio: "pipe", timeout: 300_000 });
    if (!existsSync(exe)) {
      const why = r.error?.message ?? (`${r.stderr ?? ""}`.trim().split("\n").pop() || `exit ${r.status}`);
      return { error: `could not download the tree-sitter CLI (${why})` };
    }
  }
  if (!cliCache.has(exe)) {
    // Flags differ across the pinned versions: --abi arrived in 0.20, --no-bindings
    // (without which old CLIs rewrite binding.gyp and bindings/) left in 0.24.
    const help = spawnSync(exe, ["generate", "--help"], { encoding: "utf8", timeout: 60_000 });
    const text = `${help.stdout ?? ""}${help.stderr ?? ""}`;
    cliCache.set(exe, { exe, abi: /--abi\b/.test(text), noBindings: /--no-bindings\b/.test(text) });
  }
  return cliCache.get(exe);
}

/** `tree-sitter generate` in one grammar's directory. */
function generateUnit(cli, unit, abi) {
  const args = ["generate"];
  if (cli.abi && abi) args.push("--abi", String(abi));
  if (cli.noBindings) args.push("--no-bindings");
  // The CLI evaluates grammar.js with `node` from PATH; make it this node.
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = `${dirname(process.execPath)}${delimiter}${env[pathKey] ?? ""}`;
  if (process.platform === "win32") {
    // Forward slashes: NODE_OPTIONS treats a backslash inside quotes as an escape.
    const shim = join(repoRoot, "scripts", "tree-sitter-grammar-path.cjs").replace(/\\/g, "/");
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --require "${shim}"`.trim();
  }
  const r = spawnSync(cli.exe, args, {
    cwd: unit.dir,
    env,
    encoding: "utf8",
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: 1_800_000,
  });
  if (r.error) return { ok: false, message: r.error.message };
  if (r.status !== 0) {
    const tail = `${r.stderr ?? ""}`.trim().split("\n").slice(-5).join("\n    ");
    return { ok: false, message: `exit ${r.status}${tail ? `\n    ${tail}` : ""}` };
  }
  return { ok: true };
}

function hashFile(file) {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/** git status of `files` inside `repo`: which are modified vs HEAD. null = not a git
 * checkout (or git unavailable) — no evidence either way. */
function gitModified(repo, files) {
  const rels = files
    .map((f) => relative(repo, f))
    .filter((r) => r && !r.startsWith("..") && !/^[a-zA-Z]:/.test(r))
    .map((r) => r.replace(/\\/g, "/"));
  if (rels.length === 0) return null;
  const r = spawnSync("git", ["-C", repo, "status", "--porcelain", "--", ...rels], { encoding: "utf8", timeout: 60_000, env: gitEnv });
  if (r.error || r.status !== 0) return null;
  return new Set(
    `${r.stdout ?? ""}`.split("\n").filter(Boolean).map((l) => l.slice(3).trim().replace(/^"|"$/g, "")),
  );
}

/**
 * Decide, per grammar the binding compiles, whether src/ must be regenerated, and do it.
 *
 * Content, not timestamps, drives it once a grammar has been seen (stamp `gen[unit] =
 * { in, parser }`: hashes of the grammar inputs and of parser.c when last in sync):
 *   - inputs unchanged                  → in sync (a checkout merely touched mtimes);
 *   - inputs changed, parser.c changed  → regenerated alongside (by hand, or both came
 *                                         in with a pull) → in sync;
 *   - inputs changed, parser.c the same → grammar.js is ahead of its parser: generate.
 *                                         This covers local edits AND pulls whose commit
 *                                         did not regenerate src/.
 * The first time a grammar is seen there is no record, so the rule is the plain one —
 * grammar.js newer than src/parser.c — minus the case git can disprove: nothing
 * modified vs HEAD means a committed, matching pair written in checkout order
 * (tree-sitter-json's grammar.js is hours "newer" than its parser.c from one commit).
 *
 * A parser.c above the ABI graft's runtime loads is regenerated at that ABI too (e.g.
 * an upstream moved to ABI 15): it would build, then silently fail to load, and the
 * language would drop out of graft. A failed attempt is retried on the next build.
 *
 * Returns `{ generated, pending, failed }`. `pending`: some needed generating but could
 * not (CLI unavailable) — the binding must not then be rebuilt from the stale src/.
 */
function regenerate(name, dir, entry) {
  const result = { generated: 0, pending: false, failed: false };
  if (!generateEnabled) return result;
  entry.gen ??= {};
  for (const unit of grammarUnits(dir)) {
    const parserC = join(unit.dir, "src", "parser.c");
    const inputs = grammarInputs(unit.dir);
    const inHash = hashInputs(unit.dir, inputs);
    const parserHash = hashFile(parserC);
    // Older stamps stored the input hash alone; its parser.c is taken as the one on disk.
    const raw = entry.gen[unit.rel];
    const rec = typeof raw === "string" ? { in: raw, parser: parserHash } : raw;
    const label = unit.rel === "." ? name : `${name} (${unit.rel})`;
    const abiNow = parserAbi(parserC);
    const abiTooNew = abiNow !== null && abiNow > MAX_ABI;

    let reason = null;
    if (forceGenerate) {
      reason = "--generate";
    } else if (rec) {
      if (rec.in !== inHash && rec.parser === parserHash) reason = "grammar.js changed since src/parser.c was generated";
      else if (abiTooNew) reason = `new src/parser.c is ABI ${abiNow}; graft's runtime loads ≤ ${MAX_ABI}`;
    } else {
      const newest = Math.max(...inputs.map((f) => statSync(f).mtimeMs));
      if (newest > statSync(parserC).mtimeMs) {
        const mod = gitModified(dir, [...inputs, parserC]);
        const parserRel = relative(dir, parserC).replace(/\\/g, "/");
        // No git: the plain timestamp rule. Git: an input edited while parser.c is not.
        if (mod === null || (mod.size > 0 && !mod.has(parserRel))) reason = "grammar.js newer than src/parser.c";
      }
    }
    if (!reason) {
      entry.gen[unit.rel] = { in: inHash, parser: parserHash };
      continue;
    }

    const abiOnly = reason.startsWith("new src/parser.c");
    const cli = treeSitterCli(dir);
    if (cli.error) {
      warnings.push(`${label}: ${reason}, but src/ was not regenerated — ${cli.error}`);
      if (!abiOnly) result.pending = true;
      continue;
    }
    const abi = Math.min(abiNow ?? MAX_ABI, MAX_ABI);
    log(`  ${label}: generating (${reason}; ABI ${abi}) …`);
    const gen = generateUnit(cli, unit, abi);
    if (!gen.ok) {
      if (abiOnly) {
        // Upstream's own parser.c is kept; the grammar may not load, but that is not
        // something the user's change broke.
        warnings.push(`${label}: could not regenerate at ABI ${abi} — graft may not load it (${gen.message})`);
        entry.gen[unit.rel] = { in: inHash, parser: parserHash };
        continue;
      }
      failures.push(`${label}: tree-sitter generate failed — ${gen.message}`);
      result.failed = true;
      continue;
    }
    entry.gen[unit.rel] = { in: inHash, parser: hashFile(parserC) };
    result.generated++;
  }
  return result;
}

/** Why a grammar's native build cannot run here, or null. Missing dependencies are an
 * environment state (the repo was cloned but never `npm install`ed), not a broken build. */
function buildBlocker(dir, scripts) {
  if (!existsSync(join(dir, "node_modules"))) return "dependencies not installed (run `npm install` in the grammar repo)";
  let gyp = "";
  try {
    gyp = readFileSync(join(dir, "binding.gyp"), "utf8");
  } catch {
    return "no binding.gyp";
  }
  if (/node-addon-api|node_addon_api/.test(gyp) && !existsSync(join(dir, "node_modules", "node-addon-api"))) {
    return "node-addon-api not installed (run `npm install` in the grammar repo)";
  }
  const usesPrebuildify = /prebuildify/.test(`${scripts.prebuild ?? ""} ${scripts.prebuildify ?? ""}`);
  if (usesPrebuildify && !existsSync(join(dir, "node_modules", "prebuildify"))) {
    return "prebuildify not installed (run `npm install` in the grammar repo)";
  }
  return null;
}

/**
 * After prebuildify installed the binding itself: leave exactly one `.node`, under the
 * name the grammar already used. prebuildify names the file after the package's
 * CURRENT name, which drifts — groovy's committed binding is `@murtaza64+…` while the
 * package is now `@bootswithdefer/…` — and it then sits beside the old one. The loader,
 * vendor-grammars.mjs and prebuiltNode() all take the first `*.node` they list, so two
 * files mean an arbitrary pick, and both would be packed into the tarball.
 */
function settlePrebuild(dir, previousName) {
  const destDir = join(dir, "prebuilds", PLATFORM);
  let files;
  try {
    files = readdirSync(destDir).filter((f) => f.endsWith(".node"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const newest = files.reduce((a, b) => (statSync(join(destDir, b)).mtimeMs > statSync(join(destDir, a)).mtimeMs ? b : a));
  const keep = previousName && files.includes(previousName) ? previousName : newest;
  if (newest !== keep) {
    moveAside(join(destDir, keep), quarantineDir(dir));
    renameSync(join(destDir, newest), join(destDir, keep));
  }
  for (const f of files) {
    if (f !== keep && f !== newest && existsSync(join(destDir, f))) moveAside(join(destDir, f), quarantineDir(dir));
  }
  return join(destDir, keep);
}

/**
 * Graft's own grammar keys → { pkg, prop }, read from the built loader so this cannot
 * drift from what graft actually loads. Falls back to a copy when dist/ is not built yet
 * (build:grammars runs before build:ts). Only the grammar graft uses from a multi-
 * grammar binding is held to the ABI check: markdown's `inline` and csv's `psv`/`tsv`
 * ship at ABI 15 today and graft never loads them.
 */
const GRAFT_GRAMMARS_FALLBACK = {
  "tree-sitter-c-sharp": [undefined], "tree-sitter-groovy": [undefined], "tree-sitter-plsql": [undefined],
  "tree-sitter-css-in-js": [undefined], "tree-sitter-html": [undefined], "tree-sitter-razor": [undefined],
  "@tree-sitter-grammars/tree-sitter-xml": ["xml"], "tree-sitter-c": [undefined], "tree-sitter-cpp": [undefined],
  "tree-sitter-json": [undefined], "@tree-sitter-grammars/tree-sitter-yaml": [undefined],
  "@tree-sitter-grammars/tree-sitter-markdown": [undefined], "tree-sitter-scss": [undefined], "tree-sitter-csv": ["csv"],
  "tree-sitter-cmake": [undefined], "tree-sitter-kotlin-local": [undefined],
};
function graftGrammarProps(pkgName) {
  try {
    const src = readFileSync(join(repoRoot, "src", "graph", "extract.ts"), "utf8");
    const block = src.match(/OPTIONAL_GRAMMAR_PKG[^=]*=\s*\{([\s\S]*?)\n\};/);
    if (block) {
      const props = [];
      for (const m of block[1].matchAll(/\{\s*pkg:\s*"([^"]+)"(?:\s*,\s*prop:\s*"([^"]+)")?\s*\}/g)) {
        if (m[1] === pkgName) props.push(m[2]);
      }
      if (props.length) return props;
    }
  } catch {
    /* source not available — fall back */
  }
  return GRAFT_GRAMMARS_FALLBACK[pkgName] ?? [undefined];
}

/** graft's grammar key (`groovy`, `xml`, …) for a dependency name — the vendor/<key>
 * directory graft falls back to. Read from the same OPTIONAL_GRAMMAR_PKG table. */
function graftKeyFor(depName) {
  try {
    const src = readFileSync(join(repoRoot, "src", "graph", "extract.ts"), "utf8");
    for (const m of src.matchAll(/^\s*(\w+):\s*\{\s*pkg:\s*"([^"]+)"/gm)) if (m[2] === depName) return m[1];
  } catch {
    /* no source */
  }
  return null;
}

/** The grammar unit (from grammarUnits) a binding export comes from: `prop` names its
 * directory (`xml`, `csv`); the default export is the repo-root grammar, or — in a
 * repo without one, like markdown — the unit named after the package. */
function unitForProp(units, prop, pkgName) {
  if (prop) return units.find((u) => basename(u.rel) === prop) ?? null;
  const base = pkgName.split("/").pop();
  return units.find((u) => u.rel === ".") ?? units.find((u) => basename(u.rel) === base) ?? (units.length === 1 ? units[0] : null);
}

/**
 * Load a binding with graft's tree-sitter runtime, in a child process, and set each
 * grammar graft uses from it as a parser's language. A child because a bad native
 * module can crash the process that loads it, and on Windows a loaded `.node` stays
 * locked for as long as that process lives — the next rebuild could not replace it.
 * Returns `{ results: [{ prop, loads, error }] }`, or `{ crashed }` / `{ loadError }`.
 */
function probeBinding(nodeFile, props) {
  const probe = `
    const [nodeFile, runtimeDir, propsJson] = process.argv.slice(1);
    let mod, Parser;
    try { mod = require(nodeFile); } catch (e) { console.log(JSON.stringify({ loadError: e.message })); process.exit(0); }
    try { Parser = require(runtimeDir); } catch (e) { console.log(JSON.stringify({ runtimeError: e.message })); process.exit(0); }
    const results = JSON.parse(propsJson).map((prop) => {
      const lang = prop ? mod[prop] : (mod.default ?? mod);
      if (!lang) return { prop, loads: false, error: "binding exports no " + (prop ? "'" + prop + "' grammar" : "grammar") };
      try { const p = new Parser(); p.setLanguage(lang); p.parse(""); return { prop, loads: true }; }
      catch (e) { return { prop, loads: false, error: e.message }; }
    });
    console.log(JSON.stringify({ results }));
  `;
  const r = spawnSync(process.execPath, ["-e", probe, nodeFile, RUNTIME_DIR, JSON.stringify(props)], { encoding: "utf8", timeout: 60_000 });
  const line = `${r.stdout ?? ""}`.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return { crashed: `${r.stderr ?? ""}`.trim().split("\n").pop() || `exit ${r.status ?? r.signal}` };
  }
}

/**
 * Check that every grammar graft uses from this binding matches graft's parser ABI.
 * Two independent signals, because neither suffices alone:
 *   - the ABI the parser was generated at (`LANGUAGE_VERSION` in the parser.c that was
 *     compiled) against the range in the runtime's own headers — this names the cause;
 *   - actually loading it with graft's runtime — the ground truth. The runtime gives no
 *     usable error for a bad ABI ("Cannot read properties of undefined (reading
 *     'length')"), hence the first signal for the message.
 * Returns a list of error strings (empty = compatible).
 */
function checkAbi(name, dir, pkgName, nodeFile) {
  const errors = [];
  const units = grammarUnits(dir);
  const props = graftGrammarProps(pkgName);
  for (const prop of props) {
    const unit = unitForProp(units, prop, pkgName);
    const abi = unit ? parserAbi(join(unit.dir, "src", "parser.c")) : null;
    if (abi !== null && (abi < ABI_RANGE.min || abi > ABI_RANGE.max)) {
      const label = prop ? `${name} (${prop})` : name;
      errors.push(
        `${label}: parser ABI ${abi} does not match graft's tree-sitter runtime (loads ABI ${abiRangeText}) — ` +
          `${relative(repoRoot, join(unit.dir, "src", "parser.c"))} was generated with a newer tree-sitter CLI; ` +
          `regenerate it with \`tree-sitter generate --abi ${ABI_RANGE.max}\` (or \`node scripts/build-grammars.mjs --generate\`)`,
      );
    }
  }
  if (!ABI_RANGE.known) return errors; // runtime not installed: nothing to load against
  const probe = probeBinding(nodeFile, props);
  if (probe.crashed) {
    errors.push(`${name}: loading ${relative(repoRoot, nodeFile)} with graft's tree-sitter runtime crashed (${probe.crashed})`);
  } else if (probe.loadError) {
    errors.push(`${name}: ${relative(repoRoot, nodeFile)} cannot be loaded by node (${probe.loadError})`);
  } else if (probe.results) {
    for (const r of probe.results) {
      if (r.loads) continue;
      const label = r.prop ? `${name} (${r.prop})` : name;
      // Already explained by the ABI check above: don't report the runtime's opaque error twice.
      if (errors.some((e) => e.startsWith(`${label}: parser ABI`))) continue;
      // The runtime's own message for an out-of-range ABI is a null-pointer TypeError;
      // name the likely cause instead of passing that through alone.
      const likelyAbi = /reading 'length'|Incompatible language version/.test(r.error ?? "");
      errors.push(
        `${label}: graft's tree-sitter runtime (ABI ${abiRangeText}) rejects the built grammar` +
          (likelyAbi ? ` — ABI mismatch: the binding was compiled from a parser outside ${abiRangeText}` : "") +
          ` (${r.error}); rebuild it from a parser.c generated with \`--abi ${ABI_RANGE.max}\``,
      );
    }
  }
  return errors;
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

const tally = { generated: 0, built: 0, packed: 0, current: 0, skipped: 0, abiMismatch: 0 };
/** Grammar repos not present on this machine: warned, never a failure (not even --strict). */
const missing = [];
const failures = [];
/** Unavailable tooling/deps: reported, previous build kept, exit code stays 0. */
const warnings = [];
/** Informational: upstream commits not pulled, missing links graft works around. */
const notices = [];
const stamps = readStamps();

for (const { name, dir } of targets) {
  // Not an error: a checkout without the sibling grammar repos is a normal state, and
  // the affected languages simply stay unclaimed at runtime (or come from a vendor/
  // copy built elsewhere). Same for a directory that exists but is not a grammar
  // checkout (an empty folder, a half-finished clone). Warned, so it is visible, but it
  // never fails the build.
  let absent;
  try {
    absent = !existsSync(dir)
      ? "not present"
      : !statSync(dir).isDirectory()
        ? "not a directory"
        : !existsSync(join(dir, "package.json"))
          ? "no package.json — not a grammar checkout"
          : null;
  } catch (err) {
    absent = `not accessible (${err.code ?? err.message})`;
  }
  if (absent) {
    // Listed once, in the warning block at the end — not also line by line here.
    missing.push({ name, dir, absent });
    tally.skipped++;
    continue;
  }

  // Upstream first: a pull changes everything below.
  checkUpstream(name, dir);
  // Leftovers of earlier runs: delete what nothing holds any more, and move the old
  // in-repo holding pen out of build/ so the next `node-gyp rebuild` can clean it.
  sweepQuarantine(quarantineDir(dir));
  migrateLegacyQuarantine(dir);

  let meta;
  try {
    meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch (err) {
    failures.push(`${name}: unreadable package.json — ${err.message}`);
    continue;
  }
  checkGraftLink(name, dir);
  // Before generate and build: both run tools out of the grammar's node_modules.
  const depsError = syncDependencies(name, dir, meta);
  // The tarball is named after the package's OWN name, which is not always the
  // dependency key graft uses: the groovy grammar publishes as @bootswithdefer/…
  const pkgName = meta.name ?? name;
  const version = meta.version ?? "0.0.0";
  const tarballBase = `${pkgName.replace(/^@/, "").replace(/\//g, "-")}-`;
  const tarball = join(vendorDir, `${tarballBase}${version}.tgz`);

  // Generate first: it rewrites src/, which the build hash below must see.
  const entry = (stamps[pkgName] = { ...stampFor(stamps, pkgName, dir) });
  const gen = regenerate(name, dir, entry);
  tally.generated += gen.generated;
  if (gen.failed) continue; // reported; building the stale src/ would hide it
  if (gen.pending) continue; // warned; keep the previous binding, retry next run

  const hash = grammarHashes(dir);
  const stamp = entry;
  let nodeFile = prebuiltNode(dir);
  let didBuild = false;

  const needsBuild = force || !nodeFile || stamp.build !== hash.build;
  const why = !nodeFile ? "never built" : force ? "forced" : gen.generated ? "parser regenerated" : "sources changed";
  const blocker = needsBuild ? (buildBlocker(dir, meta.scripts ?? {}) ?? depsError) : null;
  if (!needsBuild) removeShadowingBuilds(name, dir, nodeFile);
  if (blocker) {
    // Keep whatever binding exists; the build hash stays unrecorded so the next run
    // retries once the dependencies are installed.
    warnings.push(`${name}: not rebuilt (${why}) — ${blocker}`);
    // Not packed either: a tarball pairing new sources with the old binding would
    // ship a parser that does not match its own src/.
    if (nodeFile) log(`  ${name}: keeping the previous binding (${blocker})`);
    continue;
  }

  if (needsBuild) {
    log(`  ${name}: building (${why}) …`);
    const previousName = nodeFile ? basename(nodeFile) : null;
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
      nodeFile = compiled ? installPrebuild(dir, pkgName, compiled) : settlePrebuild(dir, previousName);
    } catch (err) {
      failures.push(`${name}: could not install prebuild — ${err.message}`);
      continue;
    }
    if (!nodeFile || (!built.ok && !compiled && statSync(nodeFile).mtimeMs < startedAt)) {
      // A failed compile that left only the old binding behind: report the real error,
      // not the "file is locked" guess below.
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
    entry.build = hash.build;
    removeShadowingBuilds(name, dir, nodeFile);
  }

  // ABI gate, on every run — for a fresh build and for one kept from before (a pull can
  // bring in a parser.c generated at a newer ABI). A mismatch is an error: graft would
  // silently lose the language. The binding is left in place (recompiling would only
  // reproduce it) but not packed, and the build stops before build:vendor stages it.
  const abiErrors = checkAbi(name, dir, pkgName, nodeFile);
  if (abiErrors.length > 0) {
    failures.push(...abiErrors);
    tally.abiMismatch++;
    continue;
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

  // Re-pack when the binding is newer than the tarball, or when any other local file
  // (queries, tree-sitter.json, docs, …) changed since the last pack.
  const fresh =
    existsSync(tarball) &&
    statSync(tarball).mtimeMs >= statSync(nodeFile).mtimeMs &&
    stamp.pack === hash.pack;
  if (force || !fresh) {
    const why = !existsSync(tarball)
      ? "no tarball"
      : didBuild || statSync(tarball).mtimeMs < statSync(nodeFile).mtimeMs
        ? "binding rebuilt"
        : force
          ? "forced"
          : "local files changed";
    log(`  ${name}: packing (${why}) …`);
    const result = run("npm", ["pack", "--pack-destination", vendorDir], dir);
    if (!result.ok) {
      failures.push(`${name}: npm pack failed — ${result.message}`);
      continue;
    }
    if (!existsSync(tarball)) {
      failures.push(`${name}: npm pack produced no ${tarball}`);
      continue;
    }
    entry.build = hash.build; // this run's build, or the (migrated) one that was current
    entry.pack = hash.pack;
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

const summary =
  `grammars: ${tally.generated} generated, ${tally.built} built, ${tally.packed} packed, ` +
  `${tally.current} up to date, ${tally.skipped} skipped`;

if (notices.length > 0) {
  console.log(`\nℹ ${notices.length} note(s):`);
  for (const n of notices) console.log(`  ${n}`);
}

// Missing grammar repos: a warning, always, even under --quiet and --strict — a machine
// with only graft on it must build. The languages fall back to a vendor/ copy if one
// was built earlier, else stay unclaimed (their files go through the breadth tier).
if (missing.length > 0) {
  const all = missing.length === targets.length;
  console.warn(
    `\n⚠ ${all ? "none of the" : `${missing.length} of ${targets.length}`} local tree-sitter grammar repos ` +
      `${all ? "are" : "are not"} available — ${all ? "skipped" : "skipped those"}, the build continues:`,
  );
  for (const m of missing) {
    const fallback = existsSync(join(vendorDir, graftKeyFor(m.name) ?? "\0")) ? "graft uses its vendor/ copy" : "language unavailable in graft";
    console.warn(`  ${m.name}: ${m.dir} ${m.absent} (${fallback})`);
  }
  console.warn(`  Clone them next to graft (${relative(repoRoot, dirname(missing[0].dir)) || "."}) to build them.\n`);
}

// Warnings go out even under --quiet: each one means a local change did NOT reach graft.
if (warnings.length > 0) {
  console.warn(`\n⚠ ${warnings.length} grammar(s) kept their previous build:`);
  for (const w of warnings) console.warn(`  ${w}`);
  console.warn("");
}

if (failures.length > 0 || (strict && warnings.length > 0)) {
  console.error(`\n✗ ${summary}, ${failures.length} failed${strict && warnings.length ? `, ${warnings.length} warned (--strict)` : ""}`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  const hints = ["  Native grammar builds need the MSVC C++ toolchain and Python on PATH."];
  if (tally.abiMismatch > 0) {
    hints.push(
      `  ABI mismatch: graft's tree-sitter runtime loads parser ABI ${abiRangeText} only. A grammar outside`,
      "  that range builds fine but graft cannot load it, so the build stops here instead of",
      "  shipping it. Regenerate the listed parser(s) at a supported ABI, then rebuild.",
    );
  }
  hints.push(
    "  A failed `tree-sitter generate` is an error in that grammar.js; fix it, or build",
    "  from the committed src/ with: node scripts/build-grammars.mjs --no-generate",
    "  To carry on without the grammars, run the TypeScript build alone: npm run build:ts",
  );
  console.error(`\n${hints.join("\n")}\n`);
  process.exit(1);
}

// Always printed, even under --quiet: this one line is the script's whole report to
// whoever ran `npm run build`.
const extra = [warnings.length && `${warnings.length} warned`, missing.length && `${missing.length} missing`].filter(Boolean);
console.log(`✓ ${summary}${extra.length ? `, ${extra.join(", ")}` : ""}`);
