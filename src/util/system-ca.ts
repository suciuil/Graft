/**
 * Trust the operating system's certificate store for graft's outbound HTTPS.
 *
 * Node trusts only its bundled Mozilla roots. On a corporate network the LLM
 * gateway (or a TLS-inspecting proxy in front of everything) presents a chain
 * signed by a company root that lives in the OS store, which is why curl and
 * browsers work while every graft LLM call fails with the SDK's bare
 * "Connection error." (underneath: SELF_SIGNED_CERT_IN_CHAIN). IT already
 * deploys that root to the OS store, so adding the store fixes it on every
 * machine with no NODE_EXTRA_CA_CERTS or NODE_OPTIONS to configure, and it
 * holds however graft is launched: a shell, an agent's hook, or an MCP server
 * started by any host with its own environment.
 *
 * Lazy: reading the store costs ~100 ms, too much for `graft ask`, MCP queries
 * and hooks that never touch the network, so it happens on the first fetch.
 * Additive: Node's default set (bundled roots plus NODE_EXTRA_CA_CERTS) stays.
 * Opt out with GRAFT_SYSTEM_CA=0. A no-op on Node versions without the API.
 */
import tls from "node:tls";

/** The slice of `node:tls` this needs — a seam so tests don't touch process-wide TLS state. */
export interface CaApi {
  getCACertificates?: (type: "default" | "system") => string[];
  setDefaultCACertificates?: (certs: ReadonlyArray<string>) => void;
}

const OFF = new Set(["0", "false", "off", "no"]);

export function systemCaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.GRAFT_SYSTEM_CA?.trim().toLowerCase();
  return !(v && OFF.has(v));
}

/** A run-once trust step: the first call decides, later calls return that answer. */
export function createSystemCaTrust(api: CaApi = tls as CaApi, env: NodeJS.ProcessEnv = process.env): () => boolean {
  let applied: boolean | null = null;
  return () => {
    if (applied !== null) return applied;
    applied = false;
    if (!systemCaEnabled(env)) return false;
    if (typeof api.getCACertificates !== "function" || typeof api.setDefaultCACertificates !== "function") return false;
    try {
      const system = api.getCACertificates("system");
      if (system.length === 0) return false;
      api.setDefaultCACertificates([...new Set([...api.getCACertificates("default"), ...system])]);
      applied = true;
    } catch {
      // An unreadable store must not take the request down with it; Node's defaults still apply.
    }
    return applied;
  };
}

export const trustSystemCA = createSystemCaTrust();

const WRAPPED = Symbol.for("graft.systemCaFetch");

/**
 * Route `fetch` through {@link trustSystemCA} on first use. Both LLM SDKs and
 * graft's own clients read `globalThis.fetch` when they are created or called,
 * so this must run before any of them; idempotent.
 */
export function installSystemCaFetch(
  target: { fetch?: typeof fetch } = globalThis,
  trust: () => unknown = trustSystemCA,
): void {
  const original = target.fetch;
  if (typeof original !== "function" || (original as unknown as Record<symbol, unknown>)[WRAPPED]) return;
  const wrapped = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    trust();
    return original(input, init);
  }) as typeof fetch;
  (wrapped as unknown as Record<symbol, unknown>)[WRAPPED] = true;
  target.fetch = wrapped;
}
