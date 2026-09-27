/**
 * Tests for XML extraction, including .NET config (Web.config/App.config) and
 * MSBuild project files (.csproj/.props/.targets). The XML grammar is an optional,
 * locally-built native dependency; these tests skip when its binding isn't built.
 * They assert config entries (`<add key=…>`, `<add name=…>`), MSBuild items
 * (`<PackageReference Include=…>`), and container sections become element nodes
 * scoped under their enclosing element.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { grammarAvailable } from "../src/graph/extract.js";
import { checkGraph } from "../src/graph/check.js";
import type { CruxSummarizer } from "../src/ai/crux.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const skip = grammarAvailable("xml") ? false : "tree-sitter-xml grammar not built";

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

async function build(files: Record<string, string>): Promise<GraphV1> {
  const dir = mkdtempSync(join(tmpdir(), "graft-xml-"));
  try {
    for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
    await buildGraph(dir);
    return readGraph(wiringPath(join(dir, "graft")))!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WEB_CONFIG = `<?xml version="1.0"?>
<configuration>
  <appSettings>
    <add key="ApiUrl" value="https://x" />
    <add key="Timeout" value="30" />
  </appSettings>
  <connectionStrings>
    <add name="Default" connectionString="Server=." />
  </connectionStrings>
</configuration>
`;

test("XML/.NET config: appSettings + connectionStrings entries become scoped element nodes", { skip }, async () => {
  const graph = await build({ "Web.config": WEB_CONFIG });

  assert.ok(graph.meta.languages.includes("xml"), "languages should include xml");

  // container sections named by their tag
  assert.equal(nodeById(graph, "Web.config#configuration")?.kind, "element");
  assert.equal(nodeById(graph, "Web.config#configuration.appSettings")?.kind, "element");

  // config entries named by their key/name attribute, scoped under the section
  assert.equal(nodeById(graph, "Web.config#configuration.appSettings.ApiUrl")?.kind, "element");
  assert.equal(nodeById(graph, "Web.config#configuration.appSettings.Timeout")?.kind, "element");
  assert.equal(nodeById(graph, "Web.config#configuration.connectionStrings.Default")?.kind, "element");

  // the section contains its entry
  assert.ok(
    graph.edges.find(
      (e) =>
        e.relation === "contains" &&
        e.source === "Web.config#configuration.appSettings" &&
        e.target === "Web.config#configuration.appSettings.ApiUrl",
    ),
    "appSettings should contain the ApiUrl entry",
  );
});

test("XML/MSBuild: a .csproj PackageReference is keyed by its Include attribute", { skip }, async () => {
  const graph = await build({
    "App.csproj": `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
`,
  });
  assert.ok(graph.meta.languages.includes("xml"), "languages should include xml");
  assert.equal(nodeById(graph, "App.csproj#Project.ItemGroup.Newtonsoft.Json")?.kind, "element");
});

test("XML: an id'd element is indexed by its id", { skip }, async () => {
  const graph = await build({ "doc.xml": '<root><node id="n1"><leaf>text</leaf></node></root>' });
  assert.equal(nodeById(graph, "doc.xml#root")?.kind, "element");
  assert.equal(nodeById(graph, "doc.xml#root.n1")?.kind, "element");
});

test("XAML: elements keyed by namespaced x:Name/x:Key, labelled xaml", { skip }, async () => {
  const graph = await build({
    "MainWindow.xaml": `<Window x:Class="App.MainWindow">
  <Grid>
    <Button x:Name="okButton" Content="OK" />
    <TextBlock x:Name="title" />
  </Grid>
</Window>
`,
  });
  assert.ok(graph.meta.languages.includes("xaml"), "languages should include xaml");
  assert.equal(nodeById(graph, "MainWindow.xaml#Window.Grid")?.kind, "element");
  assert.equal(nodeById(graph, "MainWindow.xaml#Window.Grid.okButton")?.kind, "element");
  assert.equal(nodeById(graph, "MainWindow.xaml#Window.Grid.title")?.kind, "element");
});

test("XML is structural only: --deep never summarizes it and check does not count it pending", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-xml-deep-"));
  try {
    writeFileSync(join(dir, "Web.config"), WEB_CONFIG);
    writeFileSync(join(dir, "app.py"), "def run():\n    return 1\n");
    const asked: string[] = [];
    const summarizer: CruxSummarizer = {
      async describeFile(input) {
        asked.push(input.path);
        return input.nodes.map((n) => ({ id: n.id, summary: `does ${n.id}`, crux_start: 0, crux_end: 0 }));
      },
    };
    const r = await buildGraph(dir, { summarizer, concurrency: 1 });
    assert.deepEqual(asked, ["app.py"], "only the code file reaches the LLM");
    assert.equal(r.meaning.pending, 0, "XML nodes are not pending");

    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const xml = graph.nodes.filter((n) => n.path === "Web.config");
    assert.ok(xml.length > 1, "XML is still indexed structurally");
    for (const n of xml) {
      assert.equal(n.summary_state, "none", `${n.id} has no meaning tier`);
      assert.equal(n.summary, null);
    }
    assert.equal(nodeById(graph, "app.py#run")?.summary_state, "ready");

    const check = await checkGraph(dir);
    assert.ok(!check.pendingIds.some((id) => id.startsWith("Web.config")), "check never asks to summarize XML");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("XML: Web.config / App.config / packages.config are all indexed as xml", { skip }, async () => {
  const cfg = '<configuration><appSettings><add key="K" value="v" /></appSettings></configuration>';
  const graph = await build({ "Web.config": cfg, "App.config": cfg, "packages.config": cfg });
  assert.ok(graph.meta.languages.includes("xml"), "languages should include xml");
  assert.equal(nodeById(graph, "Web.config#configuration.appSettings.K")?.kind, "element");
  assert.equal(nodeById(graph, "App.config#configuration.appSettings.K")?.kind, "element");
  assert.equal(nodeById(graph, "packages.config#configuration.appSettings.K")?.kind, "element");
});

