# First release and public hygiene: scope and split

Stafford's core is complete and the repository is public. This prepares it for a broader audience: a first
release with unsigned binaries for both platforms, and the repository hygiene that open contribution needs.
It is three distinct kinds of work (hygiene docs, release mechanics, and a CI and settings posture for public
PRs), so it is scoped and split before anything is built, the way the features were.

This is a scope pass. It builds nothing. No release is cut, no hygiene file is written, no workflow is added.
It reports what exists against what a contribution-open, releasable repository needs, proposes the split, and
names the decisions that are Benzoo's.

Two of Benzoo's decisions are settled and frame everything below. First, the contribution posture is open to
PRs, but external merges are never automatic: external PRs get reviewed by an agent and reported, and Benzoo
decides every external merge. Benzoo's own branches keep the merge-on-green rule. External is the exception,
because green tests correctness, not intent, licence fit, supply-chain safety, or design fit. Second, the
first release ships unsigned binaries for both platforms. There is no code signing, so Gatekeeper on macOS
and SmartScreen on Windows will warn, and the install instructions that ride with the release are the whole
game. They go where a stranger sees them, not buried.

## The split

Three pieces. Docs, then mechanics, then CI and settings hardening. Order argued below.

1. Hygiene docs. Docs only, no mechanics, no CI surface. README status pass and posture fix, `CONTRIBUTING.md`,
   `CODE_OF_CONDUCT.md`, issue templates and a PR template, and a `SECURITY.md` confirm. Depends on nothing.
2. Release mechanics. The version bump, the tag scheme, the artifact decision (what electron-builder must
   produce to be shippable, which is not what it produces today), and manual versus workflow. Depends on piece
   1 for the install instructions the release notes reuse.
3. Public-PR CI and settings hardening. The workflow permission and trigger audit against the higher stakes of
   public PRs, the fork-PR review requirement that backs the no-auto-merge rule, and, only if piece 2 chose a
   release workflow, the least-privilege `contents: write` that publishing needs. Depends on piece 2's release
   decision for its last part.

Hygiene docs go first. They are reversible, they carry no new CI surface, and they set the posture the other
two pieces assume: the release notes in piece 2 reuse the README's install instructions, and the CI hardening
in piece 3 backs a contribution rule the docs are the ones to state. Nothing in the release or the hardening
lands well until the posture it assumes is written down.

## 1. Repository hygiene: present, absent, and what each should say

Present: `README.md`, `LICENSE` (AGPL-3.0-only, intact and referenced from the README's licence section and
`package.json`), `SECURITY.md`. Absent: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE/`, a
pull-request template, `CHANGELOG.md`.

### README

Judged as a stranger's first screen, the README explains what Stafford is well: the people-centric framing,
the Stafford Beer name, the hook-derived state, the pty-per-agent model. Two things are wrong for a
contribution-open, about-to-release repository.

The status section is stale and now understates the project. It reads "Early. Not usable yet, and not
installable yet," and the table marks Roster, terminal view, the rest of the interface as Not started, and
the Electron migration as Planned, in progress. Those pieces (roster, detail view, session lifecycle, the
whole channel) are built and merged. A stranger reads the project as earlier and less finished than it is.
The status pass has to reset this to the pre-release-but-working reality without overclaiming: unsigned, first
release, warns on launch.

The Contributing section states the opposite of the settled posture. It currently says the project "is not
actively seeking external contributions yet" and that bug reports and questions are welcome as issues. The
decision is now open to PRs, reviewed, merged at the maintainer's discretion. This section has to change to
match, with the detail living in `CONTRIBUTING.md` and the README pointing to it.

Also missing for a landing page: an install section (the unsigned-binary caveat and the per-platform
click-through, see section 2), a platforms line stated as install targets rather than only as test targets,
and a where-to-file-issues pointer (Issues for bugs and features, `SECURITY.md` for vulnerabilities). Gaps
only, not rewritten here.

### CONTRIBUTING.md

Absent, and it carries the posture, which makes it the most load-bearing new doc: it is where the two-tier
merge rule is stated in the open. It should say plainly that issues are welcome; that PRs are welcome but
reviewed and merged at the maintainer's discretion; that this is primarily a personal project; and that
external PRs are not auto-merged on green, because green means the tests passed and the maintainer still weighs
intent, licence fit, supply-chain safety, and design fit. It should also carry the internal conventions the
README already lists for readers of the history (branch before work, never commit to `main`, Conventional
Commits, pinned minimal dependencies with the lockfile committed, never commit secrets) so a contributor meets
one door, not two, plus the AGPL-3.0 inbound-equals-outbound expectation a copyleft licence implies for
contributions.

### CODE_OF_CONDUCT.md

Recommended present. A standard Contributor Covenant is cheap, expected on a contribution-open repository, and
gives a named basis for moderating a public issue tracker. The only real choice is the contact point, and
`contact@benzoogataga.com` already serves that role in `SECURITY.md`. This is a yes/no for Benzoo (section 5),
with the recommendation being yes.

### SECURITY.md

It still says the right thing: private disclosure to `contact@benzoogataga.com`, no bounty, best-effort,
sensible scope. One reconciliation for the contribution-open state: its opening still reads "pre-release and
not yet usable," the same staleness the README carries, so it should track whatever the README status pass
settles on, so the two front-facing docs don't disagree. Its note on the Claude Code sandbox is about a
containment property of the design and implies no `ProjectPolicy.sandbox` code, so no code changes here. The
content is otherwise correct for a repository that now invites reports.

### Issue and PR templates

Absent, and their shape matters for this project. The bug report has to capture what Stafford bugs actually
need: platform (Windows 11 or macOS, and arch), app version, and the ConPTY and native-module context, which
means whether it involves a pty session, node-pty or better-sqlite3, and whether it is a packaged build or a
dev run. A generic template collects none of this, and every pty bug then costs a round-trip to ask. The
feature request wants the standard problem-and-proposal shape, with a nudge toward the people-centric framing
so requests arrive as "a colleague should be able to..." rather than "add a task field." The PR template sets
the external-PR expectation in the author's face (reviewed, not auto-merged, maintainer decides) plus a short
checklist: tests included and passing, Conventional Commit title, no secrets, lockfile committed if
dependencies changed. That template is where the two-tier rule meets the contributor at the moment they open
the PR.

### Labels and triage convention

Worth a minimal set eventually (`bug`, `enhancement`, `security`, `needs-triage`), but it doesn't block the
release or the posture and it is cheap to add once real issues arrive to shape it. Deferred.

## 2. Release mechanics: the options

### Version and tag scheme

`package.json` says `0.0.1` today, with `private: true`. The first public release is naturally `0.1.0`:
pre-release, no stability promise, room below `1.0.0`. Tag scheme is semver with a `v` prefix (`v0.1.0`), the
GitHub-conventional form a release workflow would trigger on. The version bump is a one-line change owned by
piece 2. Leave `private: true` (it guards against an accidental `npm publish` and does not affect a GitHub
release). `package.json` is also missing `repository`, `bugs`, and `homepage`, which a release and the issue
links in the docs both benefit from, so fold that small addition into piece 2.

### What the release contains, and the gap that has to close first

`electron-builder.yml` currently targets `dir` only for both platforms: unpacked application directories
(`Stafford.app` for each mac arch, `win-unpacked/` for Windows x64), which is exactly what the CI packaging
legs already prove and inspect. An unpacked directory is not a shippable release artifact. You can't attach a
folder to a GitHub release, and a user can't download one file and run it. So the release-mechanics piece
carries a real decision the current config doesn't answer: how to turn the proven `dir` output into a
downloadable artifact. Two options, cheapest first.

Zip the `dir` output. Smallest change: keep the `dir` target the CI already trusts, zip the unpacked app per
platform, attach the zips. On macOS a zipped `.app` still honours the right-click-Open path past Gatekeeper;
on Windows a zipped `win-unpacked` runs the `.exe` inside. Least new surface, and it ships exactly the bundle
CI verifies.

Add real installer targets (`dmg` or `zip` for mac, `nsis`, `zip`, or `portable` for Windows). More polished,
but `dmg` and `nsis` are new build outputs the packaged-bundle check has never inspected, so they widen what a
release ships beyond what CI proves, and unsigned they warn exactly the same as a zip. More surface for no
reduction in the warning that is the whole install story.

Recommendation to carry into piece 2: zip the `dir` output, because it ships the artifact CI already verifies
and adds no unproven build target. Source archives are automatic, since GitHub attaches them to every tag.

### Install instructions that must ride with the release

These are the release, given no signing. Per platform, from the current unsigned `dir` and zip output.

macOS, past Gatekeeper: download the zip, unzip, move `Stafford.app` to Applications, then right-click the app,
choose Open, and confirm Open in the dialog. A plain double-click only offers Cancel on an unsigned,
un-notarised app. This is a one-time approval per install. If the quarantine dialog is the hard-refusal
variant, the fallback is `xattr -dr com.apple.quarantine /Applications/Stafford.app` in Terminal, documented
as a fallback rather than the primary step.

Windows, past SmartScreen: download the zip, unzip, run `Stafford.exe`; on the blue "Windows protected your
PC" prompt, click More info, then Run anyway. One-time per binary.

These go in the release notes and the README install section, prominently. They are the difference between a
release a stranger can run and one they bounce off.

### Manual versus tag-triggered

Manual first release: build locally with the existing `package` script (extended to both platforms and
zipped), draft the release, upload. Simplest to get right once, no new CI surface, and the first release is
exactly the case where getting it right once by hand beats debugging a new workflow. The cost is that it is
not repeatable and depends on a correct local toolchain.

Tag-triggered release workflow: a new workflow on `push: tags: v*` that builds both platforms and publishes
the release. Repeatable and hands-off, but it is new CI surface that builds and publishes artifacts, and it
needs `contents: write` (section 3), a real privilege increase over the read-only test workflows.

Recommendation to carry into piece 2: manual for `v0.1.0`, then codify a tag-triggered workflow once the
manual steps are known-correct. The workflow is easier to write against a release you have already cut by hand
than to design blind. This is Benzoo's call (section 5).

## 3. CI and settings for public PRs: the new attack surface

Open PRs mean fork code runs in CI. The audit against that higher bar:

No `pull_request_target`, and no secret exposed to fork code. Both workflows trigger on `push`, `pull_request`
(CI), `schedule` and `workflow_dispatch`, and neither uses `pull_request_target`, the trigger that would run a
fork's PR with the base repository's secrets and write token. `ci.yml` declares top-level `permissions:
contents: read`; `pty-probe.yml` is `workflow_dispatch` only with `contents: read`. No workflow references a
repository secret at all, and the one external download (gitleaks) is a pinned public release URL, not a
credentialled fetch. A fork PR therefore runs with a read-only `GITHUB_TOKEN` and no secrets, which is the
correct posture and is already in place. Nothing to change here; confirm and keep it.

GitHub's default fork-PR approval is the first gate. Workflows from a first-time contributor's fork require
maintainer approval to run at all, so fork code does not even execute in CI without a click. Confirm the
repository setting is at least "require approval for first-time contributors" (GitHub's default), and consider
the stricter "require approval for all outside collaborators."

Backing the two-tier merge rule in the ruleset. "Own branches auto-merge on green, external PRs never" is a
process rule the agent and Benzoo follow; the ruleset cannot express "author is Benzoo." What the ruleset can
do is require a review approval on PRs, which forces every fork PR through an explicit human or agent approval
before merge and makes the no-auto-merge rule structural rather than only documented. The tension: the same
required-review would also apply to Benzoo's own PRs unless a bypass actor is configured. So the choice is
either require review for everyone and grant Benzoo bypass (keeping his merge-on-green), or leave it a
documented rule and rely on discipline. Reported as a decision (section 5), not decided here.

A release workflow's `contents: write` is a deliberate scope increase. If piece 2 chooses the tag-triggered
workflow, it needs `contents: write` to publish a release, broader than every current workflow's `contents:
read`. Keep it least-privilege by scoping `contents: write` to that one workflow (never raising the repository
default), setting it per-job rather than top-level, triggering only on `push: tags: v*` (not on
`pull_request`, so no fork can invoke it), and using the built-in `GITHUB_TOKEN` rather than any personal or
long-lived token. Called out as deliberate so it is chosen, not slipped in.

## 4. Decisions that surface: reported, not decided

- First version number and tag scheme. Recommended `0.1.0` and `v0.1.0`. Benzoo confirms.
- Manual release versus tag-triggered workflow. Recommended manual for the first, workflow after. Benzoo's call.
- Require a review approval on fork PRs in the ruleset to back the no-auto-merge rule (with a Benzoo bypass
  actor), or leave it a documented rule. Reported for Benzoo.
- Code of conduct yes or no. Recommended yes (Contributor Covenant, `contact@benzoogataga.com` as contact).
- The AI-authorship and third-person phrasing in the docs, parked earlier and left as-is. Now that the docs
  are front-facing, whether they get an authorship and voice pass or stay as they are is a standing choice.
  Reported, not touched, no rewrite here.

## Next action and recommendation

Next action: start piece 1, the hygiene docs. The README status-and-posture pass, `CONTRIBUTING.md`,
`CODE_OF_CONDUCT.md`, the issue and PR templates, and the `SECURITY.md` staleness reconcile. Docs only,
reversible, no CI surface, and it writes down the posture the release notes and the CI hardening both assume.

One recommendation: when piece 2 lands, zip the already-proven `dir` output and cut `v0.1.0` by hand. It ships
exactly the bundle CI verifies, adds no unproven installer target and no new CI surface for the first release,
and lets the tag-triggered workflow be written later against steps already known to be correct. Given no
signing, the release's whole value lives in the per-platform click-through instructions, carried prominently
in both the release notes and the README.
