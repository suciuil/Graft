<!-- changelog:start -->
## Keep the fork changelog up to date (rules for every AI agent)

`docs/changelog.html` lists what this fork adds to or changes in upstream
Graft (`NanoNets/Graft`, the `upstream` remote), grouped by package build,
newest first. It ships in the npm package and the offline kit and is opened by
`graft about fork`. It is also the fork's homepage,
https://github-ct.int.automotive-wan.com/pages/suciui/Graft/ (`graft about
web`). Each pack publishes its kit as a release of that repository and
refreshes the page (`scripts/publish-release.mjs`; `--no-publish` skips it,
`npm run release:publish` retries it); `npm run changelog:publish` refreshes
only the page, whenever it should show new commits. It is generated from the fork's git commit messages by
`scripts/changelog.mjs` (`npm run changelog`); nothing in it is written by
hand or taken from the code. The one exception is the items of the
hand-written report that came before the generated page: they are kept in
`changelog-legacy.json` and merged in on every run, each in the group it was
listed in, and the commit-message entries an item covers (its `replaces`
list, exact entry text) are left out so nothing is listed twice. Do not add
new items there; new changes go into commit messages. If the generator warns
that a `replaces` text matches no entry, fix that text. The page also lists
suciui's typed commit lines in the local tree-sitter grammar repositories graft
builds from (the `file:../tree-sitter-*` dependencies of `package.json` and
their own) as one short item per grammar and build (`The C grammar has been
updated.`) whose `details` link opens those lines word for word. They are filed
under the first fork commit after them that changes that grammar's files in
`vendor/`; lines a fork commit there already says are left out. The generator
keeps them in `changelog-grammars.json` for clones without those repositories:
commit that file whenever it changes, with `docs/changelog.html`.

Each build lists its entries in two separate parts (`SCOPES` in
`scripts/changelog.mjs`), and so do the stats, the counts table, the page's
"Graft only / Bundled tree-sitter grammars only" filter and the release notes:
**Graft** (changes to graft itself: its code, commands, settings, output,
extractors, savings, installer, packaging, agent instructions) and **Bundled
tree-sitter grammars** (changes to the third-party tree-sitter grammars graft
builds its parsers from and ships under `vendor/`: what they parse, their
rebuilt packages and prebuilt binaries). Every entry about languages and
parsing (the Languages filter area), including the legacy items, is listed
as one short item per language, part and build whose `details` link opens the
entries: `Bash support has been added.` or `C support has been updated.` under
Graft, `The C grammar has been updated.` under the grammars; one naming
several languages is under each, one naming none under "Other changes to
language support and parsing" or "Other changes to the bundled tree-sitter
grammars" (`groupLanguages`). The Languages area thus holds
entries of both parts, and the counts table splits it (and any other area
holding both) into one row per part.

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
2. **Graft or a bundled tree-sitter grammar.** The generator files these
   under the grammars: every typed line of the grammar repositories, a fork
   line about how a grammar the fork builds parses its language (it names
   that language and its first sentence is about parsing, syntax or parse
   errors, recognised code or rebuilt parsers: `isParsingEntry`), and a line
   marked `(tree-sitter)` after its type. Everything else, and every line
   marked `(graft)`, is filed under Graft. When you write a commit message,
   mark each line whose part that guess would get wrong:
   `- Bug-Fix (tree-sitter): …` for a change that is only in a bundled
   grammar (`(grammar)`, `(third-party)` or `(tree-sitter-c)` work too), and
   `- Improvement (graft): …` for a change in graft's own code that only
   mentions parsing (for example how graft picks a parser, retries `#if`
   branches or reports syntax errors). A change that touches both gets one
   line for each part. Lines of the grammar repositories are always the
   grammars'; do not mark them. Any other note in brackets
   (`- Change request (docs): …`) marks nothing. A legacy item may carry
   `"scope": "tree-sitter"` or `"scope": "graft"` for the same purpose.
3. **Regenerate after every prompt that changed files.** When a task you
   finish changed files or made commits, run
   `node scripts/changelog.mjs --quiet` before your final reply. It rewrites
   the page only when its content changes (new commits, a new build); work
   that is not committed yet appears once it is committed. In Kilo the plugin
   `.kilo/plugin/fork-changelog.ts` runs it automatically whenever a session
   goes idle after the repository changed.
4. **Builds.** The page groups entries by the `npm run pack:bundle` run that
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
5. **The page.** Only edit its static parts (header, panels, CSS, script).
   The regions between `<!-- stats:start/end -->`, `<!-- counts:start/end -->`,
   `<!-- areas:start/end -->` and `<!-- changes:start/end -->` are generated;
   keep those markers. The filter area of an entry is guessed from keywords
   in its text (`AREAS` in `scripts/changelog.mjs`); add or adjust areas
   there, not in the page. The two parts are `SCOPES` there; each group holds
   one `<div class="scope" data-scope="graft|tree-sitter">` per part, which
   the page's script filters on. After changing the generator, run
   `node --import tsx --test test/changelog.test.ts`.
6. **Report it.** When a task changed files, end your final reply with one
   line saying whether `docs/changelog.html` was regenerated or was already up
   to date. Tasks that change no files need no such line.
<!-- changelog:end -->
