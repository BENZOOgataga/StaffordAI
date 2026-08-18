# Git executor: scope and split

The drain reaps colleagues cleanly but writes `committed=false` every time, because nothing turns a
checkpoint into a real commit. So "your colleague's work is saved when you quit" is a placeholder. This scopes
the executor that makes it real, before building any of it. The executor can do genuine harm (a junk or
secret commit, a polluted main), so the two safety decisions come first.

This reads against how the drain works today and must fit inside it, not fight it: a per-agent checkpoint
budget of 45s clamped to what is left of a 120s total, a `drain_report` row written per agent as it resolves
(`committed`, `branch`, `commit_id`, `outcome`), the `killTree` force-kill, and the forced `app.exit(0)`
backstop. The agent's `checkpoint()` returns `{committed, branch, commitId}` and the drain already records it;
the executor is the real body of that placeholder.

## 1. What gets committed

Recommend committing tracked modifications only, not everything.

The options are commit everything (`git add -A`, including untracked files), commit only tracked
modifications (`git add -u`, so new untracked files are not added), or commit named paths. The danger of
commit-everything is real and unattended: it sweeps in whatever is sitting in the working tree, which on a
colleague's repo can be `node_modules`, build output, or a `.env` the colleague created and never meant to
commit. A drain that commits a secret is an incident, and the drain runs automatically at quit with no one
watching, so it must not be the thing that does it.

Tracked-modifications-only removes that whole class of risk structurally. `git add -u` stages changes and
deletions to files git already tracks and adds no new file, so an untracked `.env` or a fresh `node_modules`
cannot enter the commit no matter what is in the working tree. It also sidesteps `.gitignore` entirely:
whether or not the colleague's repo has one, tracked-only never consults it because it never considers a new
file, so the safety does not depend on a gitignore being present or correct.

The residual risk, stated plainly: a secret added to a file that is already tracked (someone pasted a key
into a tracked config and modified it) would be captured, because that is a tracked modification. That is a
pre-existing tracked secret, not one the drain introduced by sweeping, and it lands on a checkpoint branch the
person reviews rather than on their working branch. The other cost is that new files the colleague wrote are
not in the checkpoint commit. They are not lost: the drain kills the process, it does not delete the working
tree, so untracked files stay on disk exactly where they were. The checkpoint captures the tracked edits; the
new files remain in the working tree for the person to add deliberately.

A secret scan on the staged diff, refusing to commit and reporting when it sees a key-shaped string or a
forced ignored path, is out of scope for v1. Tracked-only already prevents the add-everything sweep, which is
the real exposure, and a diff scan adds time inside a bounded drain and false positives that would drop a
legitimate checkpoint. It is a reasonable later hardening, noted, not built now.

## 2. On what branch

Recommend a dedicated checkpoint branch, never in place.

Committing in place on the colleague's current branch is dangerous, because the current branch might be main
or a shared feature branch, and a half-finished emergency checkpoint should never land there. The alternative
is a dedicated branch, `stafford/checkpoint/<hire>/<timestamp>`, that preserves the work without touching the
working branch. The work is saved and inspectable, main and the working branch stay clean, and the person
merges or discards the checkpoint deliberately later. The checkpoint-branch model wins.

The mechanism matters, because the executor must not disturb the colleague's working tree, index, or current
branch while it does this. It should not check the branch out. The clean way is git plumbing over a temporary
index:

1. Copy the repo's index to a temp file and point `GIT_INDEX_FILE` at the copy, so the colleague's own staged
   state is never touched.
2. `git add -u` into the temp index, staging tracked modifications only.
3. `git write-tree` from the temp index to get a tree object.
4. If that tree equals `HEAD`'s tree, there is nothing to commit (see case 3). Otherwise `git commit-tree
   <tree> -p HEAD` to create a commit object with the current HEAD as its parent.
5. `git update-ref refs/heads/stafford/checkpoint/<hire>/<timestamp> <commit>` to create the branch pointing
   at that commit.

Nothing here checks anything out, moves HEAD, or mutates the real index, so the colleague's working tree and
current branch are byte-for-byte unchanged. The branch name is derived from the hire id (or a slug of the
name) and the drain timestamp, and is written to `drain_report.branch` on success. The commit is authored as
Stafford, not the person, through `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` on the commit-tree call, so the row
reads as a machine checkpoint and is never misattributed. Signing is disabled explicitly
(`-c commit.gpgsign=false`) so a configured signing setup cannot prompt or hang.

## 3. Empty and failure cases

Nothing to commit is not a failure. When the temp-index tree equals HEAD's tree, the working tree has no
tracked changes, so no commit is made and `committed=false` is honest. This is distinct from a commit that was
attempted and failed, and the report should say which. The three current fields cannot carry that
distinction, so the storage piece adds a nullable `reason` column to `drain_report` (and a `reason` to the
`CheckpointResult` the executor returns): `clean` for nothing to commit, an error summary for a failure,
`timed-out` for the bound in section 4. Without it, a clean tree and a failed commit are the same row, which
is exactly the confusion this decision is meant to remove.

A commit that fails must never hang or crash the drain. Because the executor uses plumbing, the failure modes
are narrow: a locked index (someone else is writing), a corrupt object store, a repo that is not git at all,
or an `update-ref` race. Each git call is run as a bounded child (section 4); a non-zero exit or a spawn error
is caught inside the executor, which resolves with `committed=false` and a `reason`, never throws past the
drain. The drain then records `checkpointed` with `committed=false` and moves to the next colleague, which is
its existing behaviour for a checkpoint that finished without a commit. A repo that is not a git repository at
all resolves the same way with `reason=not-a-git-repo`.

Git hooks do not run, and that is the right call. The plumbing commands (`write-tree`, `commit-tree`,
`update-ref`) are plumbing and do not fire `pre-commit` or `commit-msg` hooks at all, so `--no-verify` is not
even needed: a repo's own hook cannot run arbitrary slow or failing code inside the drain, because it is never
invoked. The trade-off is that the checkpoint is not validated by the person's intended pre-commit checks. For
an unattended, bounded, emergency checkpoint that the person will review before merging, that is correct: a
failing lint hook must not be the reason a colleague's work is lost. The hooks are for the person's deliberate
commits, not for the machine's safety net.

## 4. The time bound

The executor fits the drain's existing discipline and adds no unbounded path. Every git child is spawned with
a timeout well under the 45s per-agent budget (on the order of 15s for the whole executor, since these
plumbing calls are milliseconds on any normal repo and only a pathological one is slow). On overrun the git
child is reaped (through the existing `killTree`, reused, not a new kill path) and the executor resolves with
`committed=false, reason=timed-out`. Because the executor always resolves within its own cap, the drain's own
per-agent timeout is a backstop that should never fire for a slow commit: a slow git is reported as
`timed-out` and the drain moves on, rather than the agent being force-killed for it. The drain's per-agent and
total caps remain the outer guarantee that the app always quits, and the forced `app.exit(0)` remains behind
that.

## 5. What committed comes to mean

After this, `committed=true` means the work was genuinely saved to a real commit, and the row carries a real
branch and sha. The existing fields are populated for real:

- Success: `outcome=committed`, `committed=true`, `branch=stafford/checkpoint/<hire>/<timestamp>`,
  `commit_id=<sha>`, `reason=null`.
- Nothing to commit: `outcome=checkpointed`, `committed=false`, `branch=null`, `commit_id=null`,
  `reason=clean`.
- Commit failed: `outcome=checkpointed`, `committed=false`, `branch=null`, `commit_id=null`,
  `reason=<short error>`.
- Timed out in the executor: `outcome=checkpointed`, `committed=false`, `reason=timed-out`.
- Force-killed by the drain (the agent process itself hung before the executor could resolve):
  `outcome=force-killed`, `committed=false`, unchanged from today.

## 6. The build split

Two pieces.

1. The git executor module, bounded and tested on its own. A pure-ish module that takes a cwd, a hire
   identity, a budget, and an injected git runner, and performs the temp-index plumbing of section 2:
   stage tracked modifications, compare to HEAD, create the checkpoint commit and branch or report the empty
   or failed or timed-out case, all bounded, returning the extended `CheckpointResult`. Tested against a real
   temporary git repository (a clean tree, a tracked modification, a tracked deletion, an untracked file that
   must be excluded, a not-a-git-repo, a forced timeout) plus a real-machine test for the real plumbing. This
   is first, because it proves the safe commit mechanism in isolation with no drain risk: tracked-only, no
   checkout, no hooks, bounded, every case handled.

2. Wire it into the drain in place of the placeholder, with the report change. Replace the registry's
   placeholder `#checkpoint` so it runs the executor with the session's own cwd and hire identity before the
   teardown, add the `reason` column to `drain_report` (migration 0004) and the `reason` field to
   `CheckpointResult`, and record the real branch, sha, and reason per outcome. Depends on piece 1. It proves
   `committed=true` is real end to end through the actual drain, and that a colleague's tracked work survives
   a quit on a checkpoint branch.

## Constraints honoured

Tracked-only so the executor can never sweep a secret or junk into a commit, which is decision 1. A dedicated
checkpoint branch so nothing lands on main or the working branch. The executor fits the existing bounded drain
with its own child timeouts under the per-agent budget and reuses `killTree` rather than adding a kill path.
No `ProjectPolicy.sandbox`, no change to the pin, the spawn internals, `.npmrc`, or the guards. Scope only; no
executor code, no drain change, no migration in this pass.

## Next action and recommendation

Build piece 1 next, the git executor module in isolation. Implement the temp-index plumbing commit against a
real temporary git repository, tracked-only, on a checkpoint branch, bounded, with the empty, failed,
not-a-repo, and timed-out cases each returning a typed `CheckpointResult`. Prove it with a repo fixture and a
real-machine test, with no drain wiring yet.

One recommendation: make the executor's tests build a real throwaway git repo in a temp dir and assert the
working tree and current branch are untouched after a checkpoint, not just that the commit exists. The whole
safety of the temp-index-plus-plumbing approach is that it does not disturb the colleague's repo, and the only
honest way to prove that is to check the repo is exactly as it was, on top of checking the checkpoint branch
holds the tracked changes. That assertion is what will catch a future change that accidentally reaches for
`git checkout` or a real `git commit` and starts mutating the working tree.
