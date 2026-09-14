/**
 * Per-call state for the surfaces that report savings — scoped to one graft
 * call, not to the process.
 *
 * Everything here started as module-level `let`s, which was correct while the
 * only caller was the CLI: one process answers one query and exits, so a
 * process-level slot and a per-call slot are the same thing. The MCP server
 * broke that assumption in a way nothing caught for a while. It is long-lived
 * and `callTool` is `async`, so two tool calls that overlap — which a client may
 * freely do, since JSON-RPC ids exist precisely to allow it — interleave at
 * every `await`. The second call's `setAgentModel` then lands before the first
 * has read its own, and the first is priced, reported and FILED under a model
 * that never ran it.
 *
 * `AsyncLocalStorage` fixes this at the root rather than at each slot: a store
 * entered with {@link runInCallScope} is visible to everything awaited inside
 * that call and invisible to everything else, so concurrent calls cannot see one
 * another no matter how they interleave. Outside any scope — the CLI, the hooks,
 * tests — reads and writes fall through to a process-level store, which keeps
 * those callers working exactly as before with no ceremony.
 *
 * The alternative was threading a context object through `withSavings` and all
 * seven of its callers, putting a billing parameter in the signature of every
 * retrieval formatter. That is the design this module exists to avoid.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { NO_MODEL, type Pricing } from './price.js';

/** Rows for the per-model savings table, priced for a given saving. */
export type ModelTable = (savedTokens: number) => Array<{ label: string; value: string }>;

/** Everything one graft call needs to report what it saved. */
export interface CallScope {
  /** What an input token costs here, and the model behind that price. */
  pricing: Pricing;
  /** The repo being answered for. */
  repoRoot: string | null;
  /** Per-model rows, when the host has a model list graft can read. */
  modelTable: ModelTable | null;
  /** Whether this call arrived over MCP, which has no `--agent-model` flag. */
  overMcp: boolean;
  /** Tokens this call has claimed in a savings footer, for the ledger. */
  claimedTokens: number;
  /** The model the agent named for THIS call. */
  agentModel: string | null;
}

function freshScope(): CallScope {
  return {
    pricing: { rate: null, model: NO_MODEL },
    repoRoot: null,
    modelTable: null,
    overMcp: false,
    claimedTokens: 0,
    agentModel: null,
  };
}

/**
 * The fallback store, used by every caller that never enters a scope: the CLI
 * (one process, one query), the Claude Code hooks, and the tests. Keeping it
 * rather than requiring a scope everywhere means this change is invisible to
 * them — and a missing scope degrades to the old behaviour instead of throwing
 * on a tool-call path.
 */
const processScope = freshScope();

const store = new AsyncLocalStorage<CallScope>();

/** The state this execution should read and write. */
export function callScope(): CallScope {
  return store.getStore() ?? processScope;
}

/**
 * Run `fn` with its own isolated state, so anything it awaits sees that state
 * and nothing outside can observe it. The MCP dispatch wraps each tool call in
 * this; every other caller simply doesn't, and keeps the process-level store.
 */
export function runInCallScope<T>(fn: () => T): T {
  return store.run(freshScope(), fn);
}
