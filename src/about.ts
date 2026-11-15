/**
 * `graft about`: where to read about this tool. Two sources: the upstream
 * project's homepage, and the changelog of what this fork changes. The
 * changelog is the fork's homepage (`FORK_HOMEPAGE_URL`, the latest one,
 * published by `npm run changelog:publish`), and a copy of it ships in the npm
 * package and the offline kit (`docs/changelog.html`, as of that build, readable
 * offline), which `graft about fork` opens; the printed overview names only the
 * homepage. It also lists the fork's issue tracker, where bugs in this fork are
 * reported.
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

/** The fork's public distribution repository: its homepage and its releases live there. */
export const FORK_REPO_URL = "https://github-ct.int.automotive-wan.com/suciui/Graft";

/** The fork's source repository: its issue tracker lives there. */
export const FORK_SOURCE_URL = "https://github-ct.int.automotive-wan.com/suciui/graft";

/**
 * The fork's homepage: the latest fork changelog, served by GitHub Pages from the
 * repository's gh-pages branch (`scripts/publish-changelog.mjs`), and the
 * repository's Website link (`graft about web`).
 */
export const FORK_HOMEPAGE_URL = "https://github-ct.int.automotive-wan.com/pages/suciui/Graft/";

/** Every published offline installer kit of this fork, the latest first (`scripts/publish-release.mjs`). */
export const FORK_RELEASES_URL = `${FORK_REPO_URL}/releases`;

/** Where users of this fork report bugs and request features (`graft issues`, listed by `graft about`). */
export const ISSUES_URL = `${FORK_SOURCE_URL}/issues`;

/** The fork changelog, relative to the package (or repo) root. */
export const CHANGELOG_RELATIVE = join("docs", "changelog.html");

/** What `graft about <target>` accepts: the upstream homepage, the changelog copy of this build, the fork homepage. */
export const ABOUT_TARGETS = ["home", "fork", "web"] as const;
export type AboutTarget = (typeof ABOUT_TARGETS)[number];

/** Narrows a typed target (case-insensitive), or null when it is not one. */
export function parseAboutTarget(raw: string | undefined): AboutTarget | null {
  const t = (raw ?? "").trim().toLowerCase();
  return (ABOUT_TARGETS as readonly string[]).includes(t) ? (t as AboutTarget) : null;
}

/**
 * The fork changelog next to the running package: `<root>/docs/changelog.html`,
 * or `<root>/changelog.html` as the offline kit lays it out. Null when
 * neither exists (an install made before the changelog shipped).
 */
export function findChangelog(packageJsonPath: string, exists: (p: string) => boolean = existsSync): string | null {
  const root = dirname(packageJsonPath);
  for (const c of [join(root, CHANGELOG_RELATIVE), join(root, "changelog.html")]) {
    if (exists(c)) return c;
  }
  return null;
}

/** The `file:///` address of a local file, as a browser takes it. */
export function fileUri(path: string): string {
  return pathToFileURL(path).href;
}

/** The text `graft about` prints. */
export function formatAbout(name: string, version: string, changelog: string | null): string {
  const lines = [
    `${name} ${version}: a context graph of your repo for AI coding agents.`,
    `It indexes the code into small linked notes with exact file:line spans, so an agent finds`,
    `the right code with fewer tool calls and fewer tokens than grepping and reading whole files.`,
    "",
    "Project homepage (upstream):",
    `  ${PROJECT_URL}`,
    "",
    "Fork homepage: the changelog of the changes in this fork (not in upstream), latest:",
    `  ${FORK_HOMEPAGE_URL}`,
    "",
    "Download this fork's Windows offline installer kit, the latest or any published build:",
    `  ${FORK_RELEASES_URL}`,
    "",
    "Report issues with this fork (bugs, feature requests):",
    `  ${ISSUES_URL}`,
    "",
    "Open one in your browser:",
    `  ${name} about home    the project homepage (upstream)`,
    `  ${name} about web     the fork homepage (latest changelog)`,
    `  ${name} about fork    the changelog of this build${changelog ? "" : " (falls back to the fork homepage)"}`,
    `  ${name} issues        the fork's issue tracker`,
    "",
    "Nothing is sent: these commands only open a page in your browser.",
  ];
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
    // windowsHide stays off: the opener shows a window the person asked for, and `detached` already
    // starts it without a console (test/windows-hide.test.ts holds every other spawn to windowsHide: true).
    const child = spawn(opener, [path], { stdio: "ignore", detached: true, windowsHide: false });
    child.on("error", () => {
      /* the printed path is the fallback */
    });
    child.unref();
  } catch {
    /* the printed path is the fallback */
  }
}
