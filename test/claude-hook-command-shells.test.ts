/**
 * The repo-level hook command, run through every shell a host might hand it to.
 *
 * Regression test for "Denied by preToolUse hook from "repo settings" (hook
 * errored)" in GitHub Copilot on Windows. Copilot reads `.claude/settings.json`
 * too, ignores its matchers, and runs each command under cmd.exe / PowerShell.
 * The old command, `node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/…"`, is bash
 * syntax: cmd leaves it literal and PowerShell turns it into `D:\.claude\…`, node
 * exits 1, and Copilot denies every tool call. The command must run the shim with
 * the right argv under each shell, and stay silent when the shim is missing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoShimCmd } from '../src/claude/settings-merge.js';
import { tmpRepo } from './helpers.js';

interface Shell { name: string; run: (cmd: string) => [string, string[]] }

function onPath(exe: string, args: string[]): boolean {
  const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 20_000 });
  return !r.error && r.status === 0;
}

/** Every shell available on this machine, invoked the way a host invokes a hook. */
function shells(): Shell[] {
  const out: Shell[] = [];
  if (process.platform === 'win32') {
    out.push({ name: 'cmd.exe', run: (c) => ['cmd.exe', ['/d', '/s', '/c', `"${c}"`]] });
    out.push({ name: 'powershell', run: (c) => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', c]] });
    if (onPath('pwsh', ['-NoProfile', '-Command', 'exit 0'])) {
      out.push({ name: 'pwsh', run: (c) => ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', c]] });
    }
    // Claude Code on Windows runs hooks under Git Bash, which is rarely on PATH.
    const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'bash'].find((b) => onPath(b, ['-c', 'exit 0']));
    if (gitBash) out.push({ name: 'bash', run: (c) => [gitBash, ['-c', c]] });
  } else {
    out.push({ name: 'sh', run: (c) => ['/bin/sh', ['-c', c]] });
    if (onPath('bash', ['-c', 'exit 0'])) out.push({ name: 'bash', run: (c) => ['bash', ['-c', c]] });
    if (onPath('pwsh', ['-NoProfile', '-Command', 'exit 0'])) {
      out.push({ name: 'pwsh', run: (c) => ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', c]] });
    }
  }
  return out;
}

/** A project whose shim records the argv it was given. Path has a space and a `!`. */
function project(tag: string): { dir: string; marker: string } {
  const dir = join(tmpRepo(tag), 'my !proj');
  const helpers = join(dir, '.claude', 'helpers');
  mkdirSync(helpers, { recursive: true });
  const marker = join(dir, 'argv.json');
  writeFileSync(
    join(helpers, 'graft-hooks.cjs'),
    `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ shim: process.argv[1], arg: process.argv[2] }));\n`,
  );
  return { dir, marker };
}

for (const sh of shells()) {
  for (const via of ['CLAUDE_PROJECT_DIR', 'cwd'] as const) {
    test(`${sh.name}: runs the repo shim with its argv (project found via ${via})`, () => {
      const { dir, marker } = project(`shell-${sh.name}-${via}`);
      const cmd = repoShimCmd('graft-hooks.cjs', 'pre-tool');
      const [exe, args] = sh.run(cmd);
      const env = { ...process.env };
      if (via === 'CLAUDE_PROJECT_DIR') env.CLAUDE_PROJECT_DIR = dir; else delete env.CLAUDE_PROJECT_DIR;
      const res = spawnSync(exe, args, {
        encoding: 'utf8', timeout: 30_000, env,
        cwd: via === 'cwd' ? dir : tmpRepo(`elsewhere-${sh.name}`),
        windowsVerbatimArguments: exe === 'cmd.exe',
      });
      assert.equal(res.status, 0, `${sh.name} exited ${res.status}: ${res.stderr}`);
      assert.ok(existsSync(marker), `shim did not run under ${sh.name}: ${res.stderr}`);
      const got = JSON.parse(readFileSync(marker, 'utf8'));
      assert.equal(got.arg, 'pre-tool');
      assert.equal(got.shim, join(dir, '.claude', 'helpers', 'graft-hooks.cjs'));
    });
  }

  test(`${sh.name}: a missing shim is a silent exit 0, never an error`, () => {
    const { dir } = project(`shell-missing-${sh.name}`);
    rmSync(join(dir, '.claude'), { recursive: true, force: true });
    const cmd = repoShimCmd('graft-hooks.cjs', 'pre-tool');
    const [exe, args] = sh.run(cmd);
    const res = spawnSync(exe, args, {
      encoding: 'utf8', timeout: 30_000, cwd: dir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      windowsVerbatimArguments: exe === 'cmd.exe',
    });
    assert.equal(res.status, 0, `${sh.name} exited ${res.status}: ${res.stderr}`);
    assert.equal(res.stderr.trim(), '');
  });
}

test('the command carries nothing a shell would expand or split', () => {
  const cmd = repoShimCmd('graft-hooks.cjs', 'pre-tool');
  const script = cmd.slice(cmd.indexOf('"') + 1, cmd.lastIndexOf('"'));
  assert.doesNotMatch(script, /[\s"$%!`&<>^]/, `script: ${script}`);
  assert.doesNotMatch(cmd, /CLAUDE_PROJECT_DIR:-/, 'no bash-only default expansion');
});
