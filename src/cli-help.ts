/**
 * Help text that answers "how do I combine these?": global options configure a
 * command and never run anything on their own, and the LLM options only matter
 * to `build --deep`. Without this, `graft --model x` printed the whole help as
 * an error, which reads like a broken flag rather than a missing command.
 */

/** The examples block appended to `<name> --help`. `commandHelpRow` is off where
 * the caller already prints its own `<command> --help` line (trail). */
export function helpExamples(name: string, commandHelpRow = true): string {
  const rows: [string, string][] = [
    [`${name} build`, "structural graph + cards — $0, no API key"],
    [`${name} --model <id> build --deep`, "add the LLM summaries, with a chosen model"],
    [`${name} build --deep --model <id>`, "the same: global options may also follow the command"],
    [`${name} ask "where is auth handled" --source`, "ranked answer with the code inlined"],
    [`${name} staleness`, "is a `build --deep` worth running yet?"],
    ...(commandHelpRow ? [[`${name} <command> --help`, "every option of one command"] as [string, string]] : []),
  ];
  const width = Math.max(...rows.map(([c]) => c.length)) + 3;
  return [
    "",
    "Global options configure the command they are given with; on their own they run nothing.",
    "",
    "Examples:",
    ...rows.map(([c, what]) => `  $ ${c.padEnd(width)}${what}`),
  ].join("\n");
}

/**
 * When `args` (argv after the script) hold only global options — no command —
 * the short explanation to print instead of the full help; otherwise null, and
 * the parser handles it as usual (a command, an unknown command or option,
 * `--help`/`--version`, a missing option value, or no arguments at all).
 *
 * `valueOptions` are the global options that take a value (`--model`, `-m`, …),
 * read from the program itself so this can't drift from what is registered.
 */
export function missingCommandHint(args: string[], valueOptions: readonly string[], name: string): string | null {
  if (args.length === 0) return null;
  const given: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueOptions.includes(a)) {
      if (i + 1 >= args.length) return null;
      given.push(a, quoteArg(args[++i]));
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0 && valueOptions.includes(a.slice(0, eq))) {
      given.push(a);
      continue;
    }
    return null;
  }
  const llm = given.some((g) => /^--(model|provider|api-key|base-url)\b/.test(g));
  const shown = given.map((g, i) => (given[i - 1] === "--api-key" ? "<key>" : g.startsWith("--api-key=") ? "--api-key=<key>" : g)).join(" ");
  const command = llm ? "build --deep" : "<command>";
  return [
    `error: no command given — ${shown} only configures a command; on its own it runs nothing.`,
    "",
    `  ${name} ${shown} ${command}`,
    ...(llm ? ["", "The LLM options (--provider, --model, --api-key, --base-url) are used by `build --deep`."] : []),
    "",
    `Run \`${name} --help\` for every command, or \`${name} <command> --help\` for one command's options.`,
  ].join("\n");
}

const quoteArg = (v: string): string => (/[\s"]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v);
