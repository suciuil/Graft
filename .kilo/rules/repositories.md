<!-- repositories:start -->
## Where the source code is pushed (rules for every AI agent and contributor)

This fork uses two repositories on github-ct.int.automotive-wan.com:

- **Source code:** https://github-ct.int.automotive-wan.com/suciui/Graft-sources,
  the `origin` remote. Push every branch, every commit and the
  `refs/notes/changelog` notes there, and only there.
- **Packages and changelog:** https://github-ct.int.automotive-wan.com/suciui/Graft,
  the `graft-releases` remote, which can only fetch. It holds no source code.
  Its default branch `master` holds only a README, `gh-pages` holds the
  changelog page (the fork's homepage) and its releases hold the offline
  installer kits. Each kit's tag points at a commit that holds only a README.
  Only `scripts/publish-release.mjs` (run by `npm run pack:bundle` and
  `npm run release:publish`) and `scripts/publish-changelog.mjs`
  (`npm run changelog:publish`) write to it.

1. Never push a source branch, commit, tag or note to `suciui/Graft`, or to any
   other remote (`upstream`, `my`). Only the repository owner can ask for an
   exception.
2. When a clone's `origin` still points at `suciui/Graft`, repoint it before
   pushing:
   `git remote rename origin graft-releases`, then
   `git remote set-url --push graft-releases DISABLED-source-code-is-pushed-only-to-Graft-sources`,
   then `git remote add origin https://github-ct.int.automotive-wan.com/suciui/Graft-sources.git`.
3. When a release tag on `suciui/Graft` points at a source commit, run
   `npm run release:strip-sources`. It moves the tag onto a commit that holds
   only a README.
<!-- repositories:end -->
