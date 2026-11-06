<!-- changelog:start -->
## Keep the fork changelog up to date (rules for every AI agent)

`docs/changelog.html` lists what this fork adds to or changes in upstream
Graft (`NanoNets/Graft`, the `upstream` remote), grouped by package build,
newest first. It ships in the npm package and the offline kit and is opened by
`graft about fork`. It is generated from the fork's git commit messages by
`scripts/changelog.mjs` (`npm run changelog`); nothing in it is written by
hand or taken from the code. The one exception is the items of the
hand-written report that came before the generated page: they are kept in
`changelog-legacy.json` and merged in on every run, each in the group it was
listed in, and the commit-message entries an item covers (its `replaces`
list, exact entry text) are left out so nothing is listed twice. Do not add
new items there; new changes go into commit messages. If the generator warns
that a `replaces` text matches no entry, fix that text.

1. **Commit messages are the source.** Every line of a fork commit message
   that starts with `- Feature:`, `- Bug-Fix:`, `- Improvement:` or
   `- Change request:` becomes one entry, word for word (several per commit
   are fine; plain `- …` lines right after one continue it). Commits without
   such a line are not listed. When you are asked to write a commit message,
   add one such line per change users can notice (behaviour, commands,
   options, settings, languages, output, prices, agent instructions or skills,
   installer, packaging, update channel, CI, privacy), in plain language
   describing the result, with no hashes, authors or branch names. Use
   **Feature** for functionality upstream Graft does not have; **Bug-Fix**,
   **Improvement** and **Change request** for functionality upstream already
   has (check with `git show upstream/main:<path>` or
   `git grep <identifier> upstream/main`). Refactors, tests, comments,
   formatting, docs-only changes and the regenerated `graft/` index get no
   such line. When a commit's message left out a change users can notice,
   do not rewrite published history: add the missing lines as a git note,
   `git notes --ref=changelog append -m "- Feature: …" <commit>`, which
   counts as part of that commit's message (share it with
   `git push origin refs/notes/changelog`).
2. **Regenerate after every prompt that changed files.** When a task you
   finish changed files or made commits, run
   `node scripts/changelog.mjs --quiet` before your final reply. It rewrites
   the page only when its content changes (new commits, a new build); work
   that is not committed yet appears once it is committed. In Kilo the plugin
   `.kilo/plugin/fork-changelog.ts` runs it automatically whenever a session
   goes idle after the repository changed.
3. **Builds.** The page groups entries by the `npm run pack:bundle` run that
   first shipped their commit ("Not yet bundled" first, then one group per
   build, then commits from before builds were recorded, by commit date).
   Each pack records its build (date and build version) in
   `changelog-builds.json` and regenerates the page; commit
   `changelog-builds.json`, `kit-build.json` and `docs/changelog.html` right
   after the pack, because the commit that first carries a build's record
   closes that build. Never edit `changelog-builds.json` or `kit-build.json`
   by hand. On Windows the build version is the offline kit's `a.b.c.d` (kit
   `graft-a.b.c.d-win-<arch>.zip`): graft version `a.b.c` plus kit build `d`,
   which starts at 0, goes up by 1 with each pack of the same graft version
   and restarts at 0 for a new one (`scripts/kit-build.mjs`). Elsewhere it is
   the package version.
4. **The page.** Only edit its static parts (header, panels, CSS, script).
   The regions between `<!-- stats:start/end -->`, `<!-- counts:start/end -->`,
   `<!-- areas:start/end -->` and `<!-- changes:start/end -->` are generated;
   keep those markers. The filter area of an entry is guessed from keywords
   in its text (`AREAS` in `scripts/changelog.mjs`); add or adjust areas
   there, not in the page. After changing the generator, run
   `node --import tsx --test test/changelog.test.ts`.
5. **Report it.** When a task changed files, end your final reply with one
   line saying whether `docs/changelog.html` was regenerated or was already up
   to date. Tasks that change no files need no such line.
<!-- changelog:end -->
