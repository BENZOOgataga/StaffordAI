/**
 * Composing a task's result branch, so it contains exactly what that task did.
 *
 * **The bug this exists to fix.** The drain's checkpoint commits whatever is modified in the
 * working tree, which is right for a drain: on quit, "save everything unsaved" is the whole
 * job. It is wrong for a task result. A checkpoint never resets the tree, deliberately, so
 * after one task the tree still carries that task's changes, and the next task's result
 * branch inherited them. Measured on 2026-08-22: a task that changed nothing produced a
 * branch containing the previous task's edit. That makes "review what this colleague did" a
 * false claim, and approving a task could carry in work it never touched.
 *
 * **Why not simply refuse to start on a dirty tree.** It reads as the simpler fix, and it is
 * not viable here. The checkpoint leaves the working tree exactly as it found it, which is a
 * tested safety property worth keeping, so the tree is still dirty the moment a task finishes.
 * A dirty-tree refusal would therefore let exactly one task ever run, until a person cleaned
 * up by hand. The isolation has to come from knowing what changed, not from insisting nothing
 * had.
 *
 * **How it works.** At task start the tracked state of the tree is written as a tree object
 * and remembered. At completion the tracked state is written again, and the difference between
 * the two is precisely the set of paths the task changed. The result commit is then built as
 * HEAD plus those paths and nothing else, parented on HEAD, so the branch is a clean single
 * diff that could be reviewed or merged on its own.
 *
 * **What it still refuses to commit.** Untracked files are not swept up, exactly as before,
 * because a stray `.env` beside the work must never reach a branch I might push. New files
 * reach the result only when the colleague names them and they survive validation.
 */

import {
    DEFAULT_CHECKPOINT_BUDGET_MS,
    type CheckpointDeps, type CheckpointOutcome, type CheckpointReason, type GitRun
} from './checkpoint-executor.ts';

const STAFFORD_IDENTITY: Record<string, string> = {
    GIT_AUTHOR_NAME: 'Stafford',
    GIT_AUTHOR_EMAIL: 'stafford@localhost',
    GIT_COMMITTER_NAME: 'Stafford',
    GIT_COMMITTER_EMAIL: 'stafford@localhost'
};

/**
 * How many changed paths one task result may carry.
 *
 * A bound rather than a promise of unlimited scale. A task that touched more files than this
 * is not a task I am going to review as a diff anyway, and the alternative is firing an
 * unbounded number of git children while a person waits.
 */
export const MAX_RESULT_PATHS = 1000;

/** How many paths go into one git invocation, so a wide change does not overrun the arg limit. */
const PATH_CHUNK = 100;

/** The tracked state of the working tree at a moment, as a tree object. */
export interface TaskBaseline {
    /** The tree sha, or null when it could not be taken. A null baseline is not fatal. */
    readonly tree: string | null;
    /** Why there is no tree, for the log. Null on success. */
    readonly reason: CheckpointReason | null;
}

export interface TaskBaselineRequest {
    readonly cwd: string;
    readonly budgetMs?: number;
}

export interface TaskResultRequest {
    readonly cwd: string;
    /** The tree recorded at task start. Null falls back to HEAD, i.e. no isolation. */
    readonly baselineTree: string | null;
    /** Repo-relative paths of new files the colleague declared, already validated. */
    readonly declaredOutputs?: readonly string[];
    readonly branch: string;
    readonly message: string;
    readonly budgetMs?: number;
}

function outcome(reason: CheckpointReason, over: Partial<CheckpointOutcome> = {}): CheckpointOutcome {
    return { committed: false, branch: null, commitId: null, reason, detail: null, ...over };
}

function short(text: string): string {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > 200 ? oneLine.slice(0, 200) + '...' : oneLine;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

/**
 * The tracked state of the tree right now, as a tree object, for a task about to start.
 *
 * Staged into a temp index so the real index is untouched, the same discipline the drain's
 * checkpoint uses. It writes a tree object into the repository and no ref points at it, so it
 * is unreachable and git will collect it if the task never finishes. That is the correct
 * behaviour for an abandoned task and needs no cleanup path.
 */
export async function taskBaseline(deps: CheckpointDeps, req: TaskBaselineRequest): Promise<TaskBaseline> {
    const budget = req.budgetMs ?? DEFAULT_CHECKPOINT_BUDGET_MS;
    const run = (args: readonly string[], env?: Record<string, string>): Promise<GitRun> =>
        deps.runGit(args, { cwd: req.cwd, timeoutMs: budget, ...(env ? { env } : {}) });

    try {
        const gitDir = await run(['rev-parse', '--absolute-git-dir']);
        if (gitDir.timedOut) return { tree: null, reason: 'timed-out' };
        if (gitDir.code !== 0) return { tree: null, reason: 'not-a-git-repo' };

        const head = await run(['rev-parse', 'HEAD']);
        if (head.timedOut) return { tree: null, reason: 'timed-out' };
        if (head.code !== 0) return { tree: null, reason: 'no-commits' };

        const temp = await deps.prepareTempIndex(gitDir.stdout.trim() + '/index');
        try {
            const indexEnv = { GIT_INDEX_FILE: temp.path };
            // Always from HEAD, not from a copy of the real index. A staged-but-uncommitted
            // change is pre-existing state exactly like an unstaged one, and starting from
            // HEAD means the baseline means the same thing however the person left the index.
            const readTree = await run(['read-tree', 'HEAD'], indexEnv);
            if (readTree.timedOut) return { tree: null, reason: 'timed-out' };
            if (readTree.code !== 0) return { tree: null, reason: 'error' };

            const add = await run(['add', '-u'], indexEnv);
            if (add.timedOut) return { tree: null, reason: 'timed-out' };
            if (add.code !== 0) return { tree: null, reason: 'error' };

            const writeTree = await run(['write-tree'], indexEnv);
            if (writeTree.timedOut) return { tree: null, reason: 'timed-out' };
            if (writeTree.code !== 0) return { tree: null, reason: 'error' };

            return { tree: writeTree.stdout.trim(), reason: null };
        } finally {
            await deps.cleanupTempIndex(temp.path).catch(() => { /* best effort */ });
        }
    } catch {
        return { tree: null, reason: 'error' };
    }
}

/** Repo-relative paths git ignores, of the ones asked about. For validating declared outputs. */
export async function ignoredPaths(
    deps: CheckpointDeps, cwd: string, paths: readonly string[], budgetMs?: number
): Promise<Set<string>> {
    const ignored = new Set<string>();
    if (paths.length === 0) return ignored;
    const budget = budgetMs ?? DEFAULT_CHECKPOINT_BUDGET_MS;
    for (const group of chunk(paths, PATH_CHUNK)) {
        // check-ignore exits 1 when nothing matched, which is an answer and not a failure.
        const out = await deps.runGit(['check-ignore', '--', ...group], { cwd, timeoutMs: budget })
            .catch(() => null);
        if (!out || out.timedOut) continue;
        for (const line of out.stdout.split('\n')) {
            const value = line.trim();
            if (value !== '') ignored.add(value.replace(/\\/g, '/'));
        }
    }
    return ignored;
}

/** Repo-relative paths already in the index, of the ones asked about. */
export async function trackedPaths(
    deps: CheckpointDeps, cwd: string, paths: readonly string[], budgetMs?: number
): Promise<Set<string>> {
    const tracked = new Set<string>();
    if (paths.length === 0) return tracked;
    const budget = budgetMs ?? DEFAULT_CHECKPOINT_BUDGET_MS;
    for (const group of chunk(paths, PATH_CHUNK)) {
        const out = await deps.runGit(['ls-files', '--', ...group], { cwd, timeoutMs: budget })
            .catch(() => null);
        if (!out || out.timedOut || out.code !== 0) continue;
        for (const line of out.stdout.split('\n')) {
            const value = line.trim();
            if (value !== '') tracked.add(value.replace(/\\/g, '/'));
        }
    }
    return tracked;
}

/**
 * Commits the task's own changes to its result branch.
 *
 * The shape is HEAD plus the paths that changed between the baseline and now, plus any
 * declared new files. Anything that was already dirty when the task started and that the task
 * did not touch is simply not in the result, which is the entire point.
 *
 * Like the drain's checkpoint it never throws and never hangs: every git child is bounded and
 * any surprise resolves to a typed reason.
 */
export async function commitTaskResult(
    deps: CheckpointDeps, req: TaskResultRequest
): Promise<CheckpointOutcome> {
    const budget = req.budgetMs ?? DEFAULT_CHECKPOINT_BUDGET_MS;
    const run = (args: readonly string[], env?: Record<string, string>): Promise<GitRun> =>
        deps.runGit(args, { cwd: req.cwd, timeoutMs: budget, ...(env ? { env } : {}) });

    try {
        const gitDir = await run(['rev-parse', '--absolute-git-dir']);
        if (gitDir.timedOut) return outcome('timed-out');
        if (gitDir.code !== 0) return outcome('not-a-git-repo');

        const head = await run(['rev-parse', 'HEAD']);
        if (head.timedOut) return outcome('timed-out');
        if (head.code !== 0) return outcome('no-commits');
        const headSha = head.stdout.trim();

        const headTree = await run(['rev-parse', 'HEAD^{tree}']);
        if (headTree.timedOut) return outcome('timed-out');
        if (headTree.code !== 0) return outcome('no-commits');
        const headTreeSha = headTree.stdout.trim();

        const baseline = req.baselineTree ?? headTreeSha;
        const declared = req.declaredOutputs ?? [];

        const temp = await deps.prepareTempIndex(gitDir.stdout.trim() + '/index');
        try {
            const indexEnv = { GIT_INDEX_FILE: temp.path };

            // The tracked state as it stands now, taken the same way the baseline was, so the
            // two are comparable. Both start from HEAD for that reason.
            const readNow = await run(['read-tree', 'HEAD'], indexEnv);
            if (readNow.timedOut) return outcome('timed-out');
            if (readNow.code !== 0) return outcome('error', { detail: short(readNow.stderr) });

            const addAll = await run(['add', '-u'], indexEnv);
            if (addAll.timedOut) return outcome('timed-out');
            if (addAll.code !== 0) return outcome('error', { detail: short(addAll.stderr) });

            const writeNow = await run(['write-tree'], indexEnv);
            if (writeNow.timedOut) return outcome('timed-out');
            if (writeNow.code !== 0) return outcome('error', { detail: short(writeNow.stderr) });
            const nowTree = writeNow.stdout.trim();

            // What this task changed: the paths that differ between the tree at start and the
            // tree now. Not "everything dirty", which is the whole fix.
            const diff = await run(['diff', '--name-only', baseline, nowTree]);
            if (diff.timedOut) return outcome('timed-out');
            if (diff.code !== 0) return outcome('error', { detail: short(diff.stderr) });
            const changed = diff.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');

            if (changed.length > MAX_RESULT_PATHS) {
                return outcome('error', {
                    detail: 'the task changed ' + String(changed.length) + ' files, more than the ' +
                        String(MAX_RESULT_PATHS) + ' a result may carry'
                });
            }
            if (changed.length === 0 && declared.length === 0) return outcome('clean');

            // Build the result: HEAD, then only the paths this task touched, then the new
            // files it named. Starting from HEAD rather than from `nowTree` is what leaves
            // pre-existing dirty state out.
            const reset = await run(['read-tree', 'HEAD'], indexEnv);
            if (reset.timedOut) return outcome('timed-out');
            if (reset.code !== 0) return outcome('error', { detail: short(reset.stderr) });

            if (changed.length > 0) {
                const applied = await applyPaths(run, indexEnv, nowTree, changed);
                if (applied) return applied;
            }

            for (const group of chunk(declared, PATH_CHUNK)) {
                // From the working tree, since a declared output is a new file and is
                // therefore in no tree yet. Validation has already refused anything outside
                // the repository, ignored, or matching a secret pattern.
                const addNew = await run(['add', '--', ...group], indexEnv);
                if (addNew.timedOut) return outcome('timed-out');
                if (addNew.code !== 0) return outcome('error', { detail: short(addNew.stderr) });
            }

            const writeResult = await run(['write-tree'], indexEnv);
            if (writeResult.timedOut) return outcome('timed-out');
            if (writeResult.code !== 0) return outcome('error', { detail: short(writeResult.stderr) });
            const resultTree = writeResult.stdout.trim();

            // The task changed files back to what HEAD already had, so there is nothing to
            // record. An honest clean, distinct from an error.
            if (resultTree === headTreeSha) return outcome('clean');

            const commit = await run(
                ['-c', 'commit.gpgsign=false', 'commit-tree', resultTree, '-p', headSha, '-m', req.message],
                STAFFORD_IDENTITY
            );
            if (commit.timedOut) return outcome('timed-out');
            if (commit.code !== 0) return outcome('error', { detail: short(commit.stderr) });
            const commitId = commit.stdout.trim();

            const updateRef = await run(['update-ref', 'refs/heads/' + req.branch, commitId]);
            if (updateRef.timedOut) return outcome('timed-out');
            if (updateRef.code !== 0) return outcome('error', { detail: short(updateRef.stderr) });

            return { committed: true, branch: req.branch, commitId, reason: 'ok', detail: null };
        } finally {
            await deps.cleanupTempIndex(temp.path).catch(() => { /* best effort */ });
        }
    } catch (error) {
        return outcome('error', { detail: short(error instanceof Error ? error.message : String(error)) });
    }
}

/**
 * Copies `paths` from `fromTree` into the index, removing the ones the tree no longer has.
 *
 * Taken from the tree rather than re-read from disk, so the result records the state the task
 * actually left and not whatever the working tree looks like by the time this runs. Returns a
 * failure outcome, or null when it worked.
 */
async function applyPaths(
    run: (args: readonly string[], env?: Record<string, string>) => Promise<GitRun>,
    indexEnv: Record<string, string>,
    fromTree: string,
    paths: readonly string[]
): Promise<CheckpointOutcome | null> {
    const present = new Map<string, { mode: string; sha: string }>();

    for (const group of chunk(paths, PATH_CHUNK)) {
        const listed = await run(['ls-tree', '--full-tree', '-z', fromTree, '--', ...group]);
        if (listed.timedOut) return outcome('timed-out');
        if (listed.code !== 0) return outcome('error', { detail: short(listed.stderr) });
        for (const entry of listed.stdout.split('\0')) {
            if (entry.trim() === '') continue;
            // "<mode> <type> <sha>\t<path>"
            const tab = entry.indexOf('\t');
            if (tab === -1) continue;
            const parts = entry.slice(0, tab).split(' ');
            const mode = parts[0];
            const sha = parts[2];
            if (!mode || !sha) continue;
            present.set(entry.slice(tab + 1), { mode, sha });
        }
    }

    const added = paths.filter((p) => present.has(p));
    const removed = paths.filter((p) => !present.has(p));

    for (const group of chunk(added, PATH_CHUNK)) {
        const args: string[] = ['update-index', '--add'];
        for (const p of group) {
            const entry = present.get(p);
            if (!entry) continue;
            args.push('--cacheinfo', entry.mode + ',' + entry.sha + ',' + p);
        }
        const applied = await run(args, indexEnv);
        if (applied.timedOut) return outcome('timed-out');
        if (applied.code !== 0) return outcome('error', { detail: short(applied.stderr) });
    }

    for (const group of chunk(removed, PATH_CHUNK)) {
        // A file the task deleted. --force-remove drops it from the index even though it is
        // gone from disk, which is what records the deletion in the result.
        const dropped = await run(['update-index', '--force-remove', '--', ...group], indexEnv);
        if (dropped.timedOut) return outcome('timed-out');
        if (dropped.code !== 0) return outcome('error', { detail: short(dropped.stderr) });
    }

    return null;
}
