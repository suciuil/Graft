/**
 * Tests for C# extraction in the Tier-1 code graph. Builds a small C# project in
 * a temp dir and asserts the emitted nodes (classes, interfaces, structs, enums,
 * methods, constructors) and edges (calls, heritage, using imports) match the AST
 * walk in extract.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const API_CS = `namespace Api.Controllers;

using System;

public interface IRepo
{
    void Save();
}

public class UserController : ControllerBase, IRepo
{
    public UserController() { }

    public IActionResult Get(int id)
    {
        var u = Find(id);
        Save();
        return Ok(u);
    }

    public void Save() { }

    private object Find(int id) => null;
}

public enum Role { Admin, User }

public struct Point { public int X; }

public record Dto(string Name);
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-cs-"));
  writeFileSync(join(dir, "Api.cs"), API_CS);
  return dir;
}

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

test("C# extraction: classes, interfaces, structs, enums, records, methods", async () => {
  const dir = makeFixture();
  try {
    const result = await buildGraph(dir); // $0, Tier-1 only
    assert.ok(result.languages.includes("c#"), "languages should include c#");

    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    assert.ok(graph, "wiring graph should be written");

    // type declarations — namespaces are not scope segments, so ids are bare
    assert.equal(nodeById(graph, "Api.cs#UserController")?.kind, "class");
    assert.equal(nodeById(graph, "Api.cs#IRepo")?.kind, "interface");
    assert.equal(nodeById(graph, "Api.cs#Role")?.kind, "enum");
    assert.equal(nodeById(graph, "Api.cs#Point")?.kind, "struct");
    assert.equal(nodeById(graph, "Api.cs#Dto")?.kind, "class");

    // methods — nested under their class, owner stamped, exported by `public`
    const get = nodeById(graph, "Api.cs#UserController.Get");
    assert.equal(get?.kind, "method");
    assert.equal(get?.owner, "UserController");
    assert.equal(get?.exported, true);

    // a private method is not exported
    assert.equal(nodeById(graph, "Api.cs#UserController.Find")?.exported, false);

    // constructor is a method node named after its type
    assert.equal(nodeById(graph, "Api.cs#UserController.UserController")?.kind, "method");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C# extraction: call, heritage, and using-import edges", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // plain call resolves: Get() → Save()
    assert.ok(
      graph.edges.find(
        (e) => e.relation === "calls" && e.source === "Api.cs#UserController.Get" && e.target === "Api.cs#UserController.Save",
      ),
      "Get should have a resolved calls edge to Save",
    );

    // plain call resolves: Get() → Find()
    assert.ok(
      graph.edges.find(
        (e) => e.relation === "calls" && e.source === "Api.cs#UserController.Get" && e.target === "Api.cs#UserController.Find",
      ),
      "Get should have a resolved calls edge to Find",
    );

    // heritage: `IRepo` classified as an interface (I-prefix), `ControllerBase` as a base class
    assert.ok(
      graph.edges.find(
        (e) => e.relation === "implements" && e.source === "Api.cs#UserController" && e.target === "Api.cs#IRepo",
      ),
      "UserController implements IRepo",
    );
    assert.ok(
      graph.edges.find(
        (e) => e.relation === "extends" && e.source === "Api.cs#UserController" && e.target === "ControllerBase",
      ),
      "UserController extends ControllerBase (unresolved external base)",
    );

    // `using System;` is an external import string
    assert.ok(
      graph.edges.find((e) => e.relation === "imports" && e.source === "Api.cs" && e.target === "System"),
      "using System should remain an external import string",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
