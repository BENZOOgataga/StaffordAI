/**
 * The coalescer batches a burst into one flush, and stops when disposed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { OutputCoalescer } from './output-coalescer.ts';

/** A hand-driven scheduler: it records the flush so a test fires it deliberately. */
function manualSchedule(): { schedule: (flush: () => void) => void; run: () => void; scheduled: () => number } {
    let pending: (() => void) | null = null;
    let count = 0;
    return {
        schedule: (flush) => { pending = flush; count += 1; },
        run: () => { const f = pending; pending = null; f?.(); },
        scheduled: () => count
    };
}

test('a burst of pushes flushes as one message, not one per push', () => {
    const sent: string[] = [];
    const sch = manualSchedule();
    const c = new OutputCoalescer({ sink: (d) => sent.push(d), schedule: sch.schedule });

    c.push('a'); c.push('b'); c.push('c');
    assert.equal(sch.scheduled(), 1, 'a burst arms one flush, not three');
    sch.run();
    assert.deepEqual(sent, ['abc'], 'one message carrying the whole burst');
});

test('a flush with nothing queued sends nothing', () => {
    const sent: string[] = [];
    const sch = manualSchedule();
    const c = new OutputCoalescer({ sink: (d) => sent.push(d), schedule: sch.schedule });
    c.flush();
    assert.deepEqual(sent, [], 'nothing queued, nothing sent');
});

test('after a flush a new burst arms a new flush', () => {
    const sent: string[] = [];
    const sch = manualSchedule();
    const c = new OutputCoalescer({ sink: (d) => sent.push(d), schedule: sch.schedule });
    c.push('x'); sch.run();
    c.push('y'); sch.run();
    assert.deepEqual(sent, ['x', 'y']);
});

test('a disposed coalescer drops queued output and refuses more', () => {
    const sent: string[] = [];
    const sch = manualSchedule();
    const c = new OutputCoalescer({ sink: (d) => sent.push(d), schedule: sch.schedule });
    c.push('a');
    c.dispose();
    sch.run();            // a flush scheduled before dispose does nothing
    c.push('b');          // and further pushes are refused
    sch.run();
    assert.deepEqual(sent, [], 'a disposed coalescer streams nothing');
});
