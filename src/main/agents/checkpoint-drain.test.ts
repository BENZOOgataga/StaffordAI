/**
 * The checkpoint through the real drain path, against a real git repo. This is the
 * seam that has broken three times in this repo: a tested module wired into the
 * packaged drain and failing silently there. So this drives the actual path the
 * shell uses, a DrainableAgent (the shape ClaudeRunnerManager.drainables() produces)
 * into runDrain into the executor into real git into the report row, not a direct
 * executor call, and asserts the commit is real and the repo is untouched.
 *
 * What runs for real here: the drain wiring and the git commit. What is not a real
 * process: the colleague is a plain DrainableAgent whose checkpoint runs the real
 * executor against the repo cwd, because the checkpoint path does not use a live
 * process, it uses the session's cwd and git. A real-Claude version is the owed
 * real-machine test to run locally; the commit path it would exercise is exactly this.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runDrain, type CheckpointResult, type DrainableAgent } from './drain.ts';
import type { DrainReportEntry } from '../../domain/models.ts';
import { checkpointRepo } from './checkpoint-executor.ts';
import { realCheckpointDeps } from './checkpoint-git.ts';
import { currentPlatform } from '../platform/index.ts';

const AT = '2026-08-18T00:00:00.000Z';
const platform = currentPlatform();

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], {
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

/**
 * A drainable in the given repo, wired to the real executor, that records its own
 * teardown after checkpointing. This is the shape ClaudeRunnerManager.drainables()
 * produces: checkpoint the tracked work, then reap. The hire is marion, the agent a1.
 */
function liveDrainable(repo: string, stamp: string): { agent: DrainableAgent; reaped: string[] } {
    const reaped: string[] = [];
    const agent: DrainableAgent = {
        agentId: 'a1', pid: null,
        checkpoint: async () => {
            const o = await checkpointRepo(realCheckpointDeps(platform), { cwd: repo, hireId: 'marion', stamp });
            reaped.push('a1'); // reap after checkpoint, the same order the manager keeps
            return {
                committed: o.committed, branch: o.branch, commitId: o.commitId,
                reason: o.committed ? null : (o.reason === 'error' && o.detail ? 'error: ' + o.detail : o.reason)
            } satisfies CheckpointResult;
        }
    };
    return { agent, reaped };
}

async function drain(agent: DrainableAgent): Promise<DrainReportEntry[]> {
    const rows: DrainReportEntry[] = [];
    await runDrain({
        agents: [agent], platform, sink: { append: (e) => rows.push(e) },
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

        const { agent, reaped } = liveDrainable(repo, 'DRAINSTAMP');
        const rows = await drain(agent);

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
        const { agent, reaped } = liveDrainable(repo, 'S');
        const rows = await drain(agent);

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
// stub checkpoint stands in for git, since a real git will not fail or hang on demand.
function stubDrainable(result: CheckpointResult): { agent: DrainableAgent; reaped: string[] } {
    const reaped: string[] = [];
    const agent: DrainableAgent = {
        agentId: 'a1', pid: null,
        checkpoint: async () => { reaped.push('a1'); return result; }
    };
    return { agent, reaped };
}

test('the drain records reason=error from a failed checkpoint, and still reaps', async () => {
    const { agent, reaped } = stubDrainable({ committed: false, branch: null, commitId: null, reason: 'error: fatal boom' });
    const rows = await drain(agent);
    assert.equal(rows[0]?.committed, false);
    assert.equal(rows[0]?.outcome, 'checkpointed');
    assert.equal(rows[0]?.reason, 'error: fatal boom');
    assert.deepEqual(reaped, ['a1']);
});

test('the drain records reason=timed-out from an executor timeout, distinct from a force-kill', async () => {
    const { agent } = stubDrainable({ committed: false, branch: null, commitId: null, reason: 'timed-out' });
    const rows = await drain(agent);
    assert.equal(rows[0]?.outcome, 'checkpointed', 'an executor timeout is a checkpoint, not a force-kill');
    assert.equal(rows[0]?.reason, 'timed-out');
});
