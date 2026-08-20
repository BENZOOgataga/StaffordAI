# Owed-list review, 2026-08-10

A single accounting of everything parked, taken from the plan and the tree rather than memory, so the
next build is chosen against the whole board. Read-only: this decides nothing and builds nothing.

## Update, 2026-08-20, v0.1.0 is Windows only and macOS is deferred

Read this block first. It is the newest.

v0.1.0 ships Windows only. macOS is deferred to a later release, then Linux after that. I develop on Windows,
and switching machines to verify macOS is too much friction to gate the first release on. This takes the Mac
off the v0.1.0 path: there is no Mac step left before cutting it, and the CI Windows package leg now builds a
real zip and uploads it as an Actions artifact (`Stafford-windows-x64`), so the release binary comes from CI
without a local build. The by-hand release checklist is in `docs/HANDOFF.md`.

The macOS verification checks that were v0.1.0 blockers are no longer v0.1.0 blockers. They move to whenever
macOS is picked up. They are: the Keychain credential path for the managed-config isolation (#61, does the
managed dir authenticate through Keychain with no file to copy), the cold-start first-message delivery on a
real Mac spawn (#63), the hooks firing in the managed dir on macOS (#65), and the five-fast serial delivery on
macOS (#67). None of these block Windows, which was verified directly.

One Windows check is still owed before the release is trusted, and it moved from the Mac to Windows: the
five-fast delivery proof (#67). It was proven against the state model, never in a live packaged app. With a
real CI-built Windows artifact now available, it becomes a manual check on that artifact, written into the
release checklist in `docs/HANDOFF.md` as the last gate before tagging v0.1.0. Send five fast messages to one
colleague and confirm five ordered turns, and confirm two colleagues do not cross-trigger.

## Update, 2026-08-18, the git executor loop is done and the release is one blocker away

Read this block first. It is the newest. The block under it records the redesign as complete, and everything
below that is older.

### The git executor loop landed, so committed work is real and findable

The drain used to write `committed=false` every time, because nothing turned a checkpoint into a real commit.
That is closed. On drain, a colleague's tracked work is committed to a `stafford/checkpoint/<hire>/<timestamp>`
branch through git plumbing over a temporary index, so the working tree, the real index, HEAD, and the current
branch end byte-for-byte unchanged and nothing lands on main or the working branch. Only tracked modifications
are committed (`git add -u`), never an untracked file, so a drain cannot sweep a secret into a commit.
`committed=true` is now genuine in `drain_report`, with a real branch and sha and a new `reason` column that
tells a clean tree from a failed commit from an executor timeout. The design and the split are in
`docs/plans/GIT-EXECUTOR-SPLIT.md`; this is the summary.

The save is no longer invisible. On launch a quiet, dismissible banner reads the drain report and tells the
person what was saved and the branch it is on, so a save nobody could find is now findable. It is read-only
over the rows, shows only `committed=true` saves, and does not reappear for a drain once dismissed.

### The Windows signing blocker is cleared

The Windows build ships deterministically unsigned now. There was never a work cert on it (the exe read
NotSigned and its metadata carries only my handle, no employer identifier), but a build machine with a `CSC_*`
env would have signed with whatever cert it pointed at. A no-op sign hook under `win.signtoolOptions.sign`
withholds any signature regardless of the machine's store or environment, and the packaged-bundle check now
reads the exe's PE certificate table and fails the build if a signature ever appears. It is CI-enforced on the
Windows package leg.

### The release status, precisely

v0.1.0 is feature-complete and one blocker from cuttable. The Windows signing blocker is cleared. The one
remaining blocker is the macOS real-spawn verification: the POSIX hook path, the transcript tail the rich feed
reads, and the drain-commit loop have all been proven structurally and in CI against real git, but never
against a real Claude binary on a Mac. That single verification is the next real work, and it needs the Mac.
The exact Mac-side steps are the runbook in `docs/HANDOFF.md`.

### What is next now

The Mac-side runbook in `docs/HANDOFF.md`, in order: the real-spawn verification, the darwin build, the real
unsigned launch and README reconciliation, then cutting v0.1.0. After the release, the deferred set: the three
small Geist re-skin follow-ups (the create and hire sheets shadow, the nav rail active-state gradient, the
header backdrop blur), then the larger features, task dispatch and a board, a project-centric view, Settings,
and the `ProjectPolicy.sandbox` shape decision, which comes due with task dispatch. None of the deferred set
blocks the release.

## Update, 2026-08-18, the redesign is complete

Read this block first. Everything under it is older. The redesign that the 2026-08-14 block listed as the
next work is done, so its next-pieces list is now history.

### The rich activity feed landed, across three pieces

The Activity tab is a real "what this colleague did and is doing" feed now, not a placeholder. It merges
three sources into one stream ordered by time: the persisted accomplishment rows (edits, commands, session
boundaries), the live-only reads and searches that show while the colleague is open and are gone on reopen,
and the state-change rows the tab already showed (waiting, crashed, needs_trust, rate_limited). One amber
accent stays on waiting; a failed or interrupted action reads as a quiet grayscale tag, never the accent.

The data source is Claude's own session transcript. Stafford tails the transcript JSONL Claude writes as it
works, so the rich rows cost zero added latency and need no new hook: the path arrives on the SessionStart
hook Stafford already receives (`transcript_path`), and the tool hooks stay unregistered, which is what kept
them off in the first place, since registering them cost about 760ms per tool call on Windows. The parser
turns each transcript `tool_use` and `tool_result` into a typed event and pairs them by id. Persistence is a
selective coalesced cut written to a new append-only table, `activity_events` (migration 0003): one row per
completed action carrying its outcome. The cut lives in one place, `shouldPersist`, so it is easy to change:
writes and commands and dispatch persist, reads and searches are live-only. The design and the split are in
`docs/plans/RICH-ACTIVITY-SPLIT.md`; this is the summary, not a second copy.

### The terminal-versus-structured question is closed

It was an open deferred item. Shipped code answers it, so no further investigation is owed. The resolution:
the structured feed is the front door and the raw terminal is the advanced fallback tab. The one caveat is
that the feed reads an undocumented, version-dependent file, so if the transcript format proves unstable that
reopens, but the parser degrades safely and the state feed stays authoritative, so a format change costs rich
rows, not the app. See the fragility note in `docs/HANDOFF.md`.

### The Geist re-skin landed, so the redesign is finished

The roster cards and the tab bar were brought to the register the feed set: the waiting card is flat now, its
one amber accent carried by a left edge and a dot and its state line, with the gradient and glow and lift
removed. The composer was already in the register. One small re-skin follow-up remains and is bounded: the
create and hire sheets still carry a drop-shadow elevation, the nav rail active state uses an amber-soft
gradient that spends the accent off attention, and the header keeps a backdrop blur. None of that is a
blocker; it is a later tidy pass.

Also merged since 2026-08-14: the smoke and verification harness can now run beside a live Stafford, because
`STAFFORD_APP_ID` overrides the runtime app id and gives an isolated run its own pipe and data dir together.

### What is next now

The redesign is complete, so the next work is the older deferred set below, chosen against the whole board:
the git executor and real commit-on-quit, task dispatch and a board, a project-centric view, Settings, the
`ProjectPolicy.sandbox` decision, and the release. The release is the shortest path to something a person can
trust and is the recommendation: it waits only on a real Claude spawn verified on macOS and the Windows
signing-cert check, both described under "The release" below.

## Update, 2026-08-14, machine switch to the MacBook

I am moving from the work PC to the MacBook, which has none of this session's chat context. This block is
the current state so the Mac-side work, and any fresh agent, picks up from reality rather than the stale
review below. Read this first; everything under it is older.

### Done since the last update, all merged

The whole people-centric surface is built now. The create flow: `project:create` and `hire:create` over the
existing repository inserts, with real "add a project" and "hire a colleague" forms, so a real colleague can
be brought into being from the UI (the piece that was between Stafford and real use). Pre-trust on spawn: the
project directory the user chose is marked trusted in Claude Code's own config before the spawn, so the
startup trust prompt the sanitised box cannot answer never fires. The hook state-reporting fix: the Electron
spawn now registers Stafford's own hooks in the project, using the bundled Electron as node through
PowerShell on Windows, so a colleague's state actually reaches the roster on a clean machine. The resume
stale-id fallback: a failed resume falls back to a fresh session, clears the stale id, resets the terminal,
and re-delivers the message that triggered it, so a stale colleague recovers and answers instead of sitting
stuck. The terminal fit-on-open fix, so a colleague's terminal is not garbled on first paint. The three-pane
shell: nav rail, roster in the centre, the selected colleague's detail on the right, with the detail tabs
inverted so Conversation leads and Terminal is the last, advanced tab. Window sizing: the app opens at a
fraction of the display's work area and remembers the user's size and position. Roster grouping by state:
the centre pane groups colleagues by what they are doing, waiting first.

Earlier in the same arc, also merged: the smoke seed no longer pollutes the real store, the public-repo
hygiene docs, and the enforced two-tier merge rule (own branches merge on green, external PRs need my
approval).

### The design direction is decided

It lives in `docs/plans/design-spec.md`: one screen, three panes, the detail pane's tabs in priority order
Conversation / Activity / Terminal, and the Vercel Geist visual register (near-black, hairline borders, one
amber accent spent only on waiting, quiet everything else). The three-pane shell and the roster grouping are
built to it. Read the spec before the next UI piece.

### Next pieces, in order

1. The Activity tab feed. Render the hook events Stafford already receives (SessionStart, a tool run, a stop,
   and so on) as clean rows in the detail pane's Activity tab, so a person sees what a colleague is doing
   without reading the terminal. This is the genuinely new piece, and it is the practical resolution of the
   terminal-versus-structured-output question: it uses the events I already have rather than parsing the
   terminal. Confirm the fields the forwarder captures first (`hooks/claude-hook.cjs` summarises event,
   sessionId, cwd, toolName, message, subagentType) so the rows are the honest subset the data can fill.
2. A finer per-component Geist re-skin. The shell and pane chrome are in the Geist register, but the cards,
   the create and hire sheets, and the Channel view inherited the new base palette without an individual
   pass. Tighten those to match, one component at a time.

Roster grouping by state, which the machine-switch prompt listed as the next piece, is done and merged; it
was the last place the shell diverged from the spec's structure.

### Still deferred

The git executor: checkpoints are still placeholders and the drain records committed as false, so a real
commit-on-quit is not there yet. Task dispatch and a kanban or tasks board. A project-centric view. Settings.
The `ProjectPolicy.sandbox` shape decision, still parked (the create flow ships a conservative default policy
without it). Apple Developer enrolment, which is only needed for silent in-place macOS updates; the update
model chosen is click-to-update, so this is not a release blocker. The deeper terminal-versus-structured
investigation is now optional, because the Activity feed uses existing hook events rather than needing it.

### The release

v0.1.0 is prepared but not cut. It waits on two things. One, a real Claude spawn verified on macOS: the POSIX
hook path was proven structurally and unit-tested, never with a real Claude binary on a Mac, so the
first-message-spawns-hooks-report loop needs one real run there before I trust it. Two, the Windows signing
cert issue in the known-issues note below: the packaged Windows build is auto-signed, and a public release
must not ship signed with a work-issued cert. The by-hand release checklist is in the release-piece-2 PR.

## Update, 2026-08-10, since the review below

The review below is a snapshot. Two of the four ready-now items are now built, so read this first.

Item 1, the live repository consumer, is done and merged (PR #8). `projects:list` is a read-only IPC
handler that returns ids and names only, no paths, registered in the channel allowlist and exercised by
the renderer proof window every run. The store is read on a real path now, not only in the smoke run.

Item 2, wiring the hook transport at Electron launch, is done: PR #9, green on all five CI legs, awaiting
Benzoo's merge. `index.ts` brings the socket up after the DB and before the tray, through
`src/main/hooks/transport.ts`, which orchestrates the existing `prepareSocketFor`, `HookListener`, and
`AgentSecrets` rather than reimplementing them. There are two launch gates. `assertLaunchable` covers
agent-readiness with a real spawn-and-kill prober, and `startHookTransport` covers the socket; each
refuses to a visible error and quits on failure. Teardown is awaited on the app-quit path. Nothing
consumes a hook event or maps agent state yet. That is the next step, kept separate on purpose so a
transport failure stays attributable to the transport rather than to a mapping bug.

`assertStartable` and `selfChecks` now run in the Electron shell too, which closes the item-10 gap that
paired them with the transport.

Items 3 and 4 are unchanged and still ready: the drain (Task 9) first, then the updater
click-and-notify path. The drain is the next build. Everything below is the original review, left intact
for its reasoning.

## Ready now, in build order

Argued from dependencies, not preference.

1. **A live repository consumer.** One IPC handler that lists projects or hires. Tiny, depends only on
   Task 8 which is done, blocks nothing. First because it is the cheapest, and it turns the store from
   proven-in-a-smoke-run into exercised-every-run, so a mapping regression or schema drift fails CI
   instead of waiting for the first feature to read the DB.
2. **Wire the hook transport at Electron launch.** `prepareSocketFor`, `assertStartable`, and the hook
   listener run in `src/main/cli/harness.ts` and nowhere in the Electron shell. Depends on storage
   (done: the socket now has a data directory beside it). Blocks the roster and everything
   people-centric, because without it the packaged app derives no agent state from hooks. Ready now and
   high value.
3. **Task 9, the drain.** The shutdown primitive. Writes the `drain_report` table piece 1 shaped, kills
   through the existing `killTree`. No Apple dependency. Buildable now; see item 1 below for why it does
   not wait on the SIGTERM grace.
4. **Task 9, the updater click-and-notify path.** Version floor, manifest, detached signature, the
   feed. Windows auto-applies, macOS notifies and assists. Buildable now with no signing; the plan says
   so outright (7.2.1: "buildable and testable now"). Ordered after the drain, because a blocking update
   drains before it quits, so the drain is its dependency.

Blocked, and on what: the sandbox shape (Benzoo), the channel repository (a product decision on
`ChannelMessage`), the macOS harness sections 3 and 4 (need the Mac), and the silent in-place macOS
update (Apple enrolment). None of these gates the four ready items.

## Settled this session, recorded so they are not reopened

- **Updater strategy.** macOS is click-to-update with no Apple signing: it checks the same feed, and on
  a newer version surfaces an "update available" prompt; on click it downloads and guides the user
  through replacing the app and the one-time Open Anyway. Windows auto-updates silently through
  electron-updater. Apple enrolment later is additive: the feed check exists either way, and the $99
  only removes the macOS drag-and-Open-Anyway step by enabling the silent in-place swap.

  **Plan consistency, flagged.** The migration plan section 7.2.1 already matches this: detached-signature
  verification "does not depend on Apple at all, so the update path is buildable and testable now". But
  `STACK-DECISION.md` overstates it in two places and should be reconciled when the updater is built:
  line 250, "signing is a prerequisite for the updater working at all", and line 268, "Signing is now
  mandatory, not a decision to defer". Under the settled split those read as false: the click-and-notify
  path works unsigned, and only the silent macOS swap needs signing. This is a doc reconciliation, not a
  code change, and it is not urgent, but it will mislead whoever builds Task 9 if left as is.
- **DB data directory keyed on `Stafford`, diverging from the appId.** In the tree and proven through a
  packaged run: `db open C:\Users\...\AppData\Local\Stafford\stafford.db`. Do not align it to the
  reverse-DNS appId; that orphans the DB.
- **`ProjectPolicy` ships without `sandbox`.** In the tree and enforced on read: `mapping.ts` rejects a
  policy that arrives carrying a sandbox field rather than storing it through.

## Per-item accounting

### 1. Task 9, the drain

- **What.** A blocking update quits while agents work, so quitting is a sequence (plan 7.4): close the
  gate, checkpoint every repo with a live agent via git on the agent's branch, let idle agents finish,
  wait with a 45-second-per-agent and 120-second-total grace, kill what remains through `killTree`,
  write a drain report, relaunch and show it.
- **Blocks.** The blocking update (item 2): a blocking update cannot land safely without it.
- **Depends on.** Storage (done: `drain_report` exists, shaped in piece 1 with the teardown-outcome
  column whose `force-killed` value is the `killWithTree` path) and `killTree` (done).
- **Ready.** Now, no Apple dependency. It does not need the SIGTERM grace (item 6) resolved first: the
  drain's own two timeouts are the grace, and step 5 hard-kills only what remains after them.
- **Intersections.** Item 5 (`killWithTree` is the force-kill), item 6 (the grace, refinement not
  blocker). The non-unref'd 886 timer surfaces here only as a short background cost per Windows
  teardown, already measured to not delay the teardown call, so the drain inherits it harmlessly.

### 2. Task 9, the updater feed and click-to-update

- **What.** electron-updater with GitHub Releases as the feed, a `minimumSupportedVersion` floor in
  `build/update-policy.json` published as a release asset, blocking decided by
  `semver.lt(app.getVersion(), floor)`, and every artifact carrying a detached Ed25519 signature
  verified against a key compiled into the app. Windows auto-applies; macOS notifies and assists.
- **Blocks.** Nothing downstream; it is a leaf feature.
- **Depends on.** A release feed, version comparison, the detached-signature verify (Node's built-in
  `crypto.verify` supports Ed25519, zero new dependency), and the drain (item 1) for the blocking path.
- **Ready.** The click-and-notify path is buildable now with no signing. What the later $99 adds is only
  the silent in-place macOS swap; it removes the drag-and-Open-Anyway step, it does not make the updater
  function. Windows silent auto-apply is buildable now.

### 3. Task 10 and Task 11

- **Task 10, the UI.** The roster of cards, the live terminal view, the channel, the kanban board. Not
  started. The plan sequences it after Task 8 and does not detail it in the migration plan.
- **Task 11, the pre-publication pass.** Substantially done, not moot, and honestly reported: the
  employer categories were removed from the tree, the deeper personal clean happened, the repository was
  seeded fresh from the cleaned tree and published this session, and the guards (fork-PR approval, the
  `main` ruleset, the full-history secret scan) are live. What remains is not a build: the private
  archive `Stafford-priv` must stay private permanently, which is a standing rule rather than a task,
  and the plan's own Task 11 section is now partly stale, including a dead pointer to
  `docs/exposure-inventory.md` which lives only on an unmerged branch. Reconciling that section is doc
  hygiene, owed but small.

### 4. A live repository consumer

- **What.** A single IPC handler listing projects or hires, so the store has a caller beyond the smoke
  flag.
- **Blocks.** Nothing. It is a de-risking, not a dependency.
- **Depends on.** Task 8 (done).
- **Ready.** Now, small. Owed because right now only the smoke path calls a repository, so a mapping
  regression or schema drift passes CI until the first feature reads the DB.

### 5. `ProjectPolicy.sandbox` and the multi-repo-versus-sandbox resolution

- **What.** The sandbox is the unattended dial (plan section 13 comment): on means restricted reach and
  no permission prompt, so unattended; off means full reach and a prompt, so it needs Benzoo present.
  The multi-repo conflict exists only with the sandbox on, because writes outside the starting directory
  are denied only then.
- **The three options the plan records**, for a sandboxed multi-repo project: sandbox off, one session
  per repository, or one repository per project. The verification log's own correction (2026-08-08)
  argues one-session-per-repository is arguably the *least* structurally disruptive, not the most,
  because `HiredAgent` already carries a `sessions` map keyed by project and the write lock is already
  per-repository, so it is a change of key rather than a change of shape.
- **Status.** Open. Benzoo's decision. Not decided here.

### 6. `killTreePlan` SIGTERM-then-SIGKILL grace

- **What.** The teardown sends `KILL` immediately. The proposal (verification log, "Owed: SIGTERM before
  SIGKILL") is `TERM` to each group, a short configurable grace, then `KILL` to what remains. The plan
  already takes a `KillSignal` on `group()` and `process()`, so it is an argument change and a loop, not
  a reshape.
- **Depends on / blocks.** The drain (item 1) does not need it first: the drain's own 45s/120s timeouts
  are the grace, and killing after them is correct. It is a refinement that makes a SIGKILL-mid-write
  less likely to leave a corrupt file, which is strictly better for a drain that exists to preserve
  work, but the drain functions without it.
- **Ready.** Now, and best landed with or just after the drain so the teardown fix and the signal change
  stay attributable.

### 7. The `useConptyDll` spike

- **What.** node-pty's DLL spawn path forks no console-list agent, so it avoids the 886 crash entirely.
- **Status.** A parked option, not a task. Measured lower value than it first looked: 886 was already
  per-teardown on 1.1.0 and wiring `killWithTree` did not worsen it, so the DLL path removes a cost that
  was already being paid, not a new one. The per-teardown cost it removes is real (a crashed helper and
  a five-second background timer per Windows teardown), but it is a behaviour change on a pin that
  already carries two open defects.
- **The condition that would justify it.** Schedule it if that per-teardown helper cost starts to matter
  on a machine cycling sessions all day, or as part of any move off node-pty 1.1.0. Otherwise leave it.

### 8. The channel repository and `ChannelMessage` shape

- **What.** No repository over `channel_messages`; the table and type exist, the repository is deferred.
- **Blocked on.** A product decision, not engineering: section 13 defines no `ChannelMessage` shape, so
  the type in `models.ts` is a minimal assumption marked as one, and a repository over it now would
  harden a guess. It unblocks when the channel feature settles the shape.

### 9. The tray-ahead-of-migration seam

- **What.** Piece 3 opens the DB before the tray, on the critical path. Noted in `index.ts`: if
  migrations ever grow heavy enough to be felt at launch, move the tray ahead of the open with a
  preparing state.
- **Status.** A noted future seam, not owed now. Migration 0001 is sub-millisecond, so the tray delay is
  imperceptible at the expected size.

### 10. The rest, found in the tree

- **The hook transport is not wired at the Electron launch.** Named in the ready-now set. `index.ts`
  opens the DB but never calls `prepareSocketFor`, `assertStartable`, or starts the hook listener; only
  `cli/harness.ts` does. So the packaged app derives no agent state. Ready now, storage unblocked it.
- **`selfChecks` and `assertStartable` run only in the CLI harness**, not the Electron shell. Same gap
  as the hook transport; they belong together when the shell gains a real startup.
- **Notification three-way classification.** The idle and permission-prompt strings are measured; the
  rate-limit string is still uncaptured. Waiting on a real rate-limit event to read the string, so it is
  blocked on an observation, not on code.
- **The subagent counter fix.** Reset on `UserPromptSubmit` or timestamp against the task window; pick
  one. A 6c follow-up, small, not blocking.
- **Write-path enforcement must deny all of `.claude/` to every agent.** Measured: a sandboxed agent
  that writes `.claude/settings.local.json` can influence its own next session. Owed with the writer's
  path enforcement, and the runner is the only principal that writes there.
- **macOS harness sections 3 and 4.** Socket ownership and the process-group kill against a real agent
  tree. Blocked on the Mac.

**Closed this session, recorded so they are not re-counted as owed:** `appDataDir` had no consumer and
now has one (`index.ts` and `database.ts`, piece 3); the schema, migration runner, domain types and
repository (Task 8); and the pre-publication clean and the fresh-repository seed (Task 11 core).

## Next action

Build the live repository consumer (item 4) first: it is an afternoon, it hardens Task 8 against silent
drift, and it needs nothing that is not already merged. Then wire the hook transport at the Electron
launch (item 10), because it is the thing standing between the shell and a product that reads agent
state.

## Recommendation

Take the ready-now set in the stated order and leave the blocked set for Benzoo, but reconcile the
`STACK-DECISION.md` signing language before Task 9 rather than during it. The plan currently tells a
Task 9 builder that the updater cannot function without Apple signing, which is false under the settled
click-and-notify decision, and a builder who believes it will either block on a $99 enrolment that is
not needed or build the wrong failure mode. It is a two-line doc fix that prevents a wrong turn on the
next real feature.
