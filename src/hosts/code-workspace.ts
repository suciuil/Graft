/**
 * VS Code `.code-workspace` files, for `graft init`.
 *
 * A multi-root workspace opens every folder it lists as its own root, and each
 * agent session reads its instruction files from those roots — not from the
 * directory the `.code-workspace` file sits in. So when the directory `init`
 * runs in holds a workspace file, its folders are what need wiring.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { stripComments } from './vscode-session.js';

export const CODE_WORKSPACE_EXT = '.code-workspace';

/** The `.code-workspace` files directly inside `dir` (not its subfolders), sorted by name. */
export function findCodeWorkspaces(dir: string): string[] {
  const abs = resolve(dir);
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.toLowerCase().endsWith(CODE_WORKSPACE_EXT) && n.length > CODE_WORKSPACE_EXT.length)
    .map((n) => join(abs, n))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => basename(a).localeCompare(basename(b)));
}

export interface CodeWorkspaceFolders {
  /** Absolute, existing folders, in the file's order, without duplicates. */
  folders: string[];
  /** Entries that resolved to nothing on disk, as written in the file. */
  missing: string[];
  /** Entries graft can't wire (a non-`file:` URI, such as a remote folder). */
  unsupported: string[];
}

function samePath(a: string, b: string): boolean {
  const n = (p: string) => {
    const s = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s;
  };
  return n(a) === n(b);
}

/**
 * The folders a `.code-workspace` file lists, resolved against the file's own
 * directory as VS Code does. Throws when the file can't be read or isn't a
 * workspace (no parseable JSON object).
 */
export function readCodeWorkspaceFolders(file: string): CodeWorkspaceFolders {
  const cfg: unknown = JSON.parse(stripComments(readFileSync(file, 'utf8')));
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('not a JSON object');
  const entries = Array.isArray((cfg as { folders?: unknown }).folders) ? (cfg as { folders: unknown[] }).folders : [];
  const base = dirname(resolve(file));
  const out: CodeWorkspaceFolders = { folders: [], missing: [], unsupported: [] };
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const { path, uri } = e as { path?: unknown; uri?: unknown };
    let abs: string | null = null;
    let shown = '';
    if (typeof path === 'string') {
      abs = resolve(base, path);
      shown = path;
    } else if (typeof uri === 'string') {
      shown = uri;
      if (uri.startsWith('file:')) {
        try {
          abs = fileURLToPath(uri);
        } catch {
          abs = null;
        }
      }
      if (!abs) {
        out.unsupported.push(uri);
        continue;
      }
    } else continue;
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      out.missing.push(shown);
      continue;
    }
    if (!out.folders.some((f) => samePath(f, abs!))) out.folders.push(abs);
  }
  return out;
}

/** One `.code-workspace` file offered to the user, with its folder count (null when unreadable). */
export interface CodeWorkspaceChoice {
  file: string;
  folders: number | null;
}

/** Each workspace file in `files` with how many folders it would wire. */
export function describeCodeWorkspaces(files: string[]): CodeWorkspaceChoice[] {
  return files.map((file) => {
    try {
      return { file, folders: readCodeWorkspaceFolders(file).folders.length };
    } catch {
      return { file, folders: null };
    }
  });
}

/**
 * Ask which `.code-workspace` file to use. Resolves to the chosen file, `null`
 * for "none — the whole folder", or `undefined` when the user cancelled (EOF or
 * ctrl-c). Re-asks on an answer that isn't one of the listed numbers.
 */
export async function promptCodeWorkspace(
  choices: CodeWorkspaceChoice[],
  dir: string,
  io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<string | null | undefined> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stderr;
  const count = (n: number | null) => (n === null ? 'unreadable' : `wire its ${n} folder${n === 1 ? '' : 's'}`);
  const lines = [
    choices.length === 1 ? `Found a VS Code workspace in ${dir}:` : `Found ${choices.length} VS Code workspaces in ${dir}:`,
    ...choices.map((c, i) => `  ${i + 1}) ${basename(c.file)} · ${count(c.folders)}`),
    `  0) none · wire this whole folder instead`,
  ];
  output.write(`${lines.join('\n')}\n`);
  const ask = () => output.write(`Which one should init use? [0-${choices.length}] `);
  const rl = createInterface({ input, crlfDelay: Infinity, terminal: false });
  try {
    ask();
    // The line iterator buffers, so answers typed (or piped) ahead aren't lost.
    for await (const answer of rl) {
      const n = Number(answer.trim());
      if (answer.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= choices.length) {
        return n === 0 ? null : choices[n - 1]!.file;
      }
      output.write(`  enter a number from 0 to ${choices.length}\n`);
      ask();
    }
    return undefined;
  } finally {
    rl.close();
  }
}
