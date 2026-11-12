/**
 * EB tresos code templates: the C views the extractor parses instead of the
 * template, and what a build makes of a template and of a tresos `.m` file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isTresosTemplate, tresosViews } from "../src/graph/tresos.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { grammarAvailable } from "../src/graph/extract.js";

const TEMPLATE = [
  "[!NOCODE!]",
  "[!/* header",
  "   comment */!]",
  '[!VAR "n" = "num:i(4)"!][!//',
  "[!CODE!][!//",
  "#define CH_COUNT [!\"$n\"!]U",
  "static int Tbl[[!\"$n\"!]];",
  "[!LOOP \"Channel/*\"!][!//",
  "void Ch_[!\"node:name(.)\"!]_Init(void) { Tbl[0] = [!IF \"a\"!]1[!ELSE!]2[!ENDIF!]; }",
  "[!ENDLOOP!][!//",
  "[!ENDCODE!][!//",
  "[!ERROR!]",
  "  not output: { ( ;",
  "[!ENDERROR!]",
  '[!ERROR "one-line"!]',
  "[!ENDNOCODE!][!//",
  "int Tail(void) { return [!CALL \"Value\"!]; }",
  "",
].join("\n");

test("tresos: only real markup marks a template", () => {
  assert.ok(isTresosTemplate(TEMPLATE));
  assert.ok(isTresosTemplate('x = [!"$v"!];'));
  assert.ok(!isTresosTemplate("int a[!b];\nint c = !d;\n"));
});

test("tresos: the views keep offsets, blank markup and keep output as C", () => {
  const [all, first] = tresosViews(TEMPLATE);
  for (const v of [all, first]) {
    assert.equal(v.length, TEMPLATE.length);
    assert.deepEqual(v.split("\n").map((l) => l.length), TEMPLATE.split("\n").map((l) => l.length));
    assert.doesNotMatch(v, /\[!|!\]|not output|header|comment/);
    assert.match(v, /#define CH_COUNT _+n_+U/);
    assert.match(v, /static int Tbl\[_+n_+\];/);
    assert.match(v, /void Ch_+node_name_+Init\(void\)/);
    assert.match(v, /return _+CALL_+Value_+;/);
  }
  assert.match(all, /Tbl\[0\] = \s*1\s+2\s*;/);
  assert.match(first, /Tbl\[0\] = \s*1\s*;/);
});

test("tresos: a [!CALL!] alone on a CRLF line is blanked, not kept as an identifier", () => {
  const src = '#define A [!//\r\n[!CALL "Switch"!][!//\r\nint x = [!CALL "V"!];\r\n';
  for (const v of tresosViews(src)) {
    assert.doesNotMatch(v, /CALL_+Switch/);
    assert.match(v, /int x = _+CALL_+V_+;/);
  }
});

test("tresos: a C template builds without parse errors; a tresos .m is a file node", { skip: grammarAvailable("c") ? false : "c grammar not built" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-tresos-"));
  try {
    writeFileSync(join(dir, "Ch_Cfg.c"), TEMPLATE);
    writeFileSync(join(dir, "Ch_Macros.m"), '[!NOCODE!]\n[!MACRO "Value"!][!//\n42[!//\n[!ENDMACRO!]\n[!ENDNOCODE!]\n');
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const file = graph.nodes.find((n) => n.id === "Ch_Cfg.c");
    assert.equal(file?.parse_errors, undefined, "the template parses whole");
    assert.equal(file?.chars, TEMPLATE.length);
    assert.ok(graph.nodes.some((n) => n.id === "Ch_Cfg.c#Tail" && n.kind === "function"));
    assert.ok(graph.nodes.some((n) => n.id.startsWith("Ch_Cfg.c#Ch_") && n.kind === "function"));
    const macros = graph.nodes.filter((n) => n.id === "Ch_Macros.m" || n.id.startsWith("Ch_Macros.m#"));
    assert.equal(macros.length, 1, "the .m file is a file node only");
    assert.equal(macros[0].parse_errors, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
