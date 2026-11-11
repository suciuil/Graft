/**
 * Simulink models (`.slx`) and data dictionaries (`.sldd`).
 *
 * Both arrive here as the text `readSourceFile` makes of them: a ZIP package unpacked
 * into its XML parts, each after a marker line (see `util/simulink-package.ts`), or, for
 * a dictionary saved in the text format, its JSON as is. Line numbers are those of that
 * text, so `ask --source` and `graft grep` show the XML a node came from.
 *
 * A model becomes:
 * - a `module` node for the model (or library) itself, and one per subsystem, Stateflow
 *   chart and MATLAB Function block, nested as in the model (`Model/Sub/Chart`);
 * - a `variable` node per root-level Inport/Outport (the model's interface);
 * - an `imports` edge to its data dictionary and to each referenced model;
 * - a `calls` edge from the system holding a Model block to the referenced model, and a
 *   `references` edge from a library link to the library block it instantiates;
 * - `references` edges from each system to the dictionary entries (or MATLAB variables)
 *   its block parameters, signal names and data types name, and from a chart to what
 *   its states, transitions and data use; `name(…)` in chart code is a `calls` edge.
 * A dictionary becomes one node per entry (`constant` for parameters, `variable` for
 * signals, `type` for buses and alias types, `enum` for enumerations), with bus
 * elements and enumeration members under it and `references` edges to the types its
 * entries use.
 */
import { basename } from "node:path";
import { contentHash } from "../util/id.js";
import { parseXml, type XmlEl } from "../util/xml.js";
import { isPartedText, packageParts, type PackagePart } from "../util/simulink-package.js";
import { extractMatlabSnippet, fileNodeOf, mintId, searchBody, type ExtractResult, type RawEdge } from "./extract.js";
import type { Kind, NodeV1 } from "./types.js";

// --- XML helpers --------------------------------------------------------------------

const kids = (el: XmlEl | undefined, name: string): XmlEl[] => (el ? el.children.filter((c) => c.name === name) : []);
const kid = (el: XmlEl | undefined, name: string): XmlEl | undefined => el?.children.find((c) => c.name === name);
/** An element's `<P Name="…">` parameters, by name. */
function params(el: XmlEl): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of el.children) if (p.name === "P" && p.attrs.Name !== undefined) out.set(p.attrs.Name, p.text);
  return out;
}
/** A depth-first search for elements named `name` (not descending into matches). */
function findAll(els: XmlEl[], name: string, out: XmlEl[] = []): XmlEl[] {
  for (const el of els) {
    if (el.name === name) out.push(el);
    else findAll(el.children, name, out);
  }
  return out;
}

// --- names an expression uses --------------------------------------------------------

/** Words in a parameter or chart expression that never name model data. */
const NOT_DATA = new Set([
  "on", "off", "auto", "true", "false", "inf", "Inf", "nan", "NaN", "pi", "eps", "end", "if", "else", "elseif",
  "for", "while", "switch", "case", "otherwise", "function", "return", "break", "continue", "en", "du", "ex",
  "entry", "during", "exit", "on", "after", "before", "at", "every", "temporalCount", "send", "in", "single",
  "double", "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64", "boolean", "logical", "char",
  "string", "half", "fixdt", "sfix", "ufix", "Inherit", "Enum", "Bus", "Simulink", "min", "max", "abs", "floor",
  "ceil", "round", "fix", "mod", "rem", "sqrt", "exp", "log", "zeros", "ones", "numel", "size", "length", "sum",
  "Same", "as", "first", "input", "via", "back", "propagation", "internal", "rule", "output", "Inf", "e",
]);
/** MATLAB builtins a chart or MATLAB Function calls; anything else stays a candidate. */
const NOT_A_CALL = new Set([...NOT_DATA]);

/** The data names and the called names an expression or a piece of chart code uses.
 * Comments (`% …`) and strings are skipped; `a.b` names `a`. */
function namesIn(code: string): { data: Set<string>; calls: Set<string> } {
  const data = new Set<string>();
  const calls = new Set<string>();
  const stripped = code
    .replace(/%[^\n]*/g, " ")
    .replace(/'[^'\n]*'|"[^"\n]*"/g, " ");
  for (const m of stripped.matchAll(/(?<![\w.])([A-Za-z]\w*)(\s*\()?/g)) {
    const name = m[1]!;
    if (NOT_DATA.has(name) && !m[2]) continue;
    if (m[2]) {
      if (!NOT_A_CALL.has(name)) calls.add(name);
    } else data.add(name);
  }
  return { data, calls };
}

/** The type a data-type string names, when it names one the model or dictionary could
 * define: `Bus: X`, `Enum: X`, `X`. Built-in types and `Inherit: …` rules name none. */
function typeName(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim().replace(/^(?:Bus|Enum|ValueType)\s*:\s*/, "");
  if (/^Inherit\b|^fixdt\(|^[su]fix\d|^(?:double|single|half|int(?:8|16|32|64)|uint(?:8|16|32|64)|boolean|string|char|logical)$/i.test(t)) return null;
  return /^[A-Za-z]\w*$/.test(t) ? t : null;
}

/** What model data can be: a dictionary signal, parameter, bus or enumeration, or a
 * MATLAB variable or constant defined in a script. */
const DATA_KINDS: Kind[] = ["variable", "constant", "type", "enum"];
const TYPE_KINDS: Kind[] = ["type", "enum", "class"];

/** Block parameters that hold an expression rather than layout or a setting word. */
const EXPRESSION_PARAM =
  /^(?:Value|Gain|Table|InitialCondition|InitialValue|X0|IC|UpperLimit|LowerLimit|UpperValue|LowerValue|Threshold|OnSwitchValue|OffSwitchValue|OnSwitchOutputValue|OffSwitchOutputValue|RisingSlewLimit|FallingSlewLimit|const|Numerator|Denominator|Coefficients|Bias|Offset|Amplitude|Frequency|Phase|DelayLength|uplimit|lowlimit|Vector|BreakpointsForDimension\d+|BreakpointsData|TableData|bp\d+|tableData|Parameters|ParameterArgumentValues|SampleTime|OutMin|OutMax|DialogParameters|MaskValueString)$/;
const DATA_TYPE_PARAM = /DataTypeStr$|^DataType$|^OutDataType$/;

// --- the extractor -------------------------------------------------------------------

/** A block or path name as Simulink displays it: line breaks and runs of space as one. */
const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

const SIGNATURE_MAX = 200;
const short = (s: string): string => (s.length > SIGNATURE_MAX ? `${s.slice(0, SIGNATURE_MAX - 1)}…` : s);

export function extractSimulink(rel: string, source: string): ExtractResult {
  if (/\.sldd$/i.test(rel)) {
    if (isPartedText(source)) return dictionaryFromXml(rel, source);
    if (source.trimStart().startsWith("{")) return dictionaryFromJson(rel, source);
    return { nodes: [fileNodeOf(rel, source)], rawEdges: [] };
  }
  if (isPartedText(source)) return model(rel, source, modelFromParts(source));
  if (/\.mdl$/i.test(rel) && LEGACY_MDL.test(source)) return model(rel, source, modelFromMdl(source));
  return { nodes: [fileNodeOf(rel, source)], rawEdges: [] };
}

/** Shared node-minting state for one file. */
function builder(rel: string, source: string) {
  const nodes: NodeV1[] = [fileNodeOf(rel, source)];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  const lines = source.split("\n");
  const mint = (
    idName: string,
    name: string,
    kind: Kind,
    first: number,
    last: number,
    signature: string | null,
    parentId: string,
    body?: string,
  ): NodeV1 => {
    const id = mintId(`${rel}#${idName}`, minted);
    const text = lines.slice(first, last + 1).join("\n");
    const node: NodeV1 = {
      id,
      name,
      kind,
      path: rel,
      span: `L${first + 1}-L${last + 1}`,
      signature: signature ? short(signature) : null,
      exported: true,
      origin: "ast",
      body_hash: contentHash(text),
      body_text: searchBody(body ?? text),
      summary_state: "pending",
      summary: null,
      crux: null,
    };
    nodes.push(node);
    rawEdges.push({ source: parentId, relation: "contains", targetId: id, file: rel });
    return node;
  };
  const ref = (from: string, name: string, kinds: Kind[]): void => {
    rawEdges.push({ source: from, relation: "references", name, kinds, file: rel });
  };
  const call = (from: string, name: string): void => {
    rawEdges.push({ source: from, relation: "calls", name, file: rel });
  };
  const imp = (spec: string): void => {
    rawEdges.push({ source: rel, relation: "imports", specifier: spec, file: rel });
  };
  /**
   * Add what the MATLAB extractor found in embedded code (a MATLAB Function block's
   * script) under `owner`: its ids move below the owner's (`Model/Sub/MATLAB
   * Function.fcn`), its spans move to the row the code starts on (or all onto that row
   * when the code's own lines do not survive in the file), and its file-level edges
   * come from the owner.
   */
  const graftSnippet = (owner: NodeV1, snippet: ExtractResult, baseRow: number, exactRows: boolean): void => {
    const ownerName = owner.id.slice(rel.length + 1);
    const ids = new Map<string, string>([[rel, owner.id]]);
    for (const n of snippet.nodes) {
      if (n.kind === "file") continue;
      ids.set(n.id, mintId(`${rel}#${ownerName}.${n.id.slice(n.id.indexOf("#") + 1)}`, minted));
    }
    for (const n of snippet.nodes) {
      if (n.kind === "file") continue;
      const m = /^L(\d+)-L(\d+)$/.exec(n.span);
      const span = m && exactRows ? `L${baseRow + Number(m[1])}-L${baseRow + Number(m[2])}` : `L${baseRow + 1}-L${baseRow + 1}`;
      nodes.push({ ...n, id: ids.get(n.id)!, path: rel, span, owner: n.owner ? `${ownerName}.${n.owner}` : undefined });
    }
    for (const e of snippet.rawEdges) {
      if (e.relation === "imports") continue;
      rawEdges.push({
        ...e,
        source: ids.get(e.source) ?? e.source,
        ...(e.targetId ? { targetId: ids.get(e.targetId) ?? e.targetId } : {}),
        file: rel,
      });
    }
  };
  return { nodes, rawEdges, mint, ref, call, imp, graftSnippet };
}

/** A system to walk: its element, the row its rows count from, and the rows of the
 * text that shows it (its own part, or its block). */
interface SystemSource {
  system: XmlEl;
  row: number;
  first: number;
  last: number;
}

/** A Stateflow chart (or MATLAB Function block): where it is in the model, its rows,
 * the code its states, transitions and data hold, and its MATLAB scripts. */
interface ChartSource {
  path: string;
  first: number;
  last: number;
  hash: string;
  code: string[];
  scripts: { text: string; row: number; exactRows: boolean }[];
}

/** Everything a model's extraction needs, whichever format the model is saved in. */
interface ModelSource {
  isLibrary: boolean;
  dictionary?: string;
  root?: SystemSource;
  /** `<System Ref="system_7"/>` → that system's part. */
  systemRef: (ref: string) => SystemSource | undefined;
  charts: ChartSource[];
}

/** The last row of a part (0-based, in the rendered text). */
const partEnd = (p: PackagePart): number => p.row + Math.max(0, p.text.split("\n").length - 1);

/** A chart's code and scripts, from Stateflow XML (an `.slx` part) or from the
 * objects of a classic `.mdl`'s `Stateflow { … }` section (rows absolute). */
function chartCode(els: XmlEl[], row: number): Pick<ChartSource, "code" | "scripts"> {
  const code: string[] = [];
  const scripts: ChartSource["scripts"] = [];
  const visit = (list: XmlEl[]): void => {
    for (const el of list) {
      if (el.name === "P" && el.attrs.Name === "script") {
        // Literal line breaks in the XML keep the script's own lines in the file.
        scripts.push({ text: el.text, row: row + el.start, exactRows: el.end - el.start === el.text.split("\n").length - 1 });
      } else if (el.name === "P" && (el.attrs.Name === "labelString" || el.attrs.Name === "initialValue")) {
        code.push(el.text);
      } else if (el.name === "data") {
        const name = el.attrs.name ?? params(el).get("name");
        if (name) code.push(name);
      }
      visit(el.children);
    }
  };
  visit(els);
  return { code, scripts };
}

/** A model whose parts are split by markers: an unpacked `.slx`, or a `.mdl` text
 * package (R2015a and later). */
function modelFromParts(source: string): ModelSource {
  const parts = packageParts(source).filter((p) => !p.encoded);
  const byName = new Map(parts.map((p) => [p.name.replace(/^\//, "").toLowerCase(), p]));
  const xml = new Map<string, XmlEl[]>();
  const xmlOf = (p: PackagePart): XmlEl[] => {
    let els = xml.get(p.name);
    if (!els) xml.set(p.name, (els = parseXml(p.text)));
    return els;
  };
  const json = (name: string): Record<string, unknown> | undefined => {
    const p = byName.get(name);
    if (!p) return undefined;
    try {
      return JSON.parse(p.text) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };
  // The block diagram: XML (`<Model>`/`<Library>`) or, in newer releases, JSON.
  const bdXml = byName.get("simulink/blockdiagram.xml");
  const top = bdXml ? (findAll(xmlOf(bdXml), "Model")[0] ?? findAll(xmlOf(bdXml), "Library")[0]) : undefined;
  const bdJson = json("simulink/blockdiagram.json");
  const diagram = (bdJson?.BlockDiagram ?? bdJson?.Library ?? bdJson?.Model) as Record<string, unknown> | undefined;
  const core = json("slcoreproperties.json");
  const isLibrary = top?.name === "Library" || !!bdJson?.Library || core?.SimulinkBlockDiagramType === "library";
  const dd = (top ? params(top).get("DataDictionary") : undefined) ?? (typeof diagram?.DataDictionary === "string" ? diagram.DataDictionary : undefined);

  const systemRef = (ref: string): SystemSource | undefined => {
    const p = byName.get(`simulink/systems/${ref.toLowerCase()}.xml`);
    const system = p ? findAll(xmlOf(p), "System")[0] : undefined;
    return p && system ? { system, row: p.row, first: p.row, last: partEnd(p) } : undefined;
  };
  // The root system: its own part, or (older `.slx`) inline in the block diagram.
  let root = systemRef("system_root");
  const inline = top ? kid(top, "System") : undefined;
  if (!root && inline && bdXml) root = { system: inline, row: bdXml.row, first: bdXml.row + inline.start, last: bdXml.row + inline.end };

  const charts: ChartSource[] = [];
  for (const p of parts) {
    if (!/^\/?simulink\/stateflow\/chart_/i.test(p.name)) continue;
    const chart = findAll(xmlOf(p), "chart")[0];
    if (!chart) continue;
    charts.push({
      path: clean(params(chart).get("name") ?? ""),
      first: p.row,
      last: partEnd(p),
      hash: contentHash(p.text),
      ...chartCode(chart.children, p.row),
    });
  }
  return { isLibrary, dictionary: dd?.trim() || undefined, root, systemRef, charts };
}

/** A classic `.mdl`: `Model {` (or `Library {`) first, comments aside. */
const LEGACY_MDL = /^(?:[ \t]*(?:#[^\n]*)?\r?\n)*[ \t]*(?:Model|Library)[ \t]*\{/;

/** Undo an `.mdl` string's quoting: `"a\"b\n"` → `a"b` + newline. */
function unquote(s: string): string {
  const m = /^"((?:[^"\\]|\\.)*)"/.exec(s);
  const body = m ? m[1]! : s;
  return body.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "" : c));
}

/**
 * Read a classic `.mdl` into the same element shape the XML parts give: each
 * `Section {` an element, each `Key value` a `<P Name="Key">value</P>` child (a string
 * continued on the next lines joined back), and a block's BlockType, Name and SID
 * copied to its attributes, as in `<Block BlockType=… Name=… SID=…>`. Rows are the
 * file's own.
 */
export function parseMdl(text: string): XmlEl[] {
  const root: XmlEl = { name: "#root", attrs: {}, children: [], text: "", start: 0, end: 0 };
  const stack: XmlEl[] = [root];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t || t.startsWith("#")) continue;
    const top = stack[stack.length - 1]!;
    if (t === "}") {
      if (stack.length > 1) stack.pop()!.end = i;
      continue;
    }
    const section = /^([\w$.:]+)\s*\{$/.exec(t);
    if (section) {
      const el: XmlEl = { name: section[1]!, attrs: {}, children: [], text: "", start: i, end: i };
      top.children.push(el);
      stack.push(el);
      continue;
    }
    const pair = /^([\w$.:]+)\s+(.*)$/.exec(t);
    if (!pair) continue;
    const start = i;
    let value = pair[2]!;
    if (value.startsWith('"')) {
      value = unquote(value);
      while (i + 1 < lines.length && lines[i + 1]!.trim().startsWith('"')) value += unquote(lines[++i]!.trim());
    }
    top.children.push({ name: "P", attrs: { Name: pair[1]! }, children: [], text: value, start, end: i });
    if (pair[1] === "BlockType" || pair[1] === "Name" || pair[1] === "SID") top.attrs[pair[1]] = value;
  }
  while (stack.length > 1) stack.pop()!.end = lines.length - 1;
  return root.children;
}

/** A classic `.mdl`: the model's sections, and the flat `Stateflow { … }` objects
 * (charts, states, transitions, data, each pointing at its chart by id) regrouped into
 * charts, named by the block that holds them (`instance` objects). */
function modelFromMdl(source: string): ModelSource {
  const tops = parseMdl(source);
  const top = tops.find((e) => e.name === "Model" || e.name === "Library");
  const system = top ? kid(top, "System") : undefined;
  const root = system ? { system, row: 0, first: system.start, last: system.end } : undefined;
  const charts: ChartSource[] = [];
  const sf = tops.find((e) => e.name === "Stateflow");
  if (sf) {
    const id = (el: XmlEl): string | undefined => params(el).get("id")?.trim();
    const byChart = new Map<string, XmlEl[]>();
    const chartOfState = new Map<string, string>();
    for (const el of sf.children) {
      const chart = params(el).get("chart")?.trim();
      if (el.name === "state" && chart) chartOfState.set(id(el) ?? "", chart);
    }
    for (const el of sf.children) {
      const p = params(el);
      const parent = /^\[?\s*(\d+)/.exec(p.get("linkNode") ?? p.get("treeNode") ?? "")?.[1];
      const chart = p.get("chart")?.trim() ?? (parent ? (chartOfState.get(parent) ?? parent) : undefined);
      if (!chart || el.name === "chart" || el.name === "instance") continue;
      const list = byChart.get(chart) ?? [];
      list.push(el);
      byChart.set(chart, list);
    }
    const instances = new Map<string, string>();
    for (const el of sf.children) {
      if (el.name !== "instance") continue;
      const p = params(el);
      const chart = p.get("chart")?.trim();
      if (chart && p.get("name")) instances.set(chart, p.get("name")!);
    }
    const modelName = top ? (params(top).get("Name") ?? "") : "";
    // Split once for every chart: a classic .mdl runs to tens of MB.
    let lines: string[] | undefined;
    for (const el of sf.children) {
      if (el.name !== "chart") continue;
      const cid = id(el) ?? "";
      let path = clean(instances.get(cid) ?? params(el).get("name") ?? "");
      if (modelName && path.startsWith(`${modelName}/`)) path = path.slice(modelName.length + 1);
      const members = byChart.get(cid) ?? [];
      // Not Math.max(...): a chart's members can outnumber the arguments a call takes.
      const last = members.reduce((m, x) => Math.max(m, x.end), el.end);
      lines ??= source.split("\n");
      charts.push({ path, first: el.start, last, hash: contentHash(lines.slice(el.start, last + 1).join("\n")), ...chartCode([el, ...members], 0) });
    }
  }
  return {
    isLibrary: top?.name === "Library",
    dictionary: top ? params(top).get("DataDictionary")?.trim() || undefined : undefined,
    root,
    systemRef: () => undefined,
    charts,
  };
}

function model(rel: string, source: string, src: ModelSource): ExtractResult {
  const b = builder(rel, source);
  const modelName = basename(rel).replace(/\.(slx|mdl)$/i, "");
  if (src.dictionary) b.imp(src.dictionary);
  const what = src.isLibrary ? "Simulink library" : "Simulink model";
  const modelNode = b.mint(
    modelName,
    modelName,
    "module",
    src.root?.first ?? 0,
    src.root?.last ?? 0,
    `${what} ${modelName}${src.dictionary ? ` (data dictionary ${src.dictionary})` : ""}`,
    rel,
  );

  /** Subsystem path (as Stateflow names it: below the model) → its node. */
  const systems = new Map<string, NodeV1>();

  const walk = (system: XmlEl, row: number, path: string[], owner: NodeV1, isRoot: boolean): void => {
    const summary: string[] = [];
    for (const block of kids(system, "Block")) {
      const type = block.attrs.BlockType ?? "";
      const name = clean(block.attrs.Name ?? "");
      if (!name) continue;
      const p = params(block);
      summary.push(`${type} ${name}`);
      // Expressions in the block's parameters (and its mask's) name model data.
      for (const [key, value] of p) {
        if (EXPRESSION_PARAM.test(key)) {
          for (const d of namesIn(value).data) b.ref(owner.id, d, DATA_KINDS);
          summary.push(`${key}=${value}`);
        } else if (DATA_TYPE_PARAM.test(key)) {
          const t = typeName(value);
          if (t) b.ref(owner.id, t, TYPE_KINDS);
        }
      }
      for (const mp of findAll(kids(block, "Mask"), "MaskParameter")) {
        // A popup, checkbox or radio button holds one of its own option words.
        if (/^(?:popup|checkbox|radiobutton|combobox|listbox)$/i.test(mp.attrs.Type ?? "")) continue;
        const v = kid(mp, "Value")?.text;
        if (v) for (const d of namesIn(v).data) b.ref(owner.id, d, DATA_KINDS);
      }

      if (type === "SubSystem") {
        const inner = kid(block, "System");
        const ref = inner?.attrs.Ref ? src.systemRef(inner.attrs.Ref) : undefined;
        const child: SystemSource | undefined =
          ref ?? (inner ? { system: inner, row, first: row + block.start, last: row + block.end } : undefined);
        const flavor = p.get("SFBlockType");
        const kindWord = flavor === "Chart" ? "Stateflow chart" : flavor ? flavor : "SubSystem";
        const ports = p.get("Ports")?.trim();
        const childPath = [...path, name];
        const node = b.mint(
          [modelName, ...childPath].join("/"),
          name,
          "module",
          ref ? ref.first : row + block.start,
          ref ? ref.last : row + block.end,
          `${kindWord} ${name}${ports && ports !== "[]" ? ` ${ports}` : ""}`,
          owner.id,
        );
        systems.set(childPath.join("/"), node);
        if (child) walk(child.system, child.row, childPath, node, false);
      } else if (type === "ModelReference") {
        const ref = clean(p.get("ModelNameDialog") ?? p.get("ModelName") ?? "").replace(/\.(slx|mdl)$/i, "");
        if (/^[A-Za-z]\w*$/.test(ref)) {
          b.imp(ref);
          b.call(owner.id, ref);
          summary.push(`model ${ref}`);
        }
      } else if (type === "Reference") {
        const sourceBlock = clean(p.get("SourceBlock") ?? "");
        if (sourceBlock.includes("/")) b.ref(owner.id, sourceBlock, ["module"]);
      } else if (isRoot && (type === "Inport" || type === "Outport")) {
        const port = p.get("Port") ?? "1";
        b.mint([modelName, name].join("/"), name, "variable", row + block.start, row + block.end, `${type} ${name} (port ${port})`, owner.id);
      }
    }
    // A named signal line: the dictionary signal (or variable) it carries.
    for (const line of kids(system, "Line")) {
      const signal = params(line).get("Name");
      if (signal && /^[A-Za-z]\w*$/.test(signal.trim())) {
        b.ref(owner.id, signal.trim(), DATA_KINDS);
        summary.push(`signal ${signal.trim()}`);
      }
    }
    if (summary.length > 0) owner.body_text = searchBody(`${owner.signature ?? ""} ${summary.join("; ")}`);
  };
  if (src.root) walk(src.root.system, src.root.row, [], modelNode, true);

  // Stateflow charts and MATLAB Function blocks (charts too): what their states,
  // transitions, data and code use. A chart's node is the subsystem block it lives in;
  // its span becomes the chart's own text. A MATLAB script in it is parsed with the
  // MATLAB grammar when that is built, so its functions become nodes under the block
  // and its calls resolve like any MATLAB call; without it, names are read from the text.
  for (const chart of src.charts) {
    let node = systems.get(chart.path);
    if (!node) {
      const name = chart.path.split("/").pop() || "chart";
      node = b.mint([modelName, chart.path || name].join("/"), name, "module", chart.first, chart.last, `Stateflow chart ${name}`, modelNode.id);
    } else {
      node.span = `L${chart.first + 1}-L${chart.last + 1}`;
      node.body_hash = chart.hash;
    }
    const code = [...chart.code];
    const dataOnly: string[] = [];
    for (const script of chart.scripts) {
      const snippet = extractMatlabSnippet(rel, script.text);
      if (snippet) {
        b.graftSnippet(node, snippet, script.row, script.exactRows);
        dataOnly.push(script.text);
      } else {
        code.push(script.text);
      }
    }
    const used = namesIn(code.join("\n"));
    for (const d of [...used.data, ...namesIn(dataOnly.join("\n")).data]) b.ref(node.id, d, DATA_KINDS);
    for (const c of used.calls) b.call(node.id, c);
    node.body_text = searchBody(`${node.signature ?? ""} ${[...code, ...dataOnly].join(" ")}`);
  }

  b.nodes[0]!.body_text = searchBody(b.nodes.slice(1).map((n) => n.signature ?? n.name).join("; "));
  return { nodes: b.nodes, rawEdges: b.rawEdges };
}

// --- data dictionaries ---------------------------------------------------------------

/** The node kind of a dictionary entry, by its value's class. */
function entryKind(cls: string): Kind {
  if (/EnumTypeDefinition$|\.Enum$/i.test(cls)) return "enum";
  if (/(?:^|\.)(?:Bus|AliasType|NumericType|ValueType|StructType|ConnectionBus|LookupTable|Breakpoint)$/.test(cls)) return "type";
  if (/Signal$/.test(cls)) return "variable";
  return "constant";
}

function dictionaryFromXml(rel: string, source: string): ExtractResult {
  const b = builder(rel, source);
  for (const part of packageParts(source)) {
    for (const obj of findAll(parseXml(part.text), "Object")) {
      if (obj.attrs.Class !== "DD.ENTRY") continue;
      const p = params(obj);
      const name = p.get("Name")?.trim();
      if (!name) continue;
      const valueP = obj.children.find((c) => c.name === "P" && c.attrs.Name === "Value");
      const element = kid(valueP, "Element");
      const cls = element?.attrs.Class ?? valueP?.attrs.Class ?? "value";
      const props = element ? params(element) : new Map<string, string>();
      const dataType = props.get("DataType") ?? props.get("BaseType") ?? props.get("DataType_internal");
      const detail = [
        dataType,
        props.get("DocUnits") || props.get("Unit") || undefined,
        !element && valueP?.text.trim() ? `= ${valueP.text.trim()}` : undefined,
      ].filter(Boolean);
      const node = b.mint(
        name,
        name,
        entryKind(cls),
        part.row + obj.start,
        part.row + obj.end,
        `${name} : ${cls}${detail.length ? ` (${detail.join(", ")})` : ""}`,
        rel,
      );
      const t = typeName(dataType);
      if (t && t !== name) b.ref(node.id, t, TYPE_KINDS);
      // A parameter whose value is an expression names other entries.
      const value = props.get("Value");
      if (value && /[A-Za-z]/.test(value) && element?.children.some((c) => c.attrs.Name === "Value" && c.attrs.Class === "char")) {
        for (const d of namesIn(value).data) if (d !== name) b.ref(node.id, d, DATA_KINDS);
      }
      // Bus elements and enumeration members.
      if (node.kind !== "type" && node.kind !== "enum") continue;
      for (const member of findAll(element?.children ?? [], "Element")) {
        const mp = params(member);
        const mname = mp.get("Name")?.trim();
        if (!mname) continue;
        const isEnum = node.kind === "enum";
        const mtype = mp.get("DataType_internal") ?? mp.get("DataType");
        const child = b.mint(
          `${name}.${mname}`,
          mname,
          isEnum ? "constant" : "variable",
          part.row + member.start,
          part.row + member.end,
          isEnum ? `${name}.${mname} = ${mp.get("Value") ?? ""}`.trim() : `${name}.${mname}${mtype ? ` : ${mtype}` : ""}`,
          node.id,
        );
        const mt = typeName(mtype);
        if (mt) b.ref(child.id, mt, TYPE_KINDS);
      }
    }
  }
  return { nodes: b.nodes, rawEdges: b.rawEdges };
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const obj = (v: Json | undefined): Record<string, Json> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json>) : undefined;
const str = (v: Json | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** 0-based row of a character index, by binary search over the line starts. */
function rowFinder(source: string): (index: number) => number {
  const starts = [0];
  for (let k = source.indexOf("\n"); k !== -1; k = source.indexOf("\n", k + 1)) starts.push(k + 1);
  return (index: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
}

/** The JSON object whose `"name": "<name>"` key comes first at or after `from`: the
 * character range from its opening brace to the matching closing one (strings skipped). */
function jsonObjectRange(source: string, name: string, from: number): { open: number; close: number } | null {
  const key = new RegExp(`"name"\\s*:\\s*${JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
  key.lastIndex = from;
  const m = key.exec(source);
  if (!m) return null;
  const open = source.lastIndexOf("{", m.index);
  let depth = 0;
  let close = source.length - 1;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      for (i++; i < source.length && source[i] !== '"'; i++) if (source[i] === "\\") i++;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      close = i;
      break;
    }
  }
  return { open, close };
}

/** A dictionary saved in the text format: `__MW_TEXT_PARTS__` → `…/data/chunkN` →
 * `entries[]`, each with a `name` and a `value` carrying `_array_class` and the
 * object's `_properties`. */
function dictionaryFromJson(rel: string, source: string): ExtractResult {
  const b = builder(rel, source);
  let doc: Json;
  try {
    doc = JSON.parse(source) as Json;
  } catch {
    return { nodes: b.nodes, rawEdges: b.rawEdges };
  }
  const parts = obj(obj(doc)?.__MW_TEXT_PARTS__) ?? {};
  const rowAt = rowFinder(source);
  let cursor = 0;
  for (const [key, part] of Object.entries(parts)) {
    if (!/\/data\//.test(key)) continue;
    const entries = obj(obj(part)?.__MW_TEXT_content)?.entries;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const name = str(obj(entry)?.name);
      if (!name) continue;
      const range = jsonObjectRange(source, name, cursor);
      if (!range) continue;
      cursor = range.close + 1;
      const rows = { first: rowAt(range.open), last: rowAt(range.close) };
      const value = obj(obj(entry)?.value);
      const cls = str(value?._array_class) ?? (value ? "struct" : typeof obj(entry)?.value);
      const first = Array.isArray(value?._elements) ? obj(value!._elements[0] as Json) : undefined;
      const props = obj(first?._properties) ?? {};
      const dataType = str(props.DataType) ?? str(props.BaseType) ?? str(props.DataType_internal);
      const units = str(props.DocUnits) || str(props.Unit);
      const detail = [dataType, units].filter(Boolean);
      const node = b.mint(
        name,
        name,
        entryKind(cls),
        rows.first,
        rows.last,
        `${name} : ${cls}${detail.length ? ` (${detail.join(", ")})` : ""}`,
        rel,
      );
      const t = typeName(dataType);
      if (t && t !== name) b.ref(node.id, t, TYPE_KINDS);
      if (node.kind !== "type" && node.kind !== "enum") continue;
      // Bus elements (`Elements_internal`) and enumeration members (`Enumerals`).
      const nested = obj(props.Elements_internal) ?? obj(props.Enumerals);
      const members = Array.isArray(nested?._elements) ? nested!._elements : Array.isArray(props.Enumerals) ? props.Enumerals : [];
      let memberCursor = range.open;
      for (const m of members as Json[]) {
        const mp = obj(obj(m)?._properties) ?? obj(m) ?? {};
        const mname = str(mp.Name);
        if (!mname) continue;
        const mtype = str(mp.DataType_internal) ?? str(mp.DataType);
        const isEnum = node.kind === "enum";
        // Members sit inside the entry; each one's row is that of its "Name".
        const at = source.indexOf(`"Name": ${JSON.stringify(mname)}`, memberCursor);
        const row = at >= 0 && at < range.close ? rowAt(at) : rows.first;
        if (at >= 0) memberCursor = at + 1;
        const child = b.mint(
          `${name}.${mname}`,
          mname,
          isEnum ? "constant" : "variable",
          row,
          row,
          isEnum ? `${name}.${mname}` : `${name}.${mname}${mtype ? ` : ${mtype}` : ""}`,
          node.id,
        );
        const mt = typeName(mtype);
        if (mt) b.ref(child.id, mt, TYPE_KINDS);
      }
    }
  }
  return { nodes: b.nodes, rawEdges: b.rawEdges };
}
