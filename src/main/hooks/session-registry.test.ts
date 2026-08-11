/**
 * The registry against stubs and, for the persistence and live-socket proofs, a
 * real database and a real listener. No test spawns a Claude session: events are
 * fed in directly, and the one end-to-end test drives a real socket the same way
 * the transport tests do.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    SessionRegistry, hireStoreOver, coerceHookEvent,
    type HireStore, type HireBinding
} from './session-registry.ts';
import { startHookTransport, stopHookTransport } from './transport.ts';
import { currentPlatform } from '../platform/index.ts';
import { runDrain, type DrainSink } from '../agents/drain.ts';
import { openDatabase } from '../storage/database.ts';
import { createRepositories } from '../storage/repository.ts';
import type { HookEvent } from './session-state.ts';
import type { HiredAgent } from '../../domain/models.ts';
import type { DrainReportEntry } from '../../domain/models.ts';

const PLATFORM = currentPlatform();
const AT = '2026-08-11T00:00:00.000Z';

function fakeStore(map: Record<string, HireBinding>): {
    store: HireStore; sets: Array<{ hireId: string; state: string }>;
} {
    const sets: Array<{ hireId: string; state: string }> = [];
    return {
        sets,
        store: {
            findBySession: (sid) => map[sid] ?? null,
            setState: (hireId, state) => { sets.push({ hireId, state }); }
        }
    };
}

function ev(event: string, sessionId: string, extra: Partial<HookEvent> = {}): HookEvent {
    return { event, sessionId, ...extra };
}

function collectingSink(): { sink: DrainSink; rows: DrainReportEntry[] } {
    const rows: DrainReportEntry[] = [];
    return { sink: { append: (e) => { rows.push(e); } }, rows };
}

test('a hook event drives the right hire through the sessions map', () => {
    const { store, sets } = fakeStore({ 'sess-1': { hireId: 'h1', projectId: 'p1' } });
    const registry = new SessionRegistry(store);

    registry.ingest(ev('SessionStart', 'sess-1', { agentId: 'h1' }), AT);
    const working = registry.ingest(ev('UserPromptSubmit', 'sess-1'), AT);

    assert.equal(working.hireId, 'h1');
    assert.equal(working.state, 'working');
    assert.deepEqual(sets.at(-1), { hireId: 'h1', state: 'working' });
});

test('the hire state is persisted only on a transition, not on every event', () => {
    const { store, sets } = fakeStore({ 'sess-1': { hireId: 'h1', projectId: 'p1' } });
    const registry = new SessionRegistry(store);

    registry.ingest(ev('SessionStart', 'sess-1'), AT); // idle -> idle, no write
    registry.ingest(ev('UserPromptSubmit', 'sess-1'), AT); // idle -> working, one write
    registry.ingest(ev('UserPromptSubmit', 'sess-1'), AT); // working -> working, no write
    registry.ingest(ev('SubagentStop', 'sess-1'), AT); // no state change, no write

    assert.equal(sets.length, 1, 'only the real transition wrote');
    assert.deepEqual(sets[0], { hireId: 'h1', state: 'working' });
});

test('a started session registers into the drainable set, the drain sees it and writes its row', async () => {
    const { store } = fakeStore({ 'sess-1': { hireId: 'h1', projectId: 'p1' } });
    const registry = new SessionRegistry(store);
    registry.ingest(ev('SessionStart', 'sess-1', { agentId: 'agent-marion' }), AT);

    const drainables = registry.drainables();
    assert.equal(drainables.length, 1, 'the live session is drainable');
    assert.equal(drainables[0]?.agentId, 'agent-marion');

    const { sink, rows } = collectingSink();
    const summary = await runDrain({
        agents: drainables, platform: PLATFORM, sink,
        drainId: 'd1', now: () => AT,
        timeout: () => new Promise<'timeout'>(() => {}), forceKill: () => Promise.resolve()
    });

    assert.equal(rows.length, 1, 'the drain wrote a row for the registered session, not an empty set');
    assert.equal(rows[0]?.agentId, 'agent-marion');
    assert.equal(summary.total, 1);
});

test('a session that ends deregisters and is gone from the drainable set', () => {
    const { store } = fakeStore({ 'sess-1': { hireId: 'h1', projectId: 'p1' } });
    const registry = new SessionRegistry(store);

    registry.ingest(ev('SessionStart', 'sess-1'), AT);
    assert.equal(registry.has('sess-1'), true);
    assert.equal(registry.drainables().length, 1);

    const ended = registry.ingest(ev('SessionEnd', 'sess-1'), AT);
    assert.equal(ended.ended, true);
    assert.equal(registry.has('sess-1'), false);
    assert.equal(registry.drainables().length, 0, 'a finished session is not force-killed on a later quit');
});

test('an event for an unmapped session touches no hire and registers nothing', () => {
    const { store, sets } = fakeStore({}); // nothing maps
    const registry = new SessionRegistry(store);

    const result = registry.ingest(ev('UserPromptSubmit', 'ghost'), AT);

    assert.equal(result.handled, false);
    assert.equal(result.reason, 'unmapped');
    assert.equal(sets.length, 0, 'no hire was written, so nothing was mis-attributed');
    assert.equal(registry.drainables().length, 0, 'an unmapped session is not drainable');
});

test('an event with no session id is handled, not a crash', () => {
    const { store } = fakeStore({});
    const registry = new SessionRegistry(store);
    const result = registry.ingest({ event: 'Notification' }, AT);
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'no-session-id');
});

test('coerceHookEvent narrows the raw record and drops non-string fields', () => {
    const e = coerceHookEvent({ event: 'Stop', sessionId: 's', agentId: 'a', cwd: 42, extra: {} });
    assert.equal(e.event, 'Stop');
    assert.equal(e.sessionId, 's');
    assert.equal(e.agentId, 'a');
    assert.equal(e.cwd, undefined, 'a non-string field is dropped, not passed through');
});

// --- backed by the real repository ------------------------------------------

function withRepos(fn: (repos: ReturnType<typeof createRepositories>) => void): void {
    const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stafford-reg-'));
    const open = openDatabase({ appDataDir });
    try {
        fn(createRepositories(open.db));
    } finally {
        open.db.close();
        fs.rmSync(appDataDir, { recursive: true, force: true });
    }
}

function hire(id: string, sessions: Record<string, string>): HiredAgent {
    return {
        id, name: 'Marion', type: 'lead-developer', title: 'Lead developer', seniority: 2,
        ownerId: 'owner-1', sessions, activeProjectId: 'p1', state: 'idle',
        hiredAt: '2026-08-10T00:00:00Z', firedAt: null
    };
}

test('the repository-backed hire store resolves a session and writes the hire state', () => {
    withRepos((repos) => {
        repos.hires.insert(hire('h1', { p1: 'sess-1' }));
        const registry = new SessionRegistry(hireStoreOver(repos));

        registry.ingest(ev('UserPromptSubmit', 'sess-1'), AT);

        const back = repos.hires.get('h1');
        assert.equal(back?.state, 'working', 'the derived state was written to the hire on disk');
    });
});

// --- the live listener over a real socket -----------------------------------

function shortHome(): string {
    const base = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    return fs.mkdtempSync(path.join(base, 's-'));
}

function send(socketPath: string, line: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(socketPath);
        socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('client timeout')); });
        // A data listener puts the socket in flowing mode. Without one it stays
        // paused, never consumes the acknowledgement or the server's FIN, and only
        // closes on the timeout. The reply is a constant and is deliberately unread.
        socket.on('data', () => {});
        socket.on('close', () => resolve());
        socket.on('error', reject);
        socket.on('connect', () => socket.write(line));
    });
}

test('the live listener over a real socket drives the hire state through the registry', async () => {
    const home = shortHome();
    const transport = await startHookTransport({ platform: PLATFORM, home, appId: 'Reg' + process.pid });
    const { store, sets } = fakeStore({ 'sess-1': { hireId: 'h1', projectId: 'p1' } });
    const registry = new SessionRegistry(store);

    const events: unknown[] = [];
    const rejections: unknown[] = [];
    transport.listener.on('event', (raw: Record<string, unknown>) => {
        events.push(raw);
        registry.ingest(coerceHookEvent(raw), AT);
    });
    transport.listener.on('rejected', (info: unknown) => { rejections.push(info); });

    try {
        const secret = transport.secrets.issue('h1');
        await send(transport.socketPath,
            JSON.stringify({ event: 'UserPromptSubmit', sessionId: 'sess-1', agentId: 'h1', secret }) + '\n');

        // The listener emits synchronously as it consumes the line, but the client
        // close resolves on its own tick, so give the emit a turn to land.
        const deadline = Date.now() + 3000;
        while (sets.length === 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 20));
        }

        assert.deepEqual(sets.at(-1), { hireId: 'h1', state: 'working' },
            'a real event over the socket drove the hire to working. events=' +
            JSON.stringify(events) + ' rejections=' + JSON.stringify(rejections));
        assert.equal(registry.has('sess-1'), true, 'the session is registered for the drain');
    } finally {
        await stopHookTransport(transport).catch(() => {});
        fs.rmSync(home, { recursive: true, force: true });
    }
});
