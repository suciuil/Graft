/**
 * EB tresos code templates: the C views the extractor parses instead of the
 * template, and what a build makes of a template and of a tresos `.m` file.
 */
import "./isolate.js";
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

test("tresos: a #define continued over markup-only lines and skipped branches stays one directive", () => {
  const src = [
    "#define FCTPTRS \\",
    "{\\",
    '[!LOOP "P/*"!][!//',
    '[!IF "a"!][!//',
    '  [!"."!]Read,\\',
    "[!ELSE!][!//",
    "  NULL_PTR,\\",
    "[!ENDIF!][!//",
    "[!ENDLOOP!][!//",
    "}",
    "[!IF \"b\"!][!//",
    "int after;",
    "[!ENDIF!][!//",
    "",
  ].join("\r\n");
  for (const v of tresosViews(src)) {
    const lines = v.split("\r\n");
    assert.deepEqual(lines.map((l) => l.length), src.split("\r\n").map((l) => l.length));
    // Every line from the #define to the closing brace continues it.
    for (const l of lines.slice(0, 9)) assert.match(l, /\\$/);
    assert.equal(lines[9], "}");
    assert.doesNotMatch(lines[10], /\\/, "markup lines outside a #define stay blank");
  }
});

test("tresos: a #define runs on over a markup-only line, but not into the next directive", () => {
  const src = [
    "#define MASK ( \\",
    '[!LOOP "x"!][!//',
    '  (1U << [!"."!]) | \\',
    "[!ENDLOOP!]",
    "  0U)",
    '#define ON [!IF "a"!]1[!ENDIF!][!/*',
    "*/!]",
    "#endif",
    "",
  ].join("\n");
  for (const v of tresosViews(src)) {
    const lines = v.split("\n");
    assert.match(lines[3], /\\$/, "[!ENDLOOP!] alone continues the #define");
    assert.doesNotMatch(lines[6], /\\/, "the line before #endif does not continue into it");
  }
});

test("tresos: names, separators, element values and messages come out as the generator writes them", () => {
  const src = [
    'int k[!"$T"!][!IF "$v"!]_[!"$V"!][!ENDIF!][0];',
    "int a[] = {",
    '[!LOOP "x/*"!][!//',
    '[!IF "$i > 0"!],[!ENDIF!][!"num:i($i)"!][!//',
    "[!ENDLOOP!][!//",
    "};",
    "void *f[] = {",
    "  [!\"node:when($c, concat('&Fn_', $n, ','), 'NULL_PTR,')\"!]",
    "  NULL_PTR",
    "};",
    "x = f([!\"substring-before($v, ',')\"!]);",
    "[!NOCODE!][!//",
    "[!ERROR!][!//",
    "[!CODE!][!//",
    "  the clock source shall be configured",
    "[!ENDCODE!][!//",
    "[!ENDERROR!][!//",
    "[!ENDNOCODE!][!//",
    "",
  ].join("\n");
  for (const v of tresosViews(src)) {
    const lines = v.split("\n");
    assert.match(lines[0], /^int k\w+ *\[0\];$/, "markup inside a name joins it");
    assert.doesNotMatch(lines[3], /,/, "the separator before the first element goes");
    assert.match(lines[7], /^ {2}\w+,$/, "a value ending in a comma keeps it");
    assert.equal(lines[10].indexOf(","), -1, "a comma passed as a delimiter is not output");
    assert.doesNotMatch(v, /clock source/, "[!CODE!] inside [!ERROR!] is not output");
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

const MAKE_TEMPLATE = [
  "[!AUTOSPACING!]",
  "# Csm_rules.mak",
  "[!IF \"node:exists(as:modconf('Csm')[1])\"!]",
  "LIBRARIES_TO_BUILD += Csm_src",
  "[!LOOP \"as:modconf('Csm')[1]/CsmJobs/*\"!]",
  "Csm_src_FILES += $(Csm_OUTPUT_PATH)/src/Csm_[!\"node:name(.)\"!].c",
  "[!ENDLOOP!]",
  "[!ENDIF!]",
  "csm: $(Csm_src_FILES)",
  "",
].join("\r\n");

const XML_TEMPLATE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  "[!AUTOSPACING!]",
  "<events>",
  '[!LOOP "Event/*"!]',
  '  <event name="[!"node:name(.)"!]" id="[!"num:i(@index)"!]"/>',
  "[!ENDLOOP!]",
  "</events>",
  "",
].join("\r\n");

test("tresos: makefile and XML templates build without parse errors", { skip: grammarAvailable("make") && grammarAvailable("xml") ? false : "make or xml grammar not built" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-tresos-"));
  try {
    writeFileSync(join(dir, "Csm_rules.mak"), MAKE_TEMPLATE);
    writeFileSync(join(dir, "avmeventmap.xml"), XML_TEMPLATE);
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const mak = graph.nodes.find((n) => n.id === "Csm_rules.mak");
    assert.equal(mak?.parse_errors, undefined, "the makefile template parses whole");
    assert.equal(mak?.chars, MAKE_TEMPLATE.length, "the file node keeps the template's own size");
    assert.ok(graph.nodes.some((n) => n.id === "Csm_rules.mak#LIBRARIES_TO_BUILD"));
    assert.ok(graph.nodes.some((n) => n.id === "Csm_rules.mak#csm"));
    const xml = graph.nodes.find((n) => n.id === "avmeventmap.xml");
    assert.equal(xml?.parse_errors, undefined, "the XML template parses whole");
    assert.ok(graph.nodes.some((n) => n.id === "avmeventmap.xml#events"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
