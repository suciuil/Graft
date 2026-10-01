/**
 * Full-fidelity Kotlin extraction (the depth tier, #130) on the locally-built
 * grammar, and Kotlin's place in both `--deep` LLM passes.
 *
 * Kotlin has two grammars: the registry `tree-sitter-kotlin` (always installed) and
 * a newer one built from the sibling `../tree-sitter-kotlin` checkout
 * (`tree-sitter-kotlin-local`). The local one wins whenever it is built — the
 * registry grammar collapses ordinary class headers (a primary constructor plus a
 * `: Base(…)` clause, a secondary constructor delegating to `this(…)`) into ERROR
 * nodes and loses the members inside them. Most of these tests hold on either
 * grammar; the ones that only the local grammar can parse skip without it.
 *
 * What these pin, and why each matters:
 *  - the kind split: `class_declaration` is one node type for class / interface /
 *    enum class / annotation class, told apart only by keywords;
 *  - heritage through every delegation-specifier shape — a superclass is a
 *    `constructor_invocation`, a delegated interface an `explicit_delegation`, and
 *    reading only a bare `user_type` silently dropped both;
 *  - the one-line `object X { … }` the 0.4 grammar misparses as an infix call, which
 *    otherwise makes the object vanish and its members read as top-level functions;
 *  - `--deep`: every Kotlin symbol (`.kt` and `.kts`) is summarized, and `.kts`
 *    scripts are part of the concept map.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { extractFile, grammarAvailable, grammarSourceOf, languageOf, type RawEdge } from "../src/graph/extract.js";
import { CODE_EXTENSIONS, buildContext } from "../src/context/build.js";
import type { CruxSummarizer, FileCruxInput, NodeCrux } from "../src/ai/crux.js";
import type { NodeV1 } from "../src/graph/types.js";
import { fakeProviders, tmpRepo } from "./helpers.js";

const localGrammar = grammarAvailable("kotlin");
const needsLocal = localGrammar ? false : "local tree-sitter-kotlin grammar not built (npm run build:grammars)";

function extract(source: string, rel = "src/App.kt"): { nodes: NodeV1[]; rawEdges: RawEdge[] } {
  return extractFile(rel, source, "kotlin");
}

function byName(nodes: NodeV1[], name: string): NodeV1[] {
  return nodes.filter((n) => n.name === name);
}

function extendsOf(rawEdges: RawEdge[], source: string): string[] {
  return rawEdges
    .filter((e) => e.relation === "extends" && e.source === source)
    .map((e) => e.name!)
    .sort();
}

test("kotlin: the locally-built grammar is preferred, the registry grammar is the fallback", () => {
  // Either way Kotlin is parsed — `.kt`/`.kts` never depend on the local build.
  assert.equal(languageOf("src/App.kt"), "kotlin");
  assert.equal(languageOf("build.gradle.kts"), "kotlin");
  assert.equal(grammarSourceOf("kotlin"), localGrammar ? "optional" : "core");
});

test("kotlin: class_declaration keywords map to their real kinds", () => {
  const { nodes } = extract(`
class Animal
interface Greeter
enum class Color { RED, GREEN }
annotation class Marker
typealias Handler = (String) -> Unit
val DEFAULT_NAME = "x"
object Registry {
  fun register() {}
}
`);
  assert.equal(byName(nodes, "Animal")[0]?.kind, "class");
  assert.equal(byName(nodes, "Greeter")[0]?.kind, "interface");
  assert.equal(byName(nodes, "Color")[0]?.kind, "enum");
  assert.equal(byName(nodes, "Marker")[0]?.kind, "interface");
  assert.equal(byName(nodes, "Handler")[0]?.kind, "type");
  assert.equal(byName(nodes, "DEFAULT_NAME")[0]?.kind, "variable");
  assert.equal(byName(nodes, "Registry")[0]?.kind, "class");
  const register = byName(nodes, "register")[0];
  assert.equal(register?.kind, "method");
  assert.equal(register?.owner, "Registry");
});

test("kotlin: members are methods owned by their type; fields are not definitions", () => {
  const { nodes } = extract(`
class Service {
  val cache = mutableMapOf<String, Int>()
  fun load() {}
  companion object {
    fun create(): Service = Service()
  }
}

fun String.shout(): String = uppercase()
`);
  const load = byName(nodes, "load")[0];
  assert.equal(load?.kind, "method");
  assert.equal(load?.owner, "Service");
  assert.equal(load?.id, "src/App.kt#Service.load");
  // A companion object is transparent: its members are called as `Service.create()`.
  assert.equal(byName(nodes, "create")[0]?.owner, "Service");
  assert.equal(byName(nodes, "cache").length, 0, "a class property is a field, not a node");
  // An extension function is a top-level function named without its receiver.
  assert.equal(byName(nodes, "shout")[0]?.kind, "function");
});

test("kotlin: visibility modifiers decide exported", () => {
  const { nodes } = extract(`
class Api {
  fun open() {}
  public fun explicit() {}
  internal fun module() {}
  protected fun sub() {}
  private fun hidden() {}
}
`);
  const exported = (name: string) => byName(nodes, name)[0]?.exported;
  assert.equal(exported("Api"), true);
  assert.equal(exported("open"), true, "public is implicit");
  assert.equal(exported("explicit"), true);
  assert.equal(exported("module"), false);
  assert.equal(exported("sub"), false);
  assert.equal(exported("hidden"), false);
});

test("kotlin: heritage covers superclass calls, interfaces, delegation and qualified names", () => {
  const { rawEdges } = extract(`
open class Base(val id: Int)
interface Greeter
class Service(id: Int) : Base(id), Greeter, Runnable by Worker()
class Remote : com.acme.net.Client(), java.io.Serializable
object Main : Base(0)
`);
  assert.deepEqual(extendsOf(rawEdges, "src/App.kt#Service"), ["Base", "Greeter", "Runnable"]);
  assert.deepEqual(extendsOf(rawEdges, "src/App.kt#Remote"), ["Client", "Serializable"]);
  assert.deepEqual(extendsOf(rawEdges, "src/App.kt#Main"), ["Base"]);
});

test("kotlin: a one-line object declaration is an object, not an infix call", () => {
  const { nodes } = extract(`
object Keys { const val A = "a"; fun all() = listOf(A) }
data object Idle { fun tick() {} }
`);
  assert.equal(byName(nodes, "Keys")[0]?.kind, "class");
  assert.equal(byName(nodes, "Idle")[0]?.kind, "class");
  assert.equal(byName(nodes, "all")[0]?.owner, "Keys", "members stay on their object");
  assert.equal(byName(nodes, "tick")[0]?.owner, "Idle");
  assert.ok(
    !nodes.some((n) => (n.name === "all" || n.name === "tick") && n.kind === "function"),
    "no member may leak out as a top-level function",
  );
});

test("kotlin: genuine infix calls stay calls", () => {
  const { nodes } = extract(`
val pair = 1 to 2
fun shift(x: Int) = x shl 2
fun dsl() { html body { p() } }
`);
  assert.deepEqual(
    nodes.filter((n) => n.kind !== "file").map((n) => `${n.kind}:${n.name}`).sort(),
    ["function:dsl", "function:shift", "variable:pair"],
  );
});

test("kotlin: call edges — bare, member with receiver, this and super", () => {
  const { rawEdges } = extract(`
class Animal {
  fun greet() {}
  fun walk() {
    this.greet()
    super.toString()
    helper()
    repo.find()
  }
}
fun helper() {}
`);
  const calls = rawEdges.filter((e) => e.relation === "calls" && e.source === "src/App.kt#Animal.walk");
  const find = (name: string) => calls.find((e) => e.name === name);
  assert.equal(find("helper")?.viaMember, false);
  assert.equal(find("greet")?.viaMember, true);
  assert.equal(find("greet")?.recvType, "Animal", "`this.` resolves to the enclosing class");
  assert.equal(find("toString")?.viaMember, true);
  assert.equal(find("find")?.viaMember, true);
});

test("kotlin: imports yield one edge per header, wildcard and alias dropped", () => {
  const { rawEdges } = extract(`
package com.acme.app

import com.acme.core.Repo
import com.acme.util.*
import kotlin.math.max as maxOf
`);
  assert.deepEqual(
    rawEdges.filter((e) => e.relation === "imports").map((e) => e.specifier).sort(),
    ["com.acme.core.Repo", "com.acme.util", "kotlin.math.max"],
  );
});

test("kotlin (local grammar): a primary-constructor class with a delegating secondary constructor keeps its members", { skip: needsLocal }, () => {
  // The registry grammar turns this whole class body into ERROR nodes, so none of
  // the members below would exist in the graph — the reason the local grammar wins.
  const { nodes, rawEdges } = extract(`
class Service(private val repo: Repo) : Base(1), Greeter, Runnable by Impl() {
  constructor(repo: Repo, n: Int) : this(repo)
  override fun greet(name: String): String = helper(name)
  internal fun load() { repo.find(); this.greet("a") }
  companion object { fun create(): Service = Service(Repo()) }
}
`);
  const members = nodes.filter((n) => n.owner === "Service").map((n) => n.name).sort();
  assert.deepEqual(members, ["Service", "create", "greet", "load"]);
  assert.deepEqual(extendsOf(rawEdges, "src/App.kt#Service"), ["Base", "Greeter", "Runnable"]);
});

/** A crux summarizer that records which files and symbols it was asked about. */
class RecordingCrux implements CruxSummarizer {
  paths: string[] = [];
  ids: string[] = [];
  async describeFile(input: FileCruxInput): Promise<NodeCrux[]> {
    this.paths.push(input.path);
    this.ids.push(...input.nodes.map((n) => n.id));
    return input.nodes.map((n) => ({ id: n.id, summary: `does ${n.id}`, crux_start: 0, crux_end: 0 }));
  }
}

function kotlinRepo(): string {
  const dir = tmpRepo("kotlin");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "Service.kt"),
    "package app\n\nclass Service {\n  fun load(): Int {\n    return helper()\n  }\n}\n\nfun helper(): Int = 1\n",
  );
  writeFileSync(
    join(dir, "build.gradle.kts"),
    'plugins {\n  kotlin("jvm")\n}\n\nfun versionOf(name: String): String = name\n',
  );
  return dir;
}

test("kotlin --deep: every Kotlin symbol, in .kt and .kts, gets a summary and crux", async () => {
  const dir = kotlinRepo();
  try {
    const crux = new RecordingCrux();
    const r = await buildGraph(dir, { summarizer: crux, concurrency: 1 });
    assert.deepEqual(crux.paths.sort(), ["build.gradle.kts", "src/Service.kt"]);
    assert.equal(r.meaning.pending, 0);
    assert.equal(r.meaning.failedFiles, 0);

    const graph = readGraph(wiringPath(r.contextDir))!;
    const kotlin = graph.nodes.filter((n) => n.path.endsWith(".kt") || n.path.endsWith(".kts"));
    for (const id of ["src/Service.kt#Service", "src/Service.kt#Service.load", "src/Service.kt#helper", "build.gradle.kts#versionOf"]) {
      const n = kotlin.find((k) => k.id === id);
      assert.equal(n?.summary_state, "ready", `${id} should be summarized`);
      assert.equal(n?.summary, `does ${id}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kotlin --deep: .kts scripts are part of the concept map, like .kt sources", async () => {
  assert.ok(CODE_EXTENSIONS.includes(".kt"));
  assert.ok(CODE_EXTENSIONS.includes(".kts"));
  const dir = kotlinRepo();
  try {
    const summarized: string[] = [];
    const inner = fakeProviders();
    await buildContext(dir, {
      model: "fake",
      synthesizer: inner.synthesizer,
      summarizer: {
        async summarize(code: string, opts: { path: string }) {
          summarized.push(opts.path);
          return inner.summarizer.summarize(code, opts);
        },
      },
    });
    assert.deepEqual(summarized.sort(), ["build.gradle.kts", "src/Service.kt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
