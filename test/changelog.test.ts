import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addBuild,
  areaOf,
  areasOf,
  entryHtml,
  formatBuilds,
  generateChangelog,
  groupCommits,
  htmlText,
  localDate,
  mergeLegacy,
  parseCommitMessage,
  readLegacy,
  renderChangelog,
} from "../scripts/changelog.mjs";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const shell =
  "<div><!-- stats:start -->\n<!-- stats:end --></div><table><!-- counts:start -->\n<!-- counts:end --></table>" +
  "<select><!-- areas:start -->\n<!-- areas:end --></select><section><!-- changes:start -->\n<!-- changes:end --></section>\n";

test("parseCommitMessage takes every typed line, word for word, and splits several on one line", () => {
  const body =
    "- Feature: New `graft about` command. - Bug-Fix: Windows <consoles> flashed & more.\n" +
    "- Improvement: Faster\n  builds\n- with a continuation line.\n" +
    "- Change Request (docs): The report is dated.\n- bugfix: lower case works.\n- Bug fix: two words work.";
  assert.deepEqual(parseCommitMessage(body), [
    { type: "feature", text: "New `graft about` command." },
    { type: "fix", text: "Windows <consoles> flashed & more." },
    { type: "improvement", text: "Faster builds with a continuation line." },
    { type: "change", text: "The report is dated." },
    { type: "fix", text: "Lower case works." },
    { type: "fix", text: "Two words work." },
  ]);
});

test("parseCommitMessage skips commits without a typed line and text before the first one", () => {
  assert.deepEqual(parseCommitMessage("- add more tests\n- remove file"), []);
  assert.deepEqual(parseCommitMessage("Merge work\n\n- Feature: Kept."), [{ type: "feature", text: "Kept." }]);
  assert.deepEqual(parseCommitMessage("Fix: not a bullet\n- Changes: not a type"), []);
});

test("entryHtml escapes the text and turns backticks into code", () => {
  assert.equal(entryHtml("Run `a <b>` & go"), "Run <code>a &lt;b&gt;</code> &amp; go");
});

test("areaOf guesses the filter area from words in the text", () => {
  assert.equal(areaOf("Telemetry stays permanently disabled."), "privacy");
  assert.equal(areaOf("Savings are priced with the model you used."), "savings");
  assert.equal(areaOf("Kotlin inheritance edges were missing."), "lang");
  assert.equal(areaOf("The Databricks gateway is the default endpoint."), "llm");
  assert.equal(areaOf("The Windows installer remembers your answers."), "packaging");
  assert.equal(areaOf("Add support for Kilo Code extension"), "agents");
  assert.equal(areaOf("New graft issues command."), "cli");
});

test("areasOf also lists installer items under packaging when another area wins", () => {
  assert.deepEqual(areasOf("The Windows installer asks whether to report cost savings."), ["savings", "packaging"]);
  assert.deepEqual(areasOf("The installer checks the LLM endpoint."), ["llm", "packaging"]);
  assert.deepEqual(areasOf("The Windows installer remembers your answers."), ["packaging"]);
  assert.deepEqual(areasOf("Savings are priced with the model you used."), ["savings"]);
});

test("groupCommits puts commits under the build that shipped them, newest first, and lists a repeated item once", () => {
  const commits = [
    { hash: "d", date: "2026-11-06", entries: [{ type: "fix", text: "Pending fix." }, { type: "feature", text: "Pending feature." }] },
    { hash: "c", date: "2026-11-05", entries: [{ type: "improvement", text: "Second build." }] },
    { hash: "b", date: "2026-11-04", entries: [{ type: "feature", text: "First build." }, { type: "feature", text: "Old item." }] },
    { hash: "a", date: "2026-10-01", entries: [{ type: "feature", text: "Old item." }] },
  ];
  const builds = [
    { id: "1", date: "2026-11-04", version: "0.28.0", ships: new Set(["b", "a"]) },
    { id: "2", date: "2026-11-05", version: "0.28.0.1", ships: new Set(["c", "b", "a"]) },
  ];
  const groups = groupCommits(commits, { unrecorded: new Set(["a"]), builds });
  assert.deepEqual(
    groups.map((g) => [g.kind, g.version ?? g.date ?? "", g.entries.map((e) => e.text)]),
    [
      ["pending", "", ["Pending feature.", "Pending fix."]],
      ["bundle", "0.28.0.1", ["Second build."]],
      ["bundle", "0.28.0", ["First build."]],
      ["commit", "2026-10-01", ["Old item."]],
    ],
  );
  // A build whose record is not committed yet takes every commit no earlier build shipped
  const open = groupCommits(commits, { unrecorded: new Set(["a"]), builds: [...builds, { id: "3", date: "2026-11-06", version: "0.28.0.2", ships: null }] });
  assert.equal(open[0].entries.length, 0);
  assert.deepEqual(open[1].entries.map((e) => e.text), ["Pending feature.", "Pending fix."]);
});

test("renderChangelog fills stats, counts, areas and groups, and needs every marker", () => {
  const groups = groupCommits(
    [{ hash: "a", date: "2026-11-04", entries: [{ type: "feature", text: "Kotlin `x`." }, { type: "fix", text: "Savings fix." }] }],
    { unrecorded: new Set(), builds: [{ id: "1", date: "2026-11-04", version: "0.28.0.3", ships: new Set(["a"]) }] },
  );
  const html = renderChangelog(shell, groups);
  assert.match(html, /<div class="stat feature"><b>1<\/b>/);
  assert.match(html, /<div class="stat"><b>2<\/b><span>Items in total/);
  assert.match(html, /<tr class="total"><td>Total<\/td><td>1<\/td><td>1<\/td><td>0<\/td><td>0<\/td><td>2<\/td><\/tr>/);
  assert.match(html, /<!-- areas:start -->\n    <option value="all" selected>All areas<\/option>\n    <option value="lang">/, "the page opens on all areas");
  assert.ok(html.includes('data-group="bundle" data-date="2026-11-04" data-version="0.28.0.3"'));
  assert.ok(html.includes("<small>kit 0.28.0.3, graft 0.28.0</small>"));
  assert.ok(html.includes('<li data-type="feature" data-area="lang"><span class="tag">Feature</span><span><span class="area">Languages</span>Kotlin <code>x</code>.</span></li>'));
  assert.equal(renderChangelog(html, groups), html, "regenerating is idempotent");
  const installer = renderChangelog(
    shell,
    groupCommits([{ hash: "a", date: "2026-11-04", entries: [{ type: "feature", text: "The installer reports savings." }] }], { unrecorded: new Set(), builds: [] }),
  );
  assert.ok(installer.includes('data-area="savings packaging"><span class="tag">Feature</span><span><span class="area">Savings &amp; pricing</span><span class="area">Packaging &amp; installer</span>'));
  assert.match(installer, /<a data-area="packaging">[^<]*<\/a><\/td><td>1<\/td>/);
  assert.throws(() => renderChangelog("<p></p>", groups), /stats:start/);
});

test("htmlText strips tags and decodes entities", () => {
  assert.equal(htmlText("<b><code>graft a</code></b> &amp; <i>b</i>&lt;c&gt;"), "graft a & b <c>");
});

test("mergeLegacy keeps the hand-written entries in their groups and leaves out what they cover", () => {
  const groups = groupCommits(
    [
      { hash: "c", date: "2026-11-05", entries: [{ type: "feature", text: "Covered new." }, { type: "fix", text: "Kept new." }] },
      { hash: "b", date: "2026-10-02", entries: [{ type: "feature", text: "Covered old." }] },
      { hash: "a", date: "2026-10-01", entries: [{ type: "fix", text: "Same text." }, { type: "feature", text: "Kept old." }] },
    ],
    { unrecorded: new Set(["a", "b"]), builds: [{ id: "1", date: "2026-11-05", version: "0.28.0", ships: new Set(["c", "b", "a"]) }] },
  );
  const legacy = [
    { version: "0.28.0", date: "2026-11-04", type: "feature", area: "cli", html: "<b>Merged</b> feature.", replaces: ["Covered new.", "Covered old.", "Gone."] },
    { date: "2026-10-01", type: "fix", area: "savings", html: "Same text." },
    { date: "2026-09-01", type: "change", area: "cli", html: "Only in the old report &amp; installer." },
  ];
  const { groups: merged, unmatched } = mergeLegacy(groups, legacy);
  assert.deepEqual(
    merged.map((g) => [g.kind, g.version ?? g.date ?? "", g.entries.map((e) => e.text)]),
    [
      ["pending", "", []],
      ["bundle", "0.28.0", ["Merged feature.", "Kept new."]],
      ["commit", "2026-10-01", ["Kept old.", "Same text."]],
      ["commit", "2026-09-01", ["Only in the old report & installer."]],
    ],
  );
  assert.deepEqual(unmatched, ["Gone."]);
  const old = merged[3].entries[0];
  assert.deepEqual(old.areas, ["cli", "packaging"], "the stored area comes first, `also` areas are added");
  const html = renderChangelog(shell, merged);
  assert.ok(
    html.includes(
      '<li data-type="change" data-area="cli packaging"><span class="tag">Change</span><span><span class="area">CLI &amp; configuration</span><span class="area">Packaging &amp; installer</span>Only in the old report &amp; installer.</span></li>',
    ),
  );
  assert.ok(html.includes("<b>Merged</b> feature."), "legacy HTML is kept as written");
  assert.match(html, /<div class="stat"><b>5<\/b><span>Items in total/);
});

test("the committed changelog-legacy.json is valid and names each covered entry once", () => {
  const items = readLegacy(repoRoot);
  assert.ok(items.length > 0);
  const replaces = items.flatMap((i: { replaces?: string[] }) => i.replaces ?? []);
  assert.equal(new Set(replaces).size, replaces.length);
  assert.throws(() => {
    const dir = mkdtempSync(join(tmpdir(), "graft-legacy-"));
    try {
      writeFileSync(join(dir, "changelog-legacy.json"), JSON.stringify({ items: [{ date: "2026-01-01", type: "nope", area: "cli", html: "x" }] }));
      readLegacy(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, /unknown type/);
  assert.deepEqual(readLegacy(join(repoRoot, "docs")), [], "no file, no items");
});

test("addBuild records a build once per date and version", () => {
  const one = addBuild({ builds: [] }, "2026-11-06", "0.28.0.2");
  assert.deepEqual(one.builds, [{ id: "2026-11-06 0.28.0.2", date: "2026-11-06", version: "0.28.0.2" }]);
  assert.equal(addBuild(one, "2026-11-06", "0.28.0.2"), one);
  assert.ok(formatBuilds(one).endsWith("}\n"));
});

test("generateChangelog reads the fork's commit messages and closes a build at the commit that records it", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-changelog-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8", windowsHide: true });
  const commit = (message: string, file = "work.txt") => {
    writeFileSync(join(dir, file), `${message}\n${Math.random()}\n`);
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
  };
  try {
    git("init", "-q");
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "changelog.html"), shell);
    commit("upstream base\n\n- Feature: Upstream work is not listed.");
    git("update-ref", "refs/remotes/upstream/main", "HEAD");
    commit("- Feature: Shipped in the first build.");
    writeFileSync(join(dir, "changelog-builds.json"), formatBuilds(addBuild({ builds: [] }, "2026-11-05", "0.28.0.0")));
    commit("- add more tests");
    commit("- Bug-Fix: Not yet bundled.");
    // A changelog note adds entries to a commit whose message left them out
    const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
    git(...id, "notes", "--ref=changelog", "add", "-m", "- Feature: Added by a note.", "HEAD");
    git(...id, "notes", "add", "-m", "- Feature: Default notes are not read.", "HEAD");

    const { html, changed, groups } = generateChangelog(dir);
    assert.ok(changed);
    assert.deepEqual(
      groups.map((g) => [g.kind, g.entries.map((e) => e.text)]),
      [
        ["pending", ["Added by a note.", "Not yet bundled."]],
        ["bundle", ["Shipped in the first build."]],
      ],
    );
    assert.ok(!html.includes("Upstream work"));
    writeFileSync(join(dir, "docs", "changelog.html"), html);
    assert.equal(generateChangelog(dir).changed, false);

    // A pack records a build that is not committed yet: it takes the pending commits
    const packed = addBuild(JSON.parse(readFileSync(join(dir, "changelog-builds.json"), "utf8")), "2026-11-06", "0.28.0.1");
    const next = generateChangelog(dir, packed).groups;
    assert.equal(next[0].entries.length, 0);
    assert.deepEqual(next[1].entries.map((e) => e.text), ["Added by a note.", "Not yet bundled."]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the shipped changelog has the regions the generator fills", () => {
  const html = readFileSync(join(repoRoot, "docs", "changelog.html"), "utf8");
  for (const name of ["stats", "counts", "areas", "changes"]) {
    assert.ok(html.includes(`<!-- ${name}:start -->`) && html.includes(`<!-- ${name}:end -->`), `${name} markers`);
  }
});

test("localDate formats a local date as YYYY-MM-DD", () => {
  assert.equal(localDate(new Date(2026, 0, 5)), "2026-01-05");
});
