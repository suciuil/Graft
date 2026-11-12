/**
 * EB tresos Studio code templates: C/C++ sources (and `.m` macro files) with
 * generator markup in `[! ... !]` brackets. AUTOSAR stacks carry them by the
 * thousand under `generate/` folders, named like the files they produce
 * (`Gpt_PBcfg.c`, `Can_Cfg.h`). The C grammar reads the markup as code and fails
 * on nearly every line of such a file.
 *
 * {@link tresosViews} turns a template into C the grammar can read, keeping every
 * line, column and offset where it was:
 *
 * - directives (`[!IF "…"!]`, `[!LOOP!]`, `[!VAR "x" = "…"!]`, `[!INDENT!]`, …)
 *   and comments (`[!// …` to the end of the line, `[!/* … *\/!]`) become spaces;
 * - an output expression (`[!"$Name"!]`) becomes one identifier of the same
 *   length (`__Name__`), so `Dma_[!"$Ch"!]_Cfg`, `x[[!"num:i($n)"!]]` and
 *   `#define N [!"$n"!]U` stay valid C; so does a `[!CALL "M"!]` written inside
 *   a line of code;
 * - text the generator does not output becomes spaces: `[!NOCODE!]` regions
 *   (outside the `[!CODE!]` regions inside them) and the bodies of `[!MACRO!]`,
 *   `[!VAR!]`, `[!ERROR!]`, `[!WARNING!]`, `[!INFO!]` and `[!ASSERT!]` blocks;
 * - where the generator joins text the view joins it too: markup inside a name
 *   becomes `_`, and a preprocessor directive runs on over lines whose break
 *   the generator swallows (see {@link continueMacros});
 * - a comma right after `{`, `(`, `[` or another comma, left by a separator
 *   output before all but the first element, becomes a space.
 *
 * Two views come back: one keeping every branch of each `[!IF!]` chain, one only
 * its first. The extractor parses both and keeps the better tree, as it does with
 * the branch views of `#if` chains.
 */

/** A file is a template when it carries at least one tresos directive or
 * output expression; a stray `[!` in C code (`a[!b]`) is not one. */
const TRESOS_MARKER =
  /\[!(?:CODE|NOCODE|IF|LOOP|VAR|SELECT|CALL|INCLUDE|MACRO|FOR|INDENT|AUTOSPACING)\b|\[!\/\/|\[!\/\*|\[!"/;

export function isTresosTemplate(source: string): boolean {
  return source.includes("[!") && TRESOS_MARKER.test(source);
}

interface Directive {
  at: number;
  end: number;
  kind: "value" | "comment" | "directive";
  /** The directive's keyword, upper-cased (`IF`, `ENDLOOP`); empty otherwise. */
  word: string;
}

/** Every `[! … !]` in `source`, in order. */
function directives(source: string): Directive[] {
  const out: Directive[] = [];
  let i = 0;
  for (;;) {
    const at = source.indexOf("[!", i);
    if (at < 0) break;
    let end: number;
    if (source.startsWith("[!//", at)) {
      // A line comment: up to the end of the line, which stays.
      end = source.indexOf("\n", at);
      if (end < 0) end = source.length;
      else if (source[end - 1] === "\r") end--;
      out.push({ at, end, kind: "comment", word: "" });
      i = end;
      continue;
    }
    if (source.startsWith("[!/*", at)) {
      const close = source.indexOf("*/!]", at + 4);
      end = close < 0 ? source.length : close + 4;
      out.push({ at, end, kind: "comment", word: "" });
      i = end;
      continue;
    }
    // Up to the closing `!]`, stepping over the double-quoted XPath arguments.
    end = -1;
    let j = at + 2;
    while (j < source.length) {
      const ch = source[j];
      if (ch === '"') {
        const quote = source.indexOf('"', j + 1);
        if (quote < 0) break;
        j = quote + 1;
        continue;
      }
      if (ch === "!" && source[j + 1] === "]") {
        end = j + 2;
        break;
      }
      j++;
    }
    if (end < 0) {
      const close = source.indexOf("!]", at + 2);
      end = close < 0 ? source.length : close + 2;
    }
    const body = source.slice(at + 2, end - 2);
    if (body.startsWith('"')) out.push({ at, end, kind: "value", word: "" });
    else out.push({ at, end, kind: "directive", word: (/^\s*([A-Za-z]+)/.exec(body)?.[1] ?? "").toUpperCase() });
    i = end;
  }
  return out;
}

/** Directives whose text up to the matching `END…` is not output as code
 * (`CODE` turns output back on). Each also has a one-line form with no `END…`
 * (`[!ERROR "msg"!]`, `[!VAR "x" = "1"!]`), so only a paired one opens a block. */
const BLOCKS = new Set(["CODE", "NOCODE", "MACRO", "VAR", "ERROR", "WARNING", "INFO", "ASSERT"]);

/** The two views of a template (see the module comment): every `[!IF!]` branch
 * kept, then only the first branch of each chain. */
export function tresosViews(source: string): string[] {
  const list = directives(source);
  // Pair each block opener with its END, innermost first; an opener left over
  // is the one-line form.
  const paired = new Set<number>();
  const open = new Map<string, number[]>();
  list.forEach((d, k) => {
    if (d.kind !== "directive") return;
    if (BLOCKS.has(d.word)) {
      const stack = open.get(d.word) ?? [];
      stack.push(k);
      open.set(d.word, stack);
    } else if (d.word.startsWith("END") && BLOCKS.has(d.word.slice(3))) {
      const opener = open.get(d.word.slice(3))?.pop();
      if (opener !== undefined) {
        paired.add(opener);
        paired.add(k);
      }
    }
  });
  return [view(source, list, paired, false), view(source, list, paired, true)];
}

function view(source: string, list: Directive[], paired: Set<number>, firstBranch: boolean): string {
  const chars = source.split("");
  // Line breaks the generator does not output: inside markup or text it skips,
  // and the one ending a `[!//` comment.
  const swallowed = new Set<number>();
  // Columns that output nothing, so the text on either side of them is joined.
  const gone = new Uint8Array(chars.length);
  const blank = (from: number, to: number, joins = true): void => {
    for (let x = from; x < to; x++) {
      if (chars[x] === "\n") swallowed.add(x);
      else if (chars[x] !== "\r") {
        chars[x] = " ";
        if (joins) gone[x] = 1;
      }
    }
  };
  const identifier = (from: number, to: number): void => {
    for (let x = from; x < to; x++) if (chars[x] !== "\n" && chars[x] !== "\r" && !/\w/.test(chars[x])) chars[x] = "_";
  };
  // Open blocks; `on` is whether their text is output. `[!CODE!]` turns output
  // back on inside `[!NOCODE!]`, not inside a message or macro body.
  const output: { word: string; on: boolean }[] = [{ word: "", on: true }];
  const skip: boolean[] = [];
  const emitting = (): boolean => output[output.length - 1].on && !skip.includes(true);
  let pos = 0;
  list.forEach((d, k) => {
    const code = emitting();
    if (!code) blank(pos, d.at);
    pos = d.end;
    if (d.kind === "value") {
      if (!code) return blank(d.at, d.end);
      identifier(d.at, d.end);
      if (outputsTrailingComma(source.slice(d.at, d.end))) chars[d.end - 1] = ",";
      return;
    }
    if (d.kind === "comment") {
      if (source.startsWith("[!//", d.at)) {
        const nl = source.indexOf("\n", d.end);
        if (nl >= 0) swallowed.add(nl);
      }
      return blank(d.at, d.end);
    }
    if (d.word === "CALL" && code && inLineOfCode(source, d)) return identifier(d.at, d.end);
    // In the view keeping every branch, `[!ELSE!]` separates alternatives the
    // generator never joins.
    blank(d.at, d.end, firstBranch || (d.word !== "ELSE" && d.word !== "ELSEIF"));
    if (paired.has(k)) {
      if (BLOCKS.has(d.word)) {
        const on = d.word === "CODE" && !output.some((b) => SILENT.has(b.word));
        output.push({ word: d.word, on });
      } else if (output.length > 1) output.pop();
    } else if (firstBranch) {
      if (d.word === "IF") skip.push(false);
      else if ((d.word === "ELSE" || d.word === "ELSEIF") && skip.length > 0) skip[skip.length - 1] = true;
      else if (d.word === "ENDIF") skip.pop();
    }
  });
  if (!emitting()) blank(pos, source.length);
  joinIdentifiers(chars, gone);
  continueMacros(chars, swallowed, gone);
  dropStrayCommas(chars);
  return chars.join("");
}

/** Functions whose result ends as their last argument does. */
const KEEPS_LAST_ARGUMENT = new Set(["concat", "node:when", "string", "normalize-space"]);

/**
 * Whether an output expression ends its text with a comma:
 * `[!"node:when(c, concat('&Fn_', $n, ','), 'NULL_PTR,')"!]` outputs an
 * initializer element with its comma, as its last string ends. A `','` passed
 * to another function (`substring-before($v, ',')`) is a delimiter, not output.
 */
function outputsTrailingComma(text: string): boolean {
  const m = /,(['"])\s*\)*\s*"!\]$/.exec(text);
  if (!m) return false;
  // Walk out from the last string through the calls it is the last argument of.
  let x = text.lastIndexOf(m[1], m.index) - 1;
  let depth = 0;
  for (; x >= 0; x--) {
    const ch = text[x];
    if (ch === "'" || ch === '"') x = text.lastIndexOf(ch, x - 1);
    else if (ch === ")") depth++;
    else if (ch === "(" && depth > 0) depth--;
    else if (ch === "(") {
      const name = /[\w:.-]*$/.exec(text.slice(0, x))?.[0] ?? "";
      if (!KEEPS_LAST_ARGUMENT.has(name)) return false;
    }
  }
  return true;
}

/** Blocks whose text is never output where it stands, `[!CODE!]` or not. */
const SILENT = new Set(["MACRO", "VAR", "ERROR", "WARNING", "INFO", "ASSERT"]);

/**
 * Markup inside a name outputs nothing, so the generator joins the parts:
 * `kConfig[!"$Text"!][!IF "$v"!]_[!"$Var"!][!ENDIF!][0]` is one identifier.
 * A run of such columns between two word characters on a line becomes `_`.
 */
function joinIdentifiers(chars: string[], gone: Uint8Array): void {
  for (let x = 1; x < chars.length; x++) {
    if (!gone[x] || gone[x - 1] || !/\w/.test(chars[x - 1])) continue;
    let end = x;
    while (end < chars.length && gone[end]) end++;
    if (end < chars.length && /\w/.test(chars[end])) for (let y = x; y < end; y++) chars[y] = "_";
    x = end;
  }
}

/**
 * A separator the template puts before every element but the first
 * (`[!IF "$i > 0"!],[!ENDIF!]`) is output in a view before the first one as
 * well. A comma right after `{`, `(`, `[` or another comma cannot be C, so it
 * goes.
 */
function dropStrayCommas(chars: string[]): void {
  let last = "";
  for (let x = 0; x < chars.length; x++) {
    const ch = chars[x];
    if (ch === "/" && chars[x + 1] === "*") {
      const close = chars.indexOf("*", x + 2);
      let y = close;
      while (y >= 0 && chars[y + 1] !== "/") y = chars.indexOf("*", y + 1);
      x = y < 0 ? chars.length : y + 1;
      continue;
    }
    if (ch === "/" && chars[x + 1] === "/") {
      while (x < chars.length && chars[x] !== "\n") x++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let y = x + 1;
      while (y < chars.length && chars[y] !== ch && chars[y] !== "\n") y += chars[y] === "\\" ? 2 : 1;
      x = y;
      last = ch;
      continue;
    }
    if (/\s/.test(ch) || ch === "\\") continue;
    if (ch === "," && (last === "{" || last === "(" || last === "[" || last === ",")) {
      chars[x] = " ";
      continue;
    }
    last = ch;
  }
}

/**
 * The generator joins a line whose break it swallows to the next one, so a
 * preprocessor directive runs on over markup-only lines (`[!LOOP …!][!//`) and
 * skipped branches: `#define ON [!//` + `[!IF "x"!](1)[!ELSE!](0)[!ENDIF!]`.
 * The view keeps every line, so such a line of a directive gets a `\` in its
 * last blank column instead. So does a line of markup only (`[!ENDLOOP!]`): in
 * `[!AUTOSPACING!]` mode its break is not output either, and a template that
 * continues a `#define` over it means it to go on.
 */
function continueMacros(chars: string[], swallowed: Set<number>, gone: Uint8Array): void {
  let continued = false;
  for (let start = 0; start < chars.length; ) {
    let nl = chars.indexOf("\n", start);
    if (nl < 0) nl = chars.length;
    const last = nl > start && chars[nl - 1] === "\r" ? nl - 2 : nl - 1;
    let directive = continued;
    if (!directive) {
      let x = start;
      while (x <= last && (chars[x] === " " || chars[x] === "\t")) x++;
      directive = chars[x] === "#";
    }
    let markupOnly = continued;
    for (let x = start; markupOnly && x <= last; x++) if (chars[x] !== " " && chars[x] !== "\t") markupOnly = false;
    if (markupOnly) markupOnly = gone.subarray(start, last + 1).includes(1);
    // A directive on the next line is not part of this one (`*/!]` + `#endif`).
    let next = nl + 1;
    while (next < chars.length && (chars[next] === " " || chars[next] === "\t")) next++;
    const joins = (swallowed.has(nl) || markupOnly) && chars[next] !== "#";
    if (directive && joins && last >= start && chars[last] === " ") chars[last] = "\\";
    continued = last >= start && chars[last] === "\\";
    start = nl + 1;
  }
}

/** Whether the line around `d` has code besides tresos markup. */
function inLineOfCode(source: string, d: Directive): boolean {
  const start = source.lastIndexOf("\n", d.at - 1) + 1;
  let end = source.indexOf("\n", d.end);
  if (end < 0) end = source.length;
  // `[^\n]*`, not `.*$`: `.` stops at the `\r` of a CRLF line, which left the
  // `[!//` comment in place and counted it as code.
  const rest = (source.slice(start, d.at) + source.slice(d.end, end)).replace(/\[![\s\S]*?!\]/g, "").replace(/\[!\/\/[^\n]*/, "");
  return /\S/.test(rest);
}
