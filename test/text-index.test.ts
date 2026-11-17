/**
 * Opt-in plain-text indexing (graph/text.ts): `.txt` files cut into line chunks,
 * each a node with its own span, only when the repo sets `indexText`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listContextFiles } from "../src/context/build.js";
import { symbolsIn } from "../src/notes/edit-overlap.js";
import { ignoredCode } from "../src/search/ignored-code.js";
import { inTextScope, isPlainTextPath, normalizeTextDir, setExtraTextExtensions } from "../src/util/plain-text.js";
import { partConfig } from "../src/graph/parts-build.js";
import { addDirEntries, indexTextDirProblem, indexTextExtensionProblem, normalizeDirEntry, removeDirEntries } from "../src/config-cli.js";
import { sliceSpan } from "../src/ask/ask.js";
import { buildGraph } from "../src/graph/build.js";
import { languageOf, extractFile } from "../src/graph/extract.js";
import { chunkText, headingAt, MAX_TEXT_CHUNKS, TEXT_CHUNK_CHARS, textFileLoad } from "../src/graph/text.js";
import { claimedByParser, listSourceFiles, useTextExtensions } from "../src/graph/source-files.js";
import { MAX_FILE_BYTES, MAX_TEXT_FILE_BYTES, tooBigToIndex } from "../src/ingest/fs.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { decodeSource } from "../src/util/source.js";
import { patchBuildConfig, readBuildConfig, readTextScope, textExtensionsOf } from "../src/util/state.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";
import { runCli, tmpRepo } from "./helpers.js";

function write(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

function optIn(root: string, on: boolean): void {
  write(root, ".graft/config.json", JSON.stringify({ indexText: on }));
}

function graphOf(root: string): GraphV1 {
  const g = readGraph(wiringPath(join(root, "graft")));
  assert.ok(g, `expected a graph for ${root}`);
  return g;
}

/** A paragraph of `n` lines, each mentioning `word` once. */
function para(word: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `Line ${i} of the ${word} paragraph, with some filler text to give it weight.`).join("\n");
}

test("languageOf claims .txt as text, but CMakeLists.txt is never text", () => {
  assert.equal(languageOf("docs/notes.txt"), "text");
  assert.equal(languageOf("docs/NOTES.TXT"), "text");
  assert.notEqual(languageOf("src/CMakeLists.txt"), "text");
  assert.notEqual(languageOf("CMakeLists.txt"), "text");
});

test("headingAt recognises underlined, overlined, hash, numbered and ALL-CAPS titles", () => {
  const lines = [
    "Introduction", // 0: underlined
    "============",
    "",
    "Some prose that is not a heading.",
    "",
    "2.1 Scope of work", // 5: numbered after a blank line
    "",
    "# Hash title", // 7
    "",
    "GENERAL REQUIREMENTS", // 9: caps after a blank line
    "",
    "1. Install the package.", // 11: list item, ends like a sentence
    "",
    "=====", // 13: overline
    "Overlined",
    "=====",
    "text right after",
    "",
    "Last line of a paragraph", // 18: a short separator under it is not an underline
    "---",
  ];
  assert.equal(headingAt(lines, 0), "Introduction");
  assert.equal(headingAt(lines, 1), null, "the underline itself is not a heading");
  assert.equal(headingAt(lines, 3), null);
  assert.equal(headingAt(lines, 5), "2.1 Scope of work");
  assert.equal(headingAt(lines, 7), "Hash title");
  assert.equal(headingAt(lines, 9), "GENERAL REQUIREMENTS");
  assert.equal(headingAt(lines, 11), null);
  assert.equal(headingAt(lines, 13), "Overlined");
  assert.equal(headingAt(lines, 14), null, "an overlined title starts at its overline");
  assert.equal(headingAt(lines, 18), null);
});

test("chunkText tiles the file, cuts at headings, and merges sections that are too small", () => {
  const text = [
    "Alpha",
    "=====",
    para("alpha", 40),
    "",
    "Tiny",
    "====",
    "one line",
    "",
    "Beta",
    "====",
    para("beta", 40),
  ].join("\n");
  const lines = text.split("\n");
  const chunks = chunkText(lines);
  // Tiles: contiguous, no gaps or overlaps, covering every line.
  assert.equal(chunks[0].first, 0);
  assert.equal(chunks.at(-1)!.last, lines.length - 1);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].first, chunks[i - 1].last + 1);
  // "Tiny" is below a quarter of the target, so no cut is made at "Beta": the
  // small section and the one after it share a chunk.
  assert.deepEqual(chunks.map((c) => c.heading), ["Alpha", "Tiny"]);
  assert.ok(lines.slice(chunks[1].first, chunks[1].last + 1).includes("Beta"));
});

test("chunkText cuts a long headingless text at paragraph breaks near the target size", () => {
  const paras = Array.from({ length: 30 }, (_, i) => para(`p${i}`, 8));
  const lines = paras.join("\n\n").split("\n");
  const chunks = chunkText(lines);
  assert.ok(chunks.length > 3);
  for (const c of chunks.slice(0, -1)) {
    // Each cut lands just after a blank line (a paragraph break).
    assert.equal(lines[c.last].trim(), "", `chunk ending at line ${c.last + 1} should end on a paragraph break`);
    const size = lines.slice(c.first, c.last + 1).join("\n").length;
    assert.ok(size <= TEXT_CHUNK_CHARS + 200, `chunk of ${size} chars stays near the target`);
  }
});

test("chunkText never yields more than MAX_TEXT_CHUNKS chunks", () => {
  // Short lines, a heading every few lines: the worst case for the count.
  const lines: string[] = [];
  for (let i = 0; i < 40_000; i++) lines.push("", `SECTION ${i}`, "a", "b");
  const chunks = chunkText(lines);
  assert.ok(chunks.length <= MAX_TEXT_CHUNKS, `${chunks.length} chunks`);
  assert.equal(chunks.at(-1)!.last, lines.length - 1);
});

test("extractText: one node per chunk with spans, all excluded from --deep", () => {
  const source = ["Overview", "========", para("overview", 30), "", "Details", "=======", para("details", 30), ""].join("\r\n");
  const { nodes, rawEdges } = extractFile("docs/spec.txt", source, "text");
  assert.equal(nodes[0].kind, "file");
  const chunks = nodes.slice(1);
  assert.deepEqual(chunks.map((n) => n.name), ["Overview", "Details"]);
  assert.deepEqual(chunks.map((n) => n.kind), ["heading", "heading"]);
  assert.equal(chunks[0].span, "L1-L32");
  assert.equal(chunks[1].span, "L34-L65", "the blank line between them belongs to no span");
  assert.ok(chunks[1].body_text!.includes("details paragraph"));
  assert.ok(nodes.every((n) => n.summary_state === "none"), "text never goes to the LLM pass");
  assert.equal(rawEdges.length, chunks.length);
  assert.ok(rawEdges.every((e) => e.relation === "contains" && e.source === "docs/spec.txt"));
});

test("text files get their own size limit, and binary .txt files are skipped", () => {
  assert.equal(tooBigToIndex("big.txt", MAX_FILE_BYTES + 1), false);
  assert.equal(tooBigToIndex("big.txt", MAX_TEXT_FILE_BYTES + 1), true);
  assert.equal(tooBigToIndex("CMakeLists.txt", MAX_FILE_BYTES + 1), true, "CMake keeps the code limit");
  assert.equal(decodeSource("data.txt", Buffer.from([0x41, 0x00, 0x42])), null);
  assert.equal(decodeSource("data.txt", Buffer.from("plain\n")), "plain\n");
});

test("build: .txt is indexed only when indexText is on, and leaves again when it is turned off", async () => {
  const root = tmpRepo("text-index");
  try {
    write(root, "src/app.ts", "export function app(): number { return 1; }\n");
    write(root, "docs/manual.txt", ["Installation", "============", para("install", 50), "", "Troubleshooting", "===============", para("troubleshooting", 50)].join("\n"));
    write(root, "requirements.txt", "requests==2.0\n");

    await buildGraph(root);
    const off = graphOf(root);
    assert.ok(!off.nodes.some((n) => n.path.endsWith(".txt")), "no .txt file without the opt-in");

    optIn(root, true);
    assert.ok(listSourceFiles(root, join(root, "graft")).some((f) => f.endsWith("manual.txt")));
    await buildGraph(root);
    const on = graphOf(root);
    const manual = on.nodes.filter((n: NodeV1) => n.path === "docs/manual.txt");
    assert.ok(manual.some((n) => n.kind === "file"));
    const trouble = manual.find((n) => n.name === "Troubleshooting");
    assert.ok(trouble, "the heading chunk is a node");
    assert.match(trouble!.span, /^L\d+-L\d+$/);
    assert.ok(on.nodes.some((n) => n.path === "src/app.ts"), "code is still indexed");
    const card = join(root, "graft", "docs", "manual.md");
    assert.ok(existsSync(card));
    assert.match(readFileSync(card, "utf8"), /Troubleshooting · heading · L\d+-L\d+/);

    optIn(root, false);
    await buildGraph(root);
    assert.ok(!graphOf(root).nodes.some((n) => n.path.endsWith(".txt")), "turning it off drops the text nodes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a text file with many chunks gets a table of contents on its card", async () => {
  const root = tmpRepo("text-toc");
  try {
    optIn(root, true);
    const sections = Array.from({ length: 120 }, (_, i) => [`Section ${i} title`, "=================", para(`s${i}`, 20)].join("\n"));
    write(root, "big.txt", sections.join("\n\n"));
    await buildGraph(root);
    const chunks = graphOf(root).nodes.filter((n) => n.path === "big.txt" && n.kind !== "file");
    assert.ok(chunks.length > 60, `${chunks.length} chunks`);
    const card = readFileSync(join(root, "graft", "big.md"), "utf8");
    assert.match(card, /Table of contents: \d+ chunks in all/);
    const listed = card.split("\n").filter((l) => l.startsWith("- "));
    assert.ok(listed.length <= 60, `${listed.length} entries listed`);
    assert.ok(listed.length > 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a sampled table of contents says which entries it lists in words, not a broken ordinal", async () => {
  const root = tmpRepo("text-toc-words");
  try {
    optIn(root, true);
    const sections = Array.from({ length: 130 }, (_, i) => [`Part ${i} title`, "==============", para(`q${i}`, 20)].join("\n"));
    write(root, "long.txt", sections.join("\n\n"));
    await buildGraph(root);
    const card = readFileSync(join(root, "graft", "long.md"), "utf8");
    assert.match(card, /listed below is one in every \d+ of them/);
    assert.doesNotMatch(card, /every \d+th/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isPlainTextPath: .txt in any case, never CMakeLists.txt", () => {
  assert.ok(isPlainTextPath("docs/a.txt"));
  assert.ok(isPlainTextPath("A.TXT"));
  assert.ok(isPlainTextPath("C:\\work\\notes.txt"));
  assert.ok(!isPlainTextPath("src/CMakeLists.txt"));
  assert.ok(!isPlainTextPath("src\\cmakelists.TXT"));
  assert.ok(!isPlainTextPath("readme.md"));
  assert.ok(isPlainTextPath("mycmakelists.txt"), "only the exact CMake file name is excluded");
});

test("text files never reach --deep, even named by -e .txt", () => {
  const root = tmpRepo("text-deep");
  try {
    optIn(root, true);
    write(root, "src/app.ts", "export const a = 1;\n");
    write(root, "docs/manual.txt", "Manual\n======\ntext\n");
    const files = listContextFiles(root, join(root, "graft"), [".ts", ".txt"]).map((f) => f.replace(/\\/g, "/"));
    assert.ok(files.some((f) => f.endsWith("src/app.ts")));
    assert.ok(!files.some((f) => f.endsWith(".txt")), files.join(", "));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit-overlap finds no symbols in a text file", async () => {
  const source = ["Overview", "========", para("overview", 30), "", "Details", "=======", para("details", 30)].join("\n");
  assert.deepEqual(await symbolsIn("docs/spec.txt", source), []);
});

test("git-ignored .txt files count as left-out code only when the repo opted in", () => {
  const root = tmpRepo("text-ignored");
  try {
    const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (git("init", "-q").status !== 0) return; // no git on this machine: nothing to check
    write(root, ".gitignore", "logs/\n");
    write(root, "logs/run.txt", "a log line\n");
    write(root, "src/app.ts", "export const a = 1;\n");
    assert.deepEqual(ignoredCode(root), [], "logs are not code while indexText is off");
    optIn(root, true);
    assert.deepEqual(ignoredCode(root), ["logs/"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("indexTextDirs limits text to its folders, and code stays indexed everywhere", async () => {
  const root = tmpRepo("text-dirs");
  try {
    write(root, "src/app.ts", "export function app(): number { return 1; }\n");
    write(root, "src/fixture.txt", "Fixture\n=======\nnot wanted\n");
    write(root, "requirements.txt", "requests==2.0\n");
    write(root, "docs/specs/brake.txt", "Brake spec\n==========\nwanted\n");
    write(root, "docs/specs/deep/abs.txt", "ABS spec\n========\nwanted too\n");
    write(root, "docs/specsheet.txt", "Specsheet\n=========\na sibling with the same prefix, not wanted\n");
    write(root, ".graft/config.json", JSON.stringify({ indexText: true, indexTextDirs: ["docs/specs"] }));

    const listed = listSourceFiles(root, join(root, "graft")).map((f) => f.replace(/\\/g, "/"));
    assert.ok(listed.some((f) => f.endsWith("docs/specs/brake.txt")));
    assert.ok(listed.some((f) => f.endsWith("docs/specs/deep/abs.txt")), "a folder covers its subtree");
    assert.ok(!listed.some((f) => f.endsWith("docs/specsheet.txt")), "a name prefix is not a folder");
    assert.ok(!listed.some((f) => f.endsWith("src/fixture.txt")));
    assert.ok(!listed.some((f) => f.endsWith("/requirements.txt")));
    assert.ok(listed.some((f) => f.endsWith("src/app.ts")), "code is indexed outside the text folders");

    await buildGraph(root);
    const paths = new Set(graphOf(root).nodes.map((n) => n.path));
    assert.ok(paths.has("docs/specs/brake.txt") && paths.has("src/app.ts"));
    assert.ok(!paths.has("src/fixture.txt"));

    // The folders do nothing while indexText is off.
    write(root, ".graft/config.json", JSON.stringify({ indexText: false, indexTextDirs: ["docs/specs"] }));
    assert.ok(!listSourceFiles(root, join(root, "graft")).some((f) => f.endsWith(".txt")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inTextScope: empty = everywhere, else the folders and their subtrees", () => {
  assert.ok(inTextScope("a/b.txt", []));
  assert.ok(inTextScope("docs/x.txt", ["docs"]));
  assert.ok(inTextScope("docs/a/b/x.txt", ["logs", "docs"]));
  assert.ok(!inTextScope("docsx/x.txt", ["docs"]));
  assert.ok(!inTextScope("src/docs/x.txt", ["docs"]), "a path from the repo root, not a name at any depth");
});

test("graft config index-text-dirs add turns text on for those folders; show, remove and clear explain the scope", () => {
  const root = tmpRepo("text-dirs-cli");
  try {
    write(root, "docs/specs/a.txt", "A\n=\ntext\n");
    write(root, ".graft/config.json", "{}");
    const added = runCli(["config", "index-text-dirs", "add", "docs\\specs\\", "./logs", "--repo", root]);
    assert.equal(added.status, 0, added.describe());
    assert.match(added.stdout, /added docs\/specs {2}— folder, with its subtree/);
    assert.match(added.stdout, /added logs {2}— no such folder/);
    assert.match(added.stdout, /indexText: on/);
    const cfg = readBuildConfig(root);
    assert.equal(cfg?.indexText, true);
    assert.deepEqual(cfg?.indexTextDirs, ["docs/specs", "logs"]);

    const shown = runCli(["config", "index-text", "--repo", root]);
    assert.match(shown.stdout, /^indexText: on$/m);
    assert.match(shown.stdout, /only under: docs\/specs, logs/);

    const listed = runCli(["config", "list", "--repo", root]);
    assert.match(listed.stdout, /indexTextDirs: 2 entries/);

    const bad = runCli(["config", "index-text-dirs", "add", "../outside", "--repo", root]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /must be inside the repo/);

    const cleared = runCli(["config", "index-text-dirs", "clear", "--repo", root]);
    assert.equal(cleared.status, 0, cleared.describe());
    assert.match(cleared.stdout, /every \.txt file in the repository is indexed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graft build --index-text-dir persists the folders and turns text on; it refuses --no-index-text", () => {
  const root = tmpRepo("text-dirs-build");
  try {
    write(root, "notes/a.txt", "Wanted\n======\ntext\n");
    write(root, "other/b.txt", "Unwanted\n========\ntext\n");
    write(root, ".graft/config.json", "{}");
    const built = runCli(["build", root, "--index-text-dir", "notes"]);
    assert.equal(built.status, 0, built.describe());
    assert.equal(readBuildConfig(root)?.indexText, true);
    assert.deepEqual(readBuildConfig(root)?.indexTextDirs, ["notes"]);
    const paths = new Set(graphOf(root).nodes.map((n) => n.path));
    assert.ok(paths.has("notes/a.txt"));
    assert.ok(!paths.has("other/b.txt"));

    const clash = runCli(["build", root, "--index-text-dir", "notes", "--no-index-text"]);
    assert.notEqual(clash.status, 0);
    assert.match(clash.stderr, /cannot go with --no-index-text/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partConfig re-roots the text folders at each part", () => {
  const cfg = { indexText: true, indexTextDirs: ["Src/A/docs", "Src/B"] };
  assert.deepEqual(partConfig(cfg, "Src/A"), { indexText: true, indexTextDirs: ["docs"] });
  assert.deepEqual(partConfig(cfg, "Src/B"), { indexText: true, indexTextDirs: [] }, "a folder holding the part: all of it");
  assert.deepEqual(partConfig(cfg, "Src/B/x"), { indexText: true, indexTextDirs: [] });
  assert.deepEqual(partConfig(cfg, "Src/C"), { indexText: false, indexTextDirs: [] }, "no folder reaches it: no text there");
  assert.deepEqual(partConfig({ indexText: true }, "Src/C"), { indexText: true, indexTextDirs: [] });
  assert.deepEqual(partConfig({ indexText: true, indexTextDirs: ["Src\\A\\docs\\", "./Src/A/./logs"] }, "Src/A"), {
    indexText: true,
    indexTextDirs: ["docs", "logs"],
  }, "hand-edited entries are read in their stored form");
  assert.deepEqual(partConfig({ excludeDirs: ["x"] }, "Src/A"), { excludeDirs: ["x"] }, "no text keys, none written");
});

test("a part's text scope follows the root when the root list is cleared or widened", () => {
  const root = tmpRepo("text-dirs-parts-stale");
  try {
    write(root, "Src/A/.graft/config.json", JSON.stringify({ indexText: true, indexTextDirs: ["docs"] }));
    // The root list emptied: the part's saved ["docs"] must go, not narrow it forever.
    patchBuildConfig(join(root, "Src/A"), partConfig({ indexText: true, indexTextDirs: [] }, "Src/A"));
    assert.deepEqual(readTextScope(join(root, "Src/A")), { on: true, dirs: [], exts: [] });
    // A part first out of reach (text off), then reached again by an unscoped root.
    patchBuildConfig(join(root, "Src/A"), partConfig({ indexText: true, indexTextDirs: ["Src/B"] }, "Src/A"));
    assert.equal(readTextScope(join(root, "Src/A")).on, false);
    patchBuildConfig(join(root, "Src/A"), partConfig({ indexText: true }, "Src/A"));
    assert.deepEqual(readTextScope(join(root, "Src/A")), { on: true, dirs: [], exts: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("text folders: '.' is refused, and hand-edited entries scope a build like normalized ones", () => {
  assert.match(indexTextDirProblem(".") ?? "", /leave index-text-dirs empty/);
  assert.match(indexTextDirProblem("./") ?? "", /leave index-text-dirs empty/);
  assert.match(indexTextDirProblem("/abs") ?? "", /absolute/);
  assert.match(indexTextDirProblem("C:\\abs") ?? "", /absolute/);
  assert.match(indexTextDirProblem("docs/../x") ?? "", /inside the repo/);
  assert.equal(indexTextDirProblem("docs/./specs"), null);
  assert.equal(normalizeDirEntry("indexTextDirs", " .\\docs\\.\\specs\\ "), "docs/specs");
  assert.equal(normalizeTextDir("docs//specs/"), "docs/specs");
  assert.equal(normalizeTextDir("."), "");

  const root = tmpRepo("text-dirs-hand");
  try {
    write(root, "docs/specs/a.txt", "A\n=\ntext\n");
    write(root, "other/b.txt", "B\n=\ntext\n");
    write(root, ".graft/config.json", JSON.stringify({ indexText: true, indexTextDirs: ["docs\\specs\\", ".", ""] }));
    assert.deepEqual(readTextScope(root), { on: true, dirs: ["docs/specs"], exts: [] });
    const listed = listSourceFiles(root, join(root, "graft")).map((f) => f.replace(/\\/g, "/"));
    assert.ok(listed.some((f) => f.endsWith("docs/specs/a.txt")));
    assert.ok(!listed.some((f) => f.endsWith("other/b.txt")));

    const dot = runCli(["build", root, "--index-text-dir", "."]);
    assert.notEqual(dot.status, 0);
    assert.match(dot.stderr, /--index-text-dir "\.": expected a folder path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("textFileLoad: a text file weighs about one file per chunk, capped", () => {
  assert.equal(textFileLoad(0), 1);
  assert.equal(textFileLoad(TEXT_CHUNK_CHARS), 1);
  assert.equal(textFileLoad(TEXT_CHUNK_CHARS * 10 + 1), 11);
  assert.equal(textFileLoad(50_000_000), MAX_TEXT_CHUNKS);
});

test("git-ignored .txt files count as left-out code only inside the text folders", () => {
  const root = tmpRepo("text-ignored-dirs");
  try {
    const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (git("init", "-q").status !== 0) return;
    write(root, ".gitignore", "logs/\nspecs-out/\n");
    write(root, "logs/run.txt", "a log line\n");
    write(root, "specs-out/a.txt", "generated spec\n");
    write(root, ".graft/config.json", JSON.stringify({ indexText: true, indexTextDirs: ["specs-out"] }));
    assert.deepEqual(ignoredCode(root), ["specs-out/"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graft build --index-text persists the choice; graft config index-text reads and changes it", () => {
  const root = tmpRepo("text-cli");
  try {
    write(root, "notes.txt", "Hello\n=====\nworld\n");
    write(root, ".graft/config.json", "{}");
    const built = runCli(["build", root, "--index-text"]);
    assert.equal(built.status, 0, built.describe());
    assert.equal(readBuildConfig(root)?.indexText, true);
    assert.ok(graphOf(root).nodes.some((n) => n.path === "notes.txt" && n.name === "Hello"));

    const shown = runCli(["config", "index-text", "--repo", root]);
    assert.match(shown.stdout, /^indexText: on$/m);
    const set = runCli(["config", "index-text", "off", "--repo", root]);
    assert.equal(set.status, 0, set.describe());
    assert.equal(readBuildConfig(root)?.indexText, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("text extensions: normalized, refused when graft parses them, and ignored when hand-edited in", () => {
  assert.deepEqual(textExtensionsOf({ indexTextExtensions: ["LOG", "*.out", " .lst ", ".log", ".txt", "a/b", ".tar.gz", ""] }), [".log", ".out", ".lst"]);
  assert.equal(normalizeDirEntry("indexTextExtensions", "*.LOG"), ".log");
  assert.equal(indexTextExtensionProblem("log"), null);
  assert.equal(indexTextExtensionProblem(".out"), null);
  assert.match(indexTextExtensionProblem(".txt") ?? "", /plain text already/);
  assert.match(indexTextExtensionProblem(".md") ?? "", /already parses \.md/);
  assert.match(indexTextExtensionProblem(".c") ?? "", /already parses \.c/);
  assert.match(indexTextExtensionProblem(".json") ?? "", /already parses/);
  assert.match(indexTextExtensionProblem("a/b") ?? "", /one file extension/);
  assert.match(indexTextExtensionProblem(".tar.gz") ?? "", /one file extension/);
  assert.ok(claimedByParser(".cs") && claimedByParser(".xml") && !claimedByParser(".log"));
  try {
    useTextExtensions([".log", ".json", ".py"]);
    assert.equal(languageOf("run/build.LOG"), "text");
    assert.ok(isPlainTextPath("a.log"));
    assert.notEqual(languageOf("data.json"), "text", "a parsed extension never becomes text");
    assert.notEqual(languageOf("app.py"), "text");
    assert.equal(tooBigToIndex("huge.log", MAX_FILE_BYTES + 1), false, "the text size limit applies");
  } finally {
    setExtraTextExtensions([]);
  }
  assert.ok(!isPlainTextPath("a.log"), "nothing but .txt once the list is empty");
});

test("build: added extensions are indexed as text only while indexText is on, and leave when removed", async () => {
  const root = tmpRepo("text-exts");
  try {
    write(root, "src/app.ts", "export function app(): number { return 1; }\n");
    write(root, "logs/run.log", ["Startup", "=======", para("startup", 30), "", "Shutdown", "========", para("shutdown", 30)].join("\n"));
    write(root, "out/result.out", "Result\n======\nall good\n");
    write(root, "data.json", '{"a": 1}\n');
    write(root, ".graft/config.json", JSON.stringify({ indexText: true, indexTextExtensions: [".log", ".json"] }));

    await buildGraph(root);
    let g = graphOf(root);
    const log = g.nodes.filter((n) => n.path === "logs/run.log");
    assert.ok(log.some((n) => n.name === "Shutdown" && n.kind === "heading"), "a .log file is cut into chunks");
    assert.ok(!g.nodes.some((n) => n.path === "out/result.out"), "an extension not in the list stays out");
    assert.ok(!g.nodes.some((n) => n.path === "data.json" && n.kind === "heading"), "a hand-edited .json stays JSON");
    assert.ok(g.nodes.some((n) => n.path === "src/app.ts"));

    write(root, ".graft/config.json", JSON.stringify({ indexText: false, indexTextExtensions: [".log"] }));
    await buildGraph(root);
    assert.ok(!graphOf(root).nodes.some((n) => n.path === "logs/run.log"), "indexText off drops them too");

    write(root, ".graft/config.json", JSON.stringify({ indexText: true }));
    await buildGraph(root);
    g = graphOf(root);
    assert.ok(!g.nodes.some((n) => n.path === "logs/run.log"), "removed from the list: no longer indexed");
  } finally {
    setExtraTextExtensions([]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("indexTextDirs scopes the added extensions like .txt", () => {
  const root = tmpRepo("text-exts-dirs");
  try {
    write(root, "logs/a.log", "A\n=\ntext\n");
    write(root, "other/b.log", "B\n=\ntext\n");
    write(root, ".graft/config.json", JSON.stringify({ indexText: true, indexTextDirs: ["logs"], indexTextExtensions: ["log"] }));
    const listed = listSourceFiles(root, join(root, "graft")).map((f) => f.replace(/\\/g, "/"));
    assert.ok(listed.some((f) => f.endsWith("logs/a.log")));
    assert.ok(!listed.some((f) => f.endsWith("other/b.log")));
  } finally {
    setExtraTextExtensions([]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("graft config index-text add/list/remove/clear manage the extensions; on/off still work", () => {
  const root = tmpRepo("text-exts-cli");
  try {
    write(root, ".graft/config.json", "{}");
    const added = runCli(["config", "index-text", "add", "LOG", "*.out", "--repo", root]);
    assert.equal(added.status, 0, added.describe());
    assert.match(added.stdout, /added \.log/);
    assert.match(added.stdout, /indexText: on/);
    assert.deepEqual(readBuildConfig(root)?.indexTextExtensions, [".log", ".out"]);
    assert.equal(readBuildConfig(root)?.indexText, true);

    const again = runCli(["config", "index-text", "add", ".log", "--repo", root]);
    assert.match(again.stdout, /\.log is already in indexTextExtensions/);

    for (const bad of [".md", ".txt", "a/b"]) {
      const r = runCli(["config", "index-text", "add", bad, "--repo", root]);
      assert.notEqual(r.status, 0, `${bad} should be refused`);
    }
    assert.deepEqual(readBuildConfig(root)?.indexTextExtensions, [".log", ".out"]);

    const shown = runCli(["config", "index-text", "--repo", root]);
    assert.match(shown.stdout, /files: \.txt, \.log, \.out/);
    const listed = runCli(["config", "index-text", "list", "--repo", root]);
    assert.match(listed.stdout, /^ {2}\.out$/m);

    const removed = runCli(["config", "index-text", "rm", ".out", "--repo", root]);
    assert.equal(removed.status, 0, removed.describe());
    assert.deepEqual(readBuildConfig(root)?.indexTextExtensions, [".log"]);
    const missing = runCli(["config", "index-text", "remove", ".lst", "--repo", root]);
    assert.equal(missing.status, 1);

    const off = runCli(["config", "index-text", "off", "--repo", root]);
    assert.equal(off.status, 0, off.describe());
    assert.equal(readBuildConfig(root)?.indexText, false);

    const cleared = runCli(["config", "index-text", "clear", "--repo", root]);
    assert.equal(cleared.status, 0, cleared.describe());
    assert.deepEqual(readBuildConfig(root)?.indexTextExtensions, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partConfig carries the added extensions to each part", () => {
  assert.deepEqual(partConfig({ indexText: true, indexTextExtensions: ["LOG", ".md"] }, "Src/A"), {
    indexText: true,
    indexTextDirs: [],
    indexTextExtensions: [".log", ".md"],
  }, "normalized; a parsed extension is dropped where it is used, not here");
});

test("hand-edited text entries are used by the build, and add/remove see them in the same form", () => {
  const root = tmpRepo("text-hand-entries");
  try {
    write(root, ".graft/config.json", JSON.stringify({ indexTextExtensions: ["LOG", "*.out"], indexTextDirs: ["docs/", "./logs"] }));
    assert.deepEqual(addDirEntries(root, "indexTextExtensions", [".log"]), { added: [], present: [".log"] });
    assert.deepEqual(addDirEntries(root, "indexTextDirs", ["docs"]), { added: [], present: ["docs"] });
    assert.deepEqual(removeDirEntries(root, "indexTextExtensions", ["log"]), { removed: ["LOG"], missing: [] });
    assert.deepEqual(removeDirEntries(root, "indexTextDirs", ["logs"]), { removed: ["./logs"], missing: [] });
    const cfg = readBuildConfig(root);
    assert.deepEqual(cfg?.indexTextExtensions, ["*.out"]);
    assert.deepEqual(cfg?.indexTextDirs, ["docs/"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sliceSpan cuts lines like split, caps long spans, and reads each file once per answer", () => {
  const root = tmpRepo("slice-span");
  try {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
    write(root, "a.log", `${lines.join("\r\n")}\n`);
    const cache = new Map<string, string | null>();
    assert.equal(sliceSpan(root, "a.log", 2, 3, cache), "line 2\r\nline 3\r");
    assert.equal(cache.size, 1);
    const long = sliceSpan(root, "a.log", 10, 250, cache)!.split("\n");
    assert.equal(long.length, 81);
    assert.equal(long[0], "line 10\r");
    assert.equal(long.at(-1), "… (+161 more lines; open a.log:L10-L250)");
    const pastEnd = sliceSpan(root, "a.log", 295, 999, cache)!.split("\n");
    assert.equal(pastEnd.at(-1), "", "the empty line after the final newline, as split gives it");
    assert.equal(pastEnd.length, 7);
    assert.equal(sliceSpan(root, "a.log", 400, 410, cache), "");
    assert.equal(sliceSpan(root, "missing.log", 1, 2, cache), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a large chunk's search body is its leading text, the same as collapsing the whole chunk", () => {
  // One line can't be cut, so this chunk runs far past the 5,000 characters kept.
  const longLine = Array.from({ length: 3000 }, (_, i) => `word${i}   spaced\t\tout`).join("  ");
  const source = ["Big section", "===========", "", "  short   line  ", longLine].join("\n");
  const { nodes } = extractFile("big.txt", source, "text");
  const chunks = nodes.filter((n) => n.kind !== "file");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].span, "L1-L5");
  assert.equal(chunks[0].body_text, source.replace(/\s+/g, " ").trim().slice(0, 5000));
  assert.equal(chunks[0].body_text!.length, 5000);
});