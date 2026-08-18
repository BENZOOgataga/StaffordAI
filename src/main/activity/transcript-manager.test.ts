/**
 * The manager: it starts one tailer per colleague off the transcript path the hooks
 * carry, tags events with the agent and session, and stops on SessionEnd or quit. A
 * fake tailer stands in for the file work, so this tests the wiring, not the tail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptManager, coerceObservation, type Tailer, type TaggedActivityEvent } from './transcript-manager.ts';
import type { ActivityEvent } from './transcript-parse.ts';

class FakeTailer implements Tailer {
    started = false;
    stopped = false;
    readonly path: string;
    readonly emit: (events: readonly ActivityEvent[]) => void;
    constructor(path: string, emit: (events: readonly ActivityEvent[]) => void) {
        this.path = path;
        this.emit = emit;
    }
    start(): void { this.started = true; }
    stop(): void { this.stopped = true; }
    fire(events: ActivityEvent[]): void { this.emit(events); }
}

function harness() {
    const tailers: FakeTailer[] = [];
    const emitted: TaggedActivityEvent[] = [];
    let clock = 0;
    const mgr = new TranscriptManager({
        makeTailer: (path, onEvents) => { const t = new FakeTailer(path, onEvents); tailers.push(t); return t; },
        onEvents: (events) => emitted.push(...events),
        now: () => 'T' + (clock++)
    });
    return { mgr, tailers, emitted };
}

const useEvent: ActivityEvent = { phase: 'use', tool: 'Read', target: 'a.ts', toolUseId: 't1', status: null };

test('a record with a transcript path and an agent starts one tailer', () => {
    const { mgr, tailers } = harness();
    mgr.observe({ event: 'SessionStart', agentId: 'marion', sessionId: 's1', transcriptPath: 'C:\\t.jsonl' });
    assert.equal(tailers.length, 1);
    assert.equal(tailers[0]?.started, true);
    assert.equal(tailers[0]?.path, 'C:\\t.jsonl');
    assert.equal(mgr.activeCount, 1);
});

test('later events for the same agent do not start a second tailer', () => {
    const { mgr, tailers } = harness();
    mgr.observe({ event: 'SessionStart', agentId: 'marion', sessionId: 's1', transcriptPath: 'C:\\t.jsonl' });
    mgr.observe({ event: 'UserPromptSubmit', agentId: 'marion', sessionId: 's1', transcriptPath: 'C:\\t.jsonl' });
    assert.equal(tailers.length, 1, 'one tailer per colleague, bound by agent id');
});

test('emitted events are tagged with the agent, session, and a timestamp', () => {
    const { mgr, tailers, emitted } = harness();
    mgr.observe({ event: 'SessionStart', agentId: 'theo', sessionId: 's9', transcriptPath: 'C:\\t.jsonl' });
    const [t0] = tailers;
    assert.ok(t0, 'a tailer started');
    t0.fire([useEvent]);
    assert.deepEqual(emitted, [{ ...useEvent, agentId: 'theo', sessionId: 's9', at: 'T0' }]);
});

test('two colleagues get two independent tailers', () => {
    const { mgr, tailers } = harness();
    mgr.observe({ event: 'SessionStart', agentId: 'marion', sessionId: 's1', transcriptPath: 'C:\\m.jsonl' });
    mgr.observe({ event: 'SessionStart', agentId: 'theo', sessionId: 's2', transcriptPath: 'C:\\t.jsonl' });
    assert.equal(tailers.length, 2);
    assert.equal(mgr.activeCount, 2);
});

test('SessionEnd stops and drops that agent tailer, leaving others', () => {
    const { mgr, tailers } = harness();
    mgr.observe({ event: 'SessionStart', agentId: 'marion', sessionId: 's1', transcriptPath: 'C:\\m.jsonl' });
    mgr.observe({ event: 'SessionStart', agentId: 'theo', sessionId: 's2', transcriptPath: 'C:\\t.jsonl' });
    mgr.observe({ event: 'SessionEnd', agentId: 'marion', sessionId: 's1', transcriptPath: null });
    assert.equal(tailers[0]?.stopped, true);
    assert.equal(tailers[1]?.stopped, false);
    assert.equal(mgr.activeCount, 1);
});

test('a record with no transcript path or no agent starts nothing', () => {
    const { mgr, tailers } = harness();
    mgr.observe({ event: 'SessionStart', agentId: 'marion', sessionId: 's1', transcriptPath: null });
    mgr.observe({ event: 'SessionStart', agentId: null, sessionId: 's1', transcriptPath: 'C:\\t.jsonl' });
    assert.equal(tailers.length, 0);
});

test('stopAll stops every tailer', () => {
    const { mgr, tailers } = harness();
    mgr.observe({ event: 'SessionStart', agentId: 'a', sessionId: 's1', transcriptPath: 'C:\\a.jsonl' });
    mgr.observe({ event: 'SessionStart', agentId: 'b', sessionId: 's2', transcriptPath: 'C:\\b.jsonl' });
    mgr.stopAll();
    assert.ok(tailers.every((t) => t.stopped));
    assert.equal(mgr.activeCount, 0);
});

test('coerceObservation reads the four fields and tolerates missing ones', () => {
    assert.deepEqual(
        coerceObservation({ event: 'SessionStart', agentId: 'm', sessionId: 's', transcriptPath: 'p', secret: 'x', toolName: 'Read' }),
        { event: 'SessionStart', agentId: 'm', sessionId: 's', transcriptPath: 'p' }
    );
    assert.deepEqual(
        coerceObservation({ event: 'Stop' }),
        { event: 'Stop', agentId: null, sessionId: null, transcriptPath: null }
    );
});
