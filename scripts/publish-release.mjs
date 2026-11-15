/**
 * Publishes an offline installer kit (graft-<a.b.c.d>-win-<arch>.zip, written by
 * `npm run pack:bundle`) as a release of the fork's public repository, so users can
 * download any published kit, the latest included, from its Releases page; then
 * refreshes the fork homepage (the changelog, scripts/publish-changelog.mjs).
 *
 * `npm run pack:bundle` runs it right after a successful pack (skip with
 * `--no-publish`); `npm run release:publish` runs it by hand, for example to retry a
 * failed upload. Maintainer tool: graft itself never runs it.
 *
 * The release is tagged v<kit version> (v0.28.0.2), named "graft <kit version>", and its
 * notes are the entries of that build's changelog group, and it is marked as the latest.
 * Its tag never points at the fork's source: GitHub adds "Source code (zip/tar.gz)"
 * downloads of the tagged commit to every release and offers no way to leave them out, so
 * the tag points at a commit of its own, without parents, whose only file is a README
 * naming the release (releaseTagReadme). A release whose tag points anywhere else is
 * moved onto such a commit when it is published again; `--strip-sources` does that for
 * every kit release of the repository at once. Only the kit recorded in kit-build.json can be
 * published: the last pack meant for publication, whose SHA-256 must still match (a local
 * `--no-publish` kit records nothing and is refused).
 * The notes record the kit's SHA-256. Running it again for a published kit keeps the
 * attached kit when its SHA-256 matches; a different kit (or one whose SHA-256 is not
 * known) under the same tag stops the run unless --force is given, so a kit numbered in a
 * clone that had not pulled never silently replaces a published one.
 *
 * Credentials: GRAFT_RELEASE_TOKEN (a personal access token with the repo scope) when set,
 * otherwise what git's credential helper holds for the host, the same login `git push` uses.
 *
 *   node scripts/publish-release.mjs [--kit <zip>] [--repo <git url>] [--no-changelog] [--dry-run] [--force]
 *   node scripts/publish-release.mjs --strip-sources [--repo <git url>] [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateChangelog, htmlText, TYPES } from "./changelog.mjs";
import { kitFileName, kitVersion, parseKitName, parseKitRecord, parseKitVersion } from "./kit-build.mjs";
import { FORK_REPO, pagesUrl, publishChangelog } from "./publish-changelog.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The release tag of a kit version: 0.28.0.2 → v0.28.0.2. */
export function releaseTag(version) {
  return `v${version}`;
}

/** Host, owner, name and API base of a repository URL on GitHub Enterprise Server. */
export function repoCoordinates(repo) {
  const u = new URL(repo.replace(/\.git$/, ""));
  const [owner, name] = u.pathname.split("/").filter(Boolean);
  if (!owner || !name) throw new Error(`not a repository URL: ${repo}`);
  return { host: u.host, owner, name, web: `${u.origin}/${owner}/${name}`, api: `${u.origin}/api/v3/repos/${owner}/${name}` };
}

/**
 * The release notes (markdown) of a kit: how to install it, then the entries of its build
 * group in the changelog (`groups` from generateChangelog), then where the full changelog is.
 */
export function releaseNotes({ kit, version, graftVersion, build, arch, groups, homepage, sha256 }) {
  const lines = [
    `Offline installer kit of graft ${graftVersion} for Windows ${arch}, kit build ${build}.`,
    "",
    `**Install:** download \`${kit}\`, unzip it and double-click \`START-HERE-install-graft.cmd\`. Nothing else needs to be downloaded: Node.js and every grammar are inside.`,
    "",
  ];
  if (sha256) lines.push(`SHA-256 of \`${kit}\`: \`${sha256}\``, "");
  const group = (groups ?? []).find((g) => g.kind === "bundle" && g.version === version);
  if (group && group.entries.length > 0) {
    lines.push("### Changes in this build", "");
    for (const e of group.entries) {
      const tag = TYPES.find((t) => t.key === e.type)?.tag ?? e.type;
      lines.push(`- **${tag}:** ${e.html !== undefined ? htmlText(e.html) : e.text}`);
    }
  } else {
    lines.push("No changes of its own are listed for this build: it repackages the previous one.");
  }
  const tail = `\n\nEvery change this fork makes, by build: ${homepage}`;
  let notes = lines.join("\n");
  // GitHub refuses release notes over 125,000 characters
  if (notes.length + tail.length > 120_000) notes = `${notes.slice(0, notes.lastIndexOf("\n- ", 120_000 - tail.length - 60))}\n- … more in the changelog`;
  return notes + tail;
}

/** The Authorization header: GRAFT_RELEASE_TOKEN, else the credential git holds for the host. */
function authorization(host) {
  const token = process.env.GRAFT_RELEASE_TOKEN?.trim();
  if (token) return `token ${token}`;
  let out = "";
  try {
    out = execFileSync("git", ["credential", "fill"], {
      input: `protocol=https\nhost=${host}\n\n`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    /* no helper, or it has nothing for this host */
  }
  const field = (k) => out.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1];
  const username = field("username");
  const password = field("password");
  if (!password) throw new Error(`no credentials for ${host}: set GRAFT_RELEASE_TOKEN, or sign in once with git (git push to a repository there)`);
  return `Basic ${Buffer.from(`${username ?? ""}:${password}`).toString("base64")}`;
}

async function api(auth, method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: auth, Accept: "application/vnd.github+json", ...(body && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  if (res.status === 404 && method === "GET") return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url.replace(/\?.*$/, "")}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * The only file of the commit a release's tag points at (README.md): it names the release
 * and says where the kit is, so GitHub's automatic "Source code" downloads of the release
 * hold this file and no source. Depends on the version and the repository alone, so the
 * same release always gets the same tree and a tag already on it is left where it is.
 */
export function releaseTagReadme({ version, web }) {
  const tag = releaseTag(version);
  return [
    `# graft ${version}`,
    "",
    `This tag marks the release of graft's offline installer kit ${version} for Windows.`,
    "",
    "It holds no source code on purpose: GitHub adds \"Source code\" downloads of the tagged",
    "commit to every release, and this commit carries nothing but this file.",
    "",
    `Download the kit (the .zip file attached to the release): ${web}/releases/tag/${tag}`,
    "",
  ].join("\n");
}

/**
 * Whether the commit a tag points at (as the git commits API returns it) is the
 * source-free commit of `treeSha`: that tree, and no parents (so no history of the fork
 * hangs off the tag either).
 */
export function isSourceFreeCommit(commit, treeSha) {
  return commit?.tree?.sha === treeSha && Array.isArray(commit.parents) && commit.parents.length === 0;
}

/**
 * Points the tag of release `version` at its source-free commit (see releaseTagReadme),
 * creating the tag when it does not exist and moving it when it points at any other
 * commit (the fork's source, as tags made before this did). The release itself, its
 * notes and its assets are untouched: a release follows its tag by name. Returns
 * "kept", "created" or "moved".
 */
async function sourceFreeTag(auth, where, version) {
  const tag = releaseTag(version);
  const tree = await api(auth, "POST", `${where.api}/git/trees`, {
    tree: [{ path: "README.md", mode: "100644", type: "blob", content: releaseTagReadme({ version, web: where.web }) }],
  });
  const ref = await api(auth, "GET", `${where.api}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (ref?.object) {
    let sha = ref.object.sha;
    // An annotated tag: follow it to its commit
    if (ref.object.type === "tag") sha = (await api(auth, "GET", `${where.api}/git/tags/${sha}`))?.object?.sha;
    const commit = sha ? await api(auth, "GET", `${where.api}/git/commits/${sha}`) : null;
    if (isSourceFreeCommit(commit, tree.sha)) return "kept";
  }
  const commit = await api(auth, "POST", `${where.api}/git/commits`, {
    message: `graft ${version}: offline installer kit release (no source code)`,
    tree: tree.sha,
    parents: [],
  });
  if (ref?.object) {
    await api(auth, "PATCH", `${where.api}/git/refs/tags/${encodeURIComponent(tag)}`, { sha: commit.sha, force: true });
    return "moved";
  }
  await api(auth, "POST", `${where.api}/git/refs`, { ref: `refs/tags/${tag}`, sha: commit.sha });
  return "created";
}

/**
 * Moves the tag of every kit release of `repo` onto its source-free commit, so none of
 * the releases offers the fork's source as its "Source code" downloads any more. Releases
 * whose tag is not a kit version are left alone. Returns the number of tags moved.
 */
export async function stripReleaseSources({ repo = FORK_REPO, dryRun = false, log = console.log } = {}) {
  const where = repoCoordinates(repo);
  const auth = authorization(where.host);
  const releases = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api(auth, "GET", `${where.api}/releases?per_page=100&page=${page}`);
    releases.push(...(batch ?? []));
    if (!batch || batch.length < 100) break;
  }
  let moved = 0;
  for (const release of releases) {
    const version = String(release.tag_name).replace(/^v/, "");
    if (!parseKitVersion(version) || releaseTag(version) !== release.tag_name) {
      log(`• ${release.tag_name}: not a kit release, left as it is`);
      continue;
    }
    if (dryRun) {
      log(`Dry run: would point ${release.tag_name} at a commit holding only README.md`);
      continue;
    }
    const outcome = await sourceFreeTag(auth, where, version);
    if (outcome === "kept") log(`✓ ${release.tag_name} already carries no source code`);
    else {
      moved++;
      log(`✓ ${release.tag_name} now points at a commit holding only README.md: its "Source code" downloads carry no source`);
    }
  }
  if (releases.length === 0) log(`• ${where.web} has no releases`);
  return moved;
}

/**
 * The highest kit build of package `version` among release `tags` (v0.28.0.2, …), or null
 * when none of them is a kit of that version.
 */
export function highestPublishedBuild(tags, version) {
  let highest = null;
  for (const tag of tags) {
    const kit = parseKitVersion(String(tag).replace(/^v/, ""));
    if (kit && kit.version === version && (highest === null || kit.build > highest)) highest = kit.build;
  }
  return highest;
}

/**
 * The highest kit build of package `version` already published as a release of `repo`, or
 * null when none is. `npm run pack:bundle` numbers its kit past it, so a kit-build.json that
 * was not committed (or not pulled) after a publication never makes a pack reuse a published
 * build number. Read with the publishing credentials when there are any (the repository may
 * be private), else anonymously.
 */
export async function publishedKitBuild(version, { repo = FORK_REPO } = {}) {
  const where = repoCoordinates(repo);
  let auth;
  try {
    auth = authorization(where.host);
  } catch {
    auth = undefined;
  }
  const tags = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${where.api}/releases?per_page=100&page=${page}`, {
      headers: { Accept: "application/vnd.github+json", ...(auth ? { Authorization: auth } : {}) },
    });
    if (!res.ok) throw new Error(`GET ${where.api}/releases: HTTP ${res.status}`);
    const releases = await res.json();
    tags.push(...releases.map((r) => r.tag_name));
    if (releases.length < 100) break;
  }
  return highestPublishedBuild(tags, version);
}

/**
 * The kit kit-build.json records (the last pack meant for publication: --no-publish packs
 * record nothing), as its file name and SHA-256, or null.
 */
function recordedKit() {
  const path = join(repoRoot, "kit-build.json");
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const rec = parseKitRecord(raw);
  if (!rec) return null;
  return { name: kitFileName(rec.version, rec.build, process.arch), sha256: typeof raw.sha256 === "string" ? raw.sha256 : null };
}

/**
 * Throws unless `bytes` are the kit kit-build.json records: the kit the last publishing pack
 * wrote. A local kit (--no-publish) reuses that build number and file name, so the name
 * alone proves nothing.
 */
export function assertPublishable(kit, bytes, recorded) {
  if (!recorded || recorded.name !== kit) {
    throw new Error(`${kit} is not the kit kit-build.json records${recorded ? ` (${recorded.name})` : ""}: only the last kit packed for publication (npm run pack:bundle without --no-publish) can be published`);
  }
  if (!recorded.sha256) throw new Error(`kit-build.json records no SHA-256 for ${kit}: pack it again (npm run pack:bundle) to publish it`);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== recorded.sha256) {
    throw new Error(`${kit} is not the kit the last publishing pack wrote (its SHA-256 differs; a --no-publish pack may have replaced it): pack it again with npm run pack:bundle`);
  }
}

/**
 * The SHA-256 of the kit `existing` (a release asset), as GitHub reports it (`digest`), else
 * as the release notes `body` record it (see releaseNotes), else null. The notes speak only
 * for a complete upload: an asset GitHub does not report as `uploaded` (one a failed run
 * left behind) has no known SHA-256.
 */
export function attachedKitSha(existing, body, kit) {
  const digest = typeof existing?.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(existing.digest)?.[1] : undefined;
  if (digest) return digest.toLowerCase();
  if (existing?.state !== undefined && existing.state !== "uploaded") return null;
  const escaped = kit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`SHA-256 of \`${escaped}\`: \`([0-9a-f]{64})\``, "i").exec(body ?? "")?.[1]?.toLowerCase() ?? null;
}

/**
 * What to do with a release that may already carry a kit of this name: `upload` it (none
 * attached), `keep` the attached one (the same bytes), or `replace` it (only with `force`).
 * Throws when a different kit, or one whose bytes cannot be told, is attached: build
 * numbers come from local files, so a clone that had not pulled can number a kit the same
 * as one already published elsewhere, and that kit must not be replaced silently. Given
 * `size` (the kit's bytes), an attached kit of another size is never kept.
 */
export function attachedKitAction({ existing, body, kit, tag, sha256, size, force = false }) {
  if (!existing) return "upload";
  const sized = size === undefined || typeof existing.size !== "number" || existing.size === size;
  // An attached kit of another size is not the one the notes describe (an upload cut short)
  const attached = sized ? attachedKitSha(existing, body, kit) : null;
  if (attached === sha256) return "keep";
  if (force) return "replace";
  throw new Error(
    attached
      ? `release ${tag} already carries a different ${kit} (SHA-256 ${attached}): a kit with this build number was published before, probably from another clone. Pull, pack again (it takes the next build number), or pass --force to replace the published kit`
      : `release ${tag} already carries a ${kit} whose SHA-256 is not known, so it cannot be told from this one: pass --force to replace it`,
  );
}

/**
 * Creates (or completes) the release of `kitPath`, marks it latest and refreshes the
 * homepage. Returns the release page address. `force` replaces a different kit already
 * attached under the same name (see attachedKitAction).
 */
export async function publishRelease({ kitPath, repo = FORK_REPO, changelog = true, dryRun = false, force = false, log = console.log } = {}) {
  const recorded = recordedKit();
  kitPath ??= recorded ? join(repoRoot, recorded.name) : undefined;
  if (!kitPath || !existsSync(kitPath)) throw new Error(`no kit to publish${kitPath ? `: ${kitPath} does not exist` : ""} — run npm run pack:bundle first`);
  const kit = basename(kitPath);
  const arch = /-win-([^-.]+)/.exec(kit)?.[1] ?? process.arch;
  const parsed = parseKitName(kit, arch);
  if (!parsed) throw new Error(`${kit} is not a numbered offline kit (graft-a.b.c.d-win-<arch>.zip)`);
  const version = kitVersion(parsed.version, parsed.build);
  const bytes = readFileSync(kitPath);
  assertPublishable(kit, bytes, recorded);
  const sha256 = recorded.sha256;
  const tag = releaseTag(version);
  const where = repoCoordinates(repo);
  const homepage = pagesUrl(repo);
  let groups = [];
  try {
    groups = generateChangelog(repoRoot).groups;
  } catch (err) {
    log(`! the release notes list no changes: the changelog could not be read (${err.message})`);
  }
  const body = releaseNotes({ kit, version, graftVersion: parsed.version, build: parsed.build, arch, groups, homepage, sha256 });
  if (dryRun) {
    log(`Dry run: would publish ${kit} (${(bytes.length / 1024 / 1024).toFixed(1)} MB) as release ${tag} of ${where.web}, marked latest, tagged on a commit holding only README.md (no source code), with these notes:\n\n${body}\n`);
    if (changelog) publishChangelog({ repo, dryRun, log });
    return `${where.web}/releases/tag/${tag}`;
  }

  const auth = authorization(where.host);
  let release = await api(auth, "GET", `${where.api}/releases/tags/${encodeURIComponent(tag)}`);
  // Decided before anything is changed: a different kit already published under this tag
  // stops the run here, with its release left as it was.
  const existing = (release?.assets ?? []).find((a) => a.name === kit);
  const action = attachedKitAction({ existing, body: release?.body, kit, tag, sha256, size: bytes.length, force });
  // The tag goes on a commit without the fork's source before the release is created on it
  // (and a release tagged on the source before this is moved off it), so its automatic
  // "Source code" downloads never carry the source.
  const tagged = await sourceFreeTag(auth, where, version);
  if (tagged === "moved") log(`✓ moved ${tag} onto a commit holding only README.md: its "Source code" downloads carry no source`);
  if (!release) {
    // Neither marked latest nor carrying the kit's SHA-256 yet: both wait until the kit is
    // attached (below), so a failed upload never leaves /releases/latest on a release
    // without its kit, nor notes a later run would take as proof the kit is attached
    release = await api(auth, "POST", `${where.api}/releases`, {
      tag_name: tag,
      name: `graft ${version}`,
      body: releaseNotes({ kit, version, graftVersion: parsed.version, build: parsed.build, arch, groups, homepage }),
      make_latest: "false",
    });
    log(`✓ created release ${tag}: ${release.html_url}`);
  } else {
    log(`• release ${tag} already exists: ${release.html_url}`);
  }

  const assets = release.assets ?? [];
  if (action === "keep") {
    log(`✓ ${kit} is already attached to ${tag}`);
  } else {
    if (action === "replace") log(`! replacing the different ${kit} attached to ${tag} (--force)`);
    // A replacement is uploaded under a temporary name and takes the kit's name only once it
    // is complete, so a failed upload leaves the old kit attached. A temporary upload left by
    // an earlier run that failed (before or after the old kit was deleted) is removed first,
    // whether or not the kit's own name is still taken.
    const uploadName = existing ? `${kit}.new` : kit;
    const leftover = assets.find((a) => a.name === `${kit}.new`);
    if (leftover) await api(auth, "DELETE", `${where.api}/releases/assets/${leftover.id}`);
    const upload = `${release.upload_url.replace(/\{.*$/, "")}?name=${encodeURIComponent(uploadName)}`;
    log(`• uploading ${kit} (${(bytes.length / 1024 / 1024).toFixed(1)} MB) …`);
    const uploaded = await api(auth, "POST", upload, bytes, { "Content-Type": "application/zip" });
    if (existing) {
      await api(auth, "DELETE", `${where.api}/releases/assets/${existing.id}`);
      await api(auth, "PATCH", `${where.api}/releases/assets/${uploaded.id}`, { name: kit });
    }
    log(`✓ attached ${kit} to ${tag}`);
  }
  // The notes (with the kit's SHA-256) are rewritten only now that this kit is attached, so
  // a run that failed mid-upload never leaves notes describing a kit that is not there.
  await api(auth, "PATCH", `${where.api}/releases/${release.id}`, { body, make_latest: "true" });
  log(`  Download: ${where.web}/releases/download/${tag}/${encodeURIComponent(kit)}`);
  log(`  Latest:   ${where.web}/releases/latest`);
  if (changelog) publishChangelog({ repo, log });
  return release.html_url;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const kit = opt("--kit");
  const run = argv.includes("--strip-sources")
    ? stripReleaseSources({ repo: opt("--repo") ?? FORK_REPO, dryRun: argv.includes("--dry-run") })
    : publishRelease({
        kitPath: kit ? resolve(kit) : undefined,
        repo: opt("--repo") ?? FORK_REPO,
        changelog: !argv.includes("--no-changelog"),
        dryRun: argv.includes("--dry-run"),
        force: argv.includes("--force"),
      });
  run.catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}
