import "./isolate.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addBuild,
  alreadySaid,
  areaOf,
  areasOf,
  attachGrammarEntries,
  entryHtml,
  formatBuilds,
  formatGrammars,
  generateChangelog,
  GRAMMAR_AUTHOR,
  grammarName,
  groupCommits,
  groupLanguages,
  htmlText,
  isVendoredFile,
  localDate,
  isParsingEntry,
  localGrammarRepos,
  mergeLegacy,
  namesGrammar,
  OTHER_LANGUAGE,
  parseCommitMessage,
  readGrammarRepos,
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

test("isVendoredFile matches a package's tarball and prebuilt binding, not a longer name", () => {
  assert.ok(isVendoredFile("vendor/tree-sitter-c-0.24.1.tgz", "tree-sitter-c"));
  assert.ok(isVendoredFile("vendor/tree-sitter-c/prebuilds/win32-x64/tree-sitter-c.node", "tree-sitter-c"));
  assert.ok(!isVendoredFile("vendor/tree-sitter-cpp-0.23.4.tgz", "tree-sitter-c"));
  assert.ok(!isVendoredFile("vendor/tree-sitter-c-sharp-0.23.1.tgz", "tree-sitter-c"));
  assert.ok(!isVendoredFile("vendor/tree-sitter-c-sharp/prebuilds/win32-x64/tree-sitter-c-sharp.node", "tree-sitter-c"));
  assert.ok(isVendoredFile("vendor/bootswithdefer-tree-sitter-groovy-0.1.2.tgz", "@bootswithdefer/tree-sitter-groovy"));
  assert.ok(isVendoredFile("vendor/groovy/prebuilds/win32-x64/@bootswithdefer+tree-sitter-groovy.node", "@bootswithdefer/tree-sitter-groovy"));
  assert.ok(!isVendoredFile("vendor/.grammar-stamps.json", "tree-sitter-c"));
});

test("alreadySaid needs most significant words of an entry of four or more", () => {
  const said = ["Updated the bundled C grammar: macro calls in if conditions are parsed as calls."];
  assert.ok(alreadySaid("Macro calls in if conditions are now parsed as calls.", said));
  assert.ok(!alreadySaid("Parses lambda expressions with trailing commas.", said));
  // Too short to tell
  assert.ok(!alreadySaid("Minor fixes.", ["Minor fixes."]));
});

test("attachGrammarEntries files grammar entries under the fork commit that ships them", () => {
  const commits = [
    { hash: "c3", date: "2026-11-03", entries: [{ type: "fix", text: "Unrelated fix." }] },
    { hash: "c2", date: "2026-11-02", entries: [{ type: "improvement", text: "Updated the C grammar: macro calls in if conditions are parsed as calls." }] },
    { hash: "c1", date: "2026-11-01", entries: [] },
  ];
  const repos = [
    {
      repo: "tree-sitter-c",
      package: "tree-sitter-c",
      commits: [
        { hash: "g1", time: 50, date: "2026-10-30", entries: [{ type: "feature", text: "Old work." }] },
        { hash: "g2", time: 150, date: "2026-11-01", entries: [{ type: "fix", text: "Macro calls in if conditions are parsed as calls." }, { type: "fix", text: "Kept." }] },
        { hash: "g3", time: 400, date: "2026-11-04", entries: [{ type: "feature", text: "Not shipped yet." }] },
      ],
    },
  ];
  const vendorLog = [
    { hash: "c1", time: 100, files: ["vendor/tree-sitter-cpp-1.0.0.tgz"] },
    { hash: "c2", time: 200, files: ["vendor/tree-sitter-c-1.0.0.tgz"] },
    { hash: "c0", time: 60, files: ["vendor/tree-sitter-c-0.9.0.tgz"] }, // not a fork commit listed
  ];
  const before = JSON.stringify(commits);
  const out = attachGrammarEntries(commits, repos, vendorLog);
  assert.equal(JSON.stringify(commits), before);
  const show = (e: { text: string; details?: { text: string }[] }) => (e.details ? [e.text, e.details.map((d) => d.text)] : e.text);
  assert.deepEqual(
    out.map((c) => [c.hash, c.date, c.entries.map(show)]),
    [
      ["", "2026-11-04", [["The C grammar has been updated.", ["Not shipped yet."]]]],
      ["c3", "2026-11-03", ["Unrelated fix."]],
      // The fork commit's own line about parsing C moves behind the link, after the grammar's lines
      ["c2", "2026-11-02", [["The C grammar has been updated.", ["Old work.", "Kept.", "Updated the C grammar: macro calls in if conditions are parsed as calls."]]]],
      ["c1", "2026-11-01", []],
    ],
  );
  assert.deepEqual(
    { ...out[2].entries[0], details: undefined },
    { type: "improvement", text: "The C grammar has been updated.", area: "lang", grammar: "tree-sitter-c", details: undefined },
  );
  assert.deepEqual(out[2].entries[0].details[0], { type: "feature", text: "Old work." });
  assert.equal(attachGrammarEntries(commits, [], vendorLog).length, 3);
  // A grammar line the shipping commit already says is left out: only the commit's own line is listed
  const said = [{ ...repos[0], commits: [repos[0].commits[1]].map((g) => ({ ...g, entries: g.entries.slice(0, 1) })) }];
  assert.deepEqual(attachGrammarEntries(commits, said, vendorLog)[1].entries.map(show), [
    ["The C grammar has been updated.", ["Updated the C grammar: macro calls in if conditions are parsed as calls."]],
  ]);
  // Lines about parsing a grammar's language move even from commits that ship no grammar build;
  // a line naming several languages is listed under each, other lines stay
  const own = [
    {
      hash: "d1",
      date: "2026-11-05",
      entries: [
        { type: "feature", text: "C and C++ files with odd #if blocks are now read without syntax errors. More text." },
        { type: "feature", text: "C templates are now read as code, so their functions show up in the graph instead of parse errors." },
        { type: "improvement", text: "Python files now parse faster." },
      ],
    },
  ];
  const cpp = { repo: "tree-sitter-cpp", package: "tree-sitter-cpp", commits: [] };
  assert.deepEqual(attachGrammarEntries(own, [repos[0], cpp], [])[1].entries.map(show), [
    "C templates are now read as code, so their functions show up in the graph instead of parse errors.",
    "Python files now parse faster.",
    ["The C grammar has been updated.", ["C and C++ files with odd #if blocks are now read without syntax errors. More text."]],
    ["The C++ grammar has been updated.", ["C and C++ files with odd #if blocks are now read without syntax errors. More text."]],
  ]);
  // A parsing line naming no language goes with the shipped grammar line that mostly says it
  const minus = "A name followed by a minus and a number inside macro arguments is read as a subtraction, so test files no longer report syntax errors.";
  const unnamed = [{ hash: "e1", date: "2026-11-06", entries: [{ type: "fix", text: minus }, { type: "fix", text: "Other files no longer report syntax errors." }] }];
  const grammar = {
    repo: "tree-sitter-c",
    package: "tree-sitter-c",
    commits: [{ hash: "g", time: 1, date: "2026-11-06", entries: [{ type: "fix", text: "A name followed by a minus and a number inside macro arguments is now read as a subtraction instead of a macro modifier in front of a negative value like len." }] }],
  };
  assert.deepEqual(attachGrammarEntries(unnamed, [grammar, cpp], [{ hash: "e1", time: 2, files: ["vendor/tree-sitter-c-1.0.0.tgz"] }])[0].entries.map(show), [
    "Other files no longer report syntax errors.",
    ["The C grammar has been updated.", [grammar.commits[0].entries[0].text, minus]],
  ]);
});

test("namesGrammar and isParsingEntry pick the lines about parsing a grammar's language", () => {
  assert.ok(namesGrammar("C/C++ parsing finds more functions.", "tree-sitter-c"));
  assert.ok(namesGrammar("C/C++ parsing finds more functions.", "tree-sitter-cpp"));
  assert.ok(!namesGrammar("C++ only.", "tree-sitter-c"));
  assert.ok(!namesGrammar("C# only.", "tree-sitter-c"));
  assert.ok(!namesGrammar("CSS-in-JS only.", "tree-sitter-css"));
  assert.ok(namesGrammar("In Makefiles, an empty argument parses.", "tree-sitter-make"));
  assert.ok(!namesGrammar("kept as text, as make does.", "tree-sitter-make"));
  assert.ok(namesGrammar("Updated parsers for PL/SQL and Kotlin.", "tree-sitter-plsql"));
  assert.ok(namesGrammar("Updated parsers for PL/SQL and Kotlin.", "tree-sitter-kotlin-grammar"));

  assert.ok(isParsingEntry("Unnamed bit-fields in a C struct no longer cause a parse error."));
  assert.ok(isParsingEntry("The bundled Windows x64 C and C++ language parsers were rebuilt and repackaged.", "improvement"));
  assert.ok(isParsingEntry("Perl calls such as \"print f($_);\" are no longer read as a subroutine prototype."));
  assert.ok(!isParsingEntry("Graft is better at telling C++ headers from C headers. They no longer go to the C++ parser.", "improvement"));
  assert.ok(!isParsingEntry("MATLAB and Simulink support. Files are parsed.", "feature"));
  assert.ok(!isParsingEntry("The fork changelog now lists the latest parser work for XML.", "improvement"));
  assert.ok(isParsingEntry("C files written for several builds are now read without syntax errors.", "feature"));
  assert.ok(!isParsingEntry("C templates are now read as code, so they show up in the graph and no longer fill the index with parse errors.", "feature"));
  assert.ok(!isParsingEntry("A locally-built Kotlin grammar is used when available, improving parsing accuracy.", "feature"));
});

test("grammarName names the language of a grammar repository", () => {
  assert.equal(grammarName("tree-sitter-c"), "C");
  assert.equal(grammarName("tree-sitter-c-sharp"), "C#");
  assert.equal(grammarName("tree-sitter-cpp"), "C++");
  assert.equal(grammarName("tree-sitter-kotlin-grammar"), "Kotlin");
  assert.equal(grammarName("tree-sitter-plsql"), "PL/SQL");
  assert.equal(grammarName("tree-sitter-groovy"), "Groovy");
  assert.equal(grammarName("tree-sitter-foo-bar"), "Foo-Bar");
});

test("grammar items of one group merge into one, render with a details link and are never deduplicated away", () => {
  const item = (date: string, text: string) => ({ type: "improvement", text: "The C grammar has been updated.", area: "lang", grammar: "tree-sitter-c", details: [{ type: "fix", text }] });
  const commits = [
    { hash: "b", date: "2026-11-02", entries: [item("2026-11-02", "Newer <change>.")] },
    { hash: "a", date: "2026-11-01", entries: [item("2026-11-01", "Older change.")] },
    { hash: "z", date: "2026-10-01", entries: [item("2026-10-01", "Earliest change.")] },
  ];
  const groups = groupCommits(commits, {
    unrecorded: new Set(["z"]),
    builds: [{ id: "2026-11-05 0.28.0.0", date: "2026-11-05", version: "0.28.0.0", ships: new Set(["a", "b"]) }],
  });
  const [pending, bundle, dated] = groups;
  assert.equal(pending.entries.length, 0);
  assert.equal(bundle.entries.length, 1);
  assert.deepEqual(bundle.entries[0].details.map((d: { text: string }) => d.text), ["Older change.", "Newer <change>."]);
  assert.deepEqual(dated.entries[0].details.map((d: { text: string }) => d.text), ["Earliest change."]);
  assert.equal(commits[0].entries[0].details.length, 1);
  const html = renderChangelog(shell, groups);
  assert.ok(html.includes('The C grammar has been updated. <details class="more"><summary>details: 2 changes</summary><ul class="details">'));
  assert.ok(html.includes('<li data-type="fix"><span class="tag">Bug fix</span><span>Newer &lt;change&gt;.</span></li>'));
  assert.ok(html.includes("<summary>details: 1 change</summary>"));
  assert.ok(html.includes('<div class="stat"><b>2</b><span>Items in total</span></div>'));
});

test("groupLanguages puts every Languages entry behind one item per language and build", () => {
  const lang = (type: string, text: string, extra = {}) => ({ type, text, areas: areasOf(text, "lang"), ...extra });
  const groups = [
    {
      kind: "bundle",
      date: "2026-11-05",
      version: "0.28.0.0",
      entries: [
        lang("improvement", "The C grammar has been updated.", { grammar: "tree-sitter-c", details: [{ type: "fix", text: "C bit-fields parse." }] }),
        lang("feature", "C and C++ templates with embedded Ruby are now indexed."),
        lang("feature", "MATLAB and Simulink support. Scripts are indexed."),
        lang("fix", "The grammar build found no grammars."),
        lang("feature", "Breadth-tier support for CSS, HTML and C# Razor.", { html: "<b>Breadth-tier</b> support for CSS, HTML and C# Razor.", legacy: true }),
        { type: "fix", text: "A CLI fix.", areas: ["cli"] },
      ],
    },
  ];
  const repos = ["tree-sitter-c", "tree-sitter-cpp", "tree-sitter-c-sharp", "tree-sitter-css", "tree-sitter-html", "tree-sitter-razor", "tree-sitter-matlab"];
  const [g] = groupLanguages(groups, repos);
  const byName = new Map(g.entries.filter((e: any) => e.language).map((e: any) => [e.language, e]));
  assert.deepEqual([...byName.keys()], ["C", "C++", "CSS", "HTML", "MATLAB", "Razor", "Ruby", OTHER_LANGUAGE]);
  // Entries of other areas stay, before the language items of their type
  assert.deepEqual(g.entries.slice(-2).map((e: any) => e.text), ["A CLI fix.", "Other changes to language support and parsing."]);
  const c = byName.get("C");
  assert.equal(c.text, "The C grammar has been updated.");
  assert.equal(c.type, "feature");
  assert.deepEqual(c.types, ["feature", "fix"]);
  assert.deepEqual(c.details.map((d: { text: string }) => d.text), ["C and C++ templates with embedded Ruby are now indexed.", "C bit-fields parse."]);
  assert.equal(byName.get("C++").text, "C++ support has been updated.");
  assert.equal(byName.get("MATLAB").text, "MATLAB support has been added.");
  assert.equal(byName.get("CSS").text, "CSS support has been added.");
  assert.equal(byName.get("CSS").details[0].html, "<b>Breadth-tier</b> support for CSS, HTML and C# Razor.");
  assert.ok(!byName.has("C#"));
  assert.equal(byName.get(OTHER_LANGUAGE).text, "Other changes to language support and parsing.");
  assert.equal(groups[0].entries.length, 6);
  const html = renderChangelog(shell, [g]);
  assert.ok(html.includes('<li data-type="feature" data-types="feature fix" data-area="lang">'));
  assert.ok(html.includes("<span><b>Breadth-tier</b> support for CSS, HTML and C# Razor.</span>"));
});

test("readGrammarRepos reads sibling grammar repositories and falls back to the snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "graft-grammars-"));
  const fork = join(root, "graft");
  const grammar = join(root, "tree-sitter-x-grammar");
  const base = join(root, "tree-sitter-base");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const commit = (cwd: string, message: string, author = GRAMMAR_AUTHOR) => {
    writeFileSync(join(cwd, "work.txt"), `${message}\n${Math.random()}\n`);
    git(cwd, "add", "-A");
    git(cwd, "-c", `user.name=${author}`, "-c", "user.email=a@a", "commit", "-q", "-m", message);
  };
  try {
    for (const dir of [fork, grammar, base]) mkdirSync(dir);
    writeFileSync(join(fork, "package.json"), JSON.stringify({ name: "graft", optionalDependencies: { "tree-sitter-x": "file:../tree-sitter-x-grammar", missing: "file:../nowhere" } }));
    writeFileSync(join(grammar, "package.json"), JSON.stringify({ name: "tree-sitter-x", devDependencies: { "tree-sitter-base": "file:../tree-sitter-base" } }));
    writeFileSync(join(base, "package.json"), JSON.stringify({ name: "tree-sitter-base" }));
    for (const dir of [grammar, base]) git(dir, "init", "-q");
    commit(grammar, "- Feature: First.");
    commit(grammar, "- Bug-Fix: By someone else.", "someone");
    commit(grammar, "untyped");
    commit(grammar, "- Improvement: Second.");
    commit(base, "- Feature: Base work.");

    assert.deepEqual(
      localGrammarRepos(fork).map((r) => [r.repo, r.package]),
      [
        ["tree-sitter-base", "tree-sitter-x"],
        ["tree-sitter-x-grammar", "tree-sitter-x"],
      ],
    );
    const read = readGrammarRepos(fork);
    assert.ok(read.snapshotChanged);
    assert.deepEqual(
      read.repos.map((r) => [r.repo, r.commits.map((c) => c.entries.map((e) => e.text))]),
      [
        ["tree-sitter-base", [["Base work."]]],
        ["tree-sitter-x-grammar", [["First."], ["Second."]]],
      ],
    );
    writeFileSync(read.snapshotPath, read.snapshot);
    assert.equal(readGrammarRepos(fork).snapshotChanged, false);

    // Without the checkouts the snapshot gives the same commits
    rmSync(grammar, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
    const stored = readGrammarRepos(fork);
    assert.equal(stored.snapshotChanged, false);
    assert.deepEqual(stored.repos, read.repos);
    // A snapshot of another author's commits is not reused
    writeFileSync(read.snapshotPath, formatGrammars(read.repos).replace(`"author": "${GRAMMAR_AUTHOR}"`, '"author": "someone"'));
    assert.deepEqual(readGrammarRepos(fork).repos, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
