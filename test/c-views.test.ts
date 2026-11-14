/**
 * Extra C views the extractor parses next to a file as written: the C view of
 * an ERB template, the view that puts back the commas an initializer list
 * leaves out between `#if` blocks that are never on together, the view that
 * gives statement macros their semicolon, and the `#if` views of the text a C
 * compiler sees.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { erbView, isErbTemplate } from "../src/graph/erb.js";
import { extractFile, grammarAvailable, withInitializerCommas, withMacroSemicolons, withSplicedTokens } from "../src/graph/extract.js";
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

test("spliced tokens: the second half of a broken token moves up, offsets stay", () => {
  const source = "int t[] = {0x01,0x\\\r\n02,0x03,0\\\r\nx04};\n#define M(a) a + \\\n  1\n";
  const view = withSplicedTokens(source);
  assert.ok(view !== null);
  assert.equal(view.length, source.length);
  assert.deepEqual(view.split("\n"), ["int t[] = {0x01,0x02\\\r", ",0x03,0x04\\\r", "};", "#define M(a) a + \\", "  1", ""]);
  // A continuation between tokens needs nothing.
  assert.equal(withSplicedTokens("#define M(a) a + \\\n  1\n"), null);
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

// Generated OS code: statement macros without their semicolon, whose
// definitions bring it (or an `else { … }`) along. After a declaration, four
// such lines in a row can also start a declaration, and the parser loses the
// reading that has them as statements.
const OS_TASK = [
  "StatusType osChainTask(TaskType taskIndex)",
  "{",
  "   if(osConfigBlock.ProcessToCore[taskIndex] != osSysGetCoreID())",
  "   {",
  "      osbool startDispatcher = osConfigBlock.CcbAddress[osConfigBlock.ProcessToCore[taskIndex]]->LockIsNeeded.ossStartDispatcher;",
  "      COVER(0x0374)",
  "      osReleaseInternalLock(osConfigBlock.ProcessToCore[taskIndex])",
  "      osReleaseInternalLock(OS_NESTING_LOCK)",
  "      IF2ANDCOVER(osdTRUE == startDispatcher, osdFALSE == startDispatcherBeforeInsert,0x03A3,0x03A4,0x03A5)",
  "      if((osdTRUE == startDispatcher) && (osdFALSE == startDispatcherBeforeInsert))",
  "      {",
  "         COVER(0x0375)",
  "         /* KB begin osekHWosTriggerDispatcherOnRemoteCore (default) */",
  "         osTriggerRemote(osConfigBlock.ProcessToCore[taskIndex])",
  "         /* KB end osekHWosTriggerDispatcherOnRemoteCore */",
  "      }",
  "      ELSEWITHCOVER(0x0376)",
  "   }",
  "   ELSEWITHCOVER(0x0377)",
  "   return E_OK;",
  "}",
  "const Entry Table[] = {",
  "   ENTRY(1)",
  "   ENTRY(2)",
  "};",
  "DeclareTask(Idle)",
  "void osTaskEnd(void) { }",
  "",
].join("\n");

test("macro semicolons: a statement macro on a line of its own gets a ; after its call", () => {
  const view = withMacroSemicolons(OS_TASK);
  assert.ok(view !== null);
  const lines = view.split("\n");
  const source = OS_TASK.split("\n");
  assert.equal(lines.length, source.length);
  for (const i of [5, 6, 7, 8, 11, 13, 16, 18]) assert.equal(lines[i], source[i].replace(/\)$/, ");"), `line ${i + 1}`);
  // `if` heads, statements that have their `;`, initializer elements and
  // macros outside any function are left alone.
  for (const i of [2, 4, 9, 19, 22, 23, 25]) assert.equal(lines[i], source[i], `line ${i + 1}`);
  assert.equal(withMacroSemicolons("void f(void)\n{\n   x = \n      g(a)\n      + 1;\n}\n"), null);
});

test("macro semicolons: the function around such macros is extracted whole", { skip: !grammarAvailable("c") }, () => {
  const { nodes } = extractFile("osektask.c", OS_TASK, "c");
  assert.equal(nodes[0].parse_errors ?? 0, 0);
  for (const name of ["osChainTask", "osTaskEnd"]) assert.ok(nodes.some((n) => n.name === name), name);
});

// Generated AUTOSAR E2E wrappers: macros outside any function, each call over
// several lines and without its semicolon. Several in a row read as one long
// declaration, and the function after them is lost.
const wrapper = (port: string): string[] => [
  "/** \\brief Declare Prototype of generic Rte wrapper function */",
  "E2EPW_DEFFUNC1",
  "(",
  `   ComALOut_${port},`,
  `   ${port}_Type,`,
  `   ${port},`,
  "   E2EPW_SC_WR,",
  "   E2EPW_CX_IR",
  ")",
  "",
];
const E2E_WRAPPERS = [
  "#define E2EPW_START_SEC_CODE",
  "#include <MemMap.h>",
  "",
  ...wrapper("SG_ABS3"),
  ...wrapper("SG_ESP1"),
  ...wrapper("SG_ESP2"),
  ...wrapper("SG_EPB1"),
  "static FUNC(uint8, E2EPW_CODE) E2EPW_Pack",
  "(",
  "   CONSTP2CONST(void, AUTOMATIC, E2EPW_APPL_DATA) E2EPW_SrcPtr,",
  "   CONSTP2VAR(void, AUTOMATIC, E2EPW_APPL_DATA) E2EPW_DstPtr",
  ")",
  "{",
  "   return 0U;",
  "}",
  "",
].join("\n");

test("macro semicolons: a macro call over several lines outside any function gets a ; after its )", () => {
  const view = withMacroSemicolons(E2E_WRAPPERS);
  assert.ok(view !== null);
  const lines = view.split("\n");
  const source = E2E_WRAPPERS.split("\n");
  assert.equal(lines.length, source.length);
  const head = source.findIndex((line) => line.startsWith("static FUNC"));
  source.forEach((line, i) => assert.equal(lines[i], line === ")" && i < head ? ");" : line, `line ${i + 1}`));
  // A function head written the same way is followed by its body, and a
  // prototype already has its `;`: both are left alone.
  assert.equal(withMacroSemicolons("FUNC(void, APP_CODE)\nApp_Init\n(\n   void\n)\n{\n}\n"), null);
  assert.equal(withMacroSemicolons("FUNC(void, APP_CODE)\nApp_Init\n(\n   void\n);\nint x;\n"), null);
});

test("a chain of one operator thousands of terms long is extracted without running out of stack", { skip: !grammarAvailable("c") }, () => {
  // Generated fragments OR together one flag per `#if` block, over thousands of lines.
  const terms = Array.from({ length: 20000 }, (_, k) => `Flag_${k}`);
  const source = `unsigned int Mask(void)\n{\n   return ${terms.join(" |\n      ")};\n}\n`;
  const { nodes } = extractFile("degr_reason_gen.c", source, "c");
  assert.equal(nodes[0].parse_errors ?? 0, 0);
  assert.ok(nodes.some((n) => n.name === "Mask"));
});

test("macro semicolons: the function after such wrappers is extracted", { skip: !grammarAvailable("c") }, () => {
  const { nodes } = extractFile("E2EPW_ComAL.c", E2E_WRAPPERS, "c");
  assert.equal(nodes[0].parse_errors ?? 0, 0);
  assert.ok(nodes.some((n) => n.name === "E2EPW_Pack"));
});

// A branch no build turns on that opens a brace it never closes, far from both
// ends of the file: the parser gives up on the whole file, so the error rows
// say nothing about where the branch is. The braces of the view do.
const filler = (from: number, count: number): string[] =>
  Array.from({ length: count }, (_, k) => [`int Fill_${from + k}(int x)`, "{", `   return x + ${k};`, "}"]).flat();
const UNCLOSED = [
  ...filler(0, 150),
  "void Wheel_Run(void)",
  "{",
  "#if (F_WHEEL)",
  "   if (Wheel_Ready())",
  "   {",
  "      Wheel_Start();",
  "#endif",
  "   Wheel_Done();",
  "}",
  ...filler(150, 150),
  "",
].join("\n");

test("conditional views: a branch that leaves a brace open is found by the view's braces", { skip: !grammarAvailable("c") }, () => {
  const { nodes } = extractFile("Wheel.c", UNCLOSED, "c");
  assert.equal(nodes[0].parse_errors ?? 0, 0);
  for (const name of ["Fill_0", "Wheel_Run", "Fill_299"]) assert.ok(nodes.some((n) => n.name === name), name);
});

// Directives in code commented out with them: they are no directives, and
// blanking the `#endif*\/` line would cut off the comment's end. The broken
// `#if` branch below makes the extractor parse views at all.
const COMMENTED = [
  "boolean PUT_StopLamp(void)",
  "{",
  "   boolean ret_val = False;",
  "   if ( False",
  "   #if (CFG_BLI > 0u)",
  "   || ( GET_BRAKE_LIGHT_REQUEST(Brake_light_on) == True )",
  "   #else",
  "   || (Get_safe_braking() >= Bsd_asil_qm )",
  "   #endif",
  "   /*#if (CFG_DMM)",
  "   || (Get_cms1_brakelight() == ADA_brakelight_on)",
  "   #endif",
  "   #if (CFG_DMM)",
  "   || (Get_acc1_brakelight() == ADA_brakelight_on)",
  "   #endif*/",
  "   )",
  "   {",
  "      ret_val = True;",
  "   }",
  "   return (ret_val);",
  "}",
  "void PUT_Init(void)",
  "{",
  "#if (OLD_API)",
  "   Init(1));",
  "#else",
  "   Init(2);",
  "#endif",
  "}",
  "",
].join("\n");

test("conditional views: directives inside a block comment are left as they are", { skip: !grammarAvailable("c") }, () => {
  const { nodes } = extractFile("Put.c", COMMENTED, "c");
  assert.equal(nodes[0].parse_errors ?? 0, 0);
  for (const name of ["PUT_StopLamp", "PUT_Init"]) assert.ok(nodes.some((n) => n.name === name), name);
});
