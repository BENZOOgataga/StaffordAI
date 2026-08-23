# Tasks

Status: scoped, not built. This is the feature the whole permission arc was the foundation for. It touches the
runner, the permission system and the checkpoint mechanism, so I am scoping it before writing any of it.

A task is a defined instruction I give to a named colleague, which it works to completion on its own, and which
comes back to me for review before it can close. The point is that I can assign it and walk away.

## Decisions already made

These are settled. The rest of this document designs around them rather than reopening them.

Model A, structured to grow into Model B. Model A is the task object and its lifecycle. Model B is a kanban
board over those same rows, added later. I am not building the board now, and the test of this design is that
adding it later is a new view rather than a rewrite.

The lifecycle is `assigned`, `working`, `needs-you`, `done`, `failed`. Assigned means created and given to a
colleague but not started. Working means the colleague is running it through the headless runner. Needs-you
means it is waiting on me. Done means I approved and closed it. Failed is terminal and means it could not be
completed.

Done is a review state I reach, not a state a colleague reaches. A colleague never marks its own work complete.
When it finishes its attempt the task lands in needs-you and waits for me to approve it, send it back, or fail
it.

Assignment is assign-to-colleague. I pick a colleague and give them the task, which matches how I already work:
I talk to a specific person. Creating a task into an unassigned pool is a Model B extension, noted below and
not built.

Permissions govern the task. A task-working colleague runs under exactly the policy the permission system
already resolves, and an ask pauses the task into needs-you for me. This is the reason permissions were built
first.

## What I am reusing

I went looking before designing, because most of this already exists. Reuse over reinvent.

The `tasks` table is already there, from migration 0001. It has `id`, `agent_id`, `project_id`, `text`, `kind`,
`origin`, `approvals`, `created_at`, `started_at`, `completed_at`. The `Task` interface and a `TaskRepository`
with `insert`, `update`, `get`, `page` and `pageByProject` exist too. So the entity is not new work. What it is
missing is a lifecycle state, which is the one real schema change this needs.

`TaskOrigin` is already `{ kind: 'user' }` or `{ kind: 'agent', agentId }`, so a colleague delegating a task to
another colleague is already expressible in the model, without me designing it now.

`CHANNEL_REF_KINDS` already contains `task`, and a channel message can already carry a `ChannelRef` of
`{ kind: 'task', value: <id> }`. That settles the conversation question below almost by itself.

The permission gate is done and reached. `makeCanUseTool({ hireId, cwd, projectId })` builds a per-turn seam
bound to the colleague and the project, the runner passes it as `canUseTool`, and Claude Code routes every tool
decision to it through `--permission-prompt-tool stdio`. A task turn uses this unchanged. There is no second
permission notion anywhere in this design.

The approval registry already pauses a turn on an ask and sets the colleague to `waiting_for_you`. That is the
same waiting the task lifecycle needs, which is why the two unify below rather than sitting side by side.

`ClaudeRunnerManager.submit(hireId, text)` already queues a message as a turn, strictly serial per colleague,
and records the reply into the conversation. A task instruction is a submit.

The checkpoint executor already commits a colleague's tracked work to
`stafford/checkpoint/<hire>/<timestamp>` through git plumbing over a temporary index, leaving the working tree,
the real index, HEAD and the current branch untouched. A task's result reuses that mechanism, so I do not need
a new git one to show what a colleague did.

It does not reuse the name. Task results land on `stafford/task/<hire>/<task id>`, decided rather than left
open, because a colleague that both works tasks and gets drained would otherwise accumulate branches under one
prefix with nothing saying which is the result I am meant to review. The task id in the name also means a
branch points back at its task without a lookup. This is a small change to `checkpointBranchName`, and it
belongs in phase 1 rather than being discovered in phase 4.

## The task object

The existing row gains a lifecycle and a link to its result. Everything else it already has.

```
ALTER TABLE tasks ADD COLUMN state          TEXT NOT NULL DEFAULT 'assigned';
ALTER TABLE tasks ADD COLUMN result_branch  TEXT;
ALTER TABLE tasks ADD COLUMN result_commit  TEXT;
ALTER TABLE tasks ADD COLUMN result_summary TEXT;
ALTER TABLE tasks ADD COLUMN session_id     TEXT;
ALTER TABLE tasks ADD COLUMN failed_reason  TEXT;
ALTER TABLE tasks ADD COLUMN updated_at     TEXT;
```

`state` is the lifecycle, constrained to the five values. `result_branch` and `result_commit` are where the
work landed, both null until there is any. `result_summary` is the colleague's own closing message for the
task, which is the first thing I read at review. `session_id` is the Claude session the task ran under, so the
transcript for this task is findable rather than mixed in with everything else the colleague ever said.
`failed_reason` carries why, for the terminal failed state. `updated_at` is what a board would sort a column
by.

The existing `approvals` JSON column already holds `Approval[]`, each with an agent id, a verdict, a note and a
timestamp. Every ask that paused this task, and my answer to it, appends there. That gives a task its own
approval history without a new table, and it means the review surface can show me what the colleague asked for
along the way and what I said.

`kind` stays as it is, chore or feature. `origin` stays as it is.

This shape is deliberately a flat row per task with a state column, because that is exactly what a board reads:
one query, group by state, order by `updated_at`. Nothing about Model B needs a different table.

## Assigning a task

I create a task from the colleague I am already looking at. The roster detail pane is where I have a specific
colleague in front of me, so a task is created there, with the project taken from that colleague's active
project rather than asked for again. The Channel is where I talk to a colleague; the detail pane is where I act
on one, and assigning work is an action.

A new task is written with `state = 'assigned'` and starts nothing.

I recommend assigned as a real resting state rather than starting the moment I hit create. Two reasons. I want
to be able to write three tasks and then let them go, rather than having the first one start while I am still
typing the second. And a task that starts on creation makes the assigned state decorative, which then makes the
future board's first column decorative too.

Starting is therefore an explicit act, one Start control on the task, which moves it to working. Later, when I
trust it, a per-colleague autostart setting can make that automatic without changing the lifecycle, because the
transition is the same either way.

## Working a task

Starting a task submits its instruction text through the existing runner path, as that colleague, on that
colleague's project cwd, under the gate bound to that hire and project. Mechanically it is the same call the
Channel already makes when I send a message. What differs is that the task id travels with it, so what comes
back can be attributed.

A task is a bounded sequence of turns, not a single turn.

One turn is too small. Claude Code's `result` event ends a turn, not a job, and a real instruction routinely
needs several rounds of tool calls and thinking. Unbounded is too loose, because an unattended task that keeps
going is exactly the thing I cannot supervise by definition.

So the model is a loop with a cap. The first turn carries the instruction. When a turn ends, the runner asks
whether the task is complete. If it is not, and the cap is not spent, it continues with a short continuation
prompt. If the cap is spent, the task goes to needs-you with a note saying it ran out of turns, which is a
review outcome rather than a failure.

**The cap is 20, raised from 6 on 2026-08-23, and the raise came with an idle stop.**

Six was picked before any task had run. Measured against real runs since, a turn is not a small unit: a
Stafford turn ends at Claude Code's `result`, which is where the model stops of its own accord, so one turn
already contains several tool calls and its own internal rounds. Trivial tasks measured at one to three turns
and roughly $0.13 a turn, so six was generous for those and nowhere near enough for a real feature, which is
the shape the cap was quietly blocking.

Raising a ceiling on an unattended loop is only safe if the runaway case does not scale with it. So the raise
is paired with a second, tighter stop: **two consecutive turns that call no tool and claim no completion end
the attempt**. A turn with no tool call moved nothing, and the only thing that happened is that the colleague
talked. One of those is ordinary, since it can legitimately spend a turn reasoning. Two in a row is a colleague
that has stalled, and the rest of the cap spent on it buys nothing.

The result is that the ceiling went up for work that is progressing while the stuck case got cheaper than it
was at 6: a stalled colleague now costs two turns rather than the whole cap, whatever the cap is. That property
is what the number rests on, so it is asserted in a test that compares the two constants against each other
rather than checking either for a plausible-looking value on its own.

Stopping on no progress lands in needs-you, the same safe direction as a forgotten sentinel. The cost of
stopping too early is a review I did not need; the cost of the opposite is a colleague grinding unwatched.

The 20 is a starting point rather than a measured optimum. It is one constant, already injectable per run, and
the thing to watch is whether real tasks start landing on the ceiling rather than on the sentinel.

Completion detection is the open question I am least sure of, and I would rather name it than pretend it is
solved. The candidate I favour for phase 1 is an explicit completion sentinel: the instruction is wrapped so
the colleague is told to finish its final message with a fixed marker when it considers the task complete, and
the absence of that marker means it has more to do. This is cheap, it needs no new protocol, and it fails in
the safe direction, because a colleague that forgets the marker burns a turn and then lands in needs-you rather
than closing something silently. The alternative, inferring completion from a turn that made no tool calls, is
tempting and wrong, since a colleague can spend a whole turn thinking.

While a task is working, the colleague's roster state is `working`, exactly as today. Nothing new is needed for
the roster to show it.

## The review, which is what needs-you means

When the colleague finishes its attempt, the task moves to needs-you and the colleague goes back to idle. It
does not close the task.

What I see at review, in the order I want to read it:

The instruction I gave, verbatim, because the first thing I need is to remember what I asked for.

The colleague's closing summary, which is `result_summary`, its own account of what it did.

What actually changed, which is the branch and the diff. This is the part I trust more than the summary, because
it is the work rather than a description of the work.

The result branch holds what that task did, and nothing else. This took a fix, and the reason is worth keeping
written down. A drain checkpoint commits whatever is modified in the working tree, which is exactly right for a
drain: on quit, save everything unsaved. It is wrong for a task result, and a checkpoint deliberately never
resets the tree, so after one task the tree still carries its changes and the next task's branch inherited them.
Measured on 2026-08-22, a task that changed nothing produced a branch holding the previous task's edit. That
makes "review what this colleague did" a false claim, and approving a task could carry in work it never touched.

So a task records the tracked state of the tree before its first turn, and the result is the difference between
that and the state at the end, committed onto HEAD. The branch is one reviewable diff of the task's own work.

Refusing to start on a dirty tree was the other candidate and is not viable: since the checkpoint leaves the
tree alone, the tree is dirty the moment any task finishes, so a dirty-tree refusal would let exactly one task
ever run until someone cleaned up by hand.

A new file is a special case, because staging tracked changes only is what keeps a stray `.env` off a branch I
might push, and the cost of that rule is that a task whose whole output is a new file would commit nothing. The
answer is not to sweep up everything untracked. A colleague names the new files that are its deliverable, and
each name is then validated: inside the repository, not ignored, not matching a secret pattern. Naming a file is
a claim, not an authorisation. What was refused is recorded on the task, so the review can say why a file the
colleague mentioned is not on the branch.

Any asks the task hit along the way, from the `approvals` array, so I can see what it wanted to do and what I
allowed.

The task's transcript, filtered by `session_id`, for when the summary and the diff disagree and I need to know
why.

Three controls. Approve closes the task, sets `state = 'done'` and stamps `completed_at`. Send back returns it
to working with a note from me, which becomes the next turn's instruction, so sending back is literally a
continuation with feedback rather than a restart. Fail marks it terminal with a reason, for when the thing was
not possible or I no longer want it.

## Unattended behaviour

The whole point is that I can leave. So what happens while I am gone has to be defined rather than discovered.

A task runs under the same resolved policy as any other session. It does not get wider permissions because it
is unattended. That is worth stating plainly because the opposite is the tempting shortcut: it would be easy to
let a task run with fewer prompts so it does not stall, and that would quietly make the unattended path the
least supervised one, which is exactly backwards.

An allow proceeds. A deny is refused and the colleague is told why, in the message the gate already returns, so
it can reason about it and try another route or explain that it is blocked. A deny does not end the task.

An ask pauses. The turn stops on a pending approval, the colleague goes to `waiting_for_you`, and the task goes
to needs-you. This is the same waiting the approval registry already implements, and it is why needs-you houses
both cases: from my side, a task paused on an ask and a task finished and awaiting review are the same
question, which is that this task needs me. The two differ in what I am shown, an approve or deny prompt versus
a full review, and in what my answer does, resume the turn versus close the task. They do not differ in whether
the task is waiting on me, so they share a state and a badge.

If I quit Stafford with a task in flight, the existing drain applies. The turn is disposed, the colleague's
tracked work is checkpointed to a branch, and a drain report row is written. The task itself should be left in
needs-you with a note that it was interrupted by shutdown, rather than left in working, because working across
a restart would be a lie: nothing is working. This is listed as an open question below because I have not
decided whether an interrupted task should offer to resume on next launch.

## Who moves a task, and the invariant

I create a task, which puts it in assigned. I start it, which moves it to working.

The colleague moves it from working to needs-you when it finishes an attempt, hits an ask, or runs out of
turns. The colleague may move it to failed when it cannot proceed at all.

I move it from needs-you to done, back to working, or to failed.

The invariant, which mirrors the permission invariant exactly: a colleague can never move a task to done. Only
I close a task. The human closes consequential loops. In the permission system the loop is what a colleague is
allowed to do, and only I set that. Here the loop is whether work is acceptable, and only I decide that. Both
are enforced by where the write happens rather than by convention, because the transition to done is only
reachable from the renderer over IPC, which no colleague can reach.

## Relationship to conversations

A task is a distinct object, referenced from the conversation. It is not a special message and it is not a
separate thread.

The model already supports this. `CHANNEL_REF_KINDS` contains `task`, and a channel message can carry
`{ kind: 'task', value: <task id> }`. So assigning a task appends a message to that colleague's conversation
that references the task, the colleague's turns during the task record replies as they already do, and the
closing summary is a message carrying the same reference.

That keeps both views coherent. The conversation stays the single readable history of everything that passed
between me and a colleague, including its task work, so I never have to read two places to reconstruct what
happened. The task view stays a focused object with a lifecycle, a result and controls, so I am not scrolling a
chat to find out whether something is done. The reference is what ties them, and clicking a task reference in
the conversation opens the task.

Making a task a special message would have made the lifecycle live inside the message store, which the board
would then have to reconstruct by scanning. Making it a separate thread would have split the history in two.

## Model B, the board, and the pool

Not built. Recorded so the shape stays deliberate.

The board is a view over the rows above. Columns are the lifecycle states, cards are tasks, and the card shows
the instruction, the colleague and the age. Moving a card between columns performs the same transitions this
document already defines, with the same invariant, so drag to done from a colleague-side action is simply not
offered. The query is one select over `tasks`, grouped by `state`, ordered by `updated_at`, which is why that
column exists now rather than later.

The pool, meaning creating a task with no colleague and letting one pick it up, is a Model B extension. In the
schema it is `agent_id` becoming nullable and a new lifecycle entry before assigned. I am not doing it now
because it changes how I work, and assign-to-colleague matches how I actually work today. Noting it is enough
to make sure nothing here forbids it.

## Phasing

Each phase is provable by doing the thing, not by a passing test alone.

Phase 1, the smallest slice that delivers assign and review. The migration, the lifecycle on the existing task
row, creating and assigning a task from the roster detail pane, starting it, running it as a single instruction
through the existing runner under the existing gate, the completion sentinel, the needs-you review surface with
the summary and the branch, and approve and fail. Provable by giving a colleague a real task, walking away,
coming back to a review, approving it, and finding the work on a branch.

Phase 2, the turn loop and send back. Multi-turn continuation with a cap, out-of-turns landing in needs-you,
and send back with my note becoming the continuation. Provable by giving a task that genuinely cannot be done
in one turn and watching it finish, then sending one back and watching it continue rather than restart.

Phase 3, asks inside tasks. Ask pausing the task into needs-you, the approvals array recording the exchange,
and my answer resuming the turn. Provable by giving a task whose work requires a destructive command, leaving,
and finding it waiting for me. Some of this falls out of phase 1 for free, since the gate and the registry
already do it; the work is the task-side state and the surfacing.

Phase 4, the board. Columns over the same rows, with drag performing the same transitions.

Phase 5, the pool, if I still want it.

## Risks and open questions

Completion detection is the biggest one. The sentinel is cheap and fails safe, but it depends on a colleague
following an instruction, which is not a guarantee. If it proves unreliable I would rather move to an explicit
protocol, a tool the colleague calls to declare completion, than to inference over turn shape. Worth measuring
before committing.

Failure detection is barely designed. Right now failed is a state I can set and a colleague can set. What I
have not defined is what an automatic failure looks like, for example a turn that errors repeatedly. My
inclination is that almost nothing should auto-fail, and that a task which cannot proceed should land in
needs-you and let me decide, because a task silently marked failed is as bad as one silently marked done.

A task in flight at quit. The drain covers the process and the work, but I have not decided whether an
interrupted task should resume on next launch or wait for me to restart it. Resuming is friendlier; waiting is
more honest about the fact that I was not there. This has the same shape as the open question about pending
asks surviving a restart, recorded in the permission plan, and the two should be answered together so Stafford
behaves consistently across a restart.

Whether needs-you should be one badge or two. I have designed it as one state with two presentations. It might
turn out that a task paused mid-work and a task awaiting review feel different enough to want separate signals
on the roster. Cheap to split later, since it is a presentation change over one state.

Whether the cap should be per project rather than one constant. It is 20 as of 2026-08-23, with an idle stop
that makes the stalled case cost two turns regardless, and it is already injectable per run. What would justify
making it configurable is evidence that real tasks differ enough between projects to need it, which I do not
have yet: the thing to watch is whether tasks start landing on the ceiling rather than on the sentinel.

## Next action and recommendation

Next action is that I read this and approve or change it, then build phase 1.

Recommendation: keep phase 1 to a single-turn task and resist the turn loop until phase 2, even though a
single-turn task will sometimes be too small to finish real work. The reason is that phase 1's real risk is not
the loop, it is completion detection and the review surface, and those are much easier to judge when exactly
one turn has happened. Get assign, run, review and approve working end to end on something small, confirm the
sentinel behaves, then add the loop on a foundation I trust.
