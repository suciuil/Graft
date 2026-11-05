<!-- changelog:start -->
## Keep the fork changelog up to date (rules for every AI agent)

`docs/changelog.html` lists everything this fork adds to or changes in
upstream Graft (`NanoNets/Graft`, the `upstream` remote), grouped by date,
newest first. It ships in the npm package and the offline kit and is opened by
`graft about fork`. Keep it in sync with the code. Whenever a task you finish
changes the fork in a way that qualifies (rule 1), update the changelog in the
same change, before your final reply, without being asked.

1. **What qualifies.** A change users can notice: behaviour, commands, options,
   settings, supported languages, output, prices, agent instructions or skills,
   installer, packaging, update channel, CI, privacy. Not: refactors with no
   visible effect, test-only changes, comments, formatting, docs-only changes,
   the regenerated `graft/` index, or edits to the changelog itself.
2. **Classify against upstream Graft, not against the fork.** Check what
   upstream has with `git show upstream/main:<path>`,
   `git grep <identifier> upstream/main` or `graft grep` when unsure.
   - **Feature**: functionality upstream does not have. A change that fixes,
     improves or adjusts a feature the fork added does not get its own entry;
     rewrite that feature's existing entry so it describes the result.
   - **Bug fix**, **Improvement**, **Change request**: only for functionality
     upstream already has. A bug fix says what was wrong.
   - **Update or remove**: when a change alters what an entry describes,
     rewrite the entry to the current state. When the fork drops the
     functionality, or upstream now provides the same thing, delete the entry.
3. **Groups and dates.** Entries sit in `<div class="group">` blocks inside
   `<section id="changes">`, newest first:
   - `data-group="pending"` ("Not yet bundled"), always first: put every new
     or rewritten entry between `<!-- pending:start -->` and
     `<!-- pending:end -->`. When you move a rewritten entry here from a dated
     group, end its text with `<span class="first">first added YYYY-MM-DD</span>`
     (that group's date; keep an existing "first added").
   - `data-group="bundle"`: one per successful `npm run pack:bundle`, dated with
     that run. Never create or date these by hand:
     `scripts/stamp-changelog.mjs`, called by `scripts/pack-bundle.mjs`,
     moves the pending entries into a new bundle group (date and build
     version) right after `<!-- groups:start -->`. On Windows the build version
     is the offline kit's `a.b.c.d` (kit `graft-a.b.c.d-win-<arch>.zip`): graft
     version `a.b.c` plus kit build `d`, which starts at 0, goes up by 1 with
     each pack of the same graft version and restarts at 0 for a new one
     (`scripts/kit-build.mjs`). The pack records the last kit in `kit-build.json`
     (repo root); never edit it by hand, and commit it together with the
     `docs/changelog.html` the same pack stamped, so every clone continues the
     numbering. Elsewhere the build version is the package version.
   - `data-group="commit"`: entries from before build dates were recorded,
     dated by the first commit of the change ("first committed; build date not
     recorded"). Do not add new commit groups except when regenerating (rule 6).
   - Within a group: features, improvements, fixes, changes. Keep the
     `<!-- pending:start -->`, `<!-- pending:end -->` and `<!-- groups:start -->`
     markers; `pack:bundle` fails without them.
4. **Content rules.**
   - No git information: no commit hashes, authors, branch names, commit
     messages, history or diff statistics. The group dates and "first added"
     are the only time information.
   - Describe the current state in plain language, not how the fork got
     there.
   - Edit the file in place; keep its layout, CSS and script.
   - Entry markup:
     `<li data-type="feature|improvement|fix|change" data-area="lang|llm|savings|agents|cli|privacy|packaging"><span class="tag">Feature|Improvement|Bug fix|Change</span><span><span class="area">Area label</span>…</span></li>`.
     A feature's text starts with its name in `<b>`. Escape `<`, `>` and `&`.
   - If no area fits, add a new `data-area` key with its `<option>` in the
     area filter and its row in the "Counts by area" table.
5. **Recount.** After editing, make the five `.stat` numbers and every row of
   the "Counts by area" table (including Total) match the number of
   `<li data-type=… data-area=…>` entries per type and area.
6. **Regenerating the whole changelog** (only when asked):
   - List the fork's own commits with
     `git log --no-merges --cherry-pick --right-only --reverse --format="%h|%ad|%B" --date=short upstream/main...HEAD`
     and read uncommitted changes with `git status` / `git diff`.
   - Build the entries from them with rules 1, 2 and 4, describing the
     current code (check it), not the history in the commit messages.
   - Keep every existing bundle group with its date and version, and keep
     each entry in the bundle group that first shipped it unless it changed
     since. Put entries that never shipped in a recorded build into commit
     groups, one per date of the change's first commit (entries with the same
     date share a group). Put uncommitted changes, and entries rewritten since
     their last bundle, in the pending group.
   - Then recount (rule 5) and run
     `node --import tsx --test test/changelog-stamp.test.ts`.
7. **Report it.** End your final reply with one line naming the changelog
   entries you added, updated or removed, or saying the change did not qualify.
   Tasks that change no code (questions, reviews, plans) leave the changelog
   alone and need no such line.
<!-- changelog:end -->
