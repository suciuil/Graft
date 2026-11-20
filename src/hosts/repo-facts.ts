/**
 * What `init` needs to know about a repository's map to write instructions that
 * fit it: for now, whether `graft build` built it in parts (one map per folder,
 * `graph/parts-build.ts`). The agent instructions, the skill and the MCP
 * instructions then carry a short section on working in such a repository, and
 * leave it out everywhere else.
 *
 * Read off the map on disk, never guessed: a parts index (`workspace.json` with
 * `kind: "parts"`) says yes, a map of its own (`wiring.json`) or a folder of
 * separate repos says no. With neither (no build here yet, or a clone that
 * keeps its map out of git), nothing is known, and {@link settledFacts} keeps
 * what the installed text already says, so a teammate's committed instructions
 * are not rewritten back and forth by clones that have not built yet.
 *
 * Kept light on purpose (no query stack): drift checks call it on every query.
 */
import { existsSync } from 'node:fs';
import { isPartsWorkspace, readWorkspace } from '../graph/workspace-index.js';
import { wiringPath } from '../graph/write.js';
import { resolveContextDir } from '../util/state.js';
import { PARTS_HEADING } from '../claude/skill-template.js';

export interface RepoFacts {
  /** True: built in parts. False: one map, or a folder of repos. Absent: not known. */
  parts?: boolean;
}

/** The facts the map of `repo` gives (see the module comment). `override`: an
 * explicit `--dir` for the map; otherwise `GRAFT_DIR` or the usual place, as
 * the hooks and upkeep resolve it. Never throws. */
export function repoFacts(repo: string, override?: string): RepoFacts {
  try {
    const dir = override || resolveContextDir(repo);
    const ws = readWorkspace(repo, dir);
    if (ws) return { parts: isPartsWorkspace(ws) };
    if (existsSync(wiringPath(dir))) return { parts: false };
  } catch {
    /* unreadable: not known */
  }
  return {};
}

/** Whether `text` (instructions graft wrote) carries the parts section. */
export function hasPartsGuidance(text: string): boolean {
  return new RegExp(`^#{2,4}\\s+${PARTS_HEADING}\\s*$`, 'm').test(text.replace(/\r/g, ''));
}

/**
 * `facts` with what is not known taken from `installed`, the text graft wrote
 * there before (null when there is none): an unknown answer keeps the section
 * the file already has, and adds none to a file without it.
 */
export function settledFacts(facts: RepoFacts, installed: string | null): RepoFacts {
  if (facts.parts !== undefined) return facts;
  return { parts: installed !== null && hasPartsGuidance(installed) };
}

/** A short key of `facts`, for caches whose answer depends on them. */
export function factsKey(facts: RepoFacts): string {
  return `parts=${facts.parts === undefined ? '?' : facts.parts ? 1 : 0}`;
}
