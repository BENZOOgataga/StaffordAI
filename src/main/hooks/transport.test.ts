/**
 * The launch wiring against a real socket on the platform running the test: a
 * named pipe on Windows, a socket file under a temp home on macOS. It proves the
 * shell-started transport keeps the properties the modules give it, rather than
 * re-testing the modules: the byte-identical acknowledgement, the connection cap,
 * that it is a pipe or socket and never a TCP port, and clean teardown.
 *
 * The 0700 directory and owner-only socket file are macOS filesystem properties.
 * Their logic is covered by socket-setup.test.ts with injected fs on every
 * platform, and the real-hardware ownership is the macOS harness section 3. This
 * file proves the transport comes up and enforces its access rules, not the mode
 * bits, which cannot be asserted meaningfully on Windows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHookTransport, stopHookTransport, type HookTransport } from './transport.ts';
import { currentPlatform } from '../platform/index.ts';
import { ACKNOWLEDGEMENT } from './hook-listener.ts';

const platform = currentPlatform();
let counter = 0;

// A short appId, because on macOS the socket path is
// <home>/Library/Application Support/<appId>/hook.sock and a unix socket path
// is capped near 104 bytes. The product uses ~/Library/... which is short; only
// a test with a long temp home risks the limit, so keep both short.
function appIdFor(): string {
    counter += 1;
    return 'Stx' + counter;
}

// A short temp home for the same reason: os.tmpdir() on macOS is a long
// /var/folders path, which would blow the socket-path limit. /tmp is short and
// writable on POSIX; Windows uses a named pipe, so the home length is irrelevant
// there and the standard temp dir is fine.
function shortHome(): string {
    const base = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    return fs.mkdtempSync(path.join(base, 's-'));
}

async function withTransport(
    name: string,
    options: { maxConnections?: number },
    fn: (t: HookTransport, home: string) => Promise<void>
): Promise<void> {
    void name;
    const home = shortHome();
    const transport = await startHookTransport({
        platform, home, appId: appIdFor(),
        ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections })
    });
    try {
        await fn(transport, home);
    } finally {
        await stopHookTransport(transport).catch(() => {});
        fs.rmSync(home, { recursive: true, force: true });
    }
}

/** Connect, send one line, resolve with the full reply, then the socket closes. */
function send(socketPath: string, line: string): Promise<string> {
    return new Promise((resolve, reject) => {
        let reply = '';
        const socket = net.connect(socketPath);
        socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('client timeout')); });
        socket.on('data', (d) => { reply += String(d); });
        socket.on('close', () => resolve(reply));
        socket.on('error', reject);
        socket.on('connect', () => socket.write(line));
    });
}

test('the socket comes up and a valid agent gets the byte-identical acknowledgement', async () => {
    await withTransport('ack', {}, async (t) => {
        const secret = t.secrets.issue('marion');
        const reply = await send(t.socketPath,
            JSON.stringify({ event: 'Stop', sessionId: 's1', agentId: 'marion', secret }) + '\n');
        assert.equal(reply, ACKNOWLEDGEMENT, 'the ack is byte-identical, unchanged by the shell wiring');
    });
});

test('two app ids bind distinct endpoints at once and each still authenticates its own agent', async () => {
    // The whole point of the override: a verification run under a distinct app id
    // stands up beside a running instance rather than colliding on its endpoint. Two
    // transports with two app ids come up together on two distinct pipes/sockets, and
    // the per-agent secret handshake still holds on the second, unweakened by the
    // isolation.
    const homeA = shortHome();
    const homeB = shortHome();
    const a = await startHookTransport({ platform, home: homeA, appId: appIdFor() });
    const b = await startHookTransport({ platform, home: homeB, appId: appIdFor() });
    // Auth shows in the listener signal, not the reply: the ack is byte-identical by
    // design, so a valid secret emits 'event' and a bad one emits 'rejected'.
    const eventsB: Array<{ agentId?: string; secret?: string }> = [];
    const rejectsB: Array<{ reason: string }> = [];
    b.listener.on('event', (e: { agentId?: string; secret?: string }) => eventsB.push(e));
    b.listener.on('rejected', (r: { reason: string }) => rejectsB.push(r));
    try {
        assert.notEqual(a.socketPath, b.socketPath, 'distinct app ids bind distinct endpoints, no collision');

        const secretB = b.secrets.issue('marion');
        const goodReply = await send(b.socketPath,
            JSON.stringify({ event: 'Stop', sessionId: 's1', agentId: 'marion', secret: secretB }) + '\n');
        assert.equal(goodReply, ACKNOWLEDGEMENT, 'the ack is byte-identical on the overridden endpoint');
        const authed = eventsB[0];
        assert.ok(authed, 'a valid secret authenticates and the event is emitted');
        assert.equal(eventsB.length, 1);
        assert.equal(authed.agentId, 'marion');
        assert.equal('secret' in authed, false, 'the secret never travels past the listener');

        // A's secret must not authenticate on B: the handshake is per-transport, so
        // isolation does not blur the auth between two coexisting runs.
        const secretA = a.secrets.issue('marion');
        await send(b.socketPath,
            JSON.stringify({ event: 'Stop', sessionId: 's2', agentId: 'marion', secret: secretA }) + '\n');
        assert.equal(eventsB.length, 1, 'the cross-transport secret does not emit an event');
        assert.ok(rejectsB.some((r) => r.reason === 'bad-secret'), 'a secret from the other transport is rejected');
    } finally {
        await stopHookTransport(a).catch(() => {});
        await stopHookTransport(b).catch(() => {});
        fs.rmSync(homeA, { recursive: true, force: true });
        fs.rmSync(homeB, { recursive: true, force: true });
    }
});

test('the connection cap rejects the connection past the cap, from the shell wiring', async () => {
    await withTransport('cap', { maxConnections: 2 }, async (t) => {
        const rejections: string[] = [];
        t.listener.on('rejected', (r: { reason: string }) => rejections.push(r.reason));

        // Two connections held open by connecting and not sending, so the third
        // arrives while the count is at the cap.
        const held: net.Socket[] = [];
        for (let i = 0; i < 2; i += 1) {
            await new Promise<void>((resolve, reject) => {
                const s = net.connect(t.socketPath);
                s.on('connect', () => { held.push(s); resolve(); });
                s.on('error', reject);
            });
        }

        const rejected = new Promise<void>((resolve) => {
            t.listener.on('rejected', () => resolve());
        });
        const third = net.connect(t.socketPath);
        await rejected;
        assert.ok(rejections.includes('too-many-connections'), 'the connection past the cap is rejected');

        third.destroy();
        for (const s of held) s.destroy();
    });
});

test('the transport is a pipe or socket path, never a TCP port', async () => {
    await withTransport('no-tcp', {}, async (t) => {
        assert.equal(typeof t.socketPath, 'string');
        const isPipe = t.socketPath.startsWith('\\\\.\\pipe\\');
        const isPath = path.isAbsolute(t.socketPath);
        assert.ok(isPipe || isPath, 'a pipe name or a filesystem path, not a number, so no port was bound');
        assert.equal(/^\d+$/.test(t.socketPath), false, 'not a bare port number');
    });
});

test('teardown closes the transport and a later connection fails', async () => {
    const home = shortHome();
    const t = await startHookTransport({ platform, home, appId: appIdFor() });
    await stopHookTransport(t);
    await assert.rejects(
        () => send(t.socketPath, 'x\n'),
        'after close, nothing is listening, so connecting fails'
    );
    fs.rmSync(home, { recursive: true, force: true });
});

test('the socket setup report matches the platform', async () => {
    await withTransport('report', {}, async (t) => {
        if (platform.id === 'win32') {
            // A named pipe: no parent directory, no socket file, no stale removal.
            assert.equal(t.report.parentDir, null);
            assert.equal(t.report.staleRemoved, false);
        } else {
            // A socket file in an owner-only directory the setup created or found.
            assert.notEqual(t.report.parentDir, null);
        }
    });
});

test('a stale socket file at launch is removed and the transport rebinds', async () => {
    // Only meaningful where the transport is a socket file. On Windows the pipe
    // has no file, so this asserts the pipe path binds with nothing to remove.
    const home = shortHome();
    const appId = appIdFor();
    const plan = platform.hookSocket(appId, home);
    try {
        if (plan.parentDir !== null) {
            fs.mkdirSync(plan.parentDir, { recursive: true });
            fs.writeFileSync(plan.path, '');
            const t = await startHookTransport({ platform, home, appId });
            assert.equal(t.report.staleRemoved, true, 'the leftover socket file was removed before binding');
            await stopHookTransport(t);
        } else {
            const t = await startHookTransport({ platform, home, appId });
            assert.equal(t.report.staleRemoved, false, 'a pipe has no file to remove, and it binds');
            await stopHookTransport(t);
        }
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
