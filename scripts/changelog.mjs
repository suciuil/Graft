#!/usr/bin/env node
/**
 * Generates the fork changelog, docs/changelog.html, from the fork's git commit messages.
 *
 * Source of the entries: every commit the fork has on top of upstream Graft
 * (`git log --no-merges --cherry-pick --right-only upstream/main...HEAD`). Each line of a
 * commit message that starts with a type label becomes one entry, word for word:
 *
 *   - Feature: …          - Bug-Fix: …          - Improvement: …          - Change request: …
 *
 * ("Bug fix", "Bugfix", "Change Request (note): …" are accepted too). Plain "- …" lines right
 * after a labelled one continue it. Commits without a labelled line (for example
 * "- add more tests") are not listed. Nothing is read from the source code or the diffs.
 *
 * A git note in refs/notes/changelog counts as part of the message of the commit it is
 * attached to. Use it to add entries a published commit's message left out, without
 * rewriting history: git notes --ref=changelog append -m "- Feature: …" <commit>
 * (share it with: git push origin refs/notes/changelog).
 *
 * The entries of the hand-written fork report that came before this generator are kept in
 * changelog-legacy.json and merged in on every run (see mergeLegacy): each stays in the group
 * it was listed in, and the generated entries it already covers (its "replaces" list) are left
 * out, so nothing is listed twice.
 *
 * The local tree-sitter grammars graft builds its parsers from (the `file:../…` dependencies of
 * package.json, and theirs, such as ../tree-sitter-c) are separate git repositories. Their
 * typed lines are listed too, but only from commits by GRAMMAR_AUTHOR (the fork's own work, not
 * the third-party history), merges left out, as one short item per grammar and fork commit
 * ("The C grammar has been updated.") whose collapsed details list the lines word for word
 * (see readGrammarRepos and attachGrammarEntries). A grammar commit ships with the first fork
 * commit after it that changes that grammar's vendored package under vendor/; until then it is
 * "Not yet bundled"; all items of one grammar in one group are merged into one. A grammar line
 * that a fork commit changing the same vendored package already says in its own words is left out.
 * The fork's own lines about parsing one of those languages (see isParsingEntry) are moved behind
 * the same details link. Then every entry of the Languages area, legacy items included, goes
 * behind one short item per language and group (see groupLanguages), so the main list keeps one
 * line per language and build. What was read is kept in changelog-grammars.json, so
 * the page comes out the same on a machine that has only graft checked out (the snapshot is used
 * for every grammar repo that is not there); commit it with the changelog.
 *
 * Grouping, newest first:
 *   - "Not yet bundled": commits after the last package build.
 *   - One group per `npm run pack:bundle` run, recorded in changelog-builds.json (repo root,
 *     written by pack-bundle.mjs, committed together with the work it packed). A build ships
 *     the commit that first carries its record and every earlier commit not shipped by an
 *     earlier build. A record that is not committed yet ships every commit not shipped before.
 *   - Commits from before builds were recorded ("unrecordedThrough" and its ancestors), by the
 *     date of the commit.
 *
 * The entry area (languages, LLM, savings, …) only feeds the page's filter; it is guessed from
 * keywords in the entry text.
 *
 * Usage: node scripts/changelog.mjs [--check] [--hook] [--quiet]
 *   --check  exit 1 when docs/changelog.html is not up to date, without writing it
 *   --hook   for automatic runs after an agent prompt: never fails, prints only on change
 *   --quiet  print nothing unless the file changed
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseKitVersion } from "./kit-build.mjs";

export const CHANGELOG_RELATIVE = join("docs", "changelog.html");
export const BUILDS_RELATIVE = "changelog-builds.json";
/** Entries of the hand-written fork report that came before the generated changelog. */
export const LEGACY_RELATIVE = "changelog-legacy.json";
export const UPSTREAM_REF = "upstream/main";
/** Git notes ref whose lines are read as part of the commit message they are attached to. */
export const NOTES_REF = "refs/notes/changelog";
/** Snapshot of the typed grammar-repo commits, for machines without the sibling grammar repos. */
export const GRAMMARS_RELATIVE = "changelog-grammars.json";
/** Only grammar-repo commits whose author name or e-mail matches this (case-insensitive) are listed. */
export const GRAMMAR_AUTHOR = "suciui";

/** Entry types in page order: within a group features come first, then improvements, fixes, changes. */
export const TYPES = [
  { key: "feature", tag: "Feature", stat: "New features", button: "Features" },
  { key: "improvement", tag: "Improvement", stat: "Improvements", button: "Improvements" },
  { key: "fix", tag: "Bug fix", stat: "Bug fixes", button: "Bug fixes" },
  { key: "change", tag: "Change", stat: "Change requests", button: "Change requests" },
];

/**
 * Areas for the page filter, in display order. `rank` is the order in which their keywords are
 * tried against an entry's text: the first area whose keywords occur wins, "cli" takes the rest.
 * An area with an `also` pattern additionally lists every entry that matches it.
 */
export const AREAS = [
  {
    key: "lang",
    rank: 3,
    label: "Languages",
    title: "Languages & parsing",
    re: /grammar|parser|\blanguages?\b|tree-sitter|extractor|breadth tier|depth tier|kotlin|groovy|pl\/sql|c#|c\+\+|\bxml\b|cmake|perl|\bbash support|\bmake support|razor|\.kts\b|matlab|simulink/i,
  },
  {
    key: "llm",
    rank: 4,
    label: "LLM & deep build",
    title: "LLM providers & deep build",
    re: /--deep|deep build|\bllm\b|endpoint|gateway|provider|databricks|\brelay\b|api key|\bai\b|summar|\beffort\b|\bmodel\b/i,
  },
  {
    key: "savings",
    rank: 2,
    label: "Savings & pricing",
    title: "Savings, pricing & model detection",
    re: /saving|\bprice|\bpricing|\bpriced|ledger|dollar|\bcosts?\b|\bmtok\b|oracle/i,
  },
  {
    key: "agents",
    rank: 6,
    label: "Agent integrations",
    title: "Agent integrations",
    re: /\bagents?\b|kilo|copilot|claude|cursor|codex|windsurf|gemini|\bmcp\b|\bhooks?\b|\bskills?\b|instruction/i,
  },
  { key: "cli", rank: 7, label: "CLI & configuration", title: "CLI & configuration", re: /./ },
  { key: "privacy", rank: 1, label: "Privacy", title: "Privacy / no-cloud", re: /no-cloud|telemetry|trail cloud|third party|privacy/i },
  {
    key: "packaging",
    rank: 5,
    label: "Packaging & installer",
    title: "Packaging, installer, updates & CI",
    re: /installer|offline|\bkit\b|npm package|pack:bundle|\bbundl|ci workflow|\bregistry\b|graft upgrade|postinstall|post-install|\bnpm\b/i,
    // Installer changes are listed here too when another area's keywords win
    also: /installer|install-graft|offline kit/i,
  },
];
const AREAS_BY_RANK = [...AREAS].sort((a, b) => a.rank - b.rank);

const TYPE_LABEL =
  /(?:^|\s)-\s*(feature|bug[\s-]?fix|bugfix|improvement|change[\s-]?request)s?\s*(?:\([^)\n]*\))?\s*:\s*/gi;

function typeKey(label) {
  const l = label.toLowerCase();
  if (l.startsWith("feature")) return "feature";
  if (l.startsWith("improvement")) return "improvement";
  if (l.startsWith("change")) return "change";
  return "fix";
}

/** Joins the lines of one entry: "- " continuation bullets lose their dash, whitespace collapses. */
function entryText(raw) {
  const text = raw
    .split("\n")
    .map((line) => line.trim().replace(/^-\s+/, ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

/** The labelled entries of one commit message, in message order: [{ type, text }]. */
export function parseCommitMessage(body) {
  const msg = String(body).replace(/\r\n?/g, "\n");
  const marks = [...msg.matchAll(TYPE_LABEL)];
  const entries = [];
  marks.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : msg.length;
    const text = entryText(msg.slice(start, end));
    if (text) entries.push({ type: typeKey(m[1]), text });
  });
  return entries;
}

/** The filter area of an entry, from keywords in its text. */
export function areaOf(text) {
  return AREAS_BY_RANK.find((a) => a.re.test(text)).key;
}

/**
 * Every filter area of an entry: its main area first (guessed from the text unless given), then
 * the areas whose `also` pattern matches.
 */
export function areasOf(text, main = areaOf(text)) {
  return [main, ...AREAS.filter((a) => a.key !== main && a.also?.test(text)).map((a) => a.key)];
}

/** Today's local date as YYYY-MM-DD. */
export function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The record id of a build: "<date> <version>". */
export function buildId(date, version) {
  return `${date} ${version}`;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Escapes an entry for HTML and turns `code` spans into <code>. */
export function entryHtml(text) {
  return esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

/**
 * Sorts commits into groups.
 * @param {{ hash: string, date: string, entries: {type: string, text: string}[] }[]} commits  newest first
 * @param {{ unrecorded: Set<string>, builds: { id: string, date: string, version: string, ships: Set<string> | null }[] }} history
 *   builds in the order they were made; `ships` is every commit reachable from the commit that
 *   first carried the build's record, or null while the record is not committed yet
 * @returns {{ kind: "pending" | "bundle" | "commit", date?: string, version?: string, entries: {type, text, areas}[] }[]}  newest first
 */
export function groupCommits(commits, { unrecorded, builds }) {
  const pending = { kind: "pending", entries: [] };
  const bundles = builds.map((b) => ({ kind: "bundle", date: b.date, version: b.version, entries: [] }));
  const byDate = new Map();
  const seen = new Set();
  const firstOpen = builds.findIndex((b) => !b.ships);
  for (const c of commits) {
    let group;
    if (unrecorded.has(c.hash)) {
      if (!byDate.has(c.date)) byDate.set(c.date, { kind: "commit", date: c.date, entries: [] });
      group = byDate.get(c.date);
    } else {
      const i = builds.findIndex((b) => b.ships?.has(c.hash));
      if (i >= 0) group = bundles[i];
      else if (firstOpen >= 0) group = bundles[firstOpen];
      else group = pending;
    }
    for (const { area, ...e } of c.entries) {
      if (e.grammar) {
        // One "grammar updated" item per grammar and group; commits come newest first, so the
        // details of an older commit go in front and the list reads oldest first
        const same = group.entries.find((x) => x.grammar === e.grammar);
        if (same) same.details = [...e.details, ...same.details];
        else group.entries.push({ ...e, details: [...e.details], areas: areasOf(e.text, area), key: null });
        continue;
      }
      // The same sentence committed twice is listed once, where it first shipped (oldest wins below)
      const key = `${e.type}\u0000${e.text.toLowerCase()}`;
      group.entries.push({ ...e, areas: areasOf(e.text, area), key });
    }
  }
  // By type; within a type the grammar items come last, by language
  const order = (g) =>
    g.entries.sort(
      (a, b) =>
        TYPES.findIndex((t) => t.key === a.type) - TYPES.findIndex((t) => t.key === b.type) ||
        (a.grammar ? 1 : 0) - (b.grammar ? 1 : 0) ||
        (a.grammar && b.grammar ? a.text.localeCompare(b.text, "en") : 0),
    );
  const groups = [pending, ...bundles.reverse(), ...[...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))];
  // Drop repeats, keeping the oldest occurrence: walk oldest group first
  for (const g of [...groups].reverse()) {
    g.entries = [...g.entries].reverse().filter((e) => e.key === null || (!seen.has(e.key) && seen.add(e.key))).reverse();
  }
  for (const g of groups) {
    order(g);
    for (const e of g.entries) delete e.key;
  }
  return groups;
}

/** The plain text of an entry's HTML: tags removed, the usual entities decoded, whitespace collapsed. */
export function htmlText(html) {
  return String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Merges the entries of the earlier hand-written report (changelog-legacy.json) into the groups
 * made by groupCommits, removing duplicates:
 *   - a generated entry named in a legacy item's `replaces` list (exact text), or with the same
 *     type and text as a legacy item, is left out: the legacy item already covers it;
 *   - each legacy item goes into the group it was listed in: the package build with its `version`,
 *     otherwise the commit group of its `date` (created when no commit of that date has entries).
 * Within a type, legacy items come before generated entries. Commit groups left empty are dropped.
 * @param {ReturnType<typeof groupCommits>} groups
 * @param {{ date: string, version?: string, type: string, area: string, html: string, replaces?: string[] }[]} legacy
 * @returns {{ groups: ReturnType<typeof groupCommits>, unmatched: string[] }}  unmatched: `replaces`
 *   texts no generated entry has (a commit message or note was changed, or the entry is gone)
 */
export function mergeLegacy(groups, legacy) {
  const items = legacy.map((item) => {
    const text = htmlText(item.html);
    return { type: item.type, text, html: item.html, areas: areasOf(text, item.area), legacy: true, item };
  });
  const replaced = new Set(legacy.flatMap((item) => item.replaces ?? []));
  const same = new Set(items.map((e) => `${e.type}\u0000${e.text.toLowerCase()}`));
  const found = new Set();
  let out = groups.map((g) => ({
    ...g,
    entries: g.entries.filter((e) => {
      if (replaced.has(e.text)) {
        found.add(e.text);
        return false;
      }
      return !same.has(`${e.type}\u0000${e.text.toLowerCase()}`);
    }),
  }));
  for (const e of items) {
    const { date, version } = e.item;
    let group = version ? out.find((g) => g.kind === "bundle" && g.version === version) : undefined;
    group ??= out.find((g) => g.kind === "commit" && g.date === date);
    if (!group) {
      group = { kind: "commit", date, entries: [] };
      out.push(group);
    }
    delete e.item;
    group.entries.push(e);
  }
  const commits = out.filter((g) => g.kind === "commit" && g.entries.length).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  out = [...out.filter((g) => g.kind !== "commit"), ...commits];
  const rank = (e) => TYPES.findIndex((t) => t.key === e.type) * 2 + (e.legacy ? 0 : 1);
  for (const g of out) g.entries.sort((a, b) => rank(a) - rank(b));
  return { groups: out, unmatched: [...replaced].filter((t) => !found.has(t)) };
}

/** The collapsed list of a language item's changes, opened by its "details" link. */
function detailsHtml(details) {
  const items = details
    .map((d) => `<li data-type="${d.type}"><span class="tag">${TYPES.find((x) => x.key === d.type).tag}</span><span>${d.html ?? entryHtml(d.text)}</span></li>`)
    .join("");
  const n = details.length;
  return `<details class="more"><summary>details: ${n} change${n === 1 ? "" : "s"}</summary><ul class="details">${items}</ul></details>`;
}

function renderGroup(g) {
  const items = g.entries
    .map((e) => {
      const t = TYPES.find((x) => x.key === e.type);
      const labels = e.areas.map((k) => `<span class="area">${esc(AREAS.find((x) => x.key === k).label)}</span>`).join("");
      const body = (e.html ?? entryHtml(e.text)) + (e.details?.length ? ` ${detailsHtml(e.details)}` : "");
      const types = e.types?.length > 1 ? ` data-types="${e.types.join(" ")}"` : "";
      return `    <li data-type="${e.type}"${types} data-area="${e.areas.join(" ")}"><span class="tag">${t.tag}</span><span>${labels}${body}</span></li>\n`;
    })
    .join("");
  if (g.kind === "pending") {
    return `<div class="group" data-group="pending">\n  <h2>Not yet bundled <small>goes into the next <code>npm run pack:bundle</code></small></h2>\n  <ul>\n${items}  </ul>\n</div>\n`;
  }
  if (g.kind === "bundle") {
    const kit = parseKitVersion(g.version);
    const label = kit ? `kit ${g.version}, graft ${kit.version}` : `package build ${g.version}`;
    return `<div class="group" data-group="bundle" data-date="${g.date}" data-version="${esc(g.version)}">\n  <h2>${g.date} <small>${esc(label)}</small></h2>\n  <ul>\n${items}  </ul>\n</div>\n`;
  }
  return `<div class="group" data-group="commit" data-date="${g.date}">\n  <h2>${g.date} <small>first committed; build date not recorded</small></h2>\n  <ul>\n${items}  </ul>\n</div>\n`;
}

function replaceRegion(html, name, body) {
  const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
  if (!re.test(html)) throw new Error(`${CHANGELOG_RELATIVE} lacks the <!-- ${name}:start/end --> markers`);
  return html.replace(re, (_, start, end) => `${start}\n${body}${end}`);
}

/** Fills the generated regions (stats, counts, changes) of the changelog page. */
export function renderChangelog(html, groups) {
  const all = groups.flatMap((g) => g.entries);
  const n = (type, area) => all.filter((e) => (!type || e.type === type) && (!area || e.areas.includes(area))).length;
  const stats =
    TYPES.map((t) => `  <div class="stat ${t.key}"><b>${n(t.key)}</b><span>${t.stat}</span></div>\n`).join("") +
    `  <div class="stat"><b>${all.length}</b><span>Items in total</span></div>\n`;
  const cols = ["feature", "fix", "improvement", "change"];
  const counts =
    AREAS.map(
      (a) =>
        `      <tr><td><a data-area="${a.key}">${esc(a.title)}</a></td>${cols.map((c) => `<td>${n(c, a.key)}</td>`).join("")}<td>${n(null, a.key)}</td></tr>\n`,
    ).join("") + `      <tr class="total"><td>Total</td>${cols.map((c) => `<td>${n(c)}</td>`).join("")}<td>${all.length}</td></tr>\n`;
  // "All areas" comes first: the browser selects the first option, so the page opens unfiltered
  const areas =
    `    <option value="all" selected>All areas</option>\n` + AREAS.map((a) => `    <option value="${a.key}">${esc(a.title)}</option>\n`).join("");
  let out = replaceRegion(html, "stats", stats);
  out = replaceRegion(out, "counts", counts);
  out = replaceRegion(out, "areas", areas);
  out = replaceRegion(out, "changes", groups.map(renderGroup).join("\n"));
  return out;
}

/** Reads changelog-builds.json ({ unrecordedThrough?, builds: [{ id, date, version, commit? }] }); empty when absent. */
export function readBuilds(repoRoot) {
  const path = join(repoRoot, BUILDS_RELATIVE);
  if (!existsSync(path)) return { builds: [] };
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data.builds)) throw new Error(`${path} has no "builds" list`);
  return data;
}

/** Reads changelog-legacy.json ({ items: [{ date, version?, type, area, html, replaces? }] }); empty when absent. */
export function readLegacy(repoRoot) {
  const path = join(repoRoot, LEGACY_RELATIVE);
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  if (!Array.isArray(data.items)) throw new Error(`${path} has no "items" list`);
  for (const item of data.items) {
    if (!TYPES.some((t) => t.key === item.type)) throw new Error(`${path}: unknown type "${item.type}"`);
    if (!AREAS.some((a) => a.key === item.area)) throw new Error(`${path}: unknown area "${item.area}"`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date ?? "") || typeof item.html !== "string") throw new Error(`${path}: an item lacks its date or html`);
  }
  return data.items;
}

/** The text pack-bundle writes to changelog-builds.json. */
export function formatBuilds(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** Adds a build record (once per date and version) and returns the new data. */
export function addBuild(data, date, version) {
  const id = buildId(date, version);
  if (data.builds.some((b) => b.id === id)) return data;
  return { ...data, builds: [...data.builds, { id, date, version }] };
}

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

function reachable(repoRoot, commit) {
  return new Set(git(repoRoot, ["rev-list", "--no-merges", commit, `^${UPSTREAM_REF}`]).split("\n").filter(Boolean));
}

/** The fork's commits (newest first) and the build history, read from git. */
export function readHistory(repoRoot, buildsData) {
  try {
    git(repoRoot, ["rev-parse", "--verify", "-q", `${UPSTREAM_REF}^{commit}`]);
  } catch {
    throw new Error(`no ${UPSTREAM_REF} ref — add and fetch the upstream remote (NanoNets/Graft) so the fork's own commits can be told apart`);
  }
  const log = git(repoRoot, [
    "log",
    "--no-merges",
    "--cherry-pick",
    "--right-only",
    "--date=short",
    "--no-notes",
    `--notes=${NOTES_REF}`,
    "--format=%H%x1f%ad%x1f%B%x1f%N%x1e",
    `${UPSTREAM_REF}...HEAD`,
  ]);
  const commits = log
    .split("\x1e")
    .map((rec) => rec.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [hash, date, body, note] = rec.split("\x1f");
      // A changelog note adds lines to the commit message without rewriting the commit
      return { hash, date, entries: parseCommitMessage(`${body ?? ""}\n\n${note ?? ""}`) };
    });
  const unrecorded = buildsData.unrecordedThrough ? reachable(repoRoot, buildsData.unrecordedThrough) : new Set();
  const builds = buildsData.builds.map((b) => {
    let commit = b.commit;
    if (!commit) {
      // The commit that first carried this record ships the build; none yet while it is uncommitted
      const found = git(repoRoot, ["log", "--reverse", "--format=%H", `-S${b.id}`, "HEAD", "--", BUILDS_RELATIVE]).split("\n").filter(Boolean);
      commit = found[0];
    }
    return { id: b.id, date: b.date, version: b.version, ships: commit ? reachable(repoRoot, commit) : null };
  });
  return { commits, unrecorded, builds };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

/** The `file:` dependencies of a package.json, as absolute directories. */
function fileDependencies(dir) {
  const pkg = readJson(join(dir, "package.json"));
  if (!pkg) return [];
  const deps = { ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.dependencies };
  return Object.values(deps)
    .filter((v) => typeof v === "string" && v.startsWith("file:"))
    .map((v) => resolve(dir, v.slice("file:".length)));
}

/**
 * The local grammar repositories graft builds from: the `file:` dependencies of package.json
 * that are git repositories, and their own `file:` dependencies (tree-sitter-css, which
 * tree-sitter-css-in-js is generated from). `package` is the name of the package graft vendors,
 * which ships the repository's changes: its own for a direct dependency, the depending
 * package's for a transitive one. Repositories not checked out are left out.
 * @returns {{ repo: string, path: string, package: string }[]}  sorted by repo
 */
export function localGrammarRepos(repoRoot) {
  const found = new Map();
  const visit = (dir, ships) => {
    const key = dir.toLowerCase();
    if (found.has(key) || !existsSync(join(dir, ".git"))) return;
    const name = readJson(join(dir, "package.json"))?.name;
    if (!name) return;
    const pkg = ships ?? name;
    found.set(key, { repo: basename(dir), path: dir, package: pkg });
    for (const dep of fileDependencies(dir)) visit(dep, pkg);
  };
  for (const dir of fileDependencies(repoRoot)) visit(dir, null);
  return [...found.values()].sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
}

/** The typed, non-merge commits of a grammar repository by GRAMMAR_AUTHOR, oldest first. */
export function readGrammarCommits(path) {
  const log = git(path, [
    "log",
    "--no-merges",
    `--author=${GRAMMAR_AUTHOR}`,
    "--regexp-ignore-case",
    "--date=short",
    "--no-notes",
    `--notes=${NOTES_REF}`,
    "--format=%H%x1f%ct%x1f%ad%x1f%B%x1f%N%x1e",
    "HEAD",
  ]);
  return log
    .split("\x1e")
    .map((rec) => rec.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [hash, time, date, body, note] = rec.split("\x1f");
      return { hash, time: Number(time), date, entries: parseCommitMessage(`${body ?? ""}\n\n${note ?? ""}`) };
    })
    .filter((c) => c.entries.length)
    .reverse();
}

/** The text written to changelog-grammars.json. */
export function formatGrammars(repos) {
  const data = {
    about:
      "Generated by scripts/changelog.mjs from the commits of the local tree-sitter grammar repositories; used when they are not checked out. Do not edit.",
    author: GRAMMAR_AUTHOR,
    repos: repos.map(({ repo, package: pkg, commits }) => ({ repo, package: pkg, commits })),
  };
  return `${JSON.stringify(data, null, 2)}\n`;
}

/**
 * The grammar repositories and their typed commits: read from the checked-out sibling
 * repositories, and from the snapshot (changelog-grammars.json) for those that are not there.
 * @returns {{ repos: { repo: string, package: string, commits: { hash: string, time: number, date: string, entries: {type: string, text: string}[] }[] }[], snapshot: string, snapshotPath: string, snapshotChanged: boolean }}
 */
export function readGrammarRepos(repoRoot) {
  const snapshotPath = join(repoRoot, GRAMMARS_RELATIVE);
  const before = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8") : "";
  const stored = before ? readJson(snapshotPath) : null;
  if (before && !Array.isArray(stored?.repos)) throw new Error(`${snapshotPath} has no "repos" list`);
  // A snapshot written for another author is not reused: its commits would be the wrong ones
  const byRepo = new Map(stored && stored.author === GRAMMAR_AUTHOR ? stored.repos.map((r) => [r.repo, r]) : []);
  for (const { repo, path, package: pkg } of localGrammarRepos(repoRoot)) {
    try {
      byRepo.set(repo, { repo, package: pkg, commits: readGrammarCommits(path) });
    } catch {
      // An unreadable checkout keeps what the snapshot has for it
    }
  }
  const repos = [...byRepo.values()].filter((r) => r.commits.length).sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
  const snapshot = repos.length || before ? formatGrammars(repos) : "";
  // A Windows checkout holds the committed file with CRLF (core.autocrlf, `* text=auto`):
  // line endings are not a change, or every run would report one
  return { repos, snapshot, snapshotPath, snapshotChanged: snapshot !== before.replace(/\r\n/g, "\n") };
}

/**
 * Whether a vendored file (a path under vendor/) belongs to the package: its packed tarball
 * (vendor/<scope->name-<version>.tgz) or its prebuilt binding (vendor/<key>/prebuilds/<platform>/<[scope+]name>.node).
 */
export function isVendoredFile(file, pkg) {
  const name = pkg.replace(/^@[^/]+\//, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`^vendor/(?:[^/]*-)?${name}-\\d[^/]*\\.tgz$`).test(file) ||
    new RegExp(`^vendor/[^/]+/prebuilds/[^/]+/(?:[^/]*[+-])?${name}\\.node$`).test(file)
  );
}

const STOP_WORDS = new Set(
  "the and for are now with such that this from into not its was has have can also than then when which their them they these those one two all any per but other more longer".split(" "),
);

/** The significant words of an entry, for telling whether another entry already says it. */
function significantWords(text) {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9_$@#]+/g) ?? [])
      .map((w) => (w.length > 3 ? w.replace(/s$/, "") : w))
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
  );
}

/**
 * Whether one of the `others` entries already says `text`: at least `ratio` of its significant
 * words occur in that entry. Entries of fewer than four significant words never count as said.
 */
export function alreadySaid(text, others, ratio = 0.8) {
  const words = significantWords(text);
  if (words.size < 4) return false;
  return others.some((other) => {
    const set = other instanceof Set ? other : significantWords(other);
    let hits = 0;
    for (const w of words) if (set.has(w)) hits++;
    return hits / words.size >= ratio;
  });
}

/** Language names of the grammar repositories whose name is not just the language capitalised. */
const GRAMMAR_NAMES = {
  c: "C",
  cpp: "C++",
  "c-sharp": "C#",
  cmake: "CMake",
  css: "CSS",
  "css-in-js": "CSS-in-JS",
  csv: "CSV",
  html: "HTML",
  json: "JSON",
  matlab: "MATLAB",
  plsql: "PL/SQL",
  scss: "SCSS",
  xml: "XML",
  yaml: "YAML",
};

/** The language a grammar repository parses: "tree-sitter-c-sharp" → "C#", "tree-sitter-kotlin-grammar" → "Kotlin". */
export function grammarName(repo) {
  const key = repo.replace(/^tree-sitter-/, "").replace(/-grammar$/, "");
  return GRAMMAR_NAMES[key] ?? key.replace(/(^|-)([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/** Other words an entry may name a grammar's language by. */
const GRAMMAR_ALIASES = { make: ["Makefiles?"] };

/** Whether a text names a language, by its name or an alias regex ("C" is not "C++" or "C#"). */
function namesLanguage(text, name, aliases = []) {
  const names = [name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), ...aliases];
  return new RegExp(`(?<![\\w#+-])(?:${names.join("|")})(?![\\w#+-])`).test(text);
}

/** Whether an entry's text names the language of a grammar repository ("C" is not "C++" or "C#"). */
export function namesGrammar(text, repo) {
  const key = repo.replace(/^tree-sitter-/, "").replace(/-grammar$/, "");
  // "C# Razor" is the Razor grammar, not C#
  return namesLanguage(key === "c-sharp" ? text.replace(/C# Razor/g, "Razor") : text, grammarName(repo), GRAMMAR_ALIASES[key]);
}

/** Languages graft reads with grammars that are not the fork's own, for grouping the Languages entries. */
const OTHER_LANGUAGES = ["Python", "JavaScript", "TypeScript", "Java", "Go", "Rust", "Ruby", "PHP", "Swift", "Scala", "Lua"];
/** The item Languages entries that name no language go under. */
export const OTHER_LANGUAGE = "Other";

/** The first sentence of an entry, which says what it is about. */
function firstSentence(text) {
  return (/^.*?[.!?](?=\s+["'A-Z]|$)/.exec(text)?.[0] ?? text).trim();
}

/**
 * Puts every Languages entry of a group (main area "lang") behind one short item per language,
 * so the main list keeps one line per language and build whose details link lists them: the
 * grammar items of attachGrammarEntries, the commit-message entries and the legacy items about
 * that language. An entry naming several languages is listed under each, and one naming none
 * under OTHER_LANGUAGE. The item says "<Language> support has been added." when a feature in it
 * announces the language's support, "The <Language> grammar has been updated." when it holds
 * grammar or parsing changes of a fork grammar, and "<Language> support has been updated."
 * otherwise. Its type is the first of TYPES among its details, and `types` lists all of them for
 * the type filter. Details come by type, in the order they were listed within a type.
 * @param {ReturnType<typeof groupCommits>} groups
 * @param {string[]} repos  the grammar repositories (for the language names)
 */
export function groupLanguages(groups, repos) {
  const languages = [
    ...repos.map((repo) => ({ name: grammarName(repo), repo })),
    ...OTHER_LANGUAGES.map((name) => ({ name, repo: null })),
  ].filter((l, i, all) => all.findIndex((x) => x.name === l.name) === i);
  const typeIndex = (type) => TYPES.findIndex((t) => t.key === type);
  return groups.map((g) => {
    const buckets = new Map();
    const bucket = (name, repo) => {
      if (!buckets.has(name)) buckets.set(name, { name, repo, details: [], also: new Set() });
      return buckets.get(name);
    };
    const rest = [];
    for (const e of g.entries) {
      if (e.areas[0] !== "lang") {
        rest.push(e);
        continue;
      }
      if (e.grammar) {
        const b = bucket(grammarName(e.grammar), e.grammar);
        b.details.push(...e.details.map((d) => ({ ...d, grammar: true, fromGrammar: true })));
        continue;
      }
      const detail = { type: e.type, text: e.text, ...(e.html ? { html: e.html } : {}), grammar: isParsingEntry(e.text, e.type) };
      const named = languages.filter((l) => (l.repo ? namesGrammar(e.text, l.repo) : namesLanguage(e.text, l.name)));
      for (const l of named.length ? named : [{ name: OTHER_LANGUAGE, repo: null }]) {
        const b = bucket(l.name, l.repo);
        b.details.push(detail);
        for (const a of e.areas.slice(1)) b.also.add(a);
      }
    }
    const items = [...buckets.values()].map((b) => {
      const seen = new Set();
      const details = b.details
        .filter((d) => !seen.has(d.text) && seen.add(d.text))
        .map((d, i) => ({ d, i }))
        .sort((x, y) => typeIndex(x.d.type) - typeIndex(y.d.type) || x.i - y.i)
        .map(({ d: { grammar, fromGrammar, ...d } }) => d);
      const types = TYPES.map((t) => t.key).filter((t) => details.some((d) => d.type === t));
      // Only graft's own entries announce a language, not the lines of its grammar repository
      const announced = b.details.some(
        (d) => !d.fromGrammar && d.type === "feature" && /^[^.]{0,40}\bsupport\b/i.test(firstSentence(d.text)) && namesLanguage(firstSentence(d.text), b.name),
      );
      const text =
        b.name === OTHER_LANGUAGE
          ? "Other changes to language support and parsing."
          : announced
            ? `${b.name} support has been added.`
            : b.repo && b.details.some((d) => d.grammar)
              ? `The ${b.name} grammar has been updated.`
              : `${b.name} support has been updated.`;
      return { type: types[0], types, text, areas: ["lang", ...b.also], language: b.name, details };
    });
    // By type; within a type the language items come last, by language, "Other" last
    const rank = (e) => typeIndex(e.type) * 3 + (e.language ? 2 : e.legacy ? 0 : 1);
    const other = (e) => (e.language === OTHER_LANGUAGE ? 1 : 0);
    const entries = [...rest, ...items].sort(
      (a, b) => rank(a) - rank(b) || (a.language && b.language ? other(a) - other(b) || a.language.localeCompare(b.language, "en") : 0),
    );
    return { ...g, entries };
  });
}

/**
 * Whether a fork commit's entry is about how files of a language are parsed (parse and syntax
 * errors, what is recognised or read correctly, rebuilt parsers), as opposed to a new language
 * or another feature of graft: such entries go behind the grammar's details link too. Only the
 * first sentence counts, which says what the entry is about. A feature counts only when it is
 * about syntax or parse errors and not about what the index or graph now holds.
 */
export function isParsingEntry(text, type = "fix") {
  const first = (/^.*?[.!?](?=\s+["'A-Z]|$)/.exec(text)?.[0] ?? text).trim();
  // "Bash support (.sh, …)", "MATLAB and Simulink support." announce a language, not a fix;
  // entries about this changelog only name the parser work it lists
  if (/^[^.]{0,40}\bsupport\b/i.test(first) || /\bchangelog\b/i.test(first)) return false;
  if (type === "feature") return /syntax errors?|parse errors?|\bparses?\b/i.test(first) && !/\bindex|\bgraph\b|show up/i.test(first);
  return /\bpars(?:e|es|ed|er|ers|ing)\b|syntax errors?|recogni[sz]ed|\bno longer (?:read as|breaks|swallows)\b|\bread (?:correctly|in full|more|without)\b/i.test(first);
}

/**
 * Adds the grammar repositories' changes to the fork commits that ship them: the first fork
 * commit (by commit time) at or after the grammar commit that changes a vendored file of its
 * package. Changes no fork commit ships yet go into a pending pseudo-commit (hash "") at the
 * front. Each fork commit gets one short item per grammar ("The C grammar has been updated.",
 * filed under "lang") whose `details` are that grammar's lines, word for word, oldest first,
 * followed by the fork commit's own entries about parsing that language (see namesGrammar and
 * isParsingEntry), which leave the main list; an entry naming several such languages is listed
 * under each. A grammar line the fork commits that change the same vendored package already say
 * (see alreadySaid) is left out, and a grammar with no line left gets no item.
 * @param {{ hash: string, date: string, entries: object[] }[]} commits  the fork's commits, newest first
 * @param {ReturnType<typeof readGrammarRepos>["repos"]} repos
 * @param {{ hash: string, time: number, files: string[] }[]} vendorLog  the fork commits that change vendor/
 * @returns {typeof commits}  a new list; the commits passed in are not changed
 */
export function attachGrammarEntries(commits, repos, vendorLog) {
  const out = commits.map((c) => ({ ...c, entries: [...c.entries] }));
  const byHash = new Map(out.map((c) => [c.hash, c]));
  const own = new Map(commits.map((c) => [c.hash, c.entries]));
  const pending = { hash: "", date: "", entries: [] };
  const items = new Map();
  const itemFor = (target, repo) => {
    const key = `${target.hash}\u0000${repo}`;
    if (!items.has(key)) {
      const item = { type: "improvement", text: `The ${grammarName(repo)} grammar has been updated.`, area: "lang", grammar: repo, details: [] };
      items.set(key, item);
      target.entries.push(item);
    }
    return items.get(key);
  };
  for (const { repo, package: pkg, commits: grammarCommits } of repos) {
    const ships = vendorLog
      .filter((v) => byHash.has(v.hash) && v.files.some((f) => isVendoredFile(f, pkg)))
      .sort((a, b) => a.time - b.time);
    // Only the fork commits' own words count, not grammar items attached to them before
    const said = ships.flatMap((v) => own.get(v.hash) ?? []).map((e) => significantWords(e.text));
    for (const g of grammarCommits) {
      const ship = ships.find((v) => v.time >= g.time);
      const target = ship ? byHash.get(ship.hash) : pending;
      const details = g.entries.filter((e) => !alreadySaid(e.text, said)).map((e) => ({ type: e.type, text: e.text }));
      if (!details.length) continue;
      if (!ship && g.date > pending.date) pending.date = g.date;
      itemFor(target, repo).details.push(...details);
    }
  }
  // The grammar repositories' own lines per commit and grammar, before fork lines join them
  const grammarLines = new Map([...items].map(([key, item]) => [key, item.details.map((d) => d.text)]));
  // The fork commits' own lines about parsing a language one of the grammars parses
  for (const commit of out) {
    for (const e of own.get(commit.hash)) {
      if (!isParsingEntry(e.text, e.type)) continue;
      let named = repos.map((r) => r.repo).filter((repo) => namesGrammar(e.text, repo));
      // A line naming no language goes with the grammar lines of this commit that mostly say it
      if (!named.length) {
        named = repos
          .map((r) => r.repo)
          .filter((repo) => alreadySaid(e.text, grammarLines.get(`${commit.hash}\u0000${repo}`) ?? [], 0.6));
      }
      if (!named.length) continue;
      commit.entries = commit.entries.filter((x) => x !== e);
      for (const repo of named) itemFor(commit, repo).details.push({ type: e.type, text: e.text });
    }
  }
  return pending.entries.length ? [pending, ...out] : out;
}

/** The fork's commits that change files under vendor/, with those files. */
function readVendorLog(repoRoot) {
  const log = git(repoRoot, ["log", "--no-merges", "--format=%x1e%H%x1f%ct", "--name-only", `${UPSTREAM_REF}..HEAD`, "--", "vendor"]);
  return log
    .split("\x1e")
    .filter((rec) => rec.trim())
    .map((rec) => {
      const [head, ...files] = rec.split("\n");
      const [hash, time] = head.split("\x1f");
      return { hash, time: Number(time), files: files.map((f) => f.trim()).filter(Boolean) };
    });
}

/**
 * The regenerated changelog page; `buildsData` defaults to changelog-builds.json and `legacy` to
 * the items of changelog-legacy.json. `grammars` is the regenerated snapshot of the grammar
 * repositories (changelog-grammars.json) and whether it differs from the file.
 */
export function generateChangelog(repoRoot, buildsData = readBuilds(repoRoot), legacy = readLegacy(repoRoot)) {
  const path = join(repoRoot, CHANGELOG_RELATIVE);
  const before = readFileSync(path, "utf8");
  const history = readHistory(repoRoot, buildsData);
  const grammars = readGrammarRepos(repoRoot);
  const commits = grammars.repos.length ? attachGrammarEntries(history.commits, grammars.repos, readVendorLog(repoRoot)) : history.commits;
  const merged = mergeLegacy(groupCommits(commits, history), legacy);
  const { unmatched } = merged;
  const groups = groupLanguages(merged.groups, grammars.repos.map((r) => r.repo));
  const html = renderChangelog(before, groups);
  return {
    path,
    before,
    html,
    changed: html !== before,
    groups,
    unmatched,
    grammars: { path: grammars.snapshotPath, text: grammars.snapshot, changed: grammars.snapshotChanged },
  };
}

async function main(argv) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const hook = argv.includes("--hook");
  const quiet = hook || argv.includes("--quiet");
  try {
    const { path, html, changed, groups, unmatched, grammars } = generateChangelog(repoRoot);
    const pending = groups.find((g) => g.kind === "pending").entries.length;
    if (unmatched.length && !hook) {
      console.error(`! ${LEGACY_RELATIVE}: ${unmatched.length} "replaces" text(s) match no commit-message entry any more, so nothing is left out for them:`);
      for (const t of unmatched) console.error(`  - ${t.length > 100 ? `${t.slice(0, 100)}…` : t}`);
    }
    if (argv.includes("--check")) {
      if (changed || grammars.changed) {
        console.error(`✗ ${changed ? CHANGELOG_RELATIVE : GRAMMARS_RELATIVE} is out of date — run npm run changelog`);
        return 1;
      }
      if (!quiet) console.log(`✓ ${CHANGELOG_RELATIVE} is up to date`);
      return 0;
    }
    if (grammars.changed) {
      writeFileSync(grammars.path, grammars.text);
      console.log(`✓ updated ${GRAMMARS_RELATIVE} from the local grammar repositories — commit it with ${CHANGELOG_RELATIVE}`);
    }
    if (changed) writeFileSync(path, html);
    if (changed || !quiet) {
      const all = groups.flatMap((g) => g.entries);
      const old = all.filter((e) => e.legacy).length;
      console.log(
        `${changed ? "✓ regenerated" : "✓ unchanged:"} ${CHANGELOG_RELATIVE} — ${all.length} entries (${all.length - old} from commit messages, ${old} from the earlier hand-written report), ${pending} not yet bundled`,
      );
    }
    return 0;
  } catch (err) {
    console.error(`${hook ? "!" : "✗"} fork changelog not regenerated: ${err.message}`);
    return hook ? 0 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
