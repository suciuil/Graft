/**
 * A small, tolerant XML reader for the XML parts of MATLAB and Simulink packages
 * (Simulink models and dictionaries, live scripts). It keeps each element's rows so a
 * node can point at the lines it came from.
 */

/** One element, with the 0-based rows (within its part) where it starts and ends. */
export interface XmlEl {
  name: string;
  attrs: Record<string, string>;
  children: XmlEl[];
  /** Its own text (not its children's), entities decoded. */
  text: string;
  start: number;
  end: number;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
function decode(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/**
 * Parse XML into its top-level elements. Tolerant by design: comments, processing
 * instructions and DOCTYPE are skipped, CDATA is text, and a stray close tag closes
 * up to its matching open element (or is ignored), so a damaged part still yields
 * what can be read.
 */
export function parseXml(text: string): XmlEl[] {
  const root: XmlEl = { name: "#root", attrs: {}, children: [], text: "", start: 0, end: 0 };
  const stack: XmlEl[] = [root];
  const n = text.length;
  let i = 0;
  let row = 0;
  const advance = (to: number): void => {
    for (let k = i; k < to; k++) if (text.charCodeAt(k) === 10) row++;
    i = to;
  };
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      stack[stack.length - 1]!.text += decode(text.slice(i));
      advance(n);
      break;
    }
    if (lt > i) {
      stack[stack.length - 1]!.text += decode(text.slice(i, lt));
      advance(lt);
    }
    if (text.startsWith("<!--", i)) {
      const e = text.indexOf("-->", i + 4);
      advance(e < 0 ? n : e + 3);
    } else if (text.startsWith("<![CDATA[", i)) {
      const e = text.indexOf("]]>", i + 9);
      stack[stack.length - 1]!.text += text.slice(i + 9, e < 0 ? n : e);
      advance(e < 0 ? n : e + 3);
    } else if (text.startsWith("<?", i)) {
      const e = text.indexOf("?>", i + 2);
      advance(e < 0 ? n : e + 2);
    } else if (text.startsWith("<!", i)) {
      const e = text.indexOf(">", i + 2);
      advance(e < 0 ? n : e + 1);
    } else if (text[i + 1] === "/") {
      const e = text.indexOf(">", i + 2);
      const name = text.slice(i + 2, e < 0 ? n : e).trim();
      let at = stack.length - 1;
      while (at > 0 && stack[at]!.name !== name) at--;
      if (at > 0) {
        while (stack.length > at) stack.pop()!.end = row;
      }
      advance(e < 0 ? n : e + 1);
    } else {
      // A start tag; `>` inside a quoted attribute value does not end it.
      let j = i + 1;
      let quote = "";
      for (; j < n; j++) {
        const c = text[j]!;
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
      }
      const raw = text.slice(i + 1, j);
      const selfClosing = raw.endsWith("/");
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const name = /^[^\s/>]+/.exec(body)?.[0] ?? "";
      const attrs = parseAttrs(body.slice(name.length));
      const el: XmlEl = { name, attrs, children: [], text: "", start: row, end: row };
      stack[stack.length - 1]!.children.push(el);
      advance(Math.min(n, j + 1));
      if (selfClosing) el.end = row;
      else if (name) stack.push(el);
    }
  }
  while (stack.length > 1) stack.pop()!.end = row;
  return root.children;
}

const WS = /\s/;

/**
 * A start tag's attributes, in one pass: what
 * `/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g` matches, a word without a quoted
 * value after `=` skipped. That regex, retried from every position, went
 * quadratic on a long run with no space or `=` in a tag; this reads each
 * character once (a quote never closed is searched for to the end once).
 */
function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const n = s.length;
  let k = 0;
  while (k < n) {
    while (k < n && WS.test(s[k]!)) k++;
    const from = k;
    while (k < n && s[k] !== "=" && !WS.test(s[k]!)) k++;
    if (k === from) {
      k++; // a stray `=`
      continue;
    }
    const name = s.slice(from, k);
    let p = k;
    while (p < n && WS.test(s[p]!)) p++;
    if (s[p] !== "=") {
      k = p;
      continue;
    }
    p++;
    while (p < n && WS.test(s[p]!)) p++;
    const q = s[p];
    const close = q === '"' || q === "'" ? s.indexOf(q, p + 1) : -1;
    if (close < 0) {
      k = p; // no quoted value: read on from here
      continue;
    }
    attrs[name] = decode(s.slice(p + 1, close));
    k = close + 1;
  }
  return attrs;
}
