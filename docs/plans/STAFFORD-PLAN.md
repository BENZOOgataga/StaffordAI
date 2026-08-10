# Stafford: complete design plan

The whole intended system, written down so the design survives without the conversation that
produced it, including what was tried and rejected and why. Written 2026-08-06.

This is not a v1 scope document. Section 19 says what to build first.

Named after Stafford Beer, the cybernetician. The name is load bearing: this is a variety
management system for agents, not a task tracker.

---

## 1. About this document

This is the design record for Stafford, maintained by BENZOOgataga. It is deliberately complete
rather than minimal: it keeps the rejected approaches and the reasons alongside the chosen ones, so
a later reader can see why the design is the way it is rather than only what it is.

The project is built with Claude Code agents working from role definitions (see `docs/agents/`), so
some sections are written as instructions to those agents. Where a section reads as direction rather
than description, that is why.

---

## 2. What Stafford is

A local app that turns Claude Code into a team he manages instead of a terminal he uses.

His own words: he wants to hand tasks to agents "as if they were entire persons and I'm
the PM".

He hires agents. Each hire takes a role from a definition file and gets a generated name
he cannot change, because you do not choose the name of someone you hire. Marion is the
lead dev, Theo is a developer. They persist across sessions with their history intact.

The app runs as a background process started at logon, with no window. He opens the UI
and sees a roster of cards, one per hire, showing who is working, who is idle and who
is waiting on him. Clicking a card gives that agent's live terminal plus a box to type
into, which is the CLI he already knows, addressed to a specific person. He assigns
hires to projects, and a project is a group of repos with its own permission policy.

For real features there is a pipeline: he briefs the PM assistant, it writes a design
plan, he confirms, the lead dev writes a technical plan, developers implement, the code
reviewer audits, QA writes and runs tests, the writer fixes copy and docs, the PM
assistant summarises what shipped against what was asked, and he approves the merge.

### The axis is what makes it different

Vibe Kanban is task-centric. The Claude Desktop app is session-centric. Stafford is
people-centric. He talks to a colleague, and the board is a view on top of that rather
than the point of it. Every design decision should be checked against that: if a feature
makes the board the primary surface, it is probably wrong.

---

## 3. Status: what is built, verified and unverified

### Already built and passing tests

Two files exist in the repo, from the first hook-forwarder increment:

- `hooks/claude-hook.js`, a single forwarder registered for all eight hook events. Reads
  the payload from stdin, posts a minimal summary to the runner, exits 0.
- `runner/hook-endpoint.js`, the local HTTP endpoint that derives agent state from those
  events. Six tests in `runner/hook-endpoint.test.js`, all passing on Node 26.
- `runner/server.js`, the runner entry point. Currently only starts the hook endpoint.
- `hooks/install.ps1`, resolves node.exe, generates the shared token, prints the
  settings.json block to paste.

### Verified by direct test on his machine

- `node-pty` installs from a prebuilt binary on Node 26, no compiler needed.
- Claude Code draws its full TUI inside a spawned pseudo-terminal: colors, cursor,
  arrow-key menus.
- Writing to that pty's stdin reaches the prompt and produces a real reply.
- The trust prompt appears for any directory Claude Code has not seen before, and a
  message written while that prompt is up becomes the answer to the prompt.
- Hooks fire from a real session under his actual config, the endpoint authenticates
  them, and state transitions correctly through idle, working and idle.
- Tool restriction is genuinely enforced. A session was asked to make the code reviewer
  write a file; the subagent refused with "I don't have a write tool" and no file was
  created. This matters because the whole security model rests on it.
- A session's own account of its subagent tool grants is unreliable. Asked to list them,
  a session reported Write and Edit on the code reviewer and the PM assistant, which
  neither definition grants, and placed the files in the wrong directory. Test tool
  boundaries, never ask about them.
- The Claude Code binary is at `%USERPROFILE%\.local\bin\claude.exe`, from the native
  installer, not an npm shim.

### Not verified, treat as unknown

- Whether reading subscription usage works at all. No official API exists. See section 9.
- Whether a resumed session behaves identically to a fresh one after a rate limit kill.
- Whether the alternate screen buffer from `"tui": "fullscreen"` replays cleanly into
  xterm.js from a persisted output file.
- Everything about the hosted control plane. Nothing has been built or tested there.

---

## 4. Rejected approaches, do not re-propose

### Vibe Kanban

Installed and removed the same day. The company behind it shut down in April 2026, the
binary calls a server that has already been used to retire projects remotely, the
installer pulls a 147 MB binary from the defunct company's CDN with a checksum from the
same host, it has no authentication of its own, and it shipped with
`dangerously_skip_permissions: true` in its default Claude Code profile. Its concept is
the starting point for Stafford. Its code is not.

One finding from it survives: its `deny_tool` config field belongs to the Copilot
executor and is silently dropped for Claude Code, so subagent frontmatter `tools:`
allowlists are the only place tool restrictions actually hold.

### Claude Code agent teams

Experimental, gated behind a flag, and it has already broken once (`TeamCreate` and
`TeamDelete` removed, `team_name` deprecated in hook payloads). More importantly, its
file state at `~/.claude/teams/` is documented as not safe to write by hand, so it can
only be observed, not driven. Stafford launches sessions rather than observing them, so
it needs none of this. Do not build on it.

### The Claude Agent SDK

Programmatic Claude Code usage (the Agent SDK, `claude -p`, GitHub Actions) draws from a
separate metered credit pool at API rates. Interactive Claude Code stays on his Max
subscription. Benzoo declined metered billing, so Stafford drives interactive sessions
through a pseudo-terminal.

Accepted risk, his explicit call: Anthropic split interactive from programmatic billing
deliberately, and a synthetic TTY puts programmatic work on the interactive pool. If
enforcement arrives it lands at the account level. Do not relitigate this, but do not
hide it either. See section 16 on what it means for publishing.

### agent-teams-ai

A third-party Electron app that closely matches the concept. Rejected for adoption:
single maintainer, its own orchestration layer instead of Anthropic's, no auth in its
HTTP mode, AGPL, and it wants repository write access on a corporate machine. Reading
its source for ideas is fine.

### Ambient agent chat

Two designs were tried and rejected in the design conversation itself. Broadcasting
channel messages into working sessions costs a full turn per agent per message and has
no natural stopping point, so a twenty message discussion becomes a hundred agent turns.
Giving each agent a cheap second session for chat looked better, but it strips out the
context needed to say anything useful (producing generic filler), doubles the process
count, and splits an agent's identity so its work session has no memory of what its chat
session said. See section 10 for what replaced it.

---

## 5. Domain model

### Agent types

The definition files in `~/.claude/agents/`. They are not cards in the UI. They are what
you pick from when hiring, and they carry the `tools` allowlist and the model choice.

Six roles. Six definition files already written and delivered to him:

| File                | Tools                                                              | Notes                                                                                           |
| ------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `pm-assistant.md`   | Read, Grep, Glob, Skill                                            | No write tool at all, no shell. Produces plans and summaries as output; Stafford persists them. |
| `lead-developer.md` | Read, Edit, Write, Grep, Glob, Bash, NotebookEdit, WebFetch, Skill | Writes technical plans, sizes tasks, implements alongside devs. `delegation: direct`.           |
| `developer.md`      | same as lead minus delegation                                      | Implements from a technical plan.                                                               |
| `code-reviewer.md`  | Read, Grep, Glob, Bash, Skill                                      | No write tool at all. That absence is the enforcement.                                          |
| `qa-tester.md`      | Read, Write, Grep, Glob, Bash, Skill                               | Writes test files only, never fixes the code under test.                                        |
| `writer.md`         | Read, Edit, Write, Grep, Glob, Skill                               | No shell. Path-scoped to docs, markdown, i18n.                                                  |

Critical: **only `tools` is enforced by Claude Code.** An agent physically cannot use a
tool absent from that list. Everything else in a definition is instruction, and
instructions get ignored. The writer's path scope, the delegation rules and the seniority
model are all advisory until Stafford enforces them. Enforcing them is Stafford's job.

`memory:` is set on all six: `project` where knowledge is repo-specific (lead dev, dev,
QA), `user` where it is about how Benzoo works (PM assistant, code reviewer, writer).

`delegation` and `seniority` are custom fields Claude Code ignores and Stafford reads.

### Hired agents

The cards. Hiring asks for a type and generates a name.

Names come from a French first-name pool of 186 entries, shipped as
`data/first-names.json`, drawn without replacement so no two live hires collide. A name is
never recycled after a firing, because task history has to keep one owner per name and a
second Marion six months later makes an old summary unreadable. The name is immutable. This
is a deliberate product decision, not a limitation, and it also solved a real problem: it
removes the need for "Developer 2".

The pool is derived from the most common first names given in France between 2000 to 2023.
Accent variants and near-twins are collapsed to one form, since two agents distinguishable
only by a diacritic is a support problem. Four names are excluded because they collide with real
people or projects Benzoo works with, and which four is deliberately not recorded here, since the
collision is the reason and naming them would put the thing being avoided back in the document.
Adding a project whose name is in the pool means removing that name. Keep the pool loadable from
config rather than hardcoded, so the drawing and never-recycle logic stays independent of which
list is supplied.

A hire is **not** bound to a project. Benzoo assigns any hire to any project and can
reassign at any time.

Because a Claude Code session is anchored to a working directory, a hire keeps one
session per project it has worked on. Marion's BENZOOgataga context and her Vanillin
context are separate sessions under a single identity, which is how a person switching
projects behaves anyway. Only one of a hire's sessions is active at a time, so one hire
cannot hold write locks in two projects at once.

Firing keeps the agent's tasks in history and leaves its git branch alone.

### Seniority, delegation and apprentices

Seniority lives in the definition files. `lead-developer.md` gets the delegation tool,
`developer.md` does not.

Two delegation modes, set per definition with `delegation:`.

`propose` means the agent drafts assignments and nothing leaves until Benzoo approves.
The PM assistant uses this. It comes back with several tasks at once, so the approval
view must let him edit the wording, drop one and send the rest. A yes/no on a batch will
get a good batch rejected over one bad line.

`direct` means the agent enqueues on a peer with no approval step. The lead dev uses
this. Fire and forget: the lead enqueues, finishes its turn, and when the peer completes
the dashboard injects a message into the lead's session with the result. The lead never
blocks waiting, because a blocked lead plus an away human plus a peer stuck on a
permission prompt is a permanent deadlock.

Guardrails, all required:

- A delegation chain is capped at depth 3.
- An agent cannot enqueue on anyone who already holds a task that originated from it.
  This is what stops two agents passing work in a circle overnight.
- A ceiling on delegations per hour, in a config file rather than in code, so it can be
  tightened after the first surprise.
- Peers at the same level may delegate across disciplines. A dev handing documentation to
  the writer was the original requirement and a strict one-level-down rule would forbid
  it.
- Delegation stays inside a project.

Any agent with a delegation mode needs a read-only roster tool giving names, roles,
projects and current load. Without it, it assigns work to people who were never hired.

A dispatched task targets an agent id, not a name. If the target was fired between
proposal and approval, dispatch fails visibly rather than dropping the task.

Agents may also spawn ordinary Claude Code subagents, framed as apprentices they manage.
`SubagentStop` makes those visible on the card. Their tokens are charged to the parent
session and appear nowhere else, so any cost figure on a card must include them or it is
lying.

### Projects and policies

A project holds one or more repos and a policy. This replaced an earlier idea of
per-repo sensitivity tags and is better: `benzoogataga.com` and the BENZOOgataga plugin repo
are one project, so a dev works across both without being hired twice.

Agents will be pointed at four trust levels: personal projects, employer work repos,
client or side work, and Stafford itself. Trust is configured per project rather than
assumed.

Three invariants:

- **A policy can only narrow permissions, never widen them.** Effective permission is the
  definition's `tools` allowlist intersected with the policy. A policy that could grant
  Bash to the code reviewer would defeat the only mechanism Claude Code enforces.
- A new project starts fully locked. Benzoo opens it up deliberately.
- Delegation stays inside a project.

Only Benzoo applies a policy change. The PM assistant exists here to save him hand
editing: creating a project, or applying one change across many projects at once. It
always asks first and never applies a change itself. It reads repo files, task text and
web pages, which makes it the agent most exposed to injected instructions, and an agent
that can widen permissions can widen them for everyone.

For a bulk change the confirmation shows a per-project diff, before and after, for every
project affected. A single yes over an unseen batch is worse than editing each project by
hand.

Policy changes are recorded in an append-only log: who, what, when.

Agent-authored plans and summaries land in the target repo's tree. For client work, that
may be contractually relevant.

---

## 6. Architecture

**Superseded by `docs/plans/STACK-DECISION.md`.** That document replaces this section
after a ground-up reassessment: Electron desktop app rather than a browser page,
TypeScript strict, a local socket rather than HTTP for hooks, SQLite rather than JSON
files, and Windows plus macOS as first-class targets. Read it instead of what follows.
What follows is kept for the reasoning it records, not as instructions.

### Original section 6, superseded

### Two processes from day one

The app splits into a **local runner** and a **control plane**.

The runner owns the pseudo-terminals, the agent processes, the hook endpoint and the
Claude Code credentials. It must stay on Benzoo's machine.

The control plane owns the roster, projects, tasks, the board, the channel and the UI.

Both run locally today. Later the control plane moves to a web server and the runner
stays local, reaching out to it over an authenticated websocket. Building this as one
process makes that migration a rewrite, so the seam exists from the first commit even
while both halves are on localhost.

Direction of connection matters: the runner connects out to the control plane, never the
reverse. The runner's HTTP surface binds 127.0.0.1 only, forever, including after the
control plane goes remote.

### Stack

- Runner: Node, CommonJS, zero runtime dependencies except `node-pty`. It already runs on
  Node's built-in `http` and `node:test`.
- Control plane: Node with a websocket server. Keep dependencies minimal.
- Frontend: React with Vite, Tailwind, xterm.js. Not Next, because this is a local SPA
  talking to a local socket and SSR buys nothing. If the control plane later goes hosted,
  it serves the same built SPA.
- State: React context with `useReducer` is enough. Add a state library only when it
  demonstrably hurts.
- No database. JSON files under a gitignored `.state/` directory: one registry for hires
  and projects, one output buffer per agent session, one append-only policy log. Committed
  source data, currently the first-name pool, lives under `data/` and is not ignored.

### Dependency policy

Minimal by default, prefer the standard library and what already exists. Vet new packages
for maintenance and supply-chain risk, flag known CVEs. Pin versions and commit
lockfiles, no floating ranges. `node-pty` is a native module and is the one unavoidable
native dependency.

---

## 7. Runtime

### Spawning an agent

One `claude` process per active hire, spawned in a pseudo-terminal via `node-pty` over
ConPTY. Terminal output renders in the browser with xterm.js. Nothing parses the terminal.

The binary is at `%USERPROFILE%\.local\bin\claude.exe`. Locate it by checking there and on
PATH, never by assuming an npm global path, because other people will have it elsewhere
once this is public.

Build each agent's environment explicitly. Do not pass `process.env` through. A Claude
Code spawned inside a ConPTY does not inherit the same environment as an interactive
shell, and this is not theoretical: his existing plugin hook already fails at
`SessionStart` because Git Bash is not on PATH, and his `statusLine` (claude-hud) is a
bash one-liner that will fail the same way. The runner must put Git Bash on PATH when
building the environment, or accept that both silently break in every agent session.

### Trust prompts

Claude Code shows a trust prompt for any directory it has not seen before, and a message
written while that prompt is up becomes the answer to the prompt. This was reproduced.

So the runner handles first-run trust per project explicitly rather than assuming a clean
start, and it never writes a queued message into a session whose state is not provably
idle.

### Permission mode

Sessions launch showing "manual mode", which stops for confirmation on every tool call.
For an agent working while Benzoo is away that is a permanent stall. Permission mode is
set deliberately per project through the policy. He has
`skipDangerousModePermissionPrompt: true` in his settings and has declined to remove it;
that is his decision and it is consistent with wanting agents that do not stall.

### State detection

State comes from hooks. Never from terminal output, and never from what an agent says
about itself. He has been burned by agents reporting success on unfinished work.

- `SessionStart` gives the session id, needed for `--resume`. State becomes idle.
- `UserPromptSubmit` and `PreToolUse` mean working.
- `PreToolUse` with tool `Task` increments the apprentice count. `SubagentStop`
  decrements it.
- `PostToolUse` clears the current activity line.
- `Notification` means waiting for input, unless the message matches a rate limit
  pattern, in which case the state is rate limited instead. That distinction already
  exists in the code and matters because the queue must pause rather than retry.
- `Stop` and `SessionEnd` mean idle.

The forwarder sends only the event name, session id, working directory, tool name and
notification text. Never tool inputs, which contain file contents, prompts and sometimes
secrets. Nothing about payload bodies reaches disk.

The forwarder always exits 0 within 900ms. A hook that errors or hangs degrades every
Claude Code session on the machine, which is far worse than a stale card. If the runner is
down, sessions behave normally and the UI shows stale state.

### Lifecycle

Hiring is free, running is not.

A card spawns its process on first message and shuts it down after ten minutes idle, then
reattaches with `claude --resume` on the stored session id. Ten minutes is his choice; keep
it in config. Six idle hires must not hold
six live processes.

Each agent session's terminal output is persisted to disk and replayed into xterm.js when
the card is opened. Session context survives a resume, visible scrollback does not, and a
card that opens blank feels broken. Note `"tui": "fullscreen"` in his settings, which
means alternate screen buffer sequences in that captured stream. Test the replay.

Browser window resize must propagate a pty resize, or the TUI wraps wrong and looks
broken immediately.

On boot the runner spawns zero agent processes. Everything stays cold until Benzoo opens
the UI or sends a task. Otherwise starting with the PC means sessions burning quota while
he is in a meeting.

On shutdown, child processes are killed. The registry of hires and session ids is
persisted, and startup reconciles what is still alive against what should be resumed.
Orphaned ConPTY processes with no reader are unpleasant to clean up on Windows.

---

## 8. Concurrency and failure

**One writing agent per repo at a time.** Others queue. Two Claude Code processes editing
one tree produces half-applied changes and git index lock errors. The lock is per repo,
not per project, so a dev in one repo does not block a dev in another repo of the same
project. Per-repo worktrees are the growth path once parallel work on one repo is
genuinely wanted, and they are not in scope now.

**A queued task is injected only when the agent is provably idle.** Never while it is
waiting on a prompt. This is the same failure as the trust prompt and it was observed
live.

**Rate limiting is a state, not an error.** The queue pauses until reset rather than
retrying, or a single limit hit burns whatever budget is left.

**Two hires can share a display name only through a bug**, since names are drawn without
replacement, but identity is still a stable internal id and never the name.

**Recovering a mid-task kill.** Detect the rate limit, set the card state, store the reset
time, then `--resume` at reset with an instruction to continue. Sessions are resumable so
context survives. What does not survive is a half-applied set of edits.

The mitigation is checkpoint commits on the feature branch during a task, squashed into
one commit before the code reviewer sees the branch. This is a deliberate exception to
Benzoo's standing rule of one commit at the end with no mid-task commits, approved by
him: clean history where it matters, recoverable state where it is needed. Do not
"correct" this back.

---

## 9. Usage-aware scheduling

Goal: do not start work that will die halfway through, and recover cleanly when it dies
anyway.

### Decided: no proactive usage reading

Stafford does not read subscription usage. This is a deliberate decision, taken after
looking at both available routes and rejecting them.

No official programmatic access exists. `/usage` renders in the terminal only,
`~/.claude/stats-cache.json` is client-side activity data that does not reflect
server-side limits, and `claude auth status --json` returns account info without usage
numbers. Open feature requests: anthropics/claude-code #21943, #39141, #44328. Note that
`/status` is the documented command for subscription capacity while `/usage` is a context
and token diagnostic.

Both workarounds were rejected. A `statusLine` script would work, but that slot is
occupied by the claude-hud plugin, so taking it means wrapping someone else's output and
breaking his status line whenever that plugin changes. Reading the OAuth token from
`~/.claude/.credentials.json` and calling the undocumented endpoint community tools use
works today, but it is unsupported and it would put token-reading code that calls an
undocumented endpoint into a public AGPL repo.

Instead Stafford handles limits reactively, using the mechanism that is already
implemented and tested. The `Notification` hook fires when a limit is hit, the endpoint
already distinguishes that case from a plain waiting-for-input notification, and the
notification carries the reset time. On a real limit the queue pauses until reset.

What this gives up is prediction: no refusing to start work at 92% consumed. That was
never reliable, because remaining percentage says nothing about what the next task will
cost. Task sizing in the lead developer's technical plan is what actually prevents
mid-task kills.

If prediction is wanted later it goes behind an opt-in flag, so a break degrades one
feature rather than the product.

### Scheduling rules

There are two limits and they reset differently. The 5-hour window resets in minutes to
hours. The weekly cap resets on a fixed day. The scheduler must know which one it hit and
must not defer work across a weekly boundary without asking him first, or it will
cheerfully park a feature until Wednesday.

In-flight pipelines take priority over new ones, or implementation work consumes the
budget and features sit stuck between implemented and reviewed. This ordering rule needs
no usage figure, only a queue that prefers finishing over starting.

5-hour limits are reduced on weekdays from 5 to 11 AM Pacific, which is his afternoon in
Paris. Treat that window as more expensive.

His account runs Opus 5 with 1M context by default, which is the most expensive
combination available. Long sessions on Opus is exactly the pattern that exhausts a
subscription, which makes this section less optional than it sounds.

### The cheapest guardrail

Task size beats budget forecasting. The lead dev's technical plan sizes tasks so any
single one finishes inside one window. A mid-task kill then costs twenty minutes instead
of three hours, and no new machinery is involved. This instruction is already in
`lead-developer.md`.

---

## 10. Surfaces

### Roster, the home page

A left navigation rail and a grid of hire cards. This is what he sketched and it is the
landing page.

A card carries: name and role, state, the current task in one line, the project tag,
elapsed time, queued count, apprentice count when non-zero, and a badge plus a sound when
the agent needs him. Nothing has a fixed width, because French labels run longer than
English ones.

States: idle, working, waiting for you, rate limited, crashed.

**The badge and the sound fire less often than this assumes when the Bash sandbox is on.**
Measured 2026-08-08. `Notification` is the trigger, and it has two variants wearing one name:
the permission prompt, which is what "the agent needs him" means, and an idle notification
that says the turn ended. A sandboxed Bash call raises no permission prompt, because the
sandbox is the containment instead of the prompt, so on a machine with `sandbox.enabled` set
globally the prompt variant may never arrive for tool calls at all.

Two consequences for this screen. Driving the badge off any `Notification` would light it on
every completed turn rather than when attention is needed, so the variant has to be
distinguished rather than counted. And "waiting for you" can be a state nothing ever
announces, which means it needs a second source rather than resting on the hook alone.

The sandbox is currently inherited from the machine's global settings rather than chosen per
project, which is an owed item against `ProjectPolicy`. Until that lands, this screen's
behaviour depends on a file outside the product.

### Agent detail

Click a card. Live terminal on one side, a box to type the next task on the other. Its
history, its queue, and which project it is currently on.

This is the primary way work gets assigned. It should feel like the CLI, because that is
what he asked for.

### The channel

One timeline carrying every agent's messages, questions, task events and completions, and
he can reply to any of it from there instead of opening six cards. It exists for him, not
for the agents.

Agents do not read the channel ambiently. See section 4 for the two rejected designs.
Instead a peer is pulled in at events: a task completing, a plan being written, a diff
landing. At those points the peer receives the actual artifact, so its comment is
informed. This reuses the delegation mechanism and needs nothing new.

Accepted loss: no agent wanders into a conversation unprompted. Ambient LLM commentary is
mostly noise, and after real use it will be clear which specific moments deserve a second
opinion. Adding it then is cheaper than guessing now.

History is kept indefinitely, his choice. Store it append-only as one JSONL file per day
under `.state/channel/`, which stays cheap to append and easy to prune if he changes his
mind.

One consequence to carry forward: the channel accumulates task text and agent output,
which echoes the contents of corporate and client repos. Unbounded local history is fine
on his machine. When the control plane moves to a web server, what synchronises there
needs a deliberate decision rather than a default of everything.

### Kanban board

A feature, not the point. A view over tasks that already exist, reading the same hook
events the cards read. Build it after the roster and the detail view work.

### Hire flow

Pick a type, pick a project, confirm. The app shows the generated name and does not offer
to change it.

### Project settings

Repos in the project, and the policy. Default locked. A per-project diff on any bulk
change. The append-only policy log is visible here.

### Approvals

Where proposed assignments and pipeline gates land. Editable before dispatch, per item,
not a single yes over a batch.

---

## 11. The feature pipeline

Only tasks of kind `feature` run the full pipeline. A chore goes dev, review, done.

1. Benzoo briefs the PM assistant. It writes a design plan to a file. He confirms it.
2. Lead dev turns the design plan into a technical plan, on a new branch.
3. Developers implement. The lead dev works alongside them when the work splits.
4. Code reviewer audits the branch. It has no write tool and no merge power.
5. QA tester writes and runs tests on the branch. Failures return the task to step 3.
6. Writer polishes UI copy and docs on the branch.
7. PM assistant writes the closing summary: what was asked, what shipped, what is missing.
   It reads the design plan from disk, which is why plans are files rather than chat
   messages.
8. Benzoo approves. Merge to main. He pushes.

**Merge is the last step, not the middle.** An earlier version had the reviewer merging
before QA and the writer ran, which puts untested code and unreviewed doc commits on main
and contradicts the branch discipline. Moving merge to the end also collapses two
approvals into one.

**Step 6 has a trap.** A writer editing after the reviewer signed off means the approved
artifact is no longer the artifact. The writer is therefore path-scoped to `docs/`,
markdown, i18n and UI copy files, never code. Anything else it wants changed becomes a
note back to the dev. Stafford enforces this, since frontmatter cannot.

Any rejection returns the task to the dev and invalidates all approvals. The cycle
restarts on the fix. Tracking which files each approval covered is possible and not worth
it.

The card must name which stage is blocking, since an agent asking a question while he is
away parks the whole feature.

Cost: five agents and seven or more sessions per feature. Spent once per feature rather
than continuously, but this is the most expensive thing in the design.

---

## 12. Frontend design direction

He asked for a clean Vercel Geist dark dashboard. Follow that exactly. Do not propose an
alternative aesthetic.

### Tokens

Use the real thing rather than an approximation. Install the `geist` package for Geist
Sans and Geist Mono. Take colour values from the Geist design system scales at
vercel.com/geist rather than hardcoding guesses from memory: each hue ships a numbered
scale and the dark theme is a proper inversion, not a filter.

Structure of the palette:

- Page background is the darkest neutral step, near black but not pure black.
- Surfaces sit one step up. Cards are a surface, not an outlined box on the page.
- Borders are 1px at low contrast. Geist's look comes from hairlines and spacing, not
  shadows. No drop shadows except a functional focus ring.
- Accent (Geist blue) appears sparingly: focus rings, the single primary action per view,
  and links. Everything else is neutral.
- Semantic hues carry state and nothing else. Green for working, amber for waiting on
  him, red for crashed or rate limited, neutral for idle.

Type:

- Geist Sans for everything in the interface chrome.
- Geist Mono for the terminal, session ids, paths, branch names, commit subjects, elapsed
  times and any number that lines up in a column. Monospace is information here, not
  decoration.
- Sentence case everywhere. Never title case, never all caps.
- Two weights, regular and medium. Geist at heavier weights against a dark background
  reads as shouting.

Layout:

- Left rail for navigation, fixed and narrow, icons with labels.
- Content area is a grid that reflows by available width, not a fixed column count.
- Generous whitespace and a consistent spacing scale. A cramped dark dashboard reads as
  cheap immediately.

### The signature element

Each hire's card carries a live one-line tail of its actual terminal output in Geist Mono,
updating as it works.

The reason: the whole product is people-centric, and a card showing a status pill is a row
in a table wearing a costume. A card showing the last thing the agent actually said or did
makes the roster feel like a room with people working in it. It costs nothing (the runner
already has the stream) and it is the one thing the board should be remembered by.

Keep everything else quiet so that lands.

### Interface copy

Written from his side of the screen. Name things by what he controls, never by how the
system is built. He hires an agent, he does not instantiate a session. He assigns a
project, he does not bind a workdir.

Errors say what happened and what to do, in one sentence, with no apology and no raw
exception text. "Marion cannot start: BENZOOgataga is locked by Theo" beats "EBUSY".

Empty states are invitations. An empty roster says hire your first agent, not "no agents".

Actions keep the same verb through the whole flow. The button that says Hire produces a
card, not a toast that says "created".

### Quality floor, not negotiable

Responsive down to a laptop screen at minimum. Visible keyboard focus everywhere.
`prefers-reduced-motion` respected. Every label flexes for a longer French translation, so
i18n wiring exists from the start even while the UI ships in English only.

---

## 13. Data shapes

No database. Runtime state is JSON under a gitignored `.state/` directory. Committed source data lives under `data/`.

```ts
type AgentState =
  | "idle"
  | "working"
  | "waiting_for_you"
  | "rate_limited"
  | "crashed";

type HiredAgent = {
  id: string;                         // stable internal id, never reused
  name: string;                       // generated at hire, immutable
  type: string;                       // definition filename, e.g. "lead-developer"
  title: string;                      // display role, read from the definition
  seniority: number;                  // lower number delegates to higher
  ownerId: string;                    // no implicit single user, for the hosted plane
  sessions: Record<string, string>;   // projectId to sessionId, one per project worked
  activeProjectId: string | null;     // at most one active at a time
  state: AgentState;
  hiredAt: string;
  firedAt: string | null;
};

type Project = {
  id: string;
  name: string;
  repos: { path: string; label: string }[];
  policy: ProjectPolicy;
};

type ProjectPolicy = {
  push: "none" | "feature-branches" | "including-main";
  allowedRoles: string[];             // which definitions may be hired here
  toolCeiling: string[] | null;       // intersected with the definition, never widens
  writePaths: string[] | null;        // null means the whole repo
  requirePipeline: boolean;           // features must pass the full gate
  allowWebFetch: boolean;
  permissionMode: string;             // set deliberately, not inherited
  sandbox: boolean;                   // owed. See the note below: this is the unattended dial
  maxConcurrentAgents: number;
};

type Task = {
  id: string;
  agentId: string;
  projectId: string;
  text: string;
  kind: "chore" | "feature";          // only "feature" can open a pipeline
  origin: { kind: "user" } | { kind: "agent"; agentId: string };
  approvals: Approval[];              // empty until a gate opens
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

type Approval = {
  agentId: string;
  verdict: "pending" | "approved" | "rejected";
  note: string | null;
  at: string | null;
};

type PolicyLogEntry = {
  at: string;
  actor: string;                      // always Benzoo, agents cannot apply changes
  projectId: string;
  before: Partial<ProjectPolicy>;
  after: Partial<ProjectPolicy>;
};

// The sandbox is the unattended dial, not a security toggle beside permissionMode.
//
// Measured 2026-08-08. A permission prompt fires only with the sandbox off. So the two
// settings are not neighbours, they are a trade:
//
//   sandbox on   restricted reach, and the agent never hits a prompt, so it works
//                unattended. Writes only inside its project, no DNS, no writing .git/hooks
//                or .git/config, no socket bind.
//   sandbox off  full reach, and the agent blocks on a permission prompt, so it needs
//                Benzoo present to clear it.
//
// Those are different products for the same hire, which is why this is a policy field rather
// than a machine default. Four consequences, all measured or directly implied:
//
//  - The badge and the sound were specified for the permission-prompt Notification. On a
//    sandboxed project that variant never arrives, so the feature has no trigger there. The
//    idle variant is not a substitute, since Stop already means idle.
//  - Employer work is the project most likely to want the sandbox on, and its repositories
//    are the ones a developer would least like restricted. That tension is real and is
//    stated here rather than discovered at configuration time.
//  - Stafford's own project wants it off: its agents write across the repository and run
//    builds, both of which the sandbox refuses outside the project directory.
//  - The multi-repo conflict only exists with the sandbox on, because writes outside the
//    starting directory are only denied then. So the three options for multi-repo projects
//    (sandbox off, one session per repository, one repository per project) are options for
//    sandboxed projects specifically. That narrows the decision.
//
// Whether the field is a boolean or carries per-path sandbox exceptions is open. Full
// measurements in the verification log.
```

---

## 14. Security

Hard rules, no exceptions.

- Never commit or expose secrets. No keys, tokens, passwords or env contents in code, logs
  or git. Secrets live in a gitignored `.env` with a committed `.env.example` holding keys
  and no values.
- The shared token for the hook endpoint lives at `~/.agent-dashboard/token`, owner-only
  ACL, generated by `install.ps1`. Never in the repo, never in `settings.json`.
- The runner binds 127.0.0.1 only. Never 0.0.0.0, including after the control plane goes
  remote, because the runner dials out rather than listening.
- Hook payloads never cross the wire in full and never reach disk. Only event name,
  session id, cwd, tool name and notification text.
- If the credentials-file route for usage reading is used, read the OAuth token at call
  time, never copy it, never log it, and keep it behind an opt-in flag.
- A project policy can only narrow the definition's tool allowlist. Any code path that
  could widen it is a bug of the highest severity in this project.
- No agent applies a policy change. The PM assistant is the most injection-exposed agent
  in the system because it reads repo files, task text and web pages. For the same reason
  it has no write tool: it produces plan and summary text as output and Stafford writes
  the file. Do not give it Write to make plan authoring simpler.
- Path scopes are advisory. Three definitions carry a `paths` field (writer, QA tester)
  and Claude Code ignores it entirely. Stafford enforcing write paths is a requirement,
  not a refinement.
- **No agent writes into `.claude/`, whatever its role, because that path is code
  execution wearing configuration.** This is the second thing that cannot be enforced by
  frontmatter, and it is here for the same reason as the allowlist rule above. The general
  shape, stated without the method: a containment boundary that a contained process can write
  from inside is not containment. `.claude/` holds configuration that governs how the next
  session runs, so an agent able to write there can influence its own future execution
  context. A specific mechanism of this kind was found, reported to Anthropic, and is omitted
  here pending resolution; the design consequence is what matters and it does not depend on the
  detail. `.claude/` is the same class as `.git/hooks` and `.git/config`, which the sandbox
  already denies, for the same reason: they carry executable code and capability rather than
  content. The write-path enforcement the `paths` field is waiting for must deny all of
  `.claude/` to every agent, and the only principal that writes there is the runner during
  registration, which is not an agent. Full
  measurements in the verification log.
- Flag risks unprompted: vulnerable dependencies, exposed secrets, weak auth, network
  exposure. He is a netadmin and would rather hear it than not.

### Threat worth naming

Agents with write and shell access run unattended, on a corporate machine, across four
trust levels of repository. That is the product, not a bug. What makes it survivable is
that tool restriction is enforced by Claude Code rather than by prompt, that projects
start locked, and that main is protected in the forge rather than by an instruction in a
markdown file. Branch protection is the only guardrail here that does not depend on an
agent choosing to obey.

---

## 15. Deployment

Runs as a background process at logon, with no window.

It must run as Benzoo in his own session, **not** as a Windows service under SYSTEM.
Claude Code authenticates from `~/.claude/.credentials.json` in his profile, which SYSTEM
cannot read. Task Scheduler at logon is the mechanism, not a service wrapper.

With no window there is nothing to show a crash, so a log file and a health endpoint are
required. The health endpoint already exists at `/health`.

On boot, zero agent processes.

---

## 16. Open source

AGPL-3.0, his decision. Planned, not immediate. Consequences that shape the code now:

- Config-driven throughout. No hardcoded paths, no machine-specific assumptions, no
  employer-specific references. His paths appear in this document as context, never in the code.
- No single-user assumptions in the data shape, hence `ownerId`.
- The usage-reading fallback ships behind an opt-in flag documented as unsupported.
- The synthetic-TTY approach is the headline of a published tool, and it will be described
  as running programmatic agent work on interactive subscription billing. He has been told
  this and it is his call to make before publishing, not after.
- Keep this project clearly separate from Mirage, which is his commercial product.

---

## 17. Machine facts

A managed work machine. He administers it himself, so he has latitude, but third-party code with
repository write access matters more here than on a personal box.

```
Windows          11 Pro 10.0.26200 x64
Claude Code      2.1.222, native installer at %USERPROFILE%\.local\bin\claude.exe
Node             v26.0.0
npm              11.12.1
git              2.54.0.windows.1
Docker           29.5.2, Docker Desktop, linux containers
WSL              docker-desktop distro only, no general Linux distro
PowerShell       5.1 (Windows PowerShell, not pwsh 7)
Account          Max plan, Opus 5 with 1M context by default
Repos            C:\Users\<user>\Git
```

PowerShell 5.1 matters: no `&&` or `||` chaining, no ternary, no null-coalescing. Use `;`
and `if ($?)`. This bit repeatedly during setup.

**OneDrive.** Known Folder Move is enabled by policy, so Documents and Desktop redirect into a
synced `OneDrive - <tenant>` folder. Repos were moved out to `C:\Users\<user>\Git`, which is
outside sync. Never point an agent at a repo inside the OneDrive tree: sync races concurrent
writes and produces conflict copies, a synced `.git` gets partially uploaded index and lock
files, sync restores files an agent deliberately deleted, Files On-Demand dehydration breaks
greps, and the tenant-named prefix eats around 40 characters of the 260-char path limit before
`node_modules` starts.

**Reserved ports.** Hyper-V has excluded TCP ranges including 49669-49868, 50000-50059,
52133-52332, 52639-52838, 53706-53905, 57936-58135, 58828-59027. Binding inside those
gives `code 10013 PermissionDenied`. The runner uses 4271, outside all of them. Check with
`netsh interface ipv4 show excludedportrange protocol=tcp` before changing it.

**His settings.json** contains `statusLine` (claude-hud, bash-based), eight enabled
plugins including superpowers and caveman, `"tui": "fullscreen"`,
`skipDangerousModePermissionPrompt: true`, and now the eight Stafford hook registrations.
The bash-based status line and at least one plugin hook fail under a ConPTY-spawned
session unless Git Bash is on the environment the runner builds.

---

## 18. Engineering standards

- Modular and maintainable, because a future agent in a fresh session must pick it up
  cold. Small, well-separated modules over sprawl. This is the standard he names most.
- Tests for non-trivial logic are part of done. Run them and make them pass before
  finishing a task. `node --test` with no framework is what the repo uses.
- Note: `node --test runner/` fails on Node 26, which treats the directory as a module
  path. Use `node --test runner/*.test.js`. Treat a run reporting zero tests as a failure,
  since a glob that matches nothing passes silently.
- Documentation is part of done. Keep this plan current as decisions change.
- Performant within reason. Never trade security or clarity for speed without flagging it.

### Git

- Branch before work. Never commit on main or master directly.
- Conventional Commits: `type(scope): summary`. Types include feat, fix, docs, chore,
  refactor, test, style.
- Prefer one commit at the end of a task, once verified. The exception is the WIP
  checkpoint pattern from section 8, squashed before review.
- Never add co-author trailers.
- **Push rule, amended for this project by him:** agents may push their own feature
  branches. Never push to main or master, never force-push, never delete a remote branch.
  Merging to main is his. His standing rule elsewhere says never push at all, so this
  amendment is deliberate and a fresh session should not revert it.

---

## 19. Build order

Steps 1 and 2 are done and verified.

1. **Done.** Hook forwarder, hook endpoint, state derivation, six passing tests, verified
   against a real Claude Code session.
2. **Done.** Six agent definitions with tool allowlists, `memory:`, `delegation:` and the
   writer's path scope, delivered but not yet installed to `~/.claude/agents/`.
3. **The pty runner.** Spawn a hire's process, stream its terminal over a websocket, send
   typed input to stdin, tie the `SessionStart` session id to that hire. Handle the trust
   prompt, the explicit environment, and pty resize. This is the largest single chunk and
   the point where the design meets reality.
4. **Control plane and registry.** Hires, projects, policies, the JSON store, the seam
   between runner and control plane over an authenticated socket.
5. **The roster and agent detail UI.** Geist dark, xterm.js, the live output tail
   signature. This is the first point where it is usable daily.
6. **Queue and lifecycle.** Idle shutdown, `--resume`, output buffer persistence and
   replay, the per-repo write lock, the provably-idle rule for injection.
7. **Task Scheduler deployment.** Background at logon, logging, health.
8. **Delegation.** The roster tool, propose and direct modes, the three guardrails.
9. **Usage-aware scheduling.** Reading usage, the reserve, the two reset windows,
   rate-limit recovery.
10. **The feature pipeline.** Kinds, approvals, stage routing, the writer path enforcement.
11. **The channel**, then the kanban board.

Honest size read: steps 3 through 6 are two to three weekends and produce something he
would open daily. Everything after that is incremental.

---

## 20. Starting projects

Nothing is open. Two projects to begin with, shipped as `data/projects.json`.

**Stafford**, its own repo at `C:\Users\<user>\Git\Stafford`. All six roles, agents
may push their own feature branches, `acceptEdits` permission mode so they do not stall on
every write, pipeline not required yet.

**Employer work**, one repo so far, sitting outside the synced tree. Corporate code, so
deliberately tighter: no pushing at all, local commits only, three roles (PM assistant, code
reviewer, developer), no WebFetch, pipeline required, `default` permission mode so tool calls
prompt. Both project repos sit outside the OneDrive tree, which is a requirement, not a
preference.

A third project starts from that locked-down shape, not the Stafford one. Default locked, then
opened deliberately.

Also decided since the first draft: the name pool, a ten minute idle timeout, channel
history kept indefinitely, and no proactive usage reading.

---

## 21. Things not to do

Collected because each one was considered and rejected, and each would cost real time to
undo.

- Do not reimplement orchestration. The mailbox, shared task list and claim locking exist
  in Claude Code. Rebuilding them is how this project fails.
- Do not make the kanban board the primary surface.
- Do not derive state from terminal output.
- Do not trust an agent's own claim that it finished.
- Do not let a project policy widen a tool allowlist.
- Do not give any agent the power to apply a permission change.
- Do not build ambient agent-to-agent chat.
- Do not point an agent at a OneDrive-synced repo.
- Do not run the runner as a Windows service.
- Do not spawn agents on boot.
- Do not pass `process.env` straight through to a spawned agent.
- Do not add proactive usage reading without an opt-in flag. Both routes were evaluated
  and rejected.
- Do not use em dashes.