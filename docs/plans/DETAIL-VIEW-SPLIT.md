# 3b, the agent detail view: scope and split

Click a card, open a live terminal over the pty and an input box that calls `lifecycle.sendMessage`, the
trigger the whole lifecycle was built behind. This is where the person actually talks to a colleague, so
it should feel like opening a conversation, not attaching a debugger.

3b introduces two new seams at once, a continuous output stream to the renderer and a write channel back
into a real process, plus terminal persistence. A terminal that streams but does not replay reads as
broken the instant a card is reopened, and the write channel is the first renderer-to-real-process path in
the app, so both are scoped here before any xterm wiring.

This is a scope pass. It builds nothing. It reports what exists, proposes the split, pins the three seams,
and surfaces the decisions that are Benzoo's.

## What exists to build on, from the tree

Most of the read half's hard part is already solved by the 7a pty work.

- `PtySession.subscribe(listener)` is the read primitive. It replays the session's buffered output as one
  chunk, then streams every later chunk, and returns an unsubscribe, all in one synchronous frame so no
  output is missed or doubled. It is per-session and reusable exactly as the detail view's initial paint:
  open a card, subscribe, see what came before, then live output. This is the 7a fix that removed the
  attach-then-blank hole.
- `OutputBuffer` is the scrollback, in memory, per session. It keeps whole chunks up to a cap
  (`DEFAULT_CAPACITY_BYTES`, 256KB), drops the oldest whole chunks past the cap, and prefixes the replay
  with a `RESET` sentinel when it had to drop, so a half-repaint never renders as garbage. It lives as long
  as the `PtySession`, so it is memory only and it is gone when the session ends or idle-shuts-down.
- `lifecycle.sendMessage(hireId, text)` is the write path. It cold-spawns or resumes if no session is up,
  then writes the text to the pty. So the write entry point already exists; the detail view's input box is
  a caller of it. What the lifecycle does not expose is a way to subscribe to a session's output or to
  resize it: it owns the `PtySession` privately, so the read half adds a `subscribe(hireId)` and a
  `resize(hireId, cols, rows)` that reach the owned session.
- The IPC is a frozen bridge with an explicit allowlist and argument guards. `projects:list` and
  `roster:snapshot` are pull, `roster:changed` is a push signal. The streaming shape the terminal needs
  already has a precedent in the retired proof window: `proof:data` was a push event carrying pty output
  and `proof:write` was a guarded invoke carrying input. The detail view reuses that shape, per session,
  and the proof channels are the template to copy rather than a pattern to invent.
- The renderer is the 3a roster: static `<article>` cards with no click affordance. The detail view needs
  a click handler on a card and somewhere to mount, which is the UX decision below.

## The three seams

### Seam A, the output stream

The primitive is `PtySession.subscribe`, surfaced through the lifecycle as `subscribe(hireId)`. Keyed by
hire id, which the lifecycle already holds equal to the agent id; the internal session id never crosses to
the renderer. Opening a card subscribes, closing unsubscribes, and the unsubscribe stops the stream, so
only the open card streams and the app never pays for a terminal nobody is watching.

The IPC shape follows the proof precedent. An open invoke (`session:open` with a hire id) tells main which
session to stream, main subscribes to that one session and pushes its chunks over a push event
(`session:data`), and a close invoke (`session:close`) unsubscribes. Main streams only the open session,
so it never serialises output the renderer is not showing. Because at most one card is open, the volume is
one session's output, not all of them.

Backpressure and the main thread. `webContents.send` does not block on the renderer, so a slow renderer
cannot stall the main process, which keeps the synchronous-main-thread rule intact. The cost that is real
is building and serialising large payloads, so main coalesces chunks within a frame rather than sending a
message per pty write, and the `OutputBuffer` cap bounds the initial replay to 256KB. Report the coalescing
as part of the read half, not an afterthought: a fullscreen TUI can emit many small writes, and one IPC
message per write is the flood to avoid.

### Seam B, terminal persistence and replay

This is the seam that reads as broken if skipped, and the 7a buffer already answers most of it for a
session's lifetime. Reopen a card during a live session and `subscribe` replays the `OutputBuffer`, so the
terminal is not blank. The cap is 256KB with the `RESET` sentinel, which is the bounded-read discipline
from storage meeting a high-volume source: whole chunks, oldest dropped, a sentinel when truncated, no
unbounded growth on the main thread. Report the cap as a number Benzoo can tune.

Where the plan and the current code differ, and it is worth stating. The plan says terminal output is
persisted to disk and replayed into xterm when the card is opened. The buffer today is memory only, so it
survives a reopen but not an idle-shutdown. The plan also says visible scrollback does not survive a
resume, and the context-lost note already tells the person when a session started clean. So the honest v1
is the in-memory buffer: a reopen during a live session replays it, an idle-shutdown loses it, and a resume
starts with a fresh empty terminal that the context-lost note already explains. Disk persistence, surviving
an idle-shutdown within a session's logical life, is a later refinement, not required for the terminal to
stop reading as broken. The detail view's buffer resets on resume, consistent with the note, rather than
carrying stale scrollback from a process that no longer exists.

One risk to carry, from the plan itself: with `"tui": "fullscreen"` the captured stream contains alternate
screen buffer sequences, and replaying a mid-alt-screen buffer into a fresh xterm may render wrong even
with the `RESET` sentinel. This is the one part of replay that has to be tested against a real fullscreen
TUI rather than assumed, and it is the plan's own open question (section on the alternate screen buffer).

### Seam C, the write channel, security-relevant

The input box writing to a live Claude process is the first renderer-to-real-process path, so it is not
just another allowlist entry.

It is a guarded invoke (`session:write` with a hire id and text), ids not paths, on the allowlist, through
the frozen bridge, the same shape as `proof:write`. It routes to `lifecycle.sendMessage(hireId, text)`,
which resolves the hire id to a session the lifecycle owns and writes to that session's pty; a hire id the
lifecycle does not own is a no-op, not a write to an arbitrary process. So the renderer can only write to a
session the lifecycle spawned, never to an arbitrary pid or a path, which is the property that matters.

Per-session scoping and spoofing. The write carries a hire id, and main writes only to that hire's owned
session, so a card cannot write into a different session by naming the wrong id: naming another hire writes
to that hire's own session, which is legitimate because this is a single-user local app and every colleague
is the person's. The anti-spoof property is not one person writing to another, it is that the renderer
cannot reach a process outside the lifecycle at all. Report it that way rather than pretending there is a
multi-tenant boundary here.

Raw versus sanitised stdin, a real decision. `sendMessage` today writes the text straight to the pty, so a
renderer could send control bytes (Ctrl-C, escape sequences) into Claude's stdin. For a message box, that
is not what the person is doing: they are sending a message, which is text plus a submit, and piece 1
already has `submit()` for exactly that, text then Enter, bracketed-paste-safe. So the decision is whether
the input box is a message box that sends text through `submit` and strips control bytes, or a raw terminal
passthrough that forwards every keystroke including control sequences. The plan's framing, a box to type
the next task, reads as a message box, so the safe default is sanitised-to-a-message with a raw passthrough
as a later, deliberate mode if Benzoo wants a real terminal. This is his security call, reported not taken.

## The split

Two pieces. Tags are main or renderer. Order argued from the plan.

1. The read half. Main and renderer. The output stream (`session:open` / `session:data` / `session:close`
   plus `session:resize`), the lifecycle's `subscribe(hireId)` and `resize(hireId, cols, rows)` over the
   owned session, and xterm rendering the stream: open a card, replay the capped buffer, then stream live,
   and propagate a browser resize to a pty resize. No input. Provable by opening a card and seeing live
   output plus a correct replay on reopen, and by resizing without the TUI wrapping wrong. Depends only on
   merged work: the lifecycle, `PtySession.subscribe`, and the 3a roster.
2. The write half. Main and renderer. The input box and the per-session-scoped `session:write` into
   `lifecycle.sendMessage`, with seam C's scoping and the raw-versus-sanitised decision. Depends on the
   read half, so the write channel lands on a terminal already proven to stream and replay.

First is the read half. Watch before type is the natural order, and it puts the write channel onto a
terminal that already streams and persists, so a write is visibly landing in a working terminal rather than
into a black box.

## Decisions that surface, Benzoo's not the agent's

- The scrollback cap. It is 256KB today. Larger holds more history at more memory per open terminal; this
  is a product-and-performance call, and 256KB is a starting point, not a settled number.
- Raw versus sanitised pty stdin. The recommendation is a message box that sends through `submit` and
  strips control bytes, with a raw passthrough as a later deliberate mode. It is a security call, so it is
  his.
- The detail view's shape: a separate window, a panel beside the roster, or an overlay. The plan describes
  a two-pane detail, a terminal on one side and an input on the other. A tray app with a window per card is
  clutter, so the recommendation is a detail view in the same window that the card opens into, with a way
  back to the roster, rather than a second window. This affects the whole tray-app shape, so it is his to
  confirm.
- Whether to build disk persistence of scrollback now or defer it. The recommendation is to defer: the
  in-memory buffer is honest for v1 because a resume is a fresh terminal anyway, and the plan's disk
  persistence buys surviving an idle-shutdown mid-life, which is a refinement, not the thing that stops the
  terminal reading as broken.

## Next action and recommendation

Next action: build the read half, the output stream plus in-memory replay and the xterm terminal, on its
own branch and PR, proven by opening a card to live output, a correct replay on reopen, and a browser
resize propagating to a pty resize.

Recommendation: test the read half against a real fullscreen TUI, not a plain echo, before calling it done,
because the alternate screen buffer replay is the one part the plan flags as unproven and the one most
likely to render wrong, and a terminal that replays a plain stream cleanly but garbles a real Claude
session is exactly the failure that only a real TUI would catch.
