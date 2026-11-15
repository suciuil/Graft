/**
 * Bringing a repo's agent instructions up to date by itself, instead of asking
 * the user to run `init`.
 *
 * After graft is upgraded (or its instruction text changes), the files `init`
 * wrote into each repo still hold the old text, and every tally used to carry a
 * "⚠️ Run the 'graft init' command — recommended (…)" line until someone ran
 * it. Re-running init's writes is exactly what that line asks for, and it is
 * safe to do unasked whenever it does only what `init` would do here:
 *
 *   - only in a clone where `init` ran (it left a wiring stamp), for the hosts
 *     it wired, with the flags it was given (replayed from the stamp, never
 *     from defaults), and only graft's own files and fenced blocks: the user's
 *     text around a block is never touched;
 *   - only files that still hold the text a graft wrote here: text something
 *     else put there since (a teammate's commit, another install, an edit) is
 *     left for the person to decide on, and a graft whose text was replaced
 *     here never writes it back by itself (see `AutoInitState`);
 *   - never on a `--no-refresh` query, which answers from what is on disk;
 *   - only with the graft code on disk, the one `graft init` would run: a
 *     long-lived MCP server holding older code does it in a child process that
 *     loads the code afresh, so it never writes older text over newer;
 *   - never when the instructions were written by a newer graft than this one
 *     (that would downgrade them, so the line is not shown either: running
 *     `init` with this graft is not the fix, upgrading it is);
 *   - never while git is in the middle of a merge, rebase, cherry-pick, revert
 *     or bisect, where new changes in the working tree get in the way;
 *   - once per state: when the rewrite did not clear the difference (a file
 *     only `init` with other choices would write), it is not retried until the
 *     code or the files change, and the line is shown as before;
 *   - never with GRAFT_NO_AUTO_INIT=1 (`graft agents auto-init off`), which
 *     brings the line back instead.
 *
 * When it ran, the caller shows one short line saying what was refreshed, once.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  DISK_WAIT_MS,
  diskChildArgs,
  initDueReason,
  initDueReasonAsync,
  initDueReasonFor,
  initDueStateKey,
  installedInstructionHashes,
  instructionTemplatesHash,
  lastJsonLine,
  loadedCodeIsCurrent,
  outdatedInstructionDetails,
  runDiskChild,
  settledWithin,
  type InitDueOptions,
  type OutdatedInstruction,
} from './drift.js';
import { hostWiringName } from './registry.js';
import { compareVersions, readStamp, runningVersion, stampPath, wiringContentHash } from '../upkeep.js';
import { refreshOutdatedWiring } from '../upkeep-run.js';
import { readJson, writeJsonAtomic } from '../util/state.js';

/** The variable that turns the automatic refresh off (`graft agents auto-init off`). */
export const AUTO_INIT_ENV = 'GRAFT_NO_AUTO_INIT';

/** What the tally should carry: the reason `init` is still due (null when it is
 * not), and the line saying what was refreshed by itself (null when nothing was). */
export interface InitDue {
  reason: string | null;
  note: string | null;
  /** Set when a refresh was put off for a passing reason (git was busy), so a
   * cached copy of this answer must not outlive it. */
  retry?: boolean;
}

const NONE: InitDue = { reason: null, note: null };

export function autoInitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AUTO_INIT_ENV] !== '1';
}

/** The git dir of the checkout holding `dir`, following a linked worktree's or a
 * submodule's `.git` file; null outside git. */
function gitDirOf(dir: string): string | null {
  let at = resolve(dir);
  for (;;) {
    const dot = join(at, '.git');
    try {
      if (statSync(dot).isDirectory()) return dot;
      const line = readFileSync(dot, 'utf8').split('\n').find((l) => l.startsWith('gitdir:'));
      const target = line?.slice('gitdir:'.length).trim();
      if (target) return isAbsolute(target) ? target : resolve(at, target);
    } catch {
      /* no .git here: look further up */
    }
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** The files git keeps while an operation that rewrites the working tree is unfinished. */
const GIT_BUSY = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'];

/** Whether git is in the middle of a merge, rebase, cherry-pick, revert or bisect in `repo`. */
export function gitBusy(repo: string): boolean {
  const git = gitDirOf(repo);
  return !!git && GIT_BUSY.some((f) => existsSync(join(git, f)));
}

/**
 * What this clone remembers about its instruction files, beside the wiring
 * stamp (git-ignored, per clone):
 *
 *   - `failed`: the state key of a refresh that did not clear the difference,
 *     so it is not retried until the code or the files change;
 *   - `version`, `templates`, `files`: the last time the files held exactly
 *     what a graft writes, which graft that was (its version and a fingerprint
 *     of its templates) and a fingerprint of each file then. A file that still
 *     holds that text was written by that graft; one that does not was written
 *     by something else since (a teammate's commit, another install, an edit);
 *   - `superseded`: template fingerprints a refresh here replaced. A graft
 *     whose text was replaced never writes it back by itself, so two installs
 *     of one version with different text (a global install and a development
 *     checkout) do not rewrite each other's files on every call.
 */
interface AutoInitState {
  failed?: string;
  version?: string;
  templates?: string;
  files?: Record<string, string>;
  /** The state key the record was taken at, so it is retaken only when something changed. */
  seen?: string;
  superseded?: string[];
}

const MAX_SUPERSEDED = 20;

/** Where {@link AutoInitState} is kept, beside the stamp. */
function statePath(repo: string): string {
  return join(dirname(stampPath(repo)), 'auto-init.json');
}

function readState(repo: string): AutoInitState {
  return readJson<AutoInitState>(statePath(repo)) ?? {};
}

function writeState(repo: string, state: AutoInitState): void {
  try {
    writeJsonAtomic(statePath(repo), state);
  } catch {
    /* unwritable: it is retaken next time, which is harmless */
  }
}

let mineCache: string[] | null = null;

/** This graft's fingerprints: its templates, and the stamp's kind of hash of
 * them. Fixed for the life of the process: it is the code it loaded. */
function mine(): string[] {
  return (mineCache ??= [instructionTemplatesHash(), wiringContentHash()]);
}

/**
 * Records that the files under `repo` now hold exactly this graft's text: the
 * record later refreshes are measured against. `replaced` is the fingerprint
 * of the text a refresh here has just replaced, if any. Only in a repo `init`
 * wired (a stamp is there), and only when something changed since the last
 * record, so an ordinary query writes nothing.
 */
function recordCurrent(repo: string, opts: InitDueOptions, state: AutoInitState, replaced: string | null = null): void {
  if (!readStamp(repo)) return;
  const seen = initDueStateKey(repo, { home: opts.home });
  const [templates] = mine();
  if (!replaced && state.seen === seen && state.templates === templates && state.version === runningVersion()) return;
  // The person chose this graft's text (a refresh, or `init` run by hand): the
  // text recorded before is the one replaced, and this graft's is not.
  const old = replaced ?? (state.templates && state.templates !== templates ? state.templates : null);
  const superseded = [...new Set([...(state.superseded ?? []), ...(old ? [old] : [])])]
    .filter((h) => !mine().includes(h))
    .slice(-MAX_SUPERSEDED);
  writeState(repo, {
    ...(state.failed ? { failed: state.failed } : {}),
    version: runningVersion(),
    templates,
    files: installedInstructionHashes(repo, { home: opts.home }),
    seen,
    ...(superseded.length ? { superseded } : {}),
  });
}

/**
 * Whether this graft may rewrite `repo`'s outdated instruction files by itself:
 *
 *   - `refresh` when they are text a previous `init` or refresh here wrote with
 *     an older (or, within one version, a not-yet-replaced) graft;
 *   - `newer` when a newer graft wrote them: rewriting would downgrade them, and
 *     running `init` with this one is no fix either, so nothing is recommended;
 *   - `skip` otherwise: `init` was never run in this clone (nothing says which
 *     agents or which writes outside the repo were chosen), something else
 *     wrote the files since (a teammate's commit, another install, an edit), or
 *     this graft's text was replaced here before. `init` is recommended as
 *     before, and the person decides.
 */
function verdict(repo: string, opts: InitDueOptions, outdated: OutdatedInstruction[], state: AutoInitState): 'refresh' | 'newer' | 'skip' {
  const stamp = readStamp(repo);
  if (!stamp) return 'skip';
  const running = runningVersion();
  // (A stamp newer than this graft never gets here: settleInitDue skips that repo first.)
  // Replayed as recorded, never from defaults: a stamp without the choices
  // (written before they were) could mean writes outside the repo nobody chose.
  if (typeof stamp.opts?.global !== 'boolean' || typeof stamp.opts?.hooks !== 'boolean') return 'skip';
  if (state.files && state.version && state.templates) {
    const now = installedInstructionHashes(repo, { home: opts.home });
    const unchanged = outdated.every((o) => state.files![o.file] !== undefined && state.files![o.file] === now[o.file]);
    if (!unchanged) return 'skip';
    const cmp = compareVersions(state.version, running);
    if (cmp > 0) return 'newer';
    if (mine().some((h) => state.superseded?.includes(h))) return 'skip';
    return 'refresh';
  }
  // No record yet (files written before this check existed): only text the
  // stamp says another graft wrote here, and never text this graft replaced.
  if (mine().some((h) => state.superseded?.includes(h))) return 'skip';
  return compareVersions(stamp.version, running) < 0 || (!!stamp.content && stamp.content !== wiringContentHash()) ? 'refresh' : 'skip';
}

/**
 * The reason `init` is due for `root` (and its workspace `children`), after
 * refreshing what can be refreshed safely, with the code this process loaded.
 * A process whose loaded code is out of date refreshes nothing here (it would
 * write older text) and answers as {@link initDueReason} does: use
 * {@link settleInitDueAsync}, which asks the code on disk. With `write` false
 * (`--no-refresh`) nothing is written at all. Never throws.
 */
export function settleInitDue(root: string, opts: InitDueOptions = {}, env: NodeJS.ProcessEnv = process.env, write = true): InitDue {
  try {
    if (!loadedCodeIsCurrent()) {
      const reason = initDueReason(root, opts);
      return reason ? { reason, note: null } : NONE;
    }
    const base = resolve(root);
    const repos = [base, ...(opts.children ?? []).map((c) => resolve(base, c))];
    const enabled = write && autoInitEnabled(env);
    const notes: string[] = [];
    const left: { repo: string; outdated: OutdatedInstruction[] }[] = [];
    let retry = false;
    for (const repo of repos) {
      const outdated = outdatedInstructionDetails(repo, opts);
      if (outdated.length === 0) {
        if (write) recordCurrent(repo, opts, readState(repo));
        continue;
      }
      // Written by a newer graft: not rewritten, and not reported either (see verdict).
      const stampVersion = readStamp(repo)?.version;
      if (stampVersion && compareVersions(stampVersion, runningVersion()) > 0) continue;
      if (!enabled) {
        left.push({ repo, outdated });
        continue;
      }
      if (gitBusy(repo)) {
        // Tried again once git is done: this answer is not one to keep.
        retry = true;
        left.push({ repo, outdated });
        continue;
      }
      const state = readState(repo);
      if (state.failed && state.failed === initDueStateKey(repo, { home: opts.home })) {
        left.push({ repo, outdated });
        continue;
      }
      const v = verdict(repo, opts, outdated, state);
      if (v === 'newer') continue;
      if (v === 'skip') {
        left.push({ repo, outdated });
        continue;
      }
      const replaced = state.templates ?? readStamp(repo)?.content ?? null;
      refreshOutdatedWiring(repo, runningVersion());
      const after = outdatedInstructionDetails(repo, opts);
      const fixed = outdated.filter((o) => !after.some((a) => a.file === o.file));
      recordCurrent(repo, opts, { ...state, failed: undefined }, replaced && !mine().includes(replaced) ? replaced : null);
      if (after.length) {
        left.push({ repo, outdated: after });
        writeState(repo, { ...readState(repo), failed: initDueStateKey(repo, { home: opts.home }) });
      }
      if (fixed.length) {
        const where = repo === base ? "this repo's" : `${relative(base, repo).replace(/\\/g, '/')}'s`;
        const hosts = [...new Set(fixed.flatMap((o) => o.hosts))];
        notes.push(`· ${hostWiringName(repo)} ${runningVersion()} updated ${where} agent instructions by itself (for ${hosts.join(', ')}).`);
      }
    }
    return { reason: initDueReasonFor(base, left), note: notes.length ? notes.join('\n') : null, ...(retry ? { retry } : {}) };
  } catch {
    return NONE;
  }
}

/* -------------------------------------------------------------------------- */
/* a long-lived process holding older code: the code on disk does it          */
/* -------------------------------------------------------------------------- */

/** How long a child doing the refresh with the code on disk may run. */
const CHILD_TIMEOUT_MS = 30_000;
const MAX_CACHED = 16;
/** Answers per state key: the child runs once per change, not once per call. */
const reasons = new Map<string, string | null>();
/** The child running per state key, shared by overlapping calls. */
const children = new Map<string, Promise<InitDue>>();
/** The last answer per repo and options, whatever changed since. */
const lastReason = new Map<string, string | null>();
/** A refresh line a call that stopped waiting did not show yet, per repo and options. */
const pendingNotes = new Map<string, string>();

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  if (map.size >= MAX_CACHED) map.clear();
  map.set(key, value);
}

/** The child's answer (init's writes print nothing, but see {@link lastJsonLine}). */
function parseChild(out: string | null): InitDue | null {
  const parsed = out === null ? undefined : lastJsonLine(out);
  if (!parsed || typeof parsed !== 'object') return null;
  const answer = parsed as Partial<InitDue>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  return { reason: str(answer.reason), note: str(answer.note), ...(answer.retry === true ? { retry: true } : {}) };
}

async function runChild(root: string, opts: InitDueOptions): Promise<InitDue | null> {
  const args = diskChildArgs(import.meta.url, `m.settleInitDue(${JSON.stringify(root)}, ${JSON.stringify(opts)})`);
  return parseChild(await runDiskChild(args, CHILD_TIMEOUT_MS));
}

/**
 * {@link settleInitDue} for a long-lived process that must not stall (the MCP
 * server answers every agent's calls on one thread). With current code it runs
 * in-process. With older code, a child process loads the code on disk and does
 * it there; a call it has not answered within `waitMs` goes on with the last
 * reason known for that repo, and the refresh line is shown by the next call.
 * When the code on disk cannot answer (an older graft without this module), it
 * falls back to {@link initDueReasonAsync}, which refreshes nothing. Never throws.
 */
export async function settleInitDueAsync(root: string, opts: InitDueOptions = {}, waitMs: number = DISK_WAIT_MS): Promise<InitDue> {
  if (loadedCodeIsCurrent()) return settleInitDue(root, opts);
  const id = `${resolve(root)}\n${JSON.stringify(opts)}`;
  const takeNote = (): string | null => {
    const note = pendingNotes.get(id) ?? null;
    pendingNotes.delete(id);
    return note;
  };
  try {
    const key = initDueStateKey(root, opts);
    if (reasons.has(key)) return { reason: reasons.get(key) ?? null, note: takeNote() };
    let child = children.get(key);
    if (!child) {
      child = runChild(root, opts)
        .then(async (answer) => answer ?? { reason: await initDueReasonAsync(root, opts, CHILD_TIMEOUT_MS), note: null })
        .then((answer) => {
          // Put off for a passing reason (git busy): asked again on the next call.
          if (!answer.retry) {
            remember(reasons, key, answer.reason);
            // A refresh moved the files: the state after it has the same answer,
            // so the next call does not start a second child for it.
            try {
              const after = initDueStateKey(root, opts);
              if (after !== key) remember(reasons, after, answer.reason);
            } catch {
              /* the next call asks again, which is harmless */
            }
          }
          remember(lastReason, id, answer.reason);
          if (answer.note) remember(pendingNotes, id, answer.note);
          return answer;
        });
      void child.finally(() => children.delete(key));
      children.set(key, child);
    }
    const answer = await settledWithin(child, waitMs);
    return { reason: answer !== undefined ? answer.reason : (lastReason.get(id) ?? null), note: takeNote() };
  } catch {
    return NONE;
  }
}
