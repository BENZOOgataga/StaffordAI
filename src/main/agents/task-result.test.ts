/**
 * Task result composition, against a real temporary git repository.
 *
 * The load-bearing test is the A/B one: a second task's result must not contain the first
 * task's edit. That is the defect this module exists for, and it is the one a stub could
 * easily agree with while real git did something else, so these run against the git binary.
 *
 * Every success case carries the same dual assertion the drain's checkpoint tests do: the
 * branch holds what it should, AND the repository is exactly as it was.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { taskBaseline, commitTaskResult, ignoredPaths, trackedPaths } from './task-result.ts';
import { taskBranchName } from './checkpoint-executor.ts';
import { realCheckpointDeps } from './checkpoint-git.ts';
import { currentPlatform } from '../platform/index.ts';

const deps = realCheckpointDeps(currentPlatform());

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t'
        }
    }).trim();
}

function makeRepo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'stafford-task-result-'));
    git(dir, 'init', '-b', 'main');
    writeFileSync(path.join(dir, 'x.txt'), 'x original\n');
    writeFileSync(path.join(dir, 'y.txt'), 'y original\n');
    writeFileSync(path.join(dir, 'z.txt'), 'z original\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'initial');
    return dir;
}

interface RepoState { status: string; head: string; branch: string; indexTree: string }

function snapshot(dir: string): RepoState {
    return {
        status: git(dir, 'status', '--porcelain=v1', '--untracked-files=all'),
        head: git(dir, 'rev-parse', 'HEAD'),
        branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
        indexTree: git(dir, 'write-tree')
    };
}

/** The files a branch's single commit touches, relative to HEAD. */
function filesIn(dir: string, branch: string): string[] {
    const out = git(dir, 'diff', '--name-only', 'HEAD', branch);
    return out === '' ? [] : out.split('\n').map((l) => l.trim()).filter((l) => l !== '');
}

/** Runs one task: baseline, the work, then the result commit. */
async function runTask(
    dir: string, taskId: string, work: () => void, declared: readonly string[] = []
): Promise<{ branch: string; committed: boolean; reason: string }> {
    const base = await taskBaseline(deps, { cwd: dir });
    work();
    const branch = taskBranchName('h1', taskId);
    const out = await commitTaskResult(deps, {
        cwd: dir, baselineTree: base.tree, declaredOutputs: declared,
        branch, message: 'Stafford task ' + taskId
    });
    return { branch, committed: out.committed, reason: out.reason };
}

// --- the defect this module exists for --------------------------------------

test('THE ISOLATION PROOF: task B edits Y, and B result holds only Y, not A leftover X', async () => {
    const dir = makeRepo();
    try {
        // Task A edits x.txt. Nothing resets the working tree afterwards, deliberately, so
        // x.txt is still modified on disk when task B starts. That is the exact situation
        // that used to put A's edit into B's result.
        const a = await runTask(dir, 'task-A', () => {
            writeFileSync(path.join(dir, 'x.txt'), 'x changed by A\n');
        });
        assert.equal(a.committed, true);
        assert.deepEqual(filesIn(dir, a.branch), ['x.txt']);

        assert.match(git(dir, 'status', '--porcelain'), /x\.txt/,
            'the tree is still dirty from A, which is the precondition of the bug');

        const b = await runTask(dir, 'task-B', () => {
            writeFileSync(path.join(dir, 'y.txt'), 'y changed by B\n');
        });

        assert.equal(b.committed, true);
        assert.deepEqual(filesIn(dir, b.branch), ['y.txt'],
            'B result carried a file B never touched, which makes the review surface a lie');
        assert.equal(git(dir, 'show', b.branch + ':x.txt'), 'x original',
            'and x.txt on B branch is HEAD version, not the one A left on disk');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a task that changed nothing produces nothing, even on a tree dirty from before', async () => {
    const dir = makeRepo();
    try {
        // Someone was editing before any task ran. A task that does nothing must not adopt it.
        writeFileSync(path.join(dir, 'z.txt'), 'z edited by a person\n');

        const out = await runTask(dir, 'task-idle', () => { /* the colleague did nothing */ });

        assert.equal(out.committed, false);
        assert.equal(out.reason, 'clean');
        assert.equal(git(dir, 'rev-parse', '--verify', '--quiet', out.branch + '^{commit}').length, 0,
            'no branch at all, rather than a branch holding a persons unrelated work');
    } catch (error) {
        // rev-parse --verify --quiet exits 1 when the ref is absent, which is the pass.
        if (!(error instanceof Error && error.message.includes('Command failed'))) throw error;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a task result never carries a persons unrelated edit, only its own', async () => {
    const dir = makeRepo();
    try {
        writeFileSync(path.join(dir, 'z.txt'), 'z edited by a person\n');

        const out = await runTask(dir, 'task-1', () => {
            writeFileSync(path.join(dir, 'x.txt'), 'x changed by the task\n');
        });

        assert.equal(out.committed, true);
        assert.deepEqual(filesIn(dir, out.branch), ['x.txt']);
        assert.equal(git(dir, 'show', out.branch + ':z.txt'), 'z original',
            'the persons in-progress edit is not in the branch');
        assert.equal(readFileSync(path.join(dir, 'z.txt'), 'utf8'), 'z edited by a person\n',
            'and it is left alone on disk');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the result is parented on HEAD, so the branch is one reviewable diff', async () => {
    const dir = makeRepo();
    try {
        writeFileSync(path.join(dir, 'z.txt'), 'pre-existing\n');
        const out = await runTask(dir, 'task-1', () => {
            writeFileSync(path.join(dir, 'x.txt'), 'task work\n');
        });

        assert.equal(git(dir, 'rev-list', '--count', 'HEAD..' + out.branch), '1',
            'one commit ahead of HEAD; a persons dirty state must not become a second commit');
        assert.equal(git(dir, 'rev-parse', out.branch + '^'), git(dir, 'rev-parse', 'HEAD'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a task deleting a tracked file records the deletion, and only that', async () => {
    const dir = makeRepo();
    try {
        writeFileSync(path.join(dir, 'z.txt'), 'unrelated dirt\n');
        const out = await runTask(dir, 'task-del', () => {
            unlinkSync(path.join(dir, 'x.txt'));
        });

        assert.equal(out.committed, true);
        assert.deepEqual(filesIn(dir, out.branch), ['x.txt']);
        assert.equal(git(dir, 'ls-tree', '--name-only', out.branch, 'x.txt'), '',
            'x.txt is gone from the result tree');
        assert.equal(git(dir, 'show', out.branch + ':y.txt'), 'y original');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a task that edits the same file a person was editing records the file as it left it', async () => {
    const dir = makeRepo();
    try {
        // Entangled on purpose: the two changes cannot be separated, and the honest answer is
        // the state the task left, not a guess at which line belonged to whom.
        writeFileSync(path.join(dir, 'x.txt'), 'x edited by a person\n');
        const out = await runTask(dir, 'task-1', () => {
            writeFileSync(path.join(dir, 'x.txt'), 'x edited by a person\nand then by the task\n');
        });

        assert.equal(out.committed, true);
        assert.deepEqual(filesIn(dir, out.branch), ['x.txt']);
        assert.match(git(dir, 'show', out.branch + ':x.txt'), /and then by the task/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the repository is untouched: working tree, index, HEAD and branch all as they were', async () => {
    const dir = makeRepo();
    try {
        writeFileSync(path.join(dir, 'z.txt'), 'dirt\n');
        git(dir, 'add', 'z.txt');            // a staged change too, so the index is not pristine
        writeFileSync(path.join(dir, 'untracked.txt'), 'stray\n');

        const base = await taskBaseline(deps, { cwd: dir });
        writeFileSync(path.join(dir, 'x.txt'), 'work\n');
        // Snapshot after the colleague has written and before the result is composed, so
        // what is being asserted is that composing the result changes nothing, rather than
        // that the task did nothing.
        const before = snapshot(dir);

        await commitTaskResult(deps, {
            cwd: dir, baselineTree: base.tree, branch: taskBranchName('h1', 'task-1'), message: 'm'
        });

        assert.deepEqual(snapshot(dir), before,
            'composing a result must disturb the repository exactly as little as a drain checkpoint');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a staged but uncommitted change is pre-existing state, not the tasks work', async () => {
    const dir = makeRepo();
    try {
        writeFileSync(path.join(dir, 'z.txt'), 'staged by a person\n');
        git(dir, 'add', 'z.txt');

        const out = await runTask(dir, 'task-1', () => {
            writeFileSync(path.join(dir, 'x.txt'), 'work\n');
        });

        assert.deepEqual(filesIn(dir, out.branch), ['x.txt'],
            'the baseline is taken from HEAD plus the tree, so how the index was left changes nothing');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// --- declared new files -----------------------------------------------------

test('a declared new file is committed, which is what makes a create-a-file task deliverable', async () => {
    const dir = makeRepo();
    try {
        const out = await runTask(dir, 'task-new', () => {
            writeFileSync(path.join(dir, 'deliverable.txt'), 'the whole point\n');
        }, ['deliverable.txt']);

        assert.equal(out.committed, true);
        assert.deepEqual(filesIn(dir, out.branch), ['deliverable.txt']);
        assert.equal(git(dir, 'show', out.branch + ':deliverable.txt'), 'the whole point');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('AN UNDECLARED UNTRACKED FILE IS NEVER SWEPT IN, which is the secret-safety property', async () => {
    const dir = makeRepo();
    try {
        const out = await runTask(dir, 'task-new', () => {
            writeFileSync(path.join(dir, 'deliverable.txt'), 'the deliverable\n');
            // The accident this prevents: a secret written beside the work, onto a branch I push.
            writeFileSync(path.join(dir, '.env'), 'TOKEN=do-not-commit\n');
            writeFileSync(path.join(dir, 'scratch.tmp'), 'noise\n');
        }, ['deliverable.txt']);

        assert.deepEqual(filesIn(dir, out.branch), ['deliverable.txt']);
        assert.equal(readFileSync(path.join(dir, '.env'), 'utf8'), 'TOKEN=do-not-commit\n',
            'and it is left alone on disk rather than staged or moved');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('declared new files and tracked edits land in one result together', async () => {
    const dir = makeRepo();
    try {
        mkdirSync(path.join(dir, 'src'), { recursive: true });
        const out = await runTask(dir, 'task-both', () => {
            writeFileSync(path.join(dir, 'x.txt'), 'edited\n');
            writeFileSync(path.join(dir, 'src', 'new.ts'), 'export const a = 1;\n');
        }, ['src/new.ts']);

        assert.deepEqual(filesIn(dir, out.branch).sort(), ['src/new.ts', 'x.txt']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// --- the helpers the validation uses ----------------------------------------

test('ignoredPaths reports what git ignores, so an ignored deliverable can be refused', async () => {
    const dir = makeRepo();
    try {
        writeFileSync(path.join(dir, '.gitignore'), 'build/\n*.log\n');
        git(dir, 'add', '.gitignore');
        git(dir, 'commit', '-m', 'ignore');
        mkdirSync(path.join(dir, 'build'), { recursive: true });
        writeFileSync(path.join(dir, 'build', 'out.js'), 'x\n');
        writeFileSync(path.join(dir, 'debug.log'), 'x\n');
        writeFileSync(path.join(dir, 'keep.txt'), 'x\n');

        const ignored = await ignoredPaths(deps, dir, ['build/out.js', 'debug.log', 'keep.txt']);

        assert.equal(ignored.has('build/out.js'), true);
        assert.equal(ignored.has('debug.log'), true);
        assert.equal(ignored.has('keep.txt'), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('trackedPaths reports what is already in the index', async () => {
    const dir = makeRepo();
    try {
        writeFileSync(path.join(dir, 'new.txt'), 'x\n');
        const tracked = await trackedPaths(deps, dir, ['x.txt', 'new.txt']);
        assert.equal(tracked.has('x.txt'), true);
        assert.equal(tracked.has('new.txt'), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// --- degrading safely -------------------------------------------------------

test('a null baseline falls back to HEAD rather than committing nothing', async () => {
    const dir = makeRepo();
    try {
        writeFileSync(path.join(dir, 'x.txt'), 'work\n');
        const out = await commitTaskResult(deps, {
            cwd: dir, baselineTree: null, branch: taskBranchName('h1', 't'), message: 'm'
        });
        assert.equal(out.committed, true, 'no baseline means no isolation, not no result');
        assert.deepEqual(filesIn(dir, out.branch as string), ['x.txt']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a directory that is not a repository is a clean no, not a crash', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stafford-not-a-repo-'));
    try {
        assert.equal((await taskBaseline(deps, { cwd: dir })).tree, null);
        const out = await commitTaskResult(deps, {
            cwd: dir, baselineTree: null, branch: 'b', message: 'm'
        });
        assert.equal(out.committed, false);
        assert.equal(out.reason, 'not-a-git-repo');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
