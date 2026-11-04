import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localDate, stampChangelog } from "../scripts/stamp-changelog.mjs";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

const page = (pending: string) =>
  `<section id="changes">\n<div class="group" data-group="pending">\n  <ul>\n<!-- pending:start -->\n${pending}<!-- pending:end -->\n  </ul>\n</div>\n<!-- groups:start -->\n\n<div class="group" data-group="commit" data-date="2026-11-04"></div>\n</section>`;

test("stampChangelog moves pending entries into a new build group above the older groups", () => {
  const li = '    <li data-type="fix" data-area="cli">uses $self-&gt;m() and $1</li>\n';
  const { html, count } = stampChangelog(page(li), { date: "2026-11-05", version: "1.2.3" });
  assert.equal(count, 1);
  assert.match(html, /<!-- pending:start -->\n<!-- pending:end -->/);
  const group = html.indexOf('data-group="bundle" data-date="2026-11-05" data-version="1.2.3"');
  assert.ok(group > html.indexOf("<!-- groups:start -->"));
  assert.ok(group < html.indexOf('data-group="commit"'));
  assert.ok(html.includes("uses $self-&gt;m() and $1"));
});

test("stampChangelog adds to the same build's group when the version is packed again that day", () => {
  const first = stampChangelog(page("    <li>a</li>\n"), { date: "2026-11-05", version: "1.2.3" }).html;
  const again = first.replace("<!-- pending:start -->\n", "<!-- pending:start -->\n    <li>b</li>\n");
  const { html, count } = stampChangelog(again, { date: "2026-11-05", version: "1.2.3" });
  assert.equal(count, 1);
  assert.equal(html.match(/data-group="bundle"/g)?.length, 1);
  assert.ok(html.indexOf("<li>a</li>") < html.indexOf("<li>b</li>"));
});

test("stampChangelog leaves the page alone when nothing is pending", () => {
  const html = page("");
  assert.deepEqual(stampChangelog(html, { date: "2026-11-05", version: "1.2.3" }), { html, count: 0 });
});

test("the shipped changelog has the markers pack:bundle stamps", () => {
  const html = readFileSync(join(repoRoot, "docs", "changelog.html"), "utf8");
  assert.doesNotThrow(() => stampChangelog(html, { date: localDate(), version: "0.0.0" }));
});

test("localDate formats a local date as YYYY-MM-DD", () => {
  assert.equal(localDate(new Date(2026, 0, 5)), "2026-01-05");
});
