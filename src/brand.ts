/**
 * Which name this process was started under: `trail`, or `graft`, the name it
 * had before.
 *
 * Both names run the same code. `trail` gets the new command layout and says
 * `[trail]`; `graft` keeps every old command, meaning and output byte for byte,
 * because agents, hooks, CI scripts and statusline parsers already read it.
 * Nothing about graft is ever removed — see `graftNotice` for the one line a
 * person typing it sees.
 *
 * The name travels in an environment variable rather than a module variable so
 * that every child this process spawns (the detached update check, a hook's
 * background build) speaks the same name as its parent. Unset means graft: the
 * only things that load `dist/cli.js` without going through `dist/bin/*` are
 * shims and configs an older graft wrote.
 *
 * This file imports nothing heavier than node:fs, because the hooks load it.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export type Brand = "trail" | "graft";

/** Set by `dist/bin/trail.js` and `dist/bin/graft.js` before the CLI loads. */
export const BRAND_ENV = "TRAIL_INVOKED_AS";

/** The npm package each name is published as. Same code, two names. */
export const PACKAGE_FOR: Record<Brand, string> = {
  trail: "@trailhq/trail-code",
  graft: "@nanonets/graft",
};

export function brand(env: NodeJS.ProcessEnv = process.env): Brand {
  return env[BRAND_ENV] === "trail" ? "trail" : "graft";
}

export function setBrand(b: Brand, env: NodeJS.ProcessEnv = process.env): void {
  env[BRAND_ENV] = b;
}

/**
 * `init --pair CODE` is Trail's setup prompt: only Trail's page hands out a pair
 * code, so the person asked for Trail, whatever name ran it. An agent whose
 * install of @trailhq/trail-code failed swaps in the `graft` already on the
 * machine, and an old shim loads dist/cli.js with no name; under graft either
 * would skip the look-back and `.trail/` while the page waits for them.
 */
export function asksForTrail(argv: readonly string[]): boolean {
  return argv.includes("init") && argv.some((a) => a === "--pair" || a.startsWith("--pair="));
}

/** `[trail]` or `[graft]`: the prefix agents and the statusline look for. */
export function tag(env: NodeJS.ProcessEnv = process.env): string {
  return `[${brand(env)}]`;
}

/**
 * The commands whose trail spelling is not just `graft` → `trail`, longest
 * prefix first. `graft check` gave its name to the team check, and `graft
 * stats` became `trail status`.
 */
const RENAMED: ReadonlyArray<readonly [string, string]> = [
  ["graft check", "trail build --check"],
  ["graft stats", "trail status"],
  ["graft", "trail"],
];

/**
 * A command as the running name spells it. Takes the graft spelling, so call
 * sites read the way they always have and graft's output does not change:
 * `cmd("graft ask")` is `graft ask` under graft and `trail ask` under trail.
 */
export function cmd(graftSpelling: string, b: Brand = brand()): string {
  if (b === "graft") return graftSpelling;
  for (const [from, to] of RENAMED) {
    if (graftSpelling === from) return to;
    if (graftSpelling.startsWith(`${from} `)) return `${to}${graftSpelling.slice(from.length)}`;
  }
  return graftSpelling;
}

/**
 * Agent-facing prose and tool names in trail's spelling: `graft_find_code` →
 * `trail_find_code`, and the word graft → trail. A `graft` followed by `/` is
 * the code map's folder and stays, as do `graft-…` names. Under graft, the
 * text comes back unchanged.
 */
export function inBrand(text: string, b: Brand = brand()): string {
  if (b === "graft") return text;
  return text.replace(/\bgraft_(?=[a-z])/g, "trail_").replace(/\bgraft\b(?![/\w-])/g, "trail");
}

/* -------------------------------------------------------------------------- */
/* hooks and the statusline                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `trail init` wired this repo under trail's names: its committed hooks shim,
 * skill or settings say trail. Read from the repo, not the machine, so every
 * teammate's agent speaks the same name whichever command they installed.
 */
export function repoWiredForTrail(dir: string): boolean {
  if (existsSync(join(dir, ".trail", "hook.cjs"))) return true;
  if (existsSync(join(dir, ".claude", "helpers", "trail-hooks.cjs")) || existsSync(join(dir, ".claude", "skills", "trail", "SKILL.md"))) return true;
  try {
    const settings = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    return settings.includes("trail-hooks.cjs") || settings.includes("/.trail/hook.cjs");
  } catch {
    return false;
  }
}

/**
 * The name hooks and the statusline speak in `repo`. They run under whatever
 * shim set the repo up, often one an older graft committed, so no `dist/bin`
 * entry has set a name. They say trail in a repo wired for it, but only when
 * the `trail` command is installed on this machine: a hook that tells the
 * agent to run a command the machine doesn't have costs a failed tool call.
 * A name already set (by the CLI that spawned this) is kept. `wiredElsewhere`
 * also counts a repo whose other agents' files are on trail (hosts/registry.ts's
 * `hostsWiredForTrail`, passed in so this file stays light): Cursor's and
 * Codex's hooks run this same entry in repos with no `.claude` at all.
 */
export function adoptRepoBrand(
  repo: string,
  env: NodeJS.ProcessEnv = process.env,
  wiredElsewhere?: (repo: string) => boolean,
): Brand {
  if (env[BRAND_ENV] !== "trail" && env[BRAND_ENV] !== "graft") {
    const wired = repoWiredForTrail(repo) || Boolean(wiredElsewhere?.(repo));
    setBrand(wired && trailOnPath(env) ? "trail" : "graft", env);
  }
  return brand(env);
}

/* -------------------------------------------------------------------------- */
/* the once-a-day line for people still typing graft                          */
/* -------------------------------------------------------------------------- */

export function noticeStampPath(home: string = homedir()): string {
  return join(home, ".graft", "rename-notice.json");
}

/** Whether a `trail` executable is on PATH. Only checked when the notice is due. */
export function trailOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  return commandOnPath("trail", env);
}

/**
 * A package's own bin folder, which npm puts on PATH only for the command it
 * runs: npx's temporary copy (`~/.npm/_npx/<hash>/node_modules/.bin`) or a
 * project's dependencies. Agents start with the person's own PATH, so a
 * command found only there isn't installed for them.
 */
const PACKAGE_BIN = /[\\/]node_modules[\\/]\.bin[\\/]?$/;

/** Whether an executable called `name` is on PATH: a few stats, no process spawned. */
export function commandOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const names = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || PACKAGE_BIN.test(dir)) continue;
    for (const n of names) {
      try {
        if (statSync(join(dir, n)).isFile()) return true;
      } catch {
        /* not here */
      }
    }
  }
  return false;
}

export interface NoticeInput {
  /** The graft spelling of what just ran, e.g. `graft ask` or `graft build`. */
  ran: string;
  /** stderr is a terminal: a person is watching. */
  tty: boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: number;
}

/**
 * The once-a-day rename notice upstream shows a person typing `graft`
 * ("graft is now trail. this ran trail …" and "run graft upgrade to get the
 * trail command too"). This fork never shows it, to anyone, and writes no
 * stamp: always null. Kept as a function so the call site and an upstream
 * merge that touches it stay visible.
 */
export function graftNotice(_input: NoticeInput): string | null {
  return null;
}

/** The nearest directory at or above `dir` holding a `.git`, or null. */
function gitRootOf(dir: string): string | null {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return null;
  }
}

/**
 * The line a person typing `trail` sees in a repo an older graft wired, while
 * nothing on this machine can reach that wiring; or null.
 *
 * A graft 0.21 or older committed hook shims that look for `@nanonets/graft`
 * alone, and registered a bare `graft mcp` server. On a machine with trail and
 * no graft, the hooks run and do nothing and the server never starts, so the
 * session start that would move the repo to trail never happens. `trail init`
 * in the repo moves it, and so does a session opened under the hooks
 * `trail init` writes to `~/.claude`; this says so to someone who has done
 * neither. Silent once graft is on PATH, since its hooks then move the repo.
 * Never shown to an agent, a pipe or CI, like {@link graftNotice}.
 */
export function strandedRepoNotice(input: { cwd: string; tty: boolean; env?: NodeJS.ProcessEnv }): string | null {
  const env = input.env ?? process.env;
  if (brand(env) !== "trail" || !input.tty) return null;
  if (env.CLAUDECODE !== undefined || env.CI) return null;
  const repo = gitRootOf(input.cwd);
  if (!repo || repoWiredForTrail(repo) || commandOnPath("graft", env)) return null;
  try {
    if (readFileSync(join(repo, ".claude", "helpers", "graft-hooks.cjs"), "utf8").includes(PACKAGE_FOR.trail)) return null;
  } catch {
    return null; // no graft wiring here
  }
  return "· this repo's agent hooks were set up by an older graft and can't find trail. run trail init here once to move the repo over";
}

export function handoverStampPath(home: string = homedir()): string {
  return join(home, ".graft", "trail-handover.json");
}

/**
 * The line upstream has a Claude Code session start hand the agent, at most
 * once a week, on a machine with graft but no trail command ("graft is now
 * Trail-code … tell the user that `graft upgrade` adds it"). This fork never
 * hands it over and writes no stamp: always null. Kept as a function so the
 * call site and an upstream merge that touches it stay visible.
 */
export function trailHandoverLine(_input: { env?: NodeJS.ProcessEnv; home?: string; now?: number } = {}): string | null {
  return null;
}
