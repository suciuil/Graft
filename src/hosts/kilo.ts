/**
 * Kilo Code's config file — the one host whose instruction file and MCP server
 * land in the SAME place.
 *
 * Kilo reads project settings from `.kilo/kilo.jsonc` (or a root `kilo.jsonc`;
 * the `.kilo/` copy wins when both exist). Two keys matter to graft:
 *
 *   - `instructions`: a list of file paths/globs. A rule file under
 *     `.kilo/rules/` is NOT picked up unless it is listed here — only the
 *     legacy `.kilocode/rules/` directory is auto-included — so writing
 *     `.kilo/rules/graft.md` without registering it would be a no-op.
 *   - `mcp`: the server map, in the same `{type:'local', command:[…]}` shape
 *     OpenCode uses. (`.kilocode/mcp.json` is the legacy file and is not
 *     compatible with this key.)
 *
 * Both edits are one read-modify-write here rather than being split between
 * registry.ts and mcp-config.ts, so selecting Kilo touches the file once.
 *
 * `kiloConfigTargets()` is the pure "which files would this touch" half (for
 * `graft init --dry-run` / the picker); `writeKiloConfig()` does the write.
 *
 * The file is JSONC by design. Comments are read through (see
 * {@link stripJsonc}) so an already-wired config still reports 'unchanged',
 * but a commented file is never *rewritten* — `JSON.stringify` would delete
 * the user's comments. That case reports 'skipped-unparseable' and the CLI
 * tells them what to add.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { localServerEntry, type McpWrite } from './mcp-config.js';
import type { PlannedWrite } from './plan.js';

/**
 * The rule file, relative to the repo root — posix separators because it is
 * written verbatim into `instructions`, where a Windows backslash would not
 * match. `join()` normalizes it back to native when used as a path.
 */
export const KILO_RULE_REL = '.kilo/rules/graft.md';

/**
 * Candidate config locations, highest precedence first. Merging into whichever
 * one already exists matters: creating `.kilo/kilo.jsonc` next to a user's
 * root `kilo.jsonc` would shadow the file they actually maintain.
 */
const CONFIG_CANDIDATES = [
  join('.kilo', 'kilo.jsonc'),
  join('.kilo', 'kilo.json'),
  'kilo.jsonc',
  'kilo.json',
];

/** The config graft will merge into: the existing one, else `.kilo/kilo.jsonc`. */
export function kiloConfigPath(repo: string): string {
  for (const rel of CONFIG_CANDIDATES) {
    const p = join(repo, rel);
    if (existsSync(p)) return p;
  }
  return join(repo, CONFIG_CANDIDATES[0]);
}

/**
 * Comments and trailing commas out, enough to *read* a .jsonc. String-aware, so
 * a `//` inside a value survives. Read-only: what this returns is never written
 * back, it only answers "is graft already registered here?".
 */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '"') { j++; break; }
        j++;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The file selecting Kilo Code would touch beyond its rule file — pure, no writes. */
export function kiloConfigTargets(repo: string): PlannedWrite[] {
  return [
    {
      hostId: 'kilo', id: 'kilo-config',
      path: kiloConfigPath(repo),
      scope: 'repo',
      // Tagged 'mcp' so the picker doesn't label Kilo Code as having no MCP.
      kind: 'mcp',
      what: 'mcp.graft + instructions[]',
    },
  ];
}

/**
 * Register the rule file in `instructions` and (unless `mcp` is false) the graft
 * server under `mcp`, preserving every other key.
 */
export function writeKiloConfig(repo: string, opts: { mcp?: boolean } = {}): McpWrite {
  const path = kiloConfigPath(repo);
  const id = 'kilo-config';
  const existed = existsSync(path);

  let root: Record<string, any> = {};
  /** False when the file only parses after comment-stripping — do not rewrite it. */
  let strictJson = true;
  if (existed) {
    const raw = readFileSync(path, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      strictJson = false;
      try { parsed = JSON.parse(stripJsonc(raw)); } catch { return { id, path, action: 'skipped-unparseable' }; }
    }
    if (!isPlainObject(parsed)) return { id, path, action: 'skipped-unparseable' };
    root = parsed;
  }
  const before = JSON.stringify(root);

  // `instructions` is a list of paths/globs. A non-array value is the user's own
  // shape, not ours to reinterpret — leave it and let the MCP half still land.
  if (root.instructions === undefined) root.instructions = [KILO_RULE_REL];
  else if (Array.isArray(root.instructions) && !root.instructions.includes(KILO_RULE_REL))
    root.instructions.push(KILO_RULE_REL);

  if (opts.mcp !== false) {
    const bucket = (root.mcp ??= {});
    if (!isPlainObject(bucket)) return { id, path, action: 'skipped-unparseable' };
    bucket.graft = localServerEntry();
  }

  if (JSON.stringify(root) === before) return { id, path, action: 'unchanged' };
  if (!strictJson) return { id, path, action: 'skipped-unparseable' };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  return { id, path, action: existed ? 'updated' : 'created' };
}
