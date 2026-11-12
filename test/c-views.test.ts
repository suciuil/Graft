/**
 * Extra C views the extractor parses next to a file as written: the C view of
 * an ERB template, the view that puts back the commas an initializer list
 * leaves out between `#if` blocks that are never on together, and the `#if`
 * views of the text a C compiler sees.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { erbView, isErbTemplate } from "../src/graph/erb.js";
import { extractFile, grammarAvailable, withInitializerCommas } from "../src/graph/extract.js";
import { warmDepthGrammars } from "../src/graph/depth-parser.js";

await warmDepthGrammars(["c"]);

const ERB = [
  "/* for AUTOSAR <%= MAJOR %>.<%= MINOR %> */",
  "#include <Cfg.h>",
  "% keys.each do |e|",
  "%   if e.needs_buffer?()",
  "const uint8 Buf_<%= e.name %>[SIZE_<%= e.name.upcase() %>] =",
  "<%= e.init_value %>;",
  "%   end",
  "% end",
  "<% if x %>int On(void) { return 1; }<% end %>",
  "",
].join("\n");

test("erb: output tags or Ruby lines mark a template, assembler lines do not", () => {
  assert.ok(isErbTemplate(ERB));
  assert.ok(!isErbTemplate("asm volatile int f(int x)\n{\n%reg x;\n! \"%d2\"\n  mov %d2, x\n}\n"));
  assert.ok(!isErbTemplate("int a = b % c;\n"));
});

test("erb: the view keeps every offset, outputs names and blanks Ruby", () => {
  const view = erbView(ERB);
  assert.equal(view.length, ERB.length);
  assert.deepEqual(view.split("\n").map((l) => l.length), ERB.split("\n").map((l) => l.length));
  const lines = view.split("\n");
  assert.equal(lines[2].trim(), "");
  assert.equal(lines[7].trim(), "");
  assert.match(lines[4], /^const uint8 Buf_____e_name___\[SIZE_\w+\] =$/);
  assert.match(lines[5], /^\w+;$/);
  assert.equal(lines[8].trim(), "int On(void) { return 1; }");
});

test("erb: a template is extracted from its view", { skip: !grammarAvailable("c") }, () => {
  const { nodes } = extractFile("gen/Cfg.c", ERB, "c");
  assert.equal(nodes[0].parse_errors ?? 0, 0);
  assert.ok(nodes.some((n) => n.name === "On"));
});

const VALVES = [
  "const valve_t * const Valves[] = {",
  "#if (A)",
  "   (valve_t*)&VALVE_MCV,",
  "   (valve_t*)&VALVE_PFV",
  "#endif",
  "#if (B)",
  "   (valve_t*)&VALVE_PDV  /* last */",
  "#endif",
  "#if (C)",
  "   (valve_t*)&VALVE_IFL",
  "#endif",
  "};",
  "",
  "void Valves_Run(void)",
  "{",
  "   if ((a)",
  "#if (B)",
  "      && (b)",
  "#endif",
  "      )",
  "   {",
  "      Run();",
  "   }",
  "}",
  "",
].join("\n");

test("initializer commas: a comma takes the place of the first directive in a gap", () => {
  const view = withInitializerCommas(VALVES);
  assert.ok(view !== null);
  assert.equal(view.length, VALVES.length);
  const lines = view.split("\n");
  assert.equal(lines[4], ",     ");
  assert.equal(lines[5], "#if (B)");
  assert.equal(lines[7], ",     ");
  // The list's last element and code outside initializer lists are left alone.
  assert.equal(lines[10], "#endif");
  assert.equal(lines[16], "#if (B)");
  assert.equal(lines[18], "#endif");
  assert.equal(withInitializerCommas("int a[] = {\n#if A\n 1,\n#endif\n 2\n};\n"), null);
});

test("initializer commas: functions after such a list are extracted", { skip: !grammarAvailable("c") }, () => {
  const { nodes } = extractFile("Valves.c", VALVES, "c");
  assert.equal(nodes[0].parse_errors ?? 0, 0);
  assert.ok(nodes.some((n) => n.name === "Valves_Run"));
});

// Assembler in `#if OS_ASM`, and in the `#else` an `extern "C" {` the header
// never closes. Blanking the `#ifdef __cplusplus` branch leaves the file's
// errors as they were, so only the `#else` view of that C-only text is clean.
const OS_TOOL = [
  "#ifndef OS_TOOL_H",
  "#define OS_TOOL_H",
  "#if (defined OS_ASM)",
  "\t.macro\t_mtcr\tcreg,reg",
  "\t\tdsync",
  "\t\tmtcr\tcreg,reg",
  "\t\tisync",
  "\t.endm",
  "#else",
  "#ifdef __cplusplus",
  'extern "C" {',
  "#endif",
  "#define OS_MFCR(id) _mfcr(id)",
  "extern void Os_Init(void);",
  "#endif",
  "#endif",
  "",
].join("\n");

test("conditional views: the C-only text gets its #if views too", { skip: !grammarAvailable("c") }, () => {
  const { nodes } = extractFile("Os_tool.h", OS_TOOL, "c");
  assert.equal(nodes[0].parse_errors ?? 0, 0);
});

// Enumerators in `#if` blocks, some written with a leading comma, some with a
// trailing one; the `#elif` blocks are alternatives and get no comma.
const WHEELS = [
  "typedef enum hyd_wheel_id_e",
  "{",
  "#if (N == 4)",
  "   HydWhFl",
  "#endif",
  "#if (N == 4)",
  "   ,HydWhRr",
  "#endif",
  "#if (N == 2)",
  "   HydWhF,",
  "#endif",
  "#if (N == 2)",
  "   HydWhR",
  "#endif",
  "} hyd_wheel_id_t;",
  "typedef enum wheel_id_e",
  "{",
  "#if (N == 4)",
  "   WhFl = 0,",
  "   WhRr",
  "#elif (N == 2)",
  "   WhF = 0,",
  "   WhR",
  "#endif",
  "} wheel_id_t;",
  "void Wheels_Init(void) { }",
  "",
].join("\n");

test("initializer commas: enumerator lists too, but not between #elif alternatives", () => {
  const view = withInitializerCommas(WHEELS);
  assert.ok(view !== null);
  const lines = view.split("\n");
  assert.equal(lines[7], ",     ");
  assert.equal(lines[4], "#endif");
  assert.equal(lines[10], "#endif");
  assert.equal(lines[20], "#elif (N == 2)");
});

test("initializer commas: the #if views of an enum with commas put back parse", { skip: !grammarAvailable("c") }, () => {
  const { nodes } = extractFile("Wheels.h", WHEELS, "c");
  assert.equal(nodes[0].parse_errors ?? 0, 0);
  assert.ok(nodes.some((n) => n.name === "Wheels_Init"));
});

// Elements in `#if` blocks inside the `#ifdef` branch of an outer chain, which
// also holds a line that cannot compile: only the `#else` view parses, and only
// when the commas put back between the inner blocks are left out with them.
const TABLE = [
  "const int Table[] = {",
  "#ifdef OLD_TABLE",
  "#if (A)",
  "   1",
  "#endif",
  "#if (B)",
  "   2",
  "#endif",
  "   4 5",
  "#else",
  "   3",
  "#endif",
  "};",
  "void Table_Init(void) { }",
  "",
].join("\n");

test("initializer commas: a comma in a left-out branch is left out too", { skip: !grammarAvailable("c") }, () => {
  const view = withInitializerCommas(TABLE);
  assert.ok(view !== null);
  assert.equal(view.split("\n")[4], ",     ");
  const { nodes } = extractFile("Table.c", TABLE, "c");
  assert.equal(nodes[0].parse_errors ?? 0, 0);
  assert.ok(nodes.some((n) => n.name === "Table_Init"));
});

// A `#warning` inside an `if` condition, and code no build turns on: a stray
// brace and a call with one parenthesis too many, each in an `#if` without
// `#else`. Only views without those branches parse.
const BROKEN_BRANCHES = [
  "void Mon_Run(void)",
  "{",
  "   if ((a)",
  "#if (SELECTIVE)",
  "#if (MODE == 2)",
  '#warning "selective mode is not tested"',
  "#endif",
  "       || (b)",
  "#endif",
  "      )",
  "   {",
  "      Run();",
  "   }",
  "#if (STAT_DATA)",
  "   memcpy(dst, src, size);}",
  "#endif",
  "   Done();",
  "}",
  "#if (PWM_API)",
  "void Mon_Test(void)",
  "{",
  "   Check(Get_state__return, ACTIVE, \"state\"));",
  "}",
  "#endif",
  "void Mon_Init(void)",
  "{",
  "   Init();",
  "}",
  "",
].join("\n");

test("conditional views: #warning lines are blanked, and branches with code that cannot compile are left out", { skip: !grammarAvailable("c") }, () => {
  const { nodes } = extractFile("Mon.c", BROKEN_BRANCHES, "c");
  assert.equal(nodes[0].parse_errors ?? 0, 0);
  for (const name of ["Mon_Run", "Mon_Init"]) assert.ok(nodes.some((n) => n.name === name), name);
});
