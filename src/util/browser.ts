import { spawn } from "node:child_process";

/** Open `url` in the default browser. Best-effort: the printed URL is the fallback. */
export function openBrowser(url: string): void {
  if (process.env.GRAFT_NO_BROWSER) return;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    // windowsHide stays off: the browser is a window the person asked for, and `detached` already starts
    // cmd's `start` without a console (test/windows-hide.test.ts holds every other spawn to windowsHide: true).
    spawn(opener, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32", windowsHide: false }).unref();
  } catch {
    /* the printed URL is the fallback */
  }
}
