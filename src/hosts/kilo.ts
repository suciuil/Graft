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
import type { Brand } from '../brand.js';

/**
 * The rule file, relative to the repo root — posix separators because it is
 * written verbatim into `instructions`, where a Windows backslash would not
 * match. `join()` normalizes it back to native when used as a path. Named after
 * the repo's name for the tool, like every other owned file (see `hostRelPath`).
 */
export function kiloRuleRel(name: Brand = 'graft'): string {
  return `.kilo/rules/${name}.md`;
}

export const KILO_RULE_REL = kiloRuleRel('graft');

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

type KiloRead =
  | { kind: 'absent' }
  | { kind: 'unparseable' }
  | { kind: 'ok'; root: Record<string, any>; strictJson: boolean };

/** Read a Kilo config, through JSONC comments if need be. `strictJson` is false
 * when it only parsed after comment-stripping: such a file must not be rewritten. */
export function readKiloConfig(path: string): KiloRead {
  if (!existsSync(path)) return { kind: 'absent' };
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  let strictJson = true;
  try {
    parsed = JSON.parse(raw);
  } catch {
    strictJson = false;
    try { parsed = JSON.parse(stripJsonc(raw)); } catch { return { kind: 'unparseable' }; }
  }
  return isPlainObject(parsed) ? { kind: 'ok', root: parsed, strictJson } : { kind: 'unparseable' };
}

/** The file selecting Kilo Code would touch beyond its rule file — pure, no writes. */
export function kiloConfigTargets(repo: string, name: Brand = 'graft'): PlannedWrite[] {
  return [
    {
      hostId: 'kilo', id: 'kilo-config',
      path: kiloConfigPath(repo),
      scope: 'repo',
      // Tagged 'mcp' so the picker doesn't label Kilo Code as having no MCP.
      kind: 'mcp',
      what: `mcp.${name} + instructions[]`,
    },
  ];
}

/**
 * Register the rule file in `instructions` and (unless `mcp` is false) the
 * server under `mcp`, preserving every other key. `name` is the repo's name for
 * the tool: under trail, graft's own entries come out, since `init` removes
 * graft's copy of the rule file they point at.
 */
export function writeKiloConfig(repo: string, opts: { mcp?: boolean; name?: Brand } = {}): McpWrite {
  const path = kiloConfigPath(repo);
  const id = 'kilo-config';
  const name = opts.name ?? 'graft';
  const rule = kiloRuleRel(name);
  const read = readKiloConfig(path);
  if (read.kind === 'unparseable') return { id, path, action: 'skipped-unparseable' };
  const existed = read.kind === 'ok';
  const root: Record<string, any> = read.kind === 'ok' ? read.root : {};
  const strictJson = read.kind === 'ok' ? read.strictJson : true;
  const before = JSON.stringify(root);

  // `instructions` is a list of paths/globs. A non-array value is the user's own
  // shape, not ours to reinterpret — leave it and let the MCP half still land.
  if (root.instructions === undefined) root.instructions = [rule];
  else if (Array.isArray(root.instructions)) {
    if (name === 'trail') root.instructions = root.instructions.filter((e: unknown) => e !== kiloRuleRel('graft'));
    if (!root.instructions.includes(rule)) root.instructions.push(rule);
  }

  if (opts.mcp !== false) {
    const bucket = (root.mcp ??= {});
    if (!isPlainObject(bucket)) return { id, path, action: 'skipped-unparseable' };
    if (name === 'trail') delete bucket.graft;
    bucket[name] = localServerEntry(name);
  }

  if (JSON.stringify(root) === before) return { id, path, action: 'unchanged' };
  if (!strictJson) return { id, path, action: 'skipped-unparseable' };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  return { id, path, action: existed ? 'updated' : 'created' };
}
