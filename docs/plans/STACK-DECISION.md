# Stack decision

Supersedes section 6 of `docs/plans/STAFFORD-PLAN.md`. Written 2026-08-06 after Benzoo
asked for a ground-up reassessment, with rewriting explicitly on the table.

Read this before section 6. Where the two disagree, this wins.

---

## 1. The assumption that was wrong

The original stack put the UI in a browser, served over HTTP from the runner, with a
websocket for the terminal stream.

Every security control in the pty-runner plan exists because of that single choice:

- An `Origin` check, because websockets ignore the same-origin policy, so any page Benzoo
  visits could otherwise drive his agents.
- A `Host` check, because Origin alone does not stop DNS rebinding.
- A token in a URL fragment, because an endpoint that serves the token hands it to
  anything that can fetch the page, and an agent working in Stafford has WebFetch.
- An auth frame with a two second timeout on every socket.

All of that is competent work against a threat model created by the transport. Remove the
browser and the entire class disappears. There is no port to reach, no page to fetch, no
socket to hijack, and no token to leak, because the UI and the runner are the same process
talking over IPC.

That is the change. Everything else follows from it.

---

## 2. The stack

### Shell: Electron

Not a browser. Not Tauri.

Electron, and Tauri was reconsidered properly rather than dismissed. The comparison is
close and Tauri wins three real points, so the reasoning is recorded here so nobody
relitigates it from a worse starting position.

Where Tauri is better:

- `portable-pty` from the wezterm project is mature and its ConPTY handling is arguably
  better than node-pty's. An earlier draft of this document claimed Tauri traded a solved
  problem for an unsolved one. That was wrong.
- The hook process. A hook fires on every `PreToolUse` in every Claude Code session on the
  machine, including Benzoo's own. A Rust binary starts in single-digit milliseconds where
  an Electron binary running as Node does not. See the note below on how this is solved
  without adopting Tauri.
- Its updater signs the update artifact with its own keypair, independent of OS code
  signing. Also adopted below.
- Bundle size and memory, which do not matter for a single-user local tool.

Where Electron is better, and these are the two that match the brief:

- One rendering engine. Tauri uses the system webview: Chromium on Windows, WKWebView on
  macOS. The brief asks for a beautiful, animated interface, which means Motion
  transitions, Geist typography and xterm.js rendering identically on both platforms. Two
  engines means Safari quirks, different font rendering, different animation performance,
  and testing every visual decision twice. Electron ships one Chromium.
- This application is architecturally VS Code's integrated terminal plus a dashboard.
  Electron with `node-pty` and `@xterm/xterm` is precisely that stack, proven at enormous
  scale for a decade. The brief asks for mature, and following the proven path for a
  pty-based desktop app is what mature means here. Claude Desktop is also Electron, which
  matters because its update behaviour is the reference.

A third, quieter cost of Tauri: with Rust in the backend the domain model cannot be one
shared TypeScript package. The types would be duplicated or generated, and drift would land
in exactly the definitions types exist to protect: `toolCeiling` intersecting rather than
widening, the state union, project ids versus repo paths.

So the runtime stays TypeScript. `node-pty` runs in the main process, `better-sqlite3`
beside it, the renderer is React.

Two Tauri ideas are adopted rather than dismissed:

**A standalone hook binary.** The hook forwarder is a small separate binary, a few hundred
KB of Go or Rust, not the Electron binary running as Node. It starts in milliseconds, needs
no Node installed on a user's machine, and removes the latency tax that would otherwise
apply to every tool call in every Claude Code session on the machine. Measure the startup
cost and record it.

**Detached signatures on update artifacts.** Every update artifact carries a detached
signature verified against a public key pinned in the app, in addition to OS code signing.
This makes the update channel verifiable before Apple Developer enrolment completes, and it
means a compromised release host is not automatically a compromised machine. See the
auto-update section.

Electron also gives Benzoo exactly the behaviour he asked for and the web version fakes:

- Starts at logon with no window, via `app.setLoginItemSettings`, not a Task Scheduler
  entry wrapping a headless server.
- Lives in the tray. Click to open, close to hide, process keeps running.
- Real OS notifications. This solves a problem flagged early and never fixed: a badge in a
  browser tab does not reach him when the window is behind something, and he is usually
  nearby but not watching.
- A window he controls, with no browser chrome, which is a precondition for the interface
  looking the way he wants.

Electron's own security rules are not optional and are much simpler than defending an HTTP
server: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a strict CSP,
no `remote` module, and an explicit IPC channel allowlist. The renderer gets no filesystem
and no child process access. Everything privileged happens in main, behind named IPC
handlers that validate their arguments.

Cost, stated plainly: an installer around 150 MB, and `electron-rebuild` in the build
because `node-pty` is native. That machinery is needed for `node-pty` regardless of shell.

### Language: TypeScript, strict, everywhere

`strict: true`, `noUncheckedIndexedAccess: true`. The domain model in section 13 of the
plan is already written as TypeScript types and was then thrown away, which is backwards.
The invariants that are easy to break silently are exactly the ones types catch: a
`toolCeiling` that unions instead of intersects, an `AgentState` that grows a case nobody
handles, a `projectId` passed where a repo path belongs.

One shared `src/domain/` package imported by main and renderer, so there is one definition
of a hire and one definition of a policy.

ESM throughout. Not CommonJS, which would leave the repo on two module systems.

### Transport for hooks: a local socket, not TCP

Claude Code hooks are separate processes, so they need a way in. Today that is HTTP on
127.0.0.1:4271 with a shared token.

Replace it with a local socket. Node's `net.createServer` handles both platforms through
the same call and only the path convention differs:

- Windows: a named pipe at `\\.\pipe\stafford`, access controlled by the pipe ACL.
- macOS: a socket file under `~/Library/Application Support/Stafford/`, directory mode
  0700. Not `$TMPDIR`, which gets cleaned out from under a long-running app.

What this buys:

- No TCP listener at all, so nothing to port-scan and nothing to reach from off the
  machine.
- No Hyper-V reserved port range problem, which cost time already.
- OS-level access control. Authentication is the operating system's job rather than a
  shared secret in a file.
- The `AGENT_DASHBOARD_TOKEN` file stops existing.

What it does not buy: an agent running as Benzoo can still write to the pipe and claim to
be a different agent. That is unchanged, and the fix is the same as before, per-agent
secrets injected into each spawned environment. Named pipes remove the remote and
cross-user surface, not the same-user one.

The state derivation in `hook-endpoint.ts` does not change at all. Only the socket it
listens on.

### Storage: SQLite via better-sqlite3

Not JSON files. Two concrete problems with files that the original plan underspecified:
two processes writing state with last-write-wins loses data, and channel history kept
forever turns "show me this agent's history" into a scan of everything.

`better-sqlite3` rather than `node:sqlite` because Electron bundles its own Node and
`node:sqlite` is still a release candidate, while `better-sqlite3` is the mature choice. WAL
mode. Migrations as numbered SQL files, applied on startup, never automatic schema inference.

**Correction, 2026-08-09: the original reason cited `electron-rebuild` being in the build,
and it is not any more.** Task 7b.2 set `npmRebuild: false`, so the packaging never rebuilds a
native module, and the Windows CI runner has no Visual Studio, so a from-source rebuild is not
even available there. `better-sqlite3` survives that change on its own merits rather than the
rebuild's: version 13 is Node-API through `node-addon-api`, and it bundles an ABI-independent
prebuilt binary per platform-arch in its npm tarball, `prebuilds/darwin-arm64.node`,
`prebuilds/win32-x64.node` and the rest, loaded by platform and arch alone with no Node or
Electron ABI tag. So it needs no rebuild, ships under `npmRebuild: false`, and the decision
stands on the corrected reason. Full evidence in the verification log.

Schema mirrors section 13 of the plan: hires, projects, policies, tasks, approvals,
policy log, channel messages. The append-only tables stay append-only.

### UI: React, Vite, Tailwind, Geist, Radix, Motion

- `electron-vite` for the build. Fast renderer HMR, main process rebuild on change.
- React with Vite. No Next, because a live terminal and a live board are entirely client
  state and SSR buys nothing.
- Tailwind with the Geist colour scales as tokens, and the `geist` package for Geist Sans
  and Geist Mono.
- Radix primitives for anything with keyboard and focus semantics: dialog, tabs, tooltip,
  dropdown, context menu. Not shadcn/ui, because that carries its own visual identity and
  the brief is Geist, not shadcn defaults. Radix ships behaviour and no opinions, which is
  what is wanted underneath a specific look.
- Motion (formerly Framer Motion) for animation. See section 3.
- `@xterm/xterm` with the canvas or WebGL addon for the terminal view.
- Zustand for renderer state. React context with `useReducer` was the earlier call and it
  is wrong here: a live event stream fanning out to a roster, a terminal, a channel and a
  board will re-render everything through context. Zustand is small, has no provider
  ceremony, and lets a card subscribe to one hire.

### Tests

- `node:test` for main process and domain logic, which is what already exists and works.
- Vitest with React Testing Library for the renderer.
- Playwright's Electron support for end to end: launch the app, spawn a real agent, type,
  assert output arrived. This is how the five things step 3 has to prove get tested
  automatically instead of by hand.

---

## 3. Cross-platform: Windows and macOS

Both are first-class targets. Benzoo's work machine is Windows 11 and he has a MacBook Pro
M5 on the way, so macOS is testable natively on arm64 rather than only in CI. Design the
platform layer for three so Linux is cheap later; ship and test two.

Everything platform-specific lives in one `src/main/platform/` module with a single
interface and per-OS implementations. No scattered `process.platform` checks in feature
code.

Four genuine forks:

**The IPC socket path and its access control.** Covered above. One `net` API, two path
conventions, two access-control mechanisms.

**The agent environment.** The Task 1 allowlist is entirely Windows: `SystemRoot`,
`COMSPEC`, `PATHEXT`, `APPDATA`, `LOCALAPPDATA`. macOS wants `HOME`, `USER`, `SHELL`,
`TMPDIR`, `LANG`, `LC_ALL`. PATH is rebuilt rather than inherited on both, from
`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin` and
`~/.local/bin` on macOS.

Note the inversion: locating Git Bash is a Windows-only problem and it disappears on
macOS, where a POSIX shell is always present. The claude-hud status line and the plugin
hook that fail under ConPTY work natively there.

**Locating the Claude Code binary.** `%USERPROFILE%\.local\bin\claude.exe` on Windows.
On macOS, `~/.local/bin/claude`, then `/usr/local/bin/claude`, then Homebrew's prefix, then
PATH. Config override wins on both.

**Process cleanup.** `taskkill /PID <pid> /T /F` on Windows. On macOS, SIGKILL to the
process group. The dead-pty crash found in Task 0 is a ConPTY quirk, but the guard that
makes write, resize and kill no-ops after exit is correct on both.

Paths shared across platforms: `~/.claude/`, `~/.claude.json` and the agent definitions all
sit under `os.homedir()` on both. Trust record reading has to normalise path separators and
case per platform, which the existing `trust` module already does for Windows.

### Signing and distribution

The one genuinely new cost, and it is not technical.

An unsigned Electron app on macOS is stopped by Gatekeeper, and unsigned installers on
Windows trigger SmartScreen. Signing and notarizing needs an Apple Developer account at
99 USD a year.

Apple Developer signing is deferred, not required for the updater to function. Under the
settled click-and-notify strategy the updater works with no Apple involvement: Windows
auto-updates, and macOS checks the feed, prompts, and the user does a guided download plus a
one-time Open Anyway. Apple signing adds only the silent in-place macOS swap, which removes
the drag-and-Open-Anyway step. See the auto-update section below.

`electron-builder` produces both targets. Building and notarizing a macOS artifact requires
macOS, so either his MacBook or a GitHub Actions macOS runner.

### Auto-update

Three tiers, Benzoo's requirement. The app checks in the background and either offers a
relaunch or blocks.

`electron-updater` with GitHub Releases as the feed, plus a detached signature over every
artifact verified against a public key pinned in the app. These are two different mechanisms,
and only the second gates the click-and-notify updater. The detached Ed25519 signature proves
the artifact is the one Benzoo published, and it works today with no Apple dependency, so it is
what the update path relies on for integrity now. OS code signing proves the app came from his
Apple developer identity, and it waits on enrolment, but the updater does not need it to check
the feed, prompt, and guide an install. It is the mature choice, it covers Windows NSIS and
macOS Squirrel, and it is already in the `electron-builder` ecosystem the build uses.

**Apple signing is deferred, and the updater works without it.** macOS will not apply an
unsigned update silently in place, so the Apple Developer account at 99 USD a year is what the
silent macOS swap needs, not what the updater needs to function. Without it macOS still checks
the feed, prompts, and guides the user through a download and a one-time Open Anyway, which is
the settled strategy. Update integrity does not depend on Apple at all: every artifact carries
the detached Ed25519 signature above, verified against the pinned key, so the app never
installs an artifact it cannot verify on either platform. That is what stops an unsigned or
tampered update, and it is in place now.

State the threat plainly, because it is the largest one in the project. Stafford runs as
Benzoo, spawns processes, and has full disk access on a machine holding corporate and
client repositories. An update channel is remote code execution by design. Signed
artifacts and HTTPS-only feed metadata are the floor, not hardening.

**Blocking is decided by version comparison, never by a label.** The update manifest
carries `minimumSupportedVersion`. If the running version is below it, the app blocks and
the prompt cannot be dismissed. A `severity` field only chooses the tone of the prompt for
everything above that line.

A trusted string is the wrong mechanism for a hard stop, and a version floor means a
release can retroactively force an upgrade by bumping one number.

Behaviour per tier:

- Minor: a dismissible prompt offering relaunch. Work continues. Dismissing it means asked
  again on the next check, not silenced.
- Major and security: the window is forced open, the prompt cannot be dismissed, and no new
  work can start.

**A blocking update drains before it quits.** Three agents mid-task plus a hard stop equals
three lost working trees. So blocking means: refuse new task dispatch, instruct every
running agent to commit its work in progress, wait with a timeout, then quit and relaunch.
The WIP checkpoint commit rule now has a second justification beyond rate-limit recovery.

Two more requirements:

- Check at launch and on an interval of a few hours. A tray-resident app started at logon
  rarely launches, so a launch-only check would leave it stale for weeks.
- `electron-updater` has no rollback. Keep the previous installer and document the manual
  downgrade, or a bad release strands the machine it was meant to fix.

The feed URL is configuration, not a constant, so a fork can point at its own releases.
Auto-update is disableable, because a sysadmin pinning a version on a work machine is a
legitimate thing to want.

### The sync hazard generalises

macOS has OneDrive's twin. iCloud Drive with Desktop and Documents sync enabled does the
same damage to a git repo: racing concurrent writes, a partially uploaded `.git`, restoring
files an agent deleted. The rule is not a Windows quirk. Never point an agent at a repo
inside any cloud-synced tree, on any platform.

---

## 4. Beautiful and animated, specifically

Vague intent produces generic output, so this is a token system and a list of named
moments rather than an adjective.

### Tokens

Take colour values from the Geist scales at vercel.com/geist rather than hardcoding
guesses. Page background is the darkest neutral step, near black and not pure black.
Surfaces sit one step above. Borders are 1px hairlines at low contrast. Geist's look comes
from hairlines and spacing, never from shadows.

Accent (Geist blue) appears in three places only: focus rings, the single primary action
in a view, and links. Semantic hues carry state and nothing else: green working, amber
waiting on him, red crashed or rate limited, neutral idle.

Geist Sans for chrome. Geist Mono for the terminal, session ids, paths, branch names,
elapsed times, and any number that lines up in a column. Two weights only, regular and
medium. Sentence case everywhere.

### The signature

Each hire's card carries a live one-line tail of its real terminal output, in Geist Mono,
updating as it works.

A card showing a status pill is a table row in costume. A card showing the last thing that
agent actually did makes the roster feel like a room with people working in it. The runner
already has the stream, so it costs nothing, and it is the one thing the board should be
remembered by.

### Named animation moments

Nothing animates unless it carries information.

- Roster entry: cards fade and rise 8px with a 30ms stagger, once, on first paint. It
  reads as a team assembling rather than a grid appearing.
- State change: the state pill cross-fades and the card's left edge shifts colour over
  180ms. No pulsing, no glow.
- Needs input: the amber edge breathes at roughly 2s, and only while that state holds.
  This is the one place a looping animation is justified, because it has to catch his eye
  from across a desk. It stops the instant he opens the card.
- The live output tail: new text slides up one line height, 120ms, with the old line
  fading. This is the app's heartbeat and it should be the most alive thing on screen.
- Opening an agent: the card expands into the detail view with a shared layout transition
  on the name, so the identity is visibly continuous rather than the card being replaced.
  Motion's layout animation does this in a few lines.
- Terminal attach: the terminal fades in over 100ms after the buffer has replayed, never
  before, so the first thing he sees is a finished screen rather than a repaint.
- Hiring: the generated name types itself in over about 400ms, once. The name is the whole
  point of the interaction and it should feel like meeting someone.
- Task moving between stages on the board: layout transition, 200ms, easing out.

Everything above respects `prefers-reduced-motion` by collapsing to an opacity change or
nothing at all. Durations live in one tokens file, not scattered through components.

### Quality floor

Visible keyboard focus on every interactive element. Full keyboard navigation of the
roster. Every label flexes for a longer French translation, with i18n wiring from the
first commit even while the UI ships in English. Nothing is conveyed by colour alone, so
every state has a text label beside its hue.

---

## 5. What survives from work already done

Task 1 survives entirely. `agent-env`, `claude-locator`, `trust` and `classifyExit` are
pure logic over injected dependencies, which is why they port to TypeScript and Electron's
main process without redesign. The real-machine Git Bash test survives too, and it earned
its place: it found a per-user install under `AppData\Local\Programs\Git` that a
well-known-paths resolver would have missed.

`hook-endpoint` survives. Its state derivation, the rate-limit distinction, the exit
classification table and its tests are all transport-independent. Only the listener
changes.

`claude-hook.js` survives with one change: write to the named pipe instead of posting HTTP,
and drop the token.

`pty-session` survives as a design and moves into the main process.

Discarded, and this is the point of doing it now: `terminal-server`, the websocket, the
Origin and Host checks, the auth frame, the token fragment scheme and the proof page.
That is Task 4, which has not been written. Catching this before Task 4 rather than after
is most of the reason the change is cheap.

---

## 6. What this costs

Honest accounting.

Rewriting: the three Task 1 modules convert to TypeScript, roughly an hour. The project
restructures into `electron-vite` layout, half a day. The hook transport swaps from HTTP to
a named pipe, an hour including the forwarder.

Not rewriting: Task 1's logic, all of `hook-endpoint`, the verification findings, the
entire design in `STAFFORD-PLAN.md` sections 1 through 5 and 7 through 21.

New machinery: Electron's security configuration. This originally also named `electron-rebuild`
for `node-pty` and `better-sqlite3`; that was removed in Task 7b.2, because both modules are
Node-API and ship prebuilds, so no rebuild is needed. See the storage correction above.

Revised estimate for a daily-usable app, the old steps 3 through 6: three to four weekends
rather than two to three. The extra weekend buys a real desktop application instead of a
localhost page, and removes an entire category of security work that would otherwise
recur every time a surface is added.

---

## 7. One thing to record for later, not to build

Claude Code writes session transcripts to disk as JSONL. If that holds, it is the route to
a native conversation view: structured messages, read from a file, with no terminal
parsing and no violation of the rule that state never comes from terminal output.

That is how the agent detail view eventually looks like part of Stafford rather than like
somebody else's terminal embedded in it. Verify the location and format before relying on
it, and do not build it before the terminal view works.

---

## 8. Decisions this locks

1. Electron desktop app, tray-resident, starts at logon. Not a browser page.
2. TypeScript strict, ESM, one shared domain package.
3. A local socket for hooks, named pipe on Windows and a socket file on macOS. No TCP
   listener. No shared token file.
8. Windows and macOS are both first-class. All platform differences live in one module.
9. Auto-update through electron-updater, three tiers, blocking decided by a
   `minimumSupportedVersion` floor rather than a severity label. A blocking update drains
   running agents before quitting.
10. Update integrity rests on the detached Ed25519 signature, which is in place now and needs
    no Apple account. Apple code signing and notarization are deferred: they gate the silent
    in-place macOS swap and smooth Gatekeeper and SmartScreen, not the click-and-notify updater,
    which works without them. An unverified update channel on a machine like this is the largest
    risk in the project, and the Ed25519 signature is what closes it.
4. SQLite via better-sqlite3, WAL, numbered migrations.
5. React, Vite, Tailwind, Geist tokens, Radix primitives, Motion, Zustand, xterm.js.
6. node:test for main, Vitest for renderer, Playwright Electron for end to end.
7. Animation is a fixed list of named moments with tokenised durations, all reducible.