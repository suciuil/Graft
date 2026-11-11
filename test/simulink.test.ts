/**
 * Simulink models (`.slx`) and data dictionaries (`.sldd`): the ZIP packages are
 * unpacked into text by readSourceFile (util/simulink-package.ts) and read by
 * graph/simulink.ts. The packages are built here, part by part, so the test needs no
 * MATLAB and no binary fixtures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { crc32, deflateRawSync } from "node:zlib";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { grammarAvailable, languageOf } from "../src/graph/extract.js";
import { parseXml } from "../src/util/xml.js";
import { packageParts, renderSimulinkPackage } from "../src/util/simulink-package.js";
import { readSourceFile } from "../src/util/source.js";
import { tooBigToIndex } from "../src/ingest/fs.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";
import type { ExtractEntry } from "../src/graph/extract-cache.js";

/** A ZIP archive of `parts` (deflated, or stored when `store`), as Simulink writes one. */
function zip(parts: Record<string, string | Buffer>, store = false): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(parts)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const packed = store ? data : deflateRawSync(data);
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(store ? 0 : 8, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const xml = (body: string): string => `<?xml version="1.0" encoding="utf-8"?>\n${body}\n`;

/** A model linked to `Ctrl_data.sldd`: a subsystem with a constant, a named signal, a
 * Stateflow chart, a Model block and a library link. */
const CTRL_SLX = zip({
  "[Content_Types].xml": xml("<Types/>"),
  "_rels/.rels": xml("<Relationships/>"),
  "metadata/thumbnail.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
  "simulink/systems/system_2.xml": xml(
    [
      "<System>",
      '  <Block BlockType="Inport" Name="u" SID="21"/>',
      '  <Block BlockType="Constant" Name="Gain&#xA;Const" SID="22">',
      '    <P Name="Value">Kp * 2</P>',
      '    <P Name="OutDataTypeStr">Bus: MyBus</P>',
      "  </Block>",
      '  <Block BlockType="SubSystem" Name="Chart" SID="23">',
      '    <P Name="SFBlockType">Chart</P>',
      '    <System Ref="system_23"/>',
      "  </Block>",
      '  <Block BlockType="ModelReference" Name="Plant" SID="24">',
      '    <P Name="ModelNameDialog">Plant.slx</P>',
      "  </Block>",
      '  <Block BlockType="Reference" Name="Filter" SID="25">',
      '    <P Name="SourceBlock">Lib/Low&#xA;Pass</P>',
      "  </Block>",
      '  <Block BlockType="SubSystem" Name="MATLAB Function" SID="26">',
      '    <P Name="SFBlockType">MATLAB Function</P>',
      '    <System Ref="system_26"/>',
      "  </Block>",
      '  <Line><P Name="Name">SigA</P><P Name="Src">21#out:1</P><P Name="Dst">22#in:1</P></Line>',
      "</System>",
    ].join("\n"),
  ),
  "simulink/systems/system_23.xml": xml('<System>\n  <Block BlockType="S-Function" Name=" SFunction " SID="23::1"/>\n</System>'),
  "simulink/systems/system_root.xml": xml(
    [
      "<System>",
      '  <Block BlockType="Inport" Name="SigA" SID="1"/>',
      '  <Block BlockType="SubSystem" Name="Controller" SID="2">',
      '    <P Name="Ports">[1, 1]</P>',
      '    <System Ref="system_2"/>',
      "  </Block>",
      '  <Block BlockType="Outport" Name="y" SID="3"><P Name="Port">1</P></Block>',
      '  <Line><P Name="Name">SigA</P><P Name="Src">1#out:1</P><P Name="Dst">2#in:1</P></Line>',
      "</System>",
    ].join("\n"),
  ),
  "simulink/blockdiagram.xml": xml(
    '<ModelInformation Version="1.0">\n  <Model>\n    <P Name="DataDictionary">Ctrl_data.sldd</P>\n  </Model>\n</ModelInformation>',
  ),
  "simulink/stateflow/chart_7.xml": xml(
    [
      '<chart id="7">',
      '  <P Name="name">Controller/Chart</P>',
      "  <Children>",
      '    <state SSID="1">',
      '      <P Name="labelString">Active&#10;en: y = helperFn(u) * Kp; % gain from the dictionary</P>',
      "    </state>",
      '    <data SSID="2" name="u"><P Name="scope">INPUT_DATA</P></data>',
      "  </Children>",
      "</chart>",
    ].join("\n"),
  ),
  "simulink/systems/system_26.xml": xml('<System>\n  <Block BlockType="S-Function" Name=" SFunction " SID="26::1"/>\n</System>'),
  "simulink/stateflow/chart_8.xml": xml(
    [
      '<chart id="8">',
      '  <P Name="name">Controller/MATLAB Function</P>',
      "  <Children>",
      '    <state SSID="1">',
      '      <P Name="labelString">eML_blk_kernel()</P>',
      "      <eml>",
      '        <P Name="isEML">1</P>',
      '        <P Name="script">function y = fcn(u)',
      "y = scale(helperFn(u)) * Kp;",
      "end",
      "",
      "function z = scale(v)",
      "z = 2 * v;",
      "end</P>",
      "      </eml>",
      "    </state>",
      '    <data SSID="2" name="u"><P Name="scope">INPUT_DATA</P></data>',
      "  </Children>",
      "</chart>",
    ].join("\n"),
  ),
});

const dictionaryXml = (entries: string[]): string =>
  xml(`<DataSource FormatVersion="1" MinRelease="R2014a">\n${entries.join("\n")}\n</DataSource>`);
const entry = (name: string, value: string): string =>
  [
    '    <Object Class="DD.ENTRY">',
    `        <P Name="Name" Class="char">${name}</P>`,
    '        <P Name="Value">',
    value,
    "        </P>",
    "    </Object>",
  ].join("\n");

const CTRL_SLDD = zip({
  "[Content_Types].xml": xml("<Types/>"),
  "metadata/coreProperties.xml": xml("<coreProperties/>"),
  "data/chunk0.xml": dictionaryXml([
    entry("Kp", '            <Element Class="Simulink.Parameter">\n                <P Name="Value" Class="double">1.5</P>\n                <P Name="DataType" Class="char">single</P>\n            </Element>'),
    entry("SigA", '            <Element Class="Simulink.Signal">\n                <P Name="DataType" Class="char">single</P>\n                <P Name="DocUnits" Class="char">bar</P>\n            </Element>'),
    entry(
      "MyBus",
      [
        '            <Element Class="Simulink.Bus">',
        '                <P Name="Elements_internal" Dimension="2*1">',
        '                    <Element Class="Simulink.BusElement"><P Name="Name" Class="char">speed</P><P Name="DataType_internal" Class="char">MyAlias</P></Element>',
        '                    <Element Class="Simulink.BusElement"><P Name="Name" Class="char">mode</P><P Name="DataType_internal" Class="char">Enum: Mode</P></Element>',
        "                </P>",
        "            </Element>",
      ].join("\n"),
    ),
    entry("MyAlias", '            <Element Class="Simulink.AliasType">\n                <P Name="BaseType" Class="char">uint8</P>\n            </Element>'),
  ]),
});

/** A dictionary saved in the text (JSON) format: no ZIP at all. */
const TEXT_SLDD = JSON.stringify(
  {
    __MW_TEXT_CONTENTTYPE__: "application/vnd.mathworks.simulink.datadictionary",
    __MW_TEXT_PARTS__: {
      "__MW_TEXT_PART__/data/chunk0": {
        __MW_TEXT_content: {
          entries: [
            {
              name: "Mode",
              value: {
                _array_class: "Simulink.data.dictionary.EnumTypeDefinition",
                _elements: [{ _id: "1", _properties: { Enumerals: [{ Name: "OFF", Value: "0" }, { Name: "ON", Value: "1" }] } }],
              },
            },
            { name: "Ki", value: { _array_class: "Simulink.Parameter", _elements: [{ _id: "1", _properties: { DataType: "single", DocUnits: "1/s" } }] } },
          ],
        },
      },
    },
  },
  null,
  "\t",
);

const PLANT_SLX = zip({
  "simulink/blockdiagram.xml": xml("<ModelInformation><Model/></ModelInformation>"),
  "simulink/systems/system_root.xml": xml('<System>\n  <Block BlockType="Gain" Name="K" SID="1"><P Name="Gain">Ki</P></Block>\n</System>'),
});

const LIB_SLX = zip({
  "simulink/blockdiagram.xml": xml("<ModelInformation><Library/></ModelInformation>"),
  "simulink/systems/system_root.xml": xml(
    '<System>\n  <Block BlockType="SubSystem" Name="Low&#xA;Pass" SID="1">\n    <System>\n      <Block BlockType="Gain" Name="G" SID="2"/>\n    </System>\n  </Block>\n</System>',
  ),
});

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}
function hasEdge(graph: GraphV1, rel: string, source: string, target: string): boolean {
  return graph.edges.some((e) => e.relation === rel && e.source === source && e.target === target);
}
async function buildTree(files: Record<string, string | Buffer>): Promise<GraphV1> {
  const dir = mkdtempSync(join(tmpdir(), "graft-simulink-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    await buildGraph(dir);
    return readGraph(wiringPath(join(dir, "graft")))!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an unchanged package is replayed by its raw bytes; a changed one is parsed again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-simulink-reuse-"));
  try {
    writeFileSync(join(dir, "Ctrl.slx"), CTRL_SLX);
    const first = await buildGraph(dir);
    assert.equal(first.parsed, 1);
    const cacheDir = join(dir, "graft", ".cache");
    const cacheFile = readdirSync(cacheDir).find((f) => /^extract\..+\.json$/.test(f))!;
    const entry = (JSON.parse(readFileSync(join(cacheDir, cacheFile), "utf8")) as { files: Record<string, ExtractEntry> }).files["Ctrl.slx"]!;
    assert.match(entry.rawHash ?? "", /^[0-9a-f]{64}$/, "a package keeps the hash of its raw bytes");
    assert.ok((entry.chars ?? 0) > 0, "and the size the guard counted");
    const before = readFileSync(wiringPath(join(dir, "graft")), "utf8");

    const again = await buildGraph(dir);
    assert.equal(again.parsed, 0);
    assert.equal(again.reused, 1);
    assert.equal(readFileSync(wiringPath(join(dir, "graft")), "utf8"), before, "replayed: the same map");

    writeFileSync(join(dir, "Ctrl.slx"), LIB_SLX);
    const changed = await buildGraph(dir);
    assert.equal(changed.parsed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Simulink files are claimed without a grammar; live scripts are MATLAB", () => {
  assert.equal(languageOf("models/Ctrl.slx"), "simulink");
  assert.equal(languageOf("models/Old.MDL"), "simulink");
  assert.equal(languageOf("data/Ctrl_data.SLDD"), "simulink");
  assert.equal(languageOf("doc/Notes.mlx"), grammarAvailable("matlab") ? "matlab" : null);
});

test("a package reads as its unpacked parts, in a fixed order, layout and plumbing left out", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-simulink-read-"));
  try {
    writeFileSync(join(dir, "Ctrl.slx"), CTRL_SLX);
    writeFileSync(join(dir, "stored.sldd"), zip({ "data/chunk0.xml": dictionaryXml([]) }, true));
    writeFileSync(join(dir, "broken.slx"), Buffer.from("PK\u0003\u0004 not really a zip"));
    const text = readSourceFile(join(dir, "Ctrl.slx"))!;
    assert.deepEqual(
      packageParts(text).map((p) => p.name),
      [
        "simulink/blockdiagram.xml",
        "simulink/systems/system_root.xml",
        "simulink/systems/system_2.xml",
        "simulink/systems/system_23.xml",
        "simulink/systems/system_26.xml",
        "simulink/stateflow/chart_7.xml",
        "simulink/stateflow/chart_8.xml",
      ],
    );
    assert.ok(!text.includes("thumbnail") && !text.includes("<Types/>"));
    assert.equal(readSourceFile(join(dir, "Ctrl.slx")), text, "the same text every read");
    assert.deepEqual(packageParts(readSourceFile(join(dir, "stored.sldd"))!).map((p) => p.name), ["data/chunk0.xml"], "a stored (uncompressed) entry");
    assert.equal(readSourceFile(join(dir, "broken.slx")), null, "an archive that cannot be read is skipped");
    assert.equal(renderSimulinkPackage(Buffer.from("plain"), "x.slx"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseXml: rows, attributes, entities, CDATA and a stray close tag", () => {
  const [root] = parseXml('<?xml version="1.0"?>\n<a x="1 &amp; 2">\n  <b>t &lt; 3</b>\n  <c><![CDATA[<raw>]]></c></d>\n</a>\n');
  assert.equal(root!.name, "a");
  assert.equal(root!.attrs.x, "1 & 2");
  assert.equal(root!.start, 1);
  assert.equal(root!.end, 4);
  assert.equal(root!.children[0]!.text, "t < 3");
  assert.equal(root!.children[0]!.start, 2);
  assert.equal(root!.children[1]!.text, "<raw>");
});

test("parseXml: attributes read as before, and a long tag without spaces or = stays linear", () => {
  const [el] = parseXml(`<p a = "1" b='x "y"' bare c=unquoted d="2" =e f="z"/>`);
  assert.deepEqual(el!.attrs, { a: "1", b: 'x "y"', d: "2", f: "z" });
  const [open] = parseXml(`<p a="never closed b='3'/>`);
  assert.deepEqual(open!.attrs, { b: "3" }, "an unclosed quote is skipped and reading goes on, as the regex did");
  const long = `<p ${"x".repeat(200_000)}/>`;
  const t0 = Date.now();
  const [big] = parseXml(long);
  assert.deepEqual(big!.attrs, {});
  assert.ok(Date.now() - t0 < 2000, "a 200 kB attribute-less run parses in well under a second");
  const deep = `${"<a>".repeat(5000)}</a>`.repeat(1);
  const [top] = parseXml(deep);
  assert.equal(top!.name, "a");
});

test("Simulink packages above the 1 MB source limit are still indexed", () => {
  assert.equal(tooBigToIndex("a/Model.slx", 5_000_000), false);
  assert.equal(tooBigToIndex("a/model.c", 5_000_000), true);
});

test("Simulink: models, subsystems, charts, ports, dictionaries and the links between them", async () => {
  const files: Record<string, string | Buffer> = {
    "models/Ctrl.slx": CTRL_SLX,
    "models/Plant.slx": PLANT_SLX,
    "lib/Lib.slx": LIB_SLX,
    "data/Ctrl_data.sldd": CTRL_SLDD,
    "data/Types.sldd": TEXT_SLDD,
  };
  const withMatlab = grammarAvailable("matlab");
  if (withMatlab) files["scripts/helperFn.m"] = "function r = helperFn(x)\nr = x;\nend\n";
  const graph = await buildTree(files);
  assert.ok(graph.meta.languages.includes("simulink"));

  const model = nodeById(graph, "models/Ctrl.slx#Ctrl");
  assert.equal(model?.kind, "module");
  assert.equal(model?.signature, "Simulink model Ctrl (data dictionary Ctrl_data.sldd)");
  assert.equal(nodeById(graph, "lib/Lib.slx#Lib")?.signature, "Simulink library Lib");
  const ctrl = nodeById(graph, "models/Ctrl.slx#Ctrl/Controller");
  assert.equal(ctrl?.kind, "module");
  assert.equal(ctrl?.signature, "SubSystem Controller [1, 1]");
  assert.ok(hasEdge(graph, "contains", "models/Ctrl.slx#Ctrl", "models/Ctrl.slx#Ctrl/Controller"));
  const chart = nodeById(graph, "models/Ctrl.slx#Ctrl/Controller/Chart");
  assert.equal(chart?.signature, "Stateflow chart Chart");
  assert.equal(nodeById(graph, "models/Ctrl.slx#Ctrl/y")?.signature, "Outport y (port 1)", "a root port");
  assert.equal(nodeById(graph, "models/Ctrl.slx#Ctrl/Controller/u"), undefined, "ports inside subsystems are not nodes");
  assert.equal(nodeById(graph, "lib/Lib.slx#Lib/Low Pass")?.name, "Low Pass", "line breaks in block names read as spaces");

  // Spans point into the unpacked text: the chart's own XML.
  const [first] = chart!.span.slice(1).split("-L").map(Number);
  assert.ok(first! > 1);

  assert.equal(nodeById(graph, "data/Ctrl_data.sldd#Kp")?.kind, "constant");
  assert.equal(nodeById(graph, "data/Ctrl_data.sldd#Kp")?.signature, "Kp : Simulink.Parameter (single)");
  assert.equal(nodeById(graph, "data/Ctrl_data.sldd#SigA")?.kind, "variable");
  assert.equal(nodeById(graph, "data/Ctrl_data.sldd#MyBus")?.kind, "type");
  assert.equal(nodeById(graph, "data/Ctrl_data.sldd#MyBus.speed")?.signature, "MyBus.speed : MyAlias");
  assert.equal(nodeById(graph, "data/Types.sldd#Mode")?.kind, "enum", "a text-format dictionary");
  assert.equal(nodeById(graph, "data/Types.sldd#Mode.ON")?.kind, "constant");
  assert.equal(nodeById(graph, "data/Types.sldd#Ki")?.signature, "Ki : Simulink.Parameter (single, 1/s)");

  assert.ok(hasEdge(graph, "imports", "models/Ctrl.slx", "data/Ctrl_data.sldd"), "the linked dictionary");
  assert.ok(hasEdge(graph, "imports", "models/Ctrl.slx", "models/Plant.slx"), "a referenced model");
  assert.ok(hasEdge(graph, "calls", "models/Ctrl.slx#Ctrl/Controller", "models/Plant.slx#Plant"), "a Model block");
  assert.ok(hasEdge(graph, "references", "models/Ctrl.slx#Ctrl/Controller", "lib/Lib.slx#Lib/Low Pass"), "a library link");
  assert.ok(hasEdge(graph, "references", "models/Ctrl.slx#Ctrl/Controller", "data/Ctrl_data.sldd#Kp"), "a block parameter");
  assert.ok(hasEdge(graph, "references", "models/Ctrl.slx#Ctrl/Controller", "data/Ctrl_data.sldd#MyBus"), "a data type");
  assert.ok(hasEdge(graph, "references", "models/Ctrl.slx#Ctrl/Controller", "data/Ctrl_data.sldd#SigA"), "a named signal");
  assert.ok(hasEdge(graph, "references", "models/Ctrl.slx#Ctrl", "data/Ctrl_data.sldd#SigA"), "the root's signal, not its same-named port");
  assert.ok(!hasEdge(graph, "references", "models/Ctrl.slx#Ctrl", "models/Ctrl.slx#Ctrl/SigA"));
  assert.ok(hasEdge(graph, "references", "models/Ctrl.slx#Ctrl/Controller/Chart", "data/Ctrl_data.sldd#Kp"), "chart code");
  assert.ok(hasEdge(graph, "references", "models/Plant.slx#Plant", "data/Types.sldd#Ki"), "a gain from a text-format dictionary");
  assert.ok(hasEdge(graph, "references", "data/Ctrl_data.sldd#MyBus.speed", "data/Ctrl_data.sldd#MyAlias"), "a bus element's type");
  assert.ok(hasEdge(graph, "references", "data/Ctrl_data.sldd#MyBus.mode", "data/Types.sldd#Mode"), "an enum type in another dictionary");
  if (withMatlab) {
    assert.ok(hasEdge(graph, "calls", "models/Ctrl.slx#Ctrl/Controller/Chart", "scripts/helperFn.m#helperFn"), "a MATLAB function called from a chart");
  }
});

test("Simulink: a MATLAB Function block's code is parsed with the MATLAB grammar", { skip: grammarAvailable("matlab") ? false : "matlab grammar not built" }, async () => {
  const graph = await buildTree({
    "models/Ctrl.slx": CTRL_SLX,
    "data/Ctrl_data.sldd": CTRL_SLDD,
    "scripts/helperFn.m": "function r = helperFn(x)\nr = x;\nend\n",
  });
  const block = "models/Ctrl.slx#Ctrl/Controller/MATLAB Function";
  assert.equal(nodeById(graph, block)?.signature, "MATLAB Function MATLAB Function");
  const fcn = nodeById(graph, `${block}.fcn`);
  assert.equal(fcn?.kind, "function");
  assert.equal(fcn?.signature, "function y = fcn(u)");
  const scale = nodeById(graph, `${block}.scale`);
  assert.equal(scale?.exported, false, "a local function of the block's code");
  assert.ok(hasEdge(graph, "contains", block, `${block}.fcn`));
  // The code keeps its own lines in the unpacked text: the span is where it is written.
  const dir = mkdtempSync(join(tmpdir(), "graft-simulink-mf-"));
  try {
    writeFileSync(join(dir, "Ctrl.slx"), CTRL_SLX);
    const lines = readSourceFile(join(dir, "Ctrl.slx"))!.split("\n");
    const at = (needle: string): number => lines.findIndex((l) => l.includes(needle)) + 1;
    assert.equal(fcn?.span, `L${at("function y = fcn(u)")}-L${at("function y = fcn(u)") + 2}`);
    assert.equal(scale?.span, `L${at("function z = scale(v)")}-L${at("function z = scale(v)") + 2}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(hasEdge(graph, "calls", `${block}.fcn`, `${block}.scale`), "a local function");
  assert.ok(hasEdge(graph, "calls", `${block}.fcn`, "scripts/helperFn.m#helperFn"), "a MATLAB function on the path");
  assert.ok(hasEdge(graph, "references", block, "data/Ctrl_data.sldd#Kp"), "a dictionary parameter the code uses");
});

/** A model in the classic text format, with a Stateflow section holding a MATLAB Function. */
const LEGACY_MDL = [
  "# a comment",
  "Model {",
  '  Name "Legacy"',
  '  DataDictionary "Ctrl_data.sldd"',
  '  Description "first line "',
  '    "second line"',
  "  System {",
  '    Name "Legacy"',
  "    Block {",
  "      BlockType Constant",
  '      Name "C"',
  '      Value "Kp"',
  "    }",
  "    Block {",
  "      BlockType SubSystem",
  '      Name "MF"',
  '      SFBlockType "MATLAB Function"',
  "      System {",
  '        Name "MF"',
  "      }",
  "    }",
  "    Block {",
  "      BlockType ModelReference",
  '      Name "P"',
  '      ModelNameDialog "Plant"',
  "    }",
  "    Line {",
  '      Name "SigA"',
  "    }",
  "  }",
  "}",
  "Stateflow {",
  "  machine {",
  "    id 1",
  '    name "Legacy"',
  "  }",
  "  chart {",
  "    id 2",
  '    name "MF"',
  "  }",
  "  instance {",
  "    id 3",
  '    name "Legacy/MF"',
  "    machine 1",
  "    chart 2",
  "  }",
  "  state {",
  "    id 4",
  '    labelString "eML_blk_kernel()"',
  "    chart 2",
  "    eml {",
  "      isEML 1",
  '      script "function y = fcn(u)\\ny = helperFn(u) * Kp;\\nend"',
  "    }",
  "  }",
  "  data {",
  "    id 5",
  '    name "u"',
  "    linkNode [2 0 0]",
  "  }",
  "}",
  "",
].join("\n");

/** A model saved as a MathWorks OPC text package (R2015a and later). */
const OPC_TEXT_MDL = [
  "# MathWorks OPC Text Package",
  "Model {",
  "  Version 10.1",
  "}",
  "__MWOPC_PACKAGE_BEGIN__ R2020a",
  "__MWOPC_PART_BEGIN__ /simulink/blockdiagram.xml",
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<ModelInformation Version="1.0"><Model><P Name="DataDictionary">Ctrl_data.sldd</P></Model></ModelInformation>',
  "__MWOPC_PART_BEGIN__ /metadata/thumbnail.png BASE64",
  "iVBORw0KGgo=",
  "__MWOPC_PART_BEGIN__ /simulink/systems/system_root.xml",
  '<?xml version="1.0" encoding="UTF-8"?>',
  "<System>",
  '  <Block BlockType="Gain" Name="G" SID="1"><P Name="Gain">Kp</P></Block>',
  "</System>",
  "__MWOPC_PACKAGE_END__",
  "",
].join("\n");

/** The newer Simulink text format: the block diagram in JSON. */
const SL_TEXT_MDL = [
  "# Simulink Text Package",
  "Model {",
  "  Version 27.1",
  "}",
  "__MWSL_PACKAGE_BEGIN__ R2027a",
  "__MWSL_PART_BEGIN__ /simulink/blockDiagram.json",
  '{"BlockDiagram":{"DataDictionary":"Ctrl_data.sldd","System":{"Ref":"system_root"}}}',
  "__MWSL_PART_BEGIN__ /simulink/systems/system_root.xml",
  "<System>",
  '  <Block BlockType="Constant" Name="K" SID="1"><P Name="Value">Kp</P></Block>',
  "</System>",
  "__MWSL_PACKAGE_END__",
  "",
].join("\n");

test("Simulink: .mdl models in the classic and both text-package formats", async () => {
  const withMatlab = grammarAvailable("matlab");
  const files: Record<string, string | Buffer> = {
    "models/Legacy.mdl": LEGACY_MDL,
    "models/Opc.mdl": OPC_TEXT_MDL,
    "models/Text.mdl": SL_TEXT_MDL,
    "models/Plant.slx": PLANT_SLX,
    "data/Ctrl_data.sldd": CTRL_SLDD,
    "other/Rose.mdl": "(object Petal\n    version 50)\n",
    "other/Game.mdl": Buffer.from([0x49, 0x44, 0x53, 0x54, 0, 0, 0, 0x2c]),
  };
  if (withMatlab) files["scripts/helperFn.m"] = "function r = helperFn(x)\nr = x;\nend\n";
  const graph = await buildTree(files);

  assert.equal(nodeById(graph, "models/Legacy.mdl#Legacy")?.signature, "Simulink model Legacy (data dictionary Ctrl_data.sldd)");
  assert.equal(nodeById(graph, "models/Legacy.mdl#Legacy")?.span, "L7-L30", "the root System section");
  assert.equal(nodeById(graph, "models/Legacy.mdl#Legacy/MF")?.signature, "MATLAB Function MF");
  assert.ok(hasEdge(graph, "imports", "models/Legacy.mdl", "data/Ctrl_data.sldd"));
  assert.ok(hasEdge(graph, "imports", "models/Legacy.mdl", "models/Plant.slx"), "a model referenced by name");
  assert.ok(hasEdge(graph, "calls", "models/Legacy.mdl#Legacy", "models/Plant.slx#Plant"));
  assert.ok(hasEdge(graph, "references", "models/Legacy.mdl#Legacy", "data/Ctrl_data.sldd#Kp"), "a block parameter");
  assert.ok(hasEdge(graph, "references", "models/Legacy.mdl#Legacy", "data/Ctrl_data.sldd#SigA"), "a named signal");
  assert.ok(hasEdge(graph, "references", "models/Legacy.mdl#Legacy/MF", "data/Ctrl_data.sldd#Kp"), "the Stateflow section's code");
  if (withMatlab) {
    const fcn = nodeById(graph, "models/Legacy.mdl#Legacy/MF.fcn");
    assert.equal(fcn?.kind, "function", "the MATLAB Function's code, parsed");
    assert.equal(fcn?.span, "L53-L53", "an escaped script keeps no lines of its own: its line");
    assert.ok(hasEdge(graph, "calls", "models/Legacy.mdl#Legacy/MF.fcn", "scripts/helperFn.m#helperFn"));
  }

  const opc = nodeById(graph, "models/Opc.mdl#Opc");
  assert.equal(opc?.span, "L12-L15", "the root system's part, in the file's own lines");
  assert.ok(hasEdge(graph, "imports", "models/Opc.mdl", "data/Ctrl_data.sldd"));
  assert.ok(hasEdge(graph, "references", "models/Opc.mdl#Opc", "data/Ctrl_data.sldd#Kp"));
  assert.ok(hasEdge(graph, "imports", "models/Text.mdl", "data/Ctrl_data.sldd"), "a JSON block diagram");
  assert.ok(hasEdge(graph, "references", "models/Text.mdl#Text", "data/Ctrl_data.sldd#Kp"));

  assert.deepEqual(graph.nodes.filter((n) => n.path === "other/Rose.mdl").map((n) => n.kind), ["file"], "another tool's text .mdl");
  assert.equal(graph.nodes.some((n) => n.path === "other/Game.mdl"), false, "a binary .mdl is skipped");
});

/** A live script: a title, prose, an equation and code, with a local function. */
const LIVE_DOC = [
  '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
  '<w:p><w:pPr><w:pStyle w:val="title"/></w:pPr><w:r><w:t>Gain study</w:t></w:r></w:p>',
  '<w:p><w:pPr><w:pStyle w:val="text"/></w:pPr><w:r><w:t>Scale the </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>input</w:t></w:r><w:r><w:t> twice.</w:t></w:r></w:p>',
  '<w:p><w:pPr><w:pStyle w:val="text"/></w:pPr><w:customXml w:element="equation"><w:r><w:t>y = 2x</w:t></w:r></w:customXml></w:p>',
  '<w:p><w:pPr><w:pStyle w:val="code"/></w:pPr><w:r><w:t><![CDATA[x = 3;',
  "y = twice(helperFn(x));",
  "disp(y)]]></w:t></w:r></w:p>",
  '<w:p><w:pPr><w:pStyle w:val="heading"/></w:pPr><w:r><w:t>Local functions</w:t></w:r></w:p>',
  '<w:p><w:pPr><w:pStyle w:val="code"/></w:pPr><w:r><w:t><![CDATA[function r = twice(v)',
  "r = 2 * v;",
  "end]]></w:t></w:r></w:p>",
  "</w:body></w:document>",
].join("\n");

test("a live script (.mlx) reads as MATLAB: code as written, prose as comments", { skip: grammarAvailable("matlab") ? false : "matlab grammar not built" }, async () => {
  const mlx = zip({
    "[Content_Types].xml": xml("<Types/>"),
    "matlab/document.xml": LIVE_DOC,
    "matlab/output.xml": xml("<embeddedOutputs/>"),
  });
  assert.equal(
    renderSimulinkPackage(mlx, "Gain.mlx"),
    [
      "%% Gain study",
      "% Scale the input twice.",
      "% y = 2x",
      "x = 3;",
      "y = twice(helperFn(x));",
      "disp(y)",
      "%% Local functions",
      "function r = twice(v)",
      "r = 2 * v;",
      "end",
      "",
    ].join("\n"),
  );
  const graph = await buildTree({ "study/Gain.mlx": mlx, "scripts/helperFn.m": "function r = helperFn(x)\nr = x;\nend\n" });
  const twice = nodeById(graph, "study/Gain.mlx#twice");
  assert.equal(twice?.kind, "function");
  assert.equal(twice?.span, "L8-L10");
  assert.equal(twice?.exported, false, "a live script's local function");
  assert.ok(hasEdge(graph, "calls", "study/Gain.mlx", "study/Gain.mlx#twice"));
  assert.ok(hasEdge(graph, "calls", "study/Gain.mlx", "scripts/helperFn.m#helperFn"));
  assert.ok(graph.meta.languages.includes("matlab"));
});

test("Simulink: a file that is not a readable package is a file node, not an error", async () => {
  const graph = await buildTree({ "m/Odd.slx": "not a zip at all", "m/Odd.sldd": "neither" });
  assert.deepEqual(
    graph.nodes.filter((n) => n.path.startsWith("m/")).map((n) => n.kind),
    ["file", "file"],
  );
});
