/**
 * The workspace index, `<map dir>/workspace.json`: its format, reader and
 * writers, and nothing else. Kept apart from `workspace.ts` (the federated
 * queries, which load the whole query stack) so that code which only needs to
 * know whether a repository is a workspace, or built in parts, stays light:
 * the agent-instruction writers read it (`hosts/repo-facts.ts`).
 * `workspace.ts` re-exports all of it.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { contextDirFor } from "../context/node-file.js";

/** The parent index written to `<parent>/graft/workspace.json`. Nodes/edges
 * never live at the parent — they live in each child's own `graft/`. */
export interface WorkspaceV1 {
  version: 1;
  /** Immediate child dir names that are git repos, sorted. For `kind: "parts"`,
   * the root-relative folders (`Src/EBS/ActP`) that each have their own map. */
  children: string[];
  /** `"parts"`: one repository too big for one map, built as one map per folder
   * (`graft build --all-parts`). Absent: a folder of separate git repos. */
  kind?: "parts";
}

/** True for the index of a repository built as one map per part. */
export function isPartsWorkspace(ws: WorkspaceV1 | null): boolean {
  return ws?.kind === "parts";
}

const WORKSPACE_FILE = "workspace.json";

/**
 * The version a parts index is written with (`kind: "parts"`). Above 1 so that
 * a graft from before parts indexes reads none, instead of taking the index for
 * a folder of repos and rewriting it with no children on its next build. Read
 * back as a {@link WorkspaceV1}; version 1 parts indexes are still read.
 */
export const PARTS_INDEX_VERSION = 2;

/**
 * True for a child or part that names a folder inside the root: relative, with
 * no `.`/`..`/empty segment. The index is committed, so a cloned repository can
 * hold any text there; a build writes into each part, so nothing may point out.
 */
export function isSafePart(part: string): boolean {
  if (part === "" || isAbsolute(part)) return false;
  const p = part.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/** Absolute path to the workspace index for a parent root (`<dir>/graft/workspace.json`). */
export function workspacePath(root: string, override?: string): string {
  return join(contextDirFor(root, override), WORKSPACE_FILE);
}

/** Read the workspace index, or null when the parent has none (not a workspace,
 * or unparseable/foreign json — treated the same as absent). Children that do
 * not name a folder inside the root ({@link isSafePart}) are left out. */
export function readWorkspace(root: string, override?: string): WorkspaceV1 | null {
  const path = workspacePath(root, override);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; children?: unknown; kind?: unknown };
    const parts = parsed.kind === "parts";
    if (!Array.isArray(parsed.children)) return null;
    if (parsed.version !== 1 && !(parts && parsed.version === PARTS_INDEX_VERSION)) return null;
    const ws: WorkspaceV1 = { version: 1, children: parsed.children.map(String).filter(isSafePart) };
    if (parts) ws.kind = "parts";
    return ws;
  } catch {
    return null;
  }
}

/** Write the workspace index, sorting children for a stable, minimal git diff.
 * A parts index is written as {@link PARTS_INDEX_VERSION}. */
export function writeWorkspace(root: string, ws: WorkspaceV1, override?: string): string {
  const dir = contextDirFor(root, override);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, WORKSPACE_FILE);
  const children = [...ws.children].sort();
  const out = ws.kind === "parts"
    ? { version: PARTS_INDEX_VERSION, children, kind: ws.kind }
    : { version: 1, children };
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  return path;
}

/** Remove the workspace index alone, leaving the rest of the map folder. */
export function removeWorkspace(root: string, override?: string): void {
  rmSync(workspacePath(root, override), { force: true });
}
