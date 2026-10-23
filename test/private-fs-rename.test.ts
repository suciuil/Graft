/**
 * writePrivate and writeJsonAtomic replace a file by renaming a temp file over it. On Windows that rename fails
 * with EPERM, EACCES or EBUSY while another process has the target open without delete sharing: an antivirus scan,
 * the search indexer, a reader of the same file. The lock is brief, so both retry for a short while
 * (util/rename-replacing.ts) instead of losing the write. Here a child process holds the file the way such a
 * scanner does, then lets go.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivate } from "../src/util/private-fs.js";
import { writeJsonAtomic } from "../src/util/state.js";
import { renameReplacing } from "../src/util/rename-replacing.js";

const WIN = process.platform === "win32";
const ON_WINDOWS = { skip: !WIN && "a lock that refuses a rename is a Windows thing" };

/**
 * Open `file` from another process with FileShare.Read only (no Delete, no Write: a rename over it is refused).
 * Resolves once the handle is open. With `untilTemp`, the holder closes it on its own as soon as a temp file
 * (`*.tmp`) shows up beside it, that is, once the write under test has started: the write retries on this thread,
 * blocking it, so the release can't come from here. `done` resolves when the holder has exited.
 */
function holdOpen(file: string, opts: { untilTemp: boolean }): Promise<{ done: Promise<void>; stop: () => void }> {
  const dir = join(file, "..");
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const wait = opts.untilTemp
    ? `while (-not (Get-ChildItem -LiteralPath ${q(dir)} -Filter '*.tmp' -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 5 }`
    : `[void][Console]::In.ReadLine()`;
  const script = `$f = [System.IO.File]::Open(${q(file)}, 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); ${wait}; $f.Close()`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["pipe", "pipe", "inherit"] });
  const done = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  const stop = () => child.stdin.end("\n");
  return new Promise((ready, fail) => {
    const timer = setTimeout(() => fail(new Error("the holder never opened the file")), 30_000);
    child.on("exit", () => fail(new Error("the holder exited before opening the file")));
    child.stdout.on("data", (d) => {
      if (String(d).includes("held")) {
        clearTimeout(timer);
        ready({ done, stop });
      }
    });
  });
}

// Both temp-file-and-rename writers: Trail's state (writePrivate) and graft's ledger, stats and sessions (writeJsonAtomic).
const WRITERS: Array<[string, (file: string, v: number) => void]> = [
  ["writePrivate", (file, v) => writePrivate(file, `{"v":${v}}`)],
  ["writeJsonAtomic", (file, v) => writeJsonAtomic(file, { v }, true)],
];

for (const [name, write] of WRITERS) {
  test(`${name} waits out a brief lock on the file it replaces, and leaves no temp file behind`, ON_WINDOWS, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "private-fs-rename-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "index.json");
    writeFileSync(file, '{"v":1}');
    const { done } = await holdOpen(file, { untilTemp: true });
    write(file, 2);
    await done;
    assert.equal(readFileSync(file, "utf8"), '{"v":2}', "the new contents are in place");
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no temp file left behind");
  });
}

test("writePrivate still fails, and cleans up, when the file stays locked", ON_WINDOWS, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "private-fs-rename-held-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "index.json");
  writeFileSync(file, '{"v":1}');
  // Held until told: well past the retry window, so the write gives up rather than wait for ever.
  const { done, stop } = await holdOpen(file, { untilTemp: false });
  try {
    assert.throws(() => writePrivate(file, '{"v":2}'), (e: NodeJS.ErrnoException) => ["EPERM", "EACCES", "EBUSY"].includes(e.code ?? ""));
  } finally {
    stop();
    await done;
  }
  assert.equal(readFileSync(file, "utf8"), '{"v":1}', "the old contents are untouched");
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "the temp file is removed");
  assert.ok(existsSync(file));
});

test("renameReplacing throws at once for an error a retry can't fix", () => {
  let calls = 0;
  const missing = Object.assign(new Error("no such file"), { code: "ENOENT" });
  assert.throws(() => renameReplacing("a", "b", () => { calls++; throw missing; }), /no such file/);
  assert.equal(calls, 1, "ENOENT is not retried");
});

test("renameReplacing retries a refused rename on Windows only, and gives up after a bounded wait", () => {
  let calls = 0;
  const refused = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  const t0 = Date.now();
  assert.throws(() => renameReplacing("a", "b", () => { calls++; throw refused; }), /not permitted/);
  if (WIN) {
    assert.equal(calls, 11, "the first try and 10 retries");
    assert.ok(Date.now() - t0 < 2000, "about a quarter of a second, not for ever");
  } else {
    assert.equal(calls, 1, "elsewhere a refused rename is a real error: thrown at once");
  }
  let n = 0;
  renameReplacing("a", "b", () => { if (++n < 3 && WIN) throw refused; });
  assert.equal(n, WIN ? 3 : 1, "it succeeds as soon as a try does");
});
