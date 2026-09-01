/**
 * The gate: the one hook that can answer a tool call with "no, run this instead".
 *
 * Every other surface graft has — the skill file, the instruction block, the
 * per-prompt retrieval pack — ADVISES. An agent that ignores them pays the token
 * cost silently and nobody finds out. This hook is the only place the guidance
 * BINDS: a `PreToolUse` hook may deny the call, and the denial message is the
 * thing the agent reads next.
 *
 * The contract, in full, because every clause is load-bearing:
 *
 *   - It refuses ONCE per distinct call. The refusal is recorded in the session
 *     file (`gateDenied`, a list of short hashes); an identical call that comes
 *     back is allowed through. Re-issuing IS the override, so the gate is a
 *     redirect, never a wall — no agent can be stuck, and no human has to go
 *     find a flag when graft genuinely has no answer.
 *   - It only refuses calls that have a real graft equivalent: a repo-wide
 *     literal search, or a whole-file read of a file that is actually in the
 *     graph. Everything else is allowed without comment.
 *   - A RANGED read is never refused. Opening the exact span graft pointed at is
 *     the behaviour the gate exists to produce; refusing it would be perverse.
 *   - It FAILS OPEN. Every error path, every unknown shape, every unreadable
 *     graph allows the call. A hook that is blocked on the agent's critical path
 *     must never be the reason a turn cannot proceed, and the hook's timeout
 *     (5s) is treated by the host as "no opinion" for the same reason.
 *   - `GRAFT_NO_GATE=1` disables it entirely. A human's switch, not a workaround.
 *
 * Tool vocabularies differ per host (`Bash` vs `shell` vs `local_shell`, `Read`
 * vs `read_file`), so names are normalized here and one handler covers every
 * host that installs the hook — see `hosts/codex-hooks.ts` for the Codex matcher.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { contentHash } from '../util/id.js';
import { readWiring } from './stats.js';
import { readSession, writeSession } from './state.js';

/** How many distinct refusals one session remembers. A bound, not a policy:
 *  the list only ever grows by one per refused call, but a very long session
 *  should not carry an unbounded array in its state file. Oldest drop first;
 *  the worst case of a dropped entry is one extra redirect. */
const MAX_DENIED = 256;

/** Short enough to keep the session file small, long enough that two distinct
 *  calls will not collide in any real session. */
const KEY_LEN = 16;

/** What the gate decided, and why. Returned rather than printed so the decision
 *  is testable without capturing stdout. */
export interface GateDecision {
  /** True when the call should be refused. */
  deny: boolean;
  /** The message shown to the agent. Empty when allowing. */
  reason: string;
  /** Stable key for this call, so the refusal can be recorded and overridden. */
  key: string;
}

const ALLOW: GateDecision = { deny: false, reason: '', key: '' };

/**
 * Normalize a host's tool name onto the three roles the gate knows about.
 * Unknown names return null and are always allowed: a matcher that is wider
 * than this list (Codex's is, deliberately) must not cause a refusal for a tool
 * whose shape we have not reasoned about.
 */
export function toolRole(toolName: string): 'read' | 'grep' | 'shell' | null {
  const t = toolName.toLowerCase().trim();
  if (t === 'read' || t === 'read_file' || t === 'readfile') return 'read';
  if (t === 'grep' || t === 'search' || t === 'grep_search') return 'grep';
  if (t === 'bash' || t === 'shell' || t === 'local_shell' || t === 'run_terminal_cmd') return 'shell';
  return null;
}

/**
 * Whether a `Read` call asks for a bounded slice rather than the whole file.
 *
 * Hosts spell this several ways (`offset`/`limit`, `start_line`/`end_line`,
 * `line_range`). Any of them means the agent already knows where it is going —
 * which is the outcome the gate wants — so the call goes straight through.
 */
function isRangedRead(toolInput: any): boolean {
  if (!toolInput || typeof toolInput !== 'object') return false;
  for (const k of ['offset', 'limit', 'start_line', 'end_line', 'startLine', 'endLine', 'line_range', 'range']) {
    const v = toolInput[k];
    if (typeof v === 'number' && Number.isFinite(v)) return true;
    if (Array.isArray(v) && v.length > 0) return true;
  }
  return false;
}

/**
 * A repo-wide literal search in a shell command line: `rg foo`, `grep -rn foo`,
 * `git grep foo`, `ag`, `ack`. Deliberately narrow.
 *
 * A `grep` that is READING A PIPE (`cat x | grep y`) or filtering another
 * command's output is not a repo search and is left alone — graft has no
 * equivalent for it, so refusing would be noise. Same for a grep given an
 * explicit single file argument.
 */
export function isRepoSearchCommand(command: string): boolean {
  const c = command.trim();
  if (!c) return false;
  // A pipeline whose grep consumes upstream output is a filter, not a search.
  if (/\|\s*(rg|grep|ag|ack)\b/.test(c)) return false;
  return /(^|[|&;]\s*)(git\s+grep|rg|grep|ag|ack)\b/.test(c);
}

/**
 * A whole-file dump in a shell command line: `cat file`, `type file` (Windows).
 * `head`/`tail`/`sed -n` are ranged reads by construction and never match.
 * Returns the file argument, or null.
 */
export function wholeFileCatTarget(command: string): string | null {
  const c = command.trim();
  if (/[|<>]/.test(c)) return null; // piped or redirected: not a plain read
  const m = /^(?:cat|type)\s+(?:-\S+\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(c);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Repo-relative, posix-separated path for `file`, or null when it escapes the
 *  repo (a path outside the indexed tree is never "an indexed file"). */
function repoRelative(dir: string, file: string): string | null {
  const abs = isAbsolute(file) ? resolve(file) : resolve(join(dir, file));
  const rel = relative(resolve(dir), abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

/**
 * Whether this repo has a graph with any file in it at all.
 *
 * The precondition for the gate as a whole, not just for the read branch. Every
 * redirect this module writes names a `graft …` command, and in a repo that has
 * never been built (or whose graph is empty or unreadable) every one of those
 * commands answers nothing. Refusing there would trade a working tool call for
 * a broken one — so an unbuilt repo is gate-free, silently.
 */
function hasGraph(dir: string): boolean {
  try {
    const w = readWiring(dir);
    return !!w && (w.nodes ?? []).some((n) => n.kind === 'file');
  } catch {
    return false;
  }
}

/**
 * Whether the graph has a file node for this path — i.e. graft can actually
 * answer instead. A file graft does NOT index (a doc, a lockfile, something
 * created this session) has no equivalent, so reading it whole is the correct
 * move and is never refused.
 *
 * Fails open in every direction: no graph, unreadable graph, path outside the
 * repo, or a path under `graft/` itself all report "not indexed".
 */
export function isIndexedFile(dir: string, file: string): boolean {
  const rel = repoRelative(dir, file);
  if (!rel || rel.startsWith('graft/')) return false;
  try {
    const w = readWiring(dir);
    if (!w) return false;
    return (w.nodes ?? []).some((n) => n.kind === 'file' && n.path === rel);
  } catch {
    return false;
  }
}

/** The stable identity of a call, so "the same call again" can be recognised.
 *  Role + the payload that decides the verdict; nothing time- or session-varying,
 *  or the override would never trigger. */
function callKey(role: string, payload: string): string {
  return contentHash(`${role}\u0000${payload}`).slice(0, KEY_LEN);
}

/** The refusal text for a repo-wide search. Names the command to run instead —
 *  a refusal that does not say what to do next is just an obstacle. */
function grepRedirect(literal: string | null): string {
  const q = literal ? `graft grep "${literal}"` : 'graft grep "<literal>"';
  return (
    `[graft] Use \`${q}\` instead — it is exhaustive over indexed files and groups ` +
    `hits by enclosing symbol, for a fraction of the tokens.\n` +
    `If graft has no answer here (an unindexed file, a doc, a lockfile, something ` +
    `created this session), re-issue this exact call and it will run.`
  );
}

/** The refusal text for a whole-file read of an indexed file. */
function readRedirect(rel: string): string {
  return (
    `[graft] \`${rel}\` is indexed. Use \`graft skeleton ${rel}\` for its definitions ` +
    `(~10× cheaper than reading it whole), or \`graft ask "<question>" --source\` for the ` +
    `spans that answer a specific question — then read the exact file:line range if you ` +
    `still need it.\nA ranged read is never gated. If you truly need the whole file, ` +
    `re-issue this exact call and it will run.`
  );
}

/** The literal a repo search is looking for, best-effort, so the redirect can
 *  name the exact replacement command. Null when it cannot be read out cleanly —
 *  the redirect then shows the generic form rather than a wrong one. */
function searchLiteral(command: string): string | null {
  const m = /(?:^|[|&;]\s*)(?:git\s+grep|rg|grep|ag|ack)\s+((?:-\S+\s+)*)(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command.trim());
  if (!m) return null;
  const lit = m[2] ?? m[3] ?? m[4] ?? null;
  if (!lit || lit.startsWith('-')) return null;
  return lit;
}

/**
 * Decide one tool call. Pure: no I/O beyond reading the graph, no session
 * writes, no printing — so the whole policy is testable directly.
 */
export function evaluate(input: any, dir: string): GateDecision {
  const role = toolRole(String(input?.tool_name ?? ''));
  if (!role) return ALLOW;
  // Nothing to redirect TO in a repo with no graph: every message this module
  // writes names a `graft …` command that would answer nothing there.
  if (!hasGraph(dir)) return ALLOW;
  const ti = input?.tool_input ?? {};

  if (role === 'grep') {
    const pattern = String(ti?.pattern ?? ti?.query ?? ti?.regex ?? '').trim();
    // A grep scoped to ONE file is a targeted read, not a repo search.
    const path = String(ti?.path ?? ti?.file ?? ti?.file_path ?? '').trim();
    if (path && /\.[A-Za-z0-9]+$/.test(path)) return ALLOW;
    if (!pattern) return ALLOW;
    return { deny: true, reason: grepRedirect(pattern), key: callKey('grep', pattern) };
  }

  if (role === 'read') {
    if (isRangedRead(ti)) return ALLOW;
    const file = String(ti?.file_path ?? ti?.path ?? ti?.target_file ?? '').trim();
    if (!file) return ALLOW;
    if (!isIndexedFile(dir, file)) return ALLOW;
    const rel = repoRelative(dir, file)!;
    return { deny: true, reason: readRedirect(rel), key: callKey('read', rel) };
  }

  // shell
  const command = String(ti?.command ?? ti?.cmd ?? '').trim();
  if (!command) return ALLOW;
  if (isRepoSearchCommand(command)) {
    return { deny: true, reason: grepRedirect(searchLiteral(command)), key: callKey('grep', command) };
  }
  const target = wholeFileCatTarget(command);
  if (target && isIndexedFile(dir, target)) {
    const rel = repoRelative(dir, target)!;
    return { deny: true, reason: readRedirect(rel), key: callKey('read', rel) };
  }
  return ALLOW;
}

/** Emit a PreToolUse deny in the shape Claude Code and the Codex-family hosts
 *  both read. `permissionDecision: 'deny'` is the binding field; `reason` is what
 *  the agent is shown. */
function emitDeny(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
}

/**
 * The hook entry point. Writes a deny to stdout and records it, or returns
 * silently to allow.
 *
 * Wrapped whole in a try/catch that allows: this runs with the agent's tool call
 * stalled behind it, so any bug here must cost a redirect, never the turn.
 */
export function handlePreTool(input: any, dir: string): void {
  try {
    if (process.env.GRAFT_NO_GATE === '1') return;
    // Nothing to redirect to until the repo has actually been built.
    if (!existsSync(dir)) return;

    const decision = evaluate(input, dir);
    if (!decision.deny) return;

    const id = input?.session_id || 'default';
    const s = readSession(dir, id);
    const denied = s.gateDenied ?? [];
    // Already refused once: this is the override. Allow, and forget the key so a
    // much later, genuinely fresh instance of the same call is redirected again.
    if (denied.includes(decision.key)) {
      writeSession(dir, id, { ...s, gateDenied: denied.filter((k) => k !== decision.key) });
      return;
    }
    const next = [...denied, decision.key];
    writeSession(dir, id, { ...s, gateDenied: next.slice(-MAX_DENIED) });
    emitDeny(decision.reason);
  } catch {
    // Fail open, always.
  }
}
