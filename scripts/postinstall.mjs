// Prints a one-line nudge after install. Records nothing: telemetry is
// permanently disabled. Never fails the install.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// The same code ships as @trailhq/trail-code (the `trail` command) and as
// @nanonets/graft (`graft`, its old name). The nudge says which one this is.
let pkgName = '@nanonets/graft';
try {
  pkgName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name ?? pkgName;
} catch { /* the graft defaults */ }
const isTrail = pkgName === '@trailhq/trail-code';
if (isTrail) process.env.TRAIL_INVOKED_AS = 'trail';

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
