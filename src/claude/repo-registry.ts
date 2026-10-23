/**
 * Every folder graft has filed a saving in, for this user on this machine.
 *
 * A repo's savings ledger lives inside that repo (`graft/.cache/savings.json`,
 * see `ledger.ts`), which is the right place for "what did graft save THIS
 * repo" and the wrong one for "what has graft saved ME": nothing outside a repo
 * knows the repo exists. So the one write funnel every saving passes through
 * also notes the folder here, in the user's profile, and `graft savings --all`
 * reads each listed ledger and adds them up.
 *
 * Only a pointer is stored — the folder and where its ledger was — never a copy
 * of the figures. The repo's own ledger stays the single source of truth, so a
 * repo deleted, or its cache cleared, simply stops contributing; nothing here can
 * disagree with what `graft savings` reports inside that repo.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readJson, writeJsonAtomic } from '../util/state.js';
import { anyProfileMapDirFor } from '../context/profile-store.js';

/** One folder graft has recorded a saving in. */
export interface RegisteredRepo {
  /** Absolute path of the folder, as it was spelled when first registered. */
  root: string;
  /** Absolute path of its `savings.json` when last registered. A map can move
   * (`graft/` → `.trail/cache/`), so a reader falls back to the known layouts
   * when this one is gone — see {@link ledgerCandidates}. */
  ledger: string;
  /** ISO timestamps: first saving filed, and the latest day one was. */
  firstSeen: string;
  lastSeen: string;
}

export interface RepoRegistry {
  repos: RegisteredRepo[];
  /** ISO timestamp of the last scan of the agent hosts' own folder lists
   * ({@link registerDiscovered}). Absent until the first `graft savings --all`. */
  discoveredAt?: string;
}

/** `GRAFT_REPOS_FILE` wins, so tests and unusual setups never touch the real
 * profile. Its own file under `~/.graft/`, beside `settings.json` and
 * `prices.json`. */
export function repoRegistryPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.GRAFT_REPOS_FILE?.trim();
  return override ? resolve(override) : join(home, '.graft', 'repos.json');
}

/** The comparison key for a path: Windows and macOS file systems are
 * case-insensitive by default, and `D:\Repo` and `d:\repo` must be one entry
 * rather than one repo counted twice. */
export function pathKey(p: string): string {
  const abs = resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? abs.toLowerCase() : abs;
}

export function readRepoRegistry(file: string = repoRegistryPath()): RepoRegistry {
  const r = readJson<RepoRegistry>(file);
  if (!r || !Array.isArray(r.repos)) return { repos: [] };
  return {
    repos: r.repos.filter(
      (x): x is RegisteredRepo => !!x && typeof x.root === 'string' && typeof x.ledger === 'string',
    ),
    ...(typeof r.discoveredAt === 'string' ? { discoveredAt: r.discoveredAt } : {}),
  };
}

/** Folders already noted by this process today, so a long-lived MCP server does
 * not re-read the registry on every tool call. Keyed by file too, so a test that
 * points `GRAFT_REPOS_FILE` elsewhere is not answered from another file's memo. */
const notedToday = new Set<string>();

export interface RegisterOptions {
  /** When the saving was filed. */
  when?: Date;
  /** Registry file; defaults to {@link repoRegistryPath}. */
  file?: string;
  /** Whether this call reflects a saving just filed (the default) and so moves
   * `lastSeen`. False for a backfill — `graft savings` noting a repo whose
   * ledger predates the registry — which adds a missing entry and nothing else. */
  touch?: boolean;
}

/**
 * Note that `root` has a savings ledger at `ledger`. Best-effort and never
 * throwing, like every ledger write: a cross-repo total is not worth failing a
 * tool call over.
 *
 * Writes only when something changed — a new folder, a moved ledger, or the first
 * saving of a new day — so the registry is rewritten at most once a day per repo,
 * not once per query.
 */
export function registerRepo(root: string, ledger: string, opts: RegisterOptions = {}): void {
  try {
    const when = opts.when ?? new Date();
    const file = opts.file ?? repoRegistryPath();
    const touch = opts.touch ?? true;
    const day = when.toISOString().slice(0, 10);
    const memo = `${pathKey(file)}|${pathKey(root)}|${pathKey(ledger)}|${touch ? day : 'backfill'}`;
    if (notedToday.has(memo)) return;

    const registry = readRepoRegistry(file);
    const key = pathKey(root);
    const absLedger = resolve(ledger);
    const stamp = when.toISOString();
    const hit = registry.repos.find((r) => pathKey(r.root) === key);
    if (!hit) {
      // A backfilled ledger is dated by its own history, not by today.
      const span = touch ? null : ledgerSpan(absLedger);
      registry.repos.push({ root: resolve(root), ledger: absLedger, firstSeen: span?.first ?? stamp, lastSeen: span?.last ?? stamp });
    } else if (pathKey(hit.ledger) !== pathKey(absLedger)) {
      hit.ledger = absLedger;
      if (touch) hit.lastSeen = stamp;
    } else if (touch && (hit.lastSeen ?? '').slice(0, 10) !== day) {
      hit.lastSeen = stamp;
    } else {
      notedToday.add(memo);
      return;
    }
    writeJsonAtomic(file, registry);
    notedToday.add(memo);
  } catch {
    // A cross-repo index is never worth failing a tool call over.
  }
}

/** Drop the registry memo — for tests that rewrite the file underneath it. */
export function resetRegistryMemo(): void {
  notedToday.clear();
}

/**
 * Where a registered folder's ledger may be now, most likely first: where it was
 * last seen, then the layouts a map can have (`graft/`, `.trail/cache/` for a
 * repo on trail, and the folder's map in the profile store).
 *
 * Deliberately not `ledgerPath(root)`: that resolves through `mapDirFor`, which
 * can MOVE a map on disk, and through `GRAFT_DIR` in the current environment,
 * which belongs to the repo the command was run in, not to every repo listed.
 */
export function ledgerCandidates(r: RegisteredRepo): string[] {
  const out = [
    r.ledger,
    join(r.root, 'graft', '.cache', 'savings.json'),
    join(r.root, '.trail', 'cache', '.cache', 'savings.json'),
    // The profile store's map for this folder (context/profile-store.ts), found from
    // the folder's path whether or not the store is on in this environment.
    join(anyProfileMapDirFor(r.root), '.cache', 'savings.json'),
  ];
  const seen = new Set<string>();
  return out.filter((p) => {
    const k = pathKey(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The ledger file a registered folder currently has, or null when none of the
 * known places holds one (the repo was deleted, moved, or its cache cleared). */
export function locateLedger(r: RegisteredRepo): string | null {
  return ledgerCandidates(r).find((p) => existsSync(p)) ?? null;
}

/** The first and last day a ledger file has an entry for, as ISO timestamps, so
 * a repo found after the fact is listed with when it was really used rather
 * than when it was found. Null when the file has no days. */
function ledgerSpan(file: string): { first: string; last: string } | null {
  const l = readJson<{ days?: Record<string, unknown> }>(file);
  const days = l && l.days && typeof l.days === 'object' ? Object.keys(l.days).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : [];
  if (days.length === 0) return null;
  return { first: `${days[0]}T00:00:00.000Z`, last: `${days[days.length - 1]}T00:00:00.000Z` };
}

/**
 * The repo root and ledger file for a folder a host named, walking up from it:
 * a host may have opened a subfolder of the repo graft records savings for.
 * `checked` remembers folders already looked at, so many folders inside one
 * tree cost one look each.
 */
function findLedgerAbove(folder: string, checked: Map<string, { root: string; ledger: string } | null>): { root: string; ledger: string } | null {
  const visited: string[] = [];
  let found: { root: string; ledger: string } | null = null;
  for (let d = resolve(folder); ; d = dirname(d)) {
    const k = pathKey(d);
    if (checked.has(k)) {
      found = checked.get(k)!;
      break;
    }
    visited.push(k);
    const ledger = ledgerCandidates({ root: d, ledger: join(d, 'graft', '.cache', 'savings.json'), firstSeen: '', lastSeen: '' })
      .find((p) => existsSync(p));
    if (ledger) {
      found = { root: d, ledger };
      break;
    }
    if (dirname(d) === d) break;
  }
  for (const k of visited) checked.set(k, found);
  return found;
}

/**
 * Add every folder among `folders` (or a parent of one) that holds a savings
 * ledger and is not listed yet, in one read and at most one write of the
 * registry. This is how repos where graft recorded savings before the registry
 * existed get onto it: the folders come from the agent hosts' own records of
 * where they have worked (`hosts/known-folders.ts`).
 *
 * Only folders whose ledger file exists are added, so listing every folder an
 * editor ever opened costs nothing in the registry. Returns the roots added.
 * Never throws.
 */
export function registerDiscovered(
  folders: string[],
  opts: { file?: string; now?: Date } = {},
): string[] {
  try {
    const file = opts.file ?? repoRegistryPath();
    const now = (opts.now ?? new Date()).toISOString();
    const registry = readRepoRegistry(file);
    const listed = new Set(registry.repos.map((r) => pathKey(r.root)));
    const checked = new Map<string, { root: string; ledger: string } | null>();
    const added: string[] = [];
    for (const folder of folders) {
      if (typeof folder !== 'string' || !folder.trim() || !isAbsolute(folder)) continue;
      const hit = findLedgerAbove(folder, checked);
      if (!hit || listed.has(pathKey(hit.root))) continue;
      listed.add(pathKey(hit.root));
      const span = ledgerSpan(hit.ledger);
      registry.repos.push({ root: hit.root, ledger: hit.ledger, firstSeen: span?.first ?? now, lastSeen: span?.last ?? now });
      added.push(hit.root);
    }
    registry.discoveredAt = now;
    writeJsonAtomic(file, registry);
    return added;
  } catch {
    return [];
  }
}
