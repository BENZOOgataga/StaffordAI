/**
 * The checkpoint executor against a real temporary git repository. Every success
 * test carries the dual assertion: the checkpoint branch holds the tracked change,
 * AND the repo is exactly as it was. The second half is the point. A test that only
 * checks the commit exists is not testing the safety property, which is that the
 * plumbing did not disturb the working tree, the index, HEAD, or the current branch.
 *
 * The real-git cases run against the git binary, which is present wherever the repo
 * is checked out, so they run in CI rather than being skipped. The timeout and error
 * cases use a stub, because a real git will not hang or fail on demand.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkpointRepo, checkpointBranchName, type CheckpointDeps, type GitRun } from './checkpoint-executor.ts';
import { realCheckpointDeps } from './checkpoint-git.ts';
import { currentPlatform } from '../platform/index.ts';

const deps = realCheckpointDeps(currentPlatform());

// git with a fixed identity in the env, so the setup does not depend on the machine's
// git config, and signing is off so a configured signer cannot hang the setup.
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

/** A repo with two tracked files and one commit. */
function makeRepo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'stafford-ckpt-'));
    git(dir, 'init', '-b', 'main');
    writeFileSync(path.join(dir, 'a.txt'), 'alpha\n');
    writeFileSync(path.join(dir, 'b.txt'), 'beta\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'initial');
    return dir;
}

interface RepoState { status: string; head: string; branch: string; indexTree: string }

/** Everything that must not change: the full status, HEAD, the branch, and the real index's tree. */
function snapshot(dir: string): RepoState {
    return {
        status: git(dir, 'status', '--porcelain=v1', '--untracked-files=all'),
        head: git(dir, 'rev-parse', 'HEAD'),
        branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
        // write-tree reads the real index without mutating it, so its tree is a fingerprint of the index.
        indexTree: git(dir, 'write-tree')
    };
}

/** The load-bearing half of the dual assertion: the repo is byte-for-byte as it was. */
function assertRepoUnchanged(dir: string, before: RepoState): void {
    assert.equal(git(dir, 'status', '--porcelain=v1', '--untracked-files=all'), before.status, 'working tree and index status unchanged');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), before.head, 'HEAD unchanged');
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), before.branch, 'current branch unchanged');
    assert.equal(git(dir, 'write-tree'), before.indexTree, 'the real index is unchanged');
}

function treeFiles(dir: string, branch: string): string[] {
    return git(dir, 'ls-tree', '-r', '--name-only', branch).split('\n').filter(Boolean);
}

function cleanup(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
}

test('a clean repo checkpoints to nothing: committed false, reason clean, repo unchanged', async () => {
    const dir = makeRepo();
    try {
        const before = snapshot(dir);
        const res = await checkpointRepo(deps, { cwd: dir, hireId: 'marion', stamp: 'S1' });
        assert.deepEqual({ committed: res.committed, reason: res.reason, branch: res.branch }, { committed: false, reason: 'clean', branch: null });
        assertRepoUnchanged(dir, before);
    } finally { cleanup(dir); }
});

test('a tracked modification: the branch holds the change AND the repo is unchanged', async () => {
    const dir = makeRepo();
    try {
        writeFileSync(path.join(dir, 'a.txt'), 'alpha changed\n');   // tracked modification
        writeFileSync(path.join(dir, 'new.txt'), 'untracked body\n'); // untracked, must be excluded
        const before = snapshot(dir);

        const res = await checkpointRepo(deps, { cwd: dir, hireId: 'marion', stamp: 'S1' });

        // Assertion 1: the branch holds the tracked change, the untracked file does not.
        assert.equal(res.committed, true);
        assert.equal(res.reason, 'ok');
        const branch = res.branch as string;
        assert.equal(branch, 'stafford/checkpoint/marion/S1');
        assert.equal(git(dir, 'show', branch + ':a.txt'), 'alpha changed', 'the modification is in the commit');
        assert.ok(!treeFiles(dir, branch).includes('new.txt'), 'the untracked file is not in the commit');
        assert.equal(res.commitId, git(dir, 'rev-parse', branch), 'the reported sha is the branch tip');

        // Assertion 2: the repo is exactly as it was.
        assertRepoUnchanged(dir, before);
        assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'alpha changed\n', 'the working tree file still holds the edit');
        assert.ok(existsSync(path.join(dir, 'new.txt')), 'the untracked file is still on disk');
    } finally { cleanup(dir); }
});

test('a tracked deletion: the deletion is in the commit AND the repo is unchanged', async () => {
    const dir = makeRepo();
    try {
        rmSync(path.join(dir, 'b.txt')); // delete a tracked file in the working tree
        const before = snapshot(dir);

        const res = await checkpointRepo(deps, { cwd: dir, hireId: 'theo', stamp: 'S2' });
        assert.equal(res.committed, true);
        const files = treeFiles(dir, res.branch as string);
        assert.ok(!files.includes('b.txt'), 'the deletion is captured: b.txt is absent from the branch tree');
        assert.ok(files.includes('a.txt'), 'a.txt is still present');

        assertRepoUnchanged(dir, before);
        assert.ok(!existsSync(path.join(dir, 'b.txt')), 'b.txt is still deleted in the working tree, not restored');
    } finally { cleanup(dir); }
});

test('secret safety: an untracked .env is never in the commit and stays on disk', async () => {
    const dir = makeRepo();
    try {
        writeFileSync(path.join(dir, 'a.txt'), 'alpha edited\n');            // a tracked change so a commit is made
        writeFileSync(path.join(dir, '.env'), 'SECRET_KEY=do-not-commit\n'); // untracked, secret-shaped
        const before = snapshot(dir);

        const res = await checkpointRepo(deps, { cwd: dir, hireId: 'marion', stamp: 'S3' });
        assert.equal(res.committed, true);
        const branch = res.branch as string;
        assert.ok(!treeFiles(dir, branch).includes('.env'), 'the untracked .env is not in the commit');
        assert.ok(!git(dir, 'ls-tree', '-r', branch).includes('SECRET_KEY'), 'no secret content reached the tree');

        assert.ok(existsSync(path.join(dir, '.env')), 'the .env is still on disk');
        assertRepoUnchanged(dir, before);
    } finally { cleanup(dir); }
});

test('not a git repository: committed false, reason not-a-git-repo, no throw', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stafford-nogit-'));
    try {
        const res = await checkpointRepo(deps, { cwd: dir, hireId: 'x', stamp: 'S' });
        assert.equal(res.committed, false);
        assert.equal(res.reason, 'not-a-git-repo');
    } finally { cleanup(dir); }
});

// --- stub-driven cases: timeout and error, which a real git will not do on demand ---

function stubDeps(byCommand: Record<string, GitRun>): CheckpointDeps {
    const ok: GitRun = { stdout: 'deadbeef', stderr: '', code: 0, timedOut: false };
    return {
        runGit: async (args) => {
            const key = args[0] === '-c' ? args[2] : args[0]; // commit-tree runs behind -c
            return byCommand[key ?? ''] ?? ok;
        },
        prepareTempIndex: async () => ({ path: path.join(tmpdir(), 'stub-idx'), seeded: true }),
        cleanupTempIndex: async () => { /* nothing */ }
    };
}

test('a git child that overruns its bound resolves to timed-out, never hangs or throws', async () => {
    const res = await checkpointRepo(
        stubDeps({ 'rev-parse': { stdout: '', stderr: '', code: null, timedOut: true } }),
        { cwd: '/repo', hireId: 'h', stamp: 'S' }
    );
    assert.equal(res.committed, false);
    assert.equal(res.reason, 'timed-out');
});

test('a git error is caught and returned as reason error with a short detail, not thrown', async () => {
    const res = await checkpointRepo(
        stubDeps({
            'rev-parse': { stdout: 'deadbeef', stderr: '', code: 0, timedOut: false },
            'add': { stdout: '', stderr: 'fatal: unable to write new index file', code: 128, timedOut: false }
        }),
        { cwd: '/repo', hireId: 'h', stamp: 'S' }
    );
    assert.equal(res.committed, false);
    assert.equal(res.reason, 'error');
    assert.ok(res.detail?.includes('unable to write new index file'), 'the short detail carries the git error');
});

test('checkpointBranchName is ref-safe: unsafe characters slugged, no dots or leading dashes', () => {
    assert.equal(checkpointBranchName('marion', '2026-08-18T12-00-00'), 'stafford/checkpoint/marion/2026-08-18T12-00-00');
    assert.equal(checkpointBranchName('a b/c:d', 'x'), 'stafford/checkpoint/a-b-c-d/x');
    assert.ok(!checkpointBranchName('..', 'y').includes('..'), 'no double dot in a ref');
    assert.ok(!checkpointBranchName('.hidden', 'y').includes('/.'), 'no leading dot in a segment');
    assert.equal(checkpointBranchName('name.lock', 'y'), 'stafford/checkpoint/name-lock/y');
});
