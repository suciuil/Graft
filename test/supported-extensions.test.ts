/**
 * `-e` extension validation (#98): a `graft build -e "<ext>"` must not silently index
 * nothing — the CLI warns on any extension no parser claims. These test the pure helper
 * the warning is built on: the supported set (depth + breadth + container) and which
 * inputs fall outside it, including normalization (leading dot optional, case-insensitive).
 *
 * `.vue` was the extension originally reported in #98 and is used below as a
 * SUPPORTED case: the container tier now claims it (#97). The unsupported side is
 * carried by `.svelte`, which is the same SFC shape and the natural next request —
 * the day someone adds it, this file is where the substitution happens again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { supportedExtensions, unsupportedExtensions } from "../src/graph/source-files.js";
import { languageOf } from "../src/graph/extract.js";

test("supportedExtensions covers both tiers, sorted and de-duped", () => {
  const exts = supportedExtensions();
  // depth tier
  for (const e of [".ts", ".tsx", ".py", ".go", ".java", ".js", ".php", ".kt", ".kts", ".swift"]) assert.ok(exts.includes(e), `depth ${e}`);
  // breadth tier
  for (const e of [".rs", ".rb", ".c", ".cpp", ".gleam"]) assert.ok(exts.includes(e), `breadth ${e}`);
  // container tier
  assert.ok(exts.includes(".vue"), "container .vue");
  // de-duped (.java is in BOTH tiers but must appear once) and sorted
  assert.equal(exts.filter((e) => e === ".java").length, 1, ".java de-duped across tiers");
  assert.deepEqual(exts, [...exts].sort(), "sorted");
});

test("unsupportedExtensions flags only what has no parser (the #98 repro)", () => {
  // no parser → flagged
  assert.deepEqual(unsupportedExtensions([".svelte"]), [".svelte"]);
  // mixed: supported ones drop out, unsupported stay
  assert.deepEqual(unsupportedExtensions([".ts", ".vue", ".rs", ".svelte"]), [".svelte"]);
  // fully-supported input → nothing flagged, container tier included
  assert.deepEqual(unsupportedExtensions([".ts", ".php", ".c", ".vue"]), []);
});

test("extension normalization: missing dot and mixed case still match a parser", () => {
  // a user typing `-e vue` or `-e .TS` should be judged on the normalized form
  assert.deepEqual(unsupportedExtensions(["ts"]), [], "no leading dot still recognized");
  assert.deepEqual(unsupportedExtensions([".TS", ".Php"]), [], "case-insensitive");
  assert.deepEqual(unsupportedExtensions(["vue"]), [], "container extension recognized without a dot too");
  assert.deepEqual(unsupportedExtensions(["Svelte"]), ["Svelte"], "unsupported still flagged, echoed as the user typed it");
});

test("a file claimed by its whole name (CMakeLists.txt) is judged by that name, not as an extension", { skip: supportedExtensions().includes("CMakeLists.txt") ? false : "cmake grammar not built" }, () => {
  assert.deepEqual(unsupportedExtensions(["CMakeLists.txt", "cmakelists.txt", ".cmake"]), []);
  // Every other .txt is plain text (graph/text.ts), so `-e .txt` is accepted too.
  assert.deepEqual(unsupportedExtensions([".txt"]), []);
  assert.equal(languageOf("notes.txt"), "text", "claiming CMakeLists.txt does not make every .txt CMake");
});

test("-e m and -e mlx are accepted once the MATLAB grammar is built; Simulink files always are", { skip: supportedExtensions().includes(".m") ? false : "matlab grammar not built" }, () => {
  assert.deepEqual(unsupportedExtensions(["m", ".M"]), []);
  assert.deepEqual(unsupportedExtensions([".slx", ".sldd", ".mdl", ".mlx"]), []);
});
