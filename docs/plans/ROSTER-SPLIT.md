# Roster: scope and split

The roster is the build that makes Stafford visibly Stafford. A hook event from a real Claude Code
session becomes visible agent state, so the person sees a colleague working, idle, or waiting on them
rather than a terminal. Everything here is measured against the product axis: people-centric, not
task-centric. The card is a view on top of a colleague, not a row in a table wearing a costume, and the
board is explicitly deferred until the roster and the detail view work (plan line 584).

This is a scope pass. It builds nothing. It reports what already exists, proposes the split, and names
the one decision the roster surfaces that is Benzoo's to make.

## What already exists, from the tree

Most of the state machine is already written and already tested. The roster is largely wiring it into
the Electron main process and putting a view on it, not inventing it.

- The derivation is done. `src/main/hooks/session-state.ts` holds `stateFor` and `applyEvent`, pure
  functions with no transport, that turn a hook event into an `AgentState`, plus a `SessionSnapshot`
  per session. `REGISTERED_EVENTS` names the six Stafford registers: SessionStart, UserPromptSubmit,
  Notification, Stop, SubagentStop, SessionEnd. A test asserts this file imports no transport.
- The seam is `HookListener.emit('event', rest)` at `src/main/hooks/hook-listener.ts:181`. The listener
  accepts and acks a connection, strips the secret, and emits the event with sessionId, agentId, cwd,
  message. Nothing in the Electron main subscribes to it. The only consumer today is the CLI harness
  (`src/main/cli/harness.ts:701`), which is the reference wiring: `listener.on('event', ...)` feeding a
  snapshot. In `index.ts` the transport comes up and its listener is dropped on the floor.
- The target vocabulary is `AGENT_STATES` in `src/domain/agent-state.ts`: idle, working,
  waiting_for_you, rate_limited, crashed, needs_trust. `acceptsInput` returns true only for idle, so
  input is only ever written to a provably idle session.
- The persistence is `HiredAgent` in `src/domain/models.ts`: `state: AgentState` written straight on the
  hire, `sessions` as projectId to sessionId, and `activeProjectId`. A live session relates to a stored
  hire by matching its sessionId against a value in that map, so the registry needs a sessionId to hire
  reverse lookup.
- The drain seam is `activeDrainables()` in `src/main/index.ts`, which returns `[]` today. A
  `DrainableAgent` is `{ agentId, pid, checkpoint() }`. The drain force-kills through the pid and calls
  checkpoint for the commit. Nothing registers a live session, so the drain drains nothing. The roster
  is what populates this.
- The one existing read consumer is `projects:list`: a read-only IPC handler returning ids and names,
  registered in the channel allowlist, invoked by the renderer. The roster's reads follow that shape.

## The mapping, from the plan

From plan lines 377 to 388 and the code that already implements it:

- SessionStart gives the session id and sets idle. Main, persistence.
- UserPromptSubmit and PreToolUse mean working. Main.
- Notification means waiting for input, unless the message matches a rate-limit pattern, in which case
  rate limited. Main. This is the risk, see below.
- Stop and SessionEnd mean idle. Main, persistence.
- SubagentStop counts a finished apprentice (`subagentsCompleted`). Main, shown on the card. Renderer
  reads it.

## The split

Four pieces. Tags are main-process, renderer, persistence. Order argued from dependencies.

1. Event to state in the main process, with a live session registering into the drainable set.
   Main, persistence. No UI. Subscribe the transport listener's `event` to a session registry that keeps
   a `SessionSnapshot` per sessionId through the existing `applyEvent`, resolves sessionId to a hire,
   writes the derived state onto that hire, and registers each live session as a `DrainableAgent` so
   `activeDrainables()` returns it. Depends only on things already merged: transport, storage, the drain
   seam, and `session-state.ts`. Provable headlessly, the way transport and storage were: feed an event,
   assert the hire state changed and the session is now in the drainable set.

2. The three-way Notification classifier, as far as it goes deterministically, idle as the safe default.
   Main, pure. Edits `session-state.ts` to split Notification into permission-prompt (measured string) to
   waiting_for_you, rate-limit (heuristic) to rate_limited, and everything else to idle. The rate-limit
   string was never captured deterministically and stays a heuristic; it does not block this piece
   because the default absorbs it. Depends on nothing structurally, but only matters once piece 1
   consumes states, and it must land before piece 3 shows any of them.

3. The roster view. Renderer, plus one read IPC in main. A grid of cards, one per hire: name and role,
   state, the current task in one line, project tag, elapsed, queued count, apprentice count when
   non-zero, a live one-line tail of terminal output, and a badge plus a sound only when the state is
   waiting_for_you. A card maps to a hire over a read-only IPC in the `projects:list` shape. Depends on
   pieces 1 and 2, because the badge must never be false.

4. The per-agent detail and live terminal. Renderer, plus main. Click a card: an xterm.js terminal on
   one side, an input box on the other, output persisted to disk and replayed on open, browser resize
   propagating a pty resize, input written only to an idle session. This is a later step, not roster
   scope. It also sits on a real session-spawn lifecycle that does not exist in main yet (cold spawn on
   first message, resume on the stored session id, ten-minute idle shutdown, plan lines 400 to 415),
   which is itself a piece and a dependency of a live terminal.

First is piece 1. It closes the `activeDrainables()` seam PR #11 left, it is the smallest provable
increment of the real thing, and it needs no design decision. A live session force-killed by the drain on
quit is the drain becoming real, which is exactly the increment to build first.

Ordering note: piece 1 can ship on the current mapping because no UI reads the state yet, but piece 2
must land before piece 3, so the view never shows the false-waiting the current default produces.

## The classifier risk

The Notification branch is the piece most likely to be wrong, and it is wrong right now.

`stateFor` maps a Notification to rate_limited when the message looks rate-limited and to
waiting_for_you otherwise. That default is backwards against the axis. Notification is two variants under
one name (plan lines 533 to 543): the permission prompt, which is what "the agent needs him" means, and
an idle notification that says the turn ended. Mapping every non-rate Notification to waiting_for_you
lights a false waiting badge on an idle agent, and a false waiting badge trains the person to ignore the
badge, which is the one thing the badge cannot afford.

Piece 2 flips this: prompt string to waiting, rate-limit heuristic to rate_limited, everything else to
idle. Idle is the conservative default. When the classifier cannot tell, it must say idle, never waiting.

The sandbox makes this sharper. With the Bash sandbox on, the permission-prompt Notification never
arrives at all, because the sandbox is the containment instead of the prompt (plan lines 536 to 538,
801 to 803). Only the idle variant arrives. So a waiting state driven purely off a Notification can never
fire for a sandboxed agent, and the current code would still stamp waiting on that idle Notification. The
plan is explicit that genuine waiting for a sandboxed agent "needs a second source rather than resting on
the hook alone" (plan line 543). The first roster does not have that second source, so a sandboxed agent
simply never shows hook-driven waiting and goes idle after its Stop. That is safe and correct for a first
version. Positively showing waiting for sandboxed agents is a later feature.

The rate-limit case can ship as a known gap. `looksRateLimited` already matches on a narrow set of
patterns, and anything it misses falls through to the safe idle default rather than to a wrong state, so
the uncaptured rate-limit string does not block the classifier or the roster.

## The decision the roster surfaces, Benzoo's to make

Whether to add `ProjectPolicy.sandbox` now. The constraint forbids adding it, and the roster does not
force it for pieces 1 to 3. Here is exactly how far the roster gets without it, so the call is clear.

- The classifier ships without the field by defaulting to idle. When the sandbox is off, the
  permission-prompt Notification actually fires and drives waiting correctly. When the sandbox is on, no
  prompt fires and the agent shows idle after its turn, which is not a false badge.
- What the roster cannot do without the field is know per project whether a prompt can ever arrive, and
  therefore cannot positively show waiting for a sandboxed agent through a second source. Today the
  sandbox is inherited from the machine's global settings, outside the product (plan lines 545 to 547),
  so per-project behaviour is not knowable to the product at all.

So the roster proceeds without the sandbox field, degrading to idle. The field becomes required at the
point Benzoo wants either per-project sandbox control or a positive waiting state for sandboxed agents.
That is his call and it gates only the sandboxed-waiting feature, not the first three roster pieces. The
roster is not the point at which the decision can no longer be deferred, provided the first version
accepts that sandboxed agents do not show hook-driven waiting.

## Next action and recommendation

Next action: build piece 1, event to state in the main process with a live session registering into the
drainable set, on its own branch and PR, proven headlessly by an event changing a hire's state and the
session appearing in the drainable set.

Recommendation: build piece 2, the classifier, immediately after piece 1 and before any view, and flip
the Notification default to idle as part of it. The current waiting default is a latent false-badge bug,
and it is far cheaper to correct it while no UI reads the state than to ship a roster that cries wolf on
its first idle agent.
