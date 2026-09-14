/**
 * Which MCP client is on the other end of this server.
 *
 * The `initialize` handshake is the only place a client names itself
 * (`params.clientInfo.name`), and it happens exactly once per connection — so
 * the name is captured there and held for the life of the process rather than
 * re-derived per call. Everything downstream that needs to behave differently
 * per host reads it from here.
 *
 * Only ONE thing depends on it today, and the bar for adding a second is high:
 * host-conditional behaviour is how a tool ends up with eleven subtly different
 * code paths nobody can test. The one case that earns it is the per-model
 * savings table, which requires reading a host's own configuration file — a
 * thing graft can only do for hosts whose config shape it has actually seen.
 *
 * Process-level for the same reason `context/savings.ts` holds the rate that
 * way: one stdio server serves one client, and threading a host id through
 * every tool signature would buy nothing.
 */

/** The raw `clientInfo.name` from the handshake, or null before/without one. */
let clientName: string | null = null;

/** Record the client that just introduced itself. Blank and non-string both
 * clear it: a client that sends `{"name":""}` has told us nothing. */
export function setMcpClient(name: unknown): void {
  clientName = typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** The connected client's self-reported name, or null over a non-MCP surface
 * (the CLI) or from a client that sent none. */
export function mcpClient(): string | null {
  return clientName;
}

/**
 * Is the caller Kilo Code?
 *
 * Matched loosely on the client name because the string is the host's to
 * choose and has varied across releases ("Kilo Code", "kilocode", "kilo-code").
 * A false positive costs a table of models the user may not run; a false
 * negative costs a bare token count. Neither is severe, which is why a
 * substring match is proportionate here and would not be for anything
 * behavioural.
 */
export function isKiloClient(): boolean {
  return clientName !== null && clientName.toLowerCase().replace(/[\s_-]+/g, '').includes('kilo');
}
