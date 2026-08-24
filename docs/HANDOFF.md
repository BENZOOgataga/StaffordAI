# Handoff

Where things stand and what has bitten, so a fresh start on another machine or in a fresh session picks up
from reality rather than from a chat log it does not have. I keep this current. If it disagrees with the code,
the code wins and this needs fixing.

## Start here

Read these, in order:

1. This file, top to bottom. It is the pick-up-anywhere doc.
2. `docs/owed-review.md`, newest top block first. What is built, what is next, what is deferred, what is owed.
3. `docs/plans/PERMISSION-SYSTEM.md`. The permission model. Phases 1, 2, and 3 are all shipped.
4. `docs/plans/design-spec.md`. The decided layout and visual direction the shipped UI is built to.
5. `docs/KNOWN-ISSUES.md`. The screenshot and environment leaks to check before anything public, and the
   third-party plugin noise that is not ours.

## Current shipped state

v0.1.0 is released, Windows only, tagged `v0.1.0`, marked latest not pre-release. It runs fully headless
through the stream-json protocol. node-pty is gone from the app, so there is no terminal to race and the first
message sends like any other. That was the root fix for the old rc.1 first-message quirk, not a patch over it.
macOS and Linux are deferred to later releases. I develop on Windows, and gating the first release on macOS
verification was too much friction.

The UI overhaul is done and the app is de-webified. Three React islands (Home, Roster, Channel) render inside a
shared shell, navigated by a sidebar. The Electron menu bar is hidden with accelerators still working. The
window is frameless with a custom title bar on Windows and Linux and the native frame on macOS, and close hides
to the tray rather than quitting. The default window proportions were retuned smaller, and the app opens on Home.
Selection, focus ring, caret, and scrollbar are all on theme, and the old vanilla chrome is gone.

The one vanilla surface left is the create-project and hire modals, which still use native `<select>` dropdowns.
Replacing those with the shadcn Select needs the modals migrated to React first, which is the next UI cleanup and
is deferred, not lost.

The permission system is live, all three phases shipped on main. A colleague's tool calls are checked at
`can_use_tool` against project baseline rules plus per-colleague overrides. Allow proceeds, deny is refused
cleanly, and ask pauses the colleague's turn on a pending approval that I answer in the app, approve or deny,
with the turn continuing or stopping on my answer. On shutdown every pending ask is denied so nothing hangs.
Phase 3 added the config UI: I edit project baselines and per-colleague overrides inside Stafford, over IPC,
written to the store, and the generated default profile is shown collapsed and editable on both the project
screen and each colleague's tab. The default profile denies Stafford's own userData and my real host credential
directories (`~/.claude`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.docker`, `~/.kube`, `~/.config/gh`, the git
credential files, and the Azure and gcloud stores), so a colleague cannot read them. The model, the invariant,
and the phasing are in `docs/plans/PERMISSION-SYSTEM.md`.

The tasks feature is shipped too, phases 1 and 2 on main. I assign a task to a colleague, it runs bounded (a
turn cap and a stall detector, either landing the task in needs-you rather than auto-failing), its work lands on
its own `stafford/task/<hire>/<task-id>` branch, and it reaches done only when it emits the completion sentinel
and I approve the review. Send-back resumes the same session with a note. A read-only board answers "what needs
me" across colleagues. This was the feature the whole permission arc was the foundation for.

## What is next

In order, roughly:

1. The create and hire modals to React, then the native `<select>` swapped for the shadcn Select. This is the
   one vanilla surface left, described above.
2. Whatever the next product step is after tasks. The permission and tasks arcs that filled this list are done,
   so the next feature is an open choice rather than a queued one.

## What is owed, verification I have not done

One manual check is owed and not yet done: the in-app ASK click-through on a real destructive command. Phase 2
is human-verified for the approve and deny flow in a normal session, but I have not driven a genuinely
destructive tool call (a real delete or an overwrite) all the way through the pending-approval UI on a packaged
run and confirmed the colleague pauses, my deny stops it, and my approve lets exactly that one call through. Do
this on a packaged build before trusting the ask path against real risk. It is recorded in `docs/owed-review.md`.

macOS still owes a real-run verification of the headless runner path when it is picked up. The old pty-path
blockers are moot because that path is deleted, but the runner has never run on a real Mac spawn.

## Parked and cosmetic

Small things I know about and have chosen not to fix yet. None blocks anything.

- The tray icon is blank on both platforms. The tray is built from an empty image, so its tooltip and context
  menu work but there is no glyph. Genuinely parked, cosmetic only.
- The macOS z-order click-test and the macOS DevTools and menu accelerators both look fixed in code. The dock
  and activation policy now follows the window rather than pinning the app as a permanent accessory, which was
  the shared cause. I have not confirmed either on a real Mac, so treat them as fixed-pending-hardware and
  verify on the next Mac run rather than assuming.

(An earlier revision of this list mentioned a stray Ask badge in a colleague permissions nav rail. That was
wrong: there is no such nav rail and no stray badge in the code. Removed rather than carried.)

## Standing workflow rules

These hold across every task on this repo:

- Branch before work, never commit on main. Conventional Commits. No co-authors. I push, an agent does not push
  unless I say so in the task.
- Every task lands through a PR into main, and merges only when all CI legs are green on both platforms. Never
  merge on red. Re-run transient CI infra failures rather than admin-merging past them.
- No secrets anywhere, including PR bodies. Never the string "Generated with Claude Code" anywhere, PR bodies
  included.
- Human-facing text (docs, UI copy, commit messages, PRs) reads as human-written. No em or en dashes, no smart
  quotes, no ellipsis characters, no "Bold term: explanation" lists. Plain punctuation.
- Kill a process only by exact PID, never by image name.
- The userData permission config is user-only and never reachable by a colleague. A colleague can never read to
  modify or write its own permissions. Only I set permissions.

## Which machine, and syncing home

I move between the work PC (Windows) and home (Mac). Both pull main. Main is the single source of truth. At the
start of a session anywhere, `git checkout main && git pull`, then read this file. When I finish a chunk, it
lands on main so the other machine gets it on the next pull. There is no other channel. If it is not on main it
did not happen.

The work PC cannot run `electron-builder` or the packaged-bundle guard locally, because the corporate network
blocks the Electron fetch `app-builder` needs. So Windows packaging and the unsigned-exe check run on CI. The
Mac has no such limit and can do packaged verification and a real Claude spawn locally, which the work PC never
could.

## The by-hand v0.1.0 release checklist, Windows only

I perform these. The tag-triggered release automation is scoped but deferred.

1. Make sure main is clean and green. `git checkout main && git pull`, then confirm the latest CI run on main is
   green on every leg. `package.json` is at 0.1.0.
2. Download the Windows artifact from CI. On the green Actions run for the main commit being released, open the
   run, go to Artifacts, and download `Stafford-windows-x64`. GitHub wraps an artifact in an outer zip, so if it
   comes down double-zipped, unwrap it to get `Stafford-0.1.0-win-x64.zip`. This zip is the release binary. It
   is unsigned by the deterministic config, which the packaged-bundle check on that same run already asserted.
3. Optional light confirm on that exact zip. Unzip it outside the repo, run `Stafford.exe`, approve the
   SmartScreen warning, hire a colleague, send a first message, and confirm it answers with no resend, then open
   the Transcript tab and confirm the reply and any tool calls show.
4. Tag the version. From a clean main, `git tag vX.Y.Z` and `git push origin vX.Y.Z`. Pushing the tag is the live
   action, and it is mine to take.
5. Create the GitHub release. On the tag, create a release, leave the pre-release checkbox unticked and mark it
   latest, upload the zip, and paste the notes from `docs/releases/X.Y.Z.md`.

That is the whole release. No Mac, no local build, no signing.

## Running a packaged verification beside a live Stafford

Set `STAFFORD_APP_ID=<id>` alongside `STAFFORD_SMOKE=1` for any packaged smoke or screenshot run. The app id
names both the Windows hook pipe and the data-dir segment, so an overridden run gets its own pipe and its own
store and coexists with a running Stafford instead of colliding on the fixed `Stafford` endpoints. Without it, a
running instance holds `\\.\pipe\Stafford` and the smoke harness cannot bind.

## The rich activity feed

The Activity tab is a merged feed of persisted accomplishment rows, live-only reads and searches, and
state-change rows. It reads Claude's own session transcript rather than registering tool hooks, so it costs no
added latency, and a selective coalesced cut is stored in the append-only `activity_events` table (migration
0003), with `shouldPersist` the one place that cut lives. The design is in `docs/plans/RICH-ACTIVITY-SPLIT.md`.

It stays fully off the state path. The feed registers no hook, never derives state, and never touches the drain,
which an import-boundary test asserts. Its one fragility, recorded plainly: it reads Claude's transcript, an
undocumented version-dependent file, so a Claude update could reshape it. The parser degrades rather than
crashes, an unknown line is skipped, and if nothing parses the feed falls back to the state rows and persisted
history it already has. A transcript-format change costs the rich rows, it does not break the app.

## Two regression patterns that cost real time, so watch for them

These are from the headless migration arc. The specific hook and registry machinery they name is from the old
pty era and is gone, but the two lessons hold for any change to the spawn or session lifecycle.

### Tested in the harness, absent in the packaged app

Several times, logic passed its tests and was never wired into the Electron spawn path the UI actually uses. The
tests called the lifecycle directly with an injected stub, the packaged UI spawn went through a different entry,
and the wiring the tests never exercised was missing there. Every one of these was invisible to a green suite and
obvious in a 30-second packaged reproduction.

The habit: when a fix touches the spawn or the session lifecycle, prove it in a real packaged run, not only in
the unit test. The owed `@real-machine` test, one CI-skippable test that drives a real Claude spawn through the
actual lifecycle dependencies `index.ts` wires, would catch these at the seam where they live. Still owed.

### A cross-fix regression, a new signal defeats another feature's precondition

A fix once added a new event to a shared path, and another feature quietly depended on a precondition that new
event changed, so the second feature broke while both kept passing tests, because the tests fired the raw
underlying event and never the new higher-level one.

The lesson: when you add an event or signal to a shared path (a registry, the lifecycle, a state machine), check
what already reads that path and whether the new event changes a condition it treats as meaningful. A unit test
that fires only the raw underlying event misses it.
