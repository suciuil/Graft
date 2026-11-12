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
 *   `[!VAR!]`, `[!ERROR!]`, `[!WARNING!]`, `[!INFO!]` and `[!ASSERT!]` blocks.
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
  const blank = (from: number, to: number): void => {
    for (let x = from; x < to; x++) if (chars[x] !== "\n" && chars[x] !== "\r") chars[x] = " ";
  };
  const identifier = (from: number, to: number): void => {
    for (let x = from; x < to; x++) if (chars[x] !== "\n" && chars[x] !== "\r" && !/\w/.test(chars[x])) chars[x] = "_";
  };
  const output: boolean[] = [true];
  const skip: boolean[] = [];
  const emitting = (): boolean => output[output.length - 1] && !skip.includes(true);
  let pos = 0;
  list.forEach((d, k) => {
    const code = emitting();
    if (!code) blank(pos, d.at);
    pos = d.end;
    if (d.kind === "value") return code ? identifier(d.at, d.end) : blank(d.at, d.end);
    if (d.kind === "comment") return blank(d.at, d.end);
    if (d.word === "CALL" && code && inLineOfCode(source, d)) return identifier(d.at, d.end);
    blank(d.at, d.end);
    if (paired.has(k)) {
      if (BLOCKS.has(d.word)) output.push(d.word === "CODE");
      else if (output.length > 1) output.pop();
    } else if (firstBranch) {
      if (d.word === "IF") skip.push(false);
      else if ((d.word === "ELSE" || d.word === "ELSEIF") && skip.length > 0) skip[skip.length - 1] = true;
      else if (d.word === "ENDIF") skip.pop();
    }
  });
  if (!emitting()) blank(pos, source.length);
  return chars.join("");
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
