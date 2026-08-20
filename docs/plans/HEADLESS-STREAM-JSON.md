# Headless stream-json migration

This scopes moving Stafford off driving Claude Code's interactive terminal and onto
running Claude Code headless through its stream-json control protocol. It is a plan.
No code changes land with this document. I approve it before any build.

## Why this exists

Every session-layer bug fought over the last dozen PRs is the same bug wearing a
different mask: Stafford drives Claude Code's interactive TUI by typing into a
pseudo-terminal, and a terminal meant for a human is a hostile surface for a program.
The swallowed first message, the "hitest" concatenation, the 400ms text-then-Enter
race, the accept-receipt timing, the input-ready marker, the hook socket and
forwarder and its shell pin, the node-pty #886 ConPTY teardown flake: none of those
are logic mistakes. They are the cost of pretending a program is a person at a
keyboard.

vibe-kanban (BloopAI/vibe-kanban, real Rust, pinned to `@anthropic-ai/claude-code`
2.1.119) does not do this. It runs Claude Code as a plain child process with piped
stdin and stdout and speaks the stream-json control protocol, the same protocol the
official Agent SDK uses. There is no terminal, so there is nothing to type into, no
readiness to wait for, no output to scrape, and no ConPTY to crash. Whole classes of
the bugs above become structurally impossible rather than carefully avoided.

This document scopes moving Stafford to that model.

## Decisions, blessed

These are decided, recorded here so a later reader does not reopen them.

1. Raw CLI plus stream-json, not the `@anthropic-ai/claude-agent-sdk`. Stafford
   speaks the protocol directly over a child process rather than taking the SDK as a
   dependency. The SDK would write less protocol code for us, but it version-couples
   Stafford to a moving Claude Code package and adds a new supply-chain surface, and
   it manages the spawn in ways that fight the control we need over CLAUDE_CONFIG_DIR,
   cwd, resume, and permissions. Raw CLI keeps zero new dependencies, keeps full
   control, and matches the minimal-deps and version-pinning discipline the rest of
   Stafford already follows.

2. One process per turn plus `--resume <session_id>`, not one long-lived process. The
   session id is harvested from the first turn's stream and passed back to resume on
   each following turn. This deletes the warm-session, idle-timeout, cold-start, and
   resume-fallback lifecycle entirely: between turns there is no process at all, only
   a stored session id. The docs suggest a single persistent process is also possible,
   but that path is unproven, and per-turn plus resume is what vibe-kanban actually
   ships and what removes the most machinery.

3. Permission handling is auto-approve through the control protocol, not a blanket
   bypass. When Claude asks to use a tool the CLI sends a `can_use_tool` request over
   the protocol, and Stafford answers `allow` programmatically. This is where the
   previously parked ProjectPolicy and sandbox decision will eventually live. See the
   permission section for the seam.

4. The raw Terminal tab is retired in favour of a rendered transcript built from the
   stream (the assistant's text and its tool calls). There is no TUI to show any more.
   No raw-stream debug view is kept; debugging happens through the delivery log
   instead, which is required to capture the raw wire. See the debug-view section.

## The command and the protocol

Recorded exactly as measured, so the implementation has a fixed target.

The invocation:

```
claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages --replay-user-messages
```

`-p` is headless (non-interactive). `--input-format stream-json` keeps stdin open and
streaming so the process behaves like a session rather than a one-shot. The process is
spawned with piped stdin, stdout, and stderr. There is no pseudo-terminal.

Sending the person's message, one JSON object on its own line on stdin:

```
{"type":"user","message":{"role":"user","content":"<the message text>"}}
```

Reading Claude's turn, one JSON object per line on stdout:

- `system` with `subtype: "init"`: the first event, carrying the `session_id` to store
  for resume, plus the model and loaded config.
- `assistant`: a complete assistant message, with text and any `tool_use` blocks.
- `stream_event`: raw token deltas (`content_block_delta` with `text_delta`) for live
  rendering.
- `result`: the turn is done. This is the explicit turn boundary that replaces every
  timing heuristic Stafford currently uses.

Control requests flow both ways on the same pipes. Stafford writes an `initialize`
control request first (carrying any hook registrations), then the user message. When
Claude wants a tool it sends a `can_use_tool` control request, which Stafford answers.
On cancel, Stafford writes an `interrupt` control request and keeps reading until the
`result` arrives.

State derives entirely from the stream. `init` means the turn started, `stream_event`
means it is working, `result` means it is idle and ready for the next message. There
is no hook socket, no forwarder, and no separate state machine fed by hook events.

## The structural change

### Before and after of the session layer

Before: `pty-session.ts` spawns Claude in a node-pty pseudo-terminal (ConPTY on
Windows). `session-lifecycle.ts` types the message text and an Enter into that
terminal, waits for a readiness marker, retries a swallowed submit, and confirms each
turn against a UserPromptSubmit accept receipt delivered over a Unix-socket hook
forwarder. State is a machine fed by six registered hooks. The terminal's raw output
is rendered in the Terminal tab.

After: a ClaudeRunner spawns Claude as a piped child process, writes one JSON user
message on stdin, and reads stream-json lines on stdout until `result`. There is no
typing, no readiness wait, no retry, no accept-receipt, and no hook socket. The turn
boundary is the `result` line. The assistant's text and tool calls, parsed from the
stream, feed the transcript and the conversation store.

### Deleted by this migration

The point of the migration is that it removes more than it adds. These go away:

- The pseudo-terminal: `pty-session.ts` and the node-pty dependency for the session
  path.
- The hook socket, the hook forwarder (`claude-hook.cjs`), the transport, and the
  shell-pin work from #65. State no longer comes from hooks.
- The input-ready marker detection (the `ESC[?2004h` gate).
- The submit-retry and the 400ms text-then-Enter split.
- The accept-receipt delivery queue from #67 and its guards.
- The warm-session lifecycle, the ten-minute idle timeout, the cold-spawn path, and
  the resume-fallback for a stale session id.
- The node-pty #886 ConPTY teardown flake and the test gate that contained it (#66),
  since there is no ConPTY.

### Kept, and how it maps

- #61 isolation. Stafford still passes `CLAUDE_CONFIG_DIR` to the child and still
  seeds the managed dir with the copied credential, the project trust, and plugin-free
  settings. The headless process reads that config exactly as the pty process did, so
  the plugin and foreign-hook isolation is unchanged. The macOS credential path
  through Keychain, rather than a copied file, is still an owed real-Mac check and
  still applies here: the runner inherits the same seeding, so the same verification
  covers it.
- #62 per-hire conversation store. The store already keys messages by hire and records
  the person's messages. The migration unlocks recording Claude's replies too, parsed
  from the `assistant` and `result` events, so the Conversation becomes a real
  two-sided thread rather than a list of "You:" lines. This is an improvement the
  migration makes possible, not extra scope, but note it as a natural follow-on.
- Checkpoint and drain (#54, #55). The git checkpoint runs plumbing against the
  project cwd and does not care how Claude is run, so it is unchanged. Killing a piped
  child process is a plain `child.kill()` plus reaping the process tree, far simpler
  than the ConPTY kill-tree, so the drain's kill path simplifies as a side effect.
- The create, hire, and project flow, the roster, and the database are unchanged.

## The permission layer

The control protocol's `can_use_tool` request is the clean, deliberate home for a real
per-action permission model, and this migration is where that lands. When Claude wants
to run a tool, the CLI does not prompt a terminal Stafford would have to answer by
faking keystrokes. It sends a structured request, and Stafford returns a structured
allow or deny. That is exactly the shape a real policy needs.

For v1 of the migration, Stafford auto-approves at `can_use_tool`, the same default
vibe-kanban ships, so behaviour is predictable and the migration does not also try to
design a policy engine. The requirement on the runner is that `can_use_tool` is a
named, isolated seam: a single function that today returns allow, and tomorrow can
consult a ProjectPolicy, an allowlist, or a person-facing approval prompt, without
touching the rest of the runner. The runner must pass the full tool name and input
into that function so a future policy has what it needs to decide.

This document does not design the sandbox or the policy. It fixes where they will live
(the `can_use_tool` seam) and requires the runner to keep that seam clean, so the
policy work later is a new module wired into one function rather than another rewrite.
The parked ProjectPolicy and sandbox decision is therefore not lost, it is given a home.

## Risks, stated plainly

Version-coupling. The stream-json control protocol is not guaranteed stable across
Claude Code versions. vibe-kanban pins to a specific version for this reason. The
protocol is far more stable for programmatic use than the TUI ever was, but it is a
maintenance surface Stafford takes on. The mitigation is the same posture Stafford
already took for tailing Claude's transcript: pin the Claude Code version, parse the
stream defensively so an unknown event type is ignored rather than fatal, and treat a
protocol change as known, scheduled maintenance rather than a surprise. State this to
whoever owns the upgrade cadence, because it is a real cost, not a hidden one.

The raw-stream debug view, decided: dropped. Retiring the raw Terminal removes the raw
session view that a power user, me especially, might reach for when something
misbehaves, and I am not keeping a reachable debug view for it. Debugging happens
through the delivery log instead. That only works if the log carries the wire, so it
becomes a requirement, not a nice-to-have: the delivery log must record the raw
stream-json lines exactly as they are received, not only the parsed events, so that
with no debug view the exchange with Claude is still fully inspectable from logs. This
requirement is folded into the phasing below.

## v0.1.0 sequencing, decided

Decided: Option A. Ship v0.1.0 on the current pty stack first, which is stabilized
after the recent fixes, then build the headless migration behind it for v0.2.0. The
pty stack is shippable now, a real v0.1.0 buys real user feedback and a milestone, and
the migration is lower risk built behind a shipped release than as the blocker to the
first one. Holding v0.1.0 for headless would have pushed the first release out and
front-loaded the migration's risk onto the launch, which is not worth it when the pty
stack already works.

A discipline comes with this decision, to avoid the fix-it-twice cost named above.
Once v0.1.0 ships, the pty session stack is maintenance-only. Only a release-critical
pty bug gets fixed on it. All new session-layer work goes to the headless runner, not
the pty stack. This keeps the effort flowing into the code being kept rather than the
code being deleted.

## Phasing

Each step is its own PR, each provable, in order.

1. This scope doc.
2. ClaudeRunner. Headless spawn, the stream-json parser, and one full turn end to end
   (send a message, read to `result`, capture the session id), proven against real
   Claude through the same probe harness that has been finding the delivery bugs. The
   runner records the raw stream-json lines as received into the delivery log, since no
   debug view is kept and the log is now the only window on the wire. No wiring into
   the app yet.
3. Wire the runner behind the existing `submitMessage`. Record Claude's replies into
   the #62 conversation store, keep #61 isolation by passing CLAUDE_CONFIG_DIR, and
   resume with the stored session id per turn. The raw stream-json is captured to the
   log in the app too, so a misbehaving session is inspectable without a debug view.
   The app now talks to Claude headless.
4. Rip out the pty, the hook socket and forwarder, the readiness marker, the retry,
   and the warm-session lifecycle, once the runner is proven in the app. This is the
   net deletion the migration exists for.
5. Move the Terminal tab to the rendered transcript. No raw-stream debug view is added;
   the raw wire lives in the log per the decision above.

## Ordering, unambiguous

Both open questions are now decided (Option A above, and the debug view dropped), so
the plan is fixed. The immediate next work is not the headless migration. It is
cutting v0.1.0 on the current pty stack, per the Mac runbook in `docs/HANDOFF.md`: the
owed real-spawn verification, plus the macOS checks folded into that one real spawn
(#61 isolation and the Keychain credential path, #63 cold-start first-message, #65
hooks firing in the managed dir, and #67 five-fast delivery), then the darwin build and
the v0.1.0 tag.

The headless migration starts only after v0.1.0 ships. Phase 2, the ClaudeRunner, does
not begin until the release is out. So the order is: cut v0.1.0 on pty first, then
begin the headless migration for v0.2.0, with the pty stack maintenance-only from the
moment v0.1.0 ships.
