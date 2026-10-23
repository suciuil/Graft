/**
 * `graft where`: where graft keeps a repo's files, for a person to find them.
 * Most of all the profile store (context/profile-store.ts), whose folder names
 * carry a hash and so can't be guessed. The map (cards, INDEX.md, the graph and
 * caches) and the settings file, each with where the choice came from and
 * whether it exists yet.
 *
 * Pure over the file system and the environment; the commander wiring is in
 * cli.ts.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { cmd } from "../brand.js";
import { buildConfigPath, resolveContextDir } from "../util/state.js";
import { discoverWorkspaceChildren } from "../graph/scopes.js";
import { readWorkspace } from "../graph/workspace.js";
import { isOutside, PROFILE_REPO_NOTE, profileStoreRoot } from "./profile-store.js";

/** Why the map or settings are where they are. */
export type WhereSource = "profile store" | "repo" | "--dir" | "GRAFT_DIR";

export interface WhereEntry {
  /** The repo or folder, absolute. */
  root: string;
  /** Path relative to the parent, for a workspace child; absent otherwise. */
  child?: string;
  map: { path: string; source: WhereSource; built: boolean };
  settings: { path: string; source: WhereSource; exists: boolean };
  /** The repo's folder in the profile store, when it uses one. */
  storeDir: string | null;
}

export interface WhereReport {
  /** The store's root, or null when the store is off. */
  storeRoot: string | null;
  entries: WhereEntry[];
}

/** One folder's files. `override` is the global `--dir`. */
export function whereFor(root: string, override?: string, env: NodeJS.ProcessEnv = process.env): WhereEntry {
  const abs = resolve(root);
  let mapPath: string;
  let mapSource: WhereSource;
  if (override) {
    mapPath = resolve(override);
    mapSource = "--dir";
  } else if (env.GRAFT_DIR) {
    mapPath = resolveContextDir(abs);
    mapSource = "GRAFT_DIR";
  } else {
    mapPath = resolveContextDir(abs);
    mapSource = isOutside(abs, mapPath) ? "profile store" : "repo";
  }
  const settingsPath = buildConfigPath(abs);
  const settingsSource: WhereSource = isOutside(abs, settingsPath) ? "profile store" : "repo";
  // The store folder is the parent of whichever piece lives there.
  const storeDir =
    mapSource === "profile store" ? dirname(mapPath) : settingsSource === "profile store" ? dirname(settingsPath) : null;
  return {
    root: abs,
    map: { path: mapPath, source: mapSource, built: existsSync(join(mapPath, ".graph")) || existsSync(join(mapPath, "INDEX.md")) },
    settings: { path: settingsPath, source: settingsSource, exists: existsSync(settingsPath) },
    storeDir,
  };
}

/**
 * Every folder to report for `roots`: each one, and for a workspace parent
 * (a folder of several git repos) each child repo too, since each child keeps
 * its own map.
 */
export function whereReport(roots: string[], override?: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): WhereReport {
  const entries: WhereEntry[] = [];
  const seen = new Set<string>();
  const add = (e: WhereEntry) => {
    const k = process.platform === "win32" || process.platform === "darwin" ? e.root.toLowerCase() : e.root;
    if (seen.has(k)) return;
    seen.add(k);
    entries.push(e);
  };
  for (const r of roots) {
    const root = resolve(r);
    add(whereFor(root, override, env));
    // Children are reported with their own default place: a `--dir` names one folder, not one per child.
    const ws = readWorkspace(root, override);
    const children = ws ? ws.children : existsSync(join(root, ".git")) ? [] : discoverWorkspaceChildren(root);
    if (!ws && children.length < 2) continue;
    for (const c of [...children].sort()) add({ ...whereFor(join(root, c), undefined, env), child: c });
  }
  return { storeRoot: profileStoreRoot(env, home), entries };
}

export interface StoreFolder {
  /** The repo's folder in the store. */
  dir: string;
  /** The checkout it belongs to, from its `repo.json`; null when that is missing or unreadable. */
  root: string | null;
  /** Whether that checkout is still on disk. */
  rootExists: boolean;
  built: boolean;
  hasSettings: boolean;
}

/** Every repo folder in the store, A→Z, with the checkout each belongs to. */
export function listStoreFolders(storeRoot: string): StoreFolder[] {
  let names: string[];
  try {
    names = readdirSync(storeRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return names.sort().map((name) => {
    const dir = join(storeRoot, name);
    let root: string | null = null;
    try {
      const note = JSON.parse(readFileSync(join(dir, PROFILE_REPO_NOTE), "utf8")) as { root?: unknown };
      if (typeof note.root === "string" && isAbsolute(note.root)) root = note.root;
    } catch {
      // no note: listed without its checkout
    }
    return {
      dir,
      root,
      rootExists: root !== null && existsSync(root),
      built: existsSync(join(dir, "graph", ".graph")) || existsSync(join(dir, "graph", "INDEX.md")),
      hasSettings: existsSync(join(dir, "config.json")),
    };
  });
}

/** The human report for `graft where`. */
export function formatWhereReport(r: WhereReport): string {
  const lines: string[] = [];
  lines.push(
    r.storeRoot
      ? `profile store: ${r.storeRoot}`
      : "profile store: off (GRAFT_PROFILE_STORE=0 or \"profileStore\": false), so new repos keep graft/ and .graft/ inside them",
  );
  for (const e of r.entries) {
    lines.push("");
    lines.push(e.child ? `${e.root}  (workspace repo ${e.child})` : e.root);
    if (e.storeDir) lines.push(`  store:     ${e.storeDir}`);
    lines.push(`  map:       ${e.map.path}`);
    lines.push(`             ${from(e.map.source)} · ${e.map.built ? "built" : `not built yet, run ${cmd("graft build")}`}`);
    lines.push(`  settings:  ${e.settings.path}`);
    lines.push(`             ${from(e.settings.source)} · ${e.settings.exists ? "exists" : "not created yet, every setting at its default"}`);
  }
  return lines.join("\n");
}

function from(s: WhereSource): string {
  switch (s) {
    case "profile store":
      return "in your profile store";
    case "repo":
      return "inside the repo";
    case "--dir":
      return "from --dir";
    case "GRAFT_DIR":
      return "from GRAFT_DIR";
  }
}

/** The human report for `graft where --all`. */
export function formatStoreFolders(storeRoot: string | null, folders: StoreFolder[]): string {
  if (!storeRoot) return "profile store: off (GRAFT_PROFILE_STORE=0 or \"profileStore\": false)";
  const lines = [`profile store: ${storeRoot}`];
  if (folders.length === 0) {
    lines.push("  empty: no repo keeps its files here yet");
    return lines.join("\n");
  }
  for (const f of folders) {
    lines.push("");
    lines.push(f.dir);
    const repo = f.root === null ? "unknown (no repo.json)" : f.rootExists ? f.root : `${f.root}  (gone: the folder can be deleted)`;
    lines.push(`  repo:      ${repo}`);
    lines.push(`  map:       ${f.built ? "built" : "none"} · settings: ${f.hasSettings ? "yes" : "none"}`);
  }
  return lines.join("\n");
}
