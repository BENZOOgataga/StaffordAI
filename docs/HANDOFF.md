# Handoff

Where things stand and what has bitten, so a fresh start on another machine picks up from reality rather than
from a chat log it does not have.

## Start here

Read these three, in order:

1. `docs/owed-review.md`, the newest top block dated 2026-08-20 (the headless migration done and v0.1.0
   shipping clean). What is built, what is next, what is deferred, and what the release waits on.
2. `docs/plans/design-spec.md`. The decided layout and visual direction that the shipped UI is built to.
3. `docs/KNOWN-ISSUES.md`. The screenshot and signing leaks to check before anything public, and the
   third-party plugin noise that is not ours.

The redesign and the git executor loop are both done. v0.1.0 ships Windows only. macOS is deferred to a later
release, because I develop on Windows and switching machines to verify macOS is too much friction to gate the
first release on. That decision removes the Mac from the v0.1.0 path entirely: there is no Mac step left before
cutting it. The macOS verification checks that were release blockers (the Keychain credential path from #61,
the cold-start first message from #63, the hooks from #65, the five-fast delivery from #67) are no longer
v0.1.0 blockers. They move to whenever macOS is picked up, tracked in `docs/owed-review.md`.

v0.1.0 ships clean, as a normal release, not a pre-release. The rc.1 first-message quirk is gone at the root:
the headless stream-json migration (phases 2 to 5 in `docs/plans/HEADLESS-STREAM-JSON.md`) replaced the whole
pty delivery path, so there is no terminal to race and the first message sends like any other. That is
human-verified in a real GUI run. So the release notes carry no known-issue asterisk, and the release is marked
latest, not pre-release. The rc.1 pre-release stays as the earlier one.

The Windows distributable comes from CI, because the work PC cannot run electron-builder (the corporate network
blocks the Electron fetch it needs). The Windows package leg builds a real zip and uploads it as an Actions
artifact, so I download it from CI rather than building locally. With `package.json` at 0.1.0, the zip is named
`Stafford-0.1.0-win-x64.zip`.

## The by-hand v0.1.0 release checklist, Windows only

I perform these. Nothing here is automated yet; the tag-triggered release automation is deferred.

1. Make sure main is clean and green. `git checkout main && git pull`, then confirm the latest CI run on main
   is green on every leg. `package.json` is at 0.1.0.
2. Download the Windows artifact from CI. On the green Actions run for the main commit being released, open the
   run, go to Artifacts, and download `Stafford-windows-x64`. GitHub wraps an artifact in an outer zip, so if it
   comes down double-zipped, unwrap it to get `Stafford-0.1.0-win-x64.zip`. This zip is the release binary. It
   is unsigned by the deterministic config, which the packaged-bundle check on that same run already asserted.
3. Optional light confirm on that exact zip. Unzip `Stafford-0.1.0-win-x64.zip` outside the repo, run
   `Stafford.exe`, approve the SmartScreen warning, hire a colleague, send a first message, and confirm it
   answers with no resend, then open the Transcript tab and confirm the reply and any tool calls show. This is
   already human-verified, so it is a light confirm, not a gate.
4. Tag v0.1.0. From a clean main, `git tag v0.1.0` and `git push origin v0.1.0`. Pushing the tag is the live
   action, and it is mine to take.
5. Create the GitHub release. On the v0.1.0 tag, create a release, leave the pre-release checkbox unticked and
   mark it the latest release, upload `Stafford-0.1.0-win-x64.zip`, and paste the notes from
   `docs/releases/0.1.0.md`. Title it Stafford v0.1.0.

That is the whole release. No Mac, no local build, no signing.

## The Mac can finally verify locally

The work PC could not run `electron-builder` or the packaged-bundle guard locally, because its corporate
network blocks the Electron fetch `app-builder` needs, so both the Windows packaging and the unsigned-exe check
were verified on CI rather than on the machine. This Mac has no such limit, so it can do packaged verification
and the real-spawn test locally for the first time. Use that: the real-spawn run in step 2 and the darwin build
in step 3 are the two things the work PC never could do.

## The rich activity feed, landed

The Activity tab is a merged feed of persisted accomplishment rows, live-only reads and searches, and the
existing state-change rows. It reads Claude's own session transcript rather than registering the tool hooks,
so it costs no added latency and needs no new hook: the transcript path arrives on the SessionStart hook
already received, and a selective coalesced cut is stored in the append-only `activity_events` table
(migration 0003), with `shouldPersist` the one place that cut lives. The design and the split are in
`docs/plans/RICH-ACTIVITY-SPLIT.md`.

It stays fully off the state path. The feed registers no hook, never calls the registry, never derives state,
and never touches the drain, which an import-boundary test asserts, so a fault in it cannot move a colleague's
state, the roster, or the drain.

The one fragility, recorded plainly so it is not a surprise: the feed reads Claude's transcript, which is an
undocumented, version-dependent file, so a Claude update could reshape it. The parser is built to degrade,
not crash: an unknown or partial line is skipped, and if nothing parses the feed falls back to the state rows
and the persisted history it already has. The hook-based state feed stays authoritative and independent. So a
transcript-format change costs the rich rows, it does not break the app, and the fix would be to update the
parser, not to unpick anything from state.

## Running a packaged verification beside a live Stafford

Set `STAFFORD_APP_ID=<id>` alongside `STAFFORD_SMOKE=1` for any packaged smoke or screenshot run. The app id
names both the Windows hook pipe and the data-dir segment, so an overridden run gets its own pipe and its own
store and coexists with a running Stafford instead of colliding on the fixed `Stafford` endpoints. Without it,
a running instance holds `\\.\pipe\Stafford` and the smoke harness cannot bind, which cost real time before
the override existed.

## Two regression patterns that cost real time, so watch for them

### Tested in the harness, absent in the packaged app

Three times this arc, logic passed its tests and was never wired into the Electron spawn path the UI actually
uses. The tests call the lifecycle directly with an injected stub; the packaged UI spawn goes through a
different entry, and the wiring the tests never exercise was missing there. The hook registration was in the
old CLI harness but not the Electron spawn, so a real colleague reported no state. The resume fallback fired
in a direct-lifecycle reproduction but not in the packaged app, because the packaged path had registered
hooks and the direct one did not, which is the second pattern below.

The fix I keep recommending and have not built: one CI-skippable `@real-machine` test that drives a real
Claude spawn through the actual lifecycle dependencies, the same ones `index.ts` wires, and asserts the real
behaviours: a stale resume recovers to a fresh session, a first message spawns and the hooks report, the
colleague answers. It runs locally where a Claude binary and a login exist, and skips in CI where they do
not, the way the other real-machine tests already skip. It would have caught all three of these at the seam
where they live, the real spawn, instead of after a hand test on the packaged app. This is owed.

The cheaper habit until then: when a fix touches the spawn or the session lifecycle, prove it in a real
packaged run, not only in the unit test. Every one of these was invisible to a green suite and obvious in a
30-second packaged reproduction.

### A cross-fix regression: a new signal defeats another feature's precondition

The hook state-reporting fix registered all six of Stafford's hooks on the Electron spawn. A failed resume
then fired a `SessionEnd` hook, which reached the registry, which counted any event as activity and set the
session reported, which is exactly the precondition the stale-id fallback checks against. The fallback fires
only on an unreported exit, so a reported session skipped it and the colleague stayed stuck on the resume
error. The hook fix silently broke the resume fallback, and both had passing tests, because the resume tests
fired a raw process exit and never a `SessionEnd`.

The lesson: a new event or signal can change a precondition another feature quietly depends on, and a unit
test that fires the raw underlying event misses it. When you add an event to a shared path (the registry, the
lifecycle, a state machine), check what already reads that path and whether the new event changes a
condition it treats as meaningful. Here, a `SessionEnd` is a session finishing, not evidence it is alive and
working, so it should never have counted as activity for the fallback's purpose. That is the fix that
landed.
