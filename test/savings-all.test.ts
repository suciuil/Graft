/**
 * `graft savings --all`: the user-level list of folders graft has filed a saving
 * in (`~/.graft/repos.json`), and the cross-repo roll-up that reads each one's
 * own ledger — every repo priced at its own rate, summed, never re-priced as one.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { codexCwdFrom, knownFolders, recentProjectsFrom } from '../src/hosts/known-folders.js';
import {
  aggregateAllSavings,
  formatAllSavingsReport,
  ledgerPath,
  recordSavedTokens,
  recordTurnBilling,
  registerExistingLedger,
} from '../src/claude/ledger.js';
import {
  locateLedger,
  readRepoRegistry,
  registerDiscovered,
  registerRepo,
  repoRegistryPath,
  resetRegistryMemo,
} from '../src/claude/repo-registry.js';
import { runCli } from './helpers.js';

const fresh = (tag: string) => mkdtempSync(join(tmpdir(), `graft-all-${tag}-`));
const day = (s: string) => new Date(`${s}T12:00:00`);

// Each test gets its own registry file, so none reads another's repos — and
// none ever touches the real ~/.graft/repos.json, even when this file is run on
// its own rather than through scripts/run-tests.mjs.
let registry = '';
beforeEach(() => {
  registry = join(fresh('registry'), 'repos.json');
  process.env.GRAFT_REPOS_FILE = registry;
  resetRegistryMemo();
});

// ── the registry ──────────────────────────────────────────────────────────

test('GRAFT_REPOS_FILE overrides the profile path; the default is ~/.graft/repos.json', () => {
  assert.equal(repoRegistryPath({ GRAFT_REPOS_FILE: registry }), registry);
  assert.equal(repoRegistryPath({}, join('h', 'me')), join('h', 'me', '.graft', 'repos.json'));
});

test('filing a saving registers the repo, once however many savings follow', () => {
  const a = fresh('a');
  recordSavedTokens(a, 'claude-opus-5', 100, day('2026-09-08'));
  recordSavedTokens(a, 'claude-opus-5', 200, day('2026-09-08'));
  recordSavedTokens(a, 'claude-sonnet-5', 300, day('2026-09-09'));

  const repos = readRepoRegistry(registry).repos;
  assert.equal(repos.length, 1);
  assert.equal(repos[0].ledger, ledgerPath(a));
  assert.ok(repos[0].lastSeen >= repos[0].firstSeen);
});

test('turn billing registers the repo too — it goes through the same funnel', () => {
  const a = fresh('bill');
  recordTurnBilling(a, [{ model: 'claude-opus-5', costMicros: 1, tokens: 1 }], day('2026-09-08'));
  assert.equal(readRepoRegistry(registry).repos.length, 1);
});

test('one folder spelled two ways is one entry on case-insensitive systems', { skip: process.platform === 'linux' }, () => {
  const a = fresh('case');
  registerRepo(a, ledgerPath(a), { file: registry });
  resetRegistryMemo();
  registerRepo(a.toUpperCase(), ledgerPath(a), { file: registry });
  assert.equal(readRepoRegistry(registry).repos.length, 1);
});

test('a backfill adds a missing repo but never moves lastSeen', () => {
  const a = fresh('backfill');
  registerRepo(a, ledgerPath(a), { file: registry, when: day('2026-01-01') });
  resetRegistryMemo();
  registerRepo(a, ledgerPath(a), { file: registry, when: day('2026-09-08'), touch: false });
  assert.equal(readRepoRegistry(registry).repos[0].lastSeen.slice(0, 10), day('2026-01-01').toISOString().slice(0, 10));
});

test('registerExistingLedger lists a repo whose ledger predates the registry, and ignores one with none', () => {
  const old = fresh('old');
  mkdirSync(join(old, 'graft', '.cache'), { recursive: true });
  writeFileSync(join(old, 'graft', '.cache', 'savings.json'),
    JSON.stringify({ days: { '2025-05-05': { 'claude-opus-5': { savedTokens: 9, costMicros: 0, tokensBilled: 0 } } } }));
  registerExistingLedger(old);
  registerExistingLedger(fresh('never-used'));
  assert.deepEqual(readRepoRegistry(registry).repos.map((r) => r.root), [old]);
});

test('a corrupt registry reads as empty and is rewritten on the next saving', () => {
  mkdirSync(join(registry, '..'), { recursive: true });
  writeFileSync(registry, '{ not json');
  assert.deepEqual(readRepoRegistry(registry).repos, []);
  recordSavedTokens(fresh('after-corrupt'), 'claude-opus-5', 1, day('2026-09-08'));
  assert.equal(readRepoRegistry(registry).repos.length, 1);
});

test('a map that moved to .trail/cache is still found', () => {
  const a = fresh('moved');
  recordSavedTokens(a, 'claude-opus-5', 5, day('2026-09-08'));
  const entry = readRepoRegistry(registry).repos[0];
  mkdirSync(join(a, '.trail'), { recursive: true });
  renameSync(join(a, 'graft'), join(a, '.trail', 'cache'));
  assert.equal(locateLedger(entry), join(a, '.trail', 'cache', '.cache', 'savings.json'));
});

// ── the roll-up ───────────────────────────────────────────────────────────

function twoRepos(): { a: string; b: string } {
  const a = fresh('ra');
  const b = fresh('rb');
  // Repo A billed opus at $0.60/Mtok — far under its $5 list price.
  recordSavedTokens(a, 'claude-opus-5', 100_000, day('2026-09-08'));
  recordTurnBilling(a, [{ model: 'claude-opus-5', costMicros: 600_000, tokens: 1_000_000 }], day('2026-09-08'));
  // Repo B never reported billing, so ITS opus saving is at list price.
  recordSavedTokens(b, 'claude-opus-5', 10_000, day('2026-08-01'));
  recordSavedTokens(b, 'unknown', 7_000, day('2025-01-05'));
  return { a, b };
}

test('every registered repo is added up, biggest first', () => {
  const { a, b } = twoRepos();
  const r = aggregateAllSavings();
  assert.deepEqual(r.repos.map((x) => x.root), [a, b]);
  assert.equal(r.total.savedTokens, 117_000);
  assert.equal(r.total.days, 3);
  assert.equal(r.total.unpricedTokens, 7_000);
});

test('each repo keeps its own rate — one repo\'s billing never re-prices another', () => {
  twoRepos();
  const r = aggregateAllSavings();
  // A: 100k at $0.60 = $0.06 measured. B: 10k at $5 list = $0.05.
  // Merging the ledgers first would blend B into A's measured rate.
  assert.ok(Math.abs(r.total.usd! - 0.11) < 1e-9, String(r.total.usd));
  const opus = r.total.models.find((m) => m.model === 'claude-opus-5')!;
  assert.ok(Math.abs(opus.value!.usd - 0.11) < 1e-9);
  assert.equal(opus.value!.measured, false, 'part of it is a list rate, so the row says so');
  assert.equal(r.total.measured, false);
  const perRepo = r.repos.reduce((s, x) => s + (x.report.usd ?? 0), 0);
  assert.ok(Math.abs(perRepo - r.total.usd!) < 1e-9, 'the repo lines add up to the total');
});

test('a period narrows every repo at once', () => {
  const { a } = twoRepos();
  const r = aggregateAllSavings('2026-09');
  assert.deepEqual(r.repos.map((x) => x.root), [a], 'a repo with nothing in the period is left out');
  assert.equal(r.total.savedTokens, 100_000);
  assert.equal(r.total.days, 1);
});

test('a registered repo whose ledger is gone is named, not counted', () => {
  const { a, b } = twoRepos();
  rmSync(join(b, 'graft'), { recursive: true, force: true });
  const r = aggregateAllSavings();
  assert.deepEqual(r.repos.map((x) => x.root), [a]);
  assert.deepEqual(r.missing, [b]);
  assert.match(formatAllSavingsReport(r), /1 registered folder has no savings ledger any more/);
});

test('two entries reaching one ledger count it once', () => {
  const a = fresh('dup');
  recordSavedTokens(a, 'claude-opus-5', 1_000, day('2026-09-08'));
  const reg = readRepoRegistry(registry);
  reg.repos.push({ ...reg.repos[0], root: join(a, '.') + '-alias' });
  writeFileSync(registry, JSON.stringify(reg));
  assert.equal(aggregateAllSavings().total.savedTokens, 1_000);
});

// ── the readout ───────────────────────────────────────────────────────────

test('the report lists each repo, each model and one total', () => {
  twoRepos();
  const out = formatAllSavingsReport(aggregateAllSavings());
  assert.match(out, /graft savings --all — all time · 2 repos · 3 days recorded/);
  assert.match(out, /per repo/);
  assert.match(out, /~100,000 tokens\s+~\$0\.06/);
  assert.match(out, /per model/);
  assert.match(out, /claude-opus-5\s+~110,000 tokens\s+~\$0\.11\s+\(list rate\)/);
  assert.match(out, /unknown\s+~7,000 tokens\s+\(no rate — tokens only\)/);
  assert.match(out, /total\s+~117,000 tokens\s+~\$0\.11\s+\(excludes ~7,000 unpriced tokens\)/);
});

test('the empty states say which kind of empty it is', () => {
  assert.match(formatAllSavingsReport(aggregateAllSavings()), /nothing recorded yet in any repo/);
  twoRepos();
  assert.match(formatAllSavingsReport(aggregateAllSavings('2024')), /2024: nothing recorded in that period in any repo/);
});

// ── the command ───────────────────────────────────────────────────────────

test('graft savings --all prints the cross-repo report and --json the data', () => {
  // The CLI runs from this checkout, and --all also folds in the repo it is run
  // from — so the assertions look for the two scratch repos rather than assume
  // they are the only ones listed.
  const { a, b } = twoRepos();
  const env = { GRAFT_REPOS_FILE: registry };
  const text = runCli(['savings', '--all', '--no-discover'], { env });
  assert.equal(text.status, 0, text.describe());
  assert.match(text.stdout, /graft savings --all — all time · \d+ repos/);
  assert.match(text.stdout, /per repo[\s\S]*per model[\s\S]*total/);

  const json = runCli(['savings', '--all', '2026-09', '--json', '--no-discover'], { env });
  assert.equal(json.status, 0, json.describe());
  const parsed = JSON.parse(json.stdout) as { period: string; repos: { root: string; report: { savedTokens: number } }[] };
  assert.equal(parsed.period, '2026-09');
  assert.equal(parsed.repos.find((x) => x.root === a)?.report.savedTokens, 100_000);
  assert.equal(parsed.repos.find((x) => x.root === b), undefined, 'nothing of b in 2026-09');
});

test('graft savings --all refuses a directory, which it would silently ignore', () => {
  const res = runCli(['savings', '--all', '--no-discover', fresh('dir')], { env: { GRAFT_REPOS_FILE: registry } });
  assert.equal(res.status, 1, res.describe());
  assert.match(res.stderr, /--all reads every registered repo/);
});

// ── finding repos used before the registry existed ────────────────────────

/** A ledger left by an older graft: on disk, but on nobody's list. */
function oldLedger(root: string, days: Record<string, number>): void {
  mkdirSync(join(root, 'graft', '.cache'), { recursive: true });
  const body = Object.fromEntries(
    Object.entries(days).map(([d, n]) => [d, { 'claude-opus-5': { savedTokens: n, costMicros: 0, tokensBilled: 0 } }]),
  );
  writeFileSync(join(root, 'graft', '.cache', 'savings.json'), JSON.stringify({ days: body }));
}

/** A home folder with one record per supported host, each naming a folder. */
function fixtureHome(folders: { claude: string; vscode: string; jetbrains: string; codex: string }): { home: string; env: NodeJS.ProcessEnv } {
  const home = fresh('home');
  const appData = join(home, 'AppData', 'Roaming');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [folders.claude.replace(/\\/g, '/')]: {} } }));

  const ws = join(appData, 'Cursor', 'User', 'workspaceStorage', 'abc123');
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(folders.vscode).href }));

  const jb = join(appData, 'JetBrains', 'PyCharm2026.1', 'options');
  mkdirSync(jb, { recursive: true });
  const rel = folders.jetbrains.startsWith(home) ? `$USER_HOME$${folders.jetbrains.slice(home.length)}` : folders.jetbrains;
  writeFileSync(join(jb, 'recentProjects.xml'),
    `<application><component name="RecentProjectsManager"><option name="additionalInfo"><map>` +
    `<entry key="${rel.replace(/\\/g, '/')}"><value/></entry></map></option></component></application>`);

  const cx = join(home, '.codex', 'sessions', '2026', '08', '20');
  mkdirSync(cx, { recursive: true });
  writeFileSync(join(cx, 'rollout-1.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: folders.codex, instructions: 'long…' } }) + '\n');

  // Every host location is derived from these, so nothing real is consulted:
  // APPDATA for the editors and JetBrains on Windows, XDG_* elsewhere, no Kilo db.
  // Not spread over process.env: runCli layers this over its own HOME/USERPROFILE
  // redirect, and a copy of the real env would put the real profile back.
  const env: NodeJS.ProcessEnv = { APPDATA: appData, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' };
  return { home, env };
}

test('codexCwdFrom and recentProjectsFrom read the folder each host records', () => {
  assert.equal(codexCwdFrom('{"type":"session_meta","payload":{"cwd":"d:\\\\work\\\\VED-ChAIR","x":1}}'), 'd:\\work\\VED-ChAIR');
  assert.equal(codexCwdFrom('{"type":"other"}'), null);
  const home = resolve('/home/me');
  assert.deepEqual(
    recentProjectsFrom('<entry key="$USER_HOME$/proj"><value/></entry><entry key="relative"/>', home),
    [join(home, 'proj')],
  );
});

test('every supported host contributes the folders it has worked in', () => {
  const [c, v, j, x] = ['c', 'v', 'j', 'x'].map((t) => fresh(`host-${t}`));
  const { home, env } = fixtureHome({ claude: c, vscode: v, jetbrains: j, codex: x });
  const found = knownFolders({ home, env, os: process.platform === 'win32' ? 'win32' : 'linux' });
  const by = (s: string) => found.filter((f) => f.source === s).map((f) => resolve(f.path).toLowerCase());
  assert.ok(by('claude').includes(c.toLowerCase()), JSON.stringify(found));
  assert.ok(by('vscode').includes(v.toLowerCase()), JSON.stringify(found));
  assert.ok(by('jetbrains').includes(j.toLowerCase()), JSON.stringify(found));
  assert.ok(by('codex').includes(x.toLowerCase()), JSON.stringify(found));
});

test('discovery lists only folders with a ledger, dated by the ledger, and found from a subfolder', () => {
  const used = fresh('used');
  oldLedger(used, { '2025-03-01': 10, '2025-06-30': 20 });
  const sub = join(used, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  const unused = fresh('unused');

  const added = registerDiscovered([sub, unused, used, 'relative/ignored'], { file: registry, now: day('2026-10-22') });
  assert.deepEqual(added, [used], 'one repo, once, however many of its folders were named');
  const reg = readRepoRegistry(registry);
  assert.equal(reg.repos.length, 1);
  assert.equal(reg.repos[0].firstSeen.slice(0, 10), '2025-03-01');
  assert.equal(reg.repos[0].lastSeen.slice(0, 10), '2025-06-30');
  assert.ok(reg.discoveredAt, 'the scan is stamped so it runs once');

  assert.deepEqual(registerDiscovered([used], { file: registry }), [], 'a listed repo is never added twice');
});

test('the first graft savings --all finds older repos through the hosts; later runs do not rescan', () => {
  const [c, v, j, x] = ['c', 'v', 'j', 'x'].map((t) => fresh(`old-${t}`));
  oldLedger(c, { '2025-01-02': 1_000 });
  oldLedger(j, { '2025-02-03': 2_000 });
  oldLedger(x, { '2025-04-05': 4_000 });
  // v has no ledger: an editor opened it, graft never ran there.
  const { home, env } = fixtureHome({ claude: c, vscode: v, jetbrains: j, codex: x });
  const run = (...extra: string[]) =>
    runCli(['savings', '--all', '2025', '--json', ...extra], { home, env: { ...env, GRAFT_REPOS_FILE: registry } });

  // The CLI runs from this checkout and also folds in the repo it is run from,
  // so only the scratch repos are compared.
  const scratch = (out: string) =>
    (JSON.parse(out) as { repos: { root: string }[] }).repos
      .map((r) => r.root.toLowerCase())
      .filter((r) => r.startsWith(tmpdir().toLowerCase()))
      .sort();

  const first = run();
  assert.equal(first.status, 0, first.describe());
  assert.deepEqual(scratch(first.stdout), [c, j, x].map((p) => p.toLowerCase()).sort());

  // A repo the hosts learn about later is picked up only when asked to look again.
  const later = fresh('later');
  oldLedger(later, { '2025-07-07': 7 });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [c]: {}, [later]: {} } }));
  assert.equal(scratch(run().stdout).length, 3, 'no rescan once stamped');
  assert.equal(scratch(run('--discover').stdout).length, 4, '--discover looks again');
});

test('plain graft savings in a repo registers it for --all', () => {
  const old = fresh('cli-old');
  mkdirSync(join(old, 'graft', '.cache'), { recursive: true });
  writeFileSync(join(old, 'graft', '.cache', 'savings.json'),
    JSON.stringify({ days: { '2025-05-05': { 'claude-opus-5': { savedTokens: 9, costMicros: 0, tokensBilled: 0 } } } }));
  const res = runCli(['savings', old], { env: { GRAFT_REPOS_FILE: registry } });
  assert.equal(res.status, 0, res.describe());
  assert.equal(readRepoRegistry(registry).repos.length, 1);
});
