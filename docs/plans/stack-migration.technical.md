# Technical plan: stack migration

Moves the project from a Node runner plus a browser page to a TypeScript Electron desktop
app, per `docs/plans/STACK-DECISION.md`. Written for Benzoo to approve before any code is
written.

Scope is the migration and the groundwork it needs. The roster, the terminal view and the
rest of the interface are not in this plan. Neither is the native conversation view from
section 7 of the stack decision.

---

## 1. What this has to achieve

1. The repo is TypeScript strict and ESM, laid out for `electron-vite`, with one shared
   domain package.
2. Every platform difference sits behind one interface with per-OS implementations.
3. Hooks arrive over a local socket. No TCP listener, no token file.
4. The pty layer runs inside Electron's main process with `node-pty` rebuilt for it.
5. The app starts, lives in the tray, and its security configuration is written down as
   decisions rather than inherited as defaults.
6. The test suite is green at every checkpoint, not only at the end.

Out of scope, stated so it stays out: the roster, the agent detail view, the channel, the
board, the animation list in section 4 of the stack decision, and the conversation view.
The updater is planned here because it changes the build, the signing requirement and the
shutdown path, and it is sequenced after the pty work.

---

## 2. Two things I want to push back on first

Both are places where following the instruction literally produces a worse result. One
recommendation each, then I move whichever way Benzoo decides.

### 2.1 A blocking update must not ask agents to commit their own work

The stack decision says a blocking update should "instruct every running agent to commit
its work in progress". That means typing into a session, and the sessions that have work in
progress are by definition the ones that are working, not idle. The plan's own rule is that
a queued message is injected only when an agent is provably idle, because a message written
while a prompt is up becomes the answer to that prompt. That failure was reproduced live.

It also makes recovery depend on an agent choosing to comply, at the exact moment the
design says not to trust an agent's account of itself.

Recommendation: the runner performs the checkpoint commit itself, with git, on the agent's
branch, in the agent's repo. It is deterministic, it takes milliseconds, it does not need
the session to cooperate, and it does not violate the injection rule. Asking the agent
stays as an opportunistic extra for sessions that are already idle when the drain starts.

The risk of a runner-side commit is capturing a half-written file mid tool call. That is
what a work-in-progress checkpoint is for, it is recoverable, and it is strictly better
than losing the tree. The drain report names every agent whose commit happened this way.

### 2.2 The pipe replaces remote exposure, and the cross-user claim needs measuring

The stack decision says a named pipe gives OS-level access control and that authentication
becomes the operating system's job. The remote half of that is certainly true and is a real
gain: there is no TCP listener, nothing to port scan, and the Hyper-V reserved range
problem disappears.

The cross-user half is not established. Node's `net.createServer` gives no way to set a
security descriptor, so the pipe is created with libuv's defaults, and what that default
DACL grants on Windows is exactly the kind of thing that should be measured rather than
assumed. If it turns out another account on the machine can connect, then removing the
token has widened something while closing something else, on a corporate machine where
other accounts exist.

**Measured 2026-08-06. The default is not owner-only.** Everyone and ANONYMOUS LOGON are
granted `FILE_GENERIC_READ`. The full descriptor is in the verification log, verbatim,
because it is the evidence behind everything in the rest of this section.

What that means, and what follows from it:

- Another local account cannot forge events, because read access does not include
  `FILE_WRITE_DATA`. The remote and cross-user forgery surface really is closed.
- Another local account can read anything the server writes back, and can open connections
  as a nuisance.
- An agent can forge events, because agents run as Benzoo and that account has full access.
  The descriptor does nothing about the one case Stafford actually creates.

So three controls, all adopted:

**Per-agent secrets.** The runner generates a random secret per spawned session and injects
it into that session's environment beside `STAFFORD_AGENT_ID`. The forwarder includes it.
The endpoint validates that the secret matches the agent id being claimed and drops the
event otherwise. An agent can read its own secret and no other, so the worst it can do is
forge events about itself, which it could already do by simply behaving that way. The
shared token file dies, and it is not replaced by another shared secret.

**A constant acknowledgement.** The socket never carries anything back except a fixed
`{"ok":true}`. No state, no agent data, no diagnostics. Then the Everyone-read grant leaks
nothing even in principle, rather than leaking nothing by accident of what is currently
sent.

**A concurrent connection cap.** Everyone has read access, so another local account can open
connections without ever writing. A cap, with rejections logged rather than silent, turns
that from a runner outage into a line in the log. A connection that sends nothing within a
short window is also dropped.

One line on ANONYMOUS LOGON, because it is in that ACL and should not pass without comment.
On a domain-joined machine it is usually restricted by policy, and relying on that silently
is how a local assumption becomes a deployed one. The three controls above do not depend on
it being restricted.

On macOS a socket file inside a directory at mode 0700 is genuinely owner-only, so the
cross-user half of this is Windows-specific. Per-agent secrets are not: the same-user case
exists identically on both platforms.

---

## 3. The platform layer

The interface comes before either implementation, because a wrong interface here is the
expensive mistake in this migration.

### 3.1 The design rule that makes it testable

Task 1 survived a whole stack change because it was pure logic over injected dependencies.
The platform layer keeps that property by returning data rather than doing work wherever it
can.

So the interface hands back a list of environment variable names, a list of candidate paths,
a comparison rule. The logic that consumes them stays platform-independent and stays
testable without mocking an operating system. Only the three things that genuinely have to
touch the OS are behaviours: preparing the socket, killing a process tree, and reporting
what the socket's access control actually is.

Concretely, `buildAgentEnv` does not become platform-specific. It asks the platform for an
allowlist and a PATH recipe, and stays one function with one set of tests.

### 3.2 The interface

`src/main/platform/types.ts`:

```ts
export type PlatformId = 'win32' | 'darwin' | 'linux'

export interface SocketAccess {
  /** How the OS restricts who may connect. */
  readonly mechanism: 'named-pipe-dacl' | 'unix-socket-mode'
  /** True only when the runner has established owner-only access, not assumed it. */
  readonly ownerOnly: boolean
  /** Human-readable, shown in diagnostics and written to the log at startup. */
  readonly detail: string
}

export interface PathRecipe {
  /** Absolute directories, in order, joined with the platform separator. */
  readonly directories: readonly string[]
  readonly separator: string
  /** Set when a directory the platform wanted could not be found. */
  readonly warnings: readonly string[]
}

export interface KillResult {
  readonly killed: boolean
  readonly method: 'signal' | 'taskkill' | 'already-gone'
  readonly detail?: string
}

export interface SelfCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

export interface Platform {
  readonly id: PlatformId
  /** False for anything shipped but never exercised on real hardware. */
  readonly supported: boolean

  // --- hook transport -----------------------------------------------------
  hookSocketPath(appId: string): string
  /** Creates parent directories, applies access control, removes a stale socket. */
  prepareHookSocket(socketPath: string): Promise<SocketAccess>

  // --- agent environment --------------------------------------------------
  /** Variable names copied from the parent environment. Nothing else is. */
  inheritedEnvKeys(): readonly string[]
  /** Directories that make up the PATH handed to an agent. */
  pathRecipe(input: { home: string; nodeDir: string; parentPath: string }): PathRecipe
  /** Windows needs Git Bash found. POSIX always has a shell, so this is a no-op there. */
  shellSupport(parentPath: string): { available: boolean; root: string | null; warning: string | null }

  // --- locating the binary ------------------------------------------------
  executableName(base: string): string
  claudeCandidates(home: string): readonly string[]

  // --- processes ----------------------------------------------------------
  killTree(pid: number): Promise<KillResult>

  // --- paths --------------------------------------------------------------
  /** Trust records and repo paths compare differently per filesystem. */
  pathsEqual(a: string, b: string): boolean
  appDataDir(appId: string): string

  // --- honesty ------------------------------------------------------------
  /** Run at first launch on a platform. Proves assumptions instead of hoping. */
  selfCheck(): Promise<readonly SelfCheck[]>
}
```

Three implementations: `win32.ts`, `darwin.ts`, `linux.ts`. The Linux one is written
because writing it is what proves the interface is not secretly Windows-shaped, and it
reports `supported: false`, so the app refuses to start there with a clear message rather
than half working.

### 3.3 What each fork carries

| Concern       | Windows                                            | macOS                                                                    | Linux (written, unsupported)     |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------- |
| Socket path   | `\\.\pipe\stafford`                                | `~/Library/Application Support/Stafford/hook.sock`, directory mode 0700   | `$XDG_RUNTIME_DIR/stafford.sock` |
| Access        | Pipe DACL, whatever Task 0 measures                | Directory mode, owner only                                               | Directory mode                   |
| Env allowlist | SystemRoot, windir, COMSPEC, PATHEXT, OS, USERPROFILE, HOMEDRIVE, HOMEPATH, USERNAME, USERDOMAIN, APPDATA, LOCALAPPDATA, PROGRAMDATA, ProgramFiles, ProgramFiles(x86), TEMP, TMP, NUMBER_OF_PROCESSORS, PROCESSOR_ARCHITECTURE | HOME, USER, SHELL, TMPDIR, LANG, LC_ALL, PATH is rebuilt regardless | HOME, USER, SHELL, LANG, XDG_RUNTIME_DIR |
| PATH recipe   | System32, System32\Wbem, PowerShell v1.0, node dir, Git cmd/bin/usr/bin, `~/.local/bin` | `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, `~/.local/bin`, node dir | same as macOS minus homebrew |
| Shell         | Git Bash located: registry, well-known dirs, git.exe on PATH | Always present, no discovery                                    | Always present                   |
| Claude binary | `%USERPROFILE%\.local\bin\claude.exe`, then PATH   | `~/.local/bin/claude`, `/usr/local/bin/claude`, Homebrew prefix, then PATH | `~/.local/bin/claude`, then PATH |
| Kill tree     | `taskkill /PID <pid> /T /F`, one command walks the tree | `killTreePlan`: snapshot, kill every group in it, sweep by pid, verify | same as macOS |
| Path compare  | Case-insensitive, separators normalised            | Case-insensitive on default APFS, separators already POSIX               | Case-sensitive                   |

The inversion worth naming: Git Bash discovery is a Windows-only problem and it disappears
on macOS, where the status line and the plugin hook that fail under ConPTY simply work.

**Why the POSIX kill is a plan and not a command, since the table makes it look like an
implementation choice.** Measured 2026-08-08 against a real agent tree: `kill -9 -<session
pid>` killed the session, reported success, and left the tool child running, because Claude
Code runs its Bash tool through a wrapper that leads its own process group. A single command
cannot fix that, because the tree has to be measured before the root dies or the parent chain
that identifies the children is gone. So `killTreePlan` snapshots first, collects every group
in the snapshot, kills each, sweeps survivors by pid, and verifies. **The wrapper leads its
own group whether or not the sandbox is on**, measured both ways, so this is needed on every
macOS setup rather than only sandboxed ones, which is the answer to whether the added
complexity is justified. Full measurements in the verification log.

---

## 4. The hook transport swap

### 4.1 Splitting the endpoint so the constraint can actually hold

The instruction is that `hook-endpoint`'s state derivation and its tests survive unchanged,
and that editing one of those tests is a signal I changed behaviour I was told not to.

That cannot hold for all six as they stand, because two of them test HTTP itself: one
asserts a wrong token is rejected and a right one accepted, and one asserts the health
route answers without a token. Both the token and the route are being removed. I am not
going to pretend otherwise or quietly rewrite them and call them ported.

The fix that makes the constraint true from here on: split the module.

- `src/main/hooks/session-state.ts` holds `stateFor`, `looksRateLimited`, the activity and
  subagent counters, and the state transition emitter. No sockets, no HTTP, no transport of
  any kind. This is the part that must never change again, and after the split it cannot be
  forced to change by a transport decision.
- `src/main/hooks/hook-listener.ts` holds the socket, the framing and the parsing. Small,
  replaceable, and its tests are transport tests by design.

The four state tests move to `session-state.test.ts` with their assertions untouched. The
two transport tests are retired and replaced by socket tests.

### 4.2 The transport

One `net.createServer` on both platforms. Newline-delimited JSON, one event per line, the
server replies `{"ok":true}` and the forwarder exits. Same 64 KB cap, same immediate
answer, same rule that a slow or failing hook must never degrade a Claude Code session.

`hooks/claude-hook.js` changes in two ways and no more: connect to the socket path instead
of posting HTTP, and stop reading the token file. Its timeout, its silence when the runner
is down, and its guarantee of exiting 0 all stay.

### 4.3 Which runtime executes the hook

Worth deciding now rather than discovering at install time. The hook is registered in
`~/.claude/settings.json` as a command, and today that command is an absolute path to
`node.exe` resolved by `install.ps1`. A distributed app cannot assume Node is installed.

The forwarder is a standalone compiled binary shipped alongside the app, a few hundred KB of
Go or Rust. Not the Electron binary running as Node, and not a JavaScript file needing a
Node installation.

The reason is cost per tool call. A hook fires on every `PreToolUse` in every Claude Code
session on the machine, including Benzoo's own work that has nothing to do with Stafford.
Whatever the forwarder costs is paid on every one of those. A compiled helper starts in
single-digit milliseconds. Measured baseline for the current JavaScript forwarder under
plain Node on this machine: 100.9ms median, which is the number the binary has to beat.

**Go, decided 2026-08-06, and not by the startup measurement.** Both languages start in
single digits and the difference between them is noise against a 100ms baseline, so the
measurement would not have decided anything. What decides it is cross-compilation: Go
targets Windows, macOS arm64, macOS x64 and Linux from one toolchain, while
cross-compiling Rust to macOS from Windows is not realistically doable. That matters for CI
and for anyone building from source.

CI builds the release binaries, so a contributor needs Go installed only if they change the
forwarder itself. Everyone else builds the app without it.

**Measured 2026-08-06, and the result adjusts the expectation downward.** A working Go
forwarder costs 39.7ms per invocation against Node's 91.2ms, so it saves 51.6ms per hook.
Not the eighty-odd that "single-digit startup" implied, because a Go binary that does
nothing at all still costs 32ms on this machine. That 32ms is Windows process creation plus
Defender's scan on every launch, and no forwarder in any language avoids it. The program's
own work is 7.7ms, which is the single-digit figure the stack decision was reaching for; it
is right about the program and wrong about the cost.

Go is still the right call. It is a 2.3x improvement, it needs no runtime installed, and the
cross-compilation reason is untouched. The expectation is just smaller than it was.

Two other numbers worth carrying: the binary is about 2 MB rather than the few hundred KB
the stack decision estimates, because Go links a runtime, and it has no third-party
dependencies at all, because a Windows named pipe opens through `os.OpenFile` without
`go-winio`. A freshly written binary costs 342ms on its first run while Defender inspects
it, paid once after an install or update rather than per call.

Behaviour is unchanged from the JavaScript version: read the payload from stdin, send only
the event name, session id, cwd, tool name, notification text and the Stafford agent id,
never tool inputs, always exit 0, never let a hung runner degrade a Claude Code session.

**Build and packaging.** The binary is a build artifact, so it needs a place in the pipeline
rather than being committed:

- Built in CI per platform and architecture: `windows-amd64`, `darwin-arm64`, and
  `darwin-amd64` if an Intel Mac ever matters. Cross-compilation is trivial in Go and needs
  a toolchain per target in Rust, which is one more input to the language choice.
- Placed in `electron-builder`'s `extraResources`, so it lands beside the app rather than
  inside the asar, which cannot be executed from.
- Resolved at runtime through `process.resourcesPath`, never a path assembled from the
  development tree.
- Checked at launch: the app verifies the binary exists and runs, and reports loudly if not.

**The registered command must point at a stable path.** This is the failure mode nobody had
named. If the command points at a path that changes when the app updates, every hook breaks
at once, state detection dies, and every card goes stale with no error anywhere, because the
forwarder is designed to fail silently. So:

- The command points at the installer's stable location, never at a versioned directory.
  Windows NSIS installs to a stable program directory and macOS to a stable `.app` bundle,
  so both are fine as long as nothing versioned appears in the path.
- At every launch the app reads its own registration, compares it to what it should be, and
  repairs it if the path is wrong or the entry is missing.
- The app also runs the registered binary once at launch with a self-test flag and confirms
  it answers. A path that exists but no longer runs is the same outage as a missing one.
- The repair is logged, so a silent breakage becomes a visible line rather than a mystery.

### 4.4 Registration is per project, not global

The app does not write to `~/.claude/settings.json` at all. It registers its hooks in each
managed project's `.claude/settings.local.json`.

Global registration fires in every Claude Code session on the machine, including all of
Benzoo's work that has nothing to do with Stafford, and every one of those sessions pays the
spawn cost for events no card will ever read. Per-project registration means a session
outside a managed project pays nothing, ever.

**Verified 2026-08-06 before building on it.** Claude Code does run hooks declared in a
project's `.claude/settings.local.json`, they stack on top of the global ones rather than
replacing them, and no approval prompt appears. Counted rather than assumed: eight global
hook commands plus two project ones showed as `10 hooks` in the session's own status line.
Output in the verification log. If that had come back negative, the fallback was global
registration with the trimmed set from 4.5.

**`settings.local.json`, never `settings.json`.** The committed one would put the app's own
binary paths into employer repositories and into client repositories, where they do not belong and would
follow the repo to other machines. The local one is the uncommitted, per-machine file, which
is exactly the right scope.

Rules, mostly inherited from what the global version needed and improved by the smaller
scope:

- Registering happens when a project is added, deregistering when it is removed. Those are
  the natural moments and they need no separate confirmation flow.
- Merge, never replace. Read the file if it exists, modify only the `hooks` key, write back.
  A project may already have local hooks of its own and they survive.
- Touch nothing outside `hooks`. Never the trust records, which stay read-only per Task 1.
- Idempotent. Matching is by the command's own marker, not by string equality on a path that
  may have changed, so an update or a repeated launch cannot duplicate entries.
- Back up the file before the first change to it, keeping one copy per project.
- Show Benzoo the diff and confirm on the first project registered. After that it is a
  logged action, not a prompt, because he has already seen what it writes.

**Keeping it out of the repo's history.** `.claude/settings.local.json` is conventionally
gitignored, but a given repo may not ignore it, and Stafford must not cause an untracked
file to appear in a client repository. So the app adds the path to `.git/info/exclude`
rather than to `.gitignore`. `info/exclude` is local to the clone and is not a tracked file,
so nothing Stafford does shows up in a diff or a commit in someone else's repository.

**The gap that creates, and how the sweep covers it.** `info/exclude` is per clone and is
not versioned, so a fresh clone of a managed project has no exclusion. The settings file
then shows up as untracked, and an agent running `git status` before committing can pick it
up and commit Stafford's own configuration into a client repository. That is exactly the
outcome `info/exclude` existed to prevent, arriving by a different route.

So the sweep checks two things per project, not one:

1. The hook registration exists and points at a path that is valid and runs.
2. The exclude entry exists in this clone's `.git/info/exclude`.

**When the sweep runs.** At launch, and again whenever a project is added, because a project
can be added while the app is running and a launch-only sweep would leave that project
unprotected until the next restart, silently. Every repair is logged.

`hooks/install.ps1` is deleted once this works.

### 4.5 How many events are registered, and when

The app registers a reduced set of hook events until the compiled forwarder is in place, and
the full set only after.

The reason is a number that looked fine and was not, and the measured figures make it
sharper rather than softer. Cost per tool call, with `PreToolUse` and `PostToolUse` both
registered:

| Configuration                         | Per tool call |
| ------------------------------------- | ------------- |
| Today, Node forwarder                 | about 182ms   |
| Go forwarder                          | about 79ms    |
| A hypothetical forwarder that is free | about 64ms    |

The cost is almost entirely process creation, so it is paid whether the runner is up or
down, and hooks are synchronous so it adds to the tool call rather than hiding behind it.
Today that is roughly 182ms on every tool call in every Claude Code session on this machine,
including Benzoo's own work, for no benefit at all while Stafford is not running.

The floor is the part that decides this. Even a forwarder that costs nothing leaves 64ms per
tool call, because two per-tool events mean two process spawns and a spawn is 32ms here. So
trimming the event set is worth more than the language change, and it stays worth something
after the Go binary ships.

Against the forwarder's 900ms budget each invocation is comfortable. Against a working day
it is not, and the budget was the wrong thing to measure it against.

**The per-tool events are not registered, and that is permanent rather than a stopgap.**

Six events, and only six:

```
SessionStart  UserPromptSubmit  Notification  Stop  SubagentStop  SessionEnd
```

`PreToolUse` and `PostToolUse` are deliberately absent. Written here so that a later session
does not add them back as an oversight fix.

They were there for two things and neither survives contact with the numbers:

- **The activity line on a card**, showing which tool is running. The signature element
  covers this better. A live tail of the agent's real terminal output says more than
  "running Edit", it updates continuously rather than per tool call, and the runner already
  has the stream, so it costs nothing extra.
- **State detection**, which does not need them. `working` comes from `UserPromptSubmit`,
  and `Stop`, `SessionEnd` and `Notification` cover the rest of the transitions.

The one genuine loss is the live apprentice count, and it is a bad trade at roughly 40ms on
every tool call for a badge. See 4.6 for what replaces it.

### 4.6 What happens to the two fields that lose their source

Neither field survives in its current shape, because leaving a field that nothing populates
is worse than removing it.

**`activity` is removed.** It was set from `PreToolUse`'s tool name and cleared on
`PostToolUse`. Both events are gone, so the field goes with them rather than sitting on the
session state permanently null. What a card shows instead is the live output tail, which is
the signature element and a better answer to the same question.

**`subagents` changes meaning from live to completed.** It was incremented on `PreToolUse`
with tool `Task` and decremented on `SubagentStop`. Only the decrement's source event
survives, so a live count is not derivable and pretending otherwise would give a number that
only ever goes negative.

`SubagentStop` still fires and still costs nothing extra, so the field becomes
`subagentsCompleted`. It is a different fact from the one originally specified: it says this
agent delegates, not this agent currently has two apprentices running. Renaming it rather
than keeping the old name with new semantics is the point, so nobody reads the old meaning
off the new number.

**Scope: per task, reset when a task starts.** Not lifetime, not per session.

A lifetime counter is trivia. It only grows, it says nothing about now, and after a month
every card reads a large number that means nothing. A per-session counter is better but a
session spans many tasks and lasts as long as the process does, so it drifts toward the same
uselessness. Per task, the number answers a question worth asking: did this piece of work
need four apprentices or none, which is a real signal about how the task was approached and
about what it cost, since apprentice tokens are charged to the parent session and appear
nowhere else.

A monotonic counter with no reset point quietly becomes a lifetime counter, so the reset is
part of the definition rather than a detail: it zeroes when a task starts, and the value at
task completion is kept on the task record. The card shows the current task's count. The
history shows what each finished task used.

Accepted loss, recorded so it is a decision and not a regression: there is no way to show
how many apprentices are running right now. If that ever matters more than 40ms per tool
call, registering `PreToolUse` per project buys it back, and the cost is known.

---

## 5. What happens to the 53 existing tests

Current suite: 53 passing. Breakdown and fate.

| Module           | Count | Port as-is | Rewritten harness, same assertions | Obsolete | Note                                                                |
| ---------------- | ----- | ---------- | ---------------------------------- | -------- | --------------------------------------------------------------------- |
| `hook-endpoint`  | 6     | 2          | 1                                  | 3        | See the detail below. One more became obsolete when the per-tool events went. |
| `agent-env`      | 13    | 11         | 2                                  | 0        | The allowlist and PATH tests gain a per-platform variant each.          |
| `claude-locator` | 6     | 5          | 1                                  | 0        | The non-Windows test becomes a real darwin test against the platform.   |
| `trust`          | 11    | 11         | 0                                  | 0        | Pure logic. Only `pathsEqual` moves behind the interface.               |
| `pty-session`    | 17    | 15         | 2                                  | 0        | The two are the kill-tree tests, which now go through the platform.     |
| **Total**        | 53    | 44         | 6                                  | 3        |                                                                       |

Detail on the six hook endpoint tests:

- `stateFor maps events to states` ports unchanged. The mapping still handles `PreToolUse`
  even though nothing registers it, because a defensive mapping costs nothing and someone
  will eventually register it by hand.
- `rate limit notifications are not treated as waiting for input` ports unchanged.
- `events without a session id are ignored` keeps its assertion; the harness feeds events
  into `session-state` directly instead of over HTTP.
- `tracks activity, subagents and emits on state change` retired, and this one is a
  behaviour change rather than a transport change, so it is called out rather than buried.
  It asserts three things. The state-change assertions survive, moved into a new test that
  drives them from `UserPromptSubmit` and `Stop`. The activity assertions go with the
  `activity` field. The subagent assertions asserted a live count that is no longer
  derivable, and are replaced by a test of `subagentsCompleted` counting up from
  `SubagentStop`. Splitting it is what makes each surviving assertion honest about what it
  now covers.
- `rejects a wrong token and accepts a right one` retired. There is no token.
- `health endpoint responds without a token` retired. Health becomes a status call over IPC
  and gets its own test.

**When each retirement happens.** All three still pass today and that is correct rather than
an oversight: they are testing code that still exists, on a branch where it still exists. The
pty runner work and the migration are separate, and a test does not retire before the thing it
covers does.

| Test                                                | Retires in | Because                                             |
| ---------------------------------------------------- | ---------- | ---------------------------------------------------- |
| `tracks activity, subagents and emits on state change` | Task 4     | The endpoint splits and `activity` stops existing     |
| `rejects a wrong token and accepts a right one`       | Task 5     | The token file is removed with the transport swap     |
| `health endpoint responds without a token`            | Task 5     | The HTTP route goes with it                           |

Until those tasks land, all three must keep passing. A green run of them today is evidence
the migration has not started breaking things early, not evidence the accounting is stale.

Net for this module: 2 port untouched, 1 keeps its assertion with a new harness, 3 retire,
and 2 new tests replace the parts of the retired behaviour test that still mean something.

New tests the migration adds: the platform interface across three implementations, the
socket listener, hook registration, the Electron security configuration, the updater's
version floor, and the drain.

---

## 6. Electron security configuration

Named explicitly so they are decisions, and so a later contributor has to argue with a
written reason rather than flip a default.

`BrowserWindow` `webPreferences`:

```
contextIsolation: true
nodeIntegration: false
nodeIntegrationInWorker: false
nodeIntegrationInSubFrames: false
sandbox: true
webSecurity: true
allowRunningInsecureContent: false
experimentalFeatures: false
webviewTag: false
preload: <the one preload file>
```

`@electron/remote` is not a dependency and a test asserts it is absent from the lockfile.

Content Security Policy, applied as a response header from the main process rather than a
meta tag, so the renderer cannot weaken it:

```
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';
font-src 'self';
img-src 'self' data:;
connect-src 'none';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none'
```

`connect-src 'none'` is the important line. The renderer makes no network requests at all.
Everything that touches the outside world happens in main, behind IPC. `style-src` allows
inline styles because Motion animates through the style attribute; that is a real
concession and it is the only one.

Navigation and windows:

- `will-navigate` is cancelled for anything that is not the app's own entry point.
- `setWindowOpenHandler` denies every request and returns `{ action: 'deny' }`.
- External links go through `shell.openExternal`, and only after the URL parses as `https:`.
- `session.setPermissionRequestHandler` denies everything: no camera, microphone, geolocation,
  notifications through the web API, or clipboard read.

IPC:

- The preload exposes one frozen object through `contextBridge`. No `ipcRenderer` reaches
  the renderer.
- Channels are an explicit allowlist in a shared constant, and the preload refuses any name
  not in it. The list is exhaustive and reviewed, not a prefix pattern.
- Every main handler validates its arguments before acting. Hand-written guards in
  `src/domain/guards.ts` rather than a validation library, to keep the dependency count
  down; the shapes are small and the guards are tested.
- The renderer acts on ids, never on filesystem paths. It cannot name a directory to spawn
  in, only a project that already exists.
- No `ipcRenderer.send` from renderer to main for anything privileged; `invoke` only, so
  every call has a reply and a failure is visible.

---

## 7. The updater

Sequenced after the pty work, planned now because it changes the build, makes signing
mandatory and shapes the shutdown path.

### 7.1 The manifest

`electron-updater` reads `latest.yml` and `latest-mac.yml`, which `electron-builder`
generates and which have no room for a policy field. So the version floor lives in its own
file.

- Source of truth is `build/update-policy.json`, committed. Changing the floor is a reviewed
  commit, not a console action.
- CI publishes it as a release asset named `update-policy.json` alongside the installers.
- The app fetches it over HTTPS from the same release as the feed.

```json
{
  "minimumSupportedVersion": "0.4.0",
  "severity": "security",
  "notes": "Fixes an issue where a project policy could widen a tool allowlist."
}
```

### 7.2 How blocking is decided

Blocking is `semver.lt(app.getVersion(), manifest.minimumSupportedVersion)`. Nothing else.
`severity` only chooses the tone of the prompt for versions above the floor, and it can
never cause a block on its own. A trusted string is the wrong mechanism for a hard stop; a
version floor lets a release retroactively force an upgrade by bumping one number.

Failure modes, both deliberate:

- The manifest cannot be fetched, or is malformed, or the version does not parse: the app
  does not block. A network problem must never brick a machine.
- The update itself is not signed, or the signature does not verify: the app does not
  install. Fail open on blocking, fail closed on installing.

Worth naming: a compromised feed can force a block, which is a denial of service against
the machine. It cannot install code, because the artifact signature is checked separately.
That asymmetry is the reason the two failure modes point in opposite directions.

### 7.2.1 Detached signatures

Every update artifact carries a detached signature, verified against a public key compiled
into the app, in addition to OS code signing.

The two prove different things and neither substitutes for the other. OS code signing proves
the app came from Benzoo's developer identity. The detached signature proves this specific
artifact is the one he published. A compromised release host defeats the first and not the
second, and a release host is exactly the thing most likely to be compromised.

It also unblocks work. The macOS updater cannot run without Apple enrolment, but artifact
verification does not depend on Apple at all, so the update path is buildable and testable
now instead of waiting.

Mechanics:

- Ed25519 through `libsodium` or Node's built-in `crypto.verify`, which supports Ed25519 and
  keeps the dependency count at zero.
- The public key is a constant in the source, so changing it is a reviewed commit that ships
  in a signed build. Not configuration, because configuration is writable by anything running
  as Benzoo.
- The private key never enters the repository. It lives in a GitHub Actions repository
  secret, used only by the release workflow, and a copy is kept offline by Benzoo. It is
  never on a developer machine and never on the release host.
- CI signs `latest.yml`, `latest-mac.yml`, `update-policy.json` and every installer, and
  publishes each `.sig` beside its artifact.
- Key rotation is a release: a new build carries the new public key and is signed with the
  old key, so a machine on the previous version can still verify the update that changes the
  key.

On verification failure the app refuses the update, says so plainly in the UI naming the
artifact, logs it, and does not retry silently. There is no fall back to installing
unverified, and no configuration option that enables one. If a blocking update cannot be
verified, the app stays blocked and stays on the old version rather than installing
something unproven, and the message tells Benzoo to fetch the release manually.

### 7.3 Checks

- At launch, delayed 30 seconds so startup is not slowed.
- Every 4 hours, with up to 15 minutes of jitter so a fleet does not synchronise.
- On window focus if the last successful check is older than 4 hours.

A tray app started at logon rarely launches, so a launch-only check would leave a machine
stale for weeks.

### 7.4 The drain

A blocking update quits the app while agents are working. Three agents mid-task plus a hard
stop is three lost working trees, so quitting is a sequence, not an event.

1. **Close the gate.** No new task dispatch, no queued injection, no new spawns. The UI
   shows what is happening and which agents are still draining.
2. **Checkpoint every repo with a live agent.** The runner does this itself with git, on the
   agent's branch: stage everything and commit as
   `chore(wip): checkpoint before update`. Deterministic, no session cooperation, and it
   does not write into a session that is not provably idle. See section 2.1.
3. **Let idle agents finish cleanly.** An agent already idle is asked to stop and its
   session is ended normally. An agent that is working is not typed into.
4. **Wait, with two timeouts.** 45 seconds per agent, 120 seconds total. Both configurable.
5. **Kill what remains** through the platform's `killTree`.
6. **Write a drain report** to the database before quitting: per agent, whether it was
   checkpointed, whether the commit succeeded, whether it was force-killed, and the branch
   and commit id.
7. **Relaunch** and show the report on first paint, naming any tree that was committed
   mid-edit or left dirty.

**The report is written to disk before quitting, not held in memory.** The modal shows
per-repo progress and then the app quits, so everything on that screen is gone at the moment
it becomes most useful. A repo that failed on `index.lock` after three retries is exactly
what Benzoo needs to know about after the relaunch, and a blocking update that quietly loses
one working tree and tells nobody is worse than the update it was delivering.

So the report is persisted as its own row before `app.quit()` is called, not after, and not
as part of the normal shutdown path that the forced exit may cut short. It carries, per
repo: whether it was checkpointed, the short commit id if it was, the reason if it was
skipped, the error if it failed, and whether its agent was force-killed. Plus whether the
forced quit path was taken.

On next launch it is shown before anything else, and it stays available in the project's
history rather than being a toast that disappears. A skipped repo is a thing to go and look
at, which takes longer than a notification lives.

### 7.4.1 Quit is forced, not awaited

The drain finishing is not the same as the process being able to exit, and on a blocking
update the difference is visible to Benzoo at the worst moment.

node-pty leaves up to five seconds of timers per kill, and a drain that kills several
sessions stacks several of those. There are also socket workers whose disposal is
asynchronous. So after the drain reports done, the main process can still have live handles
and Electron's normal quit will wait for them. The user-visible result is an app that says
it must relaunch and then sits there, which reads as a hang precisely when he has been told
he has no choice but to wait.

**One of those five-second timers is not unref'd, measured 2026-08-09, and it intersects with
`killWithTree` in a way the drain has to expect.** node-pty's console-list agent has a five-second
fallback timeout on Windows that is not unref'd, so a pending one holds the event loop rather than
letting the process exit. `killWithTree` reaps the shell before node-pty's own kill, so on Windows
that kill always finds a dead shell, the console-list agent always crashes, and the full five-second
timeout always fires (issue 886, and the post-wiring measurement in the verification log). So every
session torn down through `killWithTree` shortly before a quit can leave a non-unref'd five-second
timer pending, and a drain that kills several stacks them. This is exactly what the forced
`app.exit(0)` below exists to cut through, so it is not a new problem, but the drain must not treat
"drain reported done" as "safe to await a natural exit": the three-second forced-exit timer is load
bearing on Windows specifically because of this. Do not try to fix it by changing the kill path; the
forced exit is the containment.

So quitting is explicit rather than natural:

- The drain reports done, and the app calls `app.quit()`.
- A 3 second timer starts at the same moment. If the process has not exited by then, it
  calls `app.exit(0)`, which skips the remaining `before-quit` and `will-quit` handling and
  terminates.
- Every pty is already killed by step 5 of the drain and every checkpoint is already
  committed by step 2, so nothing that matters is still in flight when that timer fires. The
  forced exit can only lose handles the operating system reclaims anyway.
- If the forced exit path is taken, that fact goes in the drain report, so a machine that
  needs it every time is visible rather than silently papered over.

The same forced quit applies to an ordinary quit from the tray, with the same timeout. A
tray app that takes five seconds to disappear after you tell it to close feels broken, and
the fix should not be special to the update path.

### 7.4.2 The worst case, as one number

From "blocking update detected" to "process gone": **123 seconds.**

| Stage                                             | Budget |
| -------------------------------------------------- | ------ |
| Close the gate, checkpoint every dirty repo         | inside the drain total |
| Let already-idle agents end cleanly, per agent      | 45s    |
| Drain total, whichever comes first                  | 120s   |
| Kill survivors                                      | inside the drain total |
| Force quit after the drain reports done             | 3s     |
| **Worst case**                                      | **123s** |

Two minutes with a modal window telling him he must relaunch. That is far too long to show a
spinner, and it is the single worst moment in the app to look hung, so two things follow.

**The window shows what it is waiting for, per repo, not a spinner.** A line per repo with
its own state: checkpointing, committed with the short commit id, skipped because mid-rebase,
failed on `index.lock` after three retries, or waiting on an agent with the remaining seconds
counting down. He can see that it is working, which repo is slow, and whether anything was
skipped, without waiting for the report at the other end.

**The budgets are almost certainly too generous and are configuration, not constants.** The
120s came from a draft where the drain waited on agents to commit their own work. It does not
any more: the runner does its own git checkpoints and those take seconds, so the only thing
left worth waiting for is an already-idle agent ending its session, which is the least
valuable part of the sequence. My recommendation is 30s per agent and 60s total once there is
a real measurement to set them from, which makes the worst case 63 seconds. Not changing them
on a guess, and the progress display is what makes either number survivable.

There is also a floor worth stating: the drain cannot be skipped for speed. Three agents
mid-task and a hard stop is three lost working trees, and that is the whole reason this
sequence exists.

Three cases the first draft of this missed, all raised by Benzoo and all real.

**Index lock contention.** If the agent is running a git command at that instant, the
commit fails with `index.lock`. Retry three times with a short backoff, roughly 200ms,
400ms, 800ms. If it still fails, log loudly, record it in the report, and quit anyway. A
drain that blocks forever is worse than a lost tree.

**Every repo in the project, not one.** A project holds several repos and an agent may have
touched more than one. The drain checkpoints every repo in the project with a dirty tree,
not just the one the agent last worked in.

**Repos mid-rebase, mid-merge, mid-cherry-pick or mid-bisect.** A commit in those states
does something other than what was intended: it can complete a rebase step, or land on a
detached head that a later checkout discards. Detect the state by looking for
`.git/REBASE_HEAD`, `.git/MERGE_HEAD`, `.git/CHERRY_PICK_HEAD` and `.git/BISECT_LOG`, skip
that repo entirely, and record it explicitly so Benzoo knows exactly which tree was not
saved and why.

The other ordinary failures stay ordinary: no repository, detached head, nothing to commit.
Each is recorded and none of them stops the drain. Losing the update because a commit
failed is worse than the failure.

The work-in-progress checkpoint rule from section 8 of the main plan now has a second
justification beyond rate-limit recovery, which makes it more clearly right than when it
was agreed.

### 7.5 Rollback

`electron-updater` has none. So:

- The installer for the previous version is kept under the app data directory, one back.
- The manual downgrade is documented in the README, with the exact steps per platform.
- Auto-update is disableable in configuration, because a sysadmin pinning a version on a
  work machine is a legitimate thing to want.
- The feed URL is configuration, not a constant, so a fork points at its own releases.

Without this, a bad release strands the machine it was meant to fix.

---

## 8. What cannot be verified today

Stated plainly, because the failure mode of an unverifiable path is code that looks fine
because nothing ever runs it.

**macOS hardware is deferred.** Updated 2026-08-07. macOS stays a first-class target and is
no longer gating: both platform implementations get written as planned, Windows is verified as
the work goes, and darwin is written and marked unverified.

What makes that safe rather than optimistic is that the one macOS answer which could have
forced a redesign cannot any more. The Windows named pipe turned out not to be owner-only,
which is why per-agent secrets exist, and that decision holds on both platforms regardless.
If the macOS socket file proves genuinely owner-only, per-agent secrets stay anyway. So the
Mac answer can relax something and cannot invalidate work.

Two sources of macOS signal, and they are not the same thing:

**CI on a GitHub macOS runner**, from this task onward. It covers everything in the platform
layer that is pure logic: the environment allowlist, the PATH recipe, path normalisation, case
sensitivity, and every darwin branch that does not need a real Claude Code install. That is
real coverage and it catches the class of bug that hides until hardware arrives.

**The hardware session**, still owed, covering what CI structurally cannot:

- Whether the socket file under Application Support is owner-only in practice, checked with
  `stat` and a second account rather than by assumption.
- Where the claude binary actually is, against the candidate list.
- `node-pty` under Electron on arm64 without a rebuild.
- Whether a Claude Code hook reaches the socket, and whether the trust prompt behaves the same
  way, including whether declining exits with no hook.

A green macOS CI run is not verification of the platform. A runner has no Claude Code install,
no real trust records and nothing equivalent to ConPTY to compare against. Keeping that
distinction explicit is the point of writing it here rather than assuming everyone infers it.

Unverifiable until Apple Developer enrolment completes:

- Signing, notarization and stapling.
- The macOS updater end to end, since macOS will not apply an unsigned update.
- Windows signing, separately, since that is a different certificate.

How these fail loudly instead of silently:

- **`Platform.selfCheck()` has to bite.** With hardware deferred it stops being a nicety and
  becomes the thing standing between Benzoo and code that has never run. It proves the socket
  directory has the expected mode, a claude binary was found, a probe process can be spawned
  and killed through `killTree`, and the app data directory is writable. On failure it stops
  startup and names every check it could not confirm, as a list rather than the first error,
  so the first run on the Mac produces a work list instead of a mystery. It also reports which
  platform it is on and whether that platform has ever been verified on hardware, so a passing
  self-check on darwin does not read as the platform being signed off.
- **Every unverified darwin path carries a marker in the source.**

  ```
  // UNVERIFIED(darwin): what has not been confirmed
  // See docs/stack-migration-verification.md, macOS section.
  ```

  `grep -rn "UNVERIFIED("` is the work list for the first session on the Mac. A marker is
  removed by a measurement on hardware and never by a green CI run. The convention lives in
  `docs/CONVENTIONS.md` so it survives a fresh session.
- `Platform.supported` is false for Linux, and the app refuses to run rather than doing an
  untested best effort.
- The updater ships disabled by default behind a configuration flag, and stays disabled
  until it has been exercised end to end once on each platform. That is gated on signing,
  not on hardware, so it is unchanged. A disabled updater that says so in the log is honest.
  An enabled updater nobody has watched work is not.
- CI runs the `node:test` suite on a GitHub Actions macOS runner from Task 1. Its role has
  changed for the better: it is regression protection for code that has already been proven
  on real hardware, rather than the only signal about a platform nobody has run. Cost note
  stands, since the repo is private and macOS runner minutes bill higher than Linux.

Nothing in the macOS path gets a test that passes by never being exercised.

### 8.1 How the macOS side gets the code

This needs solving before two machines touch the repo, and it is not a technical problem.

Stafford lives at `C:\Users\<user>\Git\Stafford` on the Windows machine and has no remote.
Nothing is pushed anywhere. A clone on the Mac would be a second working copy of a repo with
no shared origin, and the only ways to move work between them would be copying files by hand
or a patch file, both of which lose history and diverge quietly.

So: a private remote comes first, before any macOS work.

- Benzoo creates a private GitHub repository and pushes `main`. Pushing `main` is his, not
  mine, per the standing rule.
- The Mac clones from that remote. It is a normal working copy, not a special one.
- I push feature branches from whichever machine I am working on. Never `main`, never a
  force push.
- Each platform's verification runs on its own machine and its output is committed to the
  same verification document from that machine, so both halves live in one file with one
  history.

Until the remote exists, the macOS half of Task 0 is blocked. That is the only thing
blocking it, and it is roughly ten minutes of Benzoo's time.

Where the macOS work runs: the Mac's own clone, driven the same way as here. Nothing needs
to be shared between the two machines except the git remote.

---

## 9. Order of work

Each task ends with the suite green and a work-in-progress checkpoint commit, squashed at
the end of the task, on the feature branch for the migration.

The rule that shapes the order: nothing is deleted until its replacement passes the same
assertions. During the migration the test script runs both the old CommonJS tests and the
new TypeScript ones, so there is never a commit where the suite does not run.

**Task 0. Verification, no production code.**
Four questions, real output into `docs/stack-migration-verification.md`:

1. Does `node-pty` spawn and stream inside an Electron main process after
   `electron-rebuild`.
2. What the default named pipe security descriptor actually grants on Windows, per section
   2.2, and whether a separate process can connect to it.
3. What a standalone forwarder binary costs to cold start on Windows, in Go and in Rust,
   including the first run of a freshly written executable while Defender inspects it. The
   measurement picks the language rather than the language being picked first.
4. Whether Node 26 runs `node:test` against ESM TypeScript by type stripping, so tests need
   no build step.

Two of these are gating. If `node-pty` under Electron fails, the plan changes shape. If the
pipe default is not owner-only, I stop and bring the per-agent secret design back for a
decision rather than building it.

**Windows half: done, 2026-08-07.** All four answered, with real output in the verification
log. node-pty works in Electron and needs no rebuild, the pipe default is not owner-only and
drove the per-agent secret design, Go saves 51.6ms per hook against a 32ms spawn floor, and
type stripping works with the `.ts` extension convention. Two things fell out that were not
asked for: no compiler is needed at all, and project-level hook registration works.

**Task 0 runs on both machines, not just Windows.** The macOS half answers the same four
questions plus two that only exist there: whether the socket file under Application Support
is genuinely owner-only in practice rather than in theory, and whether the claude binary is
where the candidate list expects. Answering the socket question on both platforms is the
point, rather than settling Windows and discovering a macOS surprise at Task 5.

The macOS half needs a session running on the MacBook. It is not something the Windows side
can do remotely: it spawns processes, reads socket permissions and runs a real `claude`
binary, all of which have to happen on that machine. The remote exists, so the Mac clones
the repository and the work runs there, committing to the same verification file so
both halves share one history.
One window per platform.

**Task 1. Done, 2026-08-07. Toolchain and layout. No logic moves.**
`electron-vite` layout in place, tsconfig with the flags below, macOS CI running from this
task rather than later, and a conventions document. 63 tests pass, 59 existing ones untouched
in place plus 4 new. Type check clean. One transitional device worth knowing about:
`src/package.json` carries `{"type":"module"}` so `src/` is ESM while the root stays commonjs
for `runner/`, and it is deleted in Task 6, which is when `runner/` is genuinely empty and
the root flips. Original scope:

`electron-vite` layout, `src/main`, `src/preload`, `src/renderer`, `src/domain`. tsconfig
with `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly` and
`allowImportingTsExtensions` with `noEmit`. Test script runs the old suite and the new one.
53 tests still pass, unchanged, in place.

**One convention locked here, before there is a second file to be inconsistent with.**
Relative imports carry the `.ts` extension. Not the TypeScript habit of writing `./foo.js`
to mean `./foo.ts`, which does not resolve under Node's type stripping and fails at runtime
rather than at type-check time. Measured in Task 0, output in the verification log. It goes
in the tsconfig commentary and in the contributing notes, because a convention that has to
hold from the first file is worth writing down before the first file.
One window.

**Task 2. The platform layer.**
The interface from section 3, plus `win32`, `darwin` and `linux`. Tests for all three run on
Windows, since most of it is data and comparison rules. The three parts that are genuine
behaviour, preparing the socket, killing a process tree and `selfCheck`, are exercised on
the Mac before this task is called done. `darwin.ts` does not ship having only run on
Windows.
One window, plus a short sitting on the Mac.

**Task 3. Port Task 1's modules.** Split into 3a and 3b, since porting three modules and
deleting their originals in one commit is the largest single change in this plan and the
migration promised no commit where nothing runs. 3a ports to TypeScript alongside the
CommonJS originals, both suites green, nothing deleted, so the port is proved before anything
is destroyed and the checkpoint is reversible for free. 3b switches callers, deletes the
originals and their tests. The root flip is not here at all: it is Task 6.
`agent-env`, `claude-locator` and `trust` to TypeScript behind the platform interface.
Their 30 tests keep their assertions; two gain a macOS variant. Old CommonJS files deleted
in the same commit that proves the port. The real-machine Git Bash test survives.
One window.

**Task 4. Split the hook endpoint.**
`session-state.ts` with the four surviving tests, assertions untouched. `hook-listener.ts`
still on HTTP at this point, so nothing else breaks yet. This is the checkpoint that makes
the transport swap safe.
Half a window.

**Task 5. Swap the transport and build the forwarder binary.**
Local socket in place of HTTP. The forwarder written in Go, with its build wired into CI and
its output placed in `extraResources`. Per-project registration into
`.claude/settings.local.json`, six events, with the merge, backup, `.git/info/exclude`,
idempotence and repair rules from section 4.4. `hooks/claude-hook.js`, `hooks/install.ps1`
and `runner/server.js` deleted. Verified against a real Claude Code session, with the state
transitions shown.
One window, probably more, since it is now two things.

**Task 6. Port the pty layer, and give the modules their first real caller.**

The reference sweep during 3b turned up something worth acting on: `agent-env`, `claude-locator`
and `trust` were written, tested and never called by anything. Their first caller would otherwise
be the Electron shell in Task 7, which is five tasks of work whose interfaces are shaped by their
tests rather than by use, written by the same person who wrote the interfaces. That usually shows
up as an interface that is perfectly convenient to assert against and slightly wrong to call.

So Task 6 also wires a minimal command line harness: one entry point that locates the binary,
builds an environment, reads trust, spawns a real agent in a pty and streams it. Not a feature,
not shipped, not a substitute for the shell. It exists to prove the four modules compose, and it
gets a real caller two tasks earlier than otherwise. It is the only thing that would catch an
interface shaped by its own tests.


`pty-session` to TypeScript in the main process, kill-tree behind the platform. The
dead-process guard and the buffer rules carry over unchanged. 17 tests, two through the
platform now.
One window.

**Task 7 owes the pty layer a subscribe that replays.** Audited 2026-08-08: nothing subscribes to
session output today except the tests, so this is not a bug yet. It becomes one in Task 7.

`PtySession` emits `data` for future chunks only, and `replay()` returns what was already emitted. A
caller must combine them, and a caller that forgets sees nothing until the next byte arrives. On an
idle agent that is minutes, and it presents as a broken terminal rather than as a missed
subscription. It cost about one run in two on darwin in the test suite before `waitFor` was seeded
from `replay()`, and darwin is where it is worst, because a real pty delivers the first write sooner
than ConPTY does.

**The product's normal shape is a late subscriber**: a session that has been running a while, and a
card opened afterwards. So the fix is not to remember, it is to remove the choice. Give the session
one way to subscribe that replays first and then streams, the way `submit()` removed the
bracketed-paste mistake by making the wrong call impossible rather than documented.

**Task 7. The Electron shell.**
Main process boots, tray icon, no window at launch, login item, the security configuration
from section 6, the IPC allowlist, and a deliberately ugly window that proves IPC and
`node-pty` work together. This is the first point where the app runs.

It also produces the first packaged build, even though nothing needs installing yet, because
that is where the native modules fail and nothing before it can catch them. `asarUnpack`
entries for `node-pty` and `better-sqlite3`, then run the packaged app and spawn a pty from
it. A dev build proves nothing about this: the failure exists only once the app is inside an
asar.
One window, probably more.

### Known limitation: node-pty 1.1.0 leaks a pty master per session on darwin

Measured, not suspected, and unfixable from this codebase. Recorded here rather than as an
`UNVERIFIED` marker, because a marker means unconfirmed and this is confirmed.

```
one pty master leaked per session, darwin
kern.tty.ptmx_max: 511, system-wide rather than per-process
```

The descriptor JavaScript is handed is not the one that leaks: `fs.closeSync` on it throws `EBADF`
while `lsof` still shows the master open, because the native layer opens `/dev/ptmx` and hands JS a
different fd. `UnixTerminal.destroy()` does not close it either, so there is no teardown to call.
Raw output in the MacBook section of the verification log.

**Fixed upstream in `1.2.0-beta.4`**, `Close non-std FDs between pty_forkpty and pty_execvpe`, and
measured at zero on `1.2.0-beta.15`. **We cannot take it.** That line breaks kill and exit on
Windows: two tests that pass on 1.1.0 time out, `killing one session leaves the runner and other
sessions working` at 8.2s and `exit reports the code and leaves no live pid` at 6.2s, and the suite
then never exits. Identical with and without our own disposal, to within milliseconds, so it is not
ours. Reported on `microsoft/node-pty#850`.

**511 counts sessions since boot, not concurrent sessions.** This is the part that makes it a real
constraint rather than a generous ceiling. Every session leaks one master permanently, so the count
only goes up. A machine kept awake for days, with idle shutdown recycling agents, reaches 511 in
ordinary use rather than under load, and a developer's Mac is rarely rebooted. Read as a
concurrency limit 511 sounds like plenty; read as a lifetime total it is a few days of normal work.

And it is the whole machine's limit rather than this process's, so when it is reached Stafford takes
every other application's terminals with it, including the user's own shell.

**What this means for Task 7, stated so it cannot be read as advisory: no macOS build ships on
node-pty 1.1.0. Full stop.**

Task 7 is not permitted to choose between the upstream fix and a session cap. A cap is a workaround
for a bug, it puts an arbitrary ceiling on the product's core function to avoid a defect the vendor
has already fixed, and shipping one would mean shipping a known system-wide resource leak on a
user's machine.

**So the pin exit condition is a release gate on the macOS milestone, not housekeeping.** A stable
1.2.0 plus a Windows measurement of kill and exit is what unblocks a macOS build. Until both exist,
the macOS deliverable is blocked upstream, and that belongs on the milestone rather than in a
comment. It is the one dependency in this project that no amount of work here can clear.

Two things that do not change:

- Whether the leak is present on any future version is measured on the Mac by cycling sessions and
  counting `/dev/ptmx`, never reasoned about. The measurement exists and takes minutes.
- Windows is unaffected. This is a POSIX defect, and the Windows input-socket leak is the separate,
  handled one. Development and the Windows build carry on normally on 1.1.0.

### node-pty stays on 1.1.0, and what would move it

Moving the pin needs three things now, not two.

**A stable 1.2.0**, because no stable release carries the darwin fix.

**And a Windows measurement of kill and exit on that release.** The exit condition used to be a
version number and that is not enough any more: the beta line fixed the darwin leak and broke
Windows kill and exit, which 1.1.0 does not do, and only a run on a Windows runner found it. A
stable 1.2.0 is a reason to re-measure, not a reason to upgrade.

**And `microsoft/node-pty#886` fixed, or confirmed absent.** On Windows, node-pty forks a
console-list agent on every ConPTY kill, and that agent's `AttachConsole` throws unhandled and
crashes the forked process. Under a child-exit-monitoring test runner, which `node --test` is, that
crash can fail the run even when every assertion passed. Issue 886 is the fix, an open pull request
created 2026-02-06 and unmerged, so no release carries it including the 1.2.0 beta. So the beta does
not collapse the pin into a trade: it fixes the darwin leak, breaks Windows kill and exit, and does
not fix 886, which stays independent.

**It fires on every kill, not only when the shell happens to have exited first.** This paragraph read
"when the shell has already exited" until 2026-08-10, which described the crash as conditional. It is
not. node-pty forks the agent and then kills the ConPTY on the next line, and forking a node process
costs about 70ms against a kill that takes about 10ms, so the shell is always gone before
`AttachConsole` runs. Measured on real Windows hardware, 50 teardowns per arm: 50 crashes through
`PtySession.kill()` and 50 through `PtySession.killWithTree()`, zero successes, with an instrument
check confirming the agent does succeed against a live shell. See the dated entry `886 fires on every
Windows teardown, and it already did before killTree was wired, 2026-08-10` in
`docs/stack-migration-verification.md`.

Two consequences for how this exit condition is read. Wiring `killTree` into teardown did not create
the problem or worsen it, so nothing in Stafford's own teardown is a candidate fix. And the rate at
which a Windows CI run goes red is not the rate at which the crash happens: one green `npm test` on
this hardware produced 26 of these crashes. Confirming 886 absent therefore means running a teardown
and watching the forked agent, never inferring it from a green run.

That is the third version exit needing a measurement rather than a number, after the Windows
kill-and-exit measurement and the `spawn-helper` mode. Every time a number alone would have been
wrong.

The measurement is cheap and already written. `.github/probes/nodepty-beta-probe.js` on
a dedicated probe branch reports whether `_agent.inSocket` still exists and whether a session still
leaks; the CI suite on a throwaway branch answers kill and exit.

**The packaged build must check `spawn-helper`'s mode, not only that it was unpacked.** This is
the same class of failure as `asarUnpack` and it fails in the same place, invisibly to every
developer machine.

node-pty 1.1.0 publishes `spawn-helper` with mode 0644, so `posix_spawnp` cannot execute it and
no pty opens at all. Measured on macOS 2026-08-08; raw output in the MacBook section of the
verification log, and upstream at `microsoft/node-pty#850`. `scripts/fix-node-pty-permissions.cjs`
repairs a dev install, and **it does nothing for a packaged app**, because a user installing a
`.dmg` never runs npm. Whether electron-builder preserves the mode through asar packing and
unpacking is a separate question that has to be answered by running the packaged app, exactly like
`asarUnpack` itself.

So the Task 7 pty check is not "a pty opens from the packaged app". It is that, plus reading the
mode of the helper inside the built bundle. A packaged app shipping a 0644 helper fails for every
macOS user and reproduces on no development machine that ran `npm ci`.

Two neighbouring reports worth reading before that build rather than after it, both about the
packaged case specifically: `microsoft/node-pty#789`, `posix_spawnp` failing in a packaged Electron
app, and the `app.asar.unpacked` path rewriting in `unixTerminal.js` which does a plain string
replace and has been observed doubling the suffix. This machine is macOS 26, where a report also
exists of `posix_spawn` rejecting an over-long helper path.

**Answered ahead of the task, 2026-08-08.** A real signed bundle with `app.isPackaged` true spawns
a pty on macOS 26 arm64. No doubled suffix, no path rejection. So there is no architecture risk
here and Task 7 does not need to prove the design, only the build. What remains is the invariant:
asar carries file modes through faithfully, so every darwin `spawn-helper` in the tree must be
executable before packing, and the check on the first packaged build is reading the mode inside
the bundle. Raw output in the MacBook section of the verification log.

### Electron's binary is not installed by `npm ci`, and the build needs a step

Electron removed its `postinstall` in 42.0.0, deliberately, because postinstall scripts are a
supply-chain attack vector. The binary downloads lazily on first run of the `electron` bin, and the
package ships an `install-electron` bin for doing it explicitly. Measured 2026-08-08: 41.1.0 has
`postinstall: node install.js`; 42.0.0 and everything after has no `scripts` field at all. A fresh
`npm install electron@43.3.0` in an empty directory, with no lockfile involved, produces no
`dist/`.

**The decision is an explicit step, `npm run electron:install`, which calls the package's own
`install-electron` bin.** Three reasons, in order of weight:

1. **Not the repository's `postinstall`.** That would recreate exactly the attack surface Electron
   just removed, in a project where agents commit to the repository and the secret scan job exists
   because that is not a formality. It would also put a hundred megabyte download in front of every
   `npm ci`, including the two CI jobs that never touch Electron.
2. **Not `node node_modules/electron/install.js`.** It works, and it reaches past the package's
   public interface into a file path that is free to move. `install-electron` is the supported
   entry point and is what the release notes point at.
3. **Not pinning back to 41.x.** That is two majors of security fixes given up to regain a
   convenience, and the convenience is the postinstall that was removed for security reasons. It
   would be moving backwards on purpose.

CI needs no change today: nothing in `npm test` or `npm run typecheck` touches Electron. The job
that packages in Task 7 will need the step, and it belongs there rather than in the shared install.

Upstream: `electron/electron#49328`, and the Electron 42 release notes.

**Task 8. Storage.**
`better-sqlite3`, WAL, numbered migrations, the domain types from section 13 of the main
plan, and the repository layer. Append-only tables stay append-only.
One window.

**Task 11. The pre-publication pass. Before the repository goes public, after the migration lands.**

Stafford ships AGPL. What is committed today includes things that should not be published, and
this is one pass over all of it rather than a habit of noticing instances.

**Benzoo owns the decisions.** What counts as too personal is his call rather than a lead
developer's, and the categories below are the questions to put to him, not answers.

**The employer categories were removed from the tip on 2026-08-10, ahead of this pass**, because
they were the only ones whose subject was a third party rather than Benzoo. The employer name, the
internal project codename and what it was, his job function there, and the egress and TLS detail in
the quick start and the verification log are gone from the working tree. They remain in the history,
which is what the options below are about.

The inventory that drove it, with a coordinate per instance, is `docs/exposure-inventory.md`. **That
file arrives with its own branch and is not in the tree yet**, so the pointer is dead until that
merges. It is named here rather than left out because a reader who cannot find it should know it
exists, and a pointer that silently resolves later is better than a category list nobody can check.

What is in there today, by category rather than by instance:

- **Personal.** The plan's opening section carried health-adjacent personal information and a
  collaboration protocol addressed to an agent, neither of which belongs in a published design
  document. That section was rewritten to a short project note.
- **Identity in commit metadata.** His full legal name and an employer email address are the author
  of 64 commits. See below, because no pass over the files reaches it.
- **Machine-specific.** His Windows username in every path, and the macOS account name in two source
  files under `src/`, which a documentation-only sweep would ship.

Three outcomes per category, decided once rather than per instance: removed, generalised to a
placeholder, or kept because a contributor genuinely needs it.

**Two entries in an earlier version of this list were wrong, and are corrected rather than edited
away, because a worklist that sends someone hunting for the wrong thing costs more than a short
one.** It named a machine hostname, which appears nowhere in any commit; searched 2026-08-10 across
all 154 reachable commits, and there is none. And it said the full name appears across the
documents, which it does not: no file contains it, and the real instance is the commit author field.
The lesson is the one this project keeps relearning, that a category list written from memory is not
an inventory.

### The history is published too, and that is a separate decision

**Everything above is about the current files. Making a repository public publishes every commit
message and every diff in it.** Cleaning a file removes it from the tip and from nothing else.

So every category above also exists in history and survives the pass as written: his Windows
username in paths that were later generalised, his employer and the egress detail in the reasoning
of earlier commits and in the 2026-08-10 removal itself, and every superseded revision of the
verification logs with the raw output that made them worth keeping.

**The commit author field is the sharpest case, and it is the one that settles the option below.**
64 commits are authored under Benzoo's full legal name and an employer email address. That is
metadata on the commit object rather than content in a file, so no amount of cleaning the tree
touches it, and it attributes the repository to the company on its own even if every document were
generalised. A fresh repository seeded with the cleaned tree re-authors every commit and the problem
disappears without anyone doing anything about it. That is a concrete reason to prefer that option
rather than a preference for it.

There is a concrete instance already. On 2026-08-08 an agent's `git add -A` committed `.letta/`,
three files of conversation transcripts, and pushed it. The branch was rewritten and force-pushed
with lease, which made the old commit **unreachable rather than gone**: it stays retrievable by SHA
until GitHub's garbage collection runs, and nothing in this repository can hurry that.

**This has to be decided before the repository flips, not after.** Afterwards there is no decision
left to make. Three realistic options, and Benzoo picks:

| Option | What it costs | What it keeps |
| ------ | ------------- | ------------- |
| **Squash to one commit at publication** | The entire history: every measurement's provenance, every bisect point, every "why" that lives in a commit message rather than a document | Simple, complete, and nothing leaks that is not in the cleaned tree |
| **Keep the history and accept it is public** | Everything above is published, permanently and irrevocably, including the egress detail and the 64 commits authored under his legal name and an employer address | The full record, which is genuinely valuable and is most of how this project explains itself |
| **Publish from a fresh repository seeded with the cleaned tree** | The history stays private in the existing repository and the public one starts from nothing | Both, at the cost of two repositories and a permanent split between them |

The middle option is the one to weigh hardest and it is not the safe default it looks like. The
security-relevant category is the reason: which categories an employer's egress filter permits, and
why, is not a detail to publish, and it is written into commit messages as well as documents.

**A fourth option, rewriting history to scrub it, is rejected rather than unconsidered.** It is what
people reach for and it does not work at this scale. It would touch nearly every commit, it is
verifiable only by reading the whole rewritten history, and the thing being protected is exactly
what one missed instance exposes. Recorded here so nobody proposes it again as though it had not
been weighed. Rejected 2026-08-08.

**Benzoo leans to the fresh repository. That is a lean and not a decision**, and it belongs at the
flip rather than now, because the other two stay open until then.

If the fresh repository is chosen, one consequence has to be handled during the pass rather than
discovered after it. **The public project would start with no history at all, so anything
load-bearing that currently lives in a commit message has to be carried into the tree first.** A
good deal of the reasoning in this project is in commit messages rather than in documents: why a
fix took the shape it did, what was measured before a decision, which of two plausible causes was
ruled out and how. None of that survives a fresh repository unless the plans and the verification
logs are where it lives instead.

So the pass gains a step under that option: read the commit messages for reasoning that exists
nowhere else, and move it. That is work, and it is the kind that looks optional until the history
is gone and someone asks why a thing is the way it is.

**The machine facts are the interesting case**, because they split. "PowerShell 5.1 has no `&&`"
is useful to any contributor and generalises. The corporate certificate path under his user
profile is useful to nobody else and goes. Most of section 17 of `STAFFORD-PLAN.md` is the first
kind wearing the second kind's clothes.

**The verification logs are the hardest and get decided first**, because the answer changes how
much work the rest is. Their whole value is that they are raw output, and raw output carries
paths, hostnames and usernames. Redacting them costs the property that makes them worth having.
So the real question is whether they ship at all, and a defensible answer is that they do not,
with their conclusions folded into the plans and the raw logs kept privately.

Sequenced after the migration because scrubbing documents that are still being rewritten daily
means doing it twice.

**Task 9. The updater and the drain.**
`electron-updater`, the version floor, the check schedule, the drain sequence and the drain
report. Ships disabled by default. The drain is tested against fake agents; the update path
itself waits on signing.
One window, probably more.

Estimate: nine tasks after the verification one, so ten sittings. The optimistic read is
ten to twelve hours of window time. Applying the correction Benzoo already made once, and
which was right: call it sixteen to twenty, concentrated in Tasks 7 and 9. Progress gets
reported against that number, and if it runs over, that is what the report says.

The UI comes after Task 8 and is not planned here.

---

## 10. Files affected

Deleted:

```
runner/server.js            HTTP bootstrap, replaced by the Electron main process
hooks/install.ps1           token generation and settings snippet, replaced by the app
runner/*.js                 each one deleted only when its TypeScript port passes
.env.example                token entries removed; the file survives if anything else needs it
```

The token file at `~/.agent-dashboard/token` stops being read or written. Removing the one
on Benzoo's machine is a manual step for him, not something the app does silently.

Created, roughly:

```
electron.vite.config.ts
tsconfig.json, tsconfig.node.json, tsconfig.web.json
src/domain/                 types, guards, shared constants
src/main/index.ts           app lifecycle, tray, login item, window
src/main/security.ts        CSP, navigation, permissions, all in one place
src/main/ipc/               channel allowlist and validated handlers
src/main/platform/          types.ts, win32.ts, darwin.ts, linux.ts, index.ts
src/main/hooks/             session-state.ts, hook-listener.ts, registration.ts
src/main/agents/            agent-env.ts, claude-locator.ts, trust.ts, pty-session.ts
src/main/storage/           database.ts, migrations/
src/main/updater/           updater.ts, policy.ts, drain.ts
src/preload/index.ts        one frozen bridge object
src/renderer/               minimal until the UI plan
build/update-policy.json
docs/stack-migration-verification.md
```

`docs/plans/pty-runner.technical.md` stays as the record of why the pty layer is shaped the
way it is. Its sections 2.5, 2.5.1 and 2.5.2, the websocket, the token fragment and the
concurrent attach rules, are marked superseded rather than deleted, because the reasoning is
worth keeping and the concurrent-attach decision still applies to multiple windows.

---

## 11. Risks

**`node-pty` inside Electron.** The whole plan assumes it rebuilds and works in the main
process. Well-trodden ground, and still the first thing Task 0 measures, because everything
downstream is built on it.

**The named pipe DACL.** Section 2.2. Gating, measured in Task 0, and the token stays until
the answer is in.

**Network access to GitHub, resolved.** Two separate problems appeared here and both are
fixed, recorded because the second was mistaken for the first.

A TLS interception certificate npm did not trust, fixed by pointing `NODE_EXTRA_CA_CERTS` and
npm's `cafile` at the corporate roots. Underneath it, an egress filter resetting any request
whose path looked like a GitHub release, fixed by Benzoo having the network policy adjusted
for release downloads. Cleared rather than worked around, so
`ELECTRON_MIRROR` and `electron_use_remote_checksums` both stay unset. Full map, including the
checksum argument for anyone who reaches for a mirror later, in the verification log.

**GitHub Releases stays as the update feed.** An earlier revision of this plan moved it to
self-hosted static files on reachability grounds. Reversed, because reachability is no longer
a problem and the argument inverts anyway: a domain of Benzoo's own is likelier to be caught
by a corporate category filter than `github.com`, and self-hosting would not have fixed
anyone else's network. Security was never the deciding factor, since detached signatures mean
the host must be reachable rather than trusted.

One real constraint, for the updater task rather than now: electron-updater's GitHub provider
cannot read a private repository without a token, and a token shipped inside a distributed app
is not a token. So either Stafford is public before the updater ships or the feed moves for
that reason. That is a decision Benzoo owes before Task 9, and he is inclined toward public,
which is consistent with the AGPL choice already made.

**No compiler is needed, and `electron-rebuild` drops out of the build.** This plan and the
stack decision both listed `electron-rebuild` as new machinery because `node-pty` is native.
Measured instead of assumed: both `node-pty` 1.1.0 and `better-sqlite3` 13.0.3 load and work
inside Electron's main process untouched. There is no MSVC toolchain on this machine,
`electron-rebuild` failed for exactly that reason, and it turned out not to be needed.

The reason is Node-API, not how the prebuilds are packaged. Both build against
`node-addon-api` and export `napi_register_module_v1`, and N-API is ABI stable across Node and
Electron versions, which is why one binary serves Node 26 at ABI 147 and Electron 43 at 148.
So a contributor needs Node and Go, not Visual Studio or Xcode command line tools.

**What to monitor, since the wrong thing is easy to watch here.** Not prebuild coverage. The
N-API version each package targets against the version Electron's bundled Node provides.
`better-sqlite3` declares `NAPI_VERSION=10`, node-pty declares none and takes
`node-addon-api`'s default, and both runtimes supply N-API 10 today. A package moving ahead of
Electron breaks as a load failure at startup, which looks nothing like the dependency problem
it is.

**The compiler risk moved to packaging rather than disappearing.** Native modules load fine in
development and break when packaged, because `electron-builder` puts the app in an asar
archive and a `.node` file cannot be loaded from inside one. That needs `asarUnpack` entries
for `node-pty` and `better-sqlite3`, and the failure appears only in a packaged build and
never in dev, which is the worst shape for a build problem to have. It belongs to whichever
task first produces an installer, and it is written here next to the good news so the good
news does not read as native modules being solved.

**A hosted macOS runner cannot open a pseudo-terminal, and a Windows one can.** Measured, not
assumed: `/dev/tty` returns `ENXIO` on a macOS runner because a CI step has no controlling
terminal, and `posix_spawnp` fails for that reason. The pty tests can never pass there and are
excluded from that job explicitly, with the skipped count and the reason printed, because a
green board that silently drops the most failure-prone tests is worse than a red one. The
Windows runner opens a pty, streams through it and kills it cleanly, so the Windows suite
failure is a bug of ours and is not excluded.

The wider consequence for the plan: the pty layer has no automated coverage on macOS and never
will from CI. It is a hardware-session question, alongside the four already listed.

**gitleaks needs a version bump before it is forced.** The action still targets Node 20 and is
being run on Node 24 under protest. It works today and will stop. Bump it during whichever task
next touches CI rather than when it breaks.

**A second language toolchain enters the build.** The forwarder binary means Go or Rust in
CI and on any machine that builds from source. Go cross-compiles to every target from one
toolchain; Rust needs a target per platform. That is a real input to the language choice
alongside the startup measurement, and it is a new dependency for contributors.

Checked on the MacBook 2026-08-08: **Go is absent, and deliberately not installed.** Nothing needs
it yet, because the forwarder is Node today on purpose, so there is one transport client rather than
two that can differ, and CI builds the release binaries. It becomes a prerequisite when the
standalone binary is built, and only for a contributor changing the forwarder itself. Then: install
Go, and confirm `GOOS=windows GOARCH=amd64 go build` and the darwin and linux equivalents, which is
the same check the work PC passed at `go1.26.5`. Recorded here rather than as an open question about
that machine, so it stops being something the Mac owes.

**Type stripping and `node:test`.** If Node 26 will not run ESM TypeScript tests directly,
the suite needs a build step, which slows every task in this plan. Measured in Task 0. The
fallback is `tsx` or a `tsc` watch, both known quantities, neither free.

**Everything macOS.** Section 8. Contained by `selfChecks`, `assertStartable` and by refusing to start rather
than half working.

**That containment was not real until 2026-08-08.** `selfCheck` was specified on every platform and
executed by nothing, so the guard this risk was declared contained by had never run. It is wired now
and its absence is recorded as a finding in the verification log, because a decision justified by an
unbuilt mechanism is a failure mode rather than an incident. The consumer test exists so the next
one fails the suite instead of being found five tasks later.

**Signing.** Blocks the updater entirely on macOS and weakens it on Windows. Not technical,
and 99 USD a year plus enrolment time. Task 9 ships with the updater disabled, so it does
not block anything else.

**The drain is hard to test honestly.** Its whole point is behaviour during an abnormal
shutdown. It gets tested against fake agents with scripted states, which proves the
sequencing and the timeouts but not the real thing. The first real blocking update should be
watched, on purpose, with a repo that does not matter.

**Installer size.** Around 150 MB, per the stack decision. Accepted there, restated here so
it is not a surprise at Task 7.

**Scope creep into the UI.** Task 7 needs a window to prove IPC works. That window is
deliberately ugly and gets deleted when the real roster arrives. If it starts acquiring
Geist tokens, that is the creep, and it is visible.

---

## 12. Tests

`node:test` for main and domain. Vitest and Playwright arrive with the UI, not here.

| Area              | What is asserted                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform`        | Each implementation returns the documented allowlist, PATH recipe, candidate list and comparison rule. `pathsEqual` is case-insensitive on win32 and darwin and case-sensitive on linux. `linux.supported` is false. `selfCheck` fails loudly on a broken assumption. |
| `agent-env`       | The 13 existing assertions, now once per platform where the platform changes the answer. Secrets still never cross. The token is still refused.                          |
| `claude-locator`  | The 6 existing assertions, plus a darwin candidate order test.                                                                                                          |
| `trust`           | The 11 existing assertions, unchanged.                                                                                                                                  |
| `session-state`   | The 3 surviving hook endpoint assertions, unchanged, with no transport in the test. Plus two replacements: state moves through `UserPromptSubmit` and `Stop` without any per-tool event; `subagentsCompleted` counts up from `SubagentStop` and never decreases. No `activity` field exists on the shape. |
| `hook-listener`   | A newline-framed event is parsed and answered. An oversized payload is refused. A malformed line does not kill the listener. A stale socket file is replaced. The reported `SocketAccess` matches what the platform actually applied. The reply is the constant acknowledgement and never carries state. The concurrent connection cap rejects beyond its limit and logs each rejection. A connection that sends nothing is dropped on its timer. |
| `agent-secrets`   | Each spawned session gets a distinct secret. An event whose secret does not match the agent id it claims is dropped. An event with a valid secret for a different agent id is dropped. A missing secret is dropped. The secret never appears in a log line or an error message. |
| `registration`    | Registration writes only to a project's `.claude/settings.local.json` and never to `settings.json` or to `~/.claude/settings.json`. Only the six chosen events are written, and never `PreToolUse` or `PostToolUse`. An existing unrelated local hook survives a merge. A repair is idempotent and cannot duplicate an entry. A stale path is detected and repaired across every managed project at launch. A backup is written before the first change to a project. The path is added to `.git/info/exclude` and never to a tracked `.gitignore`. Trust records are never written. Nothing outside the `hooks` key is modified. Deregistering removes the app's entries and leaves the rest of the file intact. |
| `pty-session`     | The 17 existing assertions, with kill-tree through the platform.                                                                                                        |
| `security`        | The window is created with the exact `webPreferences` above. The CSP header matches. Navigation and window-open are denied. `@electron/remote` is absent.                |
| `ipc`             | A channel outside the allowlist is refused by the preload. Every handler rejects malformed arguments. No handler accepts a filesystem path from the renderer.            |
| `updater/policy`  | Below the floor blocks. At or above it does not. A severity of "security" above the floor does not block. A missing, malformed or unparseable manifest does not block. |
| `updater/signature` | A valid detached signature verifies. A tampered artifact fails. A signature from the wrong key fails. A missing signature fails. Every failure refuses the update and none falls back to installing. A blocked app with an unverifiable update stays blocked and stays on the old version. |
| `hook-binary`     | The forwarder sends only the six permitted fields. Tool inputs never appear in what it sends. It exits 0 when the runner is absent, when the payload is malformed, and when the socket hangs. Its measured cold start stays under the recorded budget. |
| `updater/drain`   | The gate closes first. Every dirty repo in the project is checkpointed, not only the last one worked in. An `index.lock` failure retries with backoff and then gives up rather than hanging. A repo mid-rebase, mid-merge, mid-cherry-pick or mid-bisect is skipped and named in the report. A failing commit is recorded and does not stop the drain. Per-agent and total timeouts fire. Survivors are killed. The report names every agent and every outcome. |
| `updater/quit`    | Quit is called when the drain reports done. A process still alive after the 3 second timeout is force exited. Taking the forced path is recorded in the report. The same timeout applies to an ordinary tray quit. |
| `updater/report`  | The report is written before quit is called, not after. It survives a forced exit. It carries the commit id for every checkpointed repo, the reason for every skipped one, and the error for every failed one. It is shown on next launch and remains in history afterwards. |

Definition of done per task: the suite runs, reports a non-zero test count, and passes, with
real output shown. Anything skipped is stated first, not last.

---

## 13. Decisions taken

Answered by Benzoo on 2026-08-06, recorded so a fresh session does not reopen them.

1. The drain does its own git checkpoint rather than asking agents to. Section 2.1.
   Approved, with index lock retries, all repos in the project, and rebase or merge states
   skipped and named.
2. Per-agent secrets replace the shared token, plus a constant acknowledgement on the socket
   and a concurrent connection cap. Section 2.2. Approved after the Task 0 measurement showed
   the pipe default is not owner-only.
3. Hooks run through a standalone compiled binary the app ships, rather than requiring Node
   or booting Electron. Section 4.3. Approved, written in Go, decided on cross-compilation
   rather than on startup time.
7. Registration is per managed project, in `.claude/settings.local.json`, never global and
   never in a committed file. Section 4.4. Approved, and verified before being built on.
8. Six events are registered, permanently. `PreToolUse` and `PostToolUse` are never
   registered. Section 4.5. Approved.
9. `activity` is removed from the session state and `subagents` becomes
   `subagentsCompleted`. Section 4.6. Approved, since a field nothing populates is worse
   than no field.
10. No Defender exclusion for the forwarder binary. An auto-updating executable is exactly
    what should be scanned, and since an empty binary costs the same 32ms, most of that is
    process creation rather than repeated scanning, so the exclusion would buy little for a
    real cost.
11. Quit is forced with a 3 second timeout once the drain reports done, rather than waiting
    for handles to clear. Section 7.4.1. Approved.
4. macOS CI from Task 1. Approved.
5. State derivation is split from transport so the four surviving hook endpoint tests can
   never be forced to change by a transport decision again. Section 4.1. Approved.
6. Detached Ed25519 signatures on every update artifact, verified against a key compiled
   into the app, in addition to OS code signing. Section 7.2.1. Approved.
