/**
 * graft trusts the OS certificate store for outbound HTTPS, so a corporate root
 * (an internal LLM gateway, a TLS-inspecting proxy) works without per-machine
 * NODE_EXTRA_CA_CERTS. These pin the parts that matter: it is lazy (no store
 * read until a request), additive (Node's defaults stay), run-once, opt-out,
 * and harmless on a Node that lacks the API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystemCaTrust, installSystemCaFetch, systemCaEnabled, type CaApi } from "../src/util/system-ca.js";

function fakeTls(system: string[], defaults: string[] = ["BUNDLED"]) {
  const calls = { get: [] as string[], set: [] as string[][] };
  const api: CaApi = {
    getCACertificates: (type) => {
      calls.get.push(type);
      return type === "system" ? system : defaults;
    },
    setDefaultCACertificates: (certs) => {
      calls.set.push([...certs]);
    },
  };
  return { api, calls };
}

test("system roots are added to Node's defaults, not swapped in for them", () => {
  const { api, calls } = fakeTls(["CORP-ROOT", "BUNDLED"], ["BUNDLED", "EXTRA"]);
  assert.equal(createSystemCaTrust(api, {})(), true);
  assert.deepEqual(calls.set, [["BUNDLED", "EXTRA", "CORP-ROOT"]]);
});

test("the store is read once, however many requests follow", () => {
  const { api, calls } = fakeTls(["CORP-ROOT"]);
  const trust = createSystemCaTrust(api, {});
  trust();
  trust();
  trust();
  assert.equal(calls.set.length, 1);
  assert.equal(calls.get.filter((t) => t === "system").length, 1);
});

test("GRAFT_SYSTEM_CA=0 (and its spellings) opts out without reading the store", () => {
  for (const v of ["0", "false", "OFF", " no "]) {
    const { api, calls } = fakeTls(["CORP-ROOT"]);
    assert.equal(createSystemCaTrust(api, { GRAFT_SYSTEM_CA: v })(), false, v);
    assert.equal(calls.get.length, 0, v);
  }
  assert.equal(systemCaEnabled({}), true);
  assert.equal(systemCaEnabled({ GRAFT_SYSTEM_CA: "1" }), true);
});

test("a Node without the API, an empty store, or a throwing store leaves TLS untouched", () => {
  assert.equal(createSystemCaTrust({}, {})(), false);

  const empty = fakeTls([]);
  assert.equal(createSystemCaTrust(empty.api, {})(), false);
  assert.equal(empty.calls.set.length, 0);

  const throwing: CaApi = {
    getCACertificates: () => { throw new Error("store unreadable"); },
    setDefaultCACertificates: () => assert.fail("must not set"),
  };
  assert.equal(createSystemCaTrust(throwing, {})(), false);
});

test("the fetch wrapper trusts the store on first request only, then delegates unchanged", async () => {
  let trusted = 0;
  const seen: unknown[] = [];
  const target = { fetch: (async (input: unknown, init?: unknown) => { seen.push([input, init]); return new Response("ok"); }) as typeof fetch };
  installSystemCaFetch(target, () => trusted++);
  assert.equal(trusted, 0, "installing must not read the store");

  const res = await target.fetch("https://gateway.example/v1/models", { method: "GET" });
  assert.equal(await res.text(), "ok");
  await target.fetch("https://gateway.example/v1/chat");
  assert.equal(trusted, 2, "the wrapper defers to the run-once trust step on each call");
  assert.deepEqual(seen, [["https://gateway.example/v1/models", { method: "GET" }], ["https://gateway.example/v1/chat", undefined]]);
});

test("installing twice wraps once", () => {
  const original = (async () => new Response("")) as typeof fetch;
  const target = { fetch: original };
  installSystemCaFetch(target, () => {});
  const first = target.fetch;
  installSystemCaFetch(target, () => {});
  assert.notEqual(first, original);
  assert.equal(target.fetch, first);
});
