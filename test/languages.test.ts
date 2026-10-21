/**
 * `graft languages`: the table has to agree with what a build really does — every
 * extension it lists must be one a parser claims, and a native grammar that will not
 * load must show the level the build falls back to, not the one it would get.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { formatLanguageSupport, languageSupport, SUPPORT_LEVELS } from "../src/graph/languages.js";
import { supportedExtensions } from "../src/graph/source-files.js";
import { realNativeRequire, setNativeRequireForTest } from "../src/graph/native.js";
import { runCli } from "./helpers.js";

afterEach(() => setNativeRequireForTest(null));

const byName = (name: string) => languageSupport().find((r) => r.name === name);

test("every extension a parser claims is listed exactly once, and nothing else is", () => {
  const rows = languageSupport();
  const listed = rows.filter((r) => r.level !== "skipped").flatMap((r) => r.extensions);
  assert.equal(new Set(listed).size, listed.length, `an extension is listed twice: ${listed.join(" ")}`);
  assert.deepEqual([...listed].sort(), supportedExtensions());
  for (const r of rows) assert.ok(SUPPORT_LEVELS.includes(r.level), `${r.name}: ${r.level}`);
});

test("levels follow the tiers: hand-written, generic tags, walker-only, containers", () => {
  for (const name of ["TypeScript", "JavaScript", "Python", "Go", "Java", "Kotlin", "Swift", "PHP", "R"]) {
    const r = byName(name);
    assert.equal(r?.level, "full", name);
    assert.equal(r?.tier, "depth", name);
    assert.ok(r?.features.symbols && r.features.calls && r.features.imports, name);
  }
  assert.equal(byName("Go")?.features.inherits, false, "Go has no inheritance to extract");
  assert.equal(byName("Python")?.features.types, true);
  assert.equal(byName("Kotlin")?.features.types, false, "no receiver-binding pass for Kotlin");

  for (const name of ["Rust", "Ruby", "Scala", "Elixir", "Lua"]) {
    assert.equal(byName(name)?.level, "broad", name);
    assert.equal(byName(name)?.features.calls, true, name);
  }
  assert.equal(byName("Rust")?.features.imports, true, "Rust `use crate::…` is an import edge");
  assert.equal(byName("Rust")?.lsp, "rust-analyzer");
  for (const name of ["OCaml", "Zig"]) {
    assert.equal(byName(name)?.level, "symbols", name);
    assert.equal(byName(name)?.features.calls, false, name);
  }

  const vue = byName("Vue");
  assert.equal(vue?.tier, "container");
  assert.equal(vue?.level, byName("TypeScript")?.level, "a .vue script block gets TypeScript's extraction");
});

test("a native grammar that won't load shows the stand-in's level and the fix", () => {
  setNativeRequireForTest((id) => {
    if (id === "tree-sitter-kotlin") throw new Error("No native build was found");
    return realNativeRequire(id);
  });
  const kotlin = languageSupport("@nanonets/graft").find((r) => r.name === "Kotlin");
  assert.equal(kotlin?.level, "broad", "the WASM stand-in still captures calls");
  assert.equal(kotlin?.tier, "breadth");
  assert.equal(kotlin?.features.inherits, false);
  assert.match(kotlin?.note ?? "", /native parser missing/);
  assert.match(kotlin?.note ?? "", /--allow-scripts=tree-sitter-kotlin @nanonets\/graft$/);
  assert.equal(languageSupport().find((r) => r.name === "Java")?.level, "full", "only Kotlin falls back");
});

test("the table names every language, level and column", () => {
  const rows = languageSupport();
  const text = formatLanguageSupport(rows, "graft");
  for (const r of rows) assert.match(text, new RegExp(`^  ${r.name.replace(/[+#/]/g, "\\$&")}\\s+${r.level}\\b`, "m"), r.name);
  for (const level of SUPPORT_LEVELS) assert.match(text, new RegExp(`^  ${level}\\s+\\S`, "m"), level);
  assert.match(text, /^Columns/m);
  assert.match(text, /graft build -e <ext>/);
});

test("graft languages prints the table; --json the rows; both listed in --help", () => {
  const r = runCli(["languages"]);
  assert.equal(r.status, 0, r.describe());
  assert.match(r.stdout, /^Languages graft indexes/);
  assert.match(r.stdout, /^ {2}TypeScript\s+full\s/m);

  const json = runCli(["languages", "--json"]);
  assert.equal(json.status, 0, json.describe());
  const rows = JSON.parse(json.stdout) as { name: string; level: string }[];
  assert.ok(rows.some((x) => x.name === "Rust" && x.level === "broad"));

  const help = runCli(["--help"]);
  assert.match(help.stdout, /^ {2}languages \[options\]$/m);
  assert.match(runCli(["languages", "--help"]).stdout, /^ {2}graft languages \[options\]\n/);
});
