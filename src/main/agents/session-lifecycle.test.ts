/**
 * The lifecycle: cold spawn, the hook rendezvous, the not-reporting state, the
 * idempotent teardown, and, in one real-process test, the drain reaping a live
 * session spawned through it.
 *
 * The stubbed tests inject the spawn, the kill, and the timer so they neither
 * touch a real process nor wait real seconds. The reap test spawns a real fixture
 * process through node-pty and drives it over a real socket, then proves the drain
 * kills the whole tree with zero survivors, the way the harness kill test did.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SessionLifecycle, type Timers, type TimerHandle } from './session-lifecycle.ts';
import { SessionRegistry, coerceHookEvent, type HireStore, type HireBinding } from '../hooks/session-registry.ts';
import { AgentSecrets } from '../hooks/agent-secrets.ts';
import { startHookTransport, stopHookTransport } from '../hooks/transport.ts';
import { runDrain, type DrainSink } from './drain.ts';
import { currentPlatform } from '../platform/index.ts';
import type { PtyLike } from './pty-session.ts';
import type { KillTreeReport } from './kill-tree.ts';
import type { DrainReportEntry } from '../../domain/models.ts';

const require = createRequire(import.meta.url);
const nodePty = require('node-pty') as {
    spawn: (file: string, args: readonly string[], options: Record<string, unknown>) => PtyLike;
};

const PLATFORM = currentPlatform();
const FIXTURE = path.resolve(process.cwd(), 'runner', 'fixtures', 'hook-forwarder-child.js');

function fakeStore(map: Record<string, HireBinding>): {
    store: HireStore;
    sets: Array<{ hireId: string; state: string }>;
    binds: Array<{ hireId: string; projectId: string; sessionId: string }>;
} {
    const sets: Array<{ hireId: string; state: string }> = [];
    const binds: Array<{ hireId: string; projectId: string; sessionId: string }> = [];
    return {
        sets, binds,
        store: {
            findBySession: (sid) => map[sid] ?? null,
            setState: (hireId, state) => { sets.push({ hireId, state }); },
            bindSession: (hireId, projectId, sessionId) => {
                binds.push({ hireId, projectId, sessionId });
                map[sessionId] = { hireId, projectId };
            }
        }
    };
}

/** A stub pty that records writes and resizes and lets a test fire exit and data. */
function stubPty(pid = 4242): PtyLike & {
    fireExit: (code: number) => void; emit: (data: string) => void;
    writes: string[]; resizes: Array<{ cols: number; rows: number }>;
} {
    let onExit: (info: { exitCode: number; signal?: number }) => void = () => {};
    let onData: (data: string) => void = () => {};
    const writes: string[] = [];
    const resizes: Array<{ cols: number; rows: number }> = [];
    return {
        pid,
        onData: (listener) => { onData = listener; },
        onExit: (listener) => { onExit = listener; },
        write: (d) => { writes.push(d); },
        resize: (cols, rows) => { resizes.push({ cols, rows }); },
        kill: () => {},
        fireExit: (code) => onExit({ exitCode: code }),
        emit: (data) => onData(data),
        writes,
        resizes
    };
}

const noKill = async (): Promise<KillTreeReport> => ({
    rootPid: 0, snapshot: [], groups: [], survivorsBeforeSweep: [], survivors: [], ok: true, detail: 'stub'
});

interface FakeTimer { id: number; cb: () => void; ms: number; unrefed: boolean; cleared: boolean }

/** A timer seam a test drives by hand, so the virtual clock is deterministic. */
function fakeTimers(): {
    timers: Timers;
    armed: () => FakeTimer[];
    fireByMs: (ms: number) => void;
} {
    const all: FakeTimer[] = [];
    let seq = 0;
    const timers: Timers = {
        set: (cb, ms) => {
            const rec: FakeTimer = { id: ++seq, cb, ms, unrefed: false, cleared: false };
            all.push(rec);
            return { id: rec.id, unref: () => { rec.unrefed = true; } } as TimerHandle & { id: number };
        },
        clear: (handle) => {
            const rec = all.find((r) => r.id === (handle as { id: number }).id);
            if (rec) rec.cleared = true;
        }
    };
    return {
        timers,
        armed: () => all.filter((r) => !r.cleared),
        fireByMs: (ms) => { all.find((r) => r.ms === ms && !r.cleared)?.cb(); }
    };
}

function buildDeps(over: {
    spawn?: PtyLike;
    setState?: (hireId: string, state: string) => void;
    trust?: 'trusted' | 'not_trusted' | 'unknown';
    notReportingMs?: number;
    idleMs?: number;
    timers?: Timers;
    target?: { projectId: string; cwd: string } | null;
    resumeSessionId?: string | null;
    sessions?: Record<string, HireBinding>;
} = {}) {
    const { store, sets, binds } = fakeStore(over.sessions ?? {});
    const registry = new SessionRegistry(store);
    const secrets = new AgentSecrets();
    const pty = over.spawn ?? stubPty();
    const setStateCalls: Array<{ hireId: string; state: string }> = [];
    const killed: number[] = [];
    const capturedArgs: string[][] = [];
    const absSocket = path.resolve(os.tmpdir(), 'x.sock');
    const lifecycle = new SessionLifecycle({
        platform: PLATFORM, socketPath: absSocket, secrets, registry,
        claudePath: path.resolve(os.tmpdir(), 'claude'), nodeDir: path.dirname(process.execPath), parentEnv: {},
        spawn: (_file, args) => { capturedArgs.push([...args]); return pty; },
        resolveTarget: () => (over.target === undefined
            ? { projectId: 'p1', cwd: 'C:/repo', resumeSessionId: over.resumeSessionId ?? null }
            : over.target),
        setState: (hireId, state) => { setStateCalls.push({ hireId, state }); over.setState?.(hireId, state); },
        trustFor: () => over.trust ?? 'trusted',
        notReportingMs: over.notReportingMs ?? 30_000,
        ...(over.idleMs === undefined ? {} : { idleMs: over.idleMs }),
        ...(over.timers ? { timers: over.timers } : {}),
        killTree: async (_p, pid) => { killed.push(pid); return noKill(); }
    });
    return { lifecycle, registry, secrets, sets, binds, setStateCalls, killed, capturedArgs, pty };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('the first message cold-spawns a session and pre-registers it as drainable by its pid', () => {
    const { lifecycle, registry } = buildDeps();
    const pid = lifecycle.sendMessage('h1', 'hello');
    assert.equal(lifecycle.has('h1'), true);
    assert.equal(registry.isPending('h1'), true, 'pre-registered before any hook');
    assert.equal(registry.drainables()[0]?.pid, pid, 'drainable by its real pid');
});

test('the attached hook drives the hire to working and stops the not-reporting clock', () => {
    const { lifecycle, registry, sets } = buildDeps();
    lifecycle.sendMessage('h1', 'hello');

    // Simulate the forwarder: the first event carries the agent id.
    registry.ingest(coerceHookEvent({ event: 'SessionStart', sessionId: 's1', agentId: 'h1' }), '2026-08-11T00:00:00Z');
    registry.ingest(coerceHookEvent({ event: 'UserPromptSubmit', sessionId: 's1', agentId: 'h1' }), '2026-08-11T00:00:01Z');

    assert.deepEqual(sets.at(-1), { hireId: 'h1', state: 'working' });
    assert.equal(registry.isPending('h1'), false, 'bound, no longer pending');
});

test('a spawn whose hook never attaches enters not_reporting, stays drainable, is not crashed or needs_trust', async () => {
    const { lifecycle, registry, setStateCalls } = buildDeps({ notReportingMs: 10 });
    lifecycle.sendMessage('h1', 'hello');

    await new Promise((r) => setTimeout(r, 40));

    assert.deepEqual(setStateCalls, [{ hireId: 'h1', state: 'not_reporting' }],
        'the alive-but-silent spawn is not_reporting, distinct from crashed and needs_trust');
    assert.equal(registry.isPending('h1'), true, 'still drainable: quit will reap it');
});

test('a spawn that dies before attaching is needs_trust in an untrusted dir', () => {
    const pty = stubPty();
    const { lifecycle, setStateCalls } = buildDeps({ spawn: pty, trust: 'not_trusted' });
    lifecycle.sendMessage('h1', 'hello');
    pty.fireExit(1);
    assert.deepEqual(setStateCalls, [{ hireId: 'h1', state: 'needs_trust' }]);
});

test('a spawn that dies before attaching in a trusted dir is crashed', () => {
    const pty = stubPty();
    const { lifecycle, setStateCalls } = buildDeps({ spawn: pty, trust: 'trusted' });
    lifecycle.sendMessage('h1', 'hello');
    pty.fireExit(1);
    assert.deepEqual(setStateCalls, [{ hireId: 'h1', state: 'crashed' }]);
});

test('every armed timer is unref\'d, so a waiting session cannot hold the app open', () => {
    const ft = fakeTimers();
    const { lifecycle } = buildDeps({ timers: ft.timers, idleMs: 1000, notReportingMs: 2000 });
    lifecycle.sendMessage('h1', 'hello');
    const armed = ft.armed();
    assert.equal(armed.length, 2, 'the idle and not-reporting timers');
    assert.ok(armed.every((t) => t.unrefed), 'both are unref\'d');
});

test('the idle timer fires after the idle period and tears down through the shared path', async () => {
    const ft = fakeTimers();
    const { lifecycle, registry, killed } = buildDeps({ timers: ft.timers, idleMs: 1000, notReportingMs: 999_999 });
    const pid = lifecycle.sendMessage('h1', 'hello');

    ft.fireByMs(1000); // the virtual clock reaches the idle period
    await tick();

    assert.deepEqual(killed, [pid], 'the idle session was reaped once, through the shared teardown');
    assert.equal(lifecycle.has('h1'), false);
    assert.equal(registry.drainables().length, 0, 'zero survivors: deregistered');
});

test('activity resets the idle timer, so a session that keeps working never idles down', () => {
    const ft = fakeTimers();
    const { lifecycle, registry } = buildDeps({ timers: ft.timers, idleMs: 1000, notReportingMs: 999_999 });
    lifecycle.sendMessage('h1', 'hello');
    const firstIdle = ft.armed().find((t) => t.ms === 1000);

    // An event for the session is activity: the registry tells the lifecycle,
    // which re-arms the idle clock. The first idle timer is cleared, a new one set.
    registry.ingest(coerceHookEvent({ event: 'SessionStart', sessionId: 's1', agentId: 'h1' }), '2026-08-11T00:00:00Z');

    assert.equal(ft.armed().some((t) => t.id === firstIdle?.id), false, 'the first idle timer was cleared');
    assert.equal(ft.armed().some((t) => t.ms === 1000), true, 'a fresh idle timer was armed');
});

test('teardown disarms the idle timer, so a torn-down session has no dangling timer', async () => {
    const ft = fakeTimers();
    const { lifecycle } = buildDeps({ timers: ft.timers, idleMs: 1000, notReportingMs: 999_999 });
    lifecycle.sendMessage('h1', 'hello');
    await lifecycle.teardown('h1');
    assert.equal(ft.armed().length, 0, 'no armed timer survives teardown');
});

test('an idle shutdown racing the drain resolves to one teardown, zero survivors, one honest row', async () => {
    const ft = fakeTimers();
    const { lifecycle, registry, killed } = buildDeps({ timers: ft.timers, idleMs: 1000, notReportingMs: 999_999 });
    lifecycle.sendMessage('h1', 'hello');

    // The drain snapshots the drainables, then the idle timer fires mid-flight.
    const snapshot = registry.drainables();
    ft.fireByMs(1000);
    await tick();
    assert.deepEqual(killed, [4242], 'the idle shutdown reaped it once');

    // The drain then runs over its stale snapshot, reaching the shared teardown
    // again through the checkpoint. Idempotent, so no second kill, no error.
    const { sink, rows } = collectingSink();
    await runDrain({
        agents: snapshot, platform: PLATFORM, sink, drainId: 'd1', now: () => '2026-08-11T00:00:00Z',
        forceKill: (a) => lifecycle.teardown(a.agentId)
    });

    assert.equal(killed.length, 1, 'still one kill: the teardown was idempotent under the race');
    assert.equal(rows.length, 1, 'one honest drain_report row, not two');
    assert.equal(rows[0]?.committed, false, 'never a false commit');
});

test('teardown is idempotent: twice does not double-kill or throw', async () => {
    const { lifecycle, registry, secrets, killed } = buildDeps();
    lifecycle.sendMessage('h1', 'hello');
    secrets.issue('h1'); // present a secret to revoke

    await lifecycle.teardown('h1');
    await lifecycle.teardown('h1');

    assert.equal(killed.length, 1, 'the tree was reaped once, the second call was a no-op');
    assert.equal(lifecycle.has('h1'), false);
    assert.equal(registry.drainables().length, 0, 'deregistered');
    assert.equal(secrets.size, 0, 'the secret was revoked');
});

test('a message to a hire with a stored session id resumes with --resume and keeps the id', () => {
    const { lifecycle, registry, sets, binds, capturedArgs } = buildDeps({
        resumeSessionId: 's1', sessions: { s1: { hireId: 'h1', projectId: 'p1' } }
    });
    lifecycle.sendMessage('h1', 'continue');
    assert.deepEqual(capturedArgs[0], ['--resume', 's1'], 'resumed with the stored id');

    // The resumed session reports under the same id it was resumed with.
    registry.ingest(coerceHookEvent({ event: 'SessionStart', sessionId: 's1', agentId: 'h1' }), '2026-08-11T00:00:00Z');
    registry.ingest(coerceHookEvent({ event: 'UserPromptSubmit', sessionId: 's1', agentId: 'h1' }), '2026-08-11T00:00:01Z');
    assert.equal(sets.at(-1)?.state, 'working', 'the resume drove state');
    assert.deepEqual(binds, [], 'the stored id is retained, not rebound');
});

test('a message to a hire with no stored session id still cold-spawns, no --resume', () => {
    const { lifecycle, capturedArgs } = buildDeps({ resumeSessionId: null });
    lifecycle.sendMessage('h1', 'start');
    assert.deepEqual(capturedArgs[0], [], 'a cold spawn, unchanged');
});

test('a stale id falls back to a fresh cold spawn: works, new id, context-lost note, not stuck, not crashed', async () => {
    const pty = stubPty();
    const { lifecycle, registry, sets, binds, setStateCalls, capturedArgs } = buildDeps({
        spawn: pty, resumeSessionId: 's1', sessions: { s1: { hireId: 'h1', projectId: 'p1' } }
    });
    lifecycle.sendMessage('h1', 'continue');

    // The resume exits before it ever reported: the stale-id failure.
    pty.fireExit(1);
    await tick();

    assert.equal(lifecycle.contextLost('h1'), true, 'the person is told the context was lost');
    assert.equal(lifecycle.has('h1'), true, 'not left stuck: a fresh session is up');
    assert.deepEqual(capturedArgs[1], [], 'the fallback is a cold spawn, no --resume');
    assert.equal(setStateCalls.some((c) => c.state === 'crashed' || c.state === 'needs_trust'), false,
        'a failed resume is not crashed or needs_trust');

    // The fresh session reports under a new id, which overwrites the stale one.
    registry.ingest(coerceHookEvent({ event: 'SessionStart', sessionId: 's2', agentId: 'h1' }), '2026-08-11T00:00:00Z');
    registry.ingest(coerceHookEvent({ event: 'UserPromptSubmit', sessionId: 's2', agentId: 'h1' }), '2026-08-11T00:00:01Z');
    assert.equal(sets.at(-1)?.state, 'working', 'the colleague ends up working, freshly');
    assert.deepEqual(binds.at(-1), { hireId: 'h1', projectId: 'p1', sessionId: 's2' },
        'the new id was written over the stale one');
});

test('a healthy-but-slow resume attaches and is never force-fallen-back', () => {
    const { lifecycle, registry, sets, capturedArgs } = buildDeps({
        resumeSessionId: 's1', sessions: { s1: { hireId: 'h1', projectId: 'p1' } }
    });
    lifecycle.sendMessage('h1', 'continue');
    // No exit; it simply attaches a moment later.
    registry.ingest(coerceHookEvent({ event: 'SessionStart', sessionId: 's1', agentId: 'h1' }), '2026-08-11T00:00:00Z');
    registry.ingest(coerceHookEvent({ event: 'UserPromptSubmit', sessionId: 's1', agentId: 'h1' }), '2026-08-11T00:00:01Z');

    assert.equal(sets.at(-1)?.state, 'working');
    assert.equal(capturedArgs.length, 1, 'no second spawn: the slow resume was not force-restarted');
    assert.equal(lifecycle.contextLost('h1'), false, 'no context lost: the resume took');
});

test('a resume that stays alive but never attaches enters not_reporting, not the fallback', () => {
    const ft = fakeTimers();
    const { lifecycle, setStateCalls, capturedArgs } = buildDeps({
        timers: ft.timers, notReportingMs: 100, idleMs: 999_999,
        resumeSessionId: 's1', sessions: { s1: { hireId: 'h1', projectId: 'p1' } }
    });
    lifecycle.sendMessage('h1', 'continue');
    ft.fireByMs(100); // the not-reporting bound passes while the process is still alive

    assert.deepEqual(setStateCalls, [{ hireId: 'h1', state: 'not_reporting' }],
        'alive and silent is not_reporting, not a stale-id fallback');
    assert.equal(capturedArgs.length, 1, 'no fresh spawn was forced');
    assert.equal(lifecycle.contextLost('h1'), false);
});

test('a resumed session registers a real pid and is reaped by the drain, zero survivors', async () => {
    const { lifecycle, registry, killed } = buildDeps({
        resumeSessionId: 's1', sessions: { s1: { hireId: 'h1', projectId: 'p1' } }
    });
    const pid = lifecycle.sendMessage('h1', 'continue');
    assert.equal(registry.drainables().some((d) => d.pid === pid), true, 'the resumed pid is drainable');

    const { sink, rows } = collectingSink();
    await runDrain({
        agents: registry.drainables(), platform: PLATFORM, sink, drainId: 'd1',
        now: () => '2026-08-11T00:00:00Z', forceKill: (a) => lifecycle.teardown(a.agentId)
    });
    assert.equal(killed.length, 1, 'reaped once');
    assert.equal(rows.length, 1);
    assert.equal(registry.drainables().length, 0, 'zero survivors');
});

test('subscribe replays a live session then streams, and is a no-op for an unknown hire', () => {
    const pty = stubPty();
    const { lifecycle } = buildDeps({ spawn: pty });
    lifecycle.sendMessage('h1', 'hi');

    // The session produced output before the card opened.
    pty.emit('EARLIER');

    const seen: string[] = [];
    const off = lifecycle.subscribe('h1', (d) => seen.push(d));
    assert.equal(seen[0], 'EARLIER', 'the buffer replayed first, so the terminal is not blank');
    pty.emit('LIVE');
    assert.equal(seen.at(-1), 'LIVE', 'then live output streams');
    off();
    pty.emit('AFTER OFF');
    assert.equal(seen.includes('AFTER OFF'), false, 'unsubscribing stops the stream');

    const noop = lifecycle.subscribe('nobody', () => { throw new Error('should not fire'); });
    assert.equal(typeof noop, 'function', 'an unknown hire is a safe no-op, not an error');
});

test('resize propagates the pane size to the pty', () => {
    const pty = stubPty();
    const { lifecycle } = buildDeps({ spawn: pty });
    lifecycle.sendMessage('h1', 'hi');
    lifecycle.resize('h1', 132, 40);
    assert.deepEqual(pty.resizes.at(-1), { cols: 132, rows: 40 });
});

test('the buffer resets on resume: a resumed session starts with an empty replay', async () => {
    const pty = stubPty();
    const { lifecycle } = buildDeps({
        spawn: pty, resumeSessionId: 's1', sessions: { s1: { hireId: 'h1', projectId: 'p1' } }
    });
    // A first session builds up scrollback, then is torn down.
    lifecycle.sendMessage('h1', 'hi');
    pty.emit('OLD SCROLLBACK');
    await lifecycle.teardown('h1');

    // A resume is a fresh process with a fresh buffer, so its replay is empty until
    // it produces its own output, consistent with the context-lost note.
    lifecycle.sendMessage('h1', 'continue');
    const seen: string[] = [];
    lifecycle.subscribe('h1', (d) => seen.push(d));
    assert.equal(seen.join(''), '', 'no stale scrollback carried across the resume');
});

// The real-process proof: a fixture spawned through node-pty, driven over a real
// socket, reaped by the drain with zero survivors.

function shortHome(): string {
    const base = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    return fs.mkdtempSync(path.join(base, 's-'));
}

async function isGone(pid: number, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try { process.kill(pid, 0); } catch { return true; }
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 50));
    }
}

function collectingSink(): { sink: DrainSink; rows: DrainReportEntry[] } {
    const rows: DrainReportEntry[] = [];
    return { sink: { append: (e) => { rows.push(e); } }, rows };
}

// @real-machine
test('a real spawned session drives state, and the drain reaps it with zero survivors', async () => {
    const home = shortHome();
    const transport = await startHookTransport({ platform: PLATFORM, home, appId: 'Life' + process.pid });
    const { store, sets, binds } = fakeStore({});
    const registry = new SessionRegistry(store);
    transport.listener.on('event', (raw: Record<string, unknown>) => {
        registry.ingest(coerceHookEvent(raw), new Date().toISOString());
    });

    const repoDir = shortHome();
    const lifecycle = new SessionLifecycle({
        platform: PLATFORM, socketPath: transport.socketPath, secrets: transport.secrets, registry,
        // The injected spawn ignores claudePath and launches the node fixture, so
        // the real process tree is exercised without a real Claude binary.
        claudePath: 'unused', nodeDir: path.dirname(process.execPath), parentEnv: process.env,
        spawn: (_file, _args, opts) => nodePty.spawn(process.execPath, [FIXTURE], opts),
        resolveTarget: () => ({ projectId: 'p1', cwd: repoDir }),
        setState: () => {},
        trustFor: () => 'trusted'
    });

    try {
        const pid = lifecycle.sendMessage('h1', 'do the thing');
        assert.ok(pid > 0, 'a real process was spawned');

        // Wait for the fixture to connect and drive the hire to working.
        const deadline = Date.now() + 8000;
        while (sets.at(-1)?.state !== 'working' && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(sets.at(-1)?.state, 'working', 'the attached hook drove the hire to working');
        assert.equal(binds.length, 1, 'the session id was recorded on the hire');
        assert.equal(registry.drainables().some((d) => d.pid === pid), true, 'the real pid is drainable');

        // The drain, reaching teardown the same way quit does.
        const { sink, rows } = collectingSink();
        const summary = await runDrain({
            agents: registry.drainables(), platform: PLATFORM, sink,
            drainId: 'd1', now: () => new Date().toISOString(),
            forceKill: (a) => lifecycle.teardown(a.agentId)
        });

        assert.equal(rows.length, 1, 'a drain_report row was written for the real session');
        assert.equal(rows[0]?.committed, false, 'honest: nothing committed, the git executor is not built');
        assert.ok(summary.total >= 1);
        assert.equal(await isGone(pid), true, 'the real process tree has zero survivors after the drain');
    } finally {
        await lifecycle.teardown('h1').catch(() => {});
        await stopHookTransport(transport).catch(() => {});
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(repoDir, { recursive: true, force: true });
    }
});
