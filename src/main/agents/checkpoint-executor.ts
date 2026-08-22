/**
 * Commits a colleague's tracked work to a dedicated checkpoint branch, without ever
 * touching the repo.
 *
 * The drain gives each colleague a bounded chance to save its work on quit. This is
 * the body of that save. Its whole safety rests on one property: it does not disturb
 * the colleague's working tree, index, HEAD, or current branch. It gets there with
 * git plumbing over a temporary index. It copies the index to a temp file, stages
 * tracked modifications into the copy with `add -u`, writes a tree from the copy,
 * makes a commit object from that tree with the current HEAD as its parent, and
 * points a new branch at the commit. Nothing is checked out and nothing real is
 * mutated, so the repo ends byte-for-byte as it was and the work is saved on a branch
 * the person reviews and merges or discards deliberately.
 *
 * `add -u` is the second half of the safety. It stages changes and deletions to files
 * git already tracks and adds no new file, so an untracked `.env` or a fresh
 * `node_modules` cannot enter the commit no matter what is in the working tree. That
 * is structural: there is no path here that commits an untracked file, which is why a
 * drain cannot leak a secret it swept in.
 *
 * The module always resolves to a typed outcome. A git error is caught and returned
 * as a reason, never thrown at the caller; a git child that overruns its bound is
 * reaped and returned as timed-out, never left to hang. So piece 2 can call this
 * inside the bounded drain without adding an unbounded or throwing path.
 *
 * The plumbing commands (`write-tree`, `commit-tree`, `update-ref`) do not fire a
 * repo's `pre-commit` or `commit-msg` hooks, so a user hook cannot run slow or failing
 * code inside the drain. Signing is disabled explicitly so a configured signer cannot
 * prompt or hang, and the commit is authored as Stafford, not the person.
 */

/** One git invocation's result, as the module reads it. */
export interface GitRun {
    readonly stdout: string;
    readonly stderr: string;
    /** The exit code, or null when the child was killed for overrunning its bound. */
    readonly code: number | null;
    readonly timedOut: boolean;
}

export interface RunGitOptions {
    readonly cwd: string;
    readonly env?: Record<string, string>;
    readonly timeoutMs: number;
}

/** The temp index the module stages into: its path, and whether it was seeded from the real index. */
export interface TempIndex {
    readonly path: string;
    /** True when the real index was copied in. False when there was none, so HEAD seeds it instead. */
    readonly seeded: boolean;
}

/** The I/O the module needs, injected so it is driven by stubs in a unit test. */
export interface CheckpointDeps {
    /** Runs one git command, bounded by timeoutMs, reaping the child on overrun. */
    runGit(args: readonly string[], options: RunGitOptions): Promise<GitRun>;
    /** Copies the real index to a temp file for staging, or reports there was none to copy. */
    prepareTempIndex(realIndexPath: string): Promise<TempIndex>;
    /** Removes the temp index. Best effort, never throws. */
    cleanupTempIndex(path: string): Promise<void>;
}

export type CheckpointReason = 'ok' | 'clean' | 'timed-out' | 'not-a-git-repo' | 'no-commits' | 'error';

/** The typed outcome. committed is true only for reason 'ok'. */
export interface CheckpointOutcome {
    readonly committed: boolean;
    readonly branch: string | null;
    readonly commitId: string | null;
    readonly reason: CheckpointReason;
    /** A short error summary when reason is 'error', else null. Never a transcript or a diff. */
    readonly detail: string | null;
}

export interface CheckpointRequest {
    readonly cwd: string;
    readonly hireId: string;
    /** A timestamp string for the branch name, injected so the module reads no clock. */
    readonly stamp: string;
    readonly budgetMs?: number;
    /**
     * The ref to point at the commit, overriding the drain's checkpoint name. A task result
     * uses `taskBranchName` here so it lands under its own prefix and carries its task id.
     *
     * Only the name changes. The staging rule does not, which is the reason a task reuses
     * this function rather than committing for itself: `add -u` stages tracked modifications
     * only, so a task result can never sweep up an untracked .env the colleague happened to
     * write next to its work.
     */
    readonly branch?: string;
    /** The commit message, overriding the drain's. */
    readonly message?: string;
}

export const DEFAULT_CHECKPOINT_BUDGET_MS = 15_000;

const STAFFORD_IDENTITY: Record<string, string> = {
    GIT_AUTHOR_NAME: 'Stafford',
    GIT_AUTHOR_EMAIL: 'stafford@localhost',
    GIT_COMMITTER_NAME: 'Stafford',
    GIT_COMMITTER_EMAIL: 'stafford@localhost'
};

/** Makes a git-ref-safe segment from an id: only word characters, dot, dash, bounded. */
function refSlug(value: string): string {
    const cleaned = value
        .replace(/[^A-Za-z0-9._-]+/g, '-')   // anything a ref forbids becomes a dash
        .replace(/\.\.+/g, '-')               // no double dot in a ref
        .replace(/\.lock$/i, '-lock')         // a ref may not end in .lock
        .replace(/^[-.]+|[-.]+$/g, '');        // no leading or trailing dash or dot
    return cleaned.length > 0 ? cleaned.slice(0, 80) : 'x';
}

/** The checkpoint branch for a hire and a timestamp, both slugged to be ref-safe. */
export function checkpointBranchName(hireId: string, stamp: string): string {
    return 'stafford/checkpoint/' + refSlug(hireId) + '/' + refSlug(stamp);
}

/**
 * The branch a task's result lands on.
 *
 * A different prefix from the drain's checkpoints on purpose. A colleague that both works
 * tasks and gets drained would otherwise pile branches under one prefix with nothing saying
 * which is the result I am meant to review, and the task id in the name means a branch points
 * back at its task without a lookup.
 */
export function taskBranchName(hireId: string, taskId: string): string {
    return 'stafford/task/' + refSlug(hireId) + '/' + refSlug(taskId);
}

function outcome(reason: CheckpointReason, over: Partial<CheckpointOutcome> = {}): CheckpointOutcome {
    return { committed: false, branch: null, commitId: null, reason, detail: null, ...over };
}

/**
 * Checkpoints the repo at `req.cwd`. Always resolves to a typed outcome: it never
 * throws to the caller and never hangs, because every git child is bounded and a
 * timeout or an error resolves to a reason.
 */
export async function checkpointRepo(deps: CheckpointDeps, req: CheckpointRequest): Promise<CheckpointOutcome> {
    const budget = req.budgetMs ?? DEFAULT_CHECKPOINT_BUDGET_MS;
    const run = (args: readonly string[], env?: Record<string, string>): Promise<GitRun> =>
        deps.runGit(args, { cwd: req.cwd, timeoutMs: budget, ...(env ? { env } : {}) });

    try {
        // Is this a git repository at all, and where is its git dir? A non-repo, or a
        // git that cannot run, is a clean no, not a crash.
        const gitDir = await run(['rev-parse', '--absolute-git-dir']);
        if (gitDir.timedOut) return outcome('timed-out');
        if (gitDir.code !== 0) return outcome('not-a-git-repo');

        // HEAD's commit and tree. An unborn branch (a repo with no commits) has no HEAD
        // to parent onto, so there is nothing to checkpoint against yet.
        const head = await run(['rev-parse', 'HEAD']);
        if (head.timedOut) return outcome('timed-out');
        if (head.code !== 0) return outcome('no-commits');
        const headSha = head.stdout.trim();

        const headTree = await run(['rev-parse', 'HEAD^{tree}']);
        if (headTree.timedOut) return outcome('timed-out');
        if (headTree.code !== 0) return outcome('no-commits');
        const headTreeSha = headTree.stdout.trim();

        const temp = await deps.prepareTempIndex(gitDir.stdout.trim() + '/index');
        try {
            const indexEnv = { GIT_INDEX_FILE: temp.path };

            // If the real index could not be copied, seed the temp index from HEAD, so
            // `add -u` has the tracked set to update rather than an empty index that
            // would write a tree deleting everything.
            if (!temp.seeded) {
                const readTree = await run(['read-tree', 'HEAD'], indexEnv);
                if (readTree.timedOut) return outcome('timed-out');
                if (readTree.code !== 0) return outcome('error', { detail: short(readTree.stderr) });
            }

            // Stage tracked modifications and deletions only, into the temp index. No
            // untracked file can be added here, which is the secret-safety property.
            const add = await run(['add', '-u'], indexEnv);
            if (add.timedOut) return outcome('timed-out');
            if (add.code !== 0) return outcome('error', { detail: short(add.stderr) });

            const writeTree = await run(['write-tree'], indexEnv);
            if (writeTree.timedOut) return outcome('timed-out');
            if (writeTree.code !== 0) return outcome('error', { detail: short(writeTree.stderr) });
            const tree = writeTree.stdout.trim();

            // No tracked change: the staged tree is HEAD's tree. Nothing to save is not
            // a failure, so this is an honest clean, distinct from an error.
            if (tree === headTreeSha) return outcome('clean');

            const branch = req.branch ?? checkpointBranchName(req.hireId, req.stamp);
            const message = req.message ?? ('Stafford checkpoint for ' + req.hireId + ' at ' + req.stamp);
            // commit-tree builds a commit object from the tree with HEAD as parent. It
            // reads no index and fires no hook. Signing off, identity Stafford.
            const commit = await run(
                ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', headSha, '-m', message],
                STAFFORD_IDENTITY
            );
            if (commit.timedOut) return outcome('timed-out');
            if (commit.code !== 0) return outcome('error', { detail: short(commit.stderr) });
            const commitId = commit.stdout.trim();

            // Point the new branch at the commit. This creates a ref and touches
            // nothing else: not HEAD, not the working tree, not the current branch.
            const updateRef = await run(['update-ref', 'refs/heads/' + branch, commitId]);
            if (updateRef.timedOut) return outcome('timed-out');
            if (updateRef.code !== 0) return outcome('error', { detail: short(updateRef.stderr) });

            return { committed: true, branch, commitId, reason: 'ok', detail: null };
        } finally {
            await deps.cleanupTempIndex(temp.path).catch(() => { /* best effort */ });
        }
    } catch (error) {
        // The module's contract is that it never throws at the caller. Any surprise
        // resolves to an error outcome so the drain records it and moves on.
        return outcome('error', { detail: short(error instanceof Error ? error.message : String(error)) });
    }
}

/** A short, single-line error summary. Never the full output, so nothing sensitive travels. */
function short(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, 200) || 'git failed';
}
