import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { HookListener, ACKNOWLEDGEMENT } from './hook-listener.ts';
import { AgentSecrets } from './agent-secrets.ts';

/**
 * A real socket, on a real path, for every test. The transport is the thing
 * under test and a mocked socket would prove nothing about it.
 */
function socketPath(name: string): string {
    return process.platform === 'win32'
        ? '\\\\.\\pipe\\stafford-test-' + name + '-' + process.pid
        : path.join(os.tmpdir(), 'stafford-test-' + name + '-' + process.pid + '.sock');
}

interface Harness {
    listener: HookListener;
    secrets: AgentSecrets;
    send: (line: string) => Promise<string>;
    events: unknown[];
    rejections: { reason: string; agentId?: string | undefined }[];
    close: () => Promise<void>;
}

async function start(name: string, options: { maxConnections?: number } = {}): Promise<Harness> {
    const secrets = new AgentSecrets();
    const listener = new HookListener({
        socketPath: socketPath(name),
        secrets,
        ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections })
    });

    const events: unknown[] = [];
    const rejections: { reason: string; agentId?: string | undefined }[] = [];
    listener.on('event', (e) => events.push(e));
    listener.on('rejected', (r) => rejections.push(r));

    await listener.listen();

    const send = (line: string): Promise<string> =>
        new Promise((resolve, reject) => {
            const socket = net.connect(socketPath(name));
            let reply = '';
            socket.on('data', (d) => { reply += d.toString('utf8'); });
            socket.on('end', () => resolve(reply));
            socket.on('close', () => resolve(reply));
            socket.on('error', reject);
            socket.on('connect', () => socket.write(line));
            const bail = setTimeout(() => { socket.destroy(); resolve(reply); }, 3000);
            bail.unref();
        });

    return { listener, secrets, send, events, rejections, close: () => listener.close() };
}

// ---------------------------------------------------------------------------
// The one that matters: a valid secret does not let an agent speak for another.
// ---------------------------------------------------------------------------

test('agent A cannot post events as agent B, even holding a valid secret', async () => {
    const h = await start('impersonation');
    try {
        const secretA = h.secrets.issue('marion');
        h.secrets.issue('theo');

        // Marion's secret is real. The claim is not.
        await h.send(JSON.stringify({ event: 'Stop', sessionId: 's1', agentId: 'theo', secret: secretA }) + '\n');

        assert.deepEqual(h.events, [], 'no event may be accepted for an agent whose secret was not presented');
        assert.equal(h.rejections.length, 1);
        assert.equal(h.rejections[0]?.reason, 'bad-secret');

        // And the honest case still works, so the rejection is not blanket.
        const secretB = h.secrets.issue('theo');
        await h.send(JSON.stringify({ event: 'Stop', sessionId: 's1', agentId: 'theo', secret: secretB }) + '\n');
        assert.equal(h.events.length, 1);
    } finally {
        await h.close();
    }
});

test('a revoked secret stops working immediately', async () => {
    const h = await start('revoke');
    try {
        const secret = h.secrets.issue('marion');
        h.secrets.revoke('marion');

        await h.send(JSON.stringify({ event: 'Stop', sessionId: 's1', agentId: 'marion', secret }) + '\n');
        assert.deepEqual(h.events, []);
        assert.equal(h.rejections[0]?.reason, 'bad-secret');
    } finally {
        await h.close();
    }
});

test('no secret, empty secret and a wrong secret are all refused', async () => {
    const h = await start('nosecret');
    try {
        h.secrets.issue('marion');
        for (const secret of [undefined, '', 'not-the-secret']) {
            const payload: Record<string, unknown> = { event: 'Stop', sessionId: 's1', agentId: 'marion' };
            if (secret !== undefined) payload.secret = secret;
            await h.send(JSON.stringify(payload) + '\n');
        }
        assert.deepEqual(h.events, []);
        assert.equal(h.rejections.length, 3);
    } finally {
        await h.close();
    }
});

test('the accepted event never carries the secret onwards', async () => {
    const h = await start('stripped');
    try {
        const secret = h.secrets.issue('marion');
        await h.send(JSON.stringify({ event: 'Stop', sessionId: 's1', agentId: 'marion', secret }) + '\n');

        assert.equal(h.events.length, 1);
        assert.equal('secret' in (h.events[0] as object), false, 'the secret stops at the listener');
        assert.equal(JSON.stringify(h.events[0]).includes(secret), false);
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// The reply is a constant, so it cannot be used as an oracle.
// ---------------------------------------------------------------------------

test('every outcome gets a byte-identical reply', async () => {
    const h = await start('oracle');
    try {
        const secret = h.secrets.issue('marion');

        const replies = [
            await h.send(JSON.stringify({ event: 'Stop', sessionId: 's1', agentId: 'marion', secret }) + '\n'),
            await h.send(JSON.stringify({ event: 'Stop', sessionId: 's1', agentId: 'marion', secret: 'wrong' }) + '\n'),
            await h.send(JSON.stringify({ event: 'Stop', sessionId: 's1', agentId: 'ghost', secret }) + '\n'),
            await h.send(JSON.stringify({ event: 'Stop', agentId: 'marion', secret }) + '\n'),
            await h.send('this is not json\n')
        ];

        // Everyone has read access to the pipe on Windows. A rejection that
        // looks different from an acceptance tells a local account which agent
        // ids and secrets are real, one connection at a time.
        for (const reply of replies) {
            assert.equal(reply, ACKNOWLEDGEMENT, 'accept and reject must be indistinguishable on the wire');
        }
        assert.equal(new Set(replies.map((r) => r.length)).size, 1, 'even the length must not differ');
    } finally {
        await h.close();
    }
});

test('an event with no session id is rejected before it reaches state derivation', async () => {
    // Returned from docs/RETIRED-WITH-PROMISE.md, owed by this task. It was
    // retired from state derivation in Task 4 because a message with no session
    // id is a malformed message, not a state question.
    const h = await start('nosession');
    try {
        const secret = h.secrets.issue('marion');
        await h.send(JSON.stringify({ event: 'Stop', agentId: 'marion', secret }) + '\n');

        assert.deepEqual(h.events, []);
        assert.equal(h.rejections[0]?.reason, 'no-session-id');
    } finally {
        await h.close();
    }
});

test('malformed and oversized payloads are refused without killing the listener', async () => {
    const h = await start('malformed');
    try {
        const secret = h.secrets.issue('marion');

        await h.send('{ not json\n');
        await h.send('x'.repeat(70 * 1024) + '\n');

        assert.deepEqual(h.rejections.map((r) => r.reason), ['malformed', 'oversized']);

        // Still serving, which is the point: a hook that fails must never
        // degrade the runner, and neither must a hostile one.
        await h.send(JSON.stringify({ event: 'Stop', sessionId: 's1', agentId: 'marion', secret }) + '\n');
        assert.equal(h.events.length, 1);
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// The connection cap
// ---------------------------------------------------------------------------

test('connections beyond the cap are rejected and logged, not left to exhaust the runner', async () => {
    // A cap of zero rather than holding real sockets open. Holding them raced
    // the server's own idle timeout, which could drop the count back under the
    // cap before the assertion ran, so the test was timing-dependent in both
    // directions. The behaviour under test is the refusal, and a cap of zero
    // reaches it on the first connection every time.
    const h = await start('cap', { maxConnections: 0 });
    try {
        const secret = h.secrets.issue('marion');
        const reply = await h.send(
            JSON.stringify({ event: 'Stop', sessionId: 's1', agentId: 'marion', secret }) + '\n'
        );

        assert.equal(reply, ACKNOWLEDGEMENT, 'even a capped-out connection gets the same reply');
        assert.deepEqual(h.rejections.map((r) => r.reason), ['too-many-connections']);
        assert.deepEqual(h.events, [], 'a refused connection delivers nothing, even with a valid secret');
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// Secrets in isolation
// ---------------------------------------------------------------------------

test('issued secrets are distinct, long, and not derived from the agent id', () => {
    const secrets = new AgentSecrets();
    const a = secrets.issue('marion');
    const b = secrets.issue('theo');

    assert.notEqual(a, b);
    assert.equal(a.length, 64, '32 bytes of hex');
    assert.equal(a.includes('marion'), false);
    assert.match(a, /^[0-9a-f]+$/);
});

test('reissuing replaces the previous secret rather than adding one', () => {
    const secrets = new AgentSecrets();
    const first = secrets.issue('marion');
    const second = secrets.issue('marion');

    assert.equal(secrets.validate('marion', second), true);
    assert.equal(secrets.validate('marion', first), false, 'a respawn invalidates the old secret');
    assert.equal(secrets.size, 1);
});

test('validate refuses an unknown agent and a missing secret', () => {
    const secrets = new AgentSecrets();
    const secret = secrets.issue('marion');

    assert.equal(secrets.validate('marion', secret), true);
    assert.equal(secrets.validate('nobody', secret), false);
    assert.equal(secrets.validate('marion', undefined), false);
    assert.equal(secrets.validate(undefined, secret), false);
});
