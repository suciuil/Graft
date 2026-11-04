/**
 * Dates the fork changelog's "Not yet bundled" entries with the package build that
 * ships them: `npm run pack:bundle` moves every entry between the pending markers of
 * docs/changelog.html into a group for that run's date and version (newest group
 * first), or into the existing group when the same version is packed again that day.
 * On Windows the version is the offline kit's (a.b.c.d, see kit-build.mjs), so each kit
 * gets its own group, headed "kit a.b.c.d, graft a.b.c".
 */
import { parseKitVersion } from "./kit-build.mjs";

const PENDING = /(<!-- pending:start -->)([\s\S]*?)(<!-- pending:end -->)/;
const GROUPS = "<!-- groups:start -->";

/** Today's local date as YYYY-MM-DD. */
export function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Returns the stamped HTML and how many entries moved (0: nothing pending, HTML unchanged). */
export function stampChangelog(html, { date, version }) {
  const m = PENDING.exec(html);
  if (!m || !html.includes(GROUPS)) {
    throw new Error("docs/changelog.html lacks the <!-- pending:start/end --> or <!-- groups:start --> markers");
  }
  const items = m[2].trim();
  if (!items) return { html, count: 0 };
  const count = (items.match(/<li\b/g) ?? []).length;
  let out = html.replace(PENDING, (_, start, _items, end) => `${start}\n${end}`);
  // A Windows pack names its build by the kit version (a.b.c.d: graft a.b.c, kit build d)
  const kit = parseKitVersion(version);
  const label = kit ? `kit ${version}, graft ${kit.version}` : `package build ${version}`;
  const groupEnd = `<!-- bundle ${date} ${version}:end -->`;
  if (out.includes(groupEnd)) {
    out = out.replace(groupEnd, () => `    ${items}\n${groupEnd}`);
  } else {
    const group =
      `\n\n<div class="group" data-group="bundle" data-date="${date}" data-version="${version}">\n` +
      `  <h2>${date} <small>${label}</small></h2>\n` +
      `  <ul>\n    ${items}\n${groupEnd}\n  </ul>\n</div>`;
    out = out.replace(GROUPS, () => GROUPS + group);
  }
  return { html: out, count };
}
