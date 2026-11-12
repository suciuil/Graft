/**
 * Extra C views the extractor parses next to a file as written: the C view of
 * an ERB template, and the view that puts back the commas an initializer list
 * leaves out between `#if` blocks that are never on together.
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
