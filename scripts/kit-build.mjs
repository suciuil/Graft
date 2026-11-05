/**
 * The build number of the Windows offline installer kit written by `npm run pack:bundle`:
 * graft-<a.b.c>.<d>[-prerelease]-win-<arch>.zip, where a.b.c is the version of the graft
 * package inside it and d counts the packs of that same version. d starts at 0 and goes up
 * by 1 with each pack while the previous kit carried the same graft version; a kit carrying
 * another version starts again at 0.
 *
 * "The previous kit" is the one recorded in kit-build.json (repo root, committed with the
 * changelog the same pack dates) by the last successful pack, so every clone knows it. Without
 * that record: the newest build group of docs/changelog.html named by a kit version, then
 * the newest numbered kit in the repo root.
 */

/** Splits a package version into its a.b.c core and its prerelease suffix ("-beta.1" or ""). */
function splitVersion(version) {
  const m = /^(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$/.exec(String(version).trim());
  if (!m) throw new Error(`not a semver package version: ${version}`);
  return { core: m[1], pre: m[2] ?? "" };
}

/** The kit version for a package version and build number: 0.28.0 + 3 → 0.28.0.3, 0.28.0-beta.1 + 2 → 0.28.0.2-beta.1. */
export function kitVersion(version, build) {
  const { core, pre } = splitVersion(version);
  return `${core}.${build}${pre}`;
}

/** The kit file name: graft-0.28.0.3-win-x64.zip. */
export function kitFileName(version, build, arch) {
  return `graft-${kitVersion(version, build)}-win-${arch}.zip`;
}

/**
 * Parses a kit file name into the package version and build number it carries, or null for
 * anything else, including kits from before build numbers (graft-0.28.0-win-x64.zip). A
 * trailing " - Copy" / " (1)" is accepted, as the installer accepts it on packages.
 */
export function parseKitName(name, arch) {
  const escArch = arch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^graft-(\\d+\\.\\d+\\.\\d+)\\.(\\d+)(-[0-9A-Za-z.-]+)?-win-${escArch}(.*)\\.zip$`, "i").exec(name);
  if (!m) return null;
  return { version: `${m[1]}${m[3] ?? ""}`, build: Number(m[2]) };
}

/** Parses a kit version (0.28.0.3, 0.28.0.2-beta.1) into its package version and build number, or null. */
export function parseKitVersion(kitVer) {
  const m = /^(\d+\.\d+\.\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(String(kitVer).trim());
  return m ? { version: `${m[1]}${m[3] ?? ""}`, build: Number(m[2]) } : null;
}

/**
 * The newest kit named in the fork changelog: its build groups sit newest first, each
 * carrying data-version="<kit version>" (or a plain package version from before kit build
 * numbers, which is skipped). Null when no group names a kit.
 */
export function latestKitInChangelog(html) {
  for (const m of String(html).matchAll(/<div class="group" data-group="bundle"[^>]*\sdata-version="([^"]+)"/g)) {
    const kit = parseKitVersion(m[1]);
    if (kit) return kit;
  }
  return null;
}

/** Validates a kit-build.json record: { version, build } with a semver version and a build of 0 or more, else null. */
export function parseKitRecord(json) {
  const rec = typeof json === "string" ? JSON.parse(json) : json;
  if (typeof rec?.version !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(rec.version)) return null;
  if (!Number.isInteger(rec.build) || rec.build < 0) return null;
  return { version: rec.version, build: rec.build };
}

/**
 * The build number for a new kit of package `version`.
 * @param {string} version  the graft package version going into the kit
 * @param {{version?: string, build?: number} | null} previous  the previous kit: the record of
 *   the last successful pack, else the newest numbered kit found in the repo root, else null
 */
export function nextKitBuild(version, previous) {
  if (!previous || previous.version !== version) return 0;
  const build = Number(previous.build);
  return Number.isInteger(build) && build >= 0 ? build + 1 : 0;
}
