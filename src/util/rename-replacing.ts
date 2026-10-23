/**
 * `renameSync` over an existing file, for the "write a temp file, rename it into place" writers.
 *
 * On Windows a rename onto a file that another process has open for a moment (an antivirus scan, the search
 * indexer, a reader of the same file) fails with EPERM, EACCES or EBUSY, though the same rename a few milliseconds
 * later goes through. A file rewritten often (the savings ledger, the run index, the session state) hit this and
 * lost the write. Here it is retried for about a quarter of a second. Anywhere else, and for any other error, it
 * throws at once.
 *
 * Imports only node:fs, so the hooks' small modules can use it without pulling in anything heavier.
 */
import { renameSync } from 'node:fs';

const RETRIED = new Set(['EPERM', 'EACCES', 'EBUSY']);
const TRIES = 10;

export function renameReplacing(from: string, to: string, rename: (a: string, b: string) => void = renameSync): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || attempt >= TRIES || !RETRIED.has(code)) throw e;
      // 5, 10, 15 … 50 ms: about 275 ms in all, then give up.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * (attempt + 1));
    }
  }
}
