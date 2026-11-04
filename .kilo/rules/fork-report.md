<!-- fork-report:start -->
## Keep the fork report up to date (rules for every AI agent)

`docs/fork-report.html` lists everything this fork adds to or changes in
upstream Graft (`NanoNets/Graft`, the `upstream` remote). Keep it in sync with
the code. Whenever a task you finish changes the fork in a way that qualifies
(rule 1), update the report in the same change, before your final reply,
without being asked.

1. **What qualifies.** A change users can notice: behaviour, commands, options,
   settings, supported languages, output, prices, agent instructions or skills,
   installer, packaging, update channel, CI, privacy. Not: refactors with no
   visible effect, test-only changes, comments, formatting, docs-only changes,
   the regenerated `graft/` index, or edits to the report itself.
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
3. **Content rules.**
   - No git information: no commit hashes, dates, authors, branch names,
     commit messages, history or diff statistics.
   - Describe the current state in plain language, not how the fork got
     there.
   - Edit the file in place; keep its layout, CSS and script.
   - Put each entry in the matching `<section>`, ordered features,
     improvements, fixes, changes, using
     `<li data-type="feature|improvement|fix|change"><span class="tag">Feature|Improvement|Bug fix|Change</span><span>…</span></li>`.
     A feature's text starts with its name in `<b>`. Escape `<`, `>` and `&`.
   - If no section fits, add a `<section id="…">` with its link in
     `nav.toc` and its row in the "Counts by area" table.
4. **Recount.** After editing, make the five `.stat` numbers and every row of
   the "Counts by area" table (including Total) match the number of
   `<li data-type=…>` entries per section and type.
5. **Report it.** End your final reply with one line naming the report entries
   you added, updated or removed, or saying the change did not qualify. Tasks
   that change no code (questions, reviews, plans) leave the report alone and
   need no such line.
<!-- fork-report:end -->
