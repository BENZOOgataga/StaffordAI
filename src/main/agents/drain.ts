/**
 * The graceful-shutdown drain: on quit, each active agent session is given a
 * bounded chance to checkpoint its work, then whatever has not finished is
 * hard-killed, and one durable report row is written per agent as its outcome
 * becomes known.
 *
 * **The report is written per agent as it resolves, not all at the end.** The
 * whole reason the `drain_report` table exists before the drain does is that a
 * crash mid-drain must still leave a record of what happened to the agents
 * already resolved. The sink here is the repository's synchronous better-sqlite3
 * insert, durable the moment it returns, so this resolves an agent, writes its
 * row, and only then moves to the next.
 *
 * **The total cap is a hard guarantee that the app can always quit.** Each agent
 * gets `perAgentMs`, but its budget is also clamped to what is left of `totalMs`,
 * so a row of hanging agents cannot add up past the total. Once the total is
 * spent, the remaining agents are force-killed without a wait. A stuck agent
 * therefore cannot hold the process open, which is the point: a drain that blocks
 * forever is worse than a lost working tree.
 *
 * **What this does not do.** It does not decide the checkpoint mechanism. The
 * agent's own `checkpoint()` performs the git work on its branch and reports what
 * happened; this orchestrates the wait, the kill, and the report. The force-kill
 * is the platform's `killTree` (see `kill-tree.ts:killTree`, the only kill path;
 * there is no `killWithTree` symbol).
 *
 * Windows residual, carried as a note only: under heavy CI runner load a session
 * can fail to emit READY at open because of ConPTY AttachConsole contention (the
 * contained node-pty 886 family, at open rather than at kill). It did not
 * reproduce and is not a drain defect. If a Windows CI run shows a drain test
 * timing out with `AttachConsole failed` in stderr and a session that never
 * printed READY, that is the open-time contention hypothesis, its own task, not
 * this drain.
 */

import type { Platform } from '../platform/types.ts';
import { killTree } from './kill-tree.ts';
import { DRAIN_OUTCOMES, type DrainReportEntry, type DrainOutcome } from '../../domain/models.ts';

export const DEFAULT_PER_AGENT_MS = 45_000;
export const DEFAULT_TOTAL_MS = 120_000;

/** What an agent's checkpoint reports back: did a commit land, and where. */
export interface CheckpointResult {
    readonly committed: boolean;
    readonly branch: string | null;
    readonly commitId: string | null;
}

/**
 * The slice of an agent session the drain needs. Injected, so the drain is
 * driven by stubs in tests and by the real roster once one exists.
 */
export interface DrainableAgent {
    readonly agentId: string;
    /** For the force-kill. Null when there is no live process to reap. */
    readonly pid: number | null;
    /**
     * Checkpoint the agent's work on its branch and report what happened. May
     * hang: a checkpoint that never resolves is exactly what the per-agent and
     * total caps exist to bound.
     */
    checkpoint(): Promise<CheckpointResult>;
}

/** Where rows go. The repository's append, kept narrow so the drain cannot read or mutate. */
export interface DrainSink {
    append(entry: DrainReportEntry): void;
}

export interface DrainOptions {
    readonly agents: readonly DrainableAgent[];
    readonly platform: Platform;
    readonly sink: DrainSink;
    /** One id per quit, stamped on every row, so a shutdown's rows group into one report. */
    readonly drainId: string;
    /** The timestamp for each row. Injected so a test does not depend on the wall clock. */
    readonly now: () => string;
    readonly perAgentMs?: number;
    readonly totalMs?: number;
    /** Monotonic milliseconds. Injected so a test can drive virtual time. */
    readonly clock?: () => number;
    /** Resolves 'timeout' after ms. Injected so a test does not wait real minutes. */
    readonly timeout?: (ms: number) => Promise<'timeout'>;
    /** The force-kill. Injected so a test does not touch real processes. */
    readonly forceKill?: (agent: DrainableAgent) => Promise<void>;
}

export interface DrainSummary {
    readonly drainId: string;
    readonly total: number;
    readonly committed: number;
    readonly checkpointed: number;
    readonly forceKilled: number;
}

/** A timer that never holds the event loop open, so it cannot keep the app alive. */
function defaultTimeout(ms: number): Promise<'timeout'> {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve('timeout'), ms);
        t.unref();
    });
}

async function defaultForceKill(platform: Platform, agent: DrainableAgent): Promise<void> {
    if (agent.pid === null || agent.pid <= 0) return;
    await killTree(platform, agent.pid);
}

/**
 * Races the agent's checkpoint against its time budget. A checkpoint that throws
 * is treated as finished without a commit, not as a timeout: it was reached and
 * it failed, which is a `checkpointed` outcome with `committed = false`, distinct
 * from a hang that has to be killed.
 */
async function checkpointWithin(
    agent: DrainableAgent, budgetMs: number, timeout: (ms: number) => Promise<'timeout'>
): Promise<{ timedOut: boolean; result: CheckpointResult | null }> {
    let result: CheckpointResult | null = null;
    const work: Promise<'done'> = agent.checkpoint().then(
        (r) => { result = r; return 'done'; },
        () => 'done'
    );
    const outcome = await Promise.race([work, timeout(budgetMs)]);
    return { timedOut: outcome === 'timeout', result };
}

/**
 * Drains the given agents and returns a count of each outcome. Never rejects for
 * a kill that fails; a kill failure is swallowed so it cannot stop the drain from
 * reaching the next agent. It can still reject if the sink write itself throws,
 * which models a hard interruption: the rows written before that point are
 * already durable.
 */
export async function runDrain(options: DrainOptions): Promise<DrainSummary> {
    const perAgentMs = options.perAgentMs ?? DEFAULT_PER_AGENT_MS;
    const totalMs = options.totalMs ?? DEFAULT_TOTAL_MS;
    const clock = options.clock ?? (() => Date.now());
    const timeout = options.timeout ?? defaultTimeout;
    const forceKill = options.forceKill ?? ((agent) => defaultForceKill(options.platform, agent));

    const start = clock();
    let committed = 0;
    let checkpointed = 0;
    let forceKilled = 0;

    for (const agent of options.agents) {
        const totalRemaining = totalMs - (clock() - start);

        let outcome: DrainOutcome;
        let committedFlag: boolean;
        let branch: string | null;
        let commitId: string | null;

        if (totalRemaining <= 0) {
            // The total grace is spent. Kill without waiting, so a hang earlier in
            // the row cannot buy a later agent time the app does not have.
            await safeKill(forceKill, agent);
            outcome = DRAIN_OUTCOMES.FORCE_KILLED;
            committedFlag = false;
            branch = null;
            commitId = null;
            forceKilled += 1;
        } else {
            const budget = Math.min(perAgentMs, totalRemaining);
            const raced = await checkpointWithin(agent, budget, timeout);
            if (raced.timedOut) {
                await safeKill(forceKill, agent);
                outcome = DRAIN_OUTCOMES.FORCE_KILLED;
                committedFlag = false;
                branch = raced.result?.branch ?? null;
                commitId = null;
                forceKilled += 1;
            } else if (raced.result && raced.result.committed) {
                outcome = DRAIN_OUTCOMES.COMMITTED;
                committedFlag = true;
                branch = raced.result.branch;
                commitId = raced.result.commitId;
                committed += 1;
            } else {
                // Reached and finished, but no commit landed: nothing to commit, or
                // the commit was attempted and failed. Either way committed is false
                // and it did not have to be killed.
                outcome = DRAIN_OUTCOMES.CHECKPOINTED;
                committedFlag = false;
                branch = raced.result?.branch ?? null;
                commitId = null;
                checkpointed += 1;
            }
        }

        // Synchronous, so the row is durable the moment this returns. Written here,
        // per agent, before moving on, so an interruption leaves the resolved
        // agents on disk.
        options.sink.append({
            drainId: options.drainId,
            agentId: agent.agentId,
            outcome,
            committed: committedFlag,
            branch,
            commitId,
            at: options.now()
        });
    }

    return { drainId: options.drainId, total: options.agents.length, committed, checkpointed, forceKilled };
}

/** A kill that fails must not stop the drain: the point is to always reach quit. */
async function safeKill(forceKill: (a: DrainableAgent) => Promise<void>, agent: DrainableAgent): Promise<void> {
    try {
        await forceKill(agent);
    } catch {
        // Best effort. A kill that fails still leaves a force-killed row, and the
        // OS reclaims the process on exit.
    }
}
