/**
 * Regenerates the fork changelog (docs/changelog.html) from the fork's commit messages when a
 * Kilo session goes idle after a prompt that changed the repository: a new commit, a changelog
 * note (refs/notes/changelog), or a change in the working tree. It runs `node scripts/changelog.mjs --hook`, which writes the page only
 * when its content changes and never fails the session. Nothing leaves the machine.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "@kilocode/plugin";

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
}

/** HEAD, the changelog notes and the working-tree status: changes when a prompt commits, adds a note or edits files. */
async function repoState(cwd: string): Promise<string> {
  const [head, notes, status] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], cwd),
    run("git", ["rev-parse", "-q", "--verify", "refs/notes/changelog"], cwd),
    run("git", ["status", "--porcelain"], cwd),
  ]);
  return `${head}\n${notes}\n${status}`;
}

export const ForkChangelog: Plugin = async ({ worktree, directory }) => {
  const root = worktree || directory;
  const script = join(root, "scripts", "changelog.mjs");
  let last: string | null = null;
  let running = false;
  return {
    event: async ({ event }) => {
      const e = event as { type: string; properties?: { status?: { type?: string } } };
      const idle = e.type === "session.idle" || (e.type === "session.status" && e.properties?.status?.type === "idle");
      if (!idle || running || !existsSync(script)) return;
      running = true;
      try {
        const before = await repoState(root);
        if (before === last) return;
        await run("node", [script, "--hook"], root);
        // The state after the run, so the page it just wrote does not trigger another run
        last = await repoState(root);
      } finally {
        running = false;
      }
    },
  };
};
