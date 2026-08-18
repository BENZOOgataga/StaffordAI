/**
 * The repositories against a real migrated database in a temp directory. Insert,
 * read back deep-equal, update where mutable, pagination on the growing tables,
 * and the append-only guarantee held both by the absent method and the trigger.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from './database.ts';
import { createRepositories, type Repositories } from './repository.ts';
import type { HiredAgent, Project, ProjectPolicy, Task, PolicyLogEntry, ChannelMessage, ActivityRecord } from '../../domain/models.ts';

function withRepos(fn: (repos: Repositories, raw: { exec(sql: string): unknown }) => void): void {
    const appDataDir = mkdtempSync(path.join(tmpdir(), 'stafford-repo-'));
    const open = openDatabase({ appDataDir });
    try {
        fn(createRepositories(open.db), open.db);
    } finally {
        open.db.close();
        rmSync(appDataDir, { recursive: true, force: true });
    }
}

const POLICY: ProjectPolicy = {
    push: 'feature-branches', allowedRoles: ['developer'], toolCeiling: ['Read'], writePaths: null,
    requirePipeline: true, allowWebFetch: false, permissionMode: 'acceptEdits', maxConcurrentAgents: 3
};

function hire(id: string, at: string): HiredAgent {
    return {
        id, name: 'Marion', type: 'lead-developer', title: 'Lead developer', seniority: 2,
        ownerId: 'owner-1', sessions: { p1: 's1' }, activeProjectId: 'p1', state: 'working',
        hiredAt: at, firedAt: null
    };
}

function task(id: string, at: string, projectId = 'p1'): Task {
    return {
        id, agentId: 'h1', projectId, text: 't', kind: 'feature', origin: { kind: 'user' },
        approvals: [], createdAt: at, startedAt: null, completedAt: null
    };
}

test('a hire inserts, reads back deep-equal, and updates', () => {
    withRepos((repos) => {
        const h = hire('h1', '2026-08-10T00:00:00Z');
        repos.hires.insert(h);
        assert.deepEqual(repos.hires.get('h1'), h);
        const moved: HiredAgent = { ...h, state: 'idle', activeProjectId: null };
        repos.hires.update(moved);
        assert.deepEqual(repos.hires.get('h1'), moved);
    });
});

test('get returns null for an id that is not there', () => {
    withRepos((repos) => { assert.equal(repos.hires.get('nope'), null); });
});

test('a project inserts and reads back with its policy identical and no sandbox key', () => {
    withRepos((repos) => {
        const p: Project = { id: 'p1', name: 'Stafford', repos: [{ path: '/r', label: 'main' }], policy: POLICY };
        repos.projects.insert(p);
        const back = repos.projects.get('p1');
        assert.deepEqual(back, p);
        assert.equal('sandbox' in (back as Project).policy, false);
    });
});

test('a task inserts, reads back deep-equal, and updates', () => {
    withRepos((repos) => {
        const t = task('t1', '2026-08-10T00:00:00Z');
        repos.tasks.insert(t);
        assert.deepEqual(repos.tasks.get('t1'), t);
        const done: Task = { ...t, completedAt: '2026-08-10T01:00:00Z' };
        repos.tasks.update(done);
        assert.deepEqual(repos.tasks.get('t1'), done);
    });
});

test('task pages return the requested slice and cap at the limit', () => {
    withRepos((repos) => {
        for (let i = 1; i <= 5; i += 1) repos.tasks.insert(task('t' + i, '2026-08-10T00:00:0' + i + 'Z'));
        const first = repos.tasks.page({ limit: 2, offset: 0 });
        const second = repos.tasks.page({ limit: 2, offset: 2 });
        assert.equal(first.length, 2, 'the limit is applied, not the whole table returned');
        assert.deepEqual(first.map((t) => t.id), ['t1', 't2']);
        assert.deepEqual(second.map((t) => t.id), ['t3', 't4']);
    });
});

test('tasks page by project filters and paginates', () => {
    withRepos((repos) => {
        repos.tasks.insert(task('a1', '2026-08-10T00:00:01Z', 'p1'));
        repos.tasks.insert(task('b1', '2026-08-10T00:00:02Z', 'p2'));
        repos.tasks.insert(task('a2', '2026-08-10T00:00:03Z', 'p1'));
        const p1 = repos.tasks.pageByProject('p1', { limit: 10, offset: 0 });
        assert.deepEqual(p1.map((t) => t.id), ['a1', 'a2']);
    });
});

test('the policy log appends and reads back paginated', () => {
    withRepos((repos) => {
        const e1: PolicyLogEntry = { at: 't1', actor: 'Benzoo', projectId: 'p1', before: { push: 'none' }, after: { push: 'feature-branches' } };
        const e2: PolicyLogEntry = { at: 't2', actor: 'Benzoo', projectId: 'p1', before: { push: 'feature-branches' }, after: { push: 'including-main' } };
        repos.policyLog.append(e1);
        repos.policyLog.append(e2);
        assert.deepEqual(repos.policyLog.page({ limit: 10, offset: 0 }), [e1, e2]);
        assert.deepEqual(repos.policyLog.page({ limit: 1, offset: 1 }), [e2]);
    });
});

test('the policy log repository offers no update or delete method', () => {
    withRepos((repos) => {
        const log = repos.policyLog as unknown as Record<string, unknown>;
        assert.equal(typeof log['update'], 'undefined');
        assert.equal(typeof log['delete'], 'undefined');
        assert.equal(typeof log['remove'], 'undefined');
    });
});

test('the policy log refuses update and delete at the database even by raw statement', () => {
    withRepos((repos, raw) => {
        repos.policyLog.append({ at: 't', actor: 'Benzoo', projectId: 'p', before: {}, after: {} });
        assert.throws(() => raw.exec("UPDATE policy_log SET actor='someone'"), /append-only/);
        assert.throws(() => raw.exec('DELETE FROM policy_log'), /append-only/);
    });
});

function channelMessage(id: string, at: string, over: Partial<ChannelMessage> = {}): ChannelMessage {
    return { id, projectId: 'p1', senderId: 'Benzoo', kind: 'message', body: 'hi', reference: null, at, ...over };
}

test('the channel appends and reads a page of messages and events interleaved in time order', () => {
    withRepos((repos) => {
        // Inserted out of order; the read returns them by time.
        repos.channel.append(channelMessage('c', '2026-08-13T00:00:02Z', { body: 'later' }));
        repos.channel.append(channelMessage('a', '2026-08-13T00:00:00Z', { kind: 'event', body: 'waiting_for_you' }));
        repos.channel.append(channelMessage('b', '2026-08-13T00:00:01Z', { reference: { kind: 'commit', value: 'abc123' } }));

        const page = repos.channel.page({ limit: 10, offset: 0 });
        assert.deepEqual(page.map((m) => m.id), ['a', 'b', 'c'], 'ordered by time, messages and events interleaved');
        assert.equal(page[0]?.kind, 'event');
        assert.deepEqual(page[1]?.reference, { kind: 'commit', value: 'abc123' });
    });
});

test('the channel read is paginated: limit and offset, and there is no read-everything method', () => {
    withRepos((repos) => {
        repos.channel.append(channelMessage('a', '2026-08-13T00:00:00Z'));
        repos.channel.append(channelMessage('b', '2026-08-13T00:00:01Z'));
        repos.channel.append(channelMessage('c', '2026-08-13T00:00:02Z'));

        assert.deepEqual(repos.channel.page({ limit: 2, offset: 0 }).map((m) => m.id), ['a', 'b']);
        assert.deepEqual(repos.channel.page({ limit: 2, offset: 2 }).map((m) => m.id), ['c']);

        const channel = repos.channel as unknown as Record<string, unknown>;
        assert.equal(typeof channel['all'], 'undefined', 'no read-everything on an unbounded timeline');
    });
});

test('the channel newest, before and after cursor reads page the timeline in time order', () => {
    withRepos((repos) => {
        for (let i = 0; i < 5; i++) {
            repos.channel.append(channelMessage('m' + i, '2026-08-13T00:00:0' + i + 'Z'));
        }
        // newest: the tail, oldest-first.
        const newest = repos.channel.newest(2);
        assert.deepEqual(newest.map((m) => m.id), ['m3', 'm4'], 'the newest page, in ascending order');

        // before the oldest of that page: the older rows, oldest-first.
        const older = repos.channel.before({ at: newest[0]!.at, id: newest[0]!.id }, 2);
        assert.deepEqual(older.map((m) => m.id), ['m1', 'm2'], 'the page just before the cursor');

        // after the newest: nothing yet, then a fresh row appears.
        assert.deepEqual(repos.channel.after({ at: newest[1]!.at, id: newest[1]!.id }, 10), [], 'no rows after the tail');
        repos.channel.append(channelMessage('m5', '2026-08-13T00:00:05Z'));
        assert.deepEqual(
            repos.channel.after({ at: newest[1]!.at, id: newest[1]!.id }, 10).map((m) => m.id), ['m5'],
            'only the new tail row, not the whole timeline'
        );
    });
});

test('the channel offers no update or delete, and a raw one raises at the trigger', () => {
    withRepos((repos, raw) => {
        repos.channel.append(channelMessage('a', '2026-08-13T00:00:00Z'));
        const channel = repos.channel as unknown as Record<string, unknown>;
        assert.equal(typeof channel['update'], 'undefined');
        assert.equal(typeof channel['delete'], 'undefined');
        assert.throws(() => raw.exec("UPDATE channel_messages SET body='changed'"), /append-only/);
        assert.throws(() => raw.exec('DELETE FROM channel_messages'), /append-only/);
    });
});

function activity(id: string, hireId: string, tool: string, status: 'ok' | 'error' | 'incomplete', at: string): ActivityRecord {
    return { id, hireId, sessionId: 's1', tool, target: tool === 'Bash' ? 'git status' : 'f.ts', status, at };
}

test('activity appends coalesced rows and reads them back per hire, oldest-first', () => {
    withRepos((repos) => {
        repos.activity.append(activity('a3', 'marion', 'Bash', 'ok', '2026-08-18T12:02:00Z'));
        repos.activity.append(activity('a1', 'marion', 'Edit', 'ok', '2026-08-18T12:00:00Z'));
        repos.activity.append(activity('a2', 'marion', 'Write', 'error', '2026-08-18T12:01:00Z'));
        const rows = repos.activity.byHire('marion', 50);
        assert.deepEqual(rows.map((r) => [r.id, r.tool, r.status]),
            [['a1', 'Edit', 'ok'], ['a2', 'Write', 'error'], ['a3', 'Bash', 'ok']]);
    });
});

test('activity byHire is scoped to one colleague, not the whole team', () => {
    withRepos((repos) => {
        repos.activity.append(activity('a1', 'marion', 'Edit', 'ok', '2026-08-18T12:00:00Z'));
        repos.activity.append(activity('b1', 'theo', 'Edit', 'ok', '2026-08-18T12:00:00Z'));
        assert.deepEqual(repos.activity.byHire('marion', 50).map((r) => r.id), ['a1']);
        assert.deepEqual(repos.activity.byHire('theo', 50).map((r) => r.id), ['b1']);
    });
});

test('an incomplete action round-trips with its status', () => {
    withRepos((repos) => {
        repos.activity.append(activity('a1', 'marion', 'Edit', 'incomplete', '2026-08-18T12:00:00Z'));
        assert.equal(repos.activity.byHire('marion', 50)[0]?.status, 'incomplete');
    });
});

test('isolation: writing activity touches only activity_events, not the state tables', () => {
    withRepos((repos, raw) => {
        // A hire in a known state, the state feed's data.
        repos.hires.insert(hire('marion', '2026-08-18T11:00:00Z'));
        const before = repos.hires.get('marion');
        // Writing activity for that hire must not change the hire row or write a
        // channel/state row: the activity store is separate from the state path.
        repos.activity.append(activity('a1', 'marion', 'Edit', 'ok', '2026-08-18T12:00:00Z'));
        const after = repos.hires.get('marion');
        assert.deepEqual(after, before, 'the hire state row is untouched by an activity write');
        const channelCount = (raw as unknown as { prepare(s: string): { get(): { n: number } } })
            .prepare('SELECT count(*) AS n FROM channel_messages').get().n;
        assert.equal(channelCount, 0, 'no state-transition row was written by an activity write');
        assert.equal(repos.activity.byHire('marion', 50).length, 1, 'the activity landed in its own table');
    });
});
