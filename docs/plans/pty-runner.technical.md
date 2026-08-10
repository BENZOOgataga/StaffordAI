# Technical plan: the pty runner

Step 3 of the build order in `docs/plans/STAFFORD-PLAN.md`. Written by the lead
developer for Benzoo to approve before any code is written.

Scope of this document is step 3 and nothing else. Where a nearby concern belongs to a
later step, it is named and explicitly left out.

---

## 1. What step 3 has to prove

Five things, all end to end, on Benzoo's machine:

1. A hire's `claude.exe` runs inside a pseudo-terminal built by the runner, with an
   environment the runner constructed rather than inherited.
2. Its terminal output reaches a browser and renders as a real TUI, colors and cursor
   included.
3. Text typed in the browser reaches that session's prompt and produces a reply.
4. Resizing the browser resizes the pty, and the TUI reflows instead of wrapping wrong.
5. The `SessionStart` hook event that Claude Code fires can be attributed to the exact
   hire that was spawned, with no guessing.

Anything that does not serve one of those five is out of scope.

### Out of scope, deliberately

- Idle shutdown, `--resume` reattach, disk persistence of the output buffer, the per-repo
  write lock, the queue. All of that is step 6.
- The hire registry, projects and policies. Step 4.
- Any real UI. Step 5. This step ships one crude page whose only job is to prove input
  and output both work.
- Delegation, usage reading, the pipeline, the channel, the board.

---

## 2. Approach

### 2.1 Module layout

New files, all under `runner/`. Existing files are extended, never rewritten.

| File                     | Owns                                                                          |
| ------------------------ | ----------------------------------------------------------------------------- |
| `agent-env.js`           | Builds a spawn environment from an allowlist. Locates Git Bash. No passthrough. |
| `claude-locator.js`      | Finds `claude.exe`. Config override, then `%USERPROFILE%\.local\bin`, then PATH. |
| `pty-session.js`         | One pty process. Spawn, write, resize, kill, exit. In-memory output ring buffer. |
| `session-registry.js`    | Agent id to pty, agent id to Claude session id. Readiness gate for input.        |
| `terminal-server.js`     | Websocket server. Auth, origin check, attach, stream, input, resize.            |
| `trust.js`               | Reads Claude Code's trusted-project state. Reports, never auto-answers.        |
| `public/terminal.html`   | The crude proof page. xterm.js, one input box, nothing else.                    |
| `server.js`              | Extended: wires the above to the existing hook endpoint.                        |
| `hook-endpoint.js`       | Extended: records `agentId` when the forwarder supplies one, emits it.          |
| `hooks/claude-hook.js`   | Extended: forwards `STAFFORD_AGENT_ID` from its own environment. One field.     |

Each module is independently testable and none of them knows about the others' internals.
`pty-session.js` does not know what a hire is. `session-registry.js` does not know what a
websocket is.

### 2.2 Tying the session id to the hire

This is the part that has no obvious answer and it drives several other decisions.

When Claude Code fires `SessionStart`, the payload carries a session id and a working
directory. Neither identifies which hire it belongs to. Two hires in the same project
share a working directory, and Benzoo may have his own Claude Code open in the same repo
at the same time. Matching on `cwd` would attribute state to the wrong card, which is the
exact failure the whole hook design exists to avoid.

The mechanism: the runner puts `STAFFORD_AGENT_ID=<agent id>` into the environment it
builds for the spawned process. Hook commands run as children of that process, so
`hooks/claude-hook.js` can read the variable and forward it alongside the session id. The
endpoint then binds agent id to session id on first sight and ignores later attempts to
rebind.

The bind is scoped to one spawn, not to the hire. Within a spawn it is first-write-wins
and a rebind is refused. When the pty exits, for any reason, the bind is cleared. A
process that died and respawned gets a fresh session id, and a permanent bind would leave
the card pointing at a session that no longer exists. Clearing on exit costs nothing now
and removes a bug that would otherwise surface in step 6 when reattach arrives.

Cost of this: one new field in the forwarder, one new field in the endpoint. Nothing else
changes.

Verified on 2026-08-06. A hook command does inherit the environment of the Claude Code
process the runner spawned, confirmed on two runs with two different ids, with a control
proving the probe itself worked. Real output in `docs/pty-runner-verification.md`. The
correlation-window fallback is dropped and should not come back.

One detail from that run: anything the runner passes to a hook through the environment
must be an absolute path. A hook runs with Claude Code's working directory, not the
runner's, so a relative path resolves somewhere unintended.

Sessions with no agent id keep working exactly as they do today. Benzoo's own terminal
sessions still show up on the endpoint, unowned.

### 2.3 Building the environment

`process.env` is never passed through. The environment is assembled from three parts.

An allowlist copied from the parent, because a Windows process without them misbehaves in
ways that are hard to diagnose:

```
SystemRoot  windir  COMSPEC  PATHEXT  OS
USERPROFILE  HOMEDRIVE  HOMEPATH  USERNAME  USERDOMAIN
APPDATA  LOCALAPPDATA  PROGRAMDATA  ProgramFiles  ProgramFiles(x86)
TEMP  TMP  NUMBER_OF_PROCESSORS  PROCESSOR_ARCHITECTURE
```

A PATH built from an explicit list rather than copied:

```
%SystemRoot%\system32
%SystemRoot%
%SystemRoot%\System32\Wbem
%SystemRoot%\System32\WindowsPowerShell\v1.0
<directory containing the node.exe running the runner>
<Git for Windows>\cmd
<Git for Windows>\bin
<Git for Windows>\usr\bin
%USERPROFILE%\.local\bin
```

Git Bash is located, not assumed: `HKLM:\SOFTWARE\GitForWindows\InstallPath` first, then
the directory two levels above whatever `git.exe` PATH resolves to, then a config
override. If none of them find it, the runner logs a warning naming claude-hud and the
plugin hook as the things that will fail, and spawns anyway. It does not hard fail over a
status line.

Injected by the runner:

```
STAFFORD_AGENT_ID   the hire's stable id
AGENT_DASHBOARD_PORT  so the forwarder reaches the right runner
```

Deliberately not injected: `AGENT_DASHBOARD_TOKEN`. An agent with Bash can read its own
environment. Putting the shared token there would let a session forge hook events for any
other session. The forwarder already reads the token from `~/.agent-dashboard/token`,
which Claude Code's own file tools can also reach, so this is not a complete boundary, but
it is strictly better than handing it over. Full separation means per-agent tokens, which
belongs with the registry in step 4.

Nothing else is inherited. No `npm_*`, no `CLAUDE_*` from the parent, nothing from
Benzoo's shell profile.

### 2.4 The trust prompt

Claude Code shows a trust prompt for any directory it has not seen before, and input
written while that prompt is up becomes the answer to the prompt. Two rules follow, and
neither of them involves reading terminal output.

**Rule one: no input before the session is provably started.** The runner refuses to write
anything to a pty until the hook endpoint has reported `SessionStart` for that agent id.
Text typed in the browser before that point is rejected with a visible message, not
buffered and flushed later.

Verified on 2026-08-06: `SessionStart` does not fire while the trust prompt is up. It fired
about 1.7 seconds after the prompt was accepted, and not at all during 30 seconds of the
prompt sitting unanswered. So this rule alone closes the trust hole. `trust.js` stays for
telling Benzoo why a card is stuck, but it is no longer the control that protects him.

**Rule two: trust is Benzoo's decision, never the runner's.** Before spawning, `trust.js`
reads Claude Code's own record of trusted project directories and reports one of three
answers: trusted, not trusted, unknown. On anything but trusted, the card shows a
first-run state and Benzoo clears the prompt himself in the terminal view. The runner
never sends a keystroke that accepts trust on his behalf, and never edits Claude Code's
config to mark a directory trusted.

That is a deliberate friction. Auto-accepting trust means the runner silently grants a
future agent full access to any directory it is pointed at, including one chosen by
something that read a poisoned file. Once per project by hand is cheap.

**So hiring onto an unseen project cannot happen unattended, and that is a product
consequence rather than an implementation detail.** Measured 2026-08-08 by the 6c harness,
which creates a scratch project and therefore hits this on every fresh path: the session
starts, the trust prompt appears, no hook of any kind fires, and nothing proceeds until a
human answers. The card sits in needs-trust for as long as that takes, which may be
overnight.

Three things follow for whoever builds the hire flow:

- A hire scheduled against a project Claude Code has not seen before will not start on a
  schedule. It starts when Benzoo answers, and the queue has to tolerate that rather than
  time the task out and report a failure.
- The first-run state needs to be visibly different from a stuck one. Both look like a card
  that is not progressing, and `classifyExit` already separates them, so the interface has
  to carry that distinction rather than flatten it to "not responding".
- Once granted, trust survives the directory being deleted and recreated at the same path,
  because Claude Code keys the record on the path. That is what makes the harness runnable
  repeatedly after one manual accept, and it is worth knowing before someone assumes a
  fresh checkout needs a fresh accept.

That last property cuts both ways, so it is stated rather than left as a convenience. **A
stale trust record outlives the project it was granted for.** A directory that is deleted,
or reused for something else entirely, keeps its grant, and the next session opened there
starts trusted without anyone having decided that. Benzoo cleaned records up by hand earlier
in this project, which is the manual form of the same problem. Stafford never writes these
records, so this is not a gap in it, but a reading of trusted is evidence about a path and
not about the project currently sitting at that path.

None of that is a gap. Auto-accepting was considered and rejected above, so this is the
accepted cost of that decision, written down here so it is read rather than rediscovered.

### 2.5 The wire

Websocket, per the design. Two frame types.

- Binary frames server to client are raw pty bytes, straight into xterm.js. Terminal
  output is not text, it is a byte stream with control sequences, and forcing it through
  a text channel means escaping or base64 on every chunk.
- Text frames are JSON control messages both ways.

Client to server:

```
{ "type": "auth",   "token": "..." }
{ "type": "attach", "agentId": "..." }
{ "type": "input",  "data": "..." }
{ "type": "resize", "cols": 120, "rows": 34 }
```

Server to client:

```
{ "type": "ready",  "agentId": "...", "sessionId": "..." }
{ "type": "state",  "agentId": "...", "state": "working" }
{ "type": "exit",   "agentId": "...", "code": 0 }
{ "type": "error",  "message": "..." }
```

Three security controls on the socket, all required:

- The `Origin` header is checked at the upgrade and anything unexpected is refused.
  Websockets are not subject to the same-origin policy, so without this any web page
  Benzoo visits can open a socket to `127.0.0.1:4271` and drive his agents. This is the
  most serious exposure the runner has gained since it was written and it is worth naming
  plainly.
- The `Host` header is checked on every HTTP request and on the upgrade, and anything
  other than `127.0.0.1:<port>` or `localhost:<port>` is refused. Origin alone does not
  stop DNS rebinding, where an attacker-controlled name resolves to 127.0.0.1 and the
  browser then treats the runner as same-origin. Host validation does.
- The first frame must be `auth` with the shared token, within two seconds, or the socket
  closes. The token goes in a frame rather than the URL so it does not land in access logs
  or browser history.

Bind stays `127.0.0.1`. The websocket server attaches to the existing HTTP server on 4271
rather than opening a second port, so there is one listener and one bind rule to get right.

### 2.5.1 How the proof page gets the token

The page has to send the token in the auth frame, so the token has to reach the page. It
must not reach it in a way that a fetch of the page's URL also gets, because the Stafford
project policy allows web fetch, which means an agent working in this repo can fetch its
own runner.

So: no endpoint serves the token, ever. `runner/server.js` prints a launch URL on startup
with the token in the URL fragment:

```
http://127.0.0.1:4271/terminal#<token>
```

A fragment is never sent to the server, so `GET /terminal` returns a page containing no
token no matter who asks for it. The page reads `location.hash`, copies it to
`sessionStorage`, and clears the hash immediately so it does not sit in the address bar or
in browser history. If the hash and the stored value are both absent, the page shows a box
to paste the token into rather than failing silently.

This does not fix the underlying problem, which is that one shared token guards every
agent and any agent with a shell can read the token file. Per-agent tokens arrive with the
registry in step 4. What this does is stop the runner from handing the token out over
HTTP to anything that asks.

### 2.5.2 Concurrent attach

Decided rather than left to the code: many viewers, all of them able to type.

Every socket attached to an agent receives the same output stream, and input from any of
them goes to the pty. Two tabs open on one hire will interleave keystrokes into the TUI
if both are typed into at once, and that is accepted. Benzoo is the only user, and a
second tab is far more likely to be one he forgot about than a second person racing him.

The alternatives were considered and are worse for this step: a single writer with a
takeover handshake adds a lock, a UI for stealing it, and a stale-owner problem, all to
protect one person from himself. If it ever bites, the fix is a read-only attach mode,
which is additive and does not change anything designed here.

The card shows the count of attached viewers when it is more than one, so an interleaved
mess has a visible cause.

### 2.6 The websocket dependency

I want one new dependency beyond `node-pty`, and I want to flag it rather than slip it in.

Node has no built-in websocket server. Three options were considered.

Hand-rolling RFC 6455 is about 150 lines and it is the kind of code that looks finished
and is not: masking, fragmentation, continuation frames, ping and pong, close handshake,
and payloads over 64 KB. A terminal stream hits fragmentation and large payloads on day
one.

Server-sent events plus HTTP POST needs no dependency at all, but SSE is text-only, so
every chunk of terminal output has to be escaped or base64-encoded, and the design already
commits to a websocket as the seam between runner and control plane. Building the seam
twice is worse than one dependency.

Recommended: `ws`. It has no dependencies of its own, it is the reference implementation
in the Node ecosystem, and it is what any future contributor expects to find. Pinned to an
exact version, lockfile committed.

Second dependency, dev only: `@xterm/xterm`, served from `node_modules` for the proof
page. This avoids pulling a script from a CDN into a page that talks to a local agent
runner. It becomes a real front-end dependency in step 5 anyway.

### 2.7 Output buffer

`pty-session.js` keeps a capped in-memory ring buffer, default 256 KB, and replays it to a
client on attach. This is needed in this step so that opening the page twice does not show
a blank terminal.

The buffer stores whole chunks and evicts the oldest until it fits. Two rules beyond that,
because a fullscreen repaint arrives as one large chunk and half a repaint replays as
garbage:

- A single chunk larger than the capacity is kept whole and everything older is dropped
  instead. The buffer is briefly larger than its nominal cap, which is the right trade.
- A hard ceiling, four times the capacity by default, stops one enormous chunk eating
  memory. Past it the tail is kept and the buffer records that it truncated.

Any replay that dropped anything is prefixed with a terminal reset. Eviction cuts the
stream at an arbitrary byte, which can land inside an escape sequence, and without the
reset xterm.js starts mid-sequence and paints garbage.

Writing that buffer to disk and replaying it after a process restart is step 6. What
belongs in this step is the experiment, not the feature: Benzoo's `"tui": "fullscreen"`
setting means the captured stream contains alternate screen buffer sequences, and it is
not known whether replaying that into a fresh xterm.js produces a readable screen. Task 5
runs the experiment and writes the answer down. If replay is broken, the fix (replay only
from the last screen clear, or emit a reset first) is designed then and built in step 6.

### 2.8 Process cleanup

`node-pty`'s kill on Windows terminates the ConPTY process, but children Claude Code
spawned may outlive it. The runner tracks the pid and, after a kill, falls back to
`taskkill /PID <pid> /T /F` if the process is still alive after a short grace period.
Orphaned ConPTY processes with nothing reading them are unpleasant to clean up by hand.

Operations on a pty whose process has already exited are not safe. Measured against
node-pty 1.1.0 during Task 2, and the result corrects what Task 0 assumed:

- `resize` throws `Cannot resize a pty that has already exited`, synchronously, on the
  caller's stack. Unguarded this is a runner crash, and an idle timeout landing a moment
  after a session ended by itself hits it.
- `write` is silently dropped, so a caller cannot tell sent from lost.
- `kill` does not throw in process. It forks a helper that dies printing
  `AttachConsole failed` to stderr. Noise, not a crash. Task 0 read this as the runner
  dying and that was wrong.

The guard is two things, not one, and both are load bearing. A flag, checked first, which
handles the common case cheaply. And a try and catch around the call, because the process
can die between the check and the call, and a flag cannot cover a race it is not
synchronised with. `pty-session.js` records exit state once in the exit handler, `write`,
`resize` and `kill` all return false after it, and a throw from the underlying pty is caught
and treated as proof the process is gone, so one failure settles the session instead of
retrying into the same exception. A test exercises the race rather than only the flag, by
killing and resizing in the same tick with nothing awaited between them.

`useConptyDll: true` removes the forked helper and the stderr noise, and was rejected: it
also stops resize working entirely, emitting no size report and no repaint. Resize is one
of the five things this step exists to prove.

### 2.8.1 A session that ends by itself must still be disposed

Found while checking whether `--test-force-exit` was hiding a real leak. It was.

`node-pty` releases its conout socket worker only inside `kill()`. A pty whose process
ended on its own never takes that path, so the worker thread outlives the process it
belonged to. Measured: three sessions ended with their own exit left three `MessagePort`
handles that never came back down, where three killed sessions left none.

That is not a test artefact. An agent whose Claude Code ends normally exits on its own, so
does one that crashes, and the runner is meant to stay up for days with idle shutdown
cycling sessions. Every one of those would have leaked a worker thread and a pair of pipe
handles.

So the exit handler calls `kill()` once when the runner did not request it, purely to
trigger disposal. It is best effort and wrapped, because the process is already gone and a
failure there must not turn a clean exit into an error.

With that fixed, `--test-force-exit` is not needed at all and has been removed. The suite
runs to completion and exits on its own, which means a future leak will show up as a hang
rather than being silently absorbed. Keeping the flag would have been a permanent blindfold
over exactly the class of bug this section is about.

There was a second leak underneath it, found by asking what the handles that remained after
the first fix actually were. One `PipeWrap` per session, linear, identical on the killed and
the natural path: three sessions left five handles and thirty left thirty-two. node-pty's
ConPTY kill path never destroys its conin socket, while the ConPTY DLL path a few lines away
does, so it is an asymmetry inside node-pty and the path Stafford has to use is the leaking
one.

The exit handler therefore releases that socket itself. It reaches into a dependency's
internals, which is named here rather than hidden, and it fails soft: if node-pty moves those
fields the reach finds nothing and the leak returns rather than the runner throwing. What
catches that is a test asserting the handle count stays flat across ten sessions, which fails
on the leak whatever the cause.

Both leaks matter for the same reason. Idle shutdown cycles sessions all day and the runner
is meant to stay up for days, so anything per-session that is not released is unbounded.

### 2.8.2 Filtering the stderr noise

Every kill prints an `AttachConsole failed` stack from node-pty's forked helper, and after
2.8.1 that now happens on natural exits too, so it is more frequent rather than less.

The app runs headless with no window, so the log is the only way Benzoo sees anything. A log
carrying a stack trace on every session end trains him to ignore it, and then the one real
error in it goes unread. That is a worse outcome than the noise itself, so the filter is
part of this step rather than a later cleanup.

The runner writes its own log rather than letting stderr through raw. Lines matching the
known pattern are dropped and a counter is incremented, and the counter is reported
periodically and at shutdown. If node-pty's message ever changes, the count stops rising and
the new text appears in the log, so the filter cannot quietly swallow something else.

The readiness gate is not a substitute for this. The gate answers whether a session ever
started, which is a different question from whether the process is alive right now.

On runner shutdown every live pty is killed. On boot, zero processes spawn.

### 2.9 The one state that does not come from a hook

State comes from hooks. That rule holds everywhere except here, and the exception is
written down so nobody later removes it as a mistake.

A Claude Code process that exits cleanly fires `SessionEnd` and the card goes idle. A
process that crashes, is killed, or dies with the machine fires nothing. The last hook
anyone saw was `PreToolUse`, so without an exception the card sits on working forever and
the only way to notice is to look at Task Manager.

So: the pty's own exit event sets the state. A pty that exits after `SessionEnd` was
already seen leaves the state alone, since the session ended properly. A pty that exits
with no `SessionEnd` sets the state to crashed, records the exit code, and clears the
session binding.

One exception inside the exception, found in Task 0. Declining a trust prompt exits the
process with code 1 and fires no hook at all, which from the outside is indistinguishable
from a crash. The runner can tell them apart without reading terminal output, because
`trust.js` already knows whether the directory was trusted before the spawn.

The full classification, given the trust status read at spawn time and which hooks were
seen:

| Trust at spawn        | `SessionStart` seen | `SessionEnd` seen | Reported     |
| --------------------- | ------------------- | ----------------- | ------------ |
| any                   | yes                 | yes               | idle         |
| any                   | yes                 | no                | crashed      |
| trusted               | no                  | no                | crashed      |
| not trusted           | no                  | no                | needs trust  |
| unknown               | no                  | no                | needs trust  |

Unknown is treated as not trusted for this purpose. A startup crash that produces zero hook
events is rare, an unanswered or declined trust prompt is the likely cause, and needs trust
is the more actionable thing to put on a card than crashed. The card says which directory
needs clearing, so if the guess is wrong Benzoo finds out in one click rather than being
sent hunting for a crash that did not happen.

This is not deriving state from terminal output and it is not trusting an agent's account
of itself. It is the runner reporting on a process it owns, which is the one thing it can
observe more reliably than the hooks can. Everything else still comes from hooks.

---

## 3. Files affected

Created:

```
runner/agent-env.js
runner/agent-env.test.js
runner/claude-locator.js
runner/claude-locator.test.js
runner/pty-session.js
runner/pty-session.test.js
runner/session-registry.js
runner/session-registry.test.js
runner/terminal-server.js
runner/terminal-server.test.js
runner/trust.js
runner/trust.test.js
runner/public/terminal.html
docs/pty-runner-verification.md
```

Modified:

```
runner/server.js          wiring, plus static file serving for the proof page
runner/hook-endpoint.js   record and emit agentId
runner/hook-endpoint.test.js  one test for the new field
hooks/claude-hook.js      forward STAFFORD_AGENT_ID
package.json              two dependencies, pinned
package-lock.json         committed
.gitignore                already covers .state/, no change expected
```

The six existing hook endpoint tests must still pass unchanged. If one of them needs
editing, that is a signal I changed behaviour I was told not to change.

---

## 4. Order of work

Each task is sized to finish inside one usage window. Each ends with a WIP checkpoint
commit on the feature branch, squashed into one commit when the whole step is verified.

**Task 0. Done, 2026-08-06. Verify the three unknowns. No production code.**
All three answered, with real output in `docs/pty-runner-verification.md`. The environment
route works, the readiness gate is sufficient for trust, a declined trust prompt fires no
hook at all, and killing a dead pty crashes the runner. The plan above is updated for all
four. Original scope of the task, kept for the record:

Throwaway script under the scratchpad. Answers three questions, with real output pasted
into `docs/pty-runner-verification.md` rather than a summary of it:

1. Does a hook command inherit an environment variable set on the spawned Claude Code
   process.
2. Does `SessionStart` fire before or after the trust prompt is cleared.
3. On an untrusted directory where trust is declined, does `SessionStart` fire at all.

Everything downstream depends on the first answer. If it is no, I stop and bring the
correlation-window design back for a decision rather than building it. Correlating on
directory plus timestamp misattributes state whenever Benzoo has his own Claude Code open
in the same repo, which is the exact failure the hook design exists to prevent.
Roughly one hour.

**Task 1. Environment, locator and trust.**
`agent-env.js`, `claude-locator.js` and `trust.js` with their tests. Pure functions over an
injected filesystem and registry reader, so they test without touching the real machine,
plus one test that runs against the real machine and asserts Git Bash was found.

`trust.js` carries both halves of what Task 0 produced: the three-state read of Claude
Code's own trust record, and `classifyExit`, the pure function that turns a trust status
plus which hooks were seen into idle, crashed or needs trust. The registry consumes
`classifyExit` in Task 3 and does not reimplement it.

Half a window plus the trust work. If it runs past its window, it splits at the boundary
between the environment pair and `trust.js` rather than pushing through, because folding
work forward is exactly how a task quietly outgrows the sizing rule.

**Task 2. Done, 2026-08-06. The pty layer.**
17 tests, 53 in the suite, all passing. The dead-pty guard was written first and the Task 0
crash was re-measured while doing it, which corrected its severity and moved it from `kill`
to `resize`. See the verification log. Original scope:

`node-pty` pinned at 1.1.0, already installed during Task 0. `pty-session.js` with spawn,
write, resize, kill, exit and the ring buffer, including the guard that makes kill a no-op
on an already-exited process. Tests spawn a small node script rather than `claude.exe`, so
the suite is fast, offline and burns no quota: assert output arrives, assert written input
comes back, assert a resize changes the reported column count, assert the buffer caps,
assert killing twice does not throw.
One window.

**Task 3. Registry, hook binding and the crashed state.**
`session-registry.js`, the `agentId` field through the forwarder and the endpoint, the
readiness gate that refuses input before `SessionStart`, the bind clearing on exit, and
the crashed state from an exit with no `SessionEnd`. Tests as listed in section 6.
Half a window.

**Task 4. Websocket and the proof page.**
`ws` added and pinned, `terminal-server.js`, `public/terminal.html`, `server.js` wiring,
the launch URL with the token in the fragment. Tests cover origin rejection, host
rejection, missing auth, wrong token, auth timeout, attach to an unknown agent, a full
attach plus input round trip against a fake pty, two concurrent viewers, and that no route
returns the token.
One window, probably more.

**Task 5. End to end on the real thing, and the fullscreen replay experiment.**
Spawn a real `claude.exe` for a real directory, drive it from the browser, resize it,
confirm the card's session id matches the hook event. Then the replay test: capture a
session's output, reload the page, record whether the replayed screen is readable. Real
output goes into `docs/pty-runner-verification.md` whichever way it turns out.
Half a window.

**Task 6. Squash, document, hand over.**
Squash to one Conventional Commit, update `STAFFORD-PLAN.md` section 3 with what is now
verified, push the feature branch. Benzoo merges.

Total: the per-task numbers above are the optimistic read. Benzoo's correction, which I
accept: expect roughly half again on top, concentrated in Tasks 4 and 5, where a websocket
talking to a real TUI is the first point at which everything has to be right at once. Call
it six to eight hours across six sittings. Progress gets reported against that, and if it
runs over, that is what the report says.

Task 0 is the one that can change the plan, so it goes first and alone.

---

## 5. Risks

**Retired by Task 0.** Two risks are gone. Hook commands do inherit the spawned
environment, so the binding design holds and the correlation fallback is dropped.
`SessionStart` fires only after the trust prompt is cleared, so the readiness gate closes
the trust hole by itself. Real output in `docs/pty-runner-verification.md`.

**Fullscreen replay may be unusable.** Known unknown, called out in the design. It is
contained: the consequence is scoped to step 6 and to how the buffer is captured, and
Task 5 produces the answer before step 6 is planned.

**`node-pty` is a native module.** Verified to install prebuilt on Node 26 on this machine.
The risk is any future Node major, where a prebuilt binary may not exist yet and a
compiler suddenly becomes a requirement. Mitigated by pinning the version and by writing
the Node version that works into the README.

**Websocket exposure to the local browser.** Covered by the origin check and the auth
frame in 2.5. Worth restating because it is the one genuinely new attack surface this step
adds. If either control is missing, any page Benzoo has open can drive his agents.

**The shared token is readable by any agent with a shell.** True today for the hook
endpoint and not made worse here, since the token is kept out of the spawned environment.
Real fix is per-agent tokens with the registry in step 4. Naming it now so it does not get
lost.

**ConPTY orphans on Windows.** Mitigated with the tracked pid and the `taskkill /T`
fallback. Worst case is a stray `claude.exe` after a hard runner kill, visible in Task
Manager, not a data risk.

**Scope creep into step 6.** Idle shutdown, `--resume` and disk persistence are all one
small step away from every module in this plan. They are named in section 1 as out of
scope so that the temptation is visible when it arrives.

---

## 6. Tests

`node --test runner/*.test.js`. No framework. A run reporting zero tests is a failure.

Automated:

| Module             | What is asserted                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `agent-env`        | Only allowlisted variables survive. A planted secret in the parent environment does not appear in the result. PATH contains Git Bash, System32 and the node directory. `STAFFORD_AGENT_ID` is set. `AGENT_DASHBOARD_TOKEN` is absent. Missing Git Bash warns and still returns an environment. |
| `claude-locator`   | Config override wins. Then `.local\bin`. Then PATH. A clear error when none resolve.                                        |
| `pty-session`      | Output streams from a spawned process. Written input reaches it. Resize changes the reported columns. The ring buffer caps and keeps the tail. Exit fires with a code. Kill leaves no live pid. After exit, each of write, resize and kill returns false instead of throwing, and kill called twice does not throw. Kill and resize in the same tick, with nothing awaited between them, does not throw. A session that ends by itself releases its handles. An explicit kill disposes once and the exit handler does not repeat it, in both orderings. Handle count stays flat across ten sessions. |
| `log filter`       | A line matching the known node-pty pattern is dropped and counted. Any other stderr line passes through untouched. The count is reported at shutdown. |
| `session-registry` | Agent id binds to session id once and rebinding within a spawn is refused. The bind clears on pty exit and a new spawn binds a new session id. Unknown agent id is rejected. Input is refused before `SessionStart` and accepted after. An exit with no `SessionEnd` sets crashed and records the code. An exit after `SessionEnd` does not overwrite idle. An exit with no `SessionStart` on an untrusted directory reports trust declined, not crashed. |
| `terminal-server`  | Unexpected origin is refused at upgrade. Unexpected `Host` is refused on both a plain request and an upgrade. No auth frame within the timeout closes the socket. Wrong token closes the socket. Attach to an unknown agent returns an error frame. A valid attach replays the buffer, forwards input and forwards resize. Two sockets on one agent both receive output and both can send input. No response body from any route contains the token. |
| `trust`            | Trusted, not trusted and unknown are each reported correctly from a fixture config. Path separators and case do not change the answer. A missing or malformed config reads as unknown rather than throwing. No code path writes to Claude Code's config. `classifyExit` returns idle, crashed or needs trust for every row of the table in section 2.9, including unknown treated as not trusted. |
| `hook-endpoint`    | The existing six still pass. One added: an event carrying `agentId` records and emits it.                                    |

Manual, with real output written into `docs/pty-runner-verification.md`:

- A real `claude.exe` renders its TUI in the browser, in color.
- Typed text reaches the prompt and produces a reply.
- Browser resize reflows the TUI.
- The session id shown for the hire matches the id in the `SessionStart` hook event.
- claude-hud renders in the spawned session, proving Git Bash on PATH.
- Reload replays the buffer, with a verdict on whether fullscreen replay is readable.

Definition of done for step 3: every automated test passes with real output shown, every
manual check has a recorded result, and any check that failed is stated plainly rather
than worked around.

---

## 7. Decisions taken

Answered by Benzoo on 2026-08-06, recorded here so a fresh session does not reopen them.

1. `ws` as a second runtime dependency. Approved. Hand-rolled RFC 6455 rejected.
2. Trust prompts cleared by hand, once per project. Approved. The runner never
   auto-accepts and never writes to Claude Code's config.
3. First real spawn in the Stafford repo. Approved.
4. Session binding is per spawn and clears on pty exit. Section 2.2.
5. An unexpected pty exit sets the crashed state, and this is the only state in the system
   that does not come from a hook. Section 2.9.
6. The token is never served over HTTP. It reaches the proof page through the URL
   fragment. `Host` is validated alongside `Origin`. Section 2.5.1.
7. Concurrent attach is many viewers, all able to type. Section 2.5.2.
