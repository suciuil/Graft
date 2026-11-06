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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseKitVersion } from "./kit-build.mjs";

export const CHANGELOG_RELATIVE = join("docs", "changelog.html");
export const BUILDS_RELATIVE = "changelog-builds.json";
/** Entries of the hand-written fork report that came before the generated changelog. */
export const LEGACY_RELATIVE = "changelog-legacy.json";
export const UPSTREAM_REF = "upstream/main";
/** Git notes ref whose lines are read as part of the commit message they are attached to. */
export const NOTES_REF = "refs/notes/changelog";

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
    re: /grammar|parser|\blanguages?\b|tree-sitter|extractor|breadth tier|depth tier|kotlin|groovy|pl\/sql|c#|c\+\+|\bxml\b|cmake|perl|\bbash support|\bmake support|razor|\.kts\b/i,
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
    for (const e of c.entries) {
      // The same sentence committed twice is listed once, where it first shipped (oldest wins below)
      const key = `${e.type}\u0000${e.text.toLowerCase()}`;
      group.entries.push({ ...e, areas: areasOf(e.text), key });
    }
  }
  const order = (g) =>
    g.entries.sort((a, b) => TYPES.findIndex((t) => t.key === a.type) - TYPES.findIndex((t) => t.key === b.type));
  const groups = [pending, ...bundles.reverse(), ...[...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))];
  // Drop repeats, keeping the oldest occurrence: walk oldest group first
  for (const g of [...groups].reverse()) {
    g.entries = [...g.entries].reverse().filter((e) => !seen.has(e.key) && seen.add(e.key)).reverse();
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

function renderGroup(g) {
  const items = g.entries
    .map((e) => {
      const t = TYPES.find((x) => x.key === e.type);
      const labels = e.areas.map((k) => `<span class="area">${esc(AREAS.find((x) => x.key === k).label)}</span>`).join("");
      const body = e.html ?? entryHtml(e.text);
      return `    <li data-type="${e.type}" data-area="${e.areas.join(" ")}"><span class="tag">${t.tag}</span><span>${labels}${body}</span></li>\n`;
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

/**
 * The regenerated changelog page; `buildsData` defaults to changelog-builds.json and `legacy` to
 * the items of changelog-legacy.json.
 */
export function generateChangelog(repoRoot, buildsData = readBuilds(repoRoot), legacy = readLegacy(repoRoot)) {
  const path = join(repoRoot, CHANGELOG_RELATIVE);
  const before = readFileSync(path, "utf8");
  const { commits, unrecorded, builds } = readHistory(repoRoot, buildsData);
  const { groups, unmatched } = mergeLegacy(groupCommits(commits, { unrecorded, builds }), legacy);
  const html = renderChangelog(before, groups);
  return { path, before, html, changed: html !== before, groups, unmatched };
}

async function main(argv) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const hook = argv.includes("--hook");
  const quiet = hook || argv.includes("--quiet");
  try {
    const { path, html, changed, groups, unmatched } = generateChangelog(repoRoot);
    const pending = groups.find((g) => g.kind === "pending").entries.length;
    if (unmatched.length && !hook) {
      console.error(`! ${LEGACY_RELATIVE}: ${unmatched.length} "replaces" text(s) match no commit-message entry any more, so nothing is left out for them:`);
      for (const t of unmatched) console.error(`  - ${t.length > 100 ? `${t.slice(0, 100)}…` : t}`);
    }
    if (argv.includes("--check")) {
      if (changed) {
        console.error(`✗ ${CHANGELOG_RELATIVE} is out of date — run npm run changelog`);
        return 1;
      }
      if (!quiet) console.log(`✓ ${CHANGELOG_RELATIVE} is up to date`);
      return 0;
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
