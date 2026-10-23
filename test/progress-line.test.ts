import { test } from "node:test";
import assert from "node:assert/strict";
import { startProgressLine } from "../src/util/progress-line.js";

function fakeStream(isTTY: boolean): NodeJS.WriteStream & { text: () => string } {
  let buf = "";
  const s = {
    isTTY,
    columns: 200,
    write(chunk: unknown) {
      buf += String(chunk);
      return true;
    },
    text: () => buf,
  };
  return s as unknown as NodeJS.WriteStream & { text: () => string };
}

test("progress line (log): a warning starts on its own line, never glued to the progress text", () => {
  const err = fakeStream(false);
  const p = startProgressLine(err, []);
  p.update("reading concepts 17/913: src/ai/crux.ts");
  err.write("⚠ https://gw returned 404; retrying at https://gw/v1\n");
  p.update("reading concepts 18/913: src/ai/x.ts");
  p.end();
  assert.equal(
    err.text(),
    "\rreading concepts 17/913: src/ai/crux.ts\n⚠ https://gw returned 404; retrying at https://gw/v1\n\rreading concepts 18/913: src/ai/x.ts\n",
  );
});

test("progress line (terminal): erased before other output, redrawn below it, restored on end", () => {
  const err = fakeStream(true);
  const out = fakeStream(true);
  const origErr = err.write;
  const origOut = out.write;
  const p = startProgressLine(err, [out]);
  p.update("writing concepts 3/17: batch 2");
  out.write("  synthesis batch 1/17: 0 nodes\n");
  assert.equal(err.text(), "\r\x1b[2Kwriting concepts 3/17: batch 2\r\x1b[2Kwriting concepts 3/17: batch 2");
  p.end();
  assert.ok(err.text().endsWith("\n"), "the line is ended");
  assert.equal(err.write, origErr);
  assert.equal(out.write, origOut);
  // After end, writes pass straight through.
  err.write("after\n");
  assert.ok(err.text().endsWith("\nafter\n"));
});

test("progress line: end without any update writes nothing", () => {
  const err = fakeStream(false);
  const p = startProgressLine(err, []);
  p.end();
  p.end();
  assert.equal(err.text(), "");
});
