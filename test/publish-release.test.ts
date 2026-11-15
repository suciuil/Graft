import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertPublishable, attachedKitAction, attachedKitSha, highestPublishedBuild, releaseNotes, releaseTag, repoCoordinates } from "../scripts/publish-release.mjs";
import { FORK_REPO, pagesUrl } from "../scripts/publish-changelog.mjs";
import { FORK_HOMEPAGE_URL, FORK_REPO_URL } from "../src/about.js";

test("releases are published to the fork repository that graft about names", () => {
  assert.equal(FORK_REPO, `${FORK_REPO_URL}.git`);
  assert.equal(pagesUrl(FORK_REPO), FORK_HOMEPAGE_URL);
  assert.deepEqual(repoCoordinates(FORK_REPO), {
    host: "github-ct.int.automotive-wan.com",
    owner: "suciui",
    name: "Graft",
    web: FORK_REPO_URL,
    api: "https://github-ct.int.automotive-wan.com/api/v3/repos/suciui/Graft",
  });
});

test("a pack numbers its kit past the highest build of its graft version already released", () => {
  const tags = ["v0.27.1.5", "v0.28.0.2", "v0.28.0.0", "v0.28.0", "nightly", "v0.28.0.1-beta.1"];
  assert.equal(highestPublishedBuild(tags, "0.28.0"), 2);
  assert.equal(highestPublishedBuild(tags, "0.28.0-beta.1"), 1);
  assert.equal(highestPublishedBuild(tags, "0.29.0"), null);
  assert.equal(highestPublishedBuild([], "0.28.0"), null);
});

test("a kit is released under its kit version", () => {
  assert.equal(releaseTag("0.28.0.2"), "v0.28.0.2");
  assert.equal(releaseTag("0.28.0.0-beta.1"), "v0.28.0.0-beta.1");
});

test("release notes say how to install the kit and list the entries of its build", () => {
  const groups = [
    { kind: "pending", entries: [{ type: "feature", text: "Not shipped yet" }] },
    {
      kind: "bundle",
      version: "0.28.0.2",
      entries: [
        { type: "feature", text: "`graft about web` opens the fork homepage" },
        { type: "fix", html: "Fixed <code>x</code> &amp; y", legacy: true },
      ],
    },
  ];
  const notes = releaseNotes({ kit: "graft-0.28.0.2-win-x64.zip", version: "0.28.0.2", graftVersion: "0.28.0", build: 2, arch: "x64", groups, homepage: FORK_HOMEPAGE_URL });
  assert.match(notes, /graft 0\.28\.0 for Windows x64, kit build 2/);
  assert.match(notes, /START-HERE-install-graft\.cmd/);
  assert.match(notes, /- \*\*Feature:\*\* `graft about web` opens the fork homepage/);
  assert.match(notes, /- \*\*Bug fix:\*\* Fixed x & y/);
  assert.ok(!notes.includes("Not shipped yet"));
  assert.ok(notes.includes(FORK_HOMEPAGE_URL));
});

test("only the kit kit-build.json records, byte for byte, can be published", () => {
  const kit = "graft-0.28.0.3-win-x64.zip";
  const bytes = Buffer.from("packed for publication");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.doesNotThrow(() => assertPublishable(kit, bytes, { name: kit, sha256 }));
  // A --no-publish pack reuses the name: its bytes differ from the recorded kit
  assert.throws(() => assertPublishable(kit, Buffer.from("local kit"), { name: kit, sha256 }), /SHA-256 differs/);
  assert.throws(() => assertPublishable(kit, bytes, { name: "graft-0.28.0.2-win-x64.zip", sha256 }), /not the kit kit-build\.json records/);
  assert.throws(() => assertPublishable(kit, bytes, null), /not the kit kit-build\.json records/);
  assert.throws(() => assertPublishable(kit, bytes, { name: kit, sha256: null }), /records no SHA-256/);
});

test("release notes record the kit's SHA-256, which tells an attached kit from another", () => {
  const kit = "graft-0.28.0.3-win-x64.zip";
  const sha256 = "a".repeat(64);
  const notes = releaseNotes({ kit, version: "0.28.0.3", graftVersion: "0.28.0", build: 3, arch: "x64", groups: [], homepage: FORK_HOMEPAGE_URL, sha256 });
  assert.ok(notes.includes(`SHA-256 of \`${kit}\`: \`${sha256}\``));
  assert.equal(attachedKitSha({ name: kit }, notes, kit), sha256);
  // GitHub's own digest wins over the notes
  assert.equal(attachedKitSha({ name: kit, digest: `sha256:${"B".repeat(64)}` }, notes, kit), "b".repeat(64));
  assert.equal(attachedKitSha({ name: kit }, notes, "graft-0.28.0.4-win-x64.zip"), null);
  assert.equal(attachedKitSha({ name: kit }, undefined, kit), null);
});

test("a published kit is kept when it is the same, and never replaced silently when it differs", () => {
  const kit = "graft-0.28.0.3-win-x64.zip";
  const tag = "v0.28.0.3";
  const sha256 = "a".repeat(64);
  const same = `SHA-256 of \`${kit}\`: \`${sha256}\``;
  const other = `SHA-256 of \`${kit}\`: \`${"c".repeat(64)}\``;
  assert.equal(attachedKitAction({ existing: undefined, body: undefined, kit, tag, sha256 }), "upload");
  assert.equal(attachedKitAction({ existing: { name: kit }, body: same, kit, tag, sha256 }), "keep");
  assert.equal(attachedKitAction({ existing: { name: kit, digest: `sha256:${sha256}` }, body: other, kit, tag, sha256 }), "keep");
  // Same size or not, a different kit (numbered in a clone that had not pulled) stops the run
  assert.throws(() => attachedKitAction({ existing: { name: kit }, body: other, kit, tag, sha256 }), /already carries a different .*--force/);
  assert.throws(() => attachedKitAction({ existing: { name: kit }, body: "no hash here", kit, tag, sha256 }), /SHA-256 is not known.*--force/);
  assert.equal(attachedKitAction({ existing: { name: kit }, body: other, kit, tag, sha256, force: true }), "replace");
  assert.equal(attachedKitAction({ existing: { name: kit }, body: "", kit, tag, sha256, force: true }), "replace");
});

test("notes naming the kit's SHA-256 never vouch for an upload a failed run cut short", () => {
  const kit = "graft-0.28.0.3-win-x64.zip";
  const tag = "v0.28.0.3";
  const sha256 = "a".repeat(64);
  const notes = `SHA-256 of \`${kit}\`: \`${sha256}\``;
  // GitHub does not report the asset as uploaded: its SHA-256 is not known
  assert.equal(attachedKitSha({ name: kit, state: "starter" }, notes, kit), null);
  assert.equal(attachedKitSha({ name: kit, state: "uploaded" }, notes, kit), sha256);
  assert.throws(() => attachedKitAction({ existing: { name: kit, state: "starter" }, body: notes, kit, tag, sha256 }), /SHA-256 is not known/);
  // Uploaded, but not all of it: another size than the kit
  assert.throws(() => attachedKitAction({ existing: { name: kit, state: "uploaded", size: 10 }, body: notes, kit, tag, sha256, size: 20 }), /SHA-256 is not known/);
  assert.equal(attachedKitAction({ existing: { name: kit, state: "uploaded", size: 20 }, body: notes, kit, tag, sha256, size: 20 }), "keep");
  assert.equal(attachedKitAction({ existing: { name: kit, size: 10 }, body: notes, kit, tag, sha256, size: 20, force: true }), "replace");
  // The notes a release is created with carry no SHA-256 (it is added once the kit is attached)
  assert.equal(releaseNotes({ kit, version: "0.28.0.3", graftVersion: "0.28.0", build: 3, arch: "x64", groups: [], homepage: FORK_HOMEPAGE_URL }).includes("SHA-256"), false);
});

test("release notes of a build without entries say it repackages the previous one", () => {
  const notes = releaseNotes({ kit: "graft-0.28.0.3-win-x64.zip", version: "0.28.0.3", graftVersion: "0.28.0", build: 3, arch: "x64", groups: [], homepage: FORK_HOMEPAGE_URL });
  assert.match(notes, /repackages the previous one/);
});
