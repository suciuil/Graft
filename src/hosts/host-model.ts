/**
 * "Which model is the agent in front of me running?", asked of the host itself.
 *
 * Graft's honest answer to that question has always come from the agent: the
 * `--agent-model` flag, or the `model` argument over MCP. Measured against real
 * usage, that ask is mostly ignored — on one machine's history, 349 of 361 MCP
 * calls omitted it, and every one was filed unpriced. The instruction is not
 * going to start working by being repeated more loudly.
 *
 * This module is the fallback for the hosts that write the answer down
 * somewhere graft can read:
 *
 *   - Kilo Code   — a SQLite session row  (`kilo-session.ts`), reached over MCP.
 *   - VS Code     — a chat session log    (`vscode-session.ts`), reached by the
 *                   agent running the CLI in the integrated terminal, which is
 *                   how GitHub Copilot uses graft since graft registers no MCP
 *                   server for it.
 *
 * A registry rather than two call sites because the two surfaces that need it
 * are different (MCP dispatch, CLI `noteQuery`) while the question is identical,
 * and because a third host is then one entry rather than another bespoke branch
 * in a pricing path.
 *
 * ## The invariant this stays inside
 *
 * `ledger.ts` forbids pricing from a STANDING DECLARATION — a model written once
 * into a config file, still pricing confidently months after the user moved on,
 * indistinguishable on screen from a correct figure. Every source here is the
 * opposite: written by the host, per session, naming the model of the
 * conversation that is calling graft right now. It goes stale by disappearing
 * (the session stops being recent) rather than by lying, which is why each
 * reader enforces its own freshness window.
 *
 * Everything is best-effort. A reader that throws, finds nothing, or runs on a
 * host that isn't there yields null, and null means exactly today's behaviour:
 * tokens, no dollars.
 */
import { kiloSessionModel } from './kilo-session.js';
import { inVsCodeTerminal, vscodeSessionModel } from './vscode-session.js';

export interface HostModelSource {
  /** Which host this reads. Diagnostic only — never shown in a price. */
  id: string;
  /**
   * Whether this source applies to the process graft is running in.
   *
   * Deliberately separate from `read`: "is this host even here" is a cheap
   * environment question, while reading is filesystem work. It is also the gate
   * that stops one host's record pricing another host's session — the mistake
   * `mcp/client.ts` documents for the per-model table.
   */
  applies(env: NodeJS.ProcessEnv): boolean;
  /** The model this host says it is running for `repo`, or null. */
  read(repo: string, opts: HostModelOpts): string | null;
}

export interface HostModelOpts {
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: number;
  /**
   * The MCP client name from the `initialize` handshake, or null off that
   * surface. Threaded in rather than imported so this module stays usable from
   * the CLI, which never performs a handshake.
   */
  mcpClient?: string | null;
}

/** Kilo's own loose match on the handshake name, kept here so the registry does
 * not depend on the MCP layer. See `mcp/client.ts` for why it is a substring
 * match: the string is the host's to choose and has varied across releases. */
function isKilo(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.toLowerCase().replace(/[\s_-]+/g, '').includes('kilo');
}

/**
 * The sources, in priority order.
 *
 * Kilo first because it is the more specific claim: it is only consulted when
 * the MCP handshake actually said "Kilo", whereas the VS Code reader applies to
 * any terminal inside the editor. The two barely overlap in practice — Kilo
 * reaches graft over MCP and Copilot through the CLI — but when they do, the
 * host that named itself wins over the one merely inferred from an env var.
 */
export const HOST_MODEL_SOURCES: HostModelSource[] = [
  {
    id: 'kilo',
    applies: () => false, // MCP-only; enabled per call via `mcpClient` below.
    read: (repo, opts) => kiloSessionModel(repo, opts),
  },
  {
    id: 'vscode',
    applies: (env) => inVsCodeTerminal(env),
    read: (repo, opts) => vscodeSessionModel(repo, opts),
  },
];

/**
 * The model the HOST says it is running for `repo`, or null when none can say.
 *
 * Never throws: a source that fails is a source that answered null, because a
 * dollar figure is never worth failing a retrieval over.
 */
export function hostModelFor(repo: string, opts: HostModelOpts = {}): string | null {
  const env = opts.env ?? process.env;
  for (const source of HOST_MODEL_SOURCES) {
    // Kilo is gated on the handshake rather than the environment: its server is
    // spawned by the client that just named itself, and that name is the only
    // evidence graft has of which host it is serving.
    const applies = source.id === 'kilo' ? isKilo(opts.mcpClient) : source.applies(env);
    if (!applies) continue;
    try {
      const model = source.read(repo, opts);
      if (model && model.trim()) return model.trim();
    } catch {
      // Next source; a price is never worth failing a turn over.
    }
  }
  return null;
}
