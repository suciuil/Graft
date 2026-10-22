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

