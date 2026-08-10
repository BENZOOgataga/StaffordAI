# Owed-list review, 2026-08-10

A single accounting of everything parked, taken from the plan and the tree rather than memory, so the
next build is chosen against the whole board. Read-only: this decides nothing and builds nothing.

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
