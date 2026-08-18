/**
 * The saved-work notice logic: which committed rows become lines, and whether a drain
 * shows or has been dismissed. Pure, so no browser and no database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSavedWork, savedNoticeFor } from './saved-work.ts';
import type { DrainReportEntry } from '../../domain/models.ts';

function row(over: Partial<DrainReportEntry>): DrainReportEntry {
    return {
        drainId: 'd1', agentId: 'marion', outcome: 'committed', committed: true,
        branch: 'stafford/checkpoint/marion/S1', commitId: 'abc', reason: null, at: 'T1', ...over
    };
}

const nameOf = (hireId: string): string => (hireId === 'marion' ? 'Marion' : hireId === 'theo' ? 'Theo' : hireId);

test('buildSavedWork makes one line per committed row with a branch, name resolved', () => {
    const saves = buildSavedWork([
        row({ agentId: 'marion' }),
        row({ agentId: 'theo', branch: 'stafford/checkpoint/theo/S1' })
    ], nameOf);
    assert.deepEqual(saves, [
        { name: 'Marion', branch: 'stafford/checkpoint/marion/S1' },
        { name: 'Theo', branch: 'stafford/checkpoint/theo/S1' }
    ]);
});

test('buildSavedWork skips a row that did not commit or has no branch', () => {
    const saves = buildSavedWork([
        row({ agentId: 'marion' }),
        row({ agentId: 'x', committed: false, branch: null, outcome: 'checkpointed', reason: 'clean' }),
        row({ agentId: 'y', committed: true, branch: null })
    ], nameOf);
    assert.deepEqual(saves.map((s) => s.name), ['Marion'], 'only the real save is a line');
});

test('an unknown hire id falls back to the id rather than dropping the line', () => {
    const saves = buildSavedWork([row({ agentId: 'gone-hire' })], nameOf);
    assert.equal(saves[0]?.name, 'gone-hire');
});

test('savedNoticeFor shows a drain not yet seen', () => {
    const notice = savedNoticeFor([row({})], null, nameOf);
    assert.equal(notice?.drainId, 'd1');
    assert.equal(notice?.saves.length, 1);
});

test('savedNoticeFor does not reappear for a drain already dismissed', () => {
    assert.equal(savedNoticeFor([row({})], 'd1', nameOf), null, 'the seen drain is not shown again');
});

test('savedNoticeFor shows a newer drain even after an older one was dismissed', () => {
    const notice = savedNoticeFor([row({ drainId: 'd2' })], 'd1', nameOf);
    assert.equal(notice?.drainId, 'd2', 'a different drain still shows');
});

test('savedNoticeFor is null when nothing committed', () => {
    assert.equal(savedNoticeFor([], null, nameOf), null);
    // A row set that filters to no lines (committed but no branch) is also null.
    assert.equal(savedNoticeFor([row({ branch: null })], null, nameOf), null);
});
