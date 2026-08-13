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
