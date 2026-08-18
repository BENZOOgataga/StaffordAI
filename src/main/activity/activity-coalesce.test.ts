/**
 * The coalescer: it pairs a use with its result into one action, resolves an
 * interrupted use to a terminal incomplete row, and holds the one selective cut of
 * which tools are stored.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityCoalescer, shouldPersist, PERSISTED_TOOLS } from './activity-coalesce.ts';
import type { TaggedActivityEvent } from './transcript-manager.ts';

function use(toolUseId: string, tool: string, target: string | null, agentId = 'marion', at = 'T1'): TaggedActivityEvent {
    return { phase: 'use', tool, target, toolUseId, status: null, agentId, sessionId: 's1', at };
}
function result(toolUseId: string, status: 'ok' | 'error', agentId = 'marion', at = 'T2'): TaggedActivityEvent {
    return { phase: 'result', tool: null, target: null, toolUseId, status, agentId, sessionId: 's1', at };
}

test('a use and its result coalesce into one action carrying the outcome and the use time', () => {
    const c = new ActivityCoalescer();
    const out = c.ingest([use('t1', 'Edit', 'f.ts', 'marion', 'T1'), result('t1', 'ok', 'marion', 'T2')]);
    assert.deepEqual(out, [{ agentId: 'marion', sessionId: 's1', toolUseId: 't1', tool: 'Edit', target: 'f.ts', status: 'ok', at: 'T1' }]);
    assert.equal(c.pendingCount, 0);
});

test('an error result coalesces to an error status', () => {
    const c = new ActivityCoalescer();
    const [action] = c.ingest([use('t1', 'Bash', 'npm test'), result('t1', 'error')]);
    assert.equal(action?.status, 'error');
});

test('a use and its result across two separate batches still pair', () => {
    const c = new ActivityCoalescer();
    assert.deepEqual(c.ingest([use('t1', 'Write', 'a.ts')]), [], 'the lone use produces nothing yet');
    assert.equal(c.pendingCount, 1);
    const out = c.ingest([result('t1', 'ok')]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.tool, 'Write');
});

test('an orphan result with no held use produces nothing', () => {
    const c = new ActivityCoalescer();
    assert.deepEqual(c.ingest([result('never-seen', 'ok')]), []);
});

test('interleaved uses pair with their own results by toolUseId', () => {
    const c = new ActivityCoalescer();
    const out = c.ingest([
        use('t1', 'Edit', 'a.ts'), use('t2', 'Bash', 'ls'),
        result('t2', 'ok'), result('t1', 'error')
    ]);
    assert.deepEqual(out.map((a) => [a.toolUseId, a.tool, a.status]), [['t2', 'Bash', 'ok'], ['t1', 'Edit', 'error']]);
});

test('flush resolves an interrupted use to a terminal incomplete action', () => {
    const c = new ActivityCoalescer();
    c.ingest([use('t1', 'Edit', 'big.ts', 'marion', 'T1')]);
    const flushed = c.flush('marion');
    assert.deepEqual(flushed, [{ agentId: 'marion', sessionId: 's1', toolUseId: 't1', tool: 'Edit', target: 'big.ts', status: 'incomplete', at: 'T1' }]);
    assert.equal(c.pendingCount, 0, 'the pending use is cleared after flush');
});

test('flush only touches the named agent, leaving another agent pending', () => {
    const c = new ActivityCoalescer();
    c.ingest([use('t1', 'Edit', 'a.ts', 'marion'), use('t2', 'Edit', 'b.ts', 'theo')]);
    const flushed = c.flush('marion');
    assert.deepEqual(flushed.map((a) => a.agentId), ['marion']);
    assert.equal(c.pendingCount, 1, "theo's use is still pending");
});

test('a paired use is not flushed later', () => {
    const c = new ActivityCoalescer();
    c.ingest([use('t1', 'Edit', 'a.ts'), result('t1', 'ok')]);
    assert.deepEqual(c.flush('marion'), [], 'nothing pending, so flush yields nothing');
});

test('the selective cut: writes, commands, and dispatch persist; reads and searches do not', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Task']) {
        assert.equal(shouldPersist(tool), true, tool + ' persists');
    }
    for (const tool of ['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'Skill']) {
        assert.equal(shouldPersist(tool), false, tool + ' is live-only');
    }
    assert.equal(shouldPersist('SomeNewMcpTool'), false, 'an unknown tool is not stored by default');
    assert.ok(PERSISTED_TOOLS.has('Edit') && !PERSISTED_TOOLS.has('Read'));
});
