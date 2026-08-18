# Release automation: scope and split

Benzoo wants to push a version tag and have GitHub build both platforms, create the release, and publish it
with a two-tier notes format. This scopes that workflow and the notes convention. It builds nothing: the
workflow is not written here, because the first cut of v0.1.0 is by hand, and that manual cut teaches what the
workflow must automate. When v0.1.0 is out, a later prompt implements this and v0.1.1 is the first automated
release.

## The end-to-end flow, from Benzoo's seat

Benzoo asks the agent to make a release, and it happens:

1. The agent drafts the curated notes. It knows what shipped since the last tag, so it writes the Features
   narrative and picks the Bug Fixes worth calling out, into a notes file the workflow reads
   (`docs/releases/<version>.md`). It prepares or points at the screenshots the Features section needs, taken
   through the `STAFFORD_APP_ID` override and cropped per the screenshot-leak note in `docs/KNOWN-ISSUES.md`.
2. The agent bumps `package.json` to the version, commits that with the notes file, and pushes.
3. The tag is pushed. This is the one live action: a tag matching `v*` fires a public release, so pushing it
   is an outward, hard-to-reverse action. Per the standing safety rules the agent does not push it silently.
   Either Benzoo pushes the tag himself, or the agent pushes it only on his explicit per-release go-ahead. The
   recommendation is Benzoo pushes the tag, because the tag is the deliberate release signal and it should
   stay a human hand on the trigger even when the agent prepared everything up to it.
4. CI does the rest. The tag push triggers `release.yml`, which builds darwin-arm64 and windows-x64 in
   parallel, creates the GitHub release on the tag, uploads both zips, and assembles the notes.

So from Benzoo's seat: ask the agent, it drafts notes and screenshots and the version bump, the tag goes up
with his ok, and CI ships both platforms. He never opens a build tool, and he never needs a Mac in hand.

## The two-tier notes format

The format matches Dokploy's: a curated top half on a big release, an auto-generated changelog always.

The auto half is generated every release from the PR and commit history since the previous tag: a
What's Changed list with each merged PR by title, author, and number, a New Contributors section, and a
Full Changelog compare link. Benzoo's commits are strictly conventional, so this half is reliable without any
hand editing. The mechanism is GitHub's own release-notes generation, the `POST /repos/{owner}/{repo}/releases/generate-notes`
endpoint (what `gh release create --generate-notes` calls). An optional `.github/release.yml` can group the
list into categories (Features, Fixes, and so on) by label or conventional-commit prefix, which is worth
adding so the auto list reads cleanly.

The curated half is supplied by a notes file, because screenshots and narrative cannot be generated from
commits. The workflow looks for `docs/releases/<version>.md` where `<version>` is the tag without its `v`
(so the tag `v0.30.0` reads `docs/releases/0.30.0.md`). If the file exists, its contents are prepended above
the auto changelog. If it does not exist, the release is the auto changelog alone.

So a big release, with a notes file, reads as a curated Features and Bug Fixes section on top of the auto
What's Changed, like Dokploy v0.30.0. A patch, with no notes file, is just the auto What's Changed, like
Dokploy v0.29.14. The tier is chosen by whether the agent wrote a notes file, not by a flag, which keeps a
patch zero-effort and a feature release as much effort as the prose deserves.

The combining is one step: the workflow calls generate-notes to get the auto markdown, reads the notes file
if present, and sets the release body to the notes file followed by the auto markdown. It does not use
`--notes-file` alone, which would replace the auto notes rather than sit above them. A template for the
curated file is in `docs/releases/TEMPLATE.md`.

## The trigger and the version

The workflow triggers on a pushed tag matching `v*`, nothing else. Not on merge, not on a schedule. The tag
is the deliberate signal: a release happens when Benzoo decides, by tagging. Pre-1.0 the version is his call,
semver is soft, and milestones are human, so there is no automated version computation and no release-please
in v1.

The tag and `package.json` are reconciled by verification, not by the workflow bumping anything. The agent
bumps `package.json` in the same commit it tags, so the workflow's first step reads `package.json`, strips the
`v` from the tag, and fails the release if they differ. That keeps `package.json` the single source of the
version and the tag the trigger, and it catches a tag pushed against the wrong commit before anything builds.
Verifying is better than bumping, because a workflow that rewrote `package.json` and pushed a commit back
would be a second live action on top of the tag, and the point is one deliberate trigger.

## The build matrix

On a `v*` tag the workflow runs the same two package legs CI already runs, in parallel: darwin-arm64 on
`macos-14` with `--mac --arm64 --dir`, windows-x64 on `windows-latest` with `--win --x64 --dir`. The steps are
the ones the CI package job already proves: `npm ci`, `node scripts/fix-node-pty-permissions.cjs`,
`npm run electron:install`, `npm run typecheck`, `npx electron-vite build`, `npx electron-builder <arch>`,
`node scripts/check-packaged-bundle.cjs`. Then each leg zips its produced directory into
`Stafford-<version>-darwin-arm64.zip` and `Stafford-<version>-win-x64.zip` and uploads it to the release.

Both artifacts are unsigned, which is what the README promises. The Windows build is deterministically
unsigned through the no-op sign hook, and the packaged-bundle check already asserts the exe carries no
signature, so the release cannot ship a signed Windows binary by accident. The darwin build is unsigned too
(no Apple account, `identity: null`), click-to-update.

The real payoff is that the macOS artifact builds on a runner. The by-hand cut needed Benzoo holding a Mac to
produce the darwin zip; the tag-triggered matrix builds it on `macos-14`, so a release no longer needs a Mac
in hand at all. That is the whole reason to automate this.

## Permissions and safety

The release job needs `contents: write`, to create the release and upload assets. This is the one elevated
workflow, and it is scoped tightly. The `permissions` block grants `contents: write` on the release job only,
and the workflow triggers on `push` of a `v*` tag only, never on `pull_request` and never from a fork. A fork
PR cannot push a tag to this repository, so fork code can never reach the elevated job. This is the deliberate
permission increase the earlier PR-hardening anticipated: external PRs stay read-and-review, and the one job
that can publish is gated on a tag that only a repo collaborator can push.

No secret beyond the default `GITHUB_TOKEN` is needed, which can create releases and upload assets. There is
no signing in v1, so no `CSC_*` or signing credential is needed or present, which the config already enforces.

## The build split, for the post-v0.1.0 implementation

Two pieces.

1. The workflow and the notes convention together, because the workflow reads the file. `release.yml` with the
   `v*` tag trigger, the version-matches-`package.json` check, the two-leg matrix build, the zip and upload,
   and the notes assembly (generate-notes plus the prepended `docs/releases/<version>.md` if present), plus
   the `docs/releases/TEMPLATE.md` convention and an optional `.github/release.yml` for auto categorization.
   First, because it is the engine, and it is proven by cutting v0.1.1 as a patch: no notes file, auto
   changelog only, both zips built and published on the tag with no Mac in hand.
2. The agent-driven flow, documented in `docs/HANDOFF.md`: how the agent drafts the curated notes from the
   merged work, prepares the screenshots, bumps `package.json`, and hands the tag to Benzoo. It depends on
   piece 1 existing, and it is proven by an agent-drafted feature release with a real notes file and
   screenshots.

## Next action and recommendation

Next action, and it waits: cut v0.1.0 by hand first, per the Mac runbook in `docs/HANDOFF.md`. That manual cut
is what teaches the exact zip names, the release-notes shape, and the steps the workflow must reproduce. Only
after v0.1.0 is out does piece 1 get built, with v0.1.1 as its first automated run.

One recommendation: make v0.1.1 the workflow's first run deliberately, as a patch with no notes file, so the
first automated release exercises only the auto half and the build-and-publish path, with nothing curated to
get wrong. Prove the engine on the simple tier, then use the curated tier on the next feature release. A first
automated run that also tried to assemble a hand-written top section would be two new things failing at once;
one at a time is how the seam stays debuggable.
