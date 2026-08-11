# Session-spawn lifecycle: scope and split

3b, the agent detail view with a live terminal and an input box, needs a lifecycle that does not exist
in the Electron main: cold spawn on the first message, resume, and idle shutdown. The terminal is thin
xterm wiring once the lifecycle exists. The lifecycle is the real dependency, because it is where a real
spawned process, the drain teardown, and an idle timer all meet, and those seams have to be right before
anything hangs off them.

Measured against the axis: a colleague starts working when the person gives them something, stays
available between tasks, and is torn down cleanly. When a colleague starts and stops is a product
question, and the plan answers it, so this reports the answer rather than inventing one.

This is a scope pass. It builds nothing. It reports what exists, proposes the split, names the three
seams, and surfaces the decisions that are Benzoo's.

## What exists to build on, from the tree

The whole spawn mechanism already exists, in the CLI harness, for measurement. The lifecycle is largely
lifting that into the shell and giving it a trigger, an owner, and a teardown, not inventing a spawn.

- `PtySession` (`pty-session.ts`) is the process primitive. `start()` spawns through an injected
  `spawn` and streams output; `kill()` kills the node-pty session; `killWithTree`... there is no such
  symbol, the tree teardown is `killTree` (`kill-tree.ts:98`), which `PtySession.killTreePlan` feeds.
  `kill()` takes down the shell; the drain uses `killTree` to reap the whole process group. The harness
  builds a `PtySession` with `file` the located Claude binary, `cwd` the project dir, and the agent env.
- The cold-spawn reference is `spawnSession` in `harness.ts`. It calls `buildAgentEnv` (`agent-env.ts`),
  which sets `PATH`, `STAFFORD_AGENT_ID`, and an allowlisted parent env, then adds `STAFFORD_SOCKET` (the
  socket path, an absolute path through `extra`) and `STAFFORD_AGENT_SECRET` (the per-agent secret, set
  directly because it is not a path). The forwarder registered in the project's
  `.claude/settings.local.json` (`registration.ts`) reads those three from the session's environment,
  connects to `STAFFORD_SOCKET`, and posts each event with the secret and the agent id. That is the hook
  rendezvous, and it already works end to end in the harness.
- `SessionRegistry` (roster piece 1) registers a session when a hook event arrives, drives its
  `AgentState`, and exposes it in `activeDrainables()`. The gap this scope exists to close: nothing in the
  shell spawns the process those events come from. Today a session is registered by an event arriving, not
  by a spawn. `setPid` exists on the registry and is unused, waiting for a lifecycle to own a process and
  set its pid.
- A registered session's pid today is null in the shell and a stub in the drain tests. Nothing owns a
  real process, so `activeDrainables()` carries null pids and the drain's force-kill is a no-op the tests
  exercise with a stubbed kill. The lifecycle is what makes the pid real.
- `HiredAgent.sessions` (projectId to sessionId) and `activeProjectId` are the persistence a resume reads.
  A resumable session is a hire with a sessionId stored for a project. The catch, below: that entry is
  written only once a session id exists, and a fresh cold spawn has none until its first `SessionStart`.

## What the lifecycle must deliver, from the plan

From `STAFFORD-PLAN.md` section on lifecycle (lines 398 to 416), tagged.

- Cold spawn, main. On the first message to a colleague, spawn a Claude Code session in the project's
  repo. The plan is explicit: "A card spawns its process on first message" and "On boot the runner spawns
  zero agent processes. Everything stays cold until Benzoo opens the UI or sends a task." First message
  means the first task the person sends, not hire time. What is spawned is the located Claude binary, cwd
  the project repo, env from `buildAgentEnv` plus `STAFFORD_SOCKET`, `STAFFORD_AGENT_SECRET`, and
  `STAFFORD_AGENT_ID`, the same shape `spawnSession` already builds.
- Resume, main and persistence. The plan pins the semantics: "reattaches with `claude --resume` on the
  stored session id." Resume is a fresh process spawned with `--resume <sessionId>`, not a reconnect to a
  still-running one, because the process was shut down after idle. Claude restores the context; "Session
  context survives a resume, visible scrollback does not." So resume reads `hire.sessions[projectId]` and
  spawns fresh with that id.
- Idle shutdown, main. "shuts it down after ten minutes idle" and "Ten minutes is his choice; keep it in
  config." Idle is measured from the last activity the session reports, which is the last hook event the
  registry already stamps as `lastEventAt`. The timer is armed on each event and disarmed on shutdown. It
  must be unref'd. A non-unref'd node-pty Windows kill timer already delayed quit on this project, and a
  non-unref'd idle timer on every live session would hold the event loop open at quit exactly the same
  way. So the idle timer is unref'd, stated here as a hard requirement, not a detail.
- The secret and the socket rendezvous, main. Each session gets its own secret from `AgentSecrets.issue`,
  handed to the spawned process as `STAFFORD_AGENT_SECRET`. The forwarder presents it over the hook
  connection, and the listener validates it against the agent id. A spawn that cannot authenticate its
  hook is a session that never reports state, so the handoff is part of the spawn, not a later step.

## The three seams

### Spawn-to-drain: the drain goes real

Once the lifecycle owns a `PtySession` and calls `registry.setPid`, `activeDrainables()` carries real
pids, so at quit the drain force-kills real Claude sessions rather than stubs. What changes for the drain
is only the pid: its `killTree` and its 45s and 120s caps are unchanged and already validated against a
real Claude process tree. The harness measured a real session where Claude's shell leads its own process
group and the tool child leads another, and `killTree` killed both groups with zero survivors
(`stack-migration-verification.md`). So the kill path is proven against reality already; the lifecycle
just makes `activeDrainables()` hold those pids at quit. The drain's checkpoint stays the placeholder
until the git checkpoint executor lands, so a real session drains as force-killed or checkpointed-without-
commit, which is honest, not a regression.

### Idle shutdown versus drain

Both tear a session down, so they must not double-kill or leave a half-torn session. Two rules resolve it.
First, both go through one idempotent teardown that kills through `killTree`, deregisters from the
registry, and revokes the secret, safe to call twice because a second call finds the session already gone
and returns. Second, the drain disarms every idle timer at the start of quit, so an idle shutdown cannot
fire mid-drain; the drain then owns teardown for the whole shutdown. An idle shutdown that was already in
flight when quit began completes through the same idempotent path, and the drain's later call on the same
session is a no-op. The idle timer being unref'd is what makes this safe: even a timer that has not been
explicitly disarmed cannot hold the process open past the forced quit.

### Spawn-hook rendezvous

The process is spawned and the hook connects back asynchronously, so the ordering is not guaranteed and
each failure mode has to be handled or the session is invisible to the roster and undrainable.

The binding problem underneath all three: the registry resolves a session to a hire through
`hire.sessions`, keyed by session id, but a fresh cold spawn has no session id until its first
`SessionStart`. So the first event cannot bind by session id. It binds by agent id instead, which the
spawn put in the environment as `STAFFORD_AGENT_ID` and the forwarder includes in every event. The
lifecycle, which knows the hire and the agent id at spawn, records the session id onto
`hire.sessions[projectId]` when the first event arrives, so every later event and every resume binds by
session id as normal. Closing this agent-id-to-hire path for the first event is the core rendezvous work.

- A spawn whose hook never connects. The pid is up but no `SessionStart` arrives. This is where the
  earlier Windows AttachConsole-at-open hypothesis lives. Detect it with a bounded wait after spawn; on
  timeout, put the session in a visible error state rather than leaving it blank, and keep its pid
  drainable so it is still killed at quit.
- A hook that connects before the registry knows about the spawn. The forwarder can post `SessionStart`
  before the lifecycle finished registering. Handle it by pre-registering the pending spawn under its
  agent id and pid before the process is spawned, so an early event binds to a hire that is already known.
- A spawn that dies before attaching. The `PtySession` exit fires before any hook. `trust.ts` already
  classifies this: an exit with no `SessionStart` in a directory Claude did not trust is `needs_trust`,
  otherwise `crashed`. Surface that state and deregister, so a dead spawn is a named state on the card,
  not an invisible one.

## The split

Three pieces. Tags are main-process or persistence. Order argued from dependencies.

1. Cold spawn plus the hook rendezvous, headless. Main and persistence. First message spawns a real
   Claude session in the project repo with the env and secret handoff, pre-registers the pending spawn by
   agent id and pid, binds the first event to the hire and writes the session id onto `hire.sessions`,
   and registers the live session with a real pid into the drainable set. No UI. Provable headlessly the
   way the transport and drain were: send a message, assert a real process spawned, a real pid in
   `activeDrainables()`, and state driven by the hook it attached. Depends only on merged work: the
   transport, the registry, `spawnSession`'s pieces, and the drain seam.
2. Idle shutdown, with a correctly unref'd timer and the drain coexistence above. Main. A 10-minute
   config idle timer per session, armed on activity, disarmed on teardown, unref'd, tearing down through
   the one idempotent path the drain shares. Depends on piece 1, since there is nothing to idle-shut-down
   until a real session exists.
3. Resume. Main and persistence. A message to a hire with a stored session id spawns fresh with
   `claude --resume <sessionId>`, context restored by Claude, scrollback lost. Depends on piece 1 for the
   spawn path and on the session id piece 1 writes onto the hire.

First is piece 1. It gives `activeDrainables()` a real pid, which turns the drain real, and it is the
smallest provable increment of a live session. It also closes the agent-id-to-hire rendezvous the other
pieces rest on.

## Decisions that surface, Benzoo's not the agent's

- Cold spawn is on the first message, not at hire time. The plan says so outright ("spawns its process on
  first message", "stays cold until Benzoo opens the UI or sends a task"). Not ambiguous, confirmed.
- Resume is fresh-with-`--resume`, not a reconnect to a running process. The plan pins it ("reattaches
  with `claude --resume` on the stored session id", "visible scrollback does not survive"). Not ambiguous,
  confirmed.
- The idle timeout is 10 minutes and "kept in config." That is a runtime config value, global, not a
  `ProjectPolicy` field, so it does not intersect the open sandbox-field decision. If per-project idle is
  ever wanted, that would touch `ProjectPolicy` and is Benzoo's call then; it is not needed now and no
  field is added.
- One small product call: what a cold spawn whose hook never attaches shows on the card. The mechanism is
  a bounded wait then a visible error state, but which state (a generic error, or reusing `needs_trust`
  and `crashed`) is a naming choice worth Benzoo confirming when piece 1 is built, because it is what the
  person sees when a spawn silently fails.

## Next action and recommendation

Next action: build piece 1, cold spawn plus the hook rendezvous, headless, on its own branch and PR,
proven by a message spawning a real session that registers a real pid into the drainable set and drives
state from the hook it attached.

Recommendation: build piece 1 with the drain running for real in the same proof, spawn a session, then
quit and read its `drain_report` row, because the whole point of piece 1 is that the drain stops being a
stub, and proving the spawn without proving the drain reaping it would leave the seam that matters
untested.
