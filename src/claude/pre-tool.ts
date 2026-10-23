/**
 * PreToolUse for the gate (gate.ts), as its own entry point: `node graft-hooks.cjs pre-tool`.
 *
 * The gate runs before every Read, Grep and shell call, with the call stalled
 * behind it, so the shim sends `pre-tool` here rather than to hooks.js, which
 * pulls in the whole CLI (the graph, telemetry, learnings and skills code the
 * other hooks share). This module loads only the gate, the session file it
 * records a refusal in, and hook-layers.ts to stand down for the ~/.claude copy.
 *
 * It fails open: bad stdin, a missing repo or any error allows the call.
 */
import { fstatSync } from 'node:fs';
import { handlePreTool } from './gate.js';
import { globalCopyCovers } from './hook-layers.js';

/** The longest the payload may take to arrive: the same bound as pre-bash.ts, well inside the 5 s the hook is given. */
const STDIN_WAIT_MS = 2000;

/**
 * stdin to its end, or "" for a terminal or a read error. Not `readFileSync(0)`:
 * a host that writes the payload and never closes stdin left that read blocked
 * for good, holding up the tool call until the host killed the hook (on
 * Windows nothing gets past a pending synchronous read on a pipe). The stream
 * read gives up after STDIN_WAIT_MS and the hook exits 0, which allows the call.
 */
function readStdin(): Promise<string> {
  try {
    if (fstatSync(0).isCharacterDevice()) return Promise.resolve('');
  } catch {
    return Promise.resolve('');
  }
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => process.exit(0), STDIN_WAIT_MS);
    const finish = (text: string) => {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.pause();
      done(text);
    };
    process.stdin.on('data', (d: Buffer) => chunks.push(d));
    process.stdin.once('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.once('error', () => finish(''));
  });
}

async function readInput(): Promise<Record<string, unknown>> {
  try {
    const seam = process.env.GRAFT_TEST_STDIN;
    const raw = seam !== undefined ? seam : await readStdin();
    const input: unknown = JSON.parse(raw);
    return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The shim's entry for `pre-tool`. Never rejects. */
export async function main(event = 'pre-tool'): Promise<void> {
  try {
    if (process.env.TRAIL_NO_HOOKS === '1') return;
    const input = await readInput();
    // Registered in the repo and in ~/.claude, Claude Code runs both: one answers.
    if (globalCopyCovers(event, process.argv[1], undefined, process.env, input)) return;
    const cwd = typeof input.cwd === 'string' ? input.cwd : '';
    handlePreTool(input, process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd());
  } catch {
    // Never stand in the way of a tool call over our own failure.
  }
}
