/**
 * `graft about`: where to read about this tool. Two sources: the upstream
 * project's homepage, and the report of what this fork changes
 * (`docs/fork-report.html`, shipped in the npm package and the offline kit).
 *
 * Nothing is sent: the command prints addresses and, when asked, opens one
 * in the local browser.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** The upstream project's homepage. */
export const PROJECT_URL = "https://github.com/trailhq/Trail-Code";

/** The fork report, relative to the package (or repo) root. */
export const FORK_REPORT_RELATIVE = join("docs", "fork-report.html");

/** What `graft about <target>` accepts. */
export const ABOUT_TARGETS = ["home", "fork"] as const;
export type AboutTarget = (typeof ABOUT_TARGETS)[number];

/** Narrows a typed target (case-insensitive), or null when it is not one. */
export function parseAboutTarget(raw: string | undefined): AboutTarget | null {
  const t = (raw ?? "").trim().toLowerCase();
  return (ABOUT_TARGETS as readonly string[]).includes(t) ? (t as AboutTarget) : null;
}

/**
 * The fork report next to the running package: `<root>/docs/fork-report.html`,
 * or `<root>/fork-report.html` as the offline kit lays it out. Null when
 * neither exists (an install made before the report shipped).
 */
export function findForkReport(packageJsonPath: string, exists: (p: string) => boolean = existsSync): string | null {
  const root = dirname(packageJsonPath);
  for (const c of [join(root, FORK_REPORT_RELATIVE), join(root, "fork-report.html")]) {
    if (exists(c)) return c;
  }
  return null;
}

/** The `file:///` address of a local file, as a browser takes it. */
export function fileUri(path: string): string {
  return pathToFileURL(path).href;
}

/** The text `graft about` prints. */
export function formatAbout(name: string, version: string, report: string | null): string {
  const lines = [
    `${name} ${version}: a context graph of your repo for AI coding agents.`,
    `It indexes the code into small linked notes with exact file:line spans, so an agent finds`,
    `the right code with fewer tool calls and fewer tokens than grepping and reading whole files.`,
    "",
    "Project homepage (upstream):",
    `  ${PROJECT_URL}`,
    "",
    "Changes in this fork (not in upstream):",
  ];
  if (report) lines.push(`  ${report}`, `  ${fileUri(report)}`);
  else lines.push(`  not found in this installation (expected ${FORK_REPORT_RELATIVE} next to package.json)`);
  lines.push(
    "",
    "Open one in your browser:",
    `  ${name} about home    the project homepage`,
    `  ${name} about fork    the fork report`,
    "",
    "Nothing is sent: these commands only open a page in your browser.",
  );
  return lines.join("\n");
}

/**
 * Open a local file with its default application (the browser, for HTML).
 * Unlike `openBrowser`, no shell is involved, so paths with spaces and
 * characters cmd.exe treats specially open as typed. Best-effort: the printed
 * path is the fallback.
 */
export function openLocalFile(path: string): void {
  if (process.env.GRAFT_NO_BROWSER) return;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  try {
    const child = spawn(opener, [path], { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* the printed path is the fallback */
    });
    child.unref();
  } catch {
    /* the printed path is the fallback */
  }
}
