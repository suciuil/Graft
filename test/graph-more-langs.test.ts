/**
 * Tests for the C/C++/CMake/Bash/Perl/Make depth extractors and the JSON/YAML/Markdown/SCSS breadth
 * extractors. Each grammar is an optional, locally-built native dependency; the
 * per-language tests skip when its binding isn't built.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { grammarAvailable } from "../src/graph/extract.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}
function hasEdge(graph: GraphV1, rel: string, source: string, target: string): boolean {
  return graph.edges.some((e) => e.relation === rel && e.source === source && e.target === target);
}
async function build(files: Record<string, string>): Promise<GraphV1> {
  const dir = mkdtempSync(join(tmpdir(), "graft-lang-"));
  try {
    for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
    await buildGraph(dir);
    return readGraph(wiringPath(join(dir, "graft")))!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("C depth: functions, structs, resolved calls, local include", { skip: grammarAvailable("c") ? false : "c grammar not built" }, async () => {
  const graph = await build({
    "app.c": `#include "util.h"\nstruct Point { int x; };\nint helper(int x){ return x+1; }\nint run(void){ return helper(2); }\n`,
  });
  assert.ok(graph.meta.languages.includes("c"), "languages include c");
  assert.equal(nodeById(graph, "app.c#helper")?.kind, "function");
  assert.equal(nodeById(graph, "app.c#run")?.kind, "function");
  assert.equal(nodeById(graph, "app.c#Point")?.kind, "struct");
  assert.ok(hasEdge(graph, "calls", "app.c#run", "app.c#helper"), "run() → helper() resolves");
  assert.ok(hasEdge(graph, "imports", "app.c", "util.h"), '#include "util.h" is an import edge');
});

// AUTOSAR wraps types in function-like macros with a memory-class argument:
// CONST(T, M), VAR(T, M), FUNC(T, M), P2CONST(T, M, P). The grammar fork accepts
// them as macro_type_specifier; before that, a generated table such as
// Dem_Lcfg.c turned into one comma_expression thousands of levels deep and
// overflowed the extractor's stack.
test("C depth: AUTOSAR CONST/VAR/FUNC/P2CONST type macros", { skip: grammarAvailable("c") ? false : "c grammar not built" }, async () => {
  const rows = Array.from({ length: 12000 }, (_, i) => `  { ${i}u, DEM_CFG_X }`).join(",\n");
  const graph = await build({
    "Dem_Lcfg.c": `CONST(Dem_Cfg_EventTableType, DEM_CONST) Dem_Cfg_EventTable[12000] = {\n${rows}\n};\n`
      + `static VAR(uint8, DEM_VAR_NOINIT) Dem_State;\n`
      + `FUNC(void, DEM_CODE) Dem_Helper(P2CONST(Dem_ConfigType, AUTOMATIC, DEM_PBCFG) ConfigPtr) { Dem_State = 1u; }\n`
      + `FUNC(void, DEM_CODE) Dem_Init(void) { VAR(uint16, AUTOMATIC) i = 0u; Dem_Helper(i); }\n`,
  });
  assert.equal(nodeById(graph, "Dem_Lcfg.c#Dem_Helper")?.kind, "function");
  assert.equal(nodeById(graph, "Dem_Lcfg.c#Dem_Init")?.kind, "function");
  assert.ok(hasEdge(graph, "calls", "Dem_Lcfg.c#Dem_Init", "Dem_Lcfg.c#Dem_Helper"), "Dem_Init() → Dem_Helper() resolves");
});

// Macros a parser without a preprocessor cannot expand: a test-framework macro
// opening a function body, a storage-class macro in front of the type, a bare
// macro statement with no semicolon, and a function whose head differs per
// #if branch. Before the grammar fork these collapsed into ERROR nodes and the
// functions around them were lost or invented.
test("C depth: unit-test macro bodies, macro modifiers and #if function heads", { skip: grammarAvailable("c") ? false : "c grammar not built" }, async () => {
  const graph = await build({
    "unit_test.c": `#include "cou.h"\n`
      + `STATIC FUNC(void, TST_CODE) Tst_Helper(void) { }\n`
      + `TS_PREVENTEMPTYTRANSLATIONUNIT\n`
      + `DefStubFunc(void, Tst_Stub, void)\n`
      + `COU_TEST(TestCase_001, "Init check") { Tst_Helper(); }\n`
      + `#if (TST_CAT == 1)\nIFX_INTERRUPT(Tst_Isr, 0, 10)\n#else\nISR(Tst_Isr)\n#endif\n{ Tst_Helper(); }\n`
      + `#if (TST_WITH_ARG == 1)\nvoid Tst_Main(uint8 a)\n#else\nvoid Tst_Main(void)\n#endif\n{ Tst_Helper(); }\n`,
  });
  assert.equal(nodeById(graph, "unit_test.c#Tst_Helper")?.kind, "function");
  assert.equal(nodeById(graph, "unit_test.c#TestCase_001")?.kind, "function");
  assert.equal(nodeById(graph, "unit_test.c#Tst_Isr")?.kind, "function");
  assert.equal(nodeById(graph, "unit_test.c#Tst_Main")?.kind, "function");
  assert.ok(hasEdge(graph, "calls", "unit_test.c#TestCase_001", "unit_test.c#Tst_Helper"), "test body → Tst_Helper() resolves");
  assert.ok(hasEdge(graph, "calls", "unit_test.c#Tst_Main", "unit_test.c#Tst_Helper"), "#if-headed body → Tst_Helper() resolves");
});

// Code that only makes sense one #if branch at a time: an `if (` condition per
// branch, a brace opened in a branch and closed after the #endif. Parsed with all
// branches at once the tree has errors and swallows the functions after it; the
// file is parsed again as branch views, and the functions of every branch count.
test("C depth: #if branches that only parse one at a time", { skip: grammarAvailable("c") ? false : "c grammar not built" }, async () => {
  const graph = await build({
    "branches.c": `void Br_Helper(void) { }\n`
      + `void Br_Check(int a)\n{\n#if (BR_STRICT == 1)\n  if (a > 0) {\n#else\n  if (a >= 0) {\n#endif\n    Br_Helper();\n  }\n}\n`
      + `#if (BR_NEW == 1)\nvoid Br_Run(int a) {\n  Br_New(a);\n#else\nvoid Br_Run(void) {\n  Br_Old();\n#endif\n  Br_Helper();\n}\n`
      + `void Br_After(void) { Br_Check(1); }\n`
      + `void Br_New(int a) { }\nvoid Br_Old(void) { }\n`
      // A comment that goes on past the #endif line is blanked with it, not left as code.
      + `#if (BR_A == 1) || \\\n    (BR_B == 1)\nvoid Br_Opt(void) { }\n#endif /* (BR_A == 1) || (BR_B == 1), was:\n   void Br_Gone(void) { } */\n`
      // Types of a branch the picked view leaves out still count.
      + `#if (BR_WIDE == 1)\nstruct Br_Wide { int a; long b; };\n#else\nstruct Br_Narrow { int a; };\n#endif\n`,
  });
  assert.equal(nodeById(graph, "branches.c#Br_Wide")?.kind, "struct", "struct of the first branch");
  assert.equal(nodeById(graph, "branches.c#Br_Narrow")?.kind, "struct", "struct of the last branch");
  const names = ["Br_Helper", "Br_Check", "Br_Run", "Br_After", "Br_New", "Br_Old", "Br_Opt"];
  for (const name of names) assert.equal(nodeById(graph, `branches.c#${name}`)?.kind, "function", name);
  const functions = graph.nodes.filter((n) => n.path === "branches.c" && n.kind === "function").map((n) => n.name);
  assert.deepEqual([...new Set(functions)].sort(), [...names].sort(), "no function made up from a comment left behind");
  assert.equal(nodeById(graph, "branches.c#Br_Run")?.span, "L13-L20", "Br_Run starts at its first head");
  assert.equal(nodeById(graph, "branches.c#Br_Run~2")?.span, "L16-L20", "the head of the other branch is a second definition");
  assert.ok(hasEdge(graph, "calls", "branches.c#Br_Check", "branches.c#Br_Helper"), "call inside the per-branch if");
  assert.ok(hasEdge(graph, "calls", "branches.c#Br_After", "branches.c#Br_Check"), "functions after the #if still parse");
  assert.ok(hasEdge(graph, "calls", "branches.c#Br_Run", "branches.c#Br_New"), "call in the first branch");
  assert.ok(hasEdge(graph, "calls", "branches.c#Br_Run~2", "branches.c#Br_Old"), "call in the last branch");
});

// Code for builds that are never on together, each in a #if of its own: two
// loop heads for one closing brace, in two functions, and a call missing its `)`
// in two branches no build compiles. The file only parses once every such #if
// is changed at the same time, which changing one #if at a time never finds.
test("C depth: several #if chains that only balance the braces together", { skip: grammarAvailable("c") ? false : "c grammar not built" }, async () => {
  const loop = (name: string, a: string, b: string, head: string) =>
    `void ${name}(int a)\n{\n#if (${a} == 1)\n  ${head.replace("N", "2")} {\n#endif\n#if (${b} == 1)\n  ${head.replace("N", "3")} {\n#endif\n    Ba_Helper(a);\n  }\n}\n`;
  const call = (cond: string, arg: string) => `#if (${cond} == 1)\n  Ba_Helper(${arg}\n#else\n  Ba_Helper(${arg});\n#endif\n`;
  const graph = await build({
    "balance.c": `void Ba_Helper(int a) { }\n`
      + loop("Ba_One", "BA_X", "BA_Y", "for (a = 0; a < N; a++)")
      + loop("Ba_Two", "BA_P", "BA_Q", "while (a > N)")
      + `void Ba_Three(int a)\n{\n${call("BA_R", "a")}${call("BA_S", "a + 1")}}\n`
      + `void Ba_After(void) { Ba_One(1); Ba_Two(2); Ba_Three(3); }\n`,
  });
  assert.equal(nodeById(graph, "balance.c")?.parse_errors, undefined, "no syntax errors left");
  for (const name of ["Ba_One", "Ba_Two", "Ba_Three"]) {
    assert.ok(hasEdge(graph, "calls", `balance.c#${name}`, "balance.c#Ba_Helper"), `${name}() → Ba_Helper()`);
    assert.ok(hasEdge(graph, "calls", "balance.c#Ba_After", `balance.c#${name}`), `Ba_After() → ${name}()`);
  }
});

// A test file whose tests each sit in an #if of their own, each after a
// declaration missing its `;`: no build turns those blocks on, and there are
// more of them than changing one #if at a time can leave out.
test("C depth: many #if blocks broken the same way are left out at once", { skip: grammarAvailable("c") ? false : "c grammar not built" }, async () => {
  const blocks = Array.from({ length: 24 }, (_, i) =>
    `#if (defined (CDL_TEST_${i}))\nextern Dr_Case_${i}(a, b)\nCOU_TEST(Dr_Test_${i}, "case ${i}")\n{\n  Dr_Helper(${i});\n}\n#endif\n`,
  ).join("");
  const good = `#if (defined (CDL_TEST_OK))\nextern int Dr_Case_Ok(int a);\nCOU_TEST(Dr_Test_Ok, "case ok")\n{\n  Dr_Helper(1);\n}\n#endif\n`;
  const graph = await build({
    "drop.c": `void Dr_Helper(int a) { }\n${blocks}${good}void Dr_After(void) { Dr_Helper(0); }\n`,
  });
  assert.equal(nodeById(graph, "drop.c")?.parse_errors, undefined, "no syntax errors left");
  assert.ok(hasEdge(graph, "calls", "drop.c#Dr_After", "drop.c#Dr_Helper"), "Dr_After() → Dr_Helper()");
  assert.ok(hasEdge(graph, "calls", "drop.c#Dr_Test_Ok", "drop.c#Dr_Helper"), "a block without errors stays in");
});

// A backslash at the end of a line splits a hex number of a table in two.
test("C depth: a number split by a line continuation", { skip: grammarAvailable("c") ? false : "c grammar not built" }, async () => {
  const graph = await build({
    "splice.c": `unsigned char Sp_Table[6] = {0x01,0x\\\n02,0x03,0\\\nx04,0x05,0x06};\nvoid Sp_Helper(void) { }\nvoid Sp_Run(void) { Sp_Helper(); }\n`,
  });
  assert.equal(nodeById(graph, "splice.c")?.parse_errors, undefined, "no syntax errors left");
  assert.equal(nodeById(graph, "splice.c#Sp_Run")?.span, "L5-L5", "lines stay where they were");
  assert.ok(hasEdge(graph, "calls", "splice.c#Sp_Run", "splice.c#Sp_Helper"), "Sp_Run() → Sp_Helper()");
});

test("C++ depth: classes, out-of-line methods, inheritance, calls", { skip: grammarAvailable("cpp") ? false : "cpp grammar not built" }, async () => {
  const graph = await build({
    "app.cpp": `namespace app {\nclass Base {};\nclass Repo : public Base {\npublic:\n  int Save(int x);\n};\nint helper(int x){ return x+1; }\nint Repo::Save(int x){ return helper(x); }\n}\n`,
  });
  assert.ok(graph.meta.languages.includes("cpp"), "languages include cpp");
  assert.equal(nodeById(graph, "app.cpp#Base")?.kind, "class");
  assert.equal(nodeById(graph, "app.cpp#Repo")?.kind, "class");
  assert.equal(nodeById(graph, "app.cpp#Repo.Save")?.kind, "method");
  assert.ok(hasEdge(graph, "extends", "app.cpp#Repo", "app.cpp#Base"), "Repo extends Base");
  assert.ok(hasEdge(graph, "calls", "app.cpp#Repo.Save", "app.cpp#helper"), "Repo::Save → helper resolves");
});

test("JSON breadth: object keys become scoped variable nodes", { skip: grammarAvailable("json") ? false : "json grammar not built" }, async () => {
  const graph = await build({ "pkg.json": '{"name":"app","scripts":{"build":"tsc"}}' });
  assert.ok(graph.meta.languages.includes("json"), "languages include json");
  assert.equal(nodeById(graph, "pkg.json#name")?.kind, "variable");
  assert.equal(nodeById(graph, "pkg.json#scripts")?.kind, "variable");
  assert.equal(nodeById(graph, "pkg.json#scripts.build")?.kind, "variable");
});

test("YAML breadth: mapping keys become scoped variable nodes", { skip: grammarAvailable("yaml") ? false : "yaml grammar not built" }, async () => {
  const graph = await build({ "conf.yaml": "name: app\nservices:\n  web:\n    image: nginx\n" });
  assert.ok(graph.meta.languages.includes("yaml"), "languages include yaml");
  assert.equal(nodeById(graph, "conf.yaml#name")?.kind, "variable");
  assert.equal(nodeById(graph, "conf.yaml#services.web")?.kind, "variable");
  assert.equal(nodeById(graph, "conf.yaml#services.web.image")?.kind, "variable");
});

test("Markdown breadth: headings become scoped heading nodes", { skip: grammarAvailable("markdown") ? false : "markdown grammar not built" }, async () => {
  const graph = await build({ "doc.md": "# Title\n\nintro\n\n## Section A\n\ntext\n\n### Sub\n" });
  assert.ok(graph.meta.languages.includes("markdown"), "languages include markdown");
  assert.equal(nodeById(graph, "doc.md#Title")?.kind, "heading");
  assert.equal(nodeById(graph, "doc.md#Title.Section A")?.kind, "heading");
  assert.equal(nodeById(graph, "doc.md#Title.Section A.Sub")?.kind, "heading");
});

test("SCSS breadth: rules/mixins/variables + @include call edge", { skip: grammarAvailable("scss") ? false : "scss grammar not built" }, async () => {
  const graph = await build({ "a.scss": "$c: red;\n@mixin box($p){ padding: $p; }\n.foo { @include box(1px); color: $c; }\n" });
  assert.ok(graph.meta.languages.includes("scss"), "languages include scss");
  assert.equal(nodeById(graph, "a.scss#$c")?.kind, "variable");
  assert.equal(nodeById(graph, "a.scss#box")?.kind, "function");
  assert.equal(nodeById(graph, "a.scss#.foo")?.kind, "rule");
  assert.ok(hasEdge(graph, "calls", "a.scss#.foo", "a.scss#box"), "@include box → mixin box resolves");
});

test("CSV breadth: header columns become variable nodes", { skip: grammarAvailable("csv") ? false : "csv grammar not built" }, async () => {
  const graph = await build({ "data.csv": "id,name,age\n1,ann,30\n2,bob,25\n" });
  assert.ok(graph.meta.languages.includes("csv"), "languages include csv");
  assert.equal(nodeById(graph, "data.csv#id")?.kind, "variable");
  assert.equal(nodeById(graph, "data.csv#name")?.kind, "variable");
  assert.equal(nodeById(graph, "data.csv#age")?.kind, "variable");
});

test("CMake depth: functions, macros, targets, calls, target links and includes", { skip: grammarAvailable("cmake") ? false : "cmake grammar not built" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-cmake-"));
  try {
    mkdirSync(join(dir, "cmake"));
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "CMakeLists.txt"),
      [
        "cmake_minimum_required(VERSION 3.20)",
        "project(Demo LANGUAGES CXX)",
        "include(Helpers)",
        "include(CTest)",
        'option(DEMO_TESTS "Build tests" ON)',
        "function(add_demo name)",
        '  message(STATUS "adding ${name}")',
        "  helper_fn(${name})",
        "endfunction()",
        "add_subdirectory(src)",
        "add_executable(app main.cpp)",
        "target_link_libraries(app PRIVATE core Threads::Threads)",
        "add_demo(app)",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "cmake", "Helpers.cmake"), "MACRO(Helper_Fn x)\n  set(${x}_done ON)\nENDMACRO()\n");
    writeFileSync(join(dir, "src", "CMakeLists.txt"), "add_library(core STATIC core.cpp)\nadd_library(demo::core ALIAS core)\n");
    writeFileSync(join(dir, "notes.txt"), "not cmake\n");
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.deepEqual(graph.meta.languages, ["cmake"], "only the CMake files are indexed, not notes.txt");
    assert.equal(nodeById(graph, "CMakeLists.txt#add_demo")?.kind, "function");
    assert.equal(nodeById(graph, "CMakeLists.txt#add_demo")?.span, "L6-L9", "spans to endfunction()");
    assert.equal(nodeById(graph, "cmake/Helpers.cmake#helper_fn")?.kind, "function", "a macro, keyed in lower case");
    assert.equal(nodeById(graph, "cmake/Helpers.cmake#helper_fn")?.signature, "MACRO(Helper_Fn x)", "signature as written");
    assert.equal(nodeById(graph, "CMakeLists.txt#app")?.kind, "target");
    assert.equal(nodeById(graph, "src/CMakeLists.txt#core")?.kind, "target");
    assert.equal(nodeById(graph, "CMakeLists.txt#DEMO_TESTS")?.kind, "variable");

    assert.ok(hasEdge(graph, "calls", "CMakeLists.txt", "CMakeLists.txt#add_demo"), "a top-level call");
    assert.ok(hasEdge(graph, "calls", "CMakeLists.txt#add_demo", "cmake/Helpers.cmake#helper_fn"), "case-insensitive call across files");
    assert.ok(hasEdge(graph, "references", "CMakeLists.txt#app", "src/CMakeLists.txt#core"), "target_link_libraries");
    assert.ok(hasEdge(graph, "references", "src/CMakeLists.txt#demo::core", "src/CMakeLists.txt#core"), "ALIAS");
    assert.ok(hasEdge(graph, "imports", "CMakeLists.txt", "cmake/Helpers.cmake"), "include(Helpers) → the unique Helpers.cmake");
    assert.ok(hasEdge(graph, "imports", "CMakeLists.txt", "src/CMakeLists.txt"), "add_subdirectory(src)");
    assert.ok(hasEdge(graph, "imports", "CMakeLists.txt", "CTest"), "a CMake-shipped module stays its name");
    const targets = new Set(graph.edges.map((e) => e.target));
    for (const name of ["Threads::Threads", "message", "set", "project"]) {
      assert.ok(![...targets].some((t) => t.endsWith(`#${name}`)), `${name} resolves to nothing`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Build a repo from a `path → source` map (subdirectories included) and return its graph. */
async function buildTree(files: Record<string, string>): Promise<GraphV1> {
  const dir = mkdtempSync(join(tmpdir(), "graft-lang-"));
  try {
    for (const [name, src] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), src);
    }
    await buildGraph(dir);
    return readGraph(wiringPath(join(dir, "graft")))!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Bash depth: functions, calls across sourced scripts, source imports", { skip: grammarAvailable("bash") ? false : "bash grammar not built" }, async () => {
  const graph = await buildTree({
    "scripts/deploy.sh": [
      "#!/bin/bash",
      "source ./lib/util.sh",
      '. "$HOME/.profile"',
      "function deploy() {",
      '  local target="$1"',
      '  log_info "deploying $target"',
      "  build_all",
      "}",
      "build_all() {",
      "  make -j4 && run_tests",
      "}",
      "deploy prod",
      "",
    ].join("\n"),
    "scripts/lib/util.sh": 'log_info() { echo "[info] $*"; }\nrun_tests() { log_info tests; }\n',
    "notes.txt": "not a script\n",
  });
  assert.deepEqual(graph.meta.languages, ["bash"]);
  assert.equal(nodeById(graph, "scripts/deploy.sh#deploy")?.kind, "function");
  assert.equal(nodeById(graph, "scripts/deploy.sh#deploy")?.span, "L4-L8");
  assert.equal(nodeById(graph, "scripts/deploy.sh#deploy")?.signature, "function deploy()");
  assert.equal(nodeById(graph, "scripts/deploy.sh#build_all")?.signature, "build_all()");
  assert.ok(hasEdge(graph, "calls", "scripts/deploy.sh", "scripts/deploy.sh#deploy"), "a top-level call");
  assert.ok(hasEdge(graph, "calls", "scripts/deploy.sh#deploy", "scripts/deploy.sh#build_all"));
  assert.ok(hasEdge(graph, "calls", "scripts/deploy.sh#deploy", "scripts/lib/util.sh#log_info"), "into a sourced script");
  assert.ok(hasEdge(graph, "calls", "scripts/deploy.sh#build_all", "scripts/lib/util.sh#run_tests"), "after && too");
  assert.ok(hasEdge(graph, "imports", "scripts/deploy.sh", "scripts/lib/util.sh"), "source, relative to the script");
  assert.ok(hasEdge(graph, "imports", "scripts/deploy.sh", "$HOME/.profile"), "an expansion stays the raw path");
  assert.ok(!graph.edges.some((e) => e.relation === "calls" && /#(make|echo|local)$/.test(e.target)), "external commands drop");
});

test("Perl depth: packages, subs, typed method calls, use/require, use parent", { skip: grammarAvailable("perl") ? false : "perl grammar not built" }, async () => {
  const graph = await buildTree({
    "lib/My/Base.pm": [
      "package My::Base;",
      "use strict;",
      "sub new { my ($class, %a) = @_; my $self = bless {%a}, $class; $self->init; return $self; }",
      "sub init { 1 }",
      "1;",
      "",
    ].join("\n"),
    "lib/My/App.pm": [
      "package My::App;",
      "use strict;",
      "use warnings;",
      "use parent -norequire, 'My::Base';",
      "use My::Util qw(helper);",
      "use JSON::PP;",
      "sub init {",
      "  my $self = shift;",
      "  helper(1);",
      '  My::Util::log_it("x");',
      "  $self->_setup;",
      "}",
      "sub _setup { return 1 }",
      "1;",
      "",
    ].join("\n"),
    "lib/My/Util.pm": "package My::Util;\nour @ISA = ('Exporter');\nsub helper { log_it(\"h\") }\nsub log_it { print @_ }\n1;\n",
    "t/app.t": 'use My::App;\nmy $app = My::App->new(name => "x");\nprint "ok\\n";\n',
  });
  assert.deepEqual(graph.meta.languages, ["perl"]);
  assert.equal(nodeById(graph, "lib/My/App.pm#My::App")?.kind, "package");
  assert.equal(nodeById(graph, "lib/My/App.pm#My::App")?.span, "L1-L14", "a `package X;` runs to the end of its region");
  const init = nodeById(graph, "lib/My/App.pm#My::App::init");
  assert.equal(init?.kind, "method");
  assert.equal(init?.owner, "My::App");
  assert.equal(init?.span, "L7-L12");
  assert.equal(nodeById(graph, "lib/My/App.pm#My::App::_setup")?.exported, false, "a leading underscore is private");
  assert.ok(nodeById(graph, "lib/My/Base.pm#My::Base::init"), "same sub name in two packages: two ids");

  assert.ok(hasEdge(graph, "imports", "lib/My/App.pm", "lib/My/Util.pm"), "use My::Util → lib/My/Util.pm");
  assert.ok(hasEdge(graph, "imports", "lib/My/App.pm", "JSON::PP"), "a CPAN module stays its name");
  assert.ok(!graph.edges.some((e) => e.relation === "imports" && /^(strict|warnings|parent)$/.test(e.target)), "pragmas are not imports");
  assert.ok(hasEdge(graph, "imports", "t/app.t", "lib/My/App.pm"));
  assert.ok(hasEdge(graph, "extends", "lib/My/App.pm#My::App", "lib/My/Base.pm#My::Base"), "use parent");
  assert.ok(hasEdge(graph, "extends", "lib/My/Util.pm#My::Util", "Exporter"), "@ISA, external base kept by name");

  assert.ok(hasEdge(graph, "calls", "lib/My/App.pm#My::App::init", "lib/My/Util.pm#My::Util::helper"), "imported bare call");
  assert.ok(hasEdge(graph, "calls", "lib/My/App.pm#My::App::init", "lib/My/Util.pm#My::Util::log_it"), "Pkg::sub(...)");
  assert.ok(hasEdge(graph, "calls", "lib/My/App.pm#My::App::init", "lib/My/App.pm#My::App::_setup"), "$self->m");
  assert.ok(hasEdge(graph, "calls", "lib/My/Base.pm#My::Base::new", "lib/My/Base.pm#My::Base::init"), "$self->m in the base");
  assert.ok(hasEdge(graph, "calls", "t/app.t", "lib/My/Base.pm#My::Base::new"), "Pkg->new walks use parent to the base");
  assert.ok(!hasEdge(graph, "calls", "lib/My/Base.pm#My::Base::new", "lib/My/App.pm#My::App::init"), "$self->init stays in its own package");
});

test("Make depth: targets, prerequisites, variables, defines, includes, recursive make", { skip: grammarAvailable("make") ? false : "make grammar not built" }, async () => {
  const graph = await buildTree({
    Makefile: [
      "include mk/common.mk",
      "-include $(wildcard *.d)",
      "CC := gcc",
      "OBJS = main.o util.o",
      "define compile",
      "\t$(CC) $(CFLAGS) -c $< -o $@",
      "endef",
      ".PHONY: all clean",
      "all: app docs",
      "app: $(OBJS) libcore.a",
      "\t$(CC) -o $@ $^",
      "\t$(MAKE) -C sub install",
      "%.o: %.c",
      "\t$(call compile)",
      "libcore.a: ; ar rcs $@",
      "docs clean:: | build",
      "\trm -rf build",
      "build:",
      "\tmkdir -p $@",
      "ifeq ($(OS),Windows_NT)",
      "win: app",
      "endif",
      "",
    ].join("\n"),
    "mk/common.mk": "CFLAGS ?= -O2 -Wall\n",
    "sub/Makefile": "install:\n\tcp x /usr/local/bin\n",
    "Makefile.am": "bin_PROGRAMS = app\n",
  });
  assert.deepEqual(graph.meta.languages, ["make"], "Makefile.am (automake) is not claimed");
  const app = nodeById(graph, "Makefile#app");
  assert.equal(app?.kind, "target");
  assert.equal(app?.span, "L10-L12", "a rule spans its recipe, not the next line");
  assert.equal(app?.signature, "app: $(OBJS) libcore.a");
  assert.equal(nodeById(graph, "Makefile#build")?.span, "L18-L19", "a conditional after a recipe is not part of it");
  assert.equal(nodeById(graph, "Makefile#win")?.kind, "target", "a rule inside a conditional");
  assert.ok(nodeById(graph, "Makefile#docs") && nodeById(graph, "Makefile#clean"), "every target of a multi-target rule");
  assert.equal(nodeById(graph, "Makefile#.PHONY"), undefined, "special targets are not targets");
  assert.equal(nodeById(graph, "Makefile#CC")?.kind, "variable");
  assert.equal(nodeById(graph, "Makefile#compile")?.kind, "function");

  assert.ok(hasEdge(graph, "references", "Makefile#all", "Makefile#app"), "prerequisite → target");
  assert.ok(hasEdge(graph, "references", "Makefile#app", "Makefile#libcore.a"));
  assert.ok(hasEdge(graph, "references", "Makefile#docs", "Makefile#build"), "order-only prerequisite");
  assert.ok(hasEdge(graph, "references", "Makefile#win", "Makefile#app"));
  assert.ok(hasEdge(graph, "references", "Makefile#app", "Makefile#OBJS"), "$(OBJS) in the prerequisites");
  assert.ok(hasEdge(graph, "references", "Makefile#app", "Makefile#CC"), "$(CC) in the recipe");
  assert.ok(hasEdge(graph, "calls", "Makefile#%.o", "Makefile#compile"), "$(call compile)");
  assert.ok(hasEdge(graph, "references", "Makefile#compile", "mk/common.mk#CFLAGS"), "a define body, into an included file");
  assert.ok(hasEdge(graph, "imports", "Makefile", "mk/common.mk"), "include");
  assert.ok(hasEdge(graph, "imports", "Makefile", "sub/Makefile"), "$(MAKE) -C sub");
  assert.ok(!graph.edges.some((e) => /#(main\.o|util\.o|MAKE|OS)$/.test(e.target)), "source files and make's own variables drop");
});

test("MATLAB depth: classdef, methods, properties, local/nested functions, packages, class folders, calls", { skip: grammarAvailable("matlab") ? false : "matlab grammar not built" }, async () => {
  const graph = await buildTree({
    "src/+geom/Base.m": [
      "classdef Base < handle",
      "    methods",
      "        function describe(obj)",
      "            disp(class(obj));",
      "        end",
      "    end",
      "end",
      "",
    ].join("\n"),
    "src/@Shape/Shape.m": [
      "classdef Shape < geom.Base & matlab.mixin.Copyable",
      "    % SHAPE a shape",
      "    properties (Access = public)",
      '        Name string = "x"',
      "    end",
      "    properties (Constant)",
      "        MaxSize = 10",
      "    end",
      "    methods",
      "        function obj = Shape(name)",
      "            obj.Name = name;",
      "            obj.validate();",
      "            name.describe();",
      "        end",
      "        function v = get.Name(obj)",
      "            v = obj.Name;",
      "        end",
      "        function a = area(obj)",
      "            a = computeArea(obj.Name, 2);",
      '            pkg.util.log("area");',
      "            obj.describe();",
      "        end",
      "        r = externalMethod(obj, x)",
      "    end",
      "    methods (Static)",
      "        function s = create(varargin)",
      "            s = Shape(varargin{:});",
      "        end",
      "    end",
      "    methods (Access = private)",
      "        function validate(obj)",
      "            disp hello",
      "        end",
      "    end",
      "end",
      "",
    ].join("\n"),
    "src/@Shape/externalMethod.m": "function r = externalMethod(obj, x)\nr = obj.area() * x;\nend\n",
    "src/computeArea.m": [
      "function a = computeArea(name, k)",
      "%COMPUTEAREA the area",
      "import pkg.util.log",
      "scale = [1 2 3];",
      "a = localHelper(k) * scale(2);",
      "b = nested(3);",
      "f = @localHelper;",
      "    function y = nested(z)",
      "        y = z + 1;",
      "    end",
      "end",
      "",
      "function r = localHelper(v)",
      "r = v .^ 2;",
      "end",
      "",
    ].join("\n"),
    "src/scale.m": "function s = scale(x)\ns = 2 * x;\nend\n",
    "src/+pkg/+util/log.m": "function log(msg)\nfprintf('%s\\n', msg);\nend\n",
    "scripts/runme.m": [
      "% a script",
      "s = Shape.create('sq');",
      "v = computeArea('sq', 3);",
      "w = localFn(4);",
      "plot(v, Verbose=true);",
      "",
      "function out = localFn(x)",
      "out = x + 1;",
      "end",
      "",
    ].join("\n"),
    "src/Verbose.m": "function Verbose()\nend\n",
    "other/caller.m": "function caller()\nlocalHelper(1);\nnested(2);\nlog('x');\ncomputeArea('a', 1);\nend\n",
    "other/importer.m": "function importer()\nimport pkg.util.*\nlog('x');\nend\n",
    "objc/Widget.m": '#import "Widget.h"\n@implementation Widget\n- (void)draw { }\n@end\n',
  });
  assert.deepEqual(graph.meta.languages, ["matlab"]);

  const shape = nodeById(graph, "src/@Shape/Shape.m#Shape");
  assert.equal(shape?.kind, "class");
  assert.equal(shape?.signature, "classdef Shape < geom.Base & matlab.mixin.Copyable");
  assert.equal(nodeById(graph, "src/@Shape/Shape.m#Shape.Name")?.kind, "variable");
  assert.equal(nodeById(graph, "src/@Shape/Shape.m#Shape.MaxSize")?.kind, "constant");
  const area = nodeById(graph, "src/@Shape/Shape.m#Shape.area");
  assert.equal(area?.kind, "method");
  assert.equal(area?.owner, "Shape");
  assert.equal(area?.span, "L18-L22");
  assert.equal(area?.signature, "function a = area(obj)");
  assert.equal(nodeById(graph, "src/@Shape/Shape.m#Shape.get.Name")?.kind, "method", "a property accessor keeps its get. prefix");
  assert.equal(nodeById(graph, "src/@Shape/Shape.m#Shape.Name~2"), undefined, "the accessor does not collide with the property");
  assert.equal(nodeById(graph, "src/@Shape/Shape.m#Shape.validate")?.exported, false, "a private methods block");
  assert.equal(nodeById(graph, "src/@Shape/Shape.m#Shape.externalMethod"), undefined, "a bare signature is not a definition");
  const ext = nodeById(graph, "src/@Shape/externalMethod.m#Shape.externalMethod");
  assert.equal(ext?.kind, "method", "a function file in a class folder is a method");
  assert.equal(ext?.owner, "Shape");

  assert.equal(nodeById(graph, "src/computeArea.m#computeArea")?.exported, true);
  assert.equal(nodeById(graph, "src/computeArea.m#computeArea")?.signature, "function a = computeArea(name, k)", "the help comment is not the signature");
  assert.equal(nodeById(graph, "src/computeArea.m#localHelper")?.exported, false, "a local function");
  assert.equal(nodeById(graph, "src/computeArea.m#computeArea.nested")?.kind, "function", "a nested function");
  assert.equal(nodeById(graph, "scripts/runme.m#localFn")?.exported, false, "a script's local function");
  assert.ok(!graph.nodes.some((n) => n.path === "objc/Widget.m" && n.kind !== "file"), "Objective-C .m files get no MATLAB symbols");

  assert.ok(hasEdge(graph, "extends", "src/@Shape/Shape.m#Shape", "src/+geom/Base.m#Base"), "classdef < pkg.Base");
  assert.ok(hasEdge(graph, "extends", "src/@Shape/Shape.m#Shape", "Copyable"), "an external base is kept by name");
  assert.ok(hasEdge(graph, "imports", "src/computeArea.m", "src/+pkg/+util/log.m"), "import pkg.util.log");

  assert.ok(hasEdge(graph, "calls", "src/@Shape/Shape.m#Shape.Shape", "src/@Shape/Shape.m#Shape.validate"), "obj.m() on a constructor's output");
  assert.ok(hasEdge(graph, "calls", "src/@Shape/Shape.m#Shape.area", "src/computeArea.m#computeArea"), "a function in another file");
  assert.ok(hasEdge(graph, "calls", "src/@Shape/Shape.m#Shape.area", "src/+pkg/+util/log.m#log"), "pkg.util.log()");
  assert.ok(hasEdge(graph, "calls", "src/@Shape/Shape.m#Shape.area", "src/+geom/Base.m#Base.describe"), "an inherited method");
  assert.ok(hasEdge(graph, "calls", "src/@Shape/Shape.m#Shape.create", "src/@Shape/Shape.m#Shape"), "a constructor call");
  assert.ok(hasEdge(graph, "calls", "src/@Shape/externalMethod.m#Shape.externalMethod", "src/@Shape/Shape.m#Shape.area"), "obj.m() in a class-folder method");
  assert.ok(hasEdge(graph, "calls", "src/computeArea.m#computeArea", "src/computeArea.m#localHelper"), "a local function");
  assert.ok(hasEdge(graph, "calls", "src/computeArea.m#computeArea", "src/computeArea.m#computeArea.nested"), "a nested function");
  assert.ok(!hasEdge(graph, "calls", "src/computeArea.m#computeArea", "src/scale.m#scale"), "indexing a variable is not a call");
  assert.ok(hasEdge(graph, "calls", "scripts/runme.m", "src/@Shape/Shape.m#Shape.create"), "Cls.staticMethod()");
  assert.ok(hasEdge(graph, "calls", "scripts/runme.m", "src/computeArea.m#computeArea"));
  assert.ok(hasEdge(graph, "calls", "scripts/runme.m", "scripts/runme.m#localFn"));
  assert.ok(!graph.edges.some((e) => e.relation === "calls" && /#(disp|fprintf|class)$/.test(e.target)), "builtins drop");
  assert.ok(!hasEdge(graph, "calls", "src/@Shape/Shape.m#Shape.Shape", "src/+geom/Base.m#Base.describe"), "a constructor's argument is not an instance");
  assert.ok(!hasEdge(graph, "calls", "scripts/runme.m", "src/Verbose.m#Verbose"), "a Name=Value option name is not a call");
  assert.ok(hasEdge(graph, "calls", "other/caller.m#caller", "src/computeArea.m#computeArea"), "another file's own function");
  assert.ok(!graph.edges.some((e) => e.relation === "calls" && e.source === "other/caller.m#caller" && e.target !== "src/computeArea.m#computeArea"),
    "local, nested and un-imported package functions of other files are out of reach");
  assert.ok(hasEdge(graph, "calls", "other/importer.m#importer", "src/+pkg/+util/log.m#log"), "a package function imported with import pkg.util.*");
});

test("C++ header: a .h with a class is parsed as C++, not C", { skip: grammarAvailable("cpp") ? false : "cpp grammar not built" }, async () => {
  const graph = await build({ "widget.h": "class Widget {\npublic:\n  int area();\n};\n" });
  assert.equal(nodeById(graph, "widget.h#Widget")?.kind, "class");
  // The banner label follows the same content sniff the extractor made — it used
  // to read the extension only, so a C++-only header set reported as `c`.
  assert.ok(graph.meta.languages.includes("cpp"), "languages include cpp");
  assert.ok(!graph.meta.languages.includes("c"), "languages do NOT include c");
});

test("C header: a .h with no C++ constructs stays C", { skip: grammarAvailable("c") ? false : "c grammar not built" }, async () => {
  const graph = await build({ "util.h": "int helper(int x);\nstruct Point { int x; };\n" });
  assert.ok(graph.meta.languages.includes("c"), "languages include c");
  assert.ok(!graph.meta.languages.includes("cpp"), "languages do NOT include cpp");
});

// The sniff reads code only: C++ words in comments and strings, and C++ kept
// behind `#ifdef __cplusplus` (the usual guard of a C header), do not count.
// Sending such a C header to the C++ grammar made it parse worse, not better.
test("C header: C++ words in comments, strings or __cplusplus branches keep a .h C", { skip: grammarAvailable("c") && grammarAvailable("cpp") ? false : "c/cpp grammar not built" }, async () => {
  const graph = await build({
    "comment.h": "/* this class of helpers: new values, delete old ones */\n// namespace std::vector\nint helper(int x);\n",
    "string.h": 'static const char *msg = "class Foo { public: };";\nint use(void);\n',
    "guard.h": "#ifdef __cplusplus\r\nnamespace api { class Wrap; }\r\nextern \"C\" {\r\n#endif\r\nstruct Api { int a; };\r\n#ifdef __cplusplus\r\n}\r\n#endif\r\n",
    "template.h": "#define LIST(T) T##_list\nint new_count; int delete_flag;\nint value = a < b;\n",
  });
  assert.ok(!graph.meta.languages.includes("cpp"), `languages do NOT include cpp: ${graph.meta.languages.join(",")}`);
  assert.equal(nodeById(graph, "guard.h#Api")?.kind, "struct");
  assert.equal(nodeById(graph, "guard.h")?.parse_errors, undefined, "the C view of guard.h reads whole");
});

// A header whose classes all sit behind `#ifdef __cplusplus` stays labelled C,
// but its C parse fails on them: it is parsed as C++ too, and the better parse kept.
test("C header: classes behind #ifdef __cplusplus that C cannot read are parsed as C++", { skip: grammarAvailable("c") && grammarAvailable("cpp") ? false : "c/cpp grammar not built" }, async () => {
  const graph = await build({
    "logger.h":
      "#ifdef __cplusplus\n#include <string>\nclass TLog {\npublic:\n  virtual std::string Line(void) = 0;\n  virtual ~TLog() {}\n};\nclass TFile : public TLog {\npublic:\n  std::string Line(void) override;\n};\n#endif\n",
  });
  assert.equal(nodeById(graph, "logger.h")?.parse_errors, undefined, "logger.h reads whole as C++");
  assert.ok(graph.nodes.some((n) => n.path === "logger.h" && n.name === "TFile"), "TFile is found");
});

// C++ that no keyword gives away (direct initialization) is tried as C++ too.
test("C header: C++ without C++ keywords that C cannot read is parsed as C++", { skip: grammarAvailable("c") && grammarAvailable("cpp") ? false : "c/cpp grammar not built" }, async () => {
  const graph = await build({
    "masks.h": "#include \"types.h\"\nconst uint64 Init_mask    ((uint64) 0x1000000000000009);\nconst uint64 Neutral_mask ((uint64) 0x1000000000000001);\n",
  });
  assert.equal(nodeById(graph, "masks.h")?.parse_errors, undefined, "masks.h reads whole as C++");
});

// A `.h` that is a list of file names, not code, is a file node without errors.
test("C header: a .h without any C punctuation is not parsed", { skip: grammarAvailable("c") ? false : "c grammar not built" }, async () => {
  const graph = await build({ "files.h": "App_Int.h\nMemMap.h\nApp_Int.h\n" });
  assert.ok(nodeById(graph, "files.h"), "files.h is indexed");
  assert.equal(nodeById(graph, "files.h")?.parse_errors, undefined, "files.h carries no parse errors");
});

// A header that closes, behind `#ifdef __cplusplus`, an `extern "C" {` opened in
// another header: a C compiler never sees the stray brace, and neither does the C view.
test("C header: a stray } in an #ifdef __cplusplus branch does not break the file", { skip: grammarAvailable("c") ? false : "c grammar not built" }, async () => {
  const src = "#ifndef OS_H\r\n#define OS_H\r\n/* lock */\r\nstatic int OS_Lock(int x) { return x; }\r\n#define OS_SET(a) do { (a) = 1; } while (0)\r\n#ifdef __cplusplus\r\n} /* extern \"C\"\r\n */\r\n#endif\r\n#endif\r\n";
  const graph = await build({ "os.h": src });
  assert.equal(nodeById(graph, "os.h")?.parse_errors, undefined, "os.h reads whole as C");
  assert.equal(nodeById(graph, "os.h#OS_Lock")?.kind, "function");
  assert.equal(nodeById(graph, "os.h")?.chars, src.length, "the file node describes the file, not the view");
});

// Saved grep output (`App.c:#include "App.h"` lines) is not code either.
test("C header: a .h holding grep output is not parsed", { skip: grammarAvailable("c") ? false : "c grammar not built" }, async () => {
  const graph = await build({
    "hits.h": 'App.c:#include "App_Int.h"\r\nApp.c:#include "MemMap.h"\r\nsrc/Init.c:12:#include "App_Int.h",x.h,\r\n',
    "real.h": "struct S { int a; };\nint f(void);\nint g(void);\n",
  });
  assert.equal(nodeById(graph, "hits.h")?.parse_errors, undefined, "hits.h carries no parse errors");
  assert.ok(!graph.nodes.some((n) => n.path === "hits.h" && n.id !== "hits.h"), "hits.h is a file node only");
  assert.equal(nodeById(graph, "real.h#S")?.kind, "struct", "a real header is still parsed");
});

// A header whose last `#if` is never closed is still read whole: the `#endif`
// missing at the end of the file is not counted as a syntax error.
test("C header: a missing #endif at the end of the file is not flagged", { skip: grammarAvailable("c") ? false : "c grammar not built" }, async () => {
  const graph = await build({
    "guard.h": "#ifndef GUARD_H\n#define GUARD_H\nint f(void) { return 1; }\n#if (A)\nint g(void);\n#endif\n/* end of file */\n",
    "branch.h": "#ifdef X\nint h(void);\n#else\nint k(void);\n#endif\n#ifdef USED_AS_HEADER\nint m(void);\n#else\nint n(void);\n/* GUARD */\n",
    "bad.h": "#ifndef BAD_H\nint broken(void) { return 1 +; }\n",
  });
  assert.equal(nodeById(graph, "guard.h")?.parse_errors, undefined, "guard.h carries no flag");
  assert.equal(nodeById(graph, "guard.h#f")?.kind, "function");
  assert.equal(nodeById(graph, "branch.h")?.parse_errors, undefined, "an #else never closed carries no flag");
  assert.ok((nodeById(graph, "bad.h")?.parse_errors ?? 0) >= 1, "other errors in such a file are still flagged");
});

test("C++ header: namespace, std:: or a template sends a .h to C++", { skip: grammarAvailable("cpp") ? false : "cpp grammar not built" }, async () => {
  for (const src of [
    "namespace app {\nint run();\n}\n",
    "#include <vector>\nint count(const std::vector<int> &v);\n",
    "template <typename T>\nT max_of(T a, T b);\n",
    'extern "C" API void step(const double& dt);\n',
  ]) {
    const graph = await build({ "api.h": src });
    assert.deepEqual(graph.meta.languages, ["cpp"], src);
  }
});

// A file the parser could not read whole says so on its file node, and the
// readers built on the graph pass that on. A clean file carries nothing.
test("C depth: a file with syntax errors is flagged parse_errors", { skip: grammarAvailable("c") ? false : "c grammar not built" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-lang-"));
  try {
    writeFileSync(join(dir, "broken.c"), "int ok(void) { return 1; }\nint broken(void) { return ok() +; }\n");
    writeFileSync(join(dir, "clean.c"), "int fine(void) { return ok(); }\n");
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const broken = nodeById(graph, "broken.c");
    assert.ok((broken?.parse_errors ?? 0) >= 1, `broken.c flagged: ${broken?.parse_errors}`);
    assert.equal(nodeById(graph, "clean.c")?.parse_errors, undefined, "clean.c carries no flag");
    assert.equal(nodeById(graph, "broken.c#ok")?.parse_errors, undefined, "symbols carry no flag of their own");

    const { skeleton, formatSkeleton, ask, formatAsk } = await import("../src/ask/ask.js");
    const sk = skeleton(dir, "broken.c");
    assert.equal(sk.parse_errors, broken?.parse_errors);
    assert.match(formatSkeleton(sk), /⚠ parsed with \d+ syntax errors?: symbols, calls or spans in this file may be missing/);
    assert.doesNotMatch(formatSkeleton(skeleton(dir, "clean.c")), /syntax error/);

    const r = ask(dir, "broken", { limit: 3 });
    const hit = r.hits.find((h) => h.pointer.startsWith("broken.c"));
    assert.ok(hit?.parse_errors, "the ask hit in broken.c is flagged");
    assert.match(formatAsk(r), /⚠ parsed with/);

    const { buildRepoMap, formatRepoMap } = await import("../src/graph/map.js");
    const map = buildRepoMap(graph);
    assert.equal(map.totals.parse_error_files, 1);
    assert.match(formatRepoMap(map), /⚠ 1 file was parsed with syntax errors/);

    const { headerOf, hitLine } = await import("../src/graph/traverse-cli.js");
    assert.match(headerOf(nodeById(graph, "broken.c#broken")!, graph), /\n  ⚠ parsed with/);
    assert.doesNotMatch(headerOf(nodeById(graph, "clean.c#fine")!, graph), /syntax error/);
    const okNode = nodeById(graph, "broken.c#ok")!;
    assert.match(hitLine("in", { id: okNode.id, node: okNode, relation: "calls", depth: 1 }, false, undefined, graph), /⚠ file parsed with/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// An empty XML file has no root element, which the grammar reads as an error;
// a blank file has nothing to get wrong, so it carries no flag.
test("XML depth: a blank file is not flagged parse_errors", { skip: grammarAvailable("xml") ? false : "xml grammar not built" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-lang-"));
  try {
    writeFileSync(join(dir, "main.py"), "def main():\n    return 1\n");
    writeFileSync(join(dir, "empty.xml"), "");
    writeFileSync(join(dir, "blank.xml"), "  \r\n\n");
    writeFileSync(join(dir, "broken.xml"), '<?xml version="1.0"?>\n<a>\n  <b>\n</a>\n');
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    assert.equal(nodeById(graph, "empty.xml")?.parse_errors, undefined, "empty.xml carries no flag");
    assert.equal(nodeById(graph, "blank.xml")?.parse_errors, undefined, "blank.xml carries no flag");
    assert.ok((nodeById(graph, "broken.xml")?.parse_errors ?? 0) >= 1, "an unclosed element is still flagged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

