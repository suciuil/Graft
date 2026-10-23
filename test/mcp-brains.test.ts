/**
 * Upstream's local `trail mcp` server serves a workspace's brains once a
 * machine is connected. Trail cloud is permanently off in this version, so a
 * stored connection is ignored: the brain tools are never listed, nothing is
 * sent to a workspace, and the repo tools answer as always.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { buildGraph } from "../src/graph/build.js";
import { BRAIN_TOOL_DEFS } from "../src/mcp/brains.js";
import { startFakeTrail, TOKEN, type FakeTrail } from "./fake-trail-server.js";

let trail: FakeTrail | null = null;
after(async () => {
  await trail?.close();
});

async function rpc(messages: object[], dir: string, env: NodeJS.ProcessEnv, expected: number, extra: string[] = []): Promise<any[]> {
  const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), "mcp", dir, ...extra], { stdio: ["pipe", "pipe", "pipe"], env });
  const responses: any[] = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });
  for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  const deadline = Date.now() + 20000;
  while (responses.length < expected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  await once(child, "exit").catch(() => {});
  return responses;
}

const SESSION = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_context", arguments: { query: "how do we write the product name" } } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "trail_find_code", arguments: { query: "retryDo" } } },
];

async function builtRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mcp-brains-"));
  writeFileSync(join(dir, "client.ts"), "export function retryDo(n: number): number {\n  return n;\n}\n");
  writeFileSync(join(dir, "a.ts"), 'import { retryDo } from "./client";\nexport const a = retryDo(4);\n');
  await buildGraph(dir);
  return dir;
}

function envWith(cloud: object | null): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "mcp-brains-home-"));
  const trailHome = join(home, ".trail");
  mkdirSync(trailHome, { recursive: true });
  if (cloud) writeFileSync(join(trailHome, "cloud.json"), JSON.stringify(cloud));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: trailHome, DO_NOT_TRACK: "1", TRAIL_INVOKED_AS: "trail" };
  delete env.TRAIL_MCP_URL;
  return env;
}

function cloudFor(url: string, token = TOKEN) {
  return {
    url,
    token,
    user: { name: "R", email: "r@acme.test" },
    workspace: { id: "w1", name: "Acme", slug: "w1", url, invite_url: url },
    repos: [],
    linkedAt: 1,
    via: "connect",
  };
}

const BRAINS = ["list_brains", "get_context", "search_rules", "get_rules"];

// Trail cloud is permanently off in this version: a stored connection is
// ignored, so the brain tools are never listed and nothing reaches a workspace.

test("a stored connection is ignored: no brain tools, no workspace call, and the repo tools still work", async () => {
  trail = await startFakeTrail();
  const dir = await builtRepo();
  const rs = await rpc(SESSION, dir, envWith(cloudFor(trail.url)), 4);
  assert.doesNotMatch(rs.find((r) => r.id === 1).result.instructions, /Connected to a Trail workspace/);
  const names = rs.find((r) => r.id === 2).result.tools.map((t: any) => t.name);
  assert.ok(names.includes("trail_find_code"), names.join(","));
  for (const b of BRAINS) assert.ok(!names.includes(b), `${b} listed`);
  assert.equal(rs.find((r) => r.id === 4).result.isError, false);
  assert.equal(trail.log.filter((l) => l.path === "/api/v1/mcp").length, 0, "nothing reaches the workspace");
});

test("not connected: no brain tools, and the instructions are what they always were", async () => {
  const dir = await builtRepo();
  const rs = await rpc(SESSION.slice(0, 3), dir, envWith(null), 2);
  const names = rs.find((r) => r.id === 2).result.tools.map((t: any) => t.name);
  assert.ok(names.includes("trail_find_code"));
  for (const b of BRAINS) assert.ok(!names.includes(b));
  assert.doesNotMatch(rs.find((r) => r.id === 1).result.instructions, /Trail workspace/);
});

test("trail mcp --brains lists no tools, connection stored or not", async () => {
  trail ??= await startFakeTrail();
  const dir = await builtRepo();
  for (const cloud of [cloudFor(trail.url), null]) {
    const rs = await rpc(SESSION.slice(0, 3), dir, envWith(cloud), 2, ["--brains"]);
    assert.deepEqual(rs.find((r) => r.id === 2).result.tools, []);
    assert.match(rs.find((r) => r.id === 1).result.instructions, /Not connected to a Trail workspace/);
  }
  assert.equal(trail.log.filter((l) => l.path === "/api/v1/mcp").length, 0);
});

// Still exported for the day the connector returns; the offline copy is pinned here.
test("the brain tool definitions keep their names", () => {
  assert.deepEqual(BRAIN_TOOL_DEFS.map((d) => d.name), BRAINS);
});
