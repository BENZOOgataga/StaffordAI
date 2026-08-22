/**
 * ClaudeRunnerManager tests. These drive the manager with a fake spawn that auto-answers
 * each turn (init, an assistant echo, result), so the whole delivery path is exercised
 * with no real Claude: the serial queue, the session-id harvest and resume, the reply
 * recorded to the #62 store keyed by hireId, the roster state derived from the runner,
 * #61 isolation env, interrupt, error handling, and the drain seam.
 *
 * The behaviours pinned here are exactly the rc.1 bugs: five fast messages become five
 * ordered distinct turns (no concatenation, no drop, no first-message swallow), and two
 * colleagues never cross-talk. The REAL packaged/dev Electron proof lives in the
 * delivery smoke (STAFFORD_DELIVERY_SMOKE in index.ts), run locally against Claude 2.1.237.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeRunnerManager, type RunnerManagerDeps } from './runner-manager.ts';
import { AGENT_STATES } from '../../domain/agent-state.ts';
import type { SpawnFn } from './claude-runner.ts';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Spawned {
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    writes: string[];
    killed: boolean;
    emit: (line: string) => void;
    exit: () => void;
}

function responder({ auto = true }: { auto?: boolean } = {}): { spawn: SpawnFn; children: Spawned[] } {
    const children: Spawned[] = [];
    let counter = 0;
    const spawn: SpawnFn = (_command, args, options) => {
        let dataCb: ((chunk: string) => void) | null = null;
        let exitCb: ((code: number | null, signal: string | null) => void) | null = null;
        const rec: Spawned = {
            args, env: options.env, writes: [], killed: false,
            emit: (line) => dataCb?.(line),
            exit: () => exitCb?.(0, null)
        };
        children.push(rec);
        const child = {
            pid: 1000 + children.length,
            stdin: {
                write: (chunk: string) => {
                    rec.writes.push(chunk);
                    if (!auto) return;
                    const line = chunk.trim();
                    if (!line.includes('"type":"user"')) return;
                    const content = (JSON.parse(line) as { message: { content: string } }).message.content;
                    const resumeIdx = args.indexOf('--resume');
                    const sessionId = resumeIdx !== -1 ? String(args[resumeIdx + 1]) : 'sess-' + (++counter);
                    setTimeout(() => {
                        rec.emit('{"type":"system","subtype":"init","session_id":"' + sessionId + '"}\n');
                        rec.emit(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply:' + content }] } }) + '\n');
                        rec.emit('{"type":"result","is_error":false,"session_id":"' + sessionId + '"}\n');
                    }, 0);
                }
            },
            stdout: { on: (_e: 'data', cb: (chunk: string) => void) => { dataCb = cb; return undefined; } },
            stderr: { on: () => undefined },
            on: (event: 'exit' | 'error', cb: (...a: never[]) => void) => {
                if (event === 'exit') exitCb = cb as typeof exitCb;
                return undefined;
            },
            kill: () => { rec.killed = true; return true; }
        };
        return child;
    };
    return { spawn, children };
}

interface Recorded {
    replies: Array<{ h: string; p: string; t: string }>;
    binds: Array<{ h: string; p: string; s: string }>;
    states: Array<{ h: string; s: string }>;
    seeds: string[];
    sessions: Map<string, string>;
    stateChanges: () => number;
}

function fakeDeps(spawn: SpawnFn, extra: Partial<RunnerManagerDeps> = {}): { deps: RunnerManagerDeps; rec: Recorded } {
    const sessions = new Map<string, string>();
    const replies: Recorded['replies'] = [];
    const binds: Recorded['binds'] = [];
    const states: Recorded['states'] = [];
    const seeds: string[] = [];
    let changes = 0;
    const deps: RunnerManagerDeps = {
        claudePath: '/fake/claude',
        claudeConfigDir: '/managed',
        parentEnv: { PATH: '/bin' },
        resolveTarget: (hireId) => ({
            cwd: '/proj/' + hireId, projectId: 'p-' + hireId,
            resumeSessionId: sessions.get(hireId) ?? null
        }),
        seedManagedConfig: (cwd) => { seeds.push(cwd); },
        bindSession: (h, p, s) => { binds.push({ h, p, s }); sessions.set(h, s); },
        recordReply: (h, p, t) => { replies.push({ h, p, t }); },
        setState: (h, s) => { states.push({ h, s }); },
        onStateChanged: () => { changes += 1; },
        spawn,
        timeoutMs: 5000,
        ...extra
    };
    return { deps, rec: { replies, binds, states, seeds, sessions, stateChanges: () => changes } };
}

// --------------------------------------------------------------------------

test('one message routes through the runner and records the reply keyed by hireId', async () => {
    const { spawn, children } = responder();
    const { deps, rec } = fakeDeps(spawn);
    const manager = new ClaudeRunnerManager(deps);

    await manager.submit('hireA', 'hello');

    assert.deepEqual(rec.replies, [{ h: 'hireA', p: 'p-hireA', t: 'reply:hello' }]);
    assert.equal(rec.binds.length, 1);
    assert.equal(rec.binds[0]?.s, 'sess-1');
    assert.deepEqual(rec.seeds, ['/proj/hireA']);
    assert.equal(children[0]?.env.CLAUDE_CONFIG_DIR, '/managed', '#61 isolation: CLAUDE_CONFIG_DIR reaches the child');
});

test('state is derived from the runner: working while the turn runs, idle when it ends', async () => {
    const { spawn } = responder();
    const { deps, rec } = fakeDeps(spawn);
    const manager = new ClaudeRunnerManager(deps);

    await manager.submit('hireA', 'hi');

    assert.deepEqual(rec.states, [
        { h: 'hireA', s: AGENT_STATES.WORKING },
        { h: 'hireA', s: AGENT_STATES.IDLE }
    ]);
    assert.ok(rec.stateChanges() >= 2, 'the roster is signalled on each state change');
});

test('five fast messages become five ordered distinct turns: no concatenation, no drop', async () => {
    const { spawn, children } = responder();
    const { deps, rec } = fakeDeps(spawn);
    const manager = new ClaudeRunnerManager(deps);

    // Fire all five without awaiting between them, the rc.1 failure case.
    const all = Promise.all([
        manager.submit('hireA', 'm1'),
        manager.submit('hireA', 'm2'),
        manager.submit('hireA', 'm3'),
        manager.submit('hireA', 'm4'),
        manager.submit('hireA', 'm5')
    ]);
    await all;

    assert.deepEqual(rec.replies.map((r) => r.t), ['reply:m1', 'reply:m2', 'reply:m3', 'reply:m4', 'reply:m5']);
    assert.equal(children.length, 5, 'one process per turn, five turns');
    // Turn 1 is fresh; turns 2..5 resume the harvested session id.
    assert.equal(children[0]?.args.includes('--resume'), false, 'turn 1 does not resume');
    for (let i = 1; i < 5; i++) {
        const args = children[i]?.args ?? [];
        const idx = args.indexOf('--resume');
        assert.ok(idx !== -1, `turn ${i + 1} resumes`);
        assert.equal(args[idx + 1], 'sess-1', `turn ${i + 1} resumes the session harvested on turn 1`);
    }
});

test('two colleagues do not cross-talk: independent queues, correct per-hire replies', async () => {
    const { spawn } = responder();
    const { deps, rec } = fakeDeps(spawn);
    const manager = new ClaudeRunnerManager(deps);

    await Promise.all([
        manager.submit('hireA', 'a1'),
        manager.submit('hireB', 'b1'),
        manager.submit('hireA', 'a2')
    ]);

    const forA = rec.replies.filter((r) => r.h === 'hireA').map((r) => r.t);
    const forB = rec.replies.filter((r) => r.h === 'hireB').map((r) => r.t);
    assert.deepEqual(forA, ['reply:a1', 'reply:a2'], "A's thread is its own and ordered");
    assert.deepEqual(forB, ['reply:b1'], "B's thread is its own");
    // The two colleagues got distinct sessions.
    assert.notEqual(rec.sessions.get('hireA'), rec.sessions.get('hireB'));
});

test('the session id persists and is reused on the next turn', async () => {
    const { spawn, children } = responder();
    const { deps, rec } = fakeDeps(spawn);
    const manager = new ClaudeRunnerManager(deps);

    await manager.submit('hireA', 'first');
    const harvested = rec.sessions.get('hireA');
    assert.ok(harvested, 'turn 1 harvested and persisted a session id');

    await manager.submit('hireA', 'second');
    const secondArgs = children[1]?.args ?? [];
    const idx = secondArgs.indexOf('--resume');
    assert.equal(secondArgs[idx + 1], harvested, 'turn 2 resumes the persisted id');
});

test('interrupt reaches the in-flight runner', async () => {
    const { spawn, children } = responder({ auto: false });
    const { deps } = fakeDeps(spawn);
    const manager = new ClaudeRunnerManager(deps);

    const turn = manager.submit('hireA', 'x');
    await tick(); // let the turn spawn
    manager.interrupt('hireA');

    const child = children[0];
    assert.ok(child, 'a child spawned');
    const wroteInterrupt = child.writes.some((w) => w.includes('"subtype":"interrupt"'));
    assert.ok(wroteInterrupt, 'an interrupt control request reached the child');

    child.emit('{"type":"result","is_error":false,"session_id":"s"}\n');
    await turn;
});

test('a turn that dies without a result records no reply and leaves the colleague idle', async () => {
    const { spawn, children } = responder({ auto: false });
    const { deps, rec } = fakeDeps(spawn, { timeoutMs: 80 });
    const manager = new ClaudeRunnerManager(deps);

    const turn = manager.submit('hireA', 'x');
    await tick();
    children[0]?.exit(); // process dies before any result
    await turn;

    assert.equal(rec.replies.length, 0, 'no reply recorded for a dead turn');
    assert.equal(rec.states.at(-1)?.s, AGENT_STATES.IDLE, 'the colleague ends idle, not stuck working');

    // The queue still flows: a following message delivers.
    await manager.submit('hireA', 'again');
    assert.equal(rec.replies.length, 0, 'still no reply (auto off), but no throw and the queue advanced');
});

test('a completed turn records each tool it used, with a derived target and ok status', async () => {
    const { spawn, children } = responder({ auto: false });
    const recorded: Array<{ h: string; s: string | null; tool: string; target: string | null; status: string }> = [];
    const { deps } = fakeDeps(spawn, {
        recordToolUse: (h, s, tool, target, status) => { recorded.push({ h, s, tool, target, status }); }
    });
    const manager = new ClaudeRunnerManager(deps);

    const turn = manager.submit('hireA', 'do it');
    await tick();
    const child = children[0];
    child?.emit('{"type":"system","subtype":"init","session_id":"sess-9"}\n');
    child?.emit(JSON.stringify({
        type: 'assistant',
        message: { content: [
            { type: 'tool_use', name: 'Bash', id: 'tu1', input: { command: 'ls -la' } },
            { type: 'tool_use', name: 'Read', id: 'tu2', input: { file_path: '/src/x.ts' } }
        ] }
    }) + '\n');
    child?.emit('{"type":"result","is_error":false,"session_id":"sess-9"}\n');
    await turn;

    assert.deepEqual(recorded, [
        { h: 'hireA', s: 'sess-9', tool: 'Bash', target: 'ls -la', status: 'ok' },
        { h: 'hireA', s: 'sess-9', tool: 'Read', target: '/src/x.ts', status: 'ok' }
    ]);
});

test('a finished turn reaps the child by its exact pid (tree reap), not by image name', async () => {
    const { spawn } = responder();
    const reaped: number[] = [];
    const { deps } = fakeDeps(spawn, { reapChild: (pid) => { reaped.push(pid); } });
    const manager = new ClaudeRunnerManager(deps);

    await manager.submit('hireA', 'x');

    assert.deepEqual(reaped, [1001], 'the runner disposed its own child pid through the tree reaper, exactly once');
});

test('drainables expose each served colleague with a checkpoint that disposes then commits', async () => {
    const { spawn } = responder();
    const committed: Array<{ cwd: string; hireId: string }> = [];
    const { deps } = fakeDeps(spawn, {
        checkpointRunner: async (cwd, hireId) => {
            committed.push({ cwd, hireId });
            return { committed: true, branch: 'stafford/checkpoint/' + hireId, commitId: 'abc', reason: null };
        }
    });
    const manager = new ClaudeRunnerManager(deps);

    await manager.submit('hireA', 'work');
    await manager.submit('hireB', 'work');

    const drainables = manager.drainables();
    assert.deepEqual(drainables.map((d) => d.agentId).sort(), ['hireA', 'hireB']);

    const results = await Promise.all(drainables.map((d) => d.checkpoint()));
    assert.ok(results.every((r) => r.committed), 'each colleague checkpoints');
    assert.deepEqual(committed.map((c) => c.hireId).sort(), ['hireA', 'hireB']);
});

// --- the task turn ----------------------------------------------------------

test('a task turn returns its result, which a message turn has no way to report', async () => {
    const { spawn } = responder();
    const { deps } = fakeDeps(spawn);
    const manager = new ClaudeRunnerManager(deps);

    const result = await manager.submitTaskTurn('hireA', 'do the task', null);

    assert.ok(result, 'a task needs the turn back to decide whether it finished');
    assert.equal(result.status, 'completed');
    assert.equal(result.assistantText, 'reply:do the task');
    assert.equal(result.sessionId, 'sess-1');
});

test('a task resumes the session it was given, not the colleagues chat session', async () => {
    const { spawn, children } = responder();
    const { deps, rec } = fakeDeps(spawn);
    const manager = new ClaudeRunnerManager(deps);

    // A chat first, which binds a session for the colleague.
    await manager.submit('hireA', 'hello');
    assert.equal(rec.sessions.get('hireA'), 'sess-1');

    await manager.submitTaskTurn('hireA', 'task turn', 'task-session-9');

    const args = children[children.length - 1]!.args;
    const resumeIdx = args.indexOf('--resume');
    assert.notEqual(resumeIdx, -1, 'a task turn with a session id must resume it');
    assert.equal(args[resumeIdx + 1], 'task-session-9',
        'a task resumes its own thread, so a task transcript and a conversation stay separate');
});

test('a task turn does not bind its session onto the hire, so it cannot hijack the chat thread', async () => {
    const { spawn } = responder();
    const { deps, rec } = fakeDeps(spawn);
    const manager = new ClaudeRunnerManager(deps);

    await manager.submitTaskTurn('hireA', 'task turn', null);

    assert.deepEqual(rec.binds, [], 'the task row owns the task session, not the hires sessions map');
    assert.equal(rec.sessions.get('hireA'), undefined);
});

test('THE SHARED QUEUE: a message sent mid-task waits, rather than racing it in one working tree', async () => {
    const { spawn, children } = responder();
    const { deps } = fakeDeps(spawn);
    const manager = new ClaudeRunnerManager(deps);

    const task = manager.submitTaskTurn('hireA', 'task turn', null);
    const message = manager.submit('hireA', 'a message while it works');
    await Promise.all([task, message]);

    assert.equal(children.length, 2, 'two turns ran');
    // The user message, not whatever control frame the runner writes first.
    const sent = (child: (typeof children)[number]): string => {
        const line = child.writes.find((w) => w.includes('"type":"user"'));
        return (JSON.parse((line ?? '{}').trim()) as { message?: { content?: string } }).message?.content ?? '';
    };
    assert.equal(sent(children[0]!), 'task turn');
    assert.equal(sent(children[1]!), 'a message while it works',
        'one colleague is one queue: two Claude children in one repo would race the working tree');
});

test('a task turn with no resolvable project returns null rather than pretending it ran', async () => {
    const { spawn } = responder();
    const { deps } = fakeDeps(spawn, { resolveTarget: () => null });
    const manager = new ClaudeRunnerManager(deps);

    assert.equal(await manager.submitTaskTurn('hireA', 'task turn', null), null);
});

test('a task turn goes through the same permission seam a message does', async () => {
    const { spawn } = responder();
    const seen: Array<{ hireId: string; projectId: string }> = [];
    const { deps } = fakeDeps(spawn, {
        makeCanUseTool: (ctx) => {
            seen.push({ hireId: ctx.hireId, projectId: ctx.projectId });
            return () => ({ behavior: 'allow', updatedInput: {} });
        }
    });
    const manager = new ClaudeRunnerManager(deps);

    await manager.submit('hireA', 'a message');
    await manager.submitTaskTurn('hireA', 'a task', null);

    assert.deepEqual(seen, [
        { hireId: 'hireA', projectId: 'p-hireA' },
        { hireId: 'hireA', projectId: 'p-hireA' }
    ], 'a task must not be able to run under a looser policy than a message');
});
