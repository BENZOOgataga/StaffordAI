import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeRunnerManager, type RunnerManagerDeps } from './runner-manager.ts';
import { AGENT_STATES } from '../../domain/agent-state.ts';
import type { SpawnFn } from './claude-runner.ts';

// Minimal auto-responder: emits init, an assistant text, and a result for each user message.
function responder(): SpawnFn {
    let counter = 0;
    return (_c, _args, options) => {
        let dataCb: ((chunk: string) => void) | null = null;
        const child = {
            pid: 42, env: options.env,
            stdin: { write: (chunk: string) => {
                const line = chunk.trim();
                if (!line.includes('"type":"user"')) return;
                const sid = 'sess-' + (++counter);
                setTimeout(() => {
                    dataCb?.('{"type":"system","subtype":"init","session_id":"' + sid + '"}\n');
                    dataCb?.(JSON.stringify({ type: 'assistant', message: { content: [
                        { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'x.ts' } },
                        { type: 'text', text: 'the reply' }
                    ] } }) + '\n');
                    dataCb?.('{"type":"result","is_error":false,"session_id":"' + sid + '"}\n');
                }, 0);
            } },
            stdout: { on: (_e: 'data', cb: (chunk: string) => void) => { dataCb = cb; } },
            stderr: { on: () => undefined },
            on: () => undefined,
            kill: () => true
        };
        return child as unknown as ReturnType<SpawnFn>;
    };
}

function baseDeps(over: Partial<RunnerManagerDeps>): { deps: RunnerManagerDeps; states: string[]; errors: Array<{ stage: string }> } {
    const states: string[] = [];
    const errors: Array<{ stage: string }> = [];
    const deps: RunnerManagerDeps = {
        claudePath: '/fake', claudeConfigDir: '/m', parentEnv: {},
        resolveTarget: (h) => ({ cwd: '/p/' + h, projectId: 'p', resumeSessionId: null }),
        seedManagedConfig: () => {},
        bindSession: () => {},
        recordReply: () => {},
        setState: (_h, s) => { states.push(s); },
        onStateChanged: () => {},
        onError: (_h, stage) => { errors.push({ stage }); },
        spawn: responder(),
        timeoutMs: 5000,
        ...over
    };
    return { deps, states, errors };
}

test('a throwing recordReply no longer strands the colleague: it still returns to IDLE and the error is reported', async () => {
    const { deps, states, errors } = baseDeps({
        recordReply: () => { throw new Error('channel.append failed (simulated write error)'); }
    });
    const manager = new ClaudeRunnerManager(deps);

    await manager.submit('hireA', 'hello');
    await new Promise((r) => setTimeout(r, 20));

    assert.deepEqual(states, [AGENT_STATES.WORKING, AGENT_STATES.IDLE],
        'the colleague goes Working then Idle even though the reply write threw, never stuck on Working');
    assert.ok(errors.some((e) => e.stage === 'record-reply'), 'the failure is surfaced, not swallowed');
});

test('one failing write does not skip the others: a bad tool write still leaves the reply recorded and the state idle', async () => {
    const replied: string[] = [];
    const { deps, states, errors } = baseDeps({
        recordReply: (_h, _p, t) => { replied.push(t); },
        recordToolUse: () => { throw new Error('activity.append failed'); }
    });
    const manager = new ClaudeRunnerManager(deps);
    await manager.submit('hireA', 'hello');
    await new Promise((r) => setTimeout(r, 20));

    assert.deepEqual(replied, ['the reply'], 'the reply was still recorded despite the tool write throwing after it');
    assert.equal(states.at(-1), AGENT_STATES.IDLE, 'the colleague still returned to idle');
    assert.ok(errors.some((e) => e.stage === 'record-tool'), 'the tool write failure is surfaced');
    assert.ok(errors.every((e) => e.stage !== 'record-reply'), 'the reply write itself did not fail');
});

test('a throwing opening live push does not strand the colleague before the turn runs', async () => {
    const { deps, states, errors } = baseDeps({
        // The very first (empty, working-indicator) push throws; the turn must still run and end idle.
        onLive: () => { throw new Error('live push failed'); }
    });
    const manager = new ClaudeRunnerManager(deps);
    await manager.submit('hireA', 'hello');
    await new Promise((r) => setTimeout(r, 20));

    assert.deepEqual(states, [AGENT_STATES.WORKING, AGENT_STATES.IDLE], 'the turn still went Working then Idle');
    assert.ok(errors.some((e) => e.stage === 'live-open'), 'the opening push failure is surfaced');
});

test('a throwing idle write is reported and does not escape the finally to re-strand the turn', async () => {
    const errors: Array<{ stage: string }> = [];
    let sawIdleAttempt = false;
    const deps: RunnerManagerDeps = {
        claudePath: '/fake', claudeConfigDir: '/m', parentEnv: {},
        resolveTarget: (h) => ({ cwd: '/p/' + h, projectId: 'p', resumeSessionId: null }),
        seedManagedConfig: () => {}, bindSession: () => {}, recordReply: () => {},
        setState: (_h, s) => { if (s === AGENT_STATES.IDLE) { sawIdleAttempt = true; throw new Error('roster write failed'); } },
        onStateChanged: () => {},
        onError: (_h, stage) => { errors.push({ stage }); },
        spawn: responder(), timeoutMs: 5000
    };
    const manager = new ClaudeRunnerManager(deps);

    // Must not reject: the throwing idle write is caught inside the finally, not propagated.
    await manager.submit('hireA', 'hello');
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(sawIdleAttempt, true, 'the idle write was attempted');
    assert.ok(errors.some((e) => e.stage === 'set-idle'), 'its failure is surfaced rather than swallowed or escaping');
});
