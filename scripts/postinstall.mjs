// Points the user's npm at this fork's registry, mints the local install id,
// then prints a one-line nudge after install. Sends nothing: telemetry is
// permanently disabled. Never fails the install.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// The same code ships as @trailhq/trail-code (the `trail` command) and as
// @nanonets/graft (`graft`, its old name). The nudge says which one this is.
let pkg = {};
try {
  pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
} catch { /* the graft defaults */ }
const pkgName = pkg.name ?? '@nanonets/graft';
const isTrail = pkgName === '@trailhq/trail-code';
if (isTrail) process.env.TRAIL_INVOKED_AS = 'trail';

// This fork: every scope the code ships under resolves from the fork's registry
// in the user's .npmrc, so a plain `npm i -g` or `npx` never pulls the official package.
try {
  const registry = pkg.publishConfig?.registry;
  if (registry) {
    const file = process.env.npm_config_userconfig || process.env.NPM_CONFIG_USERCONFIG || join(homedir(), '.npmrc');
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
    const scopes = new Set([pkgName, '@nanonets/graft', '@trailhq/trail-code'].filter((n) => n.startsWith('@')).map((n) => n.split('/')[0]));
    let changed = false;
    for (const scope of scopes) {
      const want = `${scope}:registry=${registry}`;
      const at = lines.findIndex((l) => new RegExp(`^\\s*${scope}:registry\\s*=`, 'i').test(l));
      if (at === -1) lines.push(want);
      else if (lines[at].trim() !== want) lines[at] = want;
      else continue;
      changed = true;
    }
    if (changed) writeFileSync(file, lines.join(eol) + eol, { mode: 0o600 });
  }
} catch {
  /* never fail an install */
}

// The machine's install id (a random UUID in ~/.graft/telemetry.json), minted
// now so it exists from the first command on. Local only: it leaves the machine
// solely in the opt-in savings report (`graft savings-report enable`). An
// install that skips scripts (`--ignore-scripts`, the offline bundle) mints it
// on first use instead.
try {
  const identity = join(root, 'dist', 'telemetry', 'identity.js');
  if (existsSync(identity)) {
    const { installId } = await import(pathToFileURL(identity).href);
    installId();
  }
} catch {
  /* never fail an install */
}

try {
  if (process.env.CI) process.exit(0);
  const dir = process.env.INIT_CWD || process.cwd();
  if (existsSync(join(dir, '.claude', 'helpers', 'graft-statusline.cjs'))) process.exit(0);
  if (existsSync(join(dir, '.claude', 'helpers', 'trail-statusline.cjs'))) process.exit(0);
  console.log(
    isTrail
      ? '\n  Trail installed. Run `trail init` in a repo to wire it into your agents.\n'
      : '\n  Graft installed. Run `npx graft init` to enable the Claude Code integration (statusline + hooks + auto-sync).\n',
  );
} catch {
  /* never fail an install */
}
