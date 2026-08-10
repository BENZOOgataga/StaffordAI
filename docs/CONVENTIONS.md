# Conventions

Short, and every entry is here because getting it wrong is expensive or silent.

---

## Imports carry the `.ts` extension

```ts
import { classifyExit } from './trust.ts'   // yes
import { classifyExit } from './trust.js'   // no
import { classifyExit } from './trust'      // no
```

Node runs TypeScript directly by stripping types, and its resolver does not rewrite
extensions. The TypeScript habit of importing `./foo.js` to mean `./foo.ts` does not resolve,
and it fails at runtime rather than at type-check time, so a type check passes and the test
run does not.

Measured during Task 0. Output in `docs/stack-migration-verification.md`.

`allowImportingTsExtensions` is on for this reason, which requires `noEmit`. That is fine
here: `electron-vite` does the bundling and `tsc` only ever type checks.

---

## Tests run against source, with no build step

```
npm test
```

runs `node --test` over `runner/*.test.js` and `src/**/*.test.ts` together. There is no
compile step in the loop, so a test failure points at a line you wrote.

**`--test-force-exit` must not come back.** It was in the test script, it was hiding a handle
leak that reproduced only on the path a long-running runner takes most often, and the leak is
fixed. If the suite passes and then hangs, something is holding the event loop open and that
is the signal working. See `docs/pty-runner-verification.md`.

Three separate defects have now surfaced as a hanging test file, and every one would have been
invisible under the flag: the conout worker leak, a listener `close()` that waited for open
connections, and a refused connection that was never tracked so `close()` waited on it forever.
That last one matters more than it sounds. On a pipe where Everyone has read access, waiting
politely for a connection anyone on the machine can hold open is a denial of service against the
runner rather than an inconvenience.

---

## The root is ESM, and `.cjs` means a file still needs `require`

The root `package.json` is `type: module`. `src/package.json` is gone: it existed only to make
`src/` ESM while the root was still `commonjs`, and it was deleted in 6b commit 3 by the deadline
test that had been waiting for exactly that.

**A `.cjs` extension is now a statement, not a leftover.** It says this file still uses `require`
and has not been ported. Four were renamed at the flip rather than converted, because converting a
working instrument in the same commit that changes the module system for every file would make a
failure impossible to attribute:

```
scripts/run-tests.cjs                  npm test
scripts/loop-pty-tests.cjs             how races get found
.github/probes/pty-probe.cjs           the CI pty diagnostic
hooks/claude-hook.cjs                  runs on a user's machine
scripts/macos-harness/run.cjs          the macOS harness
```

Two `.js` files survive and both are deliberate. `runner/fixtures/pty-child.js` uses no CommonJS at
all, so it runs as ESM unchanged. `scripts/macos-harness/electron-app/` has its own `package.json`
with no `type`, which makes everything in that directory CommonJS regardless of the root, and it
needs to stay that way because Electron loads it.

**The nesting is the part that misleads.** That shield covers the `electron-app` directory and not
its parent, so `scripts/macos-harness/run.js` was swept in with the shielded files and left broken
at the flip. It has no importer and no test, so the suite stayed green and the only symptom was
running it by hand. It was the trap the module-system flip set, and it caught exactly the person who
had flagged it.

---


## Erasable syntax only

`erasableSyntaxOnly` is on, so TypeScript features that emit runtime code are rejected:
`enum`, `namespace`, parameter properties, and decorators. Node's type stripping removes
types and cannot generate code, so anything that needs generating breaks at runtime.

Use a `const` object with `as const` instead of an `enum`, which is what the existing modules
already do.

---

## Platform differences live in one module

`src/main/platform/`, one interface and per-OS implementations. No `process.platform` checks
in feature code.

The interface returns data wherever it can, an allowlist of variable names, a list of
candidate paths, a comparison rule, rather than doing the work. Separators are data too:
`pathSeparator` and `directorySeparator` exist because a separator looks like a detail and is
actually a platform decision, which is how a `platform.id === 'win32'` branch got written
inside the locator during the port.

A test enforces this. It sweeps every non-test file under `src/` outside the platform layer
and fails on `process.platform` or a comparison against `platform.id`. That keeps the logic that
consumes it platform independent and testable without mocking an operating system. It is why
the Task 1 modules survived a whole stack change.

---

## Unverified platform code is marked in the source

macOS hardware is deferred, so `darwin` implementations are written but not exercised on real
hardware. Every path in that state carries:

```ts
// UNVERIFIED(darwin): <what has not been confirmed>
// See docs/stack-migration-verification.md, macOS section.
```

Grep for `UNVERIFIED(` to get the work list for the first session on the Mac. CI on a macOS
runner covers the pure logic and does not clear these: a GitHub runner has no Claude Code
install, no real trust records and no ConPTY equivalent to compare against.

---

## A delete gets a cluster table

Any commit that removes a test file or a module reports what it removed, as clusters, and
where each cluster lives now. Anything with no new home is a gap and gets named as one.

The trigger is a delete, not a task boundary. Nothing else needs this.

Evidence for why: porting three modules and deleting their 30 tests looked like clean
deduplication, and 28 of the 30 did have a home. The two that did not were a configured shell
override that had been silently dropped, which was a feature regression rather than a coverage
gap, and a real-machine test whose loss then produced a wrong count in a report.

## A delete's cluster table compares behaviour, not names

The cluster table above says where each removed cluster lives now. Build it by comparing what tests
**do**, not what they are called.

Deleting `runner/pty-session.test.js` removed 25 tests. Comparing names against the TypeScript tree
reported ten with no home. Comparing behaviour reported one. The other nine were renames and merges:
`not propagated` became `reported once`, two dispose-once tests became one, two buffer-tail tests
became one.

A table of nine false positives and one true one is worse than no table, because the true one is
buried in it and the reader learns to skim. The one real gap was
`resize forwards the new size to the pty and records it`: the TypeScript side covered resize being
refused and never covered it working, and a name-only comparison would have listed it tenth among
nine non-problems.

## Read both platform jobs before calling anything ready, and say which you read

A suite passing on the machine in front of you is a measurement about that machine. That rule is
written elsewhere in this file about CI runners, and it applies to whoever is reading them.

Two tests were merged that had never run successfully anywhere except macOS. They failed on
`windows-latest` with a doubled drive letter, the integration branch stayed red across two
merges, and the reason was not that the failure was subtle. Nobody looked. The local suite said
`134 pass` and that was quoted as though it settled the question.

**Windows is the reference platform here**, so a macOS-green PR is half an answer. It is also
where the difference keeps showing up: `fileURLToPath` against `new URL(...).pathname`, and node-pty
1.2.0-beta.15 breaking kill and exit on Windows while fixing a leak on darwin, are two findings in
two days whose entire discriminator was Windows behaving differently.

So: name the jobs you read. "CI green" is not a claim anyone can check, and "windows-latest pass,
macos-latest pass, secret scan pass" is. Read the counts too rather than the badge, since a job can
be green with tests skipped.

## A test that asserts a symbol exists fails loudly; one that asserts behaviour can pass wrongly

Worth knowing when choosing how to write a guard, because it decides the failure mode you get on the
day it breaks.

The two tests above were broken for two merges and neither hid anything, because both failed by
erroring: the file they read was not there, so they threw. Nothing passed while broken.

That was a property of how they were written rather than luck. They assert that a symbol or a file
exists and resolves. When the ground moves, that kind of test cannot quietly succeed; it has nothing
to succeed against.

A test that asserts behaviour has the opposite property. It can pass against the wrong thing, which
is what the pinning test did while both sides carried the same Windows assumption about resize, and
what Task 5's end-to-end test did while creating the socket path the product should have created.

Neither kind is better in general. The point is to know which you are writing:

- **Existence and resolution**: fails loudly, cannot pass wrongly, proves less.
- **Behaviour**: proves more, and can prove it about the wrong subject.

Where a guard exists to catch drift rather than to prove correctness, prefer the first. That is why
the consumer test asks whether a member is referenced rather than whether calling it works.

## A mechanism that contains a risk needs a test that it runs, not that it works

The most useful finding in this project came from nothing failing.

Section 8's macOS risk read "Contained by `selfCheck` and by refusing to start rather than half
working". That was the stated reason deferring macOS hardware was safe. `selfCheck` was specified on
every platform, returned well-formed specs, had tests, and **was executed by nothing**. For several
tasks the safety of a real decision rested on code that had never run.

Every other defect here announced itself eventually: a hang, a red job, a wrong count. This one had
no symptom, because correct code that is never called reads exactly like working code. It would have
sat until someone read the interface member by member, which is exactly what nobody does.

**A test that a mechanism works is not a test that it runs.** The specs had tests proving they were
well formed. What no test asked was whether anything called them.

Two tests enforce this now, and both fail the way they are meant to rather than only passing:

- `every Platform member has a consumer, or a named exemption` catches a member added with no
  caller, which is where all three holes were.
- `every mechanism a risk is declared contained by has a caller` reads the plan, extracts the
  backticked identifiers from any "Contained by" claim, and requires each to be referenced under
  `src/`. Prose is ignored, because "refusing to start rather than half working" is a description
  and only symbols can be checked.

The general form, for anything these two do not reach: **when a document says a risk is contained by
something, the something is a claim about the code, and claims about the code get tested.**

## A file nothing imports is only verified by running it

Not "check the harness". The rule is general and the harness is the instance.

If no module imports a file and no test covers it, the suite passing says nothing about it. The only
verification is execution, and **reasoning about whether it needs verifying is how it stays broken**.

The evidence is uncomfortable. `scripts/macos-harness/run.js` was named as the trap in the handoff,
by the same person who then broke it: `scripts/macos-harness/electron-app/` has its own
`package.json` with no `type`, which shields that directory from the root flip, and the parent
directory was read as covered by the same shield. It was not. The file kept `require` at the flip
and every run of it died on the first line.

Nothing caught it. Not the type check, not 112 passing tests, not the tracked-paths guard, because
`.js` in `scripts/` is legitimate. What caught it was running all five swept instruments afterwards
instead of deciding which ones looked like they needed it.

So after any change that could alter how a file loads, run every file in that class, including the
ones that look obviously fine. The cost is a minute. The alternative is a tool that is broken until
the next person needs it, which is exactly when they cannot afford it to be.

## Separation tells a race apart from a missed window

Two intermittent failures look identical and have opposite fixes. Add a delay between the steps and
they separate immediately:

- **A race gets rarer with separation.** More time between two things means less chance they collide.
- **A missed subscription window gets worse with separation.** More time between an event and the
  subscription means more chance the event has already happened.

Measured, and it is what redirected the whole search:

```
  8 / 25   two sessions, same tick
 22 / 25   two sessions, 50ms apart
```

A 50ms delay nearly tripled the failure rate. That single number ruled out a race between sessions,
which is what everything up to then had assumed, and pointed at a listener attached too late. The
diagnostic costs one variant and one loop.

## Check a dependency's behaviour before reading its source

When a defect might be in a library, reproduce the same shape against the library directly first.

`PtySession` lost the child's first output on darwin about one run in two. Raw node-pty, two
concurrent spawns, the same fixture, 25 runs: zero losses. That ruled out node-pty before a line of
its source was read, and the next step queued had been reading its source, which would have found
nothing because node-pty was never wrong.

This is the same move as the harness pinning test, in the opposite direction. That one checks a
dependency's data still matches ours; this one checks its behaviour still matches our assumption. In
both cases the cheap check comes before the expensive read.

## A timing measurement starts by checking for stray processes

`pgrep` first, every time, before anything is timed.

Two of three hangs reported during the macOS session were processes left over from a previous killed
run, not the run being measured. Both looked exactly like the real one that followed. A machine with
strays measures the strays.

```
echo "stray: $(pgrep -f 'pty-session|node --test' | wc -l)"
```

This matters most for exactly the work where it is easiest to skip: chasing something intermittent
means killing runs, and killing runs is what leaves the strays.

## Counts come from the suite, not from a person

`npm test` prints the pty declared and skipped counts, and the test inventory prints how many
tests touch the real machine or cost quota. Reports quote those lines rather than stating a
number.

A number a person maintains drifts from the code the moment a file is deleted. That is not
hypothetical here: a count was carried forward across a delete and reported wrong, for the
same reason a typecheck line was once read instead of a test summary.

## A harness result resolves an UNVERIFIED marker, and says how

`scripts/macos-harness/run.cjs` reports one of five verdicts per question, and the two kinds of
contradiction are deliberately different things:

- `confirmed` removes the marker.
- `contradicted, harmless` removes the marker and records the real answer. The socket not being
  owner-only would be this: per-agent secrets already carry authentication, so it relaxes an
  assumption without changing code.
- `contradicted, NEEDS FIX` keeps the marker and names the change. The claude binary living
  somewhere the candidate list misses would be this.
- `pending` keeps the marker and says which task it waits on.
- `ERROR` means the check itself did not run, which is not an answer about the platform.

Only `NEEDS FIX` and `ERROR` fail the run. A pending section is the expected state until its
task lands, and a harmless contradiction is a finding rather than a problem. Without that
distinction a red line in the table looks the same whether it matters or not.

## `.git/info/exclude` is for other people's repositories, `.gitignore` is for this one

Decision 7 in the migration plan says `.git/info/exclude`, never `.gitignore`. That rule is about
repositories **Stafford manages on someone's behalf**. Stafford must never cause a diff or an
untracked file in a repository it did not create, so its exclusions go somewhere that is not
committed and not shared.

Stafford's own repository is not one of those. Here the opposite holds:

- `.gitignore` for anything that must be ignored in **every** clone. It is committed, so the work PC,
  the MacBook and every future clone inherit it.
- `.git/info/exclude` only for something genuinely personal to one machine.

Getting this backwards is not theoretical. An agent's `git add -A` swept `.letta/`, a directory of
conversation transcripts written by the tooling rather than by Stafford, into a commit and a push.
The first fix put `.letta/` in `.git/info/exclude`, reasoning correctly from decision 7 and applying
it to the one case it was never about. That would have protected exactly one clone and left the next
`git add -A` on any other machine free to do it again.

**A rule that reads as absolute gets applied where it does not belong.** Decision 7 now carries its
scope. This is the same shape as the force-push rule, which says never plain `--force` and permits
`--force-with-lease` on your own unmerged branch, and needed that second half written down for the
same reason.

An ignore rule stops one directory. `npm run check:paths` stops the habit: it fails on any tracked
top-level entry outside an allowlist, and on a short list of names that must never be tracked at any
depth. It runs in CI rather than as a local hook, because a hook protects whoever configured it and
CI protects every clone.

Publishing note, because it is easy to assume otherwise: rewriting history after a push makes the
old commit unreachable, not gone. `gitleaks` passed on the commit that carried the transcripts,
which is worth knowing and is not the same as it being safe. It scans for credential-shaped strings,
not for a file that should not be there.

## A pinning test catches drift, never a shared wrong assumption

A test that pins two things together proves they agree. It cannot prove they are right, and the
difference is invisible until the day both are wrong the same way.

`the macOS harness names the same claude candidates as the platform` is the pin, and it works. It
would catch someone adding a candidate to one side and not the other, which is the failure it was
written for.

It did not catch this. The harness asserted a resize by waiting for the ConPTY size report,
`CSI 8 ; rows ; cols t`, and so did the pty test, and so did the fixture's comment explaining why
the child could not be asked. All three agreed. All three were describing Windows. A real Unix pty
emits no size report at all: the kernel delivers SIGWINCH and the child reads its own winsize.

The cost was not the wrong assertion. It was that the harness reported `NEEDS FIX` with the note
`the pty layer does not work under Electron on this machine, which changes the plan rather than a
line of code`, from one failed check out of five, on a machine where resize worked correctly.

Two things follow, and both are now in place:

- **A pinning test needs something outside the pin.** Here that is
  `platform.resizeObservation(cols, rows)`, which names the mechanism per platform, so the two
  sides read one source rather than agreeing with each other.
- **A harness reports what failed and does not interpret it.** A note that escalates to a design
  conclusion needs more than a single failed check. A harness that draws conclusions is a harness
  that can be confidently wrong, and that costs far more than saying less.

Measured 2026-08-08. Raw output in the MacBook section of `docs/stack-migration-verification.md`.

## A scripted edit asserts its anchor, or it is a bug

Any edit applied by a script must fail loudly when its pattern matches nothing. A replacement
that matched nothing is an error, never a silent no-op.

```
assert old in source, 'ANCHOR NOT FOUND, edit would have been a silent no-op'
```

And after the edit, grep for what should now be there before running anything against it.

Two instances, both on this machine, both caught but only just. A regex substitution reported
`converted 0` and the run that followed tested the unmodified file while reporting a pass. Then
a second substitution silently did nothing and a long-prompt test was reported as passing when
it had run the short prompt. Backslashes through the shell are the usual cause and vigilance is
not the fix.

The first time this rule was applied it fired immediately, on its own first use, and stopped a
third instance.

**An unparseable value is a failure, not a warning.** The reconciliation runner treats a count it
could not read as a failed run rather than a missing detail, and that is what made a real problem
findable: on a Windows runner the summary lines were lost because the reconcile happened on the
child's `exit` rather than after its stdout drained. Everything passed and the count read as
unknown.

The instinct to soften an unparseable value into a warning is a natural one and it would have cost
this. A green run with an unread count hides the next real mismatch as well as this one.

**An anchor assertion is not enough on its own.** The rule above catches a replacement that
matched nothing. It does not catch a replacement whose content was mangled before the script saw
it: backticks and backslashes inside a shell-quoted string get interpreted, so the anchor matches,
the edit applies, and what lands is wrong.

That happened writing this very section's neighbour. Read the result back after any scripted edit
that carries markup or paths, or use the file-writing tool instead, which is the more reliable
answer for anything containing backticks, backslashes or Windows paths.

## A probe that mutates state runs outside the repository, without exception

Not "runs carefully". The fix is location.

A sandbox probe ran `git init` inside this repository to find out whether the sandbox allowed it.
It did not: the write into `.git/hooks` was denied, `git init` failed partway and left no `.git`
behind, and the `git add` and `git commit` on the following lines walked up and committed to the
working branch. Twice, before the cause was understood. Both were local, neither was pushed, both
were reset.

**Nothing caught it and nothing could have.** `npm run check:paths` checks what is tracked and a
commit is not a tracked path. The suite does not run probes. A probe that mutates git state sat
outside every guard here.

The failure mode is not one anyone predicts: a command that half succeeds, leaves no marker of its
own, and hands control to two more commands that then find the enclosing repository instead. Care
does not help, because the person writing it is thinking about the question being measured rather
than about what the tool does on the way to failing.

So: a probe that writes, commits, or changes any state runs in a scratch directory outside the
repository. Reading is fine anywhere.

## The sandboxed preload is CommonJS, and the tsconfig is split so main has no DOM

Two 7a seams, both invisible failures, both now guarded.

**A sandboxed preload must be `.cjs`.** With `webPreferences.sandbox: true`, the preload runs in a
loader that has no ESM `import`. The root is `type: module`, so a `.js` or `.mjs` preload is ESM and
the bridge dies at launch with "Cannot use import statement outside a module", with no build error
and no test failure. electron-vite emits `.mjs` by default here, so the vite config forces
`formats: ['cjs']` and `entryFileNames: 'index.cjs'`, and `src/build/preload-format.test.ts` asserts
the config and the built artefact. Found in 7a by launching, which is the only thing that catches it.

**Main-process code must not reference DOM globals.** A single `"DOM"` lib shared across main and
renderer compiles `document`, `window` and `fetch` in main with no error and fails at runtime. So
the tsconfig is split: `tsconfig.node.json` (main, domain, shared, build) and
`tsconfig.preload.json` get no DOM lib; only `tsconfig.web.json` (renderer) does. `npm run typecheck`
runs all three. `src/build/tsconfig-split.test.ts` proves the split bites by compiling a DOM-global
fixture under each lib and asserting the node lib rejects it while the DOM lib accepts it.

## Never invoke a node_modules/.bin path; call the JS entry through node

A test in the packaging work ran the compiler as `node_modules/.bin/tsc`. That path is a POSIX symlink on macOS
and Linux and a shell wrapper on Windows, and `execFileSync` cannot run the Windows form, so the
test passed on macOS and failed on the windows job. The whole check silently produced no output and
both its assertions missed.

So a test or script that runs a tool from a dependency calls the package's JS entry through node,
never the `.bin` shim:

```js
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', ...args])   // yes
execFileSync('node_modules/.bin/tsc', args)                                     // no
```

`node <entry>` is byte-identical on every platform. The `.bin` shim exists for a human at a shell,
not for `execFileSync`. This does not apply to `package.json` scripts, where npm resolves the bin
name itself and picks the right form per platform.

A test, `no-bin-invocation.test.ts`, fails on a quoted `node_modules/.bin/` in a tracked source file,
so the shim cannot come back through a test or script unnoticed.

## Every native dependency is Node-API with prebuilds for all target arches

Packaging sets `npmRebuild: false`, so electron-builder does not rebuild native modules from source,
and a from-source rebuild is not available in CI anyway: the Windows runner has no Visual Studio, and
that is a deliberate premise rather than a gap, because node-pty is Node-API and ships a prebuilt
binary per arch. So a native dependency that is not Node-API, or that lacks a prebuild for an arch the
build targets, would build a bundle that ships and then fails to load at runtime on a user's machine.

Every native dependency must therefore be Node-API and ship a prebuild for every target arch.
`native-prebuilds.test.ts` enforces it: it reads the target arches from `electron-builder.yml` and
asserts each native external has a prebuild binary for each, so adding a dependency without a prebuild,
or an arch without one, fails loudly. `better-sqlite3` arrives in Task 8 and is Node-API with
prebuilds, so it joins the native externals and this check together.
