// Prints a one-line nudge after install. Never fails the install.
try {
  if (process.env.CI) process.exit(0);
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = process.env.INIT_CWD || process.cwd();
  const initialized =
    existsSync(join(dir, '.claude', 'helpers', 'graft-statusline.cjs')) ||
    existsSync(join(dir, '.kilo', 'skills', 'graft', 'SKILL.md'));
  if (initialized) process.exit(0);
  console.log('\n  Graft installed. Run `npx graft init` to connect it to Claude Code, Kilo Code, and your other coding agents.\n');
} catch {
  /* never fail an install */
}
