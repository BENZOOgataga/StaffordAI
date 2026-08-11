/**
 * The drain against stubbed agents and, for the durability and append-only
 * guarantees, a real migrated database in a temp directory. No test spawns a
 * real session or waits a real timeout: the checkpoint, the clock, the timeout
 * and the kill are all injected, so a hang is a promise that never resolves and
 * the caps are proven against a virtual clock in microseconds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runDrain, type DrainableAgent, type CheckpointResult, type DrainSink } from './drain.ts';
import { openDatabase } from '../storage/database.ts';
import { createRepositories, type Repositories } from '../storage/repository.ts';
import { currentPlatform } from '../platform/index.ts';
import type { DrainReportEntry } from '../../domain/models.ts';

const PLATFORM = currentPlatform();
const AT = '2026-08-11T00:00:00.000Z';

/** A timeout that never fires, so the agent's own promise decides the race. */
const neverTimes = (): Promise<'timeout'> => new Promise<'timeout'>(() => {});
/** A timeout that fires at once, so a hanging agent is treated as timed out. */
const timesOut = (): Promise<'timeout'> => Promise.resolve('timeout');

function collectingSink(): { sink: DrainSink; rows: DrainReportEntry[] } {
    const rows: DrainReportEntry[] = [];
    return { sink: { append: (e) => { rows.push(e); } }, rows };
}

function agent(agentId: string, checkpoint: () => Promise<CheckpointResult>, pid: number | null = 100): DrainableAgent {
    return { agentId, pid, checkpoint };
}

async function withRepos(
    fn: (repos: Repositories, db: { exec(sql: string): unknown }) => void | Promise<void>
): Promise<void> {
    const appDataDir = mkdtempSync(path.join(tmpdir(), 'stafford-drain-'));
    const open = openDatabase({ appDataDir });
    try {
        await fn(createRepositories(open.db), open.db);
    } finally {
        open.db.close();
        rmSync(appDataDir, { recursive: true, force: true });
    }
}

test('an agent that checkpoints and commits cleanly is committed, with its branch and commit id', async () => {
    const { sink, rows } = collectingSink();
    const summary = await runDrain({
        agents: [agent('marion', () => Promise.resolve({ committed: true, branch: 'feat/x', commitId: 'abc123' }))],
        platform: PLATFORM, sink, drainId: 'd1', now: () => AT,
        timeout: neverTimes, forceKill: () => Promise.resolve()
    });

    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
        drainId: 'd1', agentId: 'marion', outcome: 'committed', committed: true,
        branch: 'feat/x', commitId: 'abc123', at: AT
    });
    assert.equal(summary.committed, 1);
});

test('an agent asked to commit that reports failure is committed=false, outcome checkpointed', async () => {
    const { sink, rows } = collectingSink();
    await runDrain({
        agents: [agent('marion', () => Promise.resolve({ committed: false, branch: 'feat/x', commitId: null }))],
        platform: PLATFORM, sink, drainId: 'd1', now: () => AT,
        timeout: neverTimes, forceKill: () => Promise.resolve()
    });

    assert.equal(rows[0]?.outcome, 'checkpointed');
    assert.equal(rows[0]?.committed, false);
    assert.equal(rows[0]?.commitId, null);
    assert.equal(rows[0]?.branch, 'feat/x');
});

test('a checkpoint that throws is a failure, not a hang: checkpointed and committed=false, not force-killed', async () => {
    const { sink, rows } = collectingSink();
    const killed: string[] = [];
    await runDrain({
        agents: [agent('marion', () => Promise.reject(new Error('index.lock')))],
        platform: PLATFORM, sink, drainId: 'd1', now: () => AT,
        timeout: neverTimes, forceKill: (a) => { killed.push(a.agentId); return Promise.resolve(); }
    });

    assert.equal(rows[0]?.outcome, 'checkpointed');
    assert.equal(rows[0]?.committed, false);
    assert.deepEqual(killed, [], 'a failed commit is not a kill');
});

test('an agent that does not finish its window is hard-killed through the kill path, outcome force-killed, row written', async () => {
    const { sink, rows } = collectingSink();
    const killed: string[] = [];
    const summary = await runDrain({
        agents: [agent('marion', () => new Promise<CheckpointResult>(() => {}), 4242)],
        platform: PLATFORM, sink, drainId: 'd1', now: () => AT,
        timeout: timesOut, forceKill: (a) => { killed.push(a.agentId); return Promise.resolve(); }
    });

    assert.deepEqual(killed, ['marion'], 'the hanging agent was force-killed');
    assert.equal(rows[0]?.outcome, 'force-killed');
    assert.equal(rows[0]?.committed, false);
    assert.equal(summary.forceKilled, 1);
});

test('a kill that fails does not stop the drain: the row is still written and the next agent still runs', async () => {
    const { sink, rows } = collectingSink();
    await runDrain({
        agents: [
            agent('hangs', () => new Promise<CheckpointResult>(() => {}), 1),
            agent('commits', () => Promise.resolve({ committed: true, branch: 'b', commitId: 'c' }), 2)
        ],
        platform: PLATFORM, sink, drainId: 'd1', now: () => AT,
        timeout: timesOut, forceKill: () => Promise.reject(new Error('taskkill failed'))
    });

    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.outcome, 'force-killed', 'the failed kill still produced a row');
    // The second agent's checkpoint resolves, so timesOut does not decide it.
    assert.equal(rows[1]?.agentId, 'commits');
});

test('the total cap holds: hanging agents cannot add up past it, and the rest are killed without waiting', async () => {
    // A virtual clock the injected timeout advances, so 120s of budget is proven
    // spent in microseconds and never exceeded.
    let nowMs = 0;
    const clock = (): number => nowMs;
    const timeout = (ms: number): Promise<'timeout'> => { nowMs += ms; return Promise.resolve('timeout'); };

    const { sink, rows } = collectingSink();
    const killed: string[] = [];
    const agents = [
        agent('a0', () => new Promise<CheckpointResult>(() => {}), 10),
        agent('a1', () => new Promise<CheckpointResult>(() => {}), 11),
        agent('a2', () => new Promise<CheckpointResult>(() => {}), 12),
        agent('a3', () => new Promise<CheckpointResult>(() => {}), 13)
    ];

    const summary = await runDrain({
        agents, platform: PLATFORM, sink, drainId: 'd1', now: () => AT,
        perAgentMs: 45_000, totalMs: 120_000,
        clock, timeout, forceKill: (a) => { killed.push(a.agentId); return Promise.resolve(); }
    });

    assert.equal(summary.forceKilled, 4, 'every hanging agent was force-killed');
    assert.deepEqual(killed, ['a0', 'a1', 'a2', 'a3']);
    assert.ok(nowMs <= 120_000, 'the virtual clock never ran past the total cap, it ended at ' + nowMs);
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.outcome === 'force-killed'));
});

test('the per-agent cap bounds a single hang to its own budget, not the total', async () => {
    let nowMs = 0;
    const clock = (): number => nowMs;
    const timeout = (ms: number): Promise<'timeout'> => { nowMs += ms; return Promise.resolve('timeout'); };

    const { sink } = collectingSink();
    await runDrain({
        agents: [agent('slow', () => new Promise<CheckpointResult>(() => {}), 9)],
        platform: PLATFORM, sink, drainId: 'd1', now: () => AT,
        perAgentMs: 45_000, totalMs: 120_000,
        clock, timeout, forceKill: () => Promise.resolve()
    });

    assert.equal(nowMs, 45_000, 'one hang consumed exactly its per-agent budget, not the whole total');
});

test('rows are durable per agent: an interrupt after some resolve leaves those rows on disk', async () => {
    await withRepos(async (repos) => {
        // The sink throws on the third write, modelling a hard interruption after
        // two agents have already been written and committed by better-sqlite3.
        let seen = 0;
        const sink: DrainSink = {
            append: (e) => {
                seen += 1;
                if (seen === 3) throw new Error('process interrupted mid-drain');
                repos.drainReports.append(e);
            }
        };

        const agents = [
            agent('a0', () => Promise.resolve({ committed: true, branch: 'b0', commitId: 'c0' })),
            agent('a1', () => Promise.resolve({ committed: true, branch: 'b1', commitId: 'c1' })),
            agent('a2', () => Promise.resolve({ committed: true, branch: 'b2', commitId: 'c2' }))
        ];

        await assert.rejects(
            () => runDrain({
                agents, platform: PLATFORM, sink, drainId: 'run-1', now: () => AT,
                timeout: neverTimes, forceKill: () => Promise.resolve()
            }),
            /interrupted/, 'the interrupted write propagates out of the drain'
        );

        const onDisk = repos.drainReports.byDrain('run-1');
        assert.equal(onDisk.length, 2, 'the two agents resolved before the interrupt are durable');
        assert.deepEqual(onDisk.map((r) => r.agentId), ['a0', 'a1']);
        assert.equal(onDisk[0]?.committed, true);
    });
});

test('the drain report is append-only: the repository offers no update or delete, and a raw one raises', async () => {
    await withRepos((repos, db) => {
        repos.drainReports.append({
            drainId: 'run-1', agentId: 'a0', outcome: 'committed', committed: true,
            branch: 'b', commitId: 'c', at: AT
        });

        const repo = repos.drainReports as unknown as Record<string, unknown>;
        assert.equal(typeof repo.update, 'undefined', 'no update method exists to call');
        assert.equal(typeof repo.delete, 'undefined', 'no delete method exists to call');

        assert.throws(() => db.exec("UPDATE drain_report SET committed = 0 WHERE drain_id = 'run-1'"),
            /append-only/, 'the trigger refuses a raw update');
        assert.throws(() => db.exec("DELETE FROM drain_report WHERE drain_id = 'run-1'"),
            /append-only/, 'the trigger refuses a raw delete');
    });
});

test('a fresh drain over no agents writes nothing and reports zero', async () => {
    const { sink, rows } = collectingSink();
    const summary = await runDrain({
        agents: [], platform: PLATFORM, sink, drainId: 'd1', now: () => AT,
        timeout: neverTimes, forceKill: () => Promise.resolve()
    });
    assert.equal(rows.length, 0);
    assert.deepEqual(summary, { drainId: 'd1', total: 0, committed: 0, checkpointed: 0, forceKilled: 0 });
});
