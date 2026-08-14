# Handoff

Where things stand and what has bitten, so a fresh start on another machine picks up from reality rather than
from a chat log it does not have.

## Start here

Read these three, in order:

1. `docs/owed-review.md`, the top block dated 2026-08-14. What is built, what is next, what is deferred, and
   what the release waits on.
2. `docs/plans/design-spec.md`. The decided layout and visual direction. The next UI piece builds to it.
3. `docs/KNOWN-ISSUES.md`. The screenshot and signing leaks to check before anything public, and the
   third-party plugin noise that is not ours.

The next build piece is the Activity tab feed. See the owed-review next-pieces list.

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
