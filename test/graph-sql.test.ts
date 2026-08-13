/**
 * Tests for SQL extraction in the Tier-1 code graph. The SQL grammar is an
 * optional native dependency; these tests skip when its binding isn't built.
 * They assert that CREATE TABLE/VIEW definitions are emitted with names,
 * including schema-qualified Oracle DDL recovered past its parse errors.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { sqlGrammarAvailable } from "../src/graph/extract.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const skip = sqlGrammarAvailable() ? false : "SQL grammar native binding not built";

const SCHEMA_SQL = `CREATE TABLE users (
  id INT PRIMARY KEY,
  name VARCHAR(100)
);

CREATE VIEW active_users AS SELECT id, name FROM users;

CREATE TABLE "CHM_PROD"."AFFECTED_PLANT" (
  "PLANT_ID" NUMBER(*,0) NOT NULL ENABLE,
  "CHANGE_ID" VARCHAR2(250 CHAR) NOT NULL ENABLE
) SEGMENT CREATION IMMEDIATE PCTFREE 10;
`;

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

test("SQL extraction: tables and views (incl. schema-qualified Oracle DDL)", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-sql-"));
  try {
    writeFileSync(join(dir, "schema.sql"), SCHEMA_SQL);
    const result = await buildGraph(dir); // $0, Tier-1 only
    assert.ok(result.languages.includes("sql"), "languages should include sql");

    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    assert.ok(graph, "wiring graph should be written");

    // standard DDL — one node per created object, named, public
    const users = nodeById(graph, "schema.sql#users");
    assert.equal(users?.kind, "table");
    assert.equal(users?.exported, true);
    assert.equal(nodeById(graph, "schema.sql#active_users")?.kind, "view");

    // Oracle DDL parses with errors, but the schema-qualified name is recovered
    // and stripped to the object name.
    assert.equal(nodeById(graph, "schema.sql#AFFECTED_PLANT")?.kind, "table");

    // the file is contained
    assert.ok(
      graph.edges.find((e) => e.relation === "contains" && e.source === "schema.sql" && e.target === "schema.sql#users"),
      "file should contain the users table node",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
