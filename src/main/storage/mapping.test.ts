/**
 * The mapping in isolation: a domain object through `toRow` then `fromRow` is
 * the same object, and a row missing a field throws rather than returning a
 * half-populated one. These run without a database, because the mapping is the
 * part that is easy to get subtly wrong and worth testing on its own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    hireToRow, hireFromRow, projectToRow, projectFromRow, taskToRow, taskFromRow,
    policyLogToRow, policyLogFromRow, drainReportToRow, drainReportFromRow,
    channelMessageToRow, channelMessageFromRow, type Row
} from './mapping.ts';
import type {
    HiredAgent, Project, ProjectPolicy, Task, PolicyLogEntry, DrainReportEntry, ChannelMessage
} from '../../domain/models.ts';

const POLICY: ProjectPolicy = {
    push: 'feature-branches',
    allowedRoles: ['developer', 'code-reviewer'],
    toolCeiling: ['Read', 'Grep'],
    writePaths: null,
    requirePipeline: true,
    allowWebFetch: false,
    permissionMode: 'acceptEdits',
    maxConcurrentAgents: 3
};

const HIRE: HiredAgent = {
    id: 'h1', name: 'Marion', type: 'lead-developer', title: 'Lead developer', seniority: 2,
    ownerId: 'owner-1', sessions: { 'p1': 's1', 'p2': 's2' }, activeProjectId: 'p1',
    state: 'working', hiredAt: '2026-08-10T00:00:00Z', activeSince: '2026-08-10T00:00:00Z', firedAt: null
};

const PROJECT: Project = {
    id: 'p1', name: 'Stafford', repos: [{ path: '/repo', label: 'main' }], policy: POLICY
};

const TASK: Task = {
    id: 't1', agentId: 'h1', projectId: 'p1', text: 'do the thing', kind: 'feature',
    origin: { kind: 'agent', agentId: 'h2' },
    approvals: [{ agentId: 'h3', verdict: 'pending', note: null, at: null }],
    state: 'assigned', resultBranch: null, resultCommit: null,
    resultSummary: null, sessionId: null, failedReason: null, updatedAt: null,
        baselineTree: null, declaredOutputs: [], refusedOutputs: null,
        sendBacks: [], attempts: 0,
    createdAt: '2026-08-10T00:00:00Z', startedAt: null, completedAt: null
};

const LOG: PolicyLogEntry = {
    at: '2026-08-10T00:00:00Z', actor: 'Benzoo', projectId: 'p1',
    before: { push: 'none' }, after: { push: 'feature-branches' }
};

const DRAIN_COMMITTED: DrainReportEntry = {
    drainId: 'run-1', agentId: 'h1', outcome: 'committed', committed: true,
    branch: 'feat/x', commitId: 'abc123', reason: null, at: '2026-08-11T00:00:00Z'
};

const DRAIN_KILLED: DrainReportEntry = {
    drainId: 'run-1', agentId: 'h2', outcome: 'force-killed', committed: false,
    branch: null, commitId: null, reason: null, at: '2026-08-11T00:00:01Z'
};

test('a hire round-trips through the mapping unchanged', () => {
    assert.deepEqual(hireFromRow(hireToRow(HIRE)), HIRE);
});

const CHANNEL_MESSAGE: ChannelMessage = {
    id: 'm1', projectId: 'p1', senderId: 'Benzoo', targetHireId: 'h1', kind: 'message',
    body: 'ship the parser', reference: { kind: 'task', value: 't1' }, at: '2026-08-13T00:00:00Z', synthetic: false
};

const CHANNEL_EVENT: ChannelMessage = {
    id: 'e1', projectId: 'p1', senderId: 'h1', targetHireId: null, kind: 'event',
    body: 'waiting_for_you', reference: null, at: '2026-08-13T00:00:01Z', synthetic: false
};

test('a channel message round-trips with a typed reference', () => {
    assert.deepEqual(channelMessageFromRow(channelMessageToRow(CHANNEL_MESSAGE)), CHANNEL_MESSAGE);
});

test('a channel row with no reference round-trips with a null reference, both columns null', () => {
    const row = channelMessageToRow(CHANNEL_EVENT);
    assert.equal(row['ref_kind'], null);
    assert.equal(row['ref_value'], null);
    assert.deepEqual(channelMessageFromRow(row), CHANNEL_EVENT);
});

test('a channel row with a kind outside the set fails loudly', () => {
    const row: Row = { ...channelMessageToRow(CHANNEL_EVENT), kind: 'gossip' };
    assert.throws(() => channelMessageFromRow(row), /not one of/);
});

test('a drain report row round-trips, committed true with a branch and commit id', () => {
    assert.deepEqual(drainReportFromRow(drainReportToRow(DRAIN_COMMITTED)), DRAIN_COMMITTED);
});

test('a force-killed drain row round-trips, committed false with null branch and commit id', () => {
    const row = drainReportToRow(DRAIN_KILLED);
    assert.equal(row['committed'], 0, 'a false boolean stores as the integer 0');
    assert.deepEqual(drainReportFromRow(row), DRAIN_KILLED);
});

test('a drain row with a committed value that is not 0 or 1 fails loudly', () => {
    const row: Row = { ...drainReportToRow(DRAIN_COMMITTED), committed: 2 };
    assert.throws(() => drainReportFromRow(row), /not the 0 or 1/);
});

test('a drain row with an outcome outside the set fails loudly', () => {
    const row: Row = { ...drainReportToRow(DRAIN_COMMITTED), outcome: 'exploded' };
    assert.throws(() => drainReportFromRow(row), /not one of/);
});

test('a project round-trips, and its policy is identical', () => {
    assert.deepEqual(projectFromRow(projectToRow(PROJECT)), PROJECT);
});

test('a task round-trips, origin and approvals included', () => {
    assert.deepEqual(taskFromRow(taskToRow(TASK)), TASK);
});

test('a policy log entry round-trips', () => {
    assert.deepEqual(policyLogFromRow(policyLogToRow(LOG)), LOG);
});

test('ProjectPolicy round-trips with no sandbox key before or after', () => {
    assert.equal('sandbox' in POLICY, false);
    const back = projectFromRow(projectToRow(PROJECT)).policy;
    assert.equal('sandbox' in back, false);
    assert.deepEqual(back, POLICY);
});

test('a policy that arrives carrying a sandbox field is rejected, not stored through', () => {
    const row: Row = { id: 'p1', name: 'x', repos: '[]', policy: JSON.stringify({ ...POLICY, sandbox: true }) };
    assert.throws(() => projectFromRow(row), /sandbox/);
});

test('a hire row missing a field fails loudly rather than returning a half-object', () => {
    const full = hireToRow(HIRE);
    const withoutName: Row = { ...full };
    delete withoutName['name'];
    assert.throws(() => hireFromRow(withoutName), /column name expected string/);
});

test('a hire row with a null in a non-nullable field fails loudly', () => {
    const row: Row = { ...hireToRow(HIRE), seniority: null };
    assert.throws(() => hireFromRow(row), /column seniority expected integer/);
});

test('a task with an unknown kind fails loudly', () => {
    const row: Row = { ...taskToRow(TASK), kind: 'nonsense' };
    assert.throws(() => taskFromRow(row), /not one of/);
});

test('a hire with an unknown state fails loudly', () => {
    const row: Row = { ...hireToRow(HIRE), state: 'melted' };
    assert.throws(() => hireFromRow(row), /not a known AgentState/);
});
