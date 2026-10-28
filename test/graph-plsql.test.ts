/**
 * Tests for Oracle PL/SQL extraction via the tree-sitter-plsql grammar. That
 * grammar is an optional, locally-built native dependency; these tests skip
 * unless it is the active SQL dialect. They assert that packages, package
 * sub-programs, standalone procedures/functions, and tables are emitted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { sqlDialect } from "../src/graph/extract.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const skip = sqlDialect() === "plsql" ? false : "tree-sitter-plsql grammar not active";

const PLSQL = `CREATE OR REPLACE PACKAGE emp_pkg AS
  PROCEDURE hire(name IN VARCHAR2);
  FUNCTION count_all RETURN NUMBER;
END emp_pkg;

CREATE OR REPLACE PACKAGE BODY emp_pkg AS
  PROCEDURE hire(name IN VARCHAR2) IS BEGIN NULL; END;
  FUNCTION count_all RETURN NUMBER IS BEGIN RETURN 0; END;
END emp_pkg;

CREATE OR REPLACE PROCEDURE purge_old IS BEGIN NULL; END;

CREATE OR REPLACE FUNCTION add_one(x IN NUMBER) RETURN NUMBER IS BEGIN RETURN x+1; END;

CREATE TABLE "CHM_PROD"."AFFECTED_PLANT" ("PLANT_ID" NUMBER);
`;

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

test("PL/SQL extraction: packages, sub-programs, standalone procs/functions, tables", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-plsql-"));
  try {
    writeFileSync(join(dir, "pkg.sql"), PLSQL);
    const result = await buildGraph(dir); // $0, Tier-1 only
    assert.ok(result.languages.includes("sql"), "languages should include sql");

    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    assert.ok(graph, "wiring graph should be written");

    // package (spec) + its sub-programs, scoped under the package name
    assert.equal(nodeById(graph, "pkg.sql#emp_pkg")?.kind, "package");
    assert.equal(nodeById(graph, "pkg.sql#emp_pkg.hire")?.kind, "procedure");
    assert.equal(nodeById(graph, "pkg.sql#emp_pkg.count_all")?.kind, "function");

    // standalone program units
    assert.equal(nodeById(graph, "pkg.sql#purge_old")?.kind, "procedure");
    assert.equal(nodeById(graph, "pkg.sql#add_one")?.kind, "function");

    // DDL still works (schema qualifier stripped)
    assert.equal(nodeById(graph, "pkg.sql#AFFECTED_PLANT")?.kind, "table");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Build a throwaway repo from `files` and return its resolved `calls` edges as
 * "source -> target" strings (plus the confidence map for spot checks). */
async function callEdges(files: Record<string, string>): Promise<{ calls: Set<string>; conf: Map<string, string> }> {
  const dir = mkdtempSync(join(tmpdir(), "graft-plsql-calls-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const calls = new Set<string>();
    const conf = new Map<string, string>();
    for (const e of graph.edges) {
      if (e.relation !== "calls") continue;
      calls.add(`${e.source} -> ${e.target}`);
      conf.set(`${e.source} -> ${e.target}`, e.confidence);
    }
    return { calls, conf };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("PL/SQL calls: bare calls inside a package body resolve lexically", { skip }, async () => {
  const { calls, conf } = await callEdges({
    "util.sql": `CREATE OR REPLACE PACKAGE util_pkg AS
  PROCEDURE log_it(p VARCHAR2);
  FUNCTION calc(x NUMBER) RETURN NUMBER;
END util_pkg;
/
CREATE OR REPLACE PACKAGE BODY util_pkg AS
  PROCEDURE private_one IS BEGIN NULL; END;
  PROCEDURE log_it(p VARCHAR2) IS BEGIN private_one; END log_it;
  FUNCTION calc(x NUMBER) RETURN NUMBER IS
    PROCEDURE inner_helper IS BEGIN NULL; END;
    PROCEDURE private_one IS BEGIN NULL; END;
  BEGIN
    inner_helper;
    LOG_IT('upper case is the same name');
    private_one;
    RETURN x;
  END calc;
BEGIN
  log_it('package initialisation block');
END util_pkg;
/
`,
  });
  // a private (body-only) procedure, called with no arguments
  assert.ok(calls.has("util.sql#util_pkg.log_it~2 -> util.sql#util_pkg.private_one"), [...calls].join("\n"));
  // a nested helper, and case-insensitive names resolving to the BODY definition, not the spec declaration
  assert.ok(calls.has("util.sql#util_pkg.calc~2 -> util.sql#util_pkg.calc.inner_helper"));
  assert.ok(calls.has("util.sql#util_pkg.calc~2 -> util.sql#util_pkg.log_it~2"));
  assert.ok(!calls.has("util.sql#util_pkg.calc~2 -> util.sql#util_pkg.log_it"), "spec declaration is not the target");
  // the nested private_one shadows the package-level one
  assert.ok(calls.has("util.sql#util_pkg.calc~2 -> util.sql#util_pkg.calc.private_one"));
  assert.ok(!calls.has("util.sql#util_pkg.calc~2 -> util.sql#util_pkg.private_one"));
  // the package initialisation block calls too
  assert.ok(calls.has("util.sql#util_pkg~2 -> util.sql#util_pkg.log_it~2"));
  assert.equal(conf.get("util.sql#util_pkg~2 -> util.sql#util_pkg.log_it~2"), "extracted");
});

test("PL/SQL calls: package-qualified and standalone calls resolve across files", { skip }, async () => {
  const { calls, conf } = await callEdges({
    "util.pks": `CREATE OR REPLACE PACKAGE util_pkg AS
  PROCEDURE log_it(p VARCHAR2);
  FUNCTION calc(x NUMBER) RETURN NUMBER;
  PROCEDURE remote_only;
END util_pkg;
/
`,
    "util.pkb": `CREATE OR REPLACE PACKAGE BODY util_pkg AS
  PROCEDURE log_it(p VARCHAR2) IS BEGIN NULL; END;
  FUNCTION calc(x NUMBER) RETURN NUMBER IS BEGIN RETURN x; END;
  PROCEDURE remote_only IS BEGIN NULL; END;
END util_pkg;
/
`,
    "jobs.sql": `CREATE OR REPLACE PROCEDURE purge_old IS BEGIN NULL; END;
/
`,
    "caller.sql": `CREATE OR REPLACE PROCEDURE do_stuff IS
  v NUMBER;
BEGIN
  util_pkg.log_it('a');
  v := hr.util_pkg.calc(1);
  "UTIL_PKG"."LOG_IT"('quoted');
  util_pkg.remote_only@far_db;
  util_pkg.remote_only@far_db();
  DBMS_OUTPUT.PUT_LINE('built-in');
  purge_old;
END;
/
CREATE OR REPLACE PROCEDURE bare_only IS
BEGIN
  log_it('a bare name never reaches into another package');
END;
/
`,
  });
  const all = [...calls].join("\n");
  assert.ok(calls.has("caller.sql#do_stuff -> util.pkb#util_pkg.log_it"), all);
  assert.equal(conf.get("caller.sql#do_stuff -> util.pkb#util_pkg.log_it"), "inferred");
  assert.ok(calls.has("caller.sql#do_stuff -> util.pkb#util_pkg.calc"), "schema.pkg.fn() resolves to the body");
  assert.ok(calls.has("caller.sql#do_stuff -> jobs.sql#purge_old"), "a standalone procedure in another file");
  // a database-link call runs elsewhere: never an in-repo edge
  assert.ok(![...calls].some((c) => c.includes("remote_only")), all);
  // a bare name never reaches into another package's sub-programs
  assert.ok(![...calls].some((c) => c.startsWith("caller.sql#bare_only ")), all);
  // declarations in the spec are never targets while the body is in the repo
  assert.ok(![...calls].some((c) => c.includes("util.pks#")), all);
});

test("PL/SQL calls: a spec-only package resolves to its declarations", { skip }, async () => {
  const { calls } = await callEdges({
    "util.pks": `CREATE OR REPLACE PACKAGE util_pkg AS
  PROCEDURE log_it(p VARCHAR2);
END util_pkg;
/
`,
    "caller.sql": `CREATE OR REPLACE PROCEDURE do_stuff IS
BEGIN
  util_pkg.log_it('a');
  log_it('bare: not visible outside the package');
END;
/
`,
  });
  assert.deepEqual([...calls], ["caller.sql#do_stuff -> util.pks#util_pkg.log_it"]);
});

test("PL/SQL calls: overloads in one package drop rather than guess", { skip }, async () => {
  const { calls } = await callEdges({
    "p.sql": `CREATE OR REPLACE PACKAGE BODY p AS
  PROCEDURE put(x NUMBER) IS BEGIN NULL; END;
  PROCEDURE put(x VARCHAR2) IS BEGIN NULL; END;
  PROCEDURE run IS BEGIN put(1); END;
END p;
/
`,
  });
  assert.deepEqual([...calls], []);
});
