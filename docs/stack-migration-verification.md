# Stack migration verification log

Real output from verification runs on Benzoo's machine. Recorded rather than summarised.

Companion to `docs/plans/stack-migration.technical.md`.

**Note, 2026-08-10: run pre-publication acceptance searches against the integration tip, never against
the branch that did the cleaning.** A cleaning branch passed every acceptance search while the tip
still failed them all, because the branch was verified but never merged and was then deleted, so the
tip never received the work. A seed reads the tip, not the branch, so it would have carried the
uncleaned tree. This reconcile brought the verified commits onto a fresh branch off the tip and
re-ran acceptance there.

---

## Task 0, Windows half, 2026-08-06

Four questions. Two answered, one answered with a result that stops the plan, one blocked
by the machine's network before it could run.

| Question                                    | Status                                                        |
| ------------------------------------------- | -------------------------------------------------------------- |
| Named pipe default permissions               | Answered. **Not owner-only. Gating, see below.**                 |
| Node 26 type stripping with `node:test`      | Answered. Works, with one constraint.                            |
| Forwarder binary cold start                  | Answered. Go saves 51.6ms per hook; the rest is the spawn floor. |
| `node-pty` inside Electron                   | Not run. npm cannot install Electron on this network.            |

---

### Question 1. What does the default named pipe security descriptor grant?

**Not owner-only. This is the gating result.**

A pipe was created exactly the way the runner would create one, through
`net.createServer().listen('\\\\.\\pipe\\stafford-probe')`, with no security options,
because Node exposes none.

The pipe exists:

```
--- pipe listed? ---
stafford-probe
```

`Get-Acl` cannot read it (`Method failed with unexpected error code 87`), so the descriptor
was read through .NET by connecting and calling `GetAccessControl`:

```
connect: OK (same user)
SDDL: O:S-1-5-21-<domain>-<rid>G:DU
      D:(A;;FR;;;WD)(A;;FR;;;AN)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;S-1-5-21-<domain>-<rid>)
--- rules ---
Tout le monde                                 Allow  Read, Synchronize
AUTORITE NT\ANONYMOUS LOGON                   Allow  Read, Synchronize
AUTORITE NT\Système                           Allow  2032127
BUILTIN\Administrateurs                       Allow  2032127
<HOST>\<user>                                 Allow  2032127
```

Reading that:

- `WD` is Everyone, granted `FR`, which is `FILE_GENERIC_READ`. Read data, no write data.
- `AN` is ANONYMOUS LOGON, the same.
- `SY`, `BA` and the owner get `FA`, `FILE_ALL_ACCESS`, the 2032127 in the numeric column.

So the default is not owner-only. Any local account, and nominally anonymous logon, can open
the pipe and read from it. They cannot write to it, because `FR` does not include
`FILE_WRITE_DATA`.

What that means concretely:

- **Forgery by another user: no.** They cannot write, so they cannot inject hook events.
- **Reading whatever the server writes back: yes.** Today that is the constant
  `{"ok":true}`. If anything stateful ever travels back on that socket, it is readable by
  any local account.
- **Nuisance connections: yes.** Another account can connect repeatedly and consume pipe
  instances.
- **Forgery by an agent: unchanged and still open.** Agents run as Benzoo, whose SID has
  `FILE_ALL_ACCESS`. The descriptor does nothing about the same-user case, which is exactly
  the case Stafford creates. Per-agent secrets remain necessary and are now clearly the only
  mechanism that addresses it.

The transport itself works. A separate process connecting, sending one line of JSON and
reading the acknowledgement:

```
connected in 1ms
reply: {"ok":true} after 3ms
```

Server side:

```
listening on \\.\pipe\stafford-probe
SERVER GOT: {"event":"SessionStart","sessionId":"probe-1"}
```

3ms round trip, against roughly 100ms for the current HTTP forwarder end to end.

Per the standing instruction, work stops here and the per-agent secret design goes back to
Benzoo for a decision rather than being built.

---

### Question 2. Does Node 26 run node:test against ESM TypeScript with no build step?

**Yes.**

A typed ESM module and its test, run directly:

```
v26.0.0
✔ type stripping runs an ESM TypeScript test with no build step (0.4794ms)
✔ imported types are erased and do not reach the runtime (0.1006ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

One constraint, and it shapes the tsconfig. Relative imports must carry the `.ts`
extension. The TypeScript convention of importing `./greet.js` to mean `./greet.ts` does not
resolve:

```
✖ failing tests:
test at js-specifier.test.ts:1:1
✖ js-specifier.test.ts (113.0873ms)
  'test failed'
```

So the tsconfig needs `allowImportingTsExtensions`, which in turn requires `noEmit`. That is
fine here, because `electron-vite` does the bundling and `tsc` is only used for type
checking. It also has to be a project-wide convention from the first file, since mixing the
two import styles fails at runtime rather than at type-check time.

---

### Question 3. What does a standalone forwarder binary cost to cold start?

**Answered. Go saves 51.6ms per hook, not the ~85 the "single-digit startup" assumption
implied, because most of what remains is Windows process creation and no language changes
that.**

Go 1.26.5 installed via winget. An earlier note in this document said the install had failed;
it had not, it was still in the MSI's `InstallFinalize` step when it was checked. That note
is now wrong and this replaces it.

Cross-compilation confirmed from this machine, which is the reason Go was chosen:

```
go version go1.26.5 windows/amd64
darwin/amd64
darwin/arm64
linux/amd64
windows/amd64
```

The probe is a real forwarder, not an empty binary: it reads the payload from stdin, keeps
only the permitted fields, connects to the pipe, writes one line, reads the acknowledgement
and exits 0. It has no third-party dependencies, because a Windows named pipe opens through
`os.OpenFile` and does not need `github.com/Microsoft/go-winio`. An empty `go.mod` on a
binary that runs on every tool call is worth having.

```
module staffordhook

go 1.26.5
```

Sizes: 2,172,416 bytes for `windows/amd64` and 2,077,650 for `darwin/arm64`, both with
`-ldflags="-s -w"`. The stack decision says "a few hundred KB"; the real figure is about
2 MB, because Go links a runtime. It does not change anything, but the document should not
carry a number that is off by 5x.

### The measurement

Interleaved, one run of each candidate per round, 25 rounds. The first pass measured each
candidate in its own block and drifted between runs, so the medians moved with background
load. Interleaving shares the drift across all three, and the numbers came out stable.

```
Interleaved, 25 rounds, one run of each per round.

  node (current hook)    min   81.2  median   91.2  p90  112.3  max  139.3
  go (forwarder)         min   31.7  median   39.7  p90   46.6  max   52.7
  go (does nothing)      min   26.8  median   32.0  p90   40.2  max   55.5

  spawn floor (empty binary)     32.0 ms
  go work above the floor         7.7 ms
  saved per hook by go           51.6 ms
```

**The finding is the floor.** A Go binary that does nothing at all costs 32ms on this
machine. That is Windows process creation plus Defender's real-time scan on every launch,
and it is irreducible by any forwarder in any language. The forwarder's own work, JSON in,
pipe round trip, JSON out, is 7.7ms, which is the single-digit number the stack decision was
reaching for. It is correct about the program and wrong about the cost, because the process
dominates.

So per tool call, with `PreToolUse` and `PostToolUse` both registered:

| Configuration                         | Cost per tool call |
| ------------------------------------- | ------------------ |
| Today, Node forwarder                 | about 182ms        |
| Go forwarder                          | about 79ms         |
| A hypothetical forwarder that is free | about 64ms         |

Even a perfect forwarder costs 64ms per tool call while two per-tool events are registered.
That makes trimming the registered event set worth more than the language change, and it is
the stronger of the two reasons for section 4.5 of the plan.

### Cold start on a freshly written binary

Measured separately, because a binary that has just been written to disk is scanned before
it runs, and that is the number nobody measures. Each sample builds to a path that has never
existed, so Defender treats it as new:

```
cold  go (fresh build)   min  318.5  median  342.4  max  377.5  (ms, 5 fresh binaries)
```

342ms, roughly ten times the warm cost. This is paid once, on the first hook after an
install or an update, not per call. Worth knowing so that a slow first tool call after an
update is recognised rather than investigated.

### The baseline this replaces

The first pass, sequential rather than interleaved, using the real Node forwarder as Claude
Code invokes it:

```
node.exe (baseline)    min   88.2  median  100.9  max  130.4  (ms, 15 runs)
```

**This number is worse than the first write-up of it said, and the correction is the point.**

Measuring it against the 900ms forwarder budget was measuring it against the wrong thing.
Three facts together:

- The 100ms is almost entirely Node process startup, so it is paid whether the runner is
  running or not. A stopped Stafford does not make it cheaper.
- `PreToolUse` and `PostToolUse` are both registered, so a single tool call pays it twice.
- Hooks are synchronous from Claude Code's point of view, so the cost is additive to the
  tool call rather than hidden behind it.

That is roughly 200ms added to every tool call in every Claude Code session on this machine
today, including Benzoo's own work that has nothing to do with Stafford, and currently for
no benefit at all because the runner is not running.

Each invocation is comfortably inside its stated budget. The aggregate is not comfortable at
all. Consequences are in section 4.5 of the migration plan: registration is trimmed to four
session-level events until the compiled forwarder ships, and goes to all eight after.

---

### Question 4. Does node-pty work inside an Electron main process?

**Yes, and it needs no rebuild at all.**

The block described below was cleared by Benzoo having the network policy adjusted for release
downloads. Cleared rather than worked around:
`ELECTRON_MIRROR` stays unset and `electron_use_remote_checksums` stays unset. The checksum
reasoning is kept below anyway, because someone will reach for a mirror later and should find
the argument rather than rediscover it.

Electron 43.3.0 installed, binary downloaded, and the probe run headless with no
`BrowserWindow`, since the question is about a native module in the main process:

```
electron  43.3.0
node      24.18.1
chrome    150.0.7871.212
modules   148  (the ABI node-pty must match)

PASS  node-pty loads in main                version 1.1.0
PASS  pty spawns                            pid 34380
PASS  output streams                        "[?9001h[?1004h[?25l[2J[m[HREADY\r\n"
PASS  input reaches the process
PASS  resize reaches the terminal           CSI 8 ; rows ; cols t
PASS  kill ends the process                 exit code -1073741510

6 of 6 checks passed
```

Exit code -1073741510 is `STATUS_CONTROL_C_EXIT`, which is the ordinary result of killing a
console process.

#### electron-rebuild is not needed for node-pty, and could not have run anyway

`npx electron-rebuild -f -w node-pty` failed:

```
at VisualStudioFinder.fail (.../node-gyp/lib/find-visualstudio.js:118:11)
✖ Rebuild Failed
node-gyp failed to rebuild '.../node_modules/node-pty'
```

There is no MSVC toolchain on this machine. That turned out not to matter for node-pty,
because it does not need rebuilding: Node 26 reports ABI 147 and Electron 43 reports 148, and
the same binary works in both.

**The reason is Node-API, not how the prebuilds are packaged.** A first draft of this section
attributed it to the prebuild directories having no ABI in the path, which is a symptom rather
than a cause. Checked properly:

```
=== node-pty ===
deps       {"node-addon-api":"^7.1.0"}
=== better-sqlite3 ===
deps       {"node-addon-api":"^8.0.0"}

=== napi symbols in the compiled binaries ===
node_modules/node-pty/prebuilds/win32-x64/pty.node        N-API (napi_register_module_v1 present)
node_modules/better-sqlite3/prebuilds/win32-x64.node      N-API (napi_register_module_v1 present)
```

Both build against `node-addon-api` and both export `napi_register_module_v1`. A non-N-API
binary compiled for ABI 147 would not load in a runtime at 148, and these do, which is the
practical confirmation.

Versions, since this is what to monitor rather than prebuild coverage:

```
node-pty        (no NAPI_VERSION declared, builds against node-addon-api's default)
better-sqlite3  NAPI_VERSION=10

system node   26.0.0    napi 10
electron node 24.18.1   napi 10
```

**So the thing to watch is the N-API version each package targets against the N-API version
Electron's bundled Node provides.** If a package moves to a level newer than Electron supplies,
its prebuild stops loading. That surfaces as a load failure at startup, not as a compile
failure, so it looks nothing like the problem it actually is.

So the stack decision's line that `electron-rebuild` is needed in the build because node-pty
is native is wrong for node-pty. That made the other native dependency worth checking in the
same sitting rather than discovering it at Task 8, because a machine with no compiler cannot
build anything that lacks a matching prebuild.

`better-sqlite3` 13.0.3 installs with no compiler and ships the same shape of prebuild:

```
prebuilds/
  darwin-arm64.node  darwin-x64.node  linux-arm64.node  linuxmusl-arm64.node
  linuxmusl-x64.node  linux-x64.node   win32-arm64.node  win32-x64.node
```

And it works in Electron's main process untouched:

```
PASS  better-sqlite3 in electron main, select returned 42
```

**So `electron-rebuild` is not needed at all, and no compiler is needed to build this
project.** Both native dependencies ship N-API prebuilds covering both targets. That removes
a build step, a dependency, and the toolchain requirement the stack decision listed as new
machinery. It also means a contributor needs Node and Go, not Visual Studio or Xcode command
line tools.

Two conditions rather than one, and neither is "they keep shipping prebuilds".

**The N-API level has to stay within what Electron's Node provides.** Both are at 10 today and
both runtimes supply 10. A package moving ahead of Electron breaks as a load failure at
startup.

**The compiler risk did not disappear, it moved to packaging.** Native modules load fine in
development and break when packaged, because electron-builder puts the app in an asar archive
and a `.node` file cannot be loaded from inside one. That needs `asarUnpack` entries for
node-pty and better-sqlite3, and the failure appears only in a packaged build, never in dev.
Nothing measured here touches that, because nothing here was packaged. It belongs to the task
that builds the installer and it is written into the plan next to this finding, so the good
news does not read as native modules being a solved problem.

#### One false negative worth recording

The first run of this probe failed four of six checks with no output at all. The cause was
the probe, not node-pty: it spawned Electron's own binary with `ELECTRON_RUN_AS_NODE=1` as
the pty child, which produced a live process and a silent terminal. Swapping the child to the
system `node.exe` turned four failures into four passes with nothing else changed.

Incidental support for a decision already taken on other grounds: the hook forwarder is a Go
binary rather than Electron running as Node, and Electron running as Node inside a
pseudo-terminal apparently does not produce output at all.

---

### The block that was cleared, kept for the reasoning

**This was the state before the exclusions were added.**

The certificate fix worked. `NODE_EXTRA_CA_CERTS` and npm's `cafile` both point at the
corporate roots, the registry resolves, and the install completed:

```
added 44 packages, and audited 45 packages in 4s
found 0 vulnerabilities

electron 43.3.0
@electron/rebuild 4.2.0
node-pty 1.1.0
```

Electron's binary did not download. `node_modules/electron/dist` does not exist and there is
no `path.txt`. Running the postinstall by hand gives only:

```
TypeError: fetch failed
```

Unwrapping the cause chain shows it is not a certificate problem at all:

```
OK   200  https://registry.npmjs.org/electron
FAIL       <the Electron release asset URL>
             TypeError <- ECONNRESET
OK   404  <a neighbouring host on the same CDN>
```

**Something on this network reset connections to release-download URLs specifically.** It was
mapped at the time by testing neighbouring endpoints, and the shape of the result is the part
worth keeping: ordinary API and page requests to the same hosts succeeded while anything whose
path looked like a release download was reset. So the filtering was on the request path rather
than on the host, which means a TLS-inspecting middlebox reading paths rather than a DNS or
host-level block. No proxy was configured in the environment and the machine reported direct
access, so the inspection was transparent.

**The specific endpoint map is deliberately not recorded here.** It describes one organisation's
egress filter rather than anything about this project, and which requests a particular network
permits is that network's business. What a future reader needs is the inference above and the
conclusion below, both of which stand without it.

Git itself is unaffected:

```
<commit>	refs/heads/<feature-branch>
<commit>	refs/heads/<feature-branch>
<commit>	refs/heads/main
```

#### Why this looked bigger than the install, and why it no longer is

At the time this meant the auto-updater could not work on the machine it is primarily for,
since it is planned on GitHub Releases and release assets were exactly what was blocked. The
conclusion drawn then was to move the feed to self-hosted static files.

**Reversed on 2026-08-07, by Benzoo, and recorded here so nobody re-plans self-hosting from
the earlier note.** GitHub Releases stays as the update feed. Three reasons, and the first is
the weakest:

- Reachability, which was the original argument, is no longer a problem.
- The argument inverts. A domain of Benzoo's own is more likely to be caught by a corporate
  category filter than `github.com`, which is usually allowed on developer machines.
- Self-hosting would not have fixed anyone else's network, so it traded zero-maintenance
  hosting for a benefit that does not exist.

Security was never the reason either way. Detached signatures anchor trust in the key compiled
into the app, so the host has to be reachable rather than trusted. That is what makes the host
choice low stakes and reversible.

Two things stand unchanged: the feed URL is configuration rather than a constant, and every
artifact carries a detached Ed25519 signature verified against a pinned key in addition to OS
code signing.

#### Two constraints on the feed, for the updater task rather than now

**A private repository needs a token, and a token in a distributed app is not a token.**
electron-updater's GitHub provider cannot read releases from a private repo without
credentials, and anything shipped inside the application is readable by anyone who has the
application. So either Stafford is public before the updater ships, or the feed moves for that
reason rather than for reachability. Benzoo owes a decision here before the updater task, and
he is inclined toward public, which is consistent with the AGPL choice already made.

**Unauthenticated GitHub API calls are rate limited per IP.** Several users behind one
corporate NAT, all checking on an interval, can exhaust it between them. Not a problem at one
user, and worth knowing before it presents as a mystery outage rather than a quota.

#### On the Electron binary specifically

`ELECTRON_MIRROR` would work, and unusually it can be made safe rather than merely
convenient. Electron's installer verifies the download against `checksums.json` shipped
inside the npm package:

```
checksums:
  process.env.electron_use_remote_checksums || process.env.npm_config_electron_use_remote_checksums
    ? ...
    : require('./checksums.json'),
```

75 entries, one per artifact. So the bytes arrive from an untrusted mirror and are checked
against a hash that arrived through the registry. That is the same trust model as any
package manager with pinned hashes, and `electron_use_remote_checksums` must stay unset, or
the mirror supplies both the file and its hash and the check becomes theatre.

Not doing this unasked. Downloading a 100 MB runtime from a third-party mirror onto a
corporate machine is Benzoo's call even when the integrity story is sound, and the better fix
is the egress policy he controls.

`npm install electron @electron/rebuild node-pty` failed:

```
npm error code SELF_SIGNED_CERT_IN_CHAIN
npm error errno SELF_SIGNED_CERT_IN_CHAIN
npm error request to https://registry.npmjs.org/@electron%2frebuild failed,
  reason: self-signed certificate in certificate chain
```

Configuration on this machine:

```
registry    https://registry.npmjs.org/
cafile      null
proxy       null
https-proxy null
strict-ssl  true
NODE_EXTRA_CA_CERTS  (empty)
```

This is corporate TLS interception: something between the machine and npm is re-signing
connections with a certificate npm does not trust. `node-pty` installed successfully earlier
in the session, so it is not a blanket failure, but `@electron/rebuild` fails reproducibly
and so does `npm view` on the same package.

Two things follow. Electron cannot be installed until this is fixed, which blocks Task 1 as
well as this question. And Electron's postinstall downloads a large binary from a second
host, so that will need the same treatment.

The fix is to point npm at the corporate root certificate:

```
npm config set cafile "<path to the network root CA in PEM form>"
```

or set `NODE_EXTRA_CA_CERTS` to the same file, which also covers Electron's downloader and
anything else Node fetches.

The wrong fix, named so nobody reaches for it: `npm config set strict-ssl false`, or
`NODE_TLS_REJECT_UNAUTHORIZED=0`. That turns off certificate validation for every package
this project ever installs, on a machine with repository write access, and it converts a
supply-chain risk into a supply-chain certainty. Not doing that, and not recommending it.

Benzoo is the sysadmin, so he will have the root certificate to hand.

---

### Question 5. Does Claude Code run hooks from a project's settings.local.json?

**Yes, additively, with no approval prompt.**

A `.claude/settings.local.json` was written into the Stafford repo declaring `SessionStart`
and `UserPromptSubmit` hooks pointing at a probe script. The probe is a separate file, not a
patch to the registered forwarder, because the registered one is a machine-wide dependency.

The project hook fired:

```json
{"at":"2026-08-06T15:08:46.403Z","source":"project-settings-local","event":"SessionStart",
 "sessionId":"<session-id>","cwd":"C:\\Users\\<user>\\Git\\Stafford",
 "staffordAgentId":"proj-hook-test"}
```

It also carried `STAFFORD_AGENT_ID`, so per-project registration and the agent id binding
work together.

Additive rather than replacing, proved by counting. The global `settings.json` holds eight
hook commands:

```
SessionStart        1
UserPromptSubmit    1
PreToolUse          1
PostToolUse         1
Notification        1
Stop                1
SubagentStop        1
SessionEnd          1
----------------------------
global hook commands8
```

The project file added two. Claude Code's own status line inside the session reported:

```
1 CLAUDE.md | 2 MCPs | 10 hooks
```

Eight plus two. Project-level hooks stack on top of global ones rather than overriding them.

No approval prompt appeared, and the session started normally: `SessionStart` fired 1.8
seconds after spawn, the same as a session with no project hooks at all. Searching the
session's rendered output for approval or trust wording found nothing but that status line.

The probe file was removed from the repo immediately afterwards. It pointed at a script in a
session scratchpad, so leaving it would have fired a broken hook in every later session.

---

## CI, first run, 2026-08-07

Both test jobs failed. Diagnosed from logs rather than theory, and the answer is different on
each platform, which is why a single explanation kept not fitting.

### What failed

macOS ran all 87 tests: 71 pass, 15 fail. It did not die during setup. `npm ci` and
`npm run typecheck` both passed, and 25 seconds is just a fast runner.

Windows ran 70 of 87: 69 pass, 1 fail, and the one failure is the `pty-session` file as a unit
rather than any assertion. Three of its nineteen tests reported before the child died with no
diagnostic beyond `'test failed'`.

Two of the macOS failures are worth more than the rest:

```
✖ findGitBash falls back to git.exe on the parent PATH
  AssertionError: Expected values to be strictly equal

✖ PATH is used when the user profile has nothing
  Error: Claude Code executable not found. Checked:
```

Both are in the CommonJS `agent-env` and `claude-locator`, which use `path.join` and split PATH
on `;`, so they follow the host rather than the target. That is the same bug fixed in the
platform layer a day earlier, still sitting in the modules Task 3 replaces. The macOS job found
it independently on its first run. It is not fixed in CommonJS: it goes away with the files in
Task 3a, pinned by a new test that asserts both platforms give the same answers through the
platform layer rather than through whatever host the suite happens to run on.

### The pty question, asked properly

The remaining thirteen macOS failures and the whole Windows file failure are the pty tests. The
useful question is not why they fail but whether a pty can exist on a hosted runner at all,
because a bug in our code and an environment with no pty call for opposite responses.

A probe, `.github/probes/pty-probe.js`: open one pty, print whether it worked, always exit 0 so
the log is the answer rather than the exit status.

**macOS: a pty cannot be opened.**

```
platform                          darwin arm64
node                              v26.7.0
release                           25.5.0
stdout.isTTY                      false
stdin.isTTY                       false
TERM                              (unset)
/dev/tty                          NOT openable: ENXIO, no controlling terminal

loads                             yes, version 1.1.0
spawn                             THREW: posix_spawnp failed.

VERDICT: a pty cannot be opened on this runner. The pty tests can never pass here.
```

`ENXIO` on `/dev/tty` is the direct answer: a CI step has no controlling terminal, and
`posix_spawnp` fails for that reason. No fix applies. The pty tests are excluded from the macOS
job explicitly, with the count and the reason reported, because a green board that silently
skips the thing most likely to break is worse than a red one.

**Windows: a pty works perfectly.**

```
platform                          win32 x64
node                              v26.7.0
release                           10.0.26100
stdout.isTTY                      false
stdin.isTTY                       false
TERM                              (unset)

loads                             yes, version 1.1.0
spawn                             succeeded, pid 1108
data received                     yes, the child wrote through the pty
bytes seen                        102
child exit                        {"exitCode":0}
kill                              no throw

VERDICT: a pty works on this runner. The suite failure is our bug, not the environment.
```

So the two failures had one theory and needed two. The Windows suite failure is ours to fix and
is not excluded from CI.

Local control, on the machine where the suite passes 87 of 87:

```
platform                          win32 x64
node                              v26.0.0
stdout.isTTY                      false
spawn                             succeeded, pid 63728
data received                     yes, the child wrote through the pty
VERDICT: a pty works on this runner.
```

`stdout.isTTY` is false locally too, so it is not the discriminator anyone would reach for
first.

### gitleaks

Passing in 10 seconds, and it did scan rather than exiting clean on an empty scope:

```
Uploaded bytes 6764
Artifact gitleaks-results.sarif.zip successfully finalized
✅ No leaks detected
```

One warning to act on before it becomes forced:

```
Node.js 20 is deprecated. The following actions target Node.js 20 but are being
forced to run on Node.js 24: gitleaks/gitleaks-action@v2
```

---

## Task 0, macOS half

Superseded 2026-08-08. The remote exists and the Mac has cloned it. See the MacBook Pro M5
section at the end of this file, which is the first real macOS hardware this project has run on.

---

## Hook events observed end to end, 2026-08-07

A real Claude Code session in an already-trusted project, through a probe hook that logs the raw
payload before forwarding, into a listener applying the real rules. The probe is a separate
script rather than a patch to the shipped forwarder, which is a machine-wide dependency.

### What arrived

```
SessionStart -> UserPromptSubmit -> SubagentStop -> Stop -> SubagentStop

[  2182ms] SessionStart
[197464ms] UserPromptSubmit
[209133ms] SubagentStop
[214389ms] Stop
[216775ms] SubagentStop
```

Four of the six, with the correct field shape, correct agent id, validated secret and nothing
rejected. `UserPromptSubmit` is the one the working state depends on and it is now proven.

**Unobserved: `Notification` and `SessionEnd`.** Not passed, not inferred. `Notification` needs a
real permission prompt and none occurred. `SessionEnd` did not fire because the session was
killed rather than exiting cleanly, since the `/exit` text was consumed as a prompt rather than a
command. Both remain unproven.

### Two findings worth more than the events

**SessionStart is not the same as ready for input.** The prompt was written 2.2 seconds after
`SessionStart` arrived and did not reach the session. It sat unsubmitted for over three minutes
and only went through when a later write landed, which is why `UserPromptSubmit` shows at
197464ms rather than a few seconds in.

The plan's readiness gate refuses input until `SessionStart` is seen. That is necessary and this
run says it is not sufficient: input written immediately after `SessionStart` can be silently
swallowed by a TUI that has not finished starting. Nothing is lost loudly, which is the same
shape as the trust prompt problem. This needs an answer before the runner writes queued work into
a session, and it does not have one yet.

**`SubagentStop` can arrive after `Stop`.** The last event came 2.4 seconds after the session had
already reported idle.

State derivation is unaffected, because `SubagentStop` carries no state meaning and leaves the
state alone, so an agent does not flip back to working. The counter is affected: a
`subagentsCompleted` that resets when a task starts will attribute that late increment to the
next task rather than the one that spawned it. Small, real, and worth knowing before the counter
appears on a card.

### Raw payload keys, per event

```
SessionStart      cwd, hook_event_name, model, session_id, source, transcript_path
UserPromptSubmit  cwd, hook_event_name, permission_mode, prompt, prompt_id, session_id, transcript_path
SubagentStop      agent_id, agent_transcript_path, agent_type, background_tasks, cwd, effort,
                  hook_event_name, last_assistant_message, permission_mode, prompt_id,
                  session_crons, session_id, stop_hook_active, transcript_path
Stop              background_tasks, cwd, effort, hook_event_name, last_assistant_message,
                  permission_mode, prompt_id, session_crons, session_id, stop_hook_active,
                  transcript_path
```

This is the rule about never forwarding payload bodies doing real work rather than being a
principle. `UserPromptSubmit` carries `prompt`, the user's actual text. `Stop` and `SubagentStop`
carry `last_assistant_message`. None of it crosses the wire, and none of it would have been
noticed if the forwarder copied fields it did not need.

### stopHookActive, resolved

It exists: `Stop` and `SubagentStop` both carry `stop_hook_active`. The old forwarder copied it
and nothing ever consumed it. The rewritten forwarder does not, and that stays: the field tells a
`Stop` hook whether it is running because a previous `Stop` hook continued the session, which
matters only to a hook that blocks or continues. This one does neither, always exits 0, and never
influences the session.

Checked rather than assumed, and recorded so the next person does not have to ask again.

---

## The swallowed prompt: not a readiness gap, 2026-08-07

The earlier finding was that `SessionStart` arrived, a prompt written 2.2 seconds later was
silently swallowed, and the gate was therefore necessary but not sufficient. Two candidate
readiness signals were measured rather than one being picked. Both were the wrong question.

### Signal A, write and confirm

Write, wait for `UserPromptSubmit` as the receipt, rewrite if it does not arrive.

```
run 1  sessionStart   2653ms  writes 1  confirmed   4660ms  submissions 1
run 2  sessionStart   2366ms  writes 1  confirmed   4259ms  submissions 1
run 3  sessionStart   3481ms  writes 1  confirmed   5914ms  submissions 1

confirmed 3/3, duplicate submissions in 0 run(s)
```

### Signal B, the TUI's own readiness marker

```
run 1  sessionStart   1794ms  marker manual-mode   2547ms  writes 1  confirmed   3712ms  submissions 1
run 2  sessionStart   1953ms  marker manual-mode   2685ms  writes 1  confirmed   3629ms  submissions 1
run 3  sessionStart   2233ms  marker manual-mode   2416ms  writes 1  confirmed   3959ms  submissions 1

confirmed 3/3, duplicate submissions in 0 run(s)
```

Both worked every time. Neither reproduced the failure, which meant the failure was not about
timing, so the next step was to reproduce it rather than to choose between two fixes for
something that was not broken.

### Reproducing it

The prompt that was swallowed was 140 characters. The probes used `say ok`. Rerunning signal A
with the original long prompt:

```
run 1  sessionStart   2043ms  writes 4  confirmed   nullms  submissions 0
run 2  sessionStart   2061ms  writes 4  confirmed   nullms  submissions 0

confirmed 0/2, duplicate submissions in 0 run(s)
```

**Never accepted, after four attempts.** So retrying does not rescue it and no readiness signal
would have helped. It is not a timing problem at all.

### The cause

A single chunk ending in a carriage return is treated as a paste, so the Enter becomes part of
the pasted text rather than a submission. The session shows `\u001b[?2004h`, bracketed paste
mode, from startup.

Writing the text and the Enter as two writes, 400ms apart, with everything else unchanged:

```
run 1  sessionStart   1794ms  writes 2  confirmed   6942ms  submissions 1
run 2  sessionStart   2083ms  writes 2  confirmed   7365ms  submissions 1

confirmed 2/2, duplicate submissions in 0 run(s)
```

### What this means for the design

**The threshold, for findability rather than as a rule.** `say ok` submitted every time. The 140 character prompt never did. The exact boundary was not measured and is not the point; what makes this findable if it returns in another form is the shape of the observation, that short prompts worked and long ones did not.

**Input is written as text, then a separate submit.** Never one chunk ending in a carriage
return. That is the actual fix and it is a line of code rather than a new signal.

**The `SessionStart` gate stands and needs no supplement.** With split writes it was sufficient
in every run measured. The gate is about the trust prompt, which remains a real hazard, and this
was never the same problem.

**Write and confirm stays, as the receipt rather than as the fix.** `UserPromptSubmit` is
evidence the session accepted the input, and without it a lost task is silent. Duplicate
submission was measured rather than assumed: across nine runs including two where the retry
fired, no run produced more than one submission.

**Signal B is rejected.** It reads terminal output to decide behaviour, and having measured it,
it buys about a second and answers a question that turned out not to be the problem. The rule
against reading output stays intact rather than being eroded for no gain.

---

## MacBook Pro M5, 2026-08-08

Benzoo's personal machine. The first real macOS hardware in this project's history: every macOS
claim before this section came from a hosted runner or from reading the code.

One section per machine, so no finding is attributed to the wrong one. The others are the primary
Windows machine and the CI runners.

### Environment

```
node       v24.16.0
npm        11.13.0
git        2.54.0
go         absent, command not found
claude     /Users/<user>/.local/bin/claude
xcode      /Library/Developer/CommandLineTools, present
sw_vers    macOS 26.5.2, build 25F84
uname -m   arm64
```

**Node is 24 here and 26 on both CI and the work PC.** Above the 23 floor, so type stripping works
and nothing is blocked. It is recorded because it is a third variable: any darwin-only behaviour in
this section could be Node 24 rather than darwin, and the two must not be conflated. Deliberately
not upgraded mid-diagnosis.

`go` is absent and blocks nothing today. Only the forwarder task needs it.

### The clone is not in iCloud Drive

The hazard from the work PC is OneDrive; the macOS equivalent is Desktop and Documents sync. The
repository is at `~/Documents/Git/Stafford`, which looks like exactly that case and is not.

Four probes, all negative:

```
~/Library/Mobile Documents/com~apple~CloudDocs/    contains neither Desktop nor Documents
kMDItemIsUbiquitous on a repo file                 (null)
mount                                              no fileprovider mount over the path
xattr on repo files                                none
```

One contradicting signal, recorded rather than dropped. `MobileMeAccounts.plist` carries:

```
Name = CLOUDDESKTOP;
ServiceID = "com.apple.Dataclass.CloudDesktop";
status = active;
```

That is account-side provisioning. The filesystem is the authority here and says the sync is not
redirecting `~/Documents`. No move needed. Anyone rechecking this should trust the four filesystem
probes over the plist.

### A pty opens with no controlling terminal

This is the question that matters, because Stafford ships as an Electron main process started from
Login Items and never has a controlling terminal. The easy case is a terminal; the production case
is no terminal at all.

```
controlling terminal /dev/tty: FAIL ENXIO
spawn-helper mode: 755
pty.spawn: OK pid 66225
child exitCode: 0
child output: "hello-from-pty"
```

Real pty, real child, real output, no controlling terminal. **The macOS design works as drawn.**

This retires the rule that a pty opens if and only if a controlling terminal exists. That rule held
on a hosted macOS runner only because both readings were false together there.

### node-pty 1.1.0 ships a spawn-helper macOS cannot execute

The first attempt at the above failed, and the failure signature is identical to the hosted runner:

```
/dev/tty: FAIL ENXIO ENXIO: no such device or address, open '/dev/tty'
pty.spawn: THREW Error posix_spawnp failed.
    at new UnixTerminal (node_modules/node-pty/lib/unixTerminal.js:92:24)
```

Under a real controlling terminal it still failed, which is what separated the two causes:

```
AssertionError: this host has a controlling terminal but a pty would not open,
so the skip would hide a real failure
```

Cause:

```
-rw-r--r--@ 1 benzoo staff 50480 node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
```

`unixTerminal.js:29` builds `helperPath` from the loaded native module's directory and hands it to
`posix_spawnp`, which needs the execute bit. `chmod +x` and the same spawn returns `OK pid 58062`.
That was the only cause.

**Not Gatekeeper.** The only extended attribute on the helper, on `pty.node` and on the x64 twin is
`com.apple.provenance`. No `com.apple.quarantine` anywhere under `node_modules/node-pty`.

**Not npm's extraction.** The published artifact carries the mode:

```
-rw-r--r--  0 0  0  50480  package/prebuilds/darwin-arm64/spawn-helper
-rw-r--r--  0 0  0   9248  package/prebuilds/darwin-x64/spawn-helper
```

A plain `tar -xzf` outside npm reproduces `-rw-r--r--`.

**Why nobody reports it.** `lib/utils.js`:

```js
// Check build, debug, and then prebuilds.
var dirs = ['build/Release', 'build/Debug', "prebuilds/" + process.platform + "-" + process.arch];
```

Anyone compiling from source gets an executable helper from node-gyp in `build/Release` and never
reaches the packaged one. Darwin prebuilds are new in 1.1.0. Neither `scripts/prebuild.js` nor
`scripts/post-install.js` contains a chmod.

**Upstream has already fixed it**, on the beta line only:

```
-rwxr-xr-x  0 0  0  50480  package/prebuilds/darwin-arm64/spawn-helper   (1.2.0-beta.15)
```

`npm view node-pty version` is `1.1.0`, so there is no stable release to move to.
`scripts/fix-node-pty-permissions.cjs` repairs it after install and carries the removal condition.
Both darwin arches are handled, since an Intel Mac hits the identical bug.

**This affects every macOS user, not only CI.** It also is not covered by that script in the one
place that reaches users: electron-builder packaging. See the note added to Task 7.

### The fourteen real-pty tests, run on darwin for the first time

With the helper executable, running the file directly rather than through the test runner:

```
    pty tests: 14 declared, 0 skipped. controlling terminal: false, pty opens: true.
```

Twelve pass. Two fail, and both are real findings rather than a broken checkout.

```
✖ node-pty still exposes the internals the leak fix reaches through (21.747625ms)
✖ a real resize reaches the terminal (8050.929666ms)
```

The first is expected and is a Windows-only assertion running on darwin for the first time. It
asserts `probe._agent`, and:

```
ctor: UnixTerminal
_agent: undefined
own fields: _pid, _fd, _cols, _rows, ... _socket, _writeStream, _pty, _file, _name
```

`_agent` and `inSocket` are ConPTY concepts. `windowsPtyAgent.js` has no darwin counterpart.

The second is unexplained. It timed out at the 8000ms `waitFor` deadline, so the resize did not
reach the child within that window. Not yet attributed.

### The darwin disposal path does nothing, and masters leak

`PtySession.#releaseInputSocket` reaches `term._agent.inSocket`. On darwin `_agent` is `undefined`,
so it returns at the guard and does nothing. The Windows fix does not apply here.

The obvious repair does not apply either. node-pty destroys the read side itself on darwin:

```
_socket.destroyed      = true
_writeStream.destroyed = undefined
```

`_socket` is a `ReadStream` over the master fd. `_writeStream` is a `CustomWriteStream` with own
properties `_fd,_encoding,_writeQueue`, no `destroy` method, and it holds the same descriptor. So
the darwin answer is not the Windows one with a field renamed.

The leak is real and it is per session. After the fourteen tests, the process had not exited, and:

```
11u  CHR  /dev/ptmx
12u  CHR  /dev/ptmx
13u  CHR  /dev/ttys003
16u  CHR  /dev/ptmx
17u  CHR  /dev/ptmx
20u  CHR  /dev/ptmx
...
ptmx fds held: 28
```

Twenty-eight open pty masters. Those descriptors keep the libuv loop alive, so the test file
completes every test and then never exits. `sample` on the stuck process shows the main thread idle
in `uv_run` and `uv__io_poll`, with no JavaScript running.

**A correction worth recording, because it nearly became the conclusion.** An earlier reading of
this called a surviving `PipeWrap` the leak. It was not: fds 1 and 2 are the process's own piped
stdout and stderr, and a pending timer in the probe was what kept that process alive.
`process.getActiveResourcesInfo()` naming a `PipeWrap` is not evidence of a leak on its own. `lsof`
on the descriptor is.

### Reconciliation could not read its own counts from a terminal

Running the suite under a real pty, every count read as unknown and the run failed with every test
passing:

```
  ran            unknown
  skipped        unknown
  RECONCILIATION FAILED: could not read the test count from the run, so nothing was reconciled
```

The cause is not carriage returns, though a pty produces those too. It is colour:

```
0000000  033   [   3   4   m   ℹ  **  **       t   e   s   t   s       1
0000020    3   5 033   [   3   9   m  \r  \n
```

The summary matcher is anchored at column zero and the line starts with an escape byte. npm exports
`FORCE_COLOR` to its lifecycle scripts when its own stdout is a tty, so `node --test` colours its
output into the pipe even though the pipe is not a terminal.

This is the configuration a person uses and the one CI does not, which is why it survived. Fixed by
stripping control sequences and carriage returns before matching. After the fix, under a pty:

```
  declared       135
  ran            135
  skipped        28
```

### Suite as found, before any of the above

For the record, quoted rather than restated:

```
    pty tests: 14 declared, 14 skipped. controlling terminal: false, pty opens: false.
ℹ tests 135
ℹ pass 107
ℹ fail 0
ℹ skipped 28
  declared       135
  ran            135
  skipped        28
```

Green, reconciled, and hiding the fact that no pty had ever opened on this machine.

### A packaged Electron app can spawn a pty on macOS 26, and the mode is the only risk

The whole macOS design rests on an Electron main process spawning ptys, and every measurement
before this one was a development tree, which is not the shape users get. Three separate reports
existed against the packaged case: the `app.asar.unpacked` path substitution doubling its suffix,
the helper's mode inside a built bundle, and macOS 26 rejecting an over-long helper path. This
machine is macOS 26 on Apple Silicon, so the question was answerable here and nowhere else.

A real bundle was built rather than a dev tree: `Electron.app` copied, `default_app.asar` removed,
the probe packed into `app.asar` with `node-pty` unpacked exactly as `asarUnpack` would produce,
the executable renamed and `CFBundleExecutable` updated so `app.isPackaged` is genuinely true, then
ad-hoc code signed.

**It works.**

```
{"isPackaged":true,"helperMode":"755","helperPathDoubled":false,
 "spawned":true,"streamed":true,"killed":true,"error":null}
```

The helper path resolved inside the bundle, with no doubled suffix:

```
.../Probe.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
```

**asar carries file modes through pack and unpack faithfully.** The arm64 helper went in at 0755
and came out at 0755. The x64 helper went in at 0644 and came out at 0644, because the postinstall
script at the time only repaired the running architecture.

That is the finding. The mode in the tree at package time is the mode in the shipped app. Setting
it back to 0644 inside the built bundle and re-signing reproduces the user-facing failure exactly:

```
{"isPackaged":true,"helperMode":"644","spawned":false,"streamed":false,
 "error":"spawn: posix_spawnp failed."}
```

So there is no architecture problem. There is one packaging invariant: every darwin
`spawn-helper` in the tree must be executable before the app is packed, not just the one this
machine happens to load. The script and the guard test now both cover every `darwin-*` prebuild
rather than `process.arch` alone.

Two things this does not answer, and neither is blocking. Whether electron-builder specifically
preserves modes, since this used `@electron/asar` directly; and whether a notarized, hardened
runtime build behaves the same, which needs the Apple Developer enrolment that is Benzoo's.

### Resize works on darwin, and the assertion did not

The harness ran for the first time and reported:

```
2. node-pty under Electron on arm64, no rebuild
   verdict: contradicted, NEEDS FIX
   loaded=true spawned=true streamed=true resized=false killed=true
   note: the pty layer does not work under Electron on this machine, which changes the plan rather than a line of code
```

Four of five checks passed. The note escalated to a design conclusion from the fifth.

Resize works. What does not exist on darwin is the thing the assertion waited for:

```
raw output: "READY\r\nWINCH 132x40\r\n"
CSI 8 size report present: false
child saw SIGWINCH with new size: true
```

The two platforms prove a resize by different mechanisms and neither generalises. Windows waits for
the ConPTY announcing its new size on the master as `CSI 8 ; rows ; cols t`, because the child
cannot be asked: its console width is cached at startup and does not follow a ConPTY resize. A real
Unix pty echoes nothing on the master; the kernel delivers SIGWINCH and the child reads its own
winsize, which it can.

**The inversion is the point.** The Windows measurement that a child cannot report its own width
was recorded as a general fact, in the fixture's own comment, and it is Windows-only. On darwin
asking the child is not merely possible, it is the only mechanism available.

Three places agreed with each other and all three described Windows: the harness, the pty test, and
the fixture comment explaining why the child could not be asked. The pinning test between the
harness and the platform layer passed throughout, because it pins the claude candidate list and
because a pin proves agreement rather than correctness. That limit is now written into
`docs/CONVENTIONS.md` next to the technique.

The mechanism is now data on the platform interface, `resizeObservation(cols, rows)`, so both tests
read one source instead of agreeing with each other, and the fixture installs its SIGWINCH handler
unconditionally rather than branching.

After:

```
2. node-pty under Electron on arm64, no rebuild
   verdict: confirmed
   electron 43.3.0, node 24.18.1, abi 148, arm64
   loaded=true spawned=true streamed=true resized=true killed=true

summary   3 confirmed, 2 pending
```

The pty test itself, run with the darwin policy skip temporarily disabled:

```
✔ a real resize reaches the terminal (24.606792ms)
ℹ pass 1   ℹ fail 0
```

24ms, against the 8050ms timeout it took to fail before.

### A method note: the experiment was confounded and the free comparison was not

Worth recording next to the counting conventions, because the mistake is repeatable.

The beta hung the Windows suite. Two explanations fitted: the beta is untakeable, or our disposal is
incompatible with it. The experiment run to separate them pinned the beta and disabled
`#releaseInputSocket`, and it cost roughly twenty minutes of Windows runner time.

**It could not have separated them.** Disabling the disposal removes the fix for a leak already
measured on the beta at one handle per session, so the suite would hang either way. The experiment
was confounded by construction and its result carried no information.

What actually answered it was free and already on disk. Comparing the two runs:

```
with disposal     ✖ killing one session leaves the runner and other sessions working (8212.0448ms)
                  ✖ exit reports the code and leaves no live pid              (6170.3197ms)

without disposal  ✖ killing one session leaves the runner and other sessions working (8207.4595ms)
                  ✖ exit reports the code and leaves no live pid              (6163.9101ms)
```

Same two failures, same durations to within milliseconds. The disposal is not the variable, so the
defect is the beta's. That comparison needed no new run at all.

**The lesson is not "check existing data first", which is too general to act on.** It is narrower:
before running an experiment that removes a component, ask whether the outcome would be the same
with the component present, for a reason already known. Here the leak was already measured, so the
hang was predictable in both arms and the arms could not differ.

A second point worth keeping. The discriminator was two durations matching to the millisecond
across independent runs, which is a much stronger signal than either run alone, and it only exists
because both runs printed their failures before hanging. A job killed by a timeout still produces
its output up to the kill, so a timeout is not a lost run.

### Harness section 3: the socket plan has no consumer

Section 3 asked whether the socket file under `~/Library/Application Support/Stafford/` is genuinely
owner-only. It cannot be answered yet, and the reason is a defect rather than a missing task.

`SocketPlan` describes the directory precisely:

```
plan.parentDir   /Users/<user>/Library/Application Support/Stafford
plan.parentMode  0700
plan.ownerOnly   true
```

**Nothing consumes any of it.** There is no `mkdir` anywhere under `src/`. `HookListener` takes a
`socketPath` and calls `listen()` on it, and never creates the parent, applies the mode, or removes
a stale file. Measured rather than read:

```
real dir exists  false
binding into a directory that does not exist:
listen(): THREW EACCES
directory created by the listener: false
```

So on this machine Stafford cannot bring its hook socket up at all, and on a machine where the
directory happens to exist it would inherit whatever mode it finds.

**This is worse than the umask gap it was looked for.** `fs.mkdirSync(dir, { mode: 0o700 })` is
subject to umask and does nothing at all when the directory already exists, so a directory left at
0755 by an earlier version, a restore or a migration would stay at 0755. That would be a real hole.
Here the call is not made at all, so there is nothing for umask to weaken.

The fix is to wire the plan in and to **assert the mode on every startup** rather than only at
creation, correcting it or refusing to start. It belongs with the launch repair sweep. Until then
section 3 reports `contradicted, NEEDS FIX` and the harness exits 1.

**The ownership question itself can still only relax.** Per-agent secrets carry authentication
whatever the answer, so once there is a socket the verdict is `confirmed` or
`contradicted, harmless`, never `NEEDS FIX`. The NEEDS FIX above is about the missing consumer, not
about ownership.

**The second-principal check, for when there is a socket.** macOS ships `nobody`, so this needs sudo
rather than a new account. Mode bits are an inference; a second principal is a measurement, which is
what the Windows answer needed and got:

```
stat -f "%Sp %OLp %Su:%Sg %N" ~/Library/Application\ Support/Stafford
stat -f "%Sp %OLp %Su:%Sg %N" ~/Library/Application\ Support/Stafford/hook.sock
sudo -u nobody ls ~/Library/Application\ Support/Stafford
sudo -u nobody test -r ~/Library/Application\ Support/Stafford/hook.sock; echo $?
sudo -u nobody node -e "require('net').connect('$HOME/Library/Application Support/Stafford/hook.sock').on('error', e => console.log(e.code))"
```

Expected if owner-only: `Permission denied`, a non-zero status, and `EACCES`. The harness prints
these three commands itself once the socket exists, so they are run from its output rather than
copied from here.

### Section 4 stays pending

Kill by process group needs a real agent process tree to kill, which arrives with the CLI harness in
6c. `darwin.killTreeCommand(pid)` returns `kill -9 -<pid>` and that is a specification, not a
measurement, until something spawns a tree.

### The marker sweep, per marker rather than as a count

`grep -rn "UNVERIFIED("` had three markers in code. Sections 1 and 2 clear one of them, and only
one: a measurement clears the claim it measured and nothing adjacent.

**Removed, by measurement.** `claudeCandidates`. Harness section 1: the binary is at
`~/.local/bin/claude`, the first candidate in the list, and `which claude` agrees. Both Homebrew
prefixes stay in the list because arm64 and Intel differ; neither was needed here.

**Retained, and its reason changed.** `hookSocket` ownerOnly. It waited on Task 5 creating the
socket. Task 5 landed and there is still no socket, because nothing consumes the plan. So it now
waits on the plan being wired in rather than on a task, which is a different and more actionable
thing to be waiting for.

**Retained, unchanged.** `killTreeCommand`. Needs a real agent process tree, which arrives with the
CLI harness in 6c. Section 4, still pending, and correctly so.

**Section 2 cleared no markers**, which is worth saying because it is the section that went from
NEEDS FIX to confirmed. It answered whether node-pty works under Electron on arm64 without a
rebuild. No `UNVERIFIED` marker made that claim, so there was nothing to remove.

### APFS is case insensitive here, measured

`normalisePath` treats darwin as case insensitive. That is the default and not a guarantee, and a
developer machine is where the exception happens, so it was probed rather than assumed:

```
=== APFS case sensitivity, by probe not by assumption ===
RESOLVES under a different case  -> case INSENSITIVE
repo volume: case INSENSITIVE
File System Personality:   APFS
/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
```

A file written as `CaseProbe.txt` resolves as `caseprobe.txt`, on the boot volume and on the volume
holding the repository. **Confirmed, so it carries no marker.**

Not treated as universal. A case-sensitive APFS volume is a real configuration chosen at format
time, and there this would compare two distinct paths as equal, which presents as a project matching
the wrong repository rather than as a path bug. The note is in `darwin.ts` so the next person to see
odd path behaviour on a Mac probes the volume first.

### Go cross-compilation stays unanswered, deliberately

```
go version   command not found
which go     not found
```

Go is absent on this machine. The question is whether a contributor on a Mac can build the forwarder
binaries, since CI builds the release ones and a Mac contributor should not be stuck.

Deferred rather than answered, because answering it means installing a toolchain on Benzoo's machine
and that is his call rather than a lead developer's. It is cheap when he wants it: install Go, then
`GOOS=windows GOARCH=amd64 go build` and the darwin and linux equivalents, which is the same check
the work PC passed. Nothing today needs it: the forwarder is Node, deliberately, so there is one
transport client rather than two that can differ.

### Task 5's end-to-end test passed because it built what the product should have built

Recorded next to the section 3 finding, because it is the shape rather than the incident.

Task 5's verification was a real Claude Code session sending a real hook event, and it arrived. It
passed while `SocketPlan.parentDir` and `parentMode` had no consumer, because the probe created the
socket path itself. **A test that sets up what the product should set up cannot see that the product
does not.**

That is the same shape as the harness pinning test passing while the harness and the platform layer
both carried the same Windows assumption about resize. In both cases the test was correct, ran, and
proved something narrower than it appeared to.

The general form: when a test arranges its own preconditions, it verifies the code that runs after
those preconditions and says nothing about the code that should have created them. Setup written by
the test is exactly the part of the product left unexercised.

### A decision was justified by a mechanism that was never wired

The strongest argument for the interface audit, and it was not found by anything failing.

When macOS hardware was deferred, the stated reason it was safe was that `selfCheck` would fail
loudly on an unverified platform and name what it could not confirm. That was the guard the decision
rested on.

**It had never run.** Every platform returned a list of `SelfCheckSpec`, complete with the kind of
check, the targets, and the sentence to say back when it failed. Nothing executed them. So for
several tasks the safety of deferring macOS rested on code that was specified and not wired, and the
only reason nothing came of it is that the hardware questions were answered by hand on this machine
instead.

Nothing failed to surface this. No test went red, no run misbehaved, and the specs read exactly like
working code because they are correct code that is never called. It was found by walking the
platform interface member by member and asking, for each, whether anything under `src/` calls it.

Three members were unbuilt in the same way: `hookSocket` with its five `SocketPlan` fields,
`selfChecks`, and `appDataDir`. Two are now wired and the third is deliberately deferred to Task 8
with a named exemption.

**So the audit is a test now**, `every Platform member has a consumer, or a named exemption`. Every
convention in this project that stuck became a test rather than an instruction: the erosion guard,
the marker check, the deadline test, the tracked-paths guard. An instruction to audit periodically
would be skipped precisely when a task is busy adding members, which is when it is needed.

Verified by making it fail rather than by watching it pass. A temporary `unwiredProbeMember` was
added to the interface and implemented on all three platforms:

```
✖ every Platform member has a consumer, or a named exemption
  AssertionError: Platform members with no caller under src/: unwiredProbeMember.
```

Then removed. The test also fails on a stale exemption, since an exemption naming a member that no
longer exists is how a real hole gets hidden later.

### `/exit` was never the problem. The write mechanism was.

The handoff recorded that `SessionEnd` was unobserved because `/exit` sent as a prompt was consumed
as text and needed to reach the session as a command. That is now measured to be wrong, and the
correction is cheap and instructive: the measurement predates `submit()`.

A slash command sent as one chunk ending in a carriage return is a bracketed paste, exactly like the
140 character prompt that was never submitted. The Enter lands inside the pasted text. So `/exit`
was pasted into the input box rather than run, which looks identical to a command being consumed as
text.

`submit('/exit')`, which writes the text and the Enter separately 400ms apart:

```
spawned pid 15946
--- submitting /exit as two writes ---
exited: {"exitCode":0,"signal":0}
session alive: false
```

`exitCode 0`, `signal 0`. A clean exit rather than a kill, which is precisely the precondition
`SessionEnd` needs. The tail of the output shows the TUI tearing down properly rather than being
interrupted: leaving the alternate screen, disabling bracketed paste and mouse reporting, restoring
the cursor.

**What this proves and what it does not.** It proves `/exit` is accepted as a command and produces a
clean exit. It does not prove `SessionEnd` fires, because no listener was registered for this run.
It removes the blocker, and 6c still has to observe the event.

**The bracketed paste finding explains two symptoms, not one.** It was recorded against the swallowed
prompt. The same mechanism produced the `/exit` symptom, and that one was written down as a fact
about `/exit` rather than about writing. A measurement taken before a fix exists describes the
broken world, and it keeps describing it until someone re-runs it.

### An unverifiable citation is worse than no citation

The sharper half of the containment finding.

Section 8 cited `selfCheck`. The codebase has `selfChecks` and, now, `assertStartable`. It never had
anything called `selfCheck`.

A hand check would have gone one of two ways, and both are wrong. Grep for `selfCheck`, find nothing,
and conclude the mechanism was missing entirely, which overstates it. Or find `selfChecks` nearby and
assume it is the same thing, which understates it, since the specs existed and running them did not.

**A citation that cannot be resolved produces a confident wrong conclusion in either direction**,
which is worse than a risk section that says "contained, see section 8" and forces the reader to go
and look. The test now requires every backticked identifier in a containment claim to resolve to
something under `src/`, so a citation is either checkable or absent.

### A hook spawned by Claude Code reaches a unix socket, and does not inherit the tool sandbox

Its own result, deliberately not folded into section 3. The stat and sudo evidence there proves the
parent directory's mode. It says nothing about whether anything ever connected, and treating one as
evidence for the other is the same move that let Task 5's end-to-end test pass while the code it was
supposed to exercise had no consumer.

The question came from a measurement in the opposite direction. Inside the Claude Code tool sandbox
on this machine, both operations fail:

```
Error: listen EPERM: operation not permitted /tmp/claude-501/stafford-test-cap-33395.sock
CONNECT FAIL EPERM connect EPERM /Users/<user>/Library/Application Support/Stafford-socket-probe/probe.sock
```

A listener bound outside the sandbox and connected to from outside it works, so the denial is the
sandbox rather than the path or the permissions. That mattered because the hook forwarder is a
process Claude Code spawns: if a spawned hook inherited that sandbox, the transport would not work on
this platform at all, which is an architecture finding rather than a bug.

It does not inherit it. From the 6c harness, a real session in a scratch project, the forwarder
registered in that project's `.claude/settings.local.json`:

```
hook    SessionStart  session <session-id>
SessionStart arrived on a socket the product created.
{
  "event": "SessionStart",
  "sessionId": "<session-id>",
  "cwd": "/private/var/folders/.../stafford-6c-0QWxpe",
  "at": "2026-08-08T17:40:27.863Z",
  "agentId": "harness-6c"
}
```

The socket existed because `prepareSocketFor` created its directory and applied its mode at startup,
not because the harness made a path for itself. That distinction is the whole reason the harness
calls the product's startup path rather than reproducing it.

So the darwin socket transport is proved end to end, which the Windows named pipe already was. The
sandbox measurement stands as a fact about the tool sandbox and about any measurement taken through
it, and every 6c number has to be taken outside it or it measures the sandbox instead of the machine.

### Section 4: the mechanism is confirmed, the subject is not

Two different questions, and reporting them as one verdict would hide which half is open.

**The mechanism, confirmed.** A pty-spawned process with a real two-level tree underneath it, no
Claude Code involved, so it costs no quota and isolates node-pty's behaviour:

```
session row: {"pid":57854,"ppid":57853,"pgid":57854,"command":"/bin/sh"}
session leads its own group: true
sleep descendants: [{"pid":57855,"ppid":57854,"pgid":57854,"command":"sleep"}]
  descendant of session: true  shares group: true
kill: kill -9 -57854
after kill, session alive: false
after kill, child 57855 alive: false
after kill, still in group: []
```

node-pty puts the session in its own process group, a grandchild inherits it, and `kill -9 -<pgid>`
reaches both and leaves nothing behind. Had that been false, `killTreeCommand` would have been wrong
on every POSIX platform for every user, and the symptom would have been an orphan rather than an
error.

A first attempt ran `/bin/sh -c 'sleep 30'` and produced a one-level tree, because `sh` execs into a
single command rather than forking. It reported `session leads its own group: true` and no
descendants at all, which looks like a pass and tests half of what was intended. The two-level tree
above is `sh -c 'sleep 30 & wait'`.

**The subject, unverified.** Whether Claude Code spawns its tool children into the session's group or
into groups of their own. Nothing above answers that: it is a fact about the spawned program, not
about node-pty or about our own code. If Claude Code makes its own groups, the kill reaches the
session, the child is orphaned, and there is no error anywhere.

This is a different state from pending and the harness says so rather than reporting `pending`, which
would read as "not started" to whoever runs it next.

### `SessionEnd` and the process tree cannot come from one session

A correction to the 6c design as first written, recorded because the earlier note said all three
outputs land together and someone reading only that would try to recombine them.

They are mutually exclusive within a run. A session killed by process group cannot also exit cleanly,
so there is no `SessionEnd`. A session that exits cleanly leaves no tree to kill, so there is nothing
for section 4 to measure. One session cannot produce both, and a harness that claimed to would be
quietly dropping one of them.

So the harness runs two sessions against the same scratch project: the first for the fixed tool,
`Notification` and the tree, the second for `submit('/exit')` and `SessionEnd`. `Notification` and
the tree stay in one session, which is the part the original note was actually protecting: split
those and a permission prompt with no child would count as a pass.

### A floor asserts a count that only ever decreases, so it fails on progress

`every unverified darwin claim carries a marker pointing at the verification log` required at least
three markers. Confirming `ownerOnly` on hardware removed one, and the suite went red for doing the
thing the marker existed to encourage.

The floor was measuring how much work remained, which is not what the guard is for. The guarantee is
per marker: a marker that does not say where its answer will be recorded is a note to nobody. Zero
markers is the finished state, not a broken test.

Same shape as the pty skip count needing two counters rather than one. A single number cannot
distinguish the case you are guarding against from the case you are working towards, and the one that
gets asserted is whichever was true the day it was written.

### Trust survives the directory, which cuts both ways

Claude Code keys its trust record on the path, so deleting and recreating a directory at the same
path keeps the record. That is what makes the harness runnable repeatedly after one manual accept: a
fixed scratch path is granted once by hand, and the run stays unattended afterwards without anything
auto-accepting a prompt.

The same property means a stale trust record outlives the project it was granted for. A directory
that is deleted, or reused for something else entirely, keeps its grant, and the next session opened
there starts trusted without anyone deciding that. Benzoo cleaned records up by hand earlier in this
project, which is the manual form of the same problem.

Not a gap in Stafford, which never writes these records. Worth knowing before anyone treats a
trusted reading as evidence that the directory is the one it was trusted for.

### The fixed tool was `sleep` and Claude Code refuses to run one

Observed 2026-08-08, and it would have failed the run for a reason unrelated to anything 6c
measures.

```
> Run exactly this one shell command and nothing else, using the Bash tool: sleep 300. ...

  Ran 1 shell command

● Blocked by hook:
  "Blocked: standalone sleep 300."
```

Current Claude Code refuses a foreground `sleep` in the Bash tool. It reports having run the
command first and blocks afterwards, so from outside the session it looks like a tool call that
happened and produced nothing.

**This is a property of the agent being measured, not of this project's configuration.** No setting
here changes it, and it is not one of Benzoo's user hooks: his `PreToolUse` entries are the four
`gsd-*` guards and a commit validator, none of which mention sleeping.

The command is now `tail -f /dev/null`. It blocks with no timer, is POSIX, exists on both targets,
and leaves exactly one killable child, which is what section 4 needs.

The general lesson outlives the substitution. **The fixed command is a dependency on the agent's own
policy about what it will run**, and that policy changes without notice and without a version to
pin. The harness's failure message now names three causes rather than two, because a refused command,
an unanswered permission prompt and a different command all present identically as "no child
appeared", and the third is the one that actually happened.

### The scratch project isolates project settings and not user settings

Worth naming before the next run, because it bounds what the measurement means.

The scratch project controls `.claude/settings.local.json`, which is where Stafford registers its six
hooks, and that is what makes the permission prompt happen rather than an `acceptEdits` policy
swallowing it. It does nothing about `~/.claude/settings.json`, which applies to every session on the
machine. On this machine that file carries `SessionStart`, `PostToolUse`, `PreToolUse`,
`SubagentStop`, `Stop`, `PreCompact` and `FileChanged` entries.

So the harness measures a session under Benzoo's global configuration rather than a clean one. The
`LETTA_API_KEY` errors visible in any transcript here are that configuration failing harmlessly, and
they are noise in the harness output rather than a Stafford problem.

Two consequences. A user-level `PreToolUse` guard can block the fixed command, which is exactly the
class of thing that just happened from a different direction. And a `Notification` that does not fire
could be a global hook interfering rather than the transport failing, which is a second reading of a
negative result that has to be ruled out before it is reported as an architecture finding.

Not worth solving by pointing `HOME` somewhere else, since that is where Claude Code's credentials
and trust records live and the run would stop being a run of the real thing.

### The kill orphaned a real process, silently, and would have shipped

The most consequential defect this project has found. It produced no error, no failed check and no
hang. The only evidence was a process still running with nothing attached to it.

```
  tool    tail  pid 77302, ppid 77277, pgid 77277
  session pgid 76638, leads its own group: true
  child   descendant of the session: true, shares its process group: false
  kill    kill -9 -76638
  after   session alive: false, child alive: true, processes still in group 76638: 0
```

Claude Code runs its Bash tool through a `zsh` wrapper that leads its own process group. So the
session led group 76638 and the tool child sat in group 77277, and `kill -9 -76638` reached a group
containing only the session. The kill returned success. Both the wrapper and the `tail` were still
alive afterwards and were killed by hand:

```
77277 /bin/zsh -c ... eval 'tail -f /dev/null' ...
77302 tail -f /dev/null
```

**The design named this exact failure mode in advance, and that is the only reason it was caught.**
The 6c design said to assert that the child is a genuine descendant and that nothing survives the
kill, because "the symptom is an orphan rather than an error". The assertion existed because someone
wrote down what would go wrong before it did. Without it the harness would have reported a kill
command that ran, which is what the earlier design explicitly refused to accept as an answer.

#### The shape was wrong, not the command

`killTreeCommand(pid): CommandSpec` could not express the fix, because tree teardown on POSIX is not
one command. It is a procedure over state that has to be measured before anything dies: killing the
root reparents its descendants to pid 1, so the parent chain that identifies them is gone. A single
return value forced the caller to already know the answer.

It is now `killTreePlan(pid): KillTreePlan`, the same split as `hookSocket` returning a `SocketPlan`
rather than a path. The platform says what to do, `src/main/agents/kill-tree.ts` does it, and the
ordering lives in one place:

1. Snapshot the tree by parent pid while everything is alive.
2. Collect the distinct process groups in the snapshot. On the measured run that is two: 76638 and
   77277.
3. Kill every collected group, not only the root's. Groups rather than a pid list, because a process
   spawned during teardown inherits its parent's group and is caught, where a list taken a moment
   earlier is already stale.
4. Re-walk and kill any survivor by pid, for anything that changed group in between.
5. Verify that nothing survives, as part of the procedure rather than as something a caller
   remembers.

**The window is real and is named in `plan.gap` rather than implied.** A snapshot followed by a kill
has a gap between them, and a process spawned into a brand new group inside that gap is in neither
the collected groups nor the survivor sweep. Step four narrows it and does not close it. This is a
strong best effort, not a guarantee, and anything depending on nothing surviving has to check rather
than assume.

#### POSIX, not darwin

Windows is genuinely unaffected: `taskkill /PID <pid> /T /F` walks parent to child and has no group
assumption to be wrong about. Linux would fail identically to macOS, because the tool child's group
is the spawned program's choice rather than the platform's. So the plan is shared POSIX behaviour in
`platform/posix-kill.ts` and linux gets the fix too, even though linux does not ship.

### A measurement with a stand-in verifies the mechanism and says nothing about the subject

Second instance here, and worth naming as a class.

The process-group mechanism was measured earlier with a pty-spawned `sh -c 'sleep 30 & wait'`, and it
confirmed that node-pty puts the session in its own group and that a grandchild inherits it. That
result is correct and was not contradicted by anything above. It simply could not have found this
defect, because a plain `sh` does not start a new process group and Claude Code's wrapper does. The
stand-in agreed with the assumption; the real subject did not.

The first instance was Task 5's end-to-end test, which passed against a socket path the probe had
created rather than the one the product should have created. Same shape: everything downstream of the
stand-in was exercised correctly, and the thing being stood in for was never touched.

So a stand-in measurement is worth having, and its scope is exactly "the mechanism works". Writing it
up as "the tree is killed correctly" rather than "node-pty groups behave as assumed" is how the wrong
conclusion gets carried forward.

### Why no permission prompt appeared: the sandbox is on

`Notification` fired, but as `Claude is waiting for your input` after `Stop`, which is the idle
notification rather than a permission prompt. Three things were checked rather than reasoned about:

- **What the harness writes.** Only a `hooks` key. `merge({}, command)` produces no `permissions`
  block, so nothing the harness wrote could have allowed the call.
- **Benzoo's global settings.** `~/.claude/settings.json` carries a `permissions` block whose
  `allow` list is five unrelated entries and whose `deny` list is destructive-command patterns.
  Neither mentions `tail`, `sleep` or anything the harness ran. `defaultMode` is unset.
- **The cause.** `"sandbox": { "enabled": true }`. Bash commands run inside the sandbox, and a
  sandboxed command does not need a permission prompt because the sandbox is the containment instead
  of the prompt.

That also explains the two earlier `EPERM` results on binding and connecting a unix socket, and it is
very likely why the tool child has its own process group: the sandbox wrapper is what `zsh -c` is
doing there. Worth a follow-up measurement rather than an assumption, because if the separate group
is a sandbox artifact then a user with the sandbox off gets a different tree shape and the same
teardown procedure has to cover both. It does, since it collects whatever groups it finds.

**So the permission-prompt variant of `Notification` is still unobserved.** The badge, the sound and
the rate-limit distinction were all specified against it. The route to provoking it deliberately is a
`permissions` block in the scratch project's own `settings.local.json` that forces ask on Bash,
rather than depending on a default that has already changed once.

### Cluster table: `killTreeCommand` removed

One interface member and its assertions, compared by behaviour rather than by name, per the
convention. Nothing here is a rename: the member is gone and its job is done by a plan plus a shared
executor.

| Removed behaviour | Where it lives now |
| ----------------- | ------------------ |
| Windows returns `taskkill /PID <pid> /T /F` | `win32.killTreePlan(pid).wholeTree`, byte for byte the same command, asserted in `kill plans are specifications, not actions` |
| POSIX returns a kill targeting a process group | `posixKillTreePlan().group(pgid, signal)`, but parameterised by which group rather than assuming the root's, which is the defect |
| POSIX hard-codes signal 9 | `group()` and `process()` take a `KillSignal`, so a SIGTERM-then-SIGKILL drain becomes a change of argument rather than a change of shape. Owed item below |
| `PtySession.killTreeCommand()` exposes it to a caller | `PtySession.killTreePlan()`, asserted in `the kill plan comes from the platform, not from a branch in here` |
| The member is present on all three platforms | Still asserted by `every platform implements every member`, with `killTreePlan` in the list |
| The command is data a Windows machine can assert about macOS | Unchanged and extended. `kill plans are specifications, not actions` asserts all three platforms' plans from any machine |

**One behaviour is deliberately not carried over**, and it is the reason for the change: the caller
could previously run one command and be done. It cannot now, because that was never sufficient on
POSIX. The executor is the replacement and it is not optional, which is why verification is inside it
rather than left to whoever calls it.

**New behaviour with no predecessor**, listed so the table is not read as a pure move: snapshotting
before the kill, collecting every group rather than one, the survivor sweep by pid, and the stated
`gap`. All four are tested in `kill-tree.test.ts` against the measured tree.

### Owed: SIGTERM before SIGKILL

Raised rather than implemented, because it grows the task and it is a behaviour change rather than a
correctness fix.

The procedure sends `KILL` immediately, which is what the old command did. For the blocking-update
drain that is worth reconsidering: a tool child killed with SIGKILL mid-write can leave a
half-written file, and the drain exists to preserve work. The runner does its own git checkpoints so
it never needs agent cooperation, but a corrupted file in the working tree is worse than an
uncommitted one.

Proposal: `TERM` to each collected group, a short grace, then `KILL` to whatever remains, with the
grace in configuration. The plan already takes a `KillSignal` on both `group()` and `process()`, so
this is an argument change and a loop, not a reshape.

Not done here because the teardown fix needs to be verifiable on its own. A signal change and a
structural change landing together would make a failure impossible to attribute, which is the same
reasoning that kept the ESM flip in its own commit.

### What the Bash sandbox actually restricts

`scripts/sandbox-probe.sh`, run through a sandboxed tool call and again outside one, on
2026-08-08. The control column was OK for every row, so every DENIED below is the sandbox and
not the machine.

```
OK      write inside the project directory
DENIED  write to the home directory, outside any project
DENIED  write to another repository under Documents/Git
OK      read the home directory listing
OK      read ~/.gitconfig
OK      outbound https to a public host
OK      outbound https to github, which a fetch would need
DENIED  dns resolution
OK      git init in a scratch directory outside any repository
OK      git add and commit in that repository
OK      git status in the real repository
OK      git fetch from the real remote
OK      write a plain file inside .git
DENIED  write into .git/hooks
DENIED  git config --local, which writes .git/config
DENIED  bind a unix socket under the project directory
DENIED  bind a unix socket under Application Support
OK      spawn a child process
DENIED  read the process table
```

What that means for the three tasks that depend on it:

- **Builds and tests survive.** Writes inside the project work, child processes spawn, and
  outbound HTTPS works, so `npm ci` and `npm test` are unaffected. Reads outside the project are
  allowed, which is why a toolchain in `~/.nvm` still resolves.
- **The drain survives.** `git add` and `git commit` both work in an existing repository, which is
  what the runner's checkpoint does. `git fetch` works.
- **Two git paths are closed**, and they are the two that carry executable code or credentials:
  `.git/hooks` cannot be written and `.git/config` cannot be modified. That is why `git init`
  fails inside a project directory while succeeding outside one, and the failure message names
  the hook templates rather than the sandbox.
- **Writes outside the project are refused**, including into a sibling repository. An agent given
  a path outside its project cannot write there at all.
- **DNS lookup is refused while HTTPS works**, so network egress is proxied rather than open.
  A tool that resolves names itself rather than letting the HTTP stack do it will fail, and it
  will fail looking like a network outage.

**None of these announce themselves as policy.** Every one presents as the agent being broken:
`git init` reports a template copy failure, `nslookup` reports a resolution failure, a socket bind
reports `EPERM`. A hire failing this way looks like a bad agent rather than a machine setting, and
that is the reason this is written down.

#### The sandbox is a capability the project policy does not model

`ProjectPolicy` carries `permissionMode`, so the plan already accepts that what an agent may do is
a per-project decision. The sandbox is the same class of decision and is currently inherited from
whatever `~/.claude/settings.json` says on the machine Stafford happens to run on.

That is backwards for the product's own purpose. A client repository is exactly where a sandbox
should be on, and Stafford's own repository, where an agent may need to write outside the project
or manage git configuration, is exactly where it might not be. Today both get whatever Benzoo's
machine has, and a hire's effective capabilities change if he edits a global file for an unrelated
reason.

Raised as an owed item rather than implemented, because adding a field to `ProjectPolicy` without
the sweep that writes it and the UI that sets it would be another well-specified value with no
consumer, which is the exact failure this project has already had three times.

#### The asymmetry, and why it matters more than it looks

A sandboxed tool call cannot bind or connect to a unix socket under Application Support. A hook
command spawned by Claude Code in the same session connected to one and delivered `SessionStart`.
So **the sandbox applies to tool execution and not to hook commands**, which is what makes the
whole hook transport work on a sandboxed machine.

That currently rests on one observation, and the transport depends on it, so it is listed as owed
rather than settled. The cheap confirmation is a second hook registered in the scratch project that
attempts an operation the sandbox refuses and reports the result, run in the same session as the
forwarder.

#### `Notification` fires far less than the design assumes

Stated here and in the plan next to the badge, because it changes behaviour rather than only a
measurement.

A sandboxed Bash call does not raise a permission prompt, since the sandbox is the containment
instead of the prompt. No prompt means no `Notification` for that tool call. The design specified
`Notification` as the trigger for the badge, the sound and the rate-limit distinction, and on a
sandboxed setup the prompt variant may never arrive at all.

The idle variant does arrive, as `Claude is waiting for your input`, which is something but is not
the same event: it fires when a turn ends rather than when the agent is blocked on a decision. A
badge driven by it would light up on every completed turn rather than when attention is needed.

### Section 4 closed: the tree teardown works against a real agent tree

The same shape that defeated the old command, torn down completely by the new plan.

```
  tool    tail  pid 95997, ppid 95968, pgid 95968
  session pgid 95194, leads its own group: true
  child   descendant of the session: true, shares its process group: false
  plan    snapshot the tree by parent pid while it is alive, collect the distinct process
          groups, kill each group, then re-walk and kill any survivor by pid, then verify.
  groups  killed 95194, 95968  (the session leads 95194)
  after   survivors: 0, swept by pid before that: 0
```

`nothing survived the kill  true`. Two groups collected and both killed, where the old command
killed one and orphaned the other. The tool child is still in a group of its own, so the defect
condition reproduced exactly and the procedure handled it.

The pid sweep found nothing to do, which is the expected result rather than a sign it is
unnecessary: it exists for a process that changes group between the snapshot and the kill, and
that did not happen here. Its test coverage is the simulated case in `kill-tree.test.ts`.

### Hook commands are not sandboxed. Confirmed rather than inferred.

Three operations, each measured as DENIED for a sandboxed tool call, run from inside a real hook
command registered in the scratch project alongside the forwarder:

```
  hook sandbox probe, from inside a real hook:
    ALLOWED  write to the home directory
    ALLOWED  bind a unix socket under Application Support
    ALLOWED  read the process table
```

So the sandbox applies to tool execution and not to hook commands, and the hook transport works on
a sandboxed machine because of that asymmetry. It was previously resting on a single observation,
that a hook had connected to a socket a sandboxed process could not. It now rests on three
operations chosen because the sandbox refuses all three.

Worth stating plainly since it cuts both ways: a hook command is a less constrained execution
context than a tool call on the same machine. Stafford registers six of them per managed project.
The forwarder is deliberately the only transport client for exactly this kind of reason, and this
is one more argument for keeping it that way.

### The multi-repo project model does not survive a sandbox

Measured rather than reasoned from the earlier probe.

```
sandboxed                                   control
DENIED  write into a sibling repository     OK
DENIED  git init in that sibling            OK
```

The sandbox permits writes only inside the directory Claude Code started in. A project holds
several repositories and a hire works across them, and the design's own answer to wanting one role
across two repositories was a single project containing both rather than two hires. That is
precisely the arrangement this breaks: the agent can write in the repository it started in and
nowhere else, and the failure is a denied write rather than a policy message.

Three options, none picked here because all three change something already decided:

- **Sandbox off for multi-repo projects.** Keeps the project model and gives up the containment
  exactly where a client's several repositories are involved, which is where it is most wanted.
- **One session per repository rather than per hire.** Keeps both. See the correction below: this
  was first ranked most invasive and is closer to least, because the `sessions` map and the per-repo
  write lock already exist.
- **The project model narrows to one repository.** Simplest, and it reopens the question the
  current model was the answer to.

This is a design conflict rather than a restriction to note, and it belongs to Benzoo.

### Registration survives a sandbox, both files

The dependency, checked because registration failing would take the transport with it:

```
OK  append to .git/info/exclude, which registration writes
OK  write .claude/settings.local.json, the other file registration writes
```

Both are allowed. `.git/info/exclude` falls in the same category as a plain file inside `.git`
rather than with `.git/hooks` and `.git/config`, which are the two denied paths. So per-project
registration and the launch repair sweep both work on a sandboxed machine.

### A probe that mutates state runs outside the repository, without exception

The rule, and it is about location rather than care.

The git probes originally ran inside this repository. `git init` failed partway on a denied write
into `.git/hooks`, left no `.git` behind, and the `git add` and `git commit` after it walked up and
committed to the working branch. Twice. Both were local, neither was pushed, both were reset.

**Nothing caught it, and nothing could have.** The tracked-paths guard checks what is tracked, and
a commit is not a tracked path. The suite does not run probes. A probe that mutates git state was
outside every guard this project has, which is what makes the rule worth stating rather than
treating as a one-off slip.

"Run it carefully" is not the fix. A `git init` failing partway and leaving the next two commands
to find the enclosing repository is not a failure mode anyone predicts, and it only exists because
of where the probe ran.

### A containment boundary writable from inside is not containment

The design conclusion that shaped Stafford's write-path enforcement, stated without the method.

A sandbox that a contained process can reconfigure from inside is not containment. Configuration that
governs how the next session runs lives under `.claude/`, so an agent able to write there can
influence its own future execution context rather than only its current sandboxed one. That is enough
to fix the design: `.claude/` is treated as the same class as `.git/hooks` and `.git/config`, which
the sandbox already denies, because all three carry capability rather than content. The only principal
that writes under `.claude/` is the runner during registration, which is not an agent.

**A specific mechanism of this shape was measured, reported to Anthropic, and has had no reply. The
method is omitted here pending resolution**, because it would let a reader reproduce it against an
unfixed sandbox. What is published is the design consequence, which does not depend on the detail: the
enforcement denies all of `.claude/` to every agent, and that decision stands whatever the specific
mechanism was.

#### Stafford already uses this context on purpose

Worth stating plainly: Stafford registers six hooks per managed project, so it is already using the
less constrained execution context deliberately. That is fine and is the reason the forwarder is the
single transport client. The same mechanism being an escape route for an agent is why the runner,
not any agent, is the only principal that writes to `.claude/`.

### Correction: one session per repository is not the most invasive multi-repo option

The earlier note ranked "one session per repository rather than per hire" as the most invasive of
the three, citing state derivation, the counters and the kill assuming one session per agent id.
That was wrong, and section 5 of the plan is why.

`HiredAgent` already carries `sessions: Record<string, string>`, keyed by project, with only one
active at a time, precisely so a hire can work across projects. The counters and the kill assume one
*active* session per agent, which the map already guarantees, not one session total. Re-keying that
map by repository rather than by project is a change of key, not a change of shape, and everything
downstream already handles a hire owning several sessions.

It also fits a piece already in the design: the write lock is per repository rather than per project
(plan section 5 and section 12). So the model is closer to per-repository sessions than the current
per-project wording suggests, and this option is arguably the *least* structurally disruptive of the
three rather than the most. Still a real change, and still Benzoo's to make, but ranked correctly now.

### The permission-prompt Notification, observed, and the sandbox is what suppresses it

The last hook event 6c owed, and it took a controlled comparison rather than one run.

Two runs against the scratch project, differing in one variable:

```
ask on Bash, sandbox on (inherited):   no Notification. The tool ran, no prompt.
ask on Bash, sandbox OFF for project:  Notification "Claude needs your permission"
```

So an explicit ask does not by itself produce a prompt on this machine, and the sandbox is what
suppresses it: a sandboxed Bash call is contained instead of prompted. Turning the sandbox off for
the project in its settings let the same ask produce the prompt. That also confirms a project's
settings can override the global sandbox, which is what the owed `ProjectPolicy` field would rely on.

The permission-prompt payload, verbatim:

```
{
  "event": "Notification",
  "sessionId": "<session-id>",
  "cwd": "/private/var/folders/.../stafford-6c-scratch",
  "at": "2026-08-08T18:51:36.392Z",
  "agentId": "harness-6c",
  "message": "Claude needs your permission"
}
```

**This gives the classifier its two real strings.** The idle variant is `Claude is waiting for your
input` and the permission variant is `Claude needs your permission`. The owed three-way
classification (rate limited, permission prompt, idle) now has the middle string it was blocked on,
so it is no longer blocked. The rate-limit string is the one still unmeasured.

With this, all six registered hook events have been observed end to end: `SessionStart`,
`UserPromptSubmit`, `SubagentStop` and `Stop` earlier, `SessionEnd` on the clean exit, and now the
permission-prompt `Notification`.

### The separate process group is not a sandbox artifact

Worth recording because it was flagged as needing a follow-up, and this run answered it for free.

With the sandbox OFF, the tool child still had its own process group:

```
  tool    tail  pid 13813, ppid 13811, pgid 13811
  session pgid 12529, leads its own group: true
  child   descendant: true, shares its process group: false
  groups  killed 12529, 13811    after: survivors 0
```

So Claude Code's `zsh` wrapper leads its own group whether or not the sandbox is on. The teardown
plan collects whatever groups it finds, so it covers both, but the earlier guess that the second
group might be a sandbox artifact is wrong: the tree shape is the same either way, and every user
gets it rather than only sandboxed ones. Section 4's fix is needed on every macOS setup, not just
this one.

### 7a.1: two invisible seams from the Electron shell, closed

Both compile clean and fail at runtime, and neither was caught by anything until it was exercised.

**The sandboxed preload had to be CommonJS, found by launching.** 7a built the preload as ESM,
because electron-vite emits `.mjs` under a `type: module` root, and the app launched to a dead
bridge. The smoke run showed it:

```
[smoke] renderer: Unable to load preload script: .../out/preload/index.mjs
[smoke] renderer: SyntaxError: Cannot use import statement outside a module
[smoke] renderer: Uncaught (in promise) TypeError: Cannot read properties of undefined (reading 'health')
```

A sandboxed preload runs in a loader with no ESM import. Fixed by forcing `formats: ['cjs']` and
`entryFileNames: 'index.cjs'` in the vite config, after which the smoke run reported
`renderer drove a pty open through the bridge = true`. Guarded by `preload-format.test.ts`, which
checks the config always and the built artefact when a build is present. This is not reasoned about;
it is the error the app printed at launch.

**The shared `"DOM"` lib let main-process code reference DOM globals.** 7a added `"DOM"` to the one
tsconfig so the renderer would typecheck, which also meant `document` in a main-process file
compiled clean. Split into per-environment configs on 2026-08-08: node and preload get no DOM, only
the renderer does. Proven to bite by compiling a fixture under each lib:

```
node lib (ES2023):   error TS2584: Cannot find name 'document'
DOM lib (ES2023,DOM): clean
```

`tsconfig-split.test.ts` runs exactly that and asserts the difference, so the guarantee is the
compiler's own answer rather than a claim about the config. `npm run typecheck` now runs all three
configs in one command.

### 7b.1: a packaged darwin arm64 build, with the spawn-helper invariant proven inside the bundle

Local build only. The CI matrix is 7b.2. electron-builder 26.0.12, darwin arm64, unsigned.

**The build.** `npm run package` runs `electron-vite build` then `electron-builder --mac --dir`,
producing `dist/mac-arm64/Stafford.app`. electron-builder downloads its own Electron binary, so the
packaged build does not need `npm run electron:install`; that step is only for a local `npm run dev`,
where electron-vite launches the installed binary. The 7b.2 CI packaging job therefore needs
electron-builder, which self-fetches Electron, and does not need the install step.

**The invariant, read inside the bundle.** Every darwin spawn-helper in the packaged app is mode
0755, execute bit present, at the unpacked path node-pty resolves:

```
755  build/Release/spawn-helper
755  prebuilds/darwin-x64/spawn-helper
755  prebuilds/darwin-arm64/spawn-helper
```

node-pty resolves `<native dir>/spawn-helper` with `app.asar` rewritten to `app.asar.unpacked`, so
the active helper is `build/Release/spawn-helper`. `packaged-spawn-helper.test.ts` reads these from
`dist/` and asserts the execute bit. It is a local backstop until 7b.2 builds in CI; the config guard
and this artefact check together are the guarantee.

**The negative case, proven not asserted.** With node-pty sealed into the asar the guard goes red:

```
asarUnpack: [], asar.smartUnpack: false
  -> no app.asar.unpacked, helper sealed in app.asar
  -> AssertionError: no unpacked darwin spawn-helper found. asarUnpack for node-pty is missing
     or the path changed, so the helper is sealed inside the asar and no pty can open.
```

Restored to the real config, the guard is green on the real bundle.

**electron-builder auto-unpacks native modules, so the explicit asarUnpack is belt and braces.**
Removing only `asarUnpack` was not enough to seal node-pty, because electron-builder's smartUnpack
detects native modules and unpacks them anyway. Sealing it required disabling smartUnpack as well.
So the explicit entry documents intent and guards against a smartUnpack change, and the artefact
guard is what actually catches a broken unpack however it breaks.

**The packaged app spawns a real pty, end to end.** Launched with `app.isPackaged` true:

```
[smoke] boot ok: tray-resident, no window at launch, platform darwin, windows open now 0
[smoke] renderer drove a pty open through the bridge = true
```

The unpacked helper was executable, `posix_spawnp` succeeded, and the renderer drove a shell through
the bridge from the built bundle, no error and no doubled asar path.

**A packaged smoke run must not register the login item, and did once.** `app.isPackaged` is true in
a packaged build, so `configureLoginItem` registered a Stafford login item on the first packaged
launch. It was removed with `osascript ... delete login item "Stafford"`, confirmed gone, and the
smoke path now skips the login item entirely, so verification never changes that system state again.

**Unsigned build.** There is no Apple Developer account, so the build is unsigned and macOS Gatekeeper
will refuse a double-click until it is allowed once by hand, or run it from the terminal as done here.
Signing gates the updater, not this build. No signing or notarization config was added, and no
credentials exist anywhere in the tree.

### node-pty #886: the ConPTY console-list agent crash, measured and traced, 2026-08-08

**The rate.** The Windows CI job failed once on one commit, then eight re-runs of the same
commit, changing nothing, were all green. So one failure in nine observed Windows runs, and zero in
a clean eight-sample re-measurement. Low frequency, not zero: it is a race, so a rate rather than a
constant. The failing test was `written input reaches the process` in the real-pty suite, and the
crash was the same every time.

Raw failure from the red run:

```
✖ written input reaches the process
D:\a\Stafford\Stafford\node_modules\node-pty\lib\conpty_console_list_agent.js:13
var consoleProcessList = getConsoleProcessList(shellPid);
                         ^
    at Object.<anonymous> (...conpty_console_list_agent.js:13:26)
    at Module._compile (node:internal/modules/cjs/loader:1934:14)
    ... runMain
```

**Whose code.** node-pty's. `windowsPtyAgent.js:184` forks `conpty_console_list_agent.js`, Microsoft's
own file, and the throw is at its line 13. No Stafford frame is in the stack. Upstream
`microsoft/node-pty#886` describes it exactly: when the shell has already exited, `AttachConsole`
throws unhandled and crashes the forked process, and a child-exit-monitoring runner fails the whole
run even when assertions passed.

**When it runs.** `WindowsPtyAgent.kill()` forks the agent on every ConPTY session kill, on modern
Windows (build >= 18309) on the default non-DLL path. So Stafford triggers it on every Windows
session teardown. It does not fork on the `useConptyDll` path, which kills directly.

**What happens to the parent.** It is contained. `_getConsoleProcessList()` returns a Promise that
always resolves: the agent's message, or a 5-second timeout that resolves with just the shell PID.
There is no error or exit handler that rethrows. So node-pty's parent does not throw, and an Electron
main process gets no unhandled error from it. What fails is the test runner's own child-exit monitor,
which Electron main does not have. So the crash failing the run is a CI property, not a runtime one.

**Observable runtime damage on Windows, from source.** Not a crash and not a lost session exit. The
pty is killed synchronously; only the grandchild-console cleanup waits 5 seconds and falls back to
killing just the shell PID, so console grandchildren that would have been in the full list can be
left as orphans. A slow, reduced cleanup with possible stray processes. This is read from node-pty
source on darwin; the control flow is the same on every platform, but confirming the 5-second delay
and the orphans on a live Windows machine needs a Windows run.

**Open option, not a decision.** node-pty's `useConptyDll: true` spawn path does not fork the agent,
so it avoids the crash entirely. It is a behaviour change on the platform where the pin already
carries two open defects, so it is recorded as an option with a condition rather than adopted:
justified only if Stafford's own teardown does not already sweep the orphans. That is the next
question.

### Does killTreePlan cover the #886 orphans? Not today, because it is not wired into teardown

The question was whether Stafford's own tree teardown already sweeps the console grandchildren
node-pty's #886 fallback can orphan on Windows. The answer, from the code:

1. **killTree does not run on session teardown.** The executor `killTree` is called only by the 6c
   harness. `PtySession.kill()` goes straight to node-pty's own kill, and `PtySession.killTreePlan()`
   only returns the plan as data, it does not execute. So on a real Windows session kill today,
   nothing invokes killTree. The drain (section 7.4 step 5) would, but the drain is not built.
2. **The Windows plan reaches grandchildren, through `taskkill /T`.** `win32.killTreePlan` returns
   `taskkill /PID <pid> /T /F` as `wholeTree`, and `/T` terminates the process and its child tree, so
   a console grandchild that is a child in the process tree is killed. It enumerates nothing itself;
   taskkill walks the tree.
3. **Ordering would be decisive if it were wired.** taskkill /T walks the live tree, so it must run
   while the shell is alive. After node-pty's kill has already killed the shell, the grandchildren are
   reparented and taskkill against the dead shell pid would no longer reach them. So a wiring would
   have to run killTree before node-pty's kill, not after.
4. **The Windows executor does not verify survivors.** `processTreeCommand` is null on Windows, so the
   executor's `wholeTree` branch runs taskkill and reads no process table, and its survivor list is
   empty by construction. It trusts taskkill rather than confirming. So even the executor does not
   close the loop on Windows; only an external check does.

So killTreePlan does not currently cover the orphans, on two counts: it is not called on teardown, and
its Windows path does not verify. What is true is that the mechanism reaps grandchildren, which the
test below asserts, so the fix is to wire it in rather than to change node-pty.

**A near-miss worth recording.** The first version of the test spawned the root in the test runner's
own process group. killTree kills every group in the tree, so it killed the runner and the shell with
no output. That is not a test bug so much as a live demonstration of why the runner must spawn agents
into their own process group, which the design already requires. The test now spawns the root
detached, as a real agent is.

**The measurement.** `kill-tree.real.test.ts` spawns a real process tree with a detached grandchild
that leads its own group, tears it down through `killTree`, and asserts by pid that the grandchild is
gone. It runs on Windows and macOS CI both, because it uses no pty and so avoids node-pty's kill and
the #886 fork entirely. Green locally on darwin; verified able to go red by pointing killTree at a pid
it cannot reach, which left the grandchild alive and failed the assertion. Windows CI result recorded
with the commit.

**The options, both open, Benzoo decides.** Since teardown does not sweep the orphans today, either
wire killTree into Windows session teardown, run before node-pty's kill while the tree is alive, or
spawn with node-pty's `useConptyDll` path which does not fork the console-list agent at all. The DLL
path removes the CI failure too; wiring killTree removes only the runtime orphan and leaves the CI
failure to the pin. Neither is adopted here.

### killTree is now wired into session teardown, 2026-08-09

The prior entry established that killTree reaped grandchildren but was invoked by nothing on a real
teardown. It is now `PtySession.killWithTree()`, and the proof window's teardown calls it, so the
mechanism runs on a real session kill rather than only in the harness.

**The order is the load-bearing part, and it is enforced.** killWithTree reaps the whole tree first,
while it is still alive, then calls node-pty's own kill. taskkill /T walks the live tree and the
POSIX group snapshot must be taken before the root dies and reparents its children, so reaping has to
come first. A unit test asserts that every tree kill runs before node-pty's kill, driven with
injected executor deps so no real process is touched.

**Why node-pty's kill still runs after.** node-pty's exit path destroys the output socket but
disposes the conout worker only inside `kill()`. Skipping it would leak a worker thread per session
on Windows. Read from node-pty source: `_$onProcessExit` leads to `_cleanUpProcess`, which destroys
the out socket and does not touch the conout worker, while `WindowsPtyAgent.kill` is the only path
that disposes it.

**The 886 cost, contained.** That second kill forks node-pty's console-list agent for an already-dead
shell, which is 886. It is contained by node-pty's own five-second timeout and does not reach the
Electron main process, so at runtime it costs a short-lived helper and nothing else. It only fails a
test runner that monitors child exits, which is why the tree-reaping proof is pty-free and the wiring
is unit-tested for order rather than through a real pty on Windows. A real-pty killWithTree test on
Windows would reliably hit 886 under node --test, so it is deliberately not written; that would be a
test that can only pass with a retry or a skip, both forbidden.

**What this closes and what it does not.** The runtime orphan is covered: a Windows session teardown
now reaps console grandchildren that node-pty's fallback would leave. 886's CI test failure is not
closed by this and stays a pin exit condition. The `useConptyDll` option would remove the CI noise
too by not forking the agent at all, and it is still open on that narrower ground rather than the
orphan one.

### What wiring killTree did to 886, measured where possible, 2026-08-09

killWithTree reaps the tree before node-pty's own kill, so that kill now sees a shell that killTree
already killed. That is exactly 886's precondition, a shell that has already exited. So the question
is whether a rare race became a per-teardown certainty, and whether that reaches CI or the shipped app.

**No Windows CI test traverses killWithTree with a real pty. Measured.** The only callers of
killWithTree in tests are its two unit tests, which inject the executor's run and readTree so no real
process is touched. `ProofPty`, the one production caller, is tested with a fake. The real-pty suite
uses `session.kill()`, node-pty directly, which is the unchanged path. And that change set's Windows job is
green, which a real-pty killWithTree could not be, since it would crash reliably. So the wiring did
not change any CI test's 886 failure risk. The earlier one-in-nine rate belongs to
`pty-session.real.test.ts` calling `session.kill()`, and it is unchanged.

**Whether it fires on every production teardown cannot be measured on this machine, and is not
simulated.** The console-list agent and 886 are Windows only; darwin has no console-list agent, so a
darwin run measures nothing here. From node-pty source the expectation is a certainty rather than a
race: killWithTree kills the shell first, so when node-pty's kill forks the agent the shell is always
gone, `AttachConsole` always fails, and the agent always crashes. What would measure it is a Windows
machine, or a dedicated CI probe outside `node --test`, running killWithTree against a real pty many
times and counting the agent exit and the fallback timer. That is not built here, because a probe
that let the crash through would fail the run, and one that swallowed it would be a skip.

**The per-teardown cost, from source.** Each Windows teardown through killWithTree pays, in node-pty's
kill:
- one forked console-list agent process that crashes immediately, short-lived, no accumulation;
- node-pty's five-second timeout, which is not unref'd, before it falls back to killing the shell PID.
  That fallback is now a no-op, because killTree already killed the whole tree. It runs in the
  background of node-pty's kill; killWithTree returns without waiting for it, so there is no
  user-facing five-second delay on teardown.
The conout worker is disposed, because node-pty's kill runs, so there is no handle leak. Net: a
transient crashed helper and a background timer per teardown, no accumulation, on a machine cycling
sessions all day.

**Disposing the conout worker without node-pty's full kill is not exposed.** node-pty's only public
teardown is `kill(signal)`, which always forks the agent on the ConPTY non-DLL path. There is no
public API to dispose the conout worker alone, and no upstream issue or pull request proposes exposing
one; #947 is the separate conin leak. It is reachable only by reaching into node-pty internals, the
same undocumented approach already used for the input socket, which is not an API.

**What this does to the DLL question.** The useConptyDll spawn path forks no console-list agent at
all. Before this measurement it looked like it only removed CI noise. Now that killWithTree makes the
agent crash a per-teardown event in the shipped app rather than a rare one, the DLL path removes a
real per-teardown cost in production, not just in CI. So the recommendation strengthens: the DLL spike
is worth more than it was, though it is still a behaviour change on the platform that already carries
two open pin defects, so it stays a spike to schedule rather than a change to make now.

### electron-builder rebuilds native modules by default, which broke the Windows packaging leg, 2026-08-09

The 7b.2 Windows packaging leg failed because electron-builder defaults `npmRebuild` on, so it ran
`@electron/rebuild` on node-pty, which invoked node-gyp to compile from source. The Windows runner has
no Visual Studio:

```
gyp verb find VS Failure details: RangeError [ERR_CHILD_PROCESS_STDIO_MAXBUFFER]: stdout maxBuffer length exceeded
Error: Could not find any Visual Studio installation to use
⨯ node-gyp failed to rebuild 'node-pty'  failedTask=build
```

That contradicts the project's own premise, which the test job already runs on: node-pty is Node-API
with prebuilds and needs no compiler. Fix: `npmRebuild: false`, so the prebuilt binary ships. The
setting is global, not per package, so it is only safe while every native dependency is Node-API with
prebuilds for every target arch. `native-prebuilds.test.ts` now enforces that, and the convention
records it, because the failure mode if it ever breaks is a bundle that ships and fails at runtime.

A second bug in the same leg, in the guard rather than the build: a Windows bundle ships node-pty's
darwin spawn-helpers too, in `prebuilds/`, at mode 0666, because they ship on every platform and
Windows never sets an execute bit it never needs. The bundle-check script classified the Windows
bundle as darwin by the presence of a spawn-helper and then failed on a helper Windows never runs. The
fix keys the bundle type on the `.app`, which only a darwin bundle has, so a Windows bundle takes the
not-applicable path and checks the Windows equivalent, that node-pty's `.node` modules are unpacked.

### Intel macOS is not a CI-verified target, 2026-08-09

The 7b.2 packaging matrix drops its darwin-x64 leg. Stated plainly, because a dropped leg is a
coverage gap and must not read as a decision nobody made.

- **Not a CI-verified target: Intel macOS.** Apple Silicon is the only darwin arch whose packaged
  build is exercised in CI.
- **Still asserted.** The darwin-x64 prebuild ships and `native-prebuilds.test.ts` asserts it exists
  for the target arch set. Its spawn-helper mode is read inside the arm64 bundle, which carries every
  platform's prebuilds: the arm64 packaging leg's bundle check reports
  `prebuilds/darwin-x64/spawn-helper` at 0755, confirmed 2026-08-09.
- **Not asserted.** A darwin-x64 bundle built and run on Intel hardware. Nothing executes on Intel.
- **Why dropped.** darwin-x64 needs a macos-13 runner, GitHub's Intel image, which is being wound
  down. The leg sat unallocated for over an hour. Not a packaging fault, a runner-class scarcity.
  Nothing is pinned to macos-13.
- **What brings it back.** A decision to ship Stafford for Intel Macs. Benzoo owns that and has not
  made it. Cross-packing x64 on an arm64 runner was considered and rejected: it would re-assert the
  same prebuilt helper the arm64 leg already checks, and would not run on Intel, so it would read as
  Intel coverage without being it.

**One dependency for whoever trims the bundles.** Trimming each platform's foreign prebuilds out of
its bundle is owed: a Windows bundle carries darwin spawn-helpers today and the darwin bundle carries
win32 binaries. If that trimming lands after this drop, the darwin-x64 spawn-helper stops being
asserted anywhere, because the arm64 bundle would no longer carry it. So the trimming task must either
keep the darwin-x64 prebuild in the arm64 bundle, or restore a darwin-x64 CI leg, or it silently
removes the only assertion of that helper.

### Task 8 pre-flight: better-sqlite3 ships under npmRebuild off, 2026-08-09

The lead question: can `better-sqlite3` ship when packaging never rebuilds native modules and the
Windows runner has no compiler. Yes. Task 8 proceeds as planned.

**It is Node-API.** `better-sqlite3@13.0.3` depends on `node-addon-api ^8.0.0`, the Node-API C++
wrapper, not NAN or raw V8. This is a change from older major versions, which used NAN and needed a
per-ABI rebuild.

**Its prebuilds are ABI-independent, one per platform-arch, bundled in the npm tarball.** Not on
GitHub releases, which carry no assets for v13.0.3. Inside `better-sqlite3-13.0.3.tgz`:

```
prebuilds/darwin-arm64.node
prebuilds/darwin-x64.node
prebuilds/win32-arm64.node
prebuilds/win32-x64.node
prebuilds/linux-arm64.node   linux-x64, linuxmusl-*, also present
```

The loader resolves them by platform and arch alone, with no Node ABI version and no Electron
variant, which is the Node-API property that makes one binary serve both runtimes:

```
lib/binding.js:  const filename = path.join(__dirname, '..', 'prebuilds', `${target}.node`);
lib/darwin-arm64.js:  require('../prebuilds/darwin-arm64.node')
```

**It needs no `@electron/rebuild`.** A Node-API prebuild is ABI-stable across Node and Electron, so
the binary that `npm ci` places loads inside Electron's Node without a rebuild, and electron-builder
with `npmRebuild: false` ships it as-is. There is no Visual Studio requirement, which is what Task
7b.2's failure was about. The one thing to watch, per the existing convention, is the Node-API
version: `node-addon-api ^8` targets Node-API 8 to 9, and Electron 43 bundles a Node that supports
it. Watch that pairing on any Electron or better-sqlite3 bump, not prebuild coverage.

**`node:sqlite` was not needed, and would not have been ready.** It is still marked experimental in
the Node that Electron 43 bundles, so a shipped app leaning on it would ship an experimental API. The
mature Node-API `better-sqlite3` avoids that.

**The native-prebuilds guard needs extending for Task 8, and is not extended here.** It was written
for node-pty's layout, `prebuilds/<os>-<arch>/<name>.node`, a directory per platform-arch. better-sqlite3
uses a flat file, `prebuilds/<os>-<arch>.node`, so the guard as written would look for a directory
that does not exist and fail on a module that is actually fine. When Task 8 adds better-sqlite3 to the
native externals, the guard must accept either shape: a directory `prebuilds/<os>-<arch>/` containing
a `.node`, or a flat `prebuilds/<os>-<arch>.node`. That is a guard change to make with the dependency,
not before it.

### 886 fires on every Windows teardown, and it already did before killTree was wired, 2026-08-10

The question was whether wiring `killTree` into teardown turned a rare race into a certainty. It is a
certainty, and the premise of the question is wrong: the control path was already a certainty. Both
arms, 50 iterations each, on a real pty on real Windows hardware.

```
control    iterations 50   agent forked 50   agent crashed 50   agent delivered list 0
treatment  iterations 50   agent forked 50   agent crashed 50   agent delivered list 0
```

`control` is `PtySession.kill()`, the unchanged path, on a shell that is alive when the call is made.
`treatment` is `PtySession.killWithTree()`, which reaps the tree first. Every teardown in both arms
forked `conpty_console_list_agent`, and every fork died with exit code 1 and no message. Zero
successes in 100 teardowns.

**The instrument can produce the other outcome, and that was checked before either arm ran.** A
measurement with one possible result is worthless, so the same agent module was forked by hand against
a shell that was still running:

```
CALIBRATION {"shellAlive":true,"exitCode":0,"list":[60332,8700,42620]}
```

Exit 0, a console process list of three. So `agentCrashed 50` is a finding rather than a broken probe.

**Why the control arm is not a race.** Read the order in `windowsPtyAgent.js` kill: it calls
`_getConsoleProcessList()`, which `fork`s the agent, and then synchronously calls
`_ptyNative.kill(...)` on the next line. Forking a node process costs about 70ms before its first line
runs, and the synchronous kill takes the ConPTY down in about 10ms. So `AttachConsole` is called
against a dead shell every time, by construction, whatever the caller did. Measured, both arms:

```
control    agent lifetime ms  min 64.2  median 69.2  max 94.9   teardown ms  min 9.1   median 10.0
treatment  agent lifetime ms  min 61.9  median 70.6  max 330.8  teardown ms  min 866.3 median 937.2
```

The agent never survives long enough for the outcome to depend on anything.

**This reconciles with the one-in-nine figure rather than contradicting it, because they count
different things.** One in nine was the rate at which a Windows CI *run* went red. This is the rate at
which the crash *happens*. Direct evidence that the two are not the same quantity, from this machine:
one green `npm test` produced

```
AttachConsole failures in one green suite run: 26
ℹ tests 194   pass 193   fail 0   skipped 1
```

Twenty-six crashes and the run passed. What decides whether a crash reaches the test runner's verdict
was not measured here and should not be guessed at; what is settled is that occurrence is not the
variable.

**So killWithTree did not make 886 worse. It could not have.** The entry of 2026-08-09 predicted from
source that the wiring would turn a race into a per-teardown certainty. The prediction about the
treatment arm is confirmed and the assumption about the baseline is refuted: the baseline was already
100 percent. The wiring changed nothing about 886's frequency, on either path.

**Nothing reaches the parent process.** Across 100 teardowns: zero uncaught exceptions, zero unhandled
rejections, zero throws out of the teardown call, and the session exit event arrived every time.
`reachedParent: []`. The source read that said node-pty's promise always resolves and the crash stays
contained holds under measurement.

**No orphans, in either arm.** Each iteration ran a pty shell that spawned one console grandchild and
blocked, and both pids were checked by pid after teardown, not inferred:

```
control    shell orphans 0   grandchild orphans 0   exit event missing 0
treatment  shell orphans 0   grandchild orphans 0   exit event missing 0
```

Stray `node.exe` count was 14 before the run and 13 after, so the run left nothing behind. This is the
exposure `killWithTree` was wired to close, and on this hardware it is closed on both paths: node-pty's
own kill still reaps the console list through the timeout fallback when the shell is alive, and
`taskkill /T` reaps the tree when it is not. The orphan risk described from source on 2026-08-08 did
not reproduce here.

**The cost per occurrence, measured rather than reasoned about.** Three separate numbers, and only the
third is 886's:

- Teardown wall-clock. Control 10.0ms median, 13.5ms max. Treatment 937.2ms median, 1202.6ms max. The
  difference is `killTree`, not 886: its executor waits a 500ms settle and then runs `taskkill`. That is
  a second of latency on every Windows session teardown, paid to close an orphan risk that did not
  reproduce in this measurement.
- Session exit event. Control 91.8ms median. Treatment 1428.3ms median.
- The five-second fallback timer is real and is not unref'd. After the last teardown the probe could do
  no more work and still could not exit:

```
after the last teardown, this process could not exit for a further 1297ms, which is 5930ms after the
teardown call.
```

  It holds the event loop for the balance of five seconds from the kill. It does not block the teardown
  call, which returns long before, so it is a background cost rather than a user-facing delay, and one
  crashed helper process per teardown that exits in about 70ms with no accumulation.

**What this does to the pin exit condition. It stays, and its wording is now wrong.** Section 9 of the
migration plan states the third exit as 886 "fixed, or confirmed absent", and describes the crash as
happening "when the shell has already exited". That reads as a condition that sometimes holds. On this
hardware it always holds, on every ConPTY kill, including the plain one. The exit condition itself is
unchanged and the pin is not touched: 1.1.0 stays, and 886 is still unfixed upstream. The phrasing is
owed a correction, which belongs with whoever next edits that section rather than in this entry.

**What this does to the `useConptyDll` question.** It weakens the argument that was made for it on
2026-08-09. That argument was that wiring killWithTree had promoted the agent crash from rare to
per-teardown, so the DLL path now removed a real production cost. The promotion never happened, so the
DLL path removes a cost that was already being paid on 1.1.0 before any of this work, at the same rate.
It still removes it, and the per-teardown cost is real: a crashed helper and a five-second background
timer on every session kill on a machine cycling sessions all day. The case is unchanged in size rather
than strengthened, and it stays a spike to schedule rather than a change to make. Not adopted here.

**Machine.**

```
{"node":"v26.0.0","os":"10.0.26200","arch":"x64","windowsBuild":26200,"nodePty":"1.1.0","iterations":50}
Windows 11, build 26200. No Visual Studio, no MSVC, no Windows SDK.
```

Build 26200 is well past 18309, so node-pty takes the ConPTY non-DLL path, which is the one that forks
the agent.

**Raw failure, once, identical on all 100.** The repository path is replaced with `<repo>` here; it is
otherwise verbatim.

```
<repo>\node_modules\node-pty\lib\conpty_console_list_agent.js:13
var consoleProcessList = getConsoleProcessList(shellPid);
                         ^

Error: AttachConsole failed
    at Object.<anonymous> (<repo>\node_modules\node-pty\lib\conpty_console_list_agent.js:13:26)
    at Module._compile (node:internal/modules/cjs/loader:1829:14)
    at Object..js (node:internal/modules/cjs/loader:1969:10)
    at Module.load (node:internal/modules/cjs/loader:1552:32)
    at Module._load (node:internal/modules/cjs/loader:1354:12)
    at wrapModuleLoad (node:internal/modules/cjs/loader:255:19)
    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)
    at node:internal/main/run_main_module:33:47

Node.js v26.0.0
```

**Raw rows, one per arm, verbatim from the run.**

```
control 000 {"arm":"control","index":0,"shellPid":29196,"grandPid":41900,"ptyPid":29196,"forks":1,
"agentGotMessage":false,"agentExitCode":1,"agentSignal":null,"agentLifetimeMs":83.3,"crashed":true,
"teardownMs":12.3,"exitEventMs":97.1,"exitOutcome":"exit","shellSurvived":false,"grandSurvived":false,
"ptySurvived":false,"threw":null}

treatment 000 {"arm":"treatment","index":0,"shellPid":65544,"grandPid":66096,"ptyPid":65544,"forks":1,
"agentGotMessage":false,"agentExitCode":1,"agentSignal":null,"agentLifetimeMs":69.6,"crashed":true,
"teardownMs":989.3,"exitEventMs":1466.1,"exitOutcome":"exit","shellSurvived":false,"grandSurvived":false,
"ptySurvived":false,"threw":null}
```

#### The probe

Three files, run from a scratch directory outside the repository, per the probe rule. It writes nothing
into the tree and takes the repository root as an argument, so it carries no machine path:

```
node probe.mjs <repo-root> 50
```

`pty-grandchild.mjs`:

```js
// A console grandchild that never exits on its own.
// It inherits the shell's stdio, so it is attached to the same ConPTY console
// and therefore appears in the console process list node-pty asks for.
setInterval(() => {}, 1 << 30);
```

`pty-shell.mjs`:

```js
// The process the pty runs. Spawns one console grandchild, announces both pids,
// then blocks. Stands in for an agent that has a tool child running.
import { spawn } from 'node:child_process';

const grandchild = spawn(process.execPath, [process.argv[2]], { stdio: 'inherit' });

process.stdout.write('PIDS ' + process.pid + ' ' + grandchild.pid + '\r\n');

setInterval(() => {}, 1 << 30);
```

`probe.mjs`:

```js
/**
 * node-pty #886 on Windows: two arms, measured.
 *
 * Runs outside the repository and mutates nothing in it. It reads two modules
 * from the tree (PtySession and the win32 platform) and node-pty from the
 * tree's node_modules, so it exercises the shipped teardown path rather than a
 * copy of it.
 *
 *   node probe.mjs <repo-root> <iterations>
 *
 * Arm A, control:    PtySession.kill(), node-pty's own kill on a live shell.
 * Arm B, treatment:  PtySession.killWithTree(), which reaps the tree first, so
 *                    node-pty's kill always sees a shell that is already dead.
 *
 * What is counted, per iteration:
 *   - whether node-pty forked conpty_console_list_agent, and how that fork ended.
 *     A fork that delivers a message did its job. A fork that exits non-zero is
 *     886. The distinction is read from the child, not from a log line.
 *   - teardown wall-clock, from the teardown call to its return.
 *   - time from the teardown call to the session's exit event.
 *   - whether the shell and its console grandchild are still alive afterwards,
 *     checked by pid rather than inferred.
 *   - anything that reaches this process: an uncaught exception, an unhandled
 *     rejection, or a throw out of the teardown call.
 *
 * Nothing here retries and nothing here skips.
 */

import childProcess from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const REPO = path.resolve(process.argv[2] ?? '');
const ITERATIONS = Number(process.argv[3] ?? 50);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.join(HERE, 'pty-shell.mjs');
const GRANDCHILD = path.join(HERE, 'pty-grandchild.mjs');

const SETTLE_AFTER_TEARDOWN_MS = 2000;
const READY_TIMEOUT_MS = 15000;
const EXIT_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Observation. Wraps fork to watch node-pty's console-list agent. It records
// what the agent did and changes nothing about how it is spawned.
// ---------------------------------------------------------------------------

let forkLog = [];
const realFork = childProcess.fork;
childProcess.fork = function observedFork(modulePath, args, options) {
    const child = realFork.call(this, modulePath, args, options);
    if (String(modulePath).includes('conpty_console_list_agent')) {
        const record = {
            pid: child.pid,
            forkedAt: performance.now(),
            gotMessage: false,
            exitCode: null,
            signal: null,
            exitedAt: null
        };
        forkLog.push(record);
        child.once('message', () => { record.gotMessage = true; });
        child.once('exit', (code, signal) => {
            record.exitCode = code;
            record.signal = signal;
            record.exitedAt = performance.now();
        });
    }
    return child;
};

// ---------------------------------------------------------------------------
// Anything that reaches this process. Recorded rather than swallowed silently:
// the run reports a non-zero exit if either list is non-empty.
// ---------------------------------------------------------------------------

let lastTeardownStartedAt = 0;
const reachedParent = [];
process.on('uncaughtException', (error) => {
    reachedParent.push({ kind: 'uncaughtException', message: String(error && error.message), stack: String(error && error.stack) });
});
process.on('unhandledRejection', (reason) => {
    reachedParent.push({ kind: 'unhandledRejection', message: String(reason) });
});

// ---------------------------------------------------------------------------

const require = createRequire(path.join(REPO, 'package.json'));
const nodePty = require('node-pty');

const { PtySession } = await import(pathToFileURL(path.join(REPO, 'src', 'main', 'agents', 'pty-session.ts')).href);
const { win32 } = await import(pathToFileURL(path.join(REPO, 'src', 'main', 'platform', 'win32.ts')).href);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function reap(pid) {
    if (!pid) return;
    try {
        childProcess.execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
        // Already gone is the expected case.
    }
}

function strayCount() {
    const out = childProcess.execFileSync('tasklist', ['/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    return out.split('\n').filter((line) => line.trim().length > 0).length;
}

function newSession(id) {
    return new PtySession({
        agentId: id,
        platform: win32,
        file: process.execPath,
        args: [SHELL, GRANDCHILD],
        cwd: HERE,
        env: {
            PATH: process.env.PATH ?? '',
            SystemRoot: process.env.SystemRoot ?? '',
            windir: process.env.windir ?? '',
            TEMP: process.env.TEMP ?? ''
        },
        spawn: (file, args, options) => nodePty.spawn(file, [...args], options)
    });
}

/** One iteration. `arm` is 'control' or 'treatment'. */
async function runOnce(arm, index) {
    forkLog = [];

    const session = newSession(arm + '-' + index);
    let shellPid = null;
    let grandPid = null;
    let exitAt = null;
    let threw = null;

    const ready = new Promise((resolve, reject) => {
        let seen = '';
        const timer = setTimeout(() => reject(new Error('no PIDS line within ' + READY_TIMEOUT_MS + 'ms')), READY_TIMEOUT_MS);
        session.subscribe((data) => {
            seen += data;
            const match = /PIDS (\d+) (\d+)/.exec(seen);
            if (match) {
                clearTimeout(timer);
                shellPid = Number(match[1]);
                grandPid = Number(match[2]);
                resolve();
            }
        });
    });

    const exited = new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), EXIT_TIMEOUT_MS);
        session.once('exit', () => {
            clearTimeout(timer);
            exitAt = performance.now();
            resolve('exit');
        });
    });

    session.start();
    await ready;

    const ptyPid = session.pid;
    const startedAt = performance.now();
    lastTeardownStartedAt = startedAt;
    try {
        if (arm === 'control') session.kill();
        else await session.killWithTree();
    } catch (error) {
        threw = { message: String(error && error.message), stack: String(error && error.stack) };
    }
    const teardownReturnedAt = performance.now();

    const exitOutcome = await exited;
    await wait(SETTLE_AFTER_TEARDOWN_MS);

    const shellSurvived = alive(shellPid);
    const grandSurvived = alive(grandPid);
    const ptySurvived = alive(ptyPid);

    // Leave nothing behind, whatever the arm did. A probe that leaks processes
    // poisons every measurement after it.
    reap(shellPid);
    reap(grandPid);
    reap(ptyPid);

    const fork = forkLog[0] ?? null;

    return {
        arm,
        index,
        shellPid,
        grandPid,
        ptyPid,
        forks: forkLog.length,
        agentGotMessage: fork ? fork.gotMessage : null,
        agentExitCode: fork ? fork.exitCode : null,
        agentSignal: fork ? fork.signal : null,
        agentLifetimeMs: fork && fork.exitedAt !== null ? Number((fork.exitedAt - fork.forkedAt).toFixed(1)) : null,
        crashed: fork ? fork.gotMessage === false && fork.exitCode !== 0 : false,
        teardownMs: Number((teardownReturnedAt - startedAt).toFixed(1)),
        exitEventMs: exitAt === null ? null : Number((exitAt - startedAt).toFixed(1)),
        exitOutcome,
        shellSurvived,
        grandSurvived,
        ptySurvived,
        threw
    };
}

function summarise(arm, rows) {
    const teardowns = rows.map((r) => r.teardownMs).sort((a, b) => a - b);
    const exits = rows.map((r) => r.exitEventMs).filter((v) => v !== null).sort((a, b) => a - b);
    const pick = (list, q) => (list.length === 0 ? null : list[Math.min(list.length - 1, Math.floor(list.length * q))]);
    return {
        arm,
        iterations: rows.length,
        forkedAgent: rows.filter((r) => r.forks > 0).length,
        agentCrashed: rows.filter((r) => r.crashed).length,
        agentDeliveredList: rows.filter((r) => r.agentGotMessage === true).length,
        shellOrphans: rows.filter((r) => r.shellSurvived).length,
        grandchildOrphans: rows.filter((r) => r.grandSurvived).length,
        exitEventMissing: rows.filter((r) => r.exitOutcome !== 'exit').length,
        threwOutOfTeardown: rows.filter((r) => r.threw !== null).length,
        teardownMsMedian: pick(teardowns, 0.5),
        teardownMsMax: teardowns[teardowns.length - 1] ?? null,
        exitEventMsMedian: pick(exits, 0.5),
        exitEventMsMax: exits[exits.length - 1] ?? null
    };
}

// ---------------------------------------------------------------------------

const machine = {
    node: process.version,
    os: os.release(),
    arch: process.arch,
    windowsBuild: Number((/(\d+)\.(\d+)\.(\d+)/.exec(os.release()) ?? [])[3] ?? 0),
    nodePty: require('node-pty/package.json').version,
    iterations: ITERATIONS
};

console.log('machine ' + JSON.stringify(machine));
console.log('stray node.exe before: ' + strayCount());

/**
 * Instrument check, before either arm.
 *
 * Both arms below report the agent crashing, and a measurement that only ever
 * produces one outcome is indistinguishable from an instrument that cannot
 * produce the other. So the same agent module is forked by hand against a shell
 * that is still alive, which is the case node-pty's kill path is trying to hit.
 * It must deliver a console process list and exit 0. If it does not, nothing
 * below means anything.
 */
async function calibrate() {
    const session = newSession('calibration');
    const ready = new Promise((resolve) => { session.subscribe((d) => { if (/PIDS/.test(d)) resolve(); }); });
    session.start();
    await ready;

    const agentModule = path.join(REPO, 'node_modules', 'node-pty', 'lib', 'conpty_console_list_agent.js');
    const outcome = await new Promise((resolve) => {
        const child = realFork.call(childProcess, agentModule, [String(session.pid)]);
        let list = null;
        child.once('message', (message) => { list = message.consoleProcessList; });
        child.once('exit', (code) => resolve({ exitCode: code, list }));
    });

    session.kill();
    await wait(SETTLE_AFTER_TEARDOWN_MS);
    reap(session.pid);

    return { shellAlive: true, ...outcome };
}

const calibration = await calibrate();
console.log('CALIBRATION ' + JSON.stringify(calibration));
if (calibration.exitCode !== 0 || calibration.list === null) {
    console.log('CALIBRATION FAILED: the agent cannot succeed even against a live shell, so a crash count below proves nothing.');
    process.exitCode = 1;
}

const results = { control: [], treatment: [] };

for (const arm of ['control', 'treatment']) {
    for (let i = 0; i < ITERATIONS; i += 1) {
        const row = await runOnce(arm, i);
        results[arm].push(row);
        console.log(arm + ' ' + String(i).padStart(3, '0') + ' ' + JSON.stringify(row));
    }
}

const workFinishedAt = performance.now();

console.log('stray node.exe after: ' + strayCount());

const summary = {
    machine,
    calibration,
    control: summarise('control', results.control),
    treatment: summarise('treatment', results.treatment),
    reachedParent
};

console.log('SUMMARY ' + JSON.stringify(summary, null, 2));

fs.writeFileSync(path.join(HERE, 'result.json'), JSON.stringify({ summary, rows: results }, null, 2));

// The last teardown leaves node-pty's five-second fallback timer pending, and
// it is not unref'd. If that is true, this process cannot exit before it fires,
// and the delta below is the measurement of it.
process.on('exit', () => {
    const idleMs = performance.now() - workFinishedAt;
    const sinceTeardownMs = performance.now() - lastTeardownStartedAt;
    console.log('after the last teardown, this process could not exit for a further ' + idleMs.toFixed(0) +
        'ms, which is ' + sinceTeardownMs.toFixed(0) + 'ms after the teardown call.');
});

process.exitCode = reachedParent.length === 0 ? 0 : 1;
```

**What this probe cannot answer.** Whether a crashed agent fails a `node --test` run, and why that
happens on some runs and not others. The probe counts occurrences, and occurrence turned out not to be
the variable. Answering it means instrumenting the test runner's own child handling, on a run that is
red, which needs a red run to look at. Not attempted here, and not simulated.

**The orphan row above is not a finding, and the entry below replaces it.** Its workload spawned a
console child inside the pty shell's own pid tree, which both teardowns reach, so zero orphans could
mean either that the teardown worked or that nothing orphanable existed. Those are opposite
conclusions from the same zero.

### killWithTree reaps an off-console descendant, and no console grandchild was ever orphaned, 2026-08-10

The question the previous entry could not answer: on Windows, does `killWithTree` reap something
`kill()` leaves running. Yes, on one of three workloads, and it is not the one the wiring was
justified by.

```
cell                       created  alive at 2s  alive at 7s  shell alive at 7s
console-child/control       15/15        0            0             0
console-child/treatment     15/15        0            0             0
console-orphan/control      15/15        0            0             0
console-orphan/treatment    15/15        0            0             0
tree-detached/control       15/15       15           15             0
tree-detached/treatment     15/15        0            0             0
```

`created` counts iterations where the long-lived process was confirmed alive by pid immediately before
the teardown. It is 15 of 15 everywhere, so every zero below it is something being killed rather than
something never existing. That column is the whole reason this entry replaces the previous one.

**The answer, plainly. `killWithTree` reaps a descendant that `kill()` leaves running, 15 out of 15,
and that descendant is not attached to the console.** A console grandchild was never orphaned by
either path, so the console case did not need reaping and the exposure named in `PtySession`'s own
doc comment did not reproduce.

**Three workloads, because the two teardown mechanisms enumerate different sets.** `taskkill /T` walks
parent to child. node-pty's console list enumerates what is attached to the ConPTY console. A process
can be in either set, both, or neither:

- `console-child`, attached to the console and inside the shell's pid tree, which both mechanisms
  reach. This is what the first probe used, and why its zero said nothing.
- `console-orphan`, attached to the console and outside the pid tree, because the `cmd` that launched
  it exits at once. `taskkill /T` cannot reach it. This is the shape node-pty's console list exists
  for and the shape 886 breaks the handling of.
- `tree-detached`, inside the pid tree and off the console. The console list cannot reach it.

**The mechanism that reaps console processes is the ConPTY teardown, not the console list.** Every
console-attached process was dead at the 2 second check, in both arms, including the ones outside the
pid tree that `taskkill /T` provably cannot reach and that the crashed console-list agent never
enumerated. The 2 second and 7 second checks exist to separate this from node-pty's five-second
fallback, and nothing changed between them in any cell. So closing the pseudoconsole takes the
attached processes down on its own, and 886 destroying the console list costs nothing here.

**That refutes the damage claim recorded on 2026-08-08.** That entry read, from node-pty source, that
886's fallback could leave "console grandchildren that would have been in the full list" as orphans.
On this hardware they are not orphaned, because the fallback is not what was keeping them from being
orphans. The reasoning was sound and the premise was wrong, which is the same shape as the one-in-nine
correction above it.

**A Node shell cannot produce an orphan on Windows at all, which is why the first probe's workload was
incapable of the measurement.** libuv puts every non-detached child in a global job object with
`KILL_ON_JOB_CLOSE`, so the child dies when its parent does, before node-pty or Windows has a say.
Measured directly while building this probe: a middle process spawning a child with `stdio: 'inherit'`
and exiting left nothing behind, outside any pty.

```
announced: GRAND 41840
DEAD
INFO: No tasks are running which match the specified criteria.
```

So the shell here is `cmd.exe`, which creates no such job object. This is worth carrying forward past
this measurement: a real agent is not a Node process spawning Node children, so nothing it spawns is
protected by that job object, and any future probe that uses a Node shell will measure libuv rather
than the product.

**What this licenses, and what it does not.**

It licenses saying that `killWithTree` buys something real on Windows: an off-console descendant
survives node-pty's kill completely, 15 out of 15, and `taskkill /T` is what reaches it. The wiring is
not decorative on this platform.

It does not license the reason currently written in the code. `PtySession.killWithTree`'s doc comment
justifies the Windows half by 886 orphaning console grandchildren, and that did not happen. The honest
Windows justification is the off-console descendant, which has nothing to do with 886. Correcting that
comment is owed and is not done here, because this task was not permitted to touch the kill path.

It does not license removing anything. The POSIX case is separate and already measured: the tool child
leads its own process group and a shell kill never reaches it.

It does not license "Windows agents leave nothing behind". This was measured with `cmd.exe` as the
shell and Node processes as the workload, on one Windows build. A real agent spawning a real tool
child is a shape nobody has run this against, and the console-attached result depends on the ConPTY
teardown behaviour of this build rather than on anything in this project.

**Teardown cost, unchanged from the first probe and measured again here.**

```
control    teardown ms  min 8.7    median 12.3   max 119.6
treatment  teardown ms  min 869.1  median 953.8  max 1209.5
```

Nothing reached the parent process in 90 iterations: `reachedParent: []`, zero missing exit events,
zero throws. Stray `node.exe` count was 14 before the run and 14 after.

**Owed: justify or shrink the 500ms settle.** `killTree`'s executor waits `settleMs`, defaulting to
500, and then on Windows re-reads a process table that `win32.processTreeCommand()` returns null for,
so the survivor list is empty by construction and the wait informs nothing on this platform. It is
most of the difference between a 12ms teardown and a 954ms one. What would justify keeping it is a
measurement showing `taskkill /T` returning before the tree is actually gone, which is plausible and
has never been checked; the check is to poll the pids after `taskkill` returns and record how long
they stay alive. Until that exists the constant is a leftover rather than a decision. Not changed
here.

**Raw rows, one per interesting cell, verbatim.**

```
console-child control 00 {"arm":"control","shape":"console-child","index":0,"shellPid":4188,
"grandPid":53840,"grandAliveBefore":true,"shellAliveBefore":true,"grandAliveEarly":false,
"shellAliveEarly":false,"grandAliveLate":false,"shellAliveLate":false,"teardownMs":10.3,
"exitOutcome":"exit","threw":null}

console-orphan control 00 {"arm":"control","shape":"console-orphan","index":0,"shellPid":17488,
"grandPid":64812,"grandAliveBefore":true,"shellAliveBefore":true,"grandAliveEarly":false,
"shellAliveEarly":false,"grandAliveLate":false,"shellAliveLate":false,"teardownMs":12.6,
"exitOutcome":"exit","threw":null}

tree-detached control 00 {"arm":"control","shape":"tree-detached","index":0,"shellPid":9672,
"grandPid":16360,"grandAliveBefore":true,"shellAliveBefore":true,"grandAliveEarly":true,
"shellAliveEarly":false,"grandAliveLate":true,"shellAliveLate":false,"teardownMs":13.2,
"exitOutcome":"exit","threw":null}

tree-detached treatment 00 {"arm":"treatment","shape":"tree-detached","index":0,"shellPid":11536,
"grandPid":3948,"grandAliveBefore":true,"shellAliveBefore":true,"grandAliveEarly":false,
"shellAliveEarly":false,"grandAliveLate":false,"shellAliveLate":false,"teardownMs":924,
"exitOutcome":"exit","threw":null}
```

#### The orphan probe

Same scratch directory outside the repository, same invocation shape:

```
node orphan-probe.mjs <repo-root> 15
```

`announce.mjs`, the long-lived process:

```js
// A long-lived console process that announces its own pid on the console it is
// attached to, so the probe reads the pid off the pty stream rather than
// guessing it from a process table.
import fs from 'node:fs';

fs.writeSync(1, 'GRAND ' + process.pid + '\r\n');
setInterval(() => {}, 1 << 30);
```

`spawn-detached.mjs`, which builds the off-console shape:

```js
// Spawns a process that leaves the ConPTY console but stays a descendant of the
// pty shell, then announces it and keeps running.
//
// `detached: true` is what takes it off the console, and it is also what keeps
// it out of libuv's global job object. That job object is why a plain Node
// child cannot be used to build an orphan: libuv puts every non-detached child
// in a job with KILL_ON_JOB_CLOSE, so it dies with its parent regardless of
// anything Windows or node-pty does.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const child = spawn(process.execPath, [process.argv[2]], { detached: true, stdio: 'ignore' });
child.unref();

fs.writeSync(1, 'GRAND ' + child.pid + '\r\n');
setInterval(() => {}, 1 << 30);
```

`orphan-probe.mjs`:

```js
/**
 * Does killWithTree reap a Windows console grandchild that kill() leaves running?
 *
 * The first probe reported no orphans in either arm and that zero was not a
 * finding. Its workload spawned a console child sitting inside the pty shell's
 * own pid tree, which both teardowns reach. Absence of orphans is only evidence
 * when something was there to be orphaned.
 *
 * The shell is `cmd.exe` here rather than node, and that is not cosmetic. A Node
 * parent cannot produce an orphan on Windows at all: libuv puts every
 * non-detached child in a global job object with KILL_ON_JOB_CLOSE, so the child
 * dies when its parent does, before node-pty or Windows gets a say. Measured
 * while building this. So the first probe's grandchild was never orphanable, and
 * a real agent, which is not a Node process spawning Node children, is not
 * protected by that job object either.
 *
 * Three workloads, chosen so the two teardown mechanisms disagree. taskkill /T
 * walks parent to child. node-pty's console list enumerates what is attached to
 * the console. They are different sets:
 *
 *   console-child   attached to the console, inside the shell's pid tree.
 *                   Both mechanisms reach it.
 *   console-orphan  attached to the console, outside the shell's pid tree,
 *                   because the cmd that launched it exits at once. taskkill /T
 *                   cannot reach it. Only the console list can. This is the
 *                   shape node-pty's console list exists for, and the shape 886
 *                   breaks the handling of.
 *   tree-detached   inside the shell's pid tree, off the console. The console
 *                   list cannot reach it. Only taskkill /T can.
 *
 *   node orphan-probe.mjs <repo-root> <iterations-per-cell>
 *
 * Liveness is checked by pid three times per iteration: before the teardown, so
 * that a zero afterwards means something was actually killed rather than never
 * created; at 2 seconds, which is before node-pty's five-second console-list
 * fallback can have fired; and at 7 seconds, which is after it. The two windows
 * separate the ConPTY teardown from the fallback, which one check cannot.
 *
 * Nothing here retries and nothing here skips.
 */

import childProcess from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const REPO = path.resolve(process.argv[2] ?? '');
const ITERATIONS = Number(process.argv[3] ?? 15);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANNOUNCE = path.join(HERE, 'announce.mjs');
const SPAWN_DETACHED = path.join(HERE, 'spawn-detached.mjs');

const NODE = process.execPath;
const q = (value) => '"' + value + '"';

/** The command written into cmd.exe, per workload. */
const WORKLOADS = {
    'console-child': 'start "" /b ' + q(NODE) + ' ' + q(ANNOUNCE),
    'console-orphan': 'cmd /c start "" /b ' + q(NODE) + ' ' + q(ANNOUNCE),
    'tree-detached': 'start "" /b ' + q(NODE) + ' ' + q(SPAWN_DETACHED) + ' ' + q(ANNOUNCE)
};

const SHAPES = Object.keys(WORKLOADS);
const ARMS = ['control', 'treatment'];

const EARLY_CHECK_MS = 2000;
const LATE_CHECK_MS = 5000;
const READY_TIMEOUT_MS = 20000;
const EXIT_TIMEOUT_MS = 15000;

const reachedParent = [];
process.on('uncaughtException', (error) => {
    reachedParent.push({ kind: 'uncaughtException', message: String(error && error.message) });
});
process.on('unhandledRejection', (reason) => {
    reachedParent.push({ kind: 'unhandledRejection', message: String(reason) });
});

const require = createRequire(path.join(REPO, 'package.json'));
const nodePty = require('node-pty');
const { PtySession } = await import(pathToFileURL(path.join(REPO, 'src', 'main', 'agents', 'pty-session.ts')).href);
const { win32 } = await import(pathToFileURL(path.join(REPO, 'src', 'main', 'platform', 'win32.ts')).href);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function reap(pid) {
    if (!pid) return;
    try {
        childProcess.execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
        // Already gone is the expected case.
    }
}

function strayCount() {
    const out = childProcess.execFileSync('tasklist', ['/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    return out.split('\n').filter((line) => line.trim().length > 0).length;
}

async function runOnce(arm, shape, index) {
    const session = new PtySession({
        agentId: arm + '-' + shape + '-' + index,
        platform: win32,
        file: process.env.COMSPEC ?? 'cmd.exe',
        args: ['/q', '/k', '@echo off'],
        cwd: HERE,
        env: {
            PATH: process.env.PATH ?? '',
            SystemRoot: process.env.SystemRoot ?? '',
            windir: process.env.windir ?? '',
            COMSPEC: process.env.COMSPEC ?? '',
            TEMP: process.env.TEMP ?? ''
        },
        spawn: (file, args, options) => nodePty.spawn(file, [...args], options)
    });

    let grandPid = null;
    let threw = null;

    const announced = new Promise((resolve, reject) => {
        let seen = '';
        const timer = setTimeout(() => reject(new Error('workload never announced a pid, saw: ' + JSON.stringify(seen.slice(-400)))), READY_TIMEOUT_MS);
        session.subscribe((data) => {
            seen += data;
            const match = /GRAND (\d+)/.exec(seen);
            if (match) {
                clearTimeout(timer);
                grandPid = Number(match[1]);
                resolve();
            }
        });
    });

    const exited = new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), EXIT_TIMEOUT_MS);
        session.once('exit', () => { clearTimeout(timer); resolve('exit'); });
    });

    session.start();
    const shellPid = session.pid;

    // Let cmd reach its prompt, then run the workload. Written raw rather than
    // through submit(): cmd.exe does not enable bracketed paste, so the reason
    // submit() exists does not apply here.
    await wait(400);
    session.write(WORKLOADS[shape] + '\r');

    await announced;
    await wait(500);

    const grandAliveBefore = alive(grandPid);
    const shellAliveBefore = alive(shellPid);

    const startedAt = performance.now();
    try {
        if (arm === 'control') session.kill();
        else await session.killWithTree();
    } catch (error) {
        threw = String(error && error.message);
    }
    const teardownMs = Number((performance.now() - startedAt).toFixed(1));

    const exitOutcome = await exited;

    await wait(EARLY_CHECK_MS);
    const grandAliveEarly = alive(grandPid);
    const shellAliveEarly = alive(shellPid);

    await wait(LATE_CHECK_MS);
    const grandAliveLate = alive(grandPid);
    const shellAliveLate = alive(shellPid);

    reap(grandPid);
    reap(shellPid);

    return {
        arm, shape, index, shellPid, grandPid,
        grandAliveBefore, shellAliveBefore,
        grandAliveEarly, shellAliveEarly,
        grandAliveLate, shellAliveLate,
        teardownMs, exitOutcome, threw
    };
}

function summarise(rows) {
    return {
        iterations: rows.length,
        grandchildrenCreated: rows.filter((r) => r.grandAliveBefore).length,
        survivingAt2s: rows.filter((r) => r.grandAliveEarly).length,
        survivingAt7s: rows.filter((r) => r.grandAliveLate).length,
        shellsSurvivingAt7s: rows.filter((r) => r.shellAliveLate).length,
        exitEventMissing: rows.filter((r) => r.exitOutcome !== 'exit').length,
        threw: rows.filter((r) => r.threw !== null).length
    };
}

const machine = {
    node: process.version,
    os: os.release(),
    arch: process.arch,
    windowsBuild: Number((/(\d+)\.(\d+)\.(\d+)/.exec(os.release()) ?? [])[3] ?? 0),
    nodePty: require('node-pty/package.json').version,
    iterationsPerCell: ITERATIONS
};

console.log('machine ' + JSON.stringify(machine));
console.log('stray node.exe before: ' + strayCount());

const rows = [];
for (const shape of SHAPES) {
    for (const arm of ARMS) {
        for (let i = 0; i < ITERATIONS; i += 1) {
            const row = await runOnce(arm, shape, i);
            rows.push(row);
            console.log(shape + ' ' + arm + ' ' + String(i).padStart(2, '0') + ' ' + JSON.stringify(row));
        }
    }
}

console.log('stray node.exe after: ' + strayCount());

const summary = { machine, cells: {}, reachedParent };
for (const shape of SHAPES) {
    for (const arm of ARMS) {
        summary.cells[shape + '/' + arm] = summarise(rows.filter((r) => r.shape === shape && r.arm === arm));
    }
}

console.log('SUMMARY ' + JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(HERE, 'orphan-result.json'), JSON.stringify({ summary, rows }, null, 2));

process.exitCode = reachedParent.length === 0 ? 0 : 1;
```
