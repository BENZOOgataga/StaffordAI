/**
 * The checkpoint through the real drain path, against a real git repo. This is the
 * seam that has broken three times in this repo: a tested module wired into the
 * packaged drain and failing silently there. So this drives the actual path the
 * shell uses, registry.drainables() into the registry's own #checkpoint into the
 * executor into real git into runDrain into the report row, not a direct executor
 * call, and asserts the commit is real and the repo is untouched.
 *
 * What runs for real here: the drain wiring and the git commit. What is not a real
 * process: the colleague is a registry entry created by ingesting a hook event
 * rather than a spawned pty, because the checkpoint path does not use the pty, it
 * uses the session's cwd and git. A real-Claude-pty version is the owed real-machine
 * test to run locally; the commit path it would exercise is exactly this one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionRegistry } from '../hooks/session-registry.ts';
import type { HireBinding, HireStore } from '../hooks/session-registry.ts';
import { runDrain, type CheckpointResult } from './drain.ts';
import type { DrainReportEntry } from '../../domain/models.ts';
import { checkpointRepo } from './checkpoint-executor.ts';
import { realCheckpointDeps } from './checkpoint-git.ts';
import { currentPlatform } from '../platform/index.ts';

const AT = '2026-08-18T00:00:00.000Z';
const platform = currentPlatform();

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        cwd, encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' }
    }).trim();
}

function makeRepo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'stafford-drain-'));
    git(dir, 'init', '-b', 'main');
    writeFileSync(path.join(dir, 'a.txt'), 'alpha\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'initial');
    return dir;
}

/** A minimal store that binds one session to one hire, enough for the registry. */
function storeFor(sessionId: string, binding: HireBinding): HireStore {
    return {
        findBySession: (sid) => (sid === sessionId ? binding : null),
        setState: () => { /* not under test here */ },
        bindSession: () => { /* the session is already known via findBySession */ }
    };
}

/** A registry with one live session in the given repo, the real executor wired, and a recording teardown. */
function liveRegistry(repo: string, stamp: string): { registry: SessionRegistry; reaped: string[] } {
    const registry = new SessionRegistry(storeFor('sess-1', { hireId: 'marion', projectId: 'p1' }));
    const reaped: string[] = [];
    registry.setTeardown(async (agentId) => { reaped.push(agentId); });
    registry.setCheckpointRunner((cwd, hireId) =>
        checkpointRepo(realCheckpointDeps(platform), { cwd, hireId, stamp }).then((o): CheckpointResult => ({
            committed: o.committed, branch: o.branch, commitId: o.commitId,
            reason: o.committed ? null : (o.reason === 'error' && o.detail ? 'error: ' + o.detail : o.reason)
        })));
    // A live session in the repo: the SessionStart carries the cwd the checkpoint uses.
    registry.ingest({ event: 'SessionStart', sessionId: 'sess-1', agentId: 'a1', cwd: repo }, AT);
    return { registry, reaped };
}

async function drain(registry: SessionRegistry): Promise<DrainReportEntry[]> {
    const rows: DrainReportEntry[] = [];
    await runDrain({
        agents: registry.drainables(), platform, sink: { append: (e) => rows.push(e) },
        drainId: 'd1', now: () => AT, forceKill: async () => { /* no real process to kill */ }
    });
    return rows;
}

function snapshot(dir: string): { status: string; head: string; branch: string } {
    return {
        status: git(dir, 'status', '--porcelain=v1', '--untracked-files=all'),
        head: git(dir, 'rev-parse', 'HEAD'),
        branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')
    };
}

test('end to end: a tracked change drains to a real checkpoint commit, committed=true, repo unchanged', async () => {
    const repo = makeRepo();
    try {
        writeFileSync(path.join(repo, 'a.txt'), 'alpha changed\n');   // the colleague's tracked work
        writeFileSync(path.join(repo, '.env'), 'SECRET=nope\n');        // untracked, must not be swept in
        const before = snapshot(repo);

        const { registry, reaped } = liveRegistry(repo, 'DRAINSTAMP');
        const rows = await drain(registry);

        assert.equal(rows.length, 1, 'one report row for the one live session');
        const row = rows[0];
        assert.ok(row);
        // committed is real: outcome, branch, sha all populated for real.
        assert.equal(row.committed, true);
        assert.equal(row.outcome, 'committed');
        assert.equal(row.branch, 'stafford/checkpoint/marion/DRAINSTAMP');
        assert.equal(row.reason, null);
        assert.equal(row.commitId, git(repo, 'rev-parse', row.branch as string), 'the row sha is the real branch tip');
        // The branch holds the tracked change, and not the untracked secret.
        assert.equal(git(repo, 'show', row.branch + ':a.txt'), 'alpha changed');
        assert.ok(!git(repo, 'ls-tree', '-r', '--name-only', row.branch as string).includes('.env'), 'untracked .env not in the commit');

        // The repo is unchanged through the real drain, the same safety as piece 1.
        assert.deepEqual(snapshot(repo), before, 'working tree, HEAD, and branch unchanged by the drain');
        assert.ok(existsSync(path.join(repo, '.env')), 'the untracked .env is still on disk');
        // The agent was still reaped: a checkpoint of any result does not block teardown.
        assert.deepEqual(reaped, ['a1']);
    } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('end to end: a clean repo drains to committed=false reason=clean, not a failure', async () => {
    const repo = makeRepo();
    try {
        const before = snapshot(repo);
        const { registry, reaped } = liveRegistry(repo, 'S');
        const rows = await drain(registry);

        const row = rows[0];
        assert.ok(row);
        assert.equal(row.committed, false);
        assert.equal(row.outcome, 'checkpointed');
        assert.equal(row.reason, 'clean');
        assert.equal(row.branch, null);
        assert.deepEqual(snapshot(repo), before);
        assert.deepEqual(reaped, ['a1'], 'still reaped');
    } finally { rmSync(repo, { recursive: true, force: true }); }
});

// The reason is carried from the checkpoint result to the row, for every outcome. A
// stub runner stands in for git, since a real git will not fail or hang on demand.
function stubRegistry(result: CheckpointResult): { registry: SessionRegistry; reaped: string[] } {
    const registry = new SessionRegistry(storeFor('sess-1', { hireId: 'marion', projectId: 'p1' }));
    const reaped: string[] = [];
    registry.setTeardown(async (agentId) => { reaped.push(agentId); });
    registry.setCheckpointRunner(async () => result);
    registry.ingest({ event: 'SessionStart', sessionId: 'sess-1', agentId: 'a1', cwd: '/repo' }, AT);
    return { registry, reaped };
}

test('the drain records reason=error from a failed checkpoint, and still reaps', async () => {
    const { registry, reaped } = stubRegistry({ committed: false, branch: null, commitId: null, reason: 'error: fatal boom' });
    const rows = await drain(registry);
    assert.equal(rows[0]?.committed, false);
    assert.equal(rows[0]?.outcome, 'checkpointed');
    assert.equal(rows[0]?.reason, 'error: fatal boom');
    assert.deepEqual(reaped, ['a1']);
});

test('the drain records reason=timed-out from an executor timeout, distinct from a force-kill', async () => {
    const { registry } = stubRegistry({ committed: false, branch: null, commitId: null, reason: 'timed-out' });
    const rows = await drain(registry);
    assert.equal(rows[0]?.outcome, 'checkpointed', 'an executor timeout is a checkpoint, not a force-kill');
    assert.equal(rows[0]?.reason, 'timed-out');
});
