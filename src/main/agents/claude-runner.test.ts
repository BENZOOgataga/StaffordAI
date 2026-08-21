/**
 * ClaudeRunner unit tests. These drive the runner with an injected fake spawn, so the
 * protocol handling, the parser, the permission seam, the resume arg, the isolation
 * env, and the bounded-failure paths are all exercised with no real Claude and no
 * quota cost. The real-Claude proof lives in the probe (claude-runner.probe.ts),
 * run locally, since CI has no Claude login.
 *
 * The behaviours pinned here are exactly the ones the pty path got wrong: the turn
 * boundary is the `result` line (not a timing guess), a malformed or unknown line is
 * ignored (not fatal), and every failure is typed (never a hang).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
    ClaudeRunner, autoApproveTool, HEADLESS_ARGS,
    type RunnerChild, type SpawnFn, type WireDirection
} from './claude-runner.ts';
import { makePermissionGate } from './permission-gate.ts';
import { ApprovalRegistry } from './approval-registry.ts';
import type { ProjectPolicy } from '../../domain/models.ts';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface FakeHandle {
    spawn: SpawnFn;
    /** The args the runner spawned with, captured on spawn. */
    args: () => readonly string[];
    /** The options the runner spawned with. */
    options: () => { cwd: string; env: NodeJS.ProcessEnv; stdio: readonly string[] } | null;
    /** Feed one stdout chunk to the runner (include a trailing newline for a full line). */
    emit: (chunk: string) => void;
    /** Fire the child's exit. */
    exit: () => void;
    /** Fire a spawn error. */
    error: (err: Error) => void;
    /** Everything the runner wrote to stdin, in order. */
    writes: () => readonly string[];
    /** Whether the runner killed the child. */
    killed: () => boolean;
    pid: number;
}

function makeFakeSpawn(pid = 4242): FakeHandle {
    let dataCb: ((chunk: Buffer | string) => void) | null = null;
    let exitCb: ((code: number | null, signal: string | null) => void) | null = null;
    let errorCb: ((err: Error) => void) | null = null;
    const writes: string[] = [];
    let killed = false;
    let capturedArgs: readonly string[] = [];
    let capturedOptions: { cwd: string; env: NodeJS.ProcessEnv; stdio: readonly string[] } | null = null;

    const child: RunnerChild = {
        pid,
        stdin: { write: (chunk: string) => { writes.push(chunk); } },
        stdout: { on: (_event, cb) => { dataCb = cb; return undefined; } },
        stderr: { on: () => undefined },
        on: (event, cb) => {
            if (event === 'exit') exitCb = cb as typeof exitCb;
            else if (event === 'error') errorCb = cb as typeof errorCb;
            return undefined;
        },
        kill: () => { killed = true; return true; }
    };

    const spawn: SpawnFn = (_command, args, options) => {
        capturedArgs = args;
        capturedOptions = options;
        return child;
    };

    return {
        spawn,
        args: () => capturedArgs,
        options: () => capturedOptions,
        emit: (chunk) => dataCb?.(chunk),
        exit: () => exitCb?.(0, null),
        error: (err) => errorCb?.(err),
        writes: () => writes,
        killed: () => killed,
        pid
    };
}

function baseDeps(fake: FakeHandle, overrides: Record<string, unknown> = {}) {
    return {
        claudePath: '/fake/claude',
        cwd: '/fake/project',
        env: { CLAUDE_CONFIG_DIR: '/managed/dir', PATH: '/usr/bin' },
        spawn: fake.spawn,
        ...overrides
    };
}

// --------------------------------------------------------------------------

test('one turn: reads to result, captures session id, assistant text, and tool uses', async () => {
    const fake = makeFakeSpawn();
    const runner = new ClaudeRunner(baseDeps(fake));

    const turn = runner.runTurn({ text: 'hello there' });

    fake.emit('{"type":"system","subtype":"init","session_id":"sess-abc"}\n');
    fake.emit('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi. "},{"type":"tool_use","name":"Read","id":"tu_1","input":{"file":"x.ts"}}]}}\n');
    fake.emit('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}\n');
    fake.emit('{"type":"result","subtype":"success","is_error":false,"session_id":"sess-abc"}\n');

    const result = await turn;
    assert.equal(result.status, 'completed');
    assert.equal(result.isError, false);
    assert.equal(result.sessionId, 'sess-abc');
    assert.equal(result.assistantText, 'Hi. Done.');
    assert.equal(result.toolUses.length, 1);
    assert.deepEqual(result.toolUses[0], { name: 'Read', input: { file: 'x.ts' }, id: 'tu_1' });
    assert.equal(fake.killed(), true, 'the child is torn down when the turn settles');
});

test('the user message and the initialize handshake are written to stdin, in order', async () => {
    const fake = makeFakeSpawn();
    const runner = new ClaudeRunner(baseDeps(fake));

    const turn = runner.runTurn({ text: 'the message text' });
    fake.emit('{"type":"result","is_error":false,"session_id":"s"}\n');
    await turn;

    const lines = fake.writes().map((w) => JSON.parse(w.trim()) as Record<string, unknown>);
    assert.ok(lines.length >= 2, 'both the handshake and the user message were written');
    const [initialize, userMessage] = lines as [Record<string, unknown>, Record<string, unknown>];
    assert.equal((initialize.request as Record<string, unknown>).subtype, 'initialize');
    assert.equal(userMessage.type, 'user');
    assert.deepEqual(userMessage.message, { role: 'user', content: 'the message text' });
});

test('the result line is the turn boundary, not a timing guess', async () => {
    const fake = makeFakeSpawn();
    const runner = new ClaudeRunner(baseDeps(fake, { timeoutMs: 5000 }));

    const turn = runner.runTurn({ text: 'x' });
    let settled = false;
    void turn.then(() => { settled = true; });

    fake.emit('{"type":"system","subtype":"init","session_id":"s"}\n');
    fake.emit('{"type":"stream_event","event":{"type":"content_block_delta"}}\n');
    await tick();
    assert.equal(settled, false, 'no result yet, so the turn is still open');

    fake.emit('{"type":"result","is_error":false,"session_id":"s"}\n');
    const result = await turn;
    assert.equal(result.status, 'completed');
});

test('a malformed line and an unknown event type are ignored, not fatal', async () => {
    const fake = makeFakeSpawn();
    const runner = new ClaudeRunner(baseDeps(fake));

    const turn = runner.runTurn({ text: 'x' });
    fake.emit('this is not json at all\n');
    fake.emit('{"type":"system","subtype":"init","session_id":"s"}\n');
    fake.emit('{"type":"some_future_event","payload":42}\n');
    fake.emit('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}\n');
    fake.emit('{"type":"result","is_error":false,"session_id":"s"}\n');

    const result = await turn;
    assert.equal(result.status, 'completed');
    assert.equal(result.assistantText, 'ok');
    assert.equal(result.sessionId, 's');
});

test('a line split across two stdout chunks still parses', async () => {
    const fake = makeFakeSpawn();
    const runner = new ClaudeRunner(baseDeps(fake));

    const turn = runner.runTurn({ text: 'x' });
    fake.emit('{"type":"system","subtype":"init","sess');
    fake.emit('ion_id":"split-sess"}\n');
    fake.emit('{"type":"result","is_error":false}\n');

    const result = await turn;
    assert.equal(result.sessionId, 'split-sess');
});

test('the assistant result string is the fallback when no text block was streamed', async () => {
    const fake = makeFakeSpawn();
    const runner = new ClaudeRunner(baseDeps(fake));

    const turn = runner.runTurn({ text: 'x' });
    fake.emit('{"type":"result","is_error":false,"session_id":"s","result":"final answer"}\n');

    const result = await turn;
    assert.equal(result.assistantText, 'final answer');
});

test('can_use_tool is answered allow through the named seam, called with tool name and input', async () => {
    const fake = makeFakeSpawn();
    const seen: Array<{ tool: string; input: unknown }> = [];
    const runner = new ClaudeRunner(baseDeps(fake, {
        canUseTool: (tool: string, input: unknown) => {
            seen.push({ tool, input });
            return { behavior: 'allow', updatedInput: input };
        }
    }));

    const turn = runner.runTurn({ text: 'x' });
    fake.emit('{"type":"control_request","request_id":"req-9","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}\n');
    await tick();

    assert.deepEqual(seen, [{ tool: 'Bash', input: { command: 'ls' } }]);
    const response = fake.writes().map((w) => JSON.parse(w.trim()) as Record<string, unknown>)
        .find((o) => o.type === 'control_response');
    assert.ok(response, 'a control_response was written');
    const payload = (response as Record<string, unknown>).response as Record<string, unknown>;
    assert.equal(payload.subtype, 'success');
    assert.equal(payload.request_id, 'req-9');
    assert.deepEqual(payload.response, { behavior: 'allow', updatedInput: { command: 'ls' } });

    fake.emit('{"type":"result","is_error":false,"session_id":"s"}\n');
    await turn;
});

test('the permission gate wired at can_use_tool allows in scope and denies out of scope, the config, and destructive shell', async () => {
    const CWD = path.resolve('/proj');
    const USERDATA = path.resolve('/userdata');
    const policy: ProjectPolicy = {
        push: 'none', allowedRoles: [], toolCeiling: null, writePaths: null,
        requirePipeline: false, allowWebFetch: true, permissionMode: 'default', maxConcurrentAgents: 1
    };
    const gate = makePermissionGate({
        getPolicy: () => policy, getStoredRules: () => [], protectedPaths: [USERDATA],
        normalisePath: (v: string) => v
    })({ hireId: 'h1', cwd: CWD, projectId: 'p' });

    // Drive one control request through the real runner and read the decision it writes back.
    const decisionFor = async (toolName: string, input: unknown): Promise<Record<string, unknown>> => {
        const fake = makeFakeSpawn();
        const runner = new ClaudeRunner(baseDeps(fake, { canUseTool: gate }));
        const turn = runner.runTurn({ text: 'x' });
        fake.emit('{"type":"control_request","request_id":"r","request":{"subtype":"can_use_tool","tool_name":' +
            JSON.stringify(toolName) + ',"input":' + JSON.stringify(input) + '}}\n');
        await tick();
        const response = fake.writes().map((w) => JSON.parse(w.trim()) as Record<string, unknown>)
            .find((o) => o.type === 'control_response');
        fake.emit('{"type":"result","is_error":false,"session_id":"s"}\n');
        await turn;
        return ((response as Record<string, unknown>).response as Record<string, unknown>).response as Record<string, unknown>;
    };

    assert.equal((await decisionFor('Write', { file_path: 'src/main.ts' })).behavior, 'allow');
    assert.equal((await decisionFor('Write', { file_path: path.resolve('/userdata/Stafford/stafford.db') })).behavior, 'deny');
    assert.equal((await decisionFor('Bash', { command: 'git push --force origin main' })).behavior, 'deny');
    assert.equal((await decisionFor('Bash', { command: 'npm test' })).behavior, 'allow');
});

test('an ask pauses the runner until answered: the decision is written only after the person approves', async () => {
    const CWD = path.resolve('/proj');
    const policy: ProjectPolicy = {
        push: 'none', allowedRoles: [], toolCeiling: null, writePaths: null,
        requirePipeline: false, allowWebFetch: true, permissionMode: 'default', maxConcurrentAgents: 1
    };
    const registry = new ApprovalRegistry({ now: () => 't', uuid: () => 'aid', onChange: () => {}, onPending: () => {} });
    const gate = makePermissionGate({
        getPolicy: () => policy, getStoredRules: () => [], protectedPaths: [path.resolve('/userdata')],
        normalisePath: (v: string) => v,
        onAsk: (r) => registry.ask(r)
    })({ hireId: 'h1', cwd: CWD, projectId: 'p' });

    const fake = makeFakeSpawn();
    const runner = new ClaudeRunner(baseDeps(fake, { canUseTool: gate }));
    const turn = runner.runTurn({ text: 'x' });
    const controlResponse = () => fake.writes().map((w) => JSON.parse(w.trim()) as Record<string, unknown>)
        .find((o) => o.type === 'control_response');

    // A destructive command resolves to ask, so the turn pauses: no response yet.
    fake.emit('{"type":"control_request","request_id":"r","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"git push --force origin main"}}}\n');
    await tick();
    assert.equal(controlResponse(), undefined, 'the seam has not answered while the ask is pending');
    assert.equal(registry.list().length, 1, 'the ask is pending');

    // The person approves, and only now is the decision written back.
    registry.answer(registry.list()[0]!.id, true, null);
    await tick();
    const decision = ((controlResponse() as Record<string, unknown>).response as Record<string, unknown>).response as Record<string, unknown>;
    assert.equal(decision.behavior, 'allow');

    fake.emit('{"type":"result","is_error":false,"session_id":"s"}\n');
    await turn;
});

test('autoApproveTool is a named function that allows and echoes the input', () => {
    const decision = autoApproveTool('AnyTool', { a: 1 });
    assert.deepEqual(decision, { behavior: 'allow', updatedInput: { a: 1 } });
});

test('a process that exits before a result returns a typed error, not a hang', async () => {
    const fake = makeFakeSpawn();
    const runner = new ClaudeRunner(baseDeps(fake));

    const turn = runner.runTurn({ text: 'x' });
    fake.emit('{"type":"system","subtype":"init","session_id":"partial"}\n');
    fake.exit();

    const result = await turn;
    assert.equal(result.status, 'exited');
    assert.equal(result.isError, true);
    assert.equal(result.sessionId, 'partial', 'what was captured before the exit survives');
});

test('a spawn error returns a typed error', async () => {
    const fake = makeFakeSpawn();
    const runner = new ClaudeRunner(baseDeps(fake));

    const turn = runner.runTurn({ text: 'x' });
    fake.error(new Error('ENOENT'));

    const result = await turn;
    assert.equal(result.status, 'spawn-error');
    assert.equal(result.isError, true);
});

test('a stalled stream times out with a typed error rather than hanging', async () => {
    const fake = makeFakeSpawn();
    const runner = new ClaudeRunner(baseDeps(fake, { timeoutMs: 30 }));

    const turn = runner.runTurn({ text: 'x' });
    fake.emit('{"type":"system","subtype":"init","session_id":"s"}\n');
    // never a result

    const result = await turn;
    assert.equal(result.status, 'timeout');
    assert.equal(result.isError, true);
    assert.equal(fake.killed(), true, 'a timed-out turn tears its child down');
});

test('interrupt writes an interrupt control request and the turn ends interrupted', async () => {
    const fake = makeFakeSpawn();
    const runner = new ClaudeRunner(baseDeps(fake));

    const turn = runner.runTurn({ text: 'x' });
    fake.emit('{"type":"system","subtype":"init","session_id":"s"}\n');
    runner.interrupt();

    const interrupt = fake.writes().map((w) => JSON.parse(w.trim()) as Record<string, unknown>)
        .find((o) => o.type === 'control_request' && (o.request as Record<string, unknown>).subtype === 'interrupt');
    assert.ok(interrupt, 'an interrupt control request was written');

    fake.emit('{"type":"result","is_error":false,"session_id":"s"}\n');
    const result = await turn;
    assert.equal(result.status, 'interrupted');
    assert.equal(result.isError, true);
});

test('turns 2+ resume: the session id is passed as --resume', async () => {
    const fake = makeFakeSpawn();
    const runner = new ClaudeRunner(baseDeps(fake));

    const turn = runner.runTurn({ text: 'second turn', resumeSessionId: 'sess-xyz' });
    fake.emit('{"type":"result","is_error":false,"session_id":"sess-xyz"}\n');
    await turn;

    const args = fake.args();
    const idx = args.indexOf('--resume');
    assert.ok(idx !== -1, '--resume is present for a resumed turn');
    assert.equal(args[idx + 1], 'sess-xyz');
});

test('turn 1 does not resume: no --resume flag', async () => {
    const fake = makeFakeSpawn();
    const runner = new ClaudeRunner(baseDeps(fake));

    const turn = runner.runTurn({ text: 'first turn' });
    fake.emit('{"type":"result","is_error":false,"session_id":"s"}\n');
    await turn;

    assert.equal(fake.args().includes('--resume'), false);
    // The fixed headless flags are all present.
    for (const flag of HEADLESS_ARGS) assert.ok(fake.args().includes(flag), `missing ${flag}`);
});

test('#61 isolation: CLAUDE_CONFIG_DIR is passed through to the child, stdio is piped', async () => {
    const fake = makeFakeSpawn();
    const runner = new ClaudeRunner(baseDeps(fake, { env: { CLAUDE_CONFIG_DIR: '/managed/xyz', PATH: '/bin' } }));

    const turn = runner.runTurn({ text: 'x' });
    fake.emit('{"type":"result","is_error":false,"session_id":"s"}\n');
    await turn;

    const options = fake.options();
    assert.equal(options?.env.CLAUDE_CONFIG_DIR, '/managed/xyz');
    assert.deepEqual(options?.stdio, ['pipe', 'pipe', 'pipe'], 'piped stdio, no pty');
});

test('the raw wire tap captures both directions verbatim', async () => {
    const fake = makeFakeSpawn();
    const wire: Array<{ line: string; dir: WireDirection }> = [];
    const runner = new ClaudeRunner(baseDeps(fake, {
        onRawLine: (line: string, dir: WireDirection) => wire.push({ line, dir })
    }));

    const turn = runner.runTurn({ text: 'x' });
    fake.emit('{"type":"result","is_error":false,"session_id":"s"}\n');
    await turn;

    const out = wire.filter((w) => w.dir === 'out').map((w) => w.line);
    const inbound = wire.filter((w) => w.dir === 'in').map((w) => w.line);
    assert.ok(out.some((l) => l.includes('"initialize"')), 'the initialize line is logged outbound');
    assert.ok(out.some((l) => l.includes('"type":"user"')), 'the user message is logged outbound');
    assert.ok(inbound.some((l) => l.includes('"type":"result"')), 'the result line is logged inbound');
});

test('dispose is idempotent and kills only the owned child', async () => {
    const fake = makeFakeSpawn();
    const runner = new ClaudeRunner(baseDeps(fake));

    const turn = runner.runTurn({ text: 'x' });
    fake.emit('{"type":"result","is_error":false,"session_id":"s"}\n');
    await turn;

    assert.equal(fake.killed(), true);
    assert.doesNotThrow(() => runner.dispose(), 'a second dispose is a no-op');
    assert.equal(runner.pid, null, 'no pid is owned after teardown');
});
