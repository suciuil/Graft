/**
 * A repository too big for one map, built as one map per part.
 *
 * `--only-dir` builds one part into the repository's map, replacing the part
 * built before it. "all" (`graft build --all-parts`, or 0 in the list of parts)
 * instead builds every part with its own folder as the root, so each one gets a
 * map of its own (`Src/EBS/ActP` is kept where a build run in that folder keeps
 * it), and writes a `workspace.json` with `kind: "parts"` at the repository's
 * map. Queries run at the repository root then search every part's map, exactly
 * as they do across the repos of a workspace folder (`workspace.ts`).
 *
 * A part that turns out too big for one map itself is split again by the list
 * its own build stops with, and the parts that took its place are listed
 * instead. The index is rewritten after every part built, so a run stopped
 * half-way still leaves the parts built so far searchable.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { contextDirFor, ensureGitignored } from "../context/node-file.js";
import { normalizeExcludeEntry } from "../ingest/fs.js";
import { patchBuildConfig, readBuildConfig, type BuildConfig } from "../util/state.js";
import { allPartsPlan, GraphTooLargeError } from "./size-guard.js";
import { clearParentGraft, isPartsWorkspace, isSafePart, readWorkspace, writeWorkspace } from "./workspace.js";

/** How many times a part is split again before it is given up on. */
export const MAX_SPLIT_LEVELS = 4;

export interface PartsBuildDeps {
  /** Build one part, its folder the root of its own map. A part too big for one
   * map throws {@link GraphTooLargeError}; any other error fails that part alone. */
  buildPart(dir: string, name: string): Promise<void>;
  log?(line: string): void;
}

export interface PartsBuildOptions {
  /** The `--dir` override of the repository's own map, where the index goes. */
  override?: string;
  /** Parts already listed in the index (a rebuild): kept unless rebuilt, split or gone. */
  keep?: readonly string[];
}

export interface PartsBuildResult {
  /** Parts listed in the index once done, sorted (failed ones too, to retry). */
  listed: string[];
  /** Parts built by this run, in build order. */
  built: string[];
  failed: { part: string; error: string }[];
  /** Too big for one map and not split any further. */
  tooBig: string[];
  /** Folders that no longer exist. */
  gone: string[];
  /** Where the index was written; undefined when no part was built. */
  index?: string;
}

/**
 * The repository's own build settings as they apply to one of its parts: the
 * folder names to include, the exclusions (a name or glob anywhere, a path only
 * when it is inside the part, made relative to it), and the submodule and
 * nested-clone choices. Empty when the repository has none of them.
 */
export function partConfig(root: BuildConfig | null, part: string): BuildConfig {
  const out: BuildConfig = {};
  if (!root) return out;
  if (root.includeDirs?.length) out.includeDirs = [...root.includeDirs];
  if (root.excludeDirs?.length) {
    const prefix = `${part}/`;
    const excludes = root.excludeDirs.flatMap((e) => {
      const x = normalizeExcludeEntry(e);
      if (!x.includes("/")) return [x];
      return x.startsWith(prefix) && x.length > prefix.length ? [x.slice(prefix.length)] : [];
    });
    if (excludes.length) out.excludeDirs = excludes;
  }
  if (root.followSubmodules !== undefined) out.followSubmodules = root.followSubmodules;
  if (root.followNestedRepos !== undefined) out.followNestedRepos = root.followNestedRepos;
  return out;
}

/**
 * Build each of `parts` (root-relative folders) into its own map, one after
 * another, and list the ones built in the repository's `workspace.json`. The
 * repository's previous map is removed once the first part is built, since the
 * index replaces it.
 */
export async function buildAllParts(
  root: string,
  parts: readonly string[],
  deps: PartsBuildDeps,
  opts: PartsBuildOptions = {},
): Promise<PartsBuildResult> {
  const log = deps.log ?? (() => {});
  const rootConfig = readBuildConfig(root);
  const listed = new Set((opts.keep ?? []).filter(isSafePart));
  const res: PartsBuildResult = { listed: [], built: [], failed: [], tooBig: [], gone: [] };
  let cleared = isPartsWorkspace(readWorkspace(root, opts.override));
  const record = (): void => {
    if (!cleared) {
      clearParentGraft(root, opts.override);
      cleared = true;
    }
    res.index = writeWorkspace(root, { version: 1, kind: "parts", children: [...listed] }, opts.override);
  };

  const one = async (part: string, level: number): Promise<void> => {
    if (!isSafePart(part)) {
      // The list can come from a committed index: never build outside the repository.
      res.failed.push({ part, error: "not a folder inside the repository" });
      if (listed.delete(part) && cleared) record();
      log(`✗ ${part}: not a folder inside the repository, left out`);
      return;
    }
    const dir = join(root, part);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      res.gone.push(part);
      if (listed.delete(part) && cleared) record();
      log(`⚠ ${part}/: no such folder any more, left out`);
      return;
    }
    const config = partConfig(rootConfig, part);
    if (Object.keys(config).length > 0) patchBuildConfig(dir, config);
    try {
      await deps.buildPart(dir, part);
    } catch (err) {
      if (!(err instanceof GraphTooLargeError)) {
        const error = err instanceof Error ? err.message : String(err);
        res.failed.push({ part, error });
        log(`✗ ${part}/: ${error}`);
        // Listed all the same: queries name it as not built, and the next build here retries it.
        listed.add(part);
        if (cleared) record();
        return;
      }
      const sub = allPartsPlan(err.report).parts;
      if (sub.length === 0 || level >= MAX_SPLIT_LEVELS) {
        res.tooBig.push(part);
        log(`✗ ${part}/: too big for one map, and it has no folders to split it into: left out`);
        return;
      }
      log(`· ${part}/ is too big for one map too: building its ${sub.length} parts instead`);
      if (listed.delete(part) && cleared) record();
      for (const s of sub) await one(`${part}/${s}`, level + 1);
      return;
    }
    res.built.push(part);
    listed.add(part);
    record();
  };

  for (const part of parts) await one(part, 0);
  if (cleared && res.index) ensureGitignored(root, contextDirFor(root, opts.override));
  res.listed = [...listed].sort();
  return res;
}
