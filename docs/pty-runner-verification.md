# Pty runner verification log

Real output from verification runs against Claude Code 2.1.222 on Benzoo's machine.
Recorded rather than summarised, because a summary of a test is not a test.

Companion to `docs/plans/pty-runner.technical.md`.

---

## Task 0, run 2026-08-06

Three questions, answered by spawning real `claude.exe` processes inside a pseudo-terminal
built by a throwaway script under the scratchpad. No production code was written. The one
production file touched was `hooks/claude-hook.js`, temporarily patched with a probe that
appended one JSON line per hook event, and reverted afterwards. The patch was inert unless
a probe path was set, so no other Claude Code session on the machine changed behaviour.

Environment given to every spawned process, built from an allowlist with `process.env`
never passed through:

```
APPDATA, COMSPEC, GIT_BASH_FOUND, HOMEDRIVE, HOMEPATH, LOCALAPPDATA,
NUMBER_OF_PROCESSORS, OS, PATH, PATHEXT, PROCESSOR_ARCHITECTURE, PROGRAMDATA,
ProgramFiles, ProgramFiles(x86), STAFFORD_AGENT_ID, STAFFORD_PROBE_FILE,
STAFFORD_PROBE_MARKER, SystemRoot, TEMP, TMP, USERDOMAIN, USERNAME, USERPROFILE, windir
```

`node-pty` 1.1.0 installed from a prebuilt binary on Node 26.0.0, no compiler.

---

### Question 1. Does a hook command inherit an environment variable set on the spawned Claude Code process?

**Yes.**

Run 2, working directory `C:\Users\<user>\Git\Stafford`, which Claude Code already
trusts. Spawned with `STAFFORD_AGENT_ID=run2-trusted`.

Spawn:

```
[2026-08-06T13:55:54.391Z +     1ms] SPAWN C:\Users\<user>\.local\bin\claude.exe  cwd=C:\Users\<user>\Git\Stafford  agentId=run2-trusted
[2026-08-06T13:55:54.393Z +     2ms] GIT_BASH_FOUND=yes
[2026-08-06T13:55:54.599Z +   208ms] pid=37388
```

What the `SessionStart` hook wrote:

```json
{"at":"2026-08-06T13:55:56.331Z","event":"SessionStart","sessionId":"<session-id>","cwd":"C:\\Users\\<user>\\Git\\Stafford","staffordAgentId":"run2-trusted","staffordMarker":"marker-run2-trusted","sawProbeFileVar":true}
```

Both injected variables arrived: the agent id and the separate marker. Reproduced on an
earlier run with a different id:

```json
{"at":"2026-08-06T13:54:30.529Z","event":"SessionStart","sessionId":"<session-id>","cwd":"C:\\Users\\<user>\\Git\\Stafford","staffordAgentId":"run1-trusted","staffordMarker":"marker-run1-trusted","sawProbeFileVar":true}
```

The probe also had a hardcoded fallback path, used when the environment variable was
absent, so that "the hook never ran" and "the variable did not arrive" could not be
confused. The fallback file stayed empty on every spawned run, and a direct control
invocation proved the fallback path itself worked:

```json
{"at":"2026-08-06T13:55:47.268Z","event":"ControlProbe","sessionId":"local-control","cwd":"C:/ctl","staffordAgentId":null,"staffordMarker":null,"sawProbeFileVar":true}
```

**Consequence.** The agent id to session id binding in section 2.2 of the technical plan
is sound. The correlation-window fallback is not needed and is dropped.

**Incidental.** A relative path in the probe variable resolved against the hook's own
working directory, which is Claude Code's working directory, not the runner's. Anything
the runner passes to a hook through the environment must be absolute.

**Incidental.** `GIT_BASH_FOUND=yes` and the claude-hud status line rendered inside the
spawned session, showing `1 CLAUDE.md | 2 MCPs | 8 hooks`. The explicit PATH build in
section 2.3 fixes the known status line and plugin hook breakage.

---

### Question 2. Does SessionStart fire before or after the trust prompt is cleared?

**After. It does not fire while the prompt is up.**

Run 3, a freshly created directory Claude Code had never seen, left alone for 30 seconds.
The trust prompt rendered:

```
Accessing workspace: ...\scratchpad\untrusted-a
Quick safety check: Is this a project you created or one you trust? ...
Claude Code'll be able to read, edit, and execute files here.
> 1. Yes, I trust this folder
  2. No, exit
Enter to confirm - Esc to cancel
```

No hook event of any kind was written in those 30 seconds. Probe file empty, fallback file
empty.

Run 4, same setup, Enter sent at 10 seconds to accept:

```
[2026-08-06T13:57:43.908Z +     1ms] SPAWN ... agentId=run4-accept
[2026-08-06T13:57:44.120Z +   213ms] pid=62800
[2026-08-06T13:57:54.122Z + 10215ms] SEND "\r"
```

```json
{"at":"2026-08-06T13:57:55.802Z","event":"SessionStart","sessionId":"<session-id>","cwd":"...\\scratchpad\\untrusted-b","staffordAgentId":"run4-accept","staffordMarker":"marker-run4-accept","sawProbeFileVar":true}
```

Trust accepted at +10.215 seconds, `SessionStart` at +11.894 seconds. A gap of about 1.7
seconds, and nothing before it.

**Consequence.** The readiness gate in section 2.4 closes the trust-prompt hole on its
own. If the runner refuses to write to a pty until `SessionStart` has been seen for that
agent id, no queued message can ever land on a trust prompt. `trust.js` stays useful for
showing Benzoo why a card is stuck, but it is no longer the load-bearing control, and the
risk listed for it in section 5 is retired.

---

### Question 3. On an untrusted directory where trust is declined, does SessionStart fire at all?

**No. Nothing fires, and the process exits.**

Run 5, fresh directory, Down then Enter to select "No, exit":

```
[2026-08-06T13:58:38.054Z +     1ms] SPAWN ... agentId=run5-decline
[2026-08-06T13:58:38.243Z +   189ms] pid=14896
[2026-08-06T13:58:48.250Z + 10196ms] SEND "\u001b[B"
[2026-08-06T13:58:49.247Z + 11193ms] SEND "\r"
[2026-08-06T13:58:50.801Z + 12747ms] EXIT code=1 signal=undefined
```

Terminal output confirmed the selection moved to "No, exit" before Enter. Probe file
empty, fallback file empty. Exit code 1 about 1.5 seconds after the decline.

**Consequence.** A declined trust prompt looks exactly like a crash from the runner's side:
a pty that exits with no `SessionEnd`. Under the rule agreed in section 2.9 that would set
the card to crashed, which is wrong and unhelpful. The distinction the runner can make
without reading terminal output: `trust.js` already knows the directory was untrusted
before the spawn, so an exit with no `SessionStart` on a directory that was not trusted is
reported as trust declined, not crashed. An exit with no `SessionStart` on a directory that
was trusted stays a crash.

This needs one line in the plan and belongs in Task 3.

---

### Incidental finding: killing an already-exited pty crashes the runner

Run 5's script called `kill()` on a pty whose process had already exited. `node-pty` threw
from its ConPTY console list agent and took the whole process down:

```
C:\Users\<user>\Git\Stafford\node_modules\node-pty\lib\conpty_console_list_agent.js:13
var consoleProcessList = getConsoleProcessList(shellPid);
                         ^

Error: AttachConsole failed
```

**Corrected during Task 2. Read the section below before quoting this one.** The severity
above is wrong. That output comes from a helper process node-pty forks during kill, not
from the runner, and the runner survives it.

---

### Trust records, for `trust.js`

Claude Code stores trust in `~/.claude.json` under `projects`, keyed by path with forward
slashes:

```
C:/Users/<user>/Git/Stafford -> hasTrustDialogAccepted=true
C:/Users/<user>/AppData/.../scratchpad/untrusted-b -> hasTrustDialogAccepted=true
```

The two directories where trust was declined or never answered have no entry at all, so
`trust.js` reads three states directly: entry with the flag true is trusted, entry with the
flag false is refused, no entry is unknown. It reads this file and never writes it.

**Cleanup, resolved during Task 1.** Run 4 accepted trust for a scratch directory, leaving
`~/.claude.json` with an entry for a temporary path that no longer mattered. Benzoo decided
it should go: the rule that Stafford never edits Claude Code's config governs the runner's
automatic behaviour, not manual maintenance, and a trusted temp path is a real if small
wart, since a recreated directory of the same name would be silently trusted.

Removed by hand, one entry, verified against a backup at
`~/.claude.json.bak-before-trust-cleanup`. The diff was exactly the 30 lines of that entry
and nothing else, and the project count went from 18 to 17. Reading the same path afterwards
returns `not_trusted`, which is also a live check of `readTrust` against the real file.

---

### Summary

| Question                                        | Answer                                        | Effect on the plan                                      |
| ----------------------------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| Hook inherits the spawned environment            | Yes, confirmed twice                          | Section 2.2 stands. Correlation-window fallback dropped.  |
| `SessionStart` versus the trust prompt           | Fires only after the prompt is cleared, +1.7s | Readiness gate is sufficient. A risk in section 5 retired. |
| `SessionStart` when trust is declined            | Never fires, process exits 1                  | New case: declined trust must not be reported as a crash. |
| Killing an already-exited pty                    | Noisy but survivable, see the Task 2 correction | Guard still required, for a different call.              |

---

## Task 2, run 2026-08-06

### Correction: which call actually crashes the runner

Task 0 read the `AttachConsole failed` output as the runner dying. That was wrong, and the
correction matters because it changes which call the guard is protecting.

Tested directly against node-pty 1.1.0, calling each operation on a pty whose process had
already exited:

```
write:  no throw
resize: THREW Cannot resize a pty that has already exited
kill:   no throw
```

So the in-process crash is `resize`. It throws synchronously on the caller's stack, and
unguarded it takes the runner down. `write` is silently dropped. `kill` does not throw in
process at all: node-pty forks `conpty_console_list_agent.js` to enumerate the console, and
when the console is already gone that forked child dies printing `AttachConsole failed` to
the parent's stderr. Noise in the log, not a crash.

Proven rather than argued. This test kills one session and then keeps using another:

```
✔ killing one session leaves the runner and other sessions working (331.5927ms)
```

The guard is still right and still required. It is just earning its place on `resize`
rather than on `kill`.

### Rejected: useConptyDll

node-pty's `useConptyDll: true` avoids the forked helper entirely, so kill is silent and
leaves no dangling timer. It also breaks resize completely.

Bytes emitted by the pty in the 800ms after a resize from 80x24 to 132x40:

```
useConptyDll=false -> "[?25l[8;40;132t[HREADY[K\r\n[K\r\n..."
useConptyDll=true  -> ""
```

`CSI 8 ; rows ; cols t` is the ConPTY announcing its new size, followed by a repaint. With
the DLL path there is no report and no repaint. Resize is one of the five things this step
exists to prove, so the DLL path is not usable and the noise stays.

### How resize is tested

A child process cannot be asked for its width. Both `process.stdout.columns` and
`getWindowSize()` report the size the console had at startup and do not follow a ConPTY
resize:

```
useConptyDll=true  -> before: 80x24 | after: 80x24
useConptyDll=false -> before: 80x24 | after: 80x24
```

ConPTY also does not hard wrap in the output stream, so wrap width is not observable
either: a 300 character line arrives as 300 unbroken characters at both 80 and 132 columns.

The size report the ConPTY emits is therefore the assertion, and it is the better one
anyway, since it is exactly what a real TUI reads to reflow.

### Known cosmetic issue

Every kill prints an `AttachConsole failed` stack from node-pty's forked helper. It reaches
the runner's stderr and will appear in the log file once the runner runs headless. Harmless,
and unavoidable without giving up resize. Filtered at write time rather than tolerated, per
section 2.8.2 of the plan, because a headless app's log is the only thing Benzoo sees and a
stack trace on every session end teaches him to ignore it.

### The leak that --test-force-exit was hiding

`--test-force-exit` was added because the suite passed and then hung, and the hang was
blamed on node-pty's five second timers. Benzoo pushed back that a blanket force exit
disables the signal for a real leak. He was right, and there was one.

Timers were not the problem. They clear:

```
[     0ms] baseline, nothing spawned   {}
[  1909ms] after 5 spawn and kill      {"PipeWrap":8,"MessagePort":3,"ProcessWrap":1,"Timeout":11}
[  3015ms] at 3000ms                   {"PipeWrap":7,"Timeout":5}
[  5514ms] at 5500ms                   {"PipeWrap":7,"Timeout":4}
[  8013ms] at 8000ms                   {"PipeWrap":7}
[ 15007ms] at 15000ms                  {"PipeWrap":7}
```

Eleven timers down to none by eight seconds. Fine.

Bisecting the suite found one test that hung the file, and it was the one where the process
exits on its own and is never killed. Comparing the two paths directly, three sessions each:

```
mode: kill, sessions: 3
[   616ms] after 3 kill                  {"PipeWrap":6,"MessagePort":3,"ProcessWrap":1,"Timeout":9}
[  8624ms] 8s later                      {"PipeWrap":5}

mode: natural, sessions: 3
[  3470ms] after 3 natural               {"PipeWrap":5,"MessagePort":3}
[ 11476ms] 8s later                      {"PipeWrap":5,"MessagePort":3}
```

Killed sessions release their `MessagePort` handles. Sessions that end by themselves do not,
because node-pty frees its conout socket worker only inside `kill()`. One leaked worker
thread per session that ends on its own, which in production means every normal session end
and every crash, on a runner meant to stay up for days.

After calling `kill()` from the exit handler purely to trigger disposal:

```
mode: natural, sessions: 3
[  3499ms] after 3 natural               {"PipeWrap":6,"MessagePort":1,"ProcessWrap":1,"Timeout":4}
[ 11505ms] 8s later                      {"PipeWrap":5}
```

And the test that hung:

```
=== the test that hung, without force-exit ===
exits cleanly (0)
```

`--test-force-exit` is now removed entirely rather than scoped to the pty file. With the leak
fixed nothing needs it, and leaving it would keep the blindfold on for the next leak. The
suite is slower as a result, 11.8s against 5.3s, because it now waits for real disposal
instead of forcing exit. That is the honest cost and it is worth paying.

### try and catch does not protect a native teardown race

The correction underneath the module, worth more than the bug that exposed it.

`_guard` was written on the assumption that wrapping a call makes it safe: check the flag for
the common case, catch the throw for the race. That is wrong for half of what it guards.
node-pty calls into native code, and a call landing while the ConPTY is tearing down can end
the process without raising a JavaScript error at all. There is no stack, no message and
nothing to catch. Wrapping it does not make it safe, it makes it look safe.

Found by looping the pty suite. Roughly one run in four died immediately after the test that
kills two sessions, with no diagnostic beyond the file being reported as `'test failed'`, which
is the same signature as the Windows CI failure:

```
✔ killing one session leaves the runner and other sessions working (470.7463ms)
✖ runner\pty-session.test.js (3810.7622ms)
ℹ tests 6   pass 5   fail 1
  'test failed'
```

The call was `resize` landing between `kill()` and the exit event, from a test written to prove
that race was survivable. It is not survivable. The only defence is not making the call.

**So the rule for this module, and for the port in Task 6:** during or after teardown, refuse
rather than attempt. A session stops being usable when a kill is requested, not when the exit
event arrives.

Audited the rest of the module against that rule:

| Call                              | When it can run            | Status                                                       |
| ---------------------------------- | -------------------------- | ------------------------------------------------------------ |
| `write`, `resize`                  | any time                   | Refused once a kill is requested. This was the bug.           |
| `kill`                             | any time                   | Self-guarding and idempotent. A second call is refused.       |
| `_term.kill()` for disposal        | after the exit event       | Deliberate and measured: kill on an exited pty does not throw in process. |
| `inSocket.destroy()`               | after the exit event       | A libuv socket rather than the ConPTY, and it carries an error listener. |

The two calls in the exit handler are made after the process is gone rather than while it is
going, which is a different window from the one that killed us. They are measured rather than
assumed, and the measurements are in this document.

This reproduced about one run in four, so a single green run does not clear it. The loop used
to find it is committed at `scripts/loop-pty-tests.js` and should be re-run after any change to
the pty layer.

---

### The second leak, found by asking what the residual five handles were

Both paths settled at five `PipeWrap` handles where the baseline was one. That was parity
between kill and natural, which was the comparison the first leak needed, and it was not an
answer. Benzoo asked for three sessions against thirty, on the grounds that constant means
harness and linear means a second leak.

Linear:

```
mode: kill, sessions: 3
[  8857ms] 8s later                      {"PipeWrap":5}

mode: natural, sessions: 3
[ 11502ms] 8s later                      {"PipeWrap":5}

mode: kill, sessions: 30
[ 14214ms] 8s later                      {"PipeWrap":32}

mode: natural, sessions: 30
[ 43226ms] 8s later                      {"PipeWrap":32}
```

Three sessions leave five, thirty leave thirty-two, against a baseline of one. About one
handle per session, and identical on both paths, so it is not the disposal asymmetry that
caused the first leak.

Source, in node-pty 1.1.0's `windowsPtyAgent.js`. The ConPTY kill path marks both sockets
unreadable and disposes the conout worker, and never destroys the conin socket:

```
138  this._inSocket.readable = false;
139  this._outSocket.readable = false;
     ...
     this._conoutSocketWorker.dispose();
```

The ConPTY DLL path, seventeen lines further down, does destroy it:

```
155  this._inSocket.destroy();
```

So it is an asymmetry inside node-pty rather than a deliberate design, and the path Stafford
must use is the one that leaks. Confirmed by running the same workload with and without
destroying that socket from outside:

```
mode: leave, sessions: 30
[  5960ms] after 30 sessions         PipeWrap=33
[ 13970ms] 8s later                  PipeWrap=32
inSocket destroyed on 0 of 30 sessions

mode: destroy, sessions: 30
[  6654ms] after 30 sessions         PipeWrap=4
[ 14660ms] 8s later                  PipeWrap=2
inSocket destroyed on 30 of 30 sessions
```

Thirty-two down to two, and two is the residue of the last session still settling rather
than a per-session cost.

The fix is in `_settle` and it reaches into a dependency's internals, which is worth naming
rather than hiding. It is written to fail soft: if node-pty moves those fields the chain
finds nothing and the leak returns, instead of the runner throwing. What catches that is a
test asserting the handle count stays flat across ten sessions, which fails on the leak
regardless of why the leak came back.
