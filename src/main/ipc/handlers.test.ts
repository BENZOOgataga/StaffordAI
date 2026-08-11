import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHandlers } from './handlers.ts';
import { INVOKE_CHANNELS, type HealthReport, type ProjectsList, type RosterSnapshot } from '../../shared/ipc.ts';
import type { ProofPty } from './proof-pty.ts';

function fakeProof(open = false): ProofPty {
    return {
        isOpen: () => open,
        spawn: () => {},
        write: () => {},
        kill: () => {}
    } as unknown as ProofPty;
}

function deps(
    proof = fakeProof(),
    projects: ProjectsList = { projects: [] },
    roster: RosterSnapshot = { cards: [] }
) {
    return {
        startedAt: '2026-08-08T00:00:00.000Z',
        platformId: 'darwin',
        proof,
        sender: () => null,
        listProjects: () => projects,
        rosterSnapshot: () => roster
    };
}

test('there is exactly one handler per invoke channel, no more and no fewer', () => {
    const handlers = buildHandlers(deps());
    const keys = Object.keys(handlers).sort();
    assert.deepEqual(keys, [...INVOKE_CHANNELS].sort(),
        'the handler map and the channel allowlist must match exactly');
});

test('health reports the platform and whether a pty is open', () => {
    const handlers = buildHandlers(deps(fakeProof(true)));
    const report = handlers.health(undefined) as HealthReport;
    assert.equal(report.ok, true);
    assert.equal(report.platform, 'darwin');
    assert.equal(report.ptyOpen, true);
});

test('projects:list returns the summaries and takes no payload', () => {
    const rows: ProjectsList = { projects: [{ id: 'p1', name: 'Stafford' }, { id: 'p2', name: 'other' }] };
    const handlers = buildHandlers(deps(fakeProof(), rows));
    const result = handlers['projects:list'](undefined) as ProjectsList;
    assert.deepEqual(result, rows);
});

test('roster:snapshot returns the cards and takes no payload', () => {
    const cards: RosterSnapshot = {
        cards: [{
            id: 'h1', name: 'Marion', role: 'Lead developer', state: 'waiting_for_you',
            project: 'Stafford', task: null, apprentices: 0, queued: 0, since: null, contextLost: false
        }]
    };
    const handlers = buildHandlers(deps(fakeProof(), { projects: [] }, cards));
    const result = handlers['roster:snapshot'](undefined) as RosterSnapshot;
    assert.deepEqual(result, cards);
});

test('proof:spawn refuses arguments that fail the guard', () => {
    const handlers = buildHandlers(deps());
    assert.throws(() => handlers['proof:spawn']({ cols: 0, rows: 0 }), /requires/);
    assert.throws(() => handlers['proof:spawn'](null), /requires/);
});

test('proof:write refuses a non-string payload', () => {
    const handlers = buildHandlers(deps());
    assert.throws(() => handlers['proof:write']({ data: 123 }), /requires/);
});

test('proof:spawn passes a valid size to the pty', () => {
    let spawned: unknown = null;
    const proof = { ...fakeProof(), spawn: (size: unknown) => { spawned = size; } } as unknown as ProofPty;
    const handlers = buildHandlers(deps(proof));
    const result = handlers['proof:spawn']({ cols: 80, rows: 24 });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(spawned, { cols: 80, rows: 24 });
});
