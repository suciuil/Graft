/**
 * Publishes the fork changelog (docs/changelog.html) as the homepage of the fork's
 * public repository: it becomes index.html on the repository's gh-pages branch,
 * which GitHub Pages serves at FORK_HOMEPAGE_URL (src/about.ts), the address
 * `graft about` prints and `graft about web` opens.
 *
 * Maintainer tool: `npm run pack:bundle` runs it after publishing a kit's release
 * (scripts/publish-release.mjs), and `npm run changelog:publish` runs it by hand;
 * graft itself never runs it. It regenerates the changelog first, so the page lists
 * every commit made so far, then pushes only when the page changed. Nothing but the
 * page and an empty .nojekyll (serve the file as is) goes to that branch.
 *
 *   node scripts/publish-changelog.mjs [--repo <git url>] [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The fork's public repository, where its releases, issues and homepage live. */
export const FORK_REPO = "https://github-ct.int.automotive-wan.com/suciui/Graft.git";
const BRANCH = "gh-pages";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The GitHub Pages address of a repository on a GitHub Enterprise Server without Pages subdomains. */
export function pagesUrl(repo) {
  const u = new URL(repo.replace(/\.git$/, ""));
  const [owner, name] = u.pathname.split("/").filter(Boolean);
  return `${u.origin}/pages/${owner}/${name}/`;
}

function git(args, cwd, opts = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: opts.quiet ? "pipe" : ["ignore", "pipe", "inherit"], windowsHide: true });
}

/**
 * Regenerates docs/changelog.html and pushes it to the gh-pages branch of `repo` when it
 * differs from the published page. Returns the homepage address and whether it was pushed.
 */
export function publishChangelog({ repo = FORK_REPO, dryRun = false, log = console.log } = {}) {
  execFileSync(process.execPath, [join(repoRoot, "scripts", "changelog.mjs"), "--quiet"], { cwd: repoRoot, stdio: "inherit", windowsHide: true });
  const url = pagesUrl(repo);
  const work = mkdtempSync(join(tmpdir(), "graft-pages-"));
  try {
    try {
      git(["clone", "--quiet", "--depth", "1", "--branch", BRANCH, repo, work], repoRoot, { quiet: true });
    } catch {
      // First publication: the branch does not exist yet.
      git(["init", "--quiet"], work);
      git(["checkout", "--quiet", "-b", BRANCH], work);
      git(["remote", "add", "origin", repo], work);
    }
    // Stored with LF as generated, whatever core.autocrlf says.
    git(["config", "core.autocrlf", "false"], work);
    copyFileSync(join(repoRoot, "docs", "changelog.html"), join(work, "index.html"));
    writeFileSync(join(work, ".nojekyll"), "");
    git(["add", "--all"], work);
    if (git(["status", "--porcelain"], work).trim() === "") {
      log(`✓ the homepage already shows the current changelog: ${url}`);
      return { url, pushed: false };
    }
    const head = git(["rev-parse", "--short", "HEAD"], repoRoot).trim();
    git(["commit", "--quiet", "-m", `Publish the fork changelog (from ${head})`], work);
    if (dryRun) {
      log(`Dry run: would push the changelog to ${repo} (${BRANCH}), served at ${url}`);
      return { url, pushed: false };
    }
    git(["push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH}`], work, { quiet: true });
    log(`✓ published the changelog on the homepage: ${url}`);
    return { url, pushed: true };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--repo");
  publishChangelog({ repo: at >= 0 ? argv[at + 1] : FORK_REPO, dryRun: argv.includes("--dry-run") });
}
