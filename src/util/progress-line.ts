/**
 * A `\r`-overwritten progress line ("reading concepts 17/913: src/x.ts") that
 * other output cannot collide with.
 *
 * A plain `process.stderr.write("\r…")` leaves the cursor at the end of the
 * progress text, so the next warning (`⚠ model … not available`, a per-batch log
 * line) was glued onto it: `reading concepts 17/913: src/ai/crux.ts  ⚠ https://…`.
 * While a progress line is active, every other write to the same stream (and to
 * stdout when both are one terminal) first takes the progress line off — erased
 * on a terminal, ended with a newline in a log — and on a terminal the progress
 * line is redrawn below the finished output.
 */
type Write = NodeJS.WriteStream["write"];

export interface ProgressLine {
  /** Replace the progress text. */
  update(text: string): void;
  /** Stop intercepting; ends the line when one is showing. Safe to call more than once. */
  end(): void;
}

function endsWithNewline(chunk: unknown): boolean {
  if (typeof chunk === "string") return chunk.endsWith("\n");
  if (chunk instanceof Uint8Array) return chunk.length > 0 && chunk[chunk.length - 1] === 0x0a;
  return false;
}

export function startProgressLine(
  stream: NodeJS.WriteStream = process.stderr,
  others: NodeJS.WriteStream[] = stream === process.stderr && process.stdout.isTTY && process.stderr.isTTY ? [process.stdout] : [],
): ProgressLine {
  const tty = Boolean(stream.isTTY);
  const original = stream.write;
  const raw = (s: string) => original.call(stream, s);
  const width = () => Math.max(20, (stream.columns || 100) - 1);
  let open = false;
  let last = "";
  let ended = false;
  const restore: (() => void)[] = [];

  const intercept = (s: NodeJS.WriteStream) => {
    const orig = s.write;
    s.write = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]) {
      if (!open) return (orig as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
      // Take the progress line off before anything else lands on its row.
      raw(tty ? "\r\x1b[2K" : "\n");
      open = false;
      const r = (orig as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
      // Redraw it under complete lines only; a partial write is left to finish.
      if (tty && endsWithNewline(chunk)) {
        raw(last);
        open = true;
      }
      return r;
    } as unknown as Write;
    restore.push(() => {
      s.write = orig;
    });
  };
  intercept(stream);
  for (const o of others) if (o !== stream) intercept(o);

  return {
    update(text: string) {
      if (ended) return;
      last = tty && text.length > width() ? text.slice(0, width()) : text;
      raw(tty ? `\r\x1b[2K${last}` : `\r${last}`);
      open = true;
    },
    end() {
      if (ended) return;
      ended = true;
      for (const r of restore.reverse()) r();
      if (open) raw("\n");
      open = false;
    },
  };
}

/** Run `fn` with a progress line that is always ended, however `fn` finishes. */
export async function withProgressLine<T>(fn: (line: ProgressLine) => Promise<T>): Promise<T> {
  const line = startProgressLine();
  try {
    return await fn(line);
  } finally {
    line.end();
  }
}
