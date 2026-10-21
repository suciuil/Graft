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
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { HOSTS, hostRelPath, hostWiringName } from './registry.js';
import { fencedBlock, markersFor, type Markers } from './sections.js';
import { skillTemplate } from '../claude/skill-template.js';
import { trailSkillPath } from '../claude/init.js';
import { readStamp, runningVersion, wiredHostIds } from '../upkeep.js';

/** Line endings and trailing whitespace are not content: git's autocrlf and
 * editors change them without changing what the agent reads. */
function normalize(text: string): string {
  return text.replace(/\r/g, '').replace(/[ \t]+$/gm, '').trimEnd();
}

/** The fenced block in `text`, or null when the file holds none (it was not
 * installed for this host, so there is nothing to be out of date). */
function blockIn(text: string, markers: Markers): string | null {
  const lines = text.replace(/\r/g, '').split('\n');
  const s = lines.findIndex((l) => l.trim() === markers.start);
  if (s === -1) return null;
  const e = lines.findIndex((l, i) => i > s && l.trim() === markers.end);
  return e === -1 ? null : lines.slice(s, e + 1).join('\n');
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

/**
 * The instruction files under `repo` that `init` wrote and that differ from what
 * this graft would write now, with the agents that read each one and the
 * sections that changed. Files that are absent, or shared files without graft's
 * block, are not counted: `init` was not run for that host. Never throws.
 */
export function outdatedInstructionDetails(repo: string, opts: { home?: string } = {}): OutdatedInstruction[] {
  const out: OutdatedInstruction[] = [];
  try {
    const root = resolve(repo);
    const name = hostWiringName(root);
    const markers = markersFor(name);
    // The agents a previous init chose here: a shared file such as AGENTS.md is
    // read by several hosts, and naming only the wired ones is the real scope.
    const wired = new Set([...wiredHostIds(root), ...(readStamp(root)?.hosts ?? [])]);
    const seen = new Set<string>();
    for (const host of HOSTS) {
      const path = join(root, hostRelPath(host, name));
      if (seen.has(path)) continue;
      seen.add(path);
      const text = read(path);
      if (text === null) continue;
      const current = host.kind === 'owned' ? text : blockIn(text, markers);
      if (current === null) continue;
      const wanted = host.kind === 'owned' ? host.content(name) : fencedBlock(host.content(name), '\n', markers);
      if (normalize(current) === normalize(wanted)) continue;
      const readers = HOSTS.filter((h) => join(root, hostRelPath(h, name)) === path).map((h) => h.id);
      const hosts = readers.filter((id) => wired.has(id));
      out.push({ file: relative(root, path), hosts: hosts.length ? hosts : readers.slice(0, 1), changes: changedSections(current, wanted) });
    }
    // Claude Code's skill: in the repo under graft's names, user-level under trail's.
    const skill = name === 'trail' ? trailSkillPath(opts.home ?? homedir()) : join(root, '.claude', 'skills', 'graft', 'SKILL.md');
    const text = read(skill);
    const wanted = skillTemplate(name);
    if (text !== null && normalize(text) !== normalize(wanted)) {
      out.push({ file: name === 'trail' ? skill : relative(root, skill), hosts: ['claude'], changes: changedSections(text, wanted) });
    }
  } catch {
    /* a nudge is never worth failing a query over */
  }
  return out.map((o) => ({ ...o, file: o.file.replace(/\\/g, '/') }));
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
 * The reason a re-run of `init` is due, for the savings tally to carry, or null
 * when every installed instruction file is current. It states the scope: every
 * file that differs, the version whose text differs, which sections changed,
 * and which agents re-running `init` refreshes. Given `children` (a workspace),
 * each child repo is checked as well as `root`.
 */
export function initDueReason(root: string, opts: { children?: string[]; home?: string } = {}): string | null {
  const repos = [resolve(root), ...(opts.children ?? []).map((c) => resolve(root, c))];
  const files: string[] = [];
  const hosts = new Set<string>();
  const changes = new Set<string>();
  for (const r of repos) {
    for (const o of outdatedInstructionDetails(r, opts)) {
      files.push(r === repos[0] ? o.file : `${relative(repos[0], r).replace(/\\/g, '/')}/${o.file}`);
      for (const h of o.hosts) hosts.add(h);
      for (const c of o.changes) changes.add(c);
    }
  }
  if (files.length === 0) return null;
  const name = hostWiringName(repos[0]);
  const changed = changes.size ? ` — changed: ${capped([...changes], 4, 'sections')}` : '';
  return (
    `the agent instructions in ${files.join(', ')} differ from what ${name} ${runningVersion()} installs${changed}; ` +
    `re-running it here rewrites only ${name}'s part of those files, for ${[...hosts].join(', ')}`
  );
}
