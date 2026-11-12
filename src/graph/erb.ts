/**
 * ERB code templates: C/C++ sources with embedded Ruby, as some AUTOSAR crypto
 * stacks ship them under `generate/` (`Crypto_11_Hsm_Cfg.c`). Ruby is written in
 * `<% … %>` tags (`<%= x %>` outputs a value) and on lines that start with `%`
 * (`% keys.each do |k|`, `% end`). The C grammar reads both as code and fails.
 *
 * {@link erbView} turns such a template into C the grammar can read, keeping
 * every line, column and offset where it was:
 *
 * - an output tag (`<%= e.name %>`) becomes one identifier of the same length
 *   (`____e_name___`), so `Buf_<%= e.name %>[N]` and `<%= e.init_value %>;`
 *   stay valid C;
 * - other tags (`<% if x %>`, `<%# note %>`) and Ruby lines become spaces.
 *
 * The view keeps every branch of the Ruby code, as the tresos view that keeps
 * every `[!IF!]` branch does. The extractor parses it next to the file as
 * written and keeps the better tree.
 */

/** A Ruby line: `%` in the first column, then a Ruby statement. A Diab inline
 * assembler line (`%reg a, b;`, `% reg x`) is not one. */
const RUBY_LINE = /^%[ \t]*(?:end\b|else\b|elsif\b|if\b|unless\b|while\b|until\b|for\b|case\b|when\b|[\w.@:]+[ \t]*=[^=]|.*\bdo\b[ \t]*(?:\|[^|\n]*\|)?[ \t]*$)/m;
const OUTPUT_TAG = /<%=/;

/** Whether the source is an ERB template: it carries an output tag, or a Ruby
 * line together with a closing `%>` somewhere. */
export function isErbTemplate(source: string): boolean {
  if (!source.includes("%")) return false;
  if (OUTPUT_TAG.test(source) && source.includes("%>")) return true;
  return RUBY_LINE.test(source) && /<%[\s\S]*?%>|^%[ \t]*end\b/m.test(source);
}

/** The C view of an ERB template: same length, same line breaks. */
export function erbView(source: string): string {
  const chars = source.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (chars[k] !== "\n" && chars[k] !== "\r") chars[k] = " ";
  };
  // Tags first: `<%%` is a literal `<%`, everything else up to `%>` is Ruby.
  const tag = /<%(%?)([=#-]?)([\s\S]*?)-?%>/g;
  for (let m = tag.exec(source); m !== null; m = tag.exec(source)) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[1] === "%") continue;
    if (m[2] === "=") {
      for (let k = start; k < end; k++) chars[k] = /\w/.test(source[k]) ? source[k] : "_";
    } else blank(start, end);
  }
  // Then Ruby lines (`%%` at the start of a line is a literal `%`; `%>` closes
  // a tag that is already blanked).
  const line = /^%(?![%>])[^\n]*/gm;
  for (let m = line.exec(source); m !== null; m = line.exec(source)) {
    if (!isRubyLine(m[0])) continue;
    blank(m.index, m.index + m[0].length);
  }
  return chars.join("");
}

/** Whether one `%` line is Ruby rather than C or assembler. In an ERB template
 * every such line is Ruby, except the `%reg`/`%` lines of a Diab assembler
 * body, which name registers; those stay. */
function isRubyLine(text: string): boolean {
  return !/^%[ \t]*reg\b/.test(text);
}
