import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHandlers } from './handlers.ts';
import { INVOKE_CHANNELS, type HealthReport } from '../../shared/ipc.ts';
import type { ProofPty } from './proof-pty.ts';

function fakeProof(open = false): ProofPty {
    return {
        isOpen: () => open,
        spawn: () => {},
        write: () => {},
        kill: () => {}
    } as unknown as ProofPty;
}

function deps(proof = fakeProof()) {
    return {
        startedAt: '2026-08-08T00:00:00.000Z',
        platformId: 'darwin',
        proof,
        sender: () => null
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
