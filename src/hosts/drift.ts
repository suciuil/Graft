/**
 * Whether the agent instructions `init` installed in a repo are the ones this
 * version of graft would install.
 *
 * Upgrading graft changes the CLI at once, but the instruction files only change
 * when someone re-runs `init` in each repo. Until then the agent keeps following
 * the old text — and so misses whatever the update taught it (a new command, a
 * new line to relay). Comparing content rather than stamping a version means the
 * nudge fires only when the instructions actually changed, and also covers repos
 * set up before this check existed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { extname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { HOSTS, hostRelPath, hostWiringName } from './registry.js';
import { blockIn, fencedBlock, markersFor } from './sections.js';
import { factsKey, repoFacts, settledFacts } from './repo-facts.js';
import { skillTemplate } from '../claude/skill-template.js';
import { trailSkillPath } from '../claude/init.js';
import { readStamp, runningVersion, wiredHostIds } from '../upkeep.js';

/** Line endings and trailing whitespace are not content: git's autocrlf and
 * editors change them without changing what the agent reads. */
function normalize(text: string): string {
  return text.replace(/\r/g, '').replace(/[ \t]+$/gm, '').trimEnd();
}

function read(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/** One out-of-date instruction file: where it is, which agents read it, and
 * which of its sections differ from what this graft would write. */
export interface OutdatedInstruction {
  /** Relative to the repo, `/`-separated (absolute for trail's user-level skill). */
  file: string;
  /** The host ids that read this file, narrowed to the ones wired here. */
  hosts: string[];
  /** Section labels, e.g. `“The tools”`, `new “Report what graft saved”`. */
  changes: string[];
}

const MAX_TITLE = 48;

/** A heading as the user will read it: no trailing parenthetical (the tally line
 * wraps the reason in parentheses already), and short. */
function sectionTitle(heading: string): string {
  const t = heading.replace(/\s*\([^)]*\)\s*$/, '').replace(/[()]/g, '').trim();
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1).trimEnd()}…` : t;
}

/** `text` split at its markdown headings (ignoring `#` lines inside code fences),
 * keyed by heading in order. Text above the first heading is keyed `''`, and the
 * text under a document title (`# …`) is keyed `'\0intro'`. A repeated heading
 * gets a `\0n` suffix so both copies are compared. */
function sectionsOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  let key = '';
  let body: string[] = [];
  let fenced = false;
  const flush = () => out.set(key, normalize(body.join('\n')));
  for (const line of normalize(text).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      flush();
      const title = heading[1].length === 1 ? '\0intro' : heading[2];
      const n = (seen.get(title) ?? 0) + 1;
      seen.set(title, n);
      key = n > 1 ? `${title}\0${n}` : title;
      body = [];
      continue;
    }
    body.push(line);
  }
  flush();
  return out;
}

/** Which sections differ between the installed text and the wanted text, as
 * labels for the user: changed, new in this version, or removed from it. */
export function changedSections(have: string, want: string): string[] {
  const a = sectionsOf(have);
  const b = sectionsOf(want);
  const label = (key: string, body: string) => {
    if (key === '') return body.startsWith('---') ? 'the front matter' : 'the opening lines';
    if (key.startsWith('\0intro')) return 'the introduction';
    return `“${sectionTitle(key.split('\0')[0])}”`;
  };
  const out: string[] = [];
  for (const [key, body] of b) {
    if (!a.has(key)) out.push(`new ${label(key, body)}`);
    else if (a.get(key) !== body) out.push(label(key, body));
  }
  for (const [key, body] of a) if (!b.has(key)) out.push(`removed ${label(key, body)}`);
  return out;
}

/** Graft's part of one instruction file `init` wrote: the file, the agents that
 * read it, the text graft owns in it now, and the text this graft would write. */
interface InstalledPart {
  file: string;
  hosts: string[];
  current: string;
  wanted: string;
}

/** Graft's part of every instruction file `init` wrote under `repo` (absent
 * files, and shared files without graft's block, are left out). */
function installedParts(repo: string, opts: { home?: string }): InstalledPart[] {
  const out: InstalledPart[] = [];
  const root = resolve(repo);
  const name = hostWiringName(root);
  const markers = markersFor(name);
  // The agents a previous init chose here: a shared file such as AGENTS.md is
  // read by several hosts, and naming only the wired ones is the real scope.
  const wired = new Set([...wiredHostIds(root), ...(readStamp(root)?.hosts ?? [])]);
  // The text init writes fits the repo's map (built in parts or not), and keeps
  // what a file already says where the map tells nothing (see repo-facts.ts).
  const facts = repoFacts(root);
  const seen = new Set<string>();
  for (const host of HOSTS) {
    const path = join(root, hostRelPath(host, name));
    if (seen.has(path)) continue;
    seen.add(path);
    const text = read(path);
    if (text === null) continue;
    const current = host.kind === 'owned' ? text : blockIn(text, markers);
    if (current === null) continue;
    const content = host.content(name, settledFacts(facts, current));
    const wanted = host.kind === 'owned' ? content : fencedBlock(content, '\n', markers);
    const readers = HOSTS.filter((h) => join(root, hostRelPath(h, name)) === path).map((h) => h.id);
    const hosts = readers.filter((id) => wired.has(id));
    out.push({ file: relative(root, path), hosts: hosts.length ? hosts : readers.slice(0, 1), current, wanted });
  }
  // Claude Code's skill: in the repo under graft's names, user-level under trail's.
  const skill = name === 'trail' ? trailSkillPath(opts.home ?? homedir()) : join(root, '.claude', 'skills', 'graft', 'SKILL.md');
  const text = read(skill);
  // Trail's skill is the user's, shared by every repo, so it says nothing of this one's map.
  if (text !== null) out.push({ file: name === 'trail' ? skill : relative(root, skill), hosts: ['claude'], current: text, wanted: name === 'trail' ? skillTemplate(name) : skillTemplate(name, settledFacts(facts, text)) });
  return out.map((p) => ({ ...p, file: p.file.replace(/\\/g, '/') }));
}

/** A short fingerprint of an instruction text, blind to line endings and trailing blanks. */
function textHash(text: string): string {
  return createHash('sha256').update(normalize(text)).digest('hex').slice(0, 16);
}

/**
 * A fingerprint of graft's part of each instruction file `init` wrote under
 * `repo`, by file. Comparing it with one taken earlier tells whether the files
 * still hold the text seen then, or something else wrote them since (a
 * teammate's commit, another graft install, an edit). Empty on any failure.
 */
export function installedInstructionHashes(repo: string, opts: { home?: string } = {}): Record<string, string> {
  try {
    return Object.fromEntries(installedParts(repo, opts).map((p) => [p.file, textHash(p.current)]));
  } catch {
    return {};
  }
}

/** A fingerprint of every text `init` would write with this graft, skill included. */
export function instructionTemplatesHash(): string {
  const h = createHash('sha256');
  for (const host of [...HOSTS].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const n of ['graft', 'trail'] as const) h.update(`${host.id}\0${n}\0${host.content(n)}\n`);
  }
  for (const n of ['graft', 'trail'] as const) h.update(`skill\0${n}\0${skillTemplate(n)}\n`);
  return h.digest('hex').slice(0, 16);
}

/**
 * The instruction files under `repo` that `init` wrote and that differ from what
 * this graft would write now, with the agents that read each one and the
 * sections that changed. Files that are absent, or shared files without graft's
 * block, are not counted: `init` was not run for that host. Never throws.
 */
export function outdatedInstructionDetails(repo: string, opts: { home?: string } = {}): OutdatedInstruction[] {
  try {
    return installedParts(repo, opts)
      .filter((p) => normalize(p.current) !== normalize(p.wanted))
      .map((p) => ({ file: p.file, hosts: p.hosts, changes: changedSections(p.current, p.wanted) }));
  } catch {
    /* a nudge is never worth failing a query over */
    return [];
  }
}

/** {@link outdatedInstructionDetails}, as file paths only. */
export function outdatedInstructions(repo: string, opts: { home?: string } = {}): string[] {
  return outdatedInstructionDetails(repo, opts).map((o) => o.file);
}

/** At most `max` items joined with commas, then "and N more <noun>". */
function capped(items: string[], max: number, noun: string): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more ${noun}`;
}

/**
 * The modules whose text makes up what `init` writes, relative to this one and
 * without their extension (`.js` in `dist/`, `.ts` under tsx).
 */
const TEMPLATE_MODULES = ['./instructions', './registry', './sections', './repo-facts', '../claude/skill-template', '../brand', '../about'];

function statPart(path: string): string {
  try {
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return '-';
  }
}

/**
 * A fingerprint of the graft code on disk that decides what `init` writes: the
 * size and modification time of each template module, and the package version
 * (npm stores every file of a package with one fixed date, so an upgrade
 * changes the version and the sizes, not the times).
 */
function codeStamp(): string {
  const here = import.meta.url;
  const ext = extname(fileURLToPath(here));
  const parts = TEMPLATE_MODULES.map((m) => statPart(fileURLToPath(new URL(`${m}${ext}`, here))));
  let version = '-';
  try {
    version = String((JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', here)), 'utf8')) as { version?: unknown }).version ?? '-');
  } catch {
    /* no package.json next to the code: the module stats still tell */
  }
  return [version, ...parts].join('|');
}

/** The fingerprint of the code this process loaded, taken when it loaded it. */
let loadedStamp: string = codeStamp();

/** Pretend this process loaded other code (or, with null, the code on disk now). */
export function setLoadedCodeStampForTest(stamp: string | null): void {
  loadedStamp = stamp ?? codeStamp();
}

/**
 * Whether the templates this process holds in memory are still the ones on disk.
 *
 * Not so in a long-lived process — the MCP server an editor starts once and
 * keeps for days — after graft was upgraded or rebuilt under it. That process
 * compares the instruction files with its own, older text: once `graft init`
 * (a fresh process, the new code) has rewritten them, they differ from the old
 * text, and the server kept recommending a `graft init` that could never clear
 * the warning, until the editor restarted it.
 */
export function loadedCodeIsCurrent(): boolean {
  return codeStamp() === loadedStamp;
}

/** Every file {@link outdatedInstructionDetails} reads for `repo`, size and time,
 * so a cached answer is dropped as soon as one of them changes. */
function instructionFilesStamp(repo: string, home?: string): string {
  try {
    const root = resolve(repo);
    const name = hostWiringName(root);
    const paths = new Set(HOSTS.map((h) => join(root, hostRelPath(h, name))));
    paths.add(name === 'trail' ? trailSkillPath(home ?? homedir()) : join(root, '.claude', 'skills', 'graft', 'SKILL.md'));
    // What the map says of the repo too: a build that splits it in parts changes the wanted text.
    return [factsKey(repoFacts(root)), ...[...paths].map((p) => `${p}=${statPart(p)}`)].join('|');
  } catch {
    return '-';
  }
}

export type InitDueOptions = { children?: string[]; home?: string };

const diskReasons = new Map<string, string | null>();
const MAX_DISK_REASONS = 16;
/** The child asking the code on disk, per cache key, while it runs. */
const diskChildren = new Map<string, Promise<string | null>>();
/** The last answer the code on disk gave per repo and options, whatever changed since. */
const lastDiskReason = new Map<string, string | null>();
/** How long an MCP call waits for a child asking the code on disk (here, and in
 * auto-init.ts) before answering with the last known answer. */
export const DISK_WAIT_MS = 1_000;
const DISK_TIMEOUT_MS = 15_000;

/** The cache key of a from-disk answer: the code, the options, and every file it reads. */
function diskKey(root: string, opts: InitDueOptions): string {
  const repos = [resolve(root), ...(opts.children ?? []).map((c) => resolve(root, c))];
  return [codeStamp(), JSON.stringify(opts), ...repos.map((r) => instructionFilesStamp(r, opts.home))].join('\n');
}

/** What an answer of {@link initDueReason} depends on: the graft code on disk and
 * every instruction file it reads. Equal keys, equal answers. */
export function initDueStateKey(root: string, opts: InitDueOptions = {}): string {
  return diskKey(root, opts);
}

/**
 * The node arguments of a child that loads the graft code on disk afresh: it
 * imports the module at `moduleUrl` as `m` and writes `JSON.stringify(<call>)` on
 * its last line (read it with {@link lastJsonLine}). For a process whose loaded
 * code is out of date; drift.ts and auto-init.ts both start theirs here.
 */
export function diskChildArgs(moduleUrl: string, call: string): string[] {
  const script = `const m = await import(${JSON.stringify(moduleUrl)});` + `process.stdout.write('\\n' + JSON.stringify(${call}));`;
  // The loader flags this process runs with (tsx in development) still apply;
  // a debugger port, the test runner and watch mode do not belong to the child.
  const flags = process.execArgv.filter((a) => !/^--(inspect|debug|test|watch|input-type|eval|print)/.test(a));
  return [...flags, '--input-type=module', '-e', script];
}

/** Runs a {@link diskChildArgs} child: its stdout, or null when it failed or timed out. */
export function runDiskChild(args: string[], timeout: number = DISK_TIMEOUT_MS): Promise<string | null> {
  return new Promise((done) => {
    execFile(process.execPath, args, { encoding: 'utf8', timeout, windowsHide: true }, (err, stdout) => done(err ? null : String(stdout)));
  });
}

/** The JSON value on the last line of a child's output (a stray line before it
 * must not cost the answer); undefined when there is none. */
export function lastJsonLine(out: string): unknown {
  try {
    return JSON.parse(out.trim().split('\n').pop() || 'null');
  } catch {
    return undefined;
  }
}

/** `p`, or undefined once `waitMs` has passed first. The wait never keeps the process up. */
export async function settledWithin<T>(p: Promise<T>, waitMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((done) => {
    timer = setTimeout(() => done(undefined), Math.max(0, waitMs));
    timer.unref?.();
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The arguments of the child that answers {@link initDueReason} with the code on disk. */
function diskChild(root: string, opts: InitDueOptions): string[] {
  return diskChildArgs(import.meta.url, `m.initDueReason(${JSON.stringify(root)}, ${JSON.stringify(opts)}) ?? null`);
}

function parseDiskAnswer(out: string | null): string | null {
  const parsed = out === null ? null : lastJsonLine(out);
  return typeof parsed === 'string' && parsed.trim() ? parsed : null;
}

function rememberDiskReason(key: string, root: string, opts: InitDueOptions, reason: string | null): void {
  if (diskReasons.size >= MAX_DISK_REASONS) diskReasons.clear();
  diskReasons.set(key, reason);
  if (lastDiskReason.size >= MAX_DISK_REASONS) lastDiskReason.clear();
  lastDiskReason.set(`${resolve(root)}\n${JSON.stringify(opts)}`, reason);
}

/**
 * {@link initDueReason} as the graft code on disk answers it, for a process
 * whose loaded code is out of date: a short child process imports this module
 * afresh and answers. Cached until the code or one of the instruction files
 * changes, so the child runs once per change, not once per call. Null when the
 * child fails: a nudge this process cannot verify is not worth showing.
 */
function initDueReasonFromDisk(root: string, opts: InitDueOptions): string | null {
  const key = diskKey(root, opts);
  if (diskReasons.has(key)) return diskReasons.get(key) ?? null;
  let reason: string | null = null;
  try {
    reason = parseDiskAnswer(
      execFileSync(process.execPath, diskChild(root, opts), { encoding: 'utf8', timeout: DISK_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }),
    );
  } catch {
    reason = null;
  }
  rememberDiskReason(key, root, opts, reason);
  return reason;
}

/**
 * {@link initDueReason} for a long-lived process that must not stall: the MCP
 * server answers every agent's calls on one thread, so it never waits on a
 * blocking child. When its loaded code is out of date, the child asking the code
 * on disk runs asynchronously (one per change, shared by overlapping calls), and
 * a call that it has not answered within {@link DISK_WAIT_MS} goes on with the
 * last reason the code on disk gave for that repo (null before the first): the
 * warning catches up on the next call.
 */
export async function initDueReasonAsync(root: string, opts: InitDueOptions = {}, waitMs: number = DISK_WAIT_MS): Promise<string | null> {
  if (loadedCodeIsCurrent()) return initDueReason(root, opts);
  try {
    const key = diskKey(root, opts);
    if (diskReasons.has(key)) return diskReasons.get(key) ?? null;
    let child = diskChildren.get(key);
    if (!child) {
      child = runDiskChild(diskChild(root, opts)).then((out) => {
        const reason = parseDiskAnswer(out);
        rememberDiskReason(key, root, opts, reason);
        return reason;
      });
      void child.finally(() => diskChildren.delete(key));
      diskChildren.set(key, child);
    }
    const reason = await settledWithin(child, waitMs);
    return reason !== undefined ? reason : (lastDiskReason.get(`${resolve(root)}\n${JSON.stringify(opts)}`) ?? null);
  } catch {
    return null;
  }
}

/**
 * The reason a re-run of `init` is due, for the savings tally to carry, or null
 * when every installed instruction file is current. It states the scope: every
 * file that differs, the version whose text differs, which sections changed,
 * and which agents re-running `init` refreshes. Given `children` (a workspace),
 * each child repo is checked as well as `root`.
 *
 * Measured against what the graft on disk writes, which is what `init` will
 * write: a process holding older code (see {@link loadedCodeIsCurrent}) asks
 * that code instead of its own (blocking: the CLI; the MCP server uses
 * {@link initDueReasonAsync}).
 */
export function initDueReason(root: string, opts: InitDueOptions = {}): string | null {
  if (!loadedCodeIsCurrent()) return initDueReasonFromDisk(root, opts);
  const repos = [resolve(root), ...(opts.children ?? []).map((c) => resolve(root, c))];
  return initDueReasonFor(repos[0], repos.map((repo) => ({ repo, outdated: outdatedInstructionDetails(repo, opts) })));
}

/**
 * {@link initDueReason}'s wording for outdated files already found: `base` is
 * the root repo, `found` each repo checked (the root or a workspace child) with
 * its outdated files. Null when none is outdated.
 */
export function initDueReasonFor(base: string, found: { repo: string; outdated: OutdatedInstruction[] }[]): string | null {
  const files: string[] = [];
  const hosts = new Set<string>();
  const changes = new Set<string>();
  for (const { repo: r, outdated } of found) {
    for (const o of outdated) {
      files.push(r === base ? o.file : `${relative(base, r).replace(/\\/g, '/')}/${o.file}`);
      for (const h of o.hosts) hosts.add(h);
      for (const c of o.changes) changes.add(c);
    }
  }
  if (files.length === 0) return null;
  const name = hostWiringName(base);
  const changed = changes.size ? ` — changed: ${capped([...changes], 4, 'sections')}` : '';
  return (
    `the agent instructions in ${files.join(', ')} differ from what ${name} ${runningVersion()} installs${changed}; ` +
    `re-running it here rewrites only ${name}'s part of those files, for ${[...hosts].join(', ')}`
  );
}
