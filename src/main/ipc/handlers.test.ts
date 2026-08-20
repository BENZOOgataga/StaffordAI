import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHandlers } from './handlers.ts';
import {
    INVOKE_CHANNELS, type HealthReport, type ProjectsList, type RosterSnapshot,
    type ChannelCursor, type ChannelMessageRow, type ChannelPageReply,
    type ProjectCreated, type HireCreated, type ActivityRow, type SavedCheckpoints
} from '../../shared/ipc.ts';

interface SessionOverrides {
    sender?: () => { send: (channel: string, data: string) => void } | null;
    channelPage?: (before: ChannelCursor | null, limit: number) => readonly ChannelMessageRow[];
    channelSince?: (after: ChannelCursor, limit: number) => readonly ChannelMessageRow[];
    channelConversation?: (hireId: string, limit: number) => readonly ChannelMessageRow[];
    activityByHire?: (hireId: string, limit: number) => readonly ActivityRow[];
    savedCheckpoints?: () => SavedCheckpoints | null;
    ackCheckpoints?: (drainId: string) => void;
    channelReply?: (hireId: string, text: string) => Promise<void>;
    createProject?: (payload: { name: string; repoPaths: readonly string[] }) => ProjectCreated;
    createHire?: (payload: { name: string; type: string; title: string; projectId: string }) => HireCreated;
}

function deps(
    projects: ProjectsList = { projects: [] },
    roster: RosterSnapshot = { cards: [] },
    over: SessionOverrides = {}
) {
    return {
        startedAt: '2026-08-08T00:00:00.000Z',
        platformId: 'darwin',
        sender: (over.sender ?? (() => null)) as unknown as HandlerDepsSender,
        listProjects: () => projects,
        createProject: over.createProject
            ?? ((payload) => ({ id: 'proj-new', name: payload.name })),
        createHire: over.createHire
            ?? ((payload) => ({ id: 'hire-new', name: payload.name, title: payload.title, projectId: payload.projectId })),
        rosterSnapshot: () => roster,
        channelPage: over.channelPage ?? (() => []),
        channelSince: over.channelSince ?? (() => []),
        channelConversation: over.channelConversation ?? (() => []),
        activityByHire: over.activityByHire ?? (() => []),
        savedCheckpoints: over.savedCheckpoints ?? (() => null),
        ackCheckpoints: over.ackCheckpoints ?? (() => { /* noop */ }),
        channelReply: over.channelReply ?? (() => Promise.resolve())
    };
}

// The real sender returns a WebContents; the tests only ever call .send, so a
// narrow fake stands in and the deps builder casts to the handler's type.
type HandlerDepsSender = Parameters<typeof buildHandlers>[0]['sender'];

test('there is exactly one handler per invoke channel, no more and no fewer', () => {
    const handlers = buildHandlers(deps());
    const keys = Object.keys(handlers).sort();
    assert.deepEqual(keys, [...INVOKE_CHANNELS].sort(),
        'the handler map and the channel allowlist must match exactly');
});

test('health reports the platform', () => {
    const handlers = buildHandlers(deps());
    const report = handlers.health(undefined) as HealthReport;
    assert.equal(report.ok, true);
    assert.equal(report.platform, 'darwin');
});

test('projects:list returns the summaries and takes no payload', () => {
    const rows: ProjectsList = { projects: [{ id: 'p1', name: 'Stafford' }, { id: 'p2', name: 'other' }] };
    const handlers = buildHandlers(deps(rows));
    const result = handlers['projects:list'](undefined) as ProjectsList;
    assert.deepEqual(result, rows);
});

test('project:create is guarded and routes a valid payload to createProject', () => {
    let seen: { name: string; repoPaths: readonly string[] } | null = null;
    const handlers = buildHandlers(deps({ projects: [] }, { cards: [] }, {
        createProject: (payload) => { seen = payload; return { id: 'p9', name: payload.name }; }
    }));
    const result = handlers['project:create']({ name: 'Stafford', repoPaths: ['C:/repo'] }) as ProjectCreated;
    assert.deepEqual(result, { id: 'p9', name: 'Stafford' });
    assert.deepEqual(seen, { name: 'Stafford', repoPaths: ['C:/repo'] });
});

test('project:create refuses a malformed payload before reaching createProject', () => {
    let called = false;
    const handlers = buildHandlers(deps({ projects: [] }, { cards: [] }, {
        createProject: () => { called = true; return { id: 'x', name: 'x' }; }
    }));
    assert.throws(() => handlers['project:create']({ name: '', repoPaths: [] }), /project:create requires/);
    assert.throws(() => handlers['project:create']({ name: 'ok' }), /project:create requires/);
    assert.equal(called, false, 'a malformed payload never reaches the create logic');
});

test('hire:create is guarded and routes a valid payload to createHire', () => {
    let seen: unknown = null;
    const handlers = buildHandlers(deps({ projects: [] }, { cards: [] }, {
        createHire: (payload) => { seen = payload; return { id: 'h9', name: payload.name, title: payload.title, projectId: payload.projectId }; }
    }));
    const result = handlers['hire:create'](
        { name: 'Marion', type: 'lead-developer', title: 'Lead developer', projectId: 'p1' }
    ) as HireCreated;
    assert.deepEqual(result, { id: 'h9', name: 'Marion', title: 'Lead developer', projectId: 'p1' });
    assert.deepEqual(seen, { name: 'Marion', type: 'lead-developer', title: 'Lead developer', projectId: 'p1' });
});

test('hire:create refuses a malformed payload before reaching createHire', () => {
    let called = false;
    const handlers = buildHandlers(deps({ projects: [] }, { cards: [] }, {
        createHire: () => { called = true; return { id: 'x', name: 'x', title: 'x', projectId: 'x' }; }
    }));
    assert.throws(() => handlers['hire:create']({ name: 'Marion', type: 'lead-developer' }), /hire:create requires/);
    assert.equal(called, false, 'a malformed payload never reaches the create logic');
});

test('roster:snapshot returns the cards and takes no payload', () => {
    const cards: RosterSnapshot = {
        cards: [{
            id: 'h1', name: 'Marion', role: 'Lead developer', state: 'waiting_for_you',
            project: 'Stafford', task: null, apprentices: 0, queued: 0, since: null, contextLost: false
        }]
    };
    const handlers = buildHandlers(deps({ projects: [] }, cards));
    const result = handlers['roster:snapshot'](undefined) as RosterSnapshot;
    assert.deepEqual(result, cards);
});

function chRow(id: string): ChannelMessageRow {
    return { id, projectId: 'p1', senderId: 'h1', kind: 'event', body: 'waiting_for_you', reference: null, at: 't' };
}

test('channel:page returns rows and passes the cursor and limit through', () => {
    const calls: Array<{ before: ChannelCursor | null; limit: number }> = [];
    const handlers = buildHandlers(deps({ projects: [] }, { cards: [] }, {
        channelPage: (before, limit) => { calls.push({ before, limit }); return [chRow('a'), chRow('b')]; }
    }));
    const newest = handlers['channel:page']({ before: null, limit: 50 }) as ChannelPageReply;
    assert.deepEqual(newest.rows.map((r) => r.id), ['a', 'b']);
    assert.deepEqual(calls[0], { before: null, limit: 50 }, 'null before loads the newest page');

    handlers['channel:page']({ before: { at: 't', id: 'a' }, limit: 20 });
    assert.deepEqual(calls[1], { before: { at: 't', id: 'a' }, limit: 20 }, 'a cursor loads older rows');
});

test('channel:conversation reads one colleague thread by hire id, and rejects a bad shape', () => {
    const calls: Array<{ hireId: string; limit: number }> = [];
    const handlers = buildHandlers(deps({ projects: [] }, { cards: [] }, {
        channelConversation: (hireId, limit) => { calls.push({ hireId, limit }); return [chRow('a')]; }
    }));
    const reply = handlers['channel:conversation']({ hireId: 'h1', limit: 100 }) as ChannelPageReply;
    assert.deepEqual(reply.rows.map((r) => r.id), ['a']);
    assert.deepEqual(calls[0], { hireId: 'h1', limit: 100 }, 'the read is keyed by the selected hire');
    // A missing hire id is refused at the boundary, not passed through.
    assert.throws(() => handlers['channel:conversation']({ limit: 100 }), /requires \{hireId,limit\}/);
});

test('channel:since returns rows newer than the cursor', () => {
    const handlers = buildHandlers(deps({ projects: [] }, { cards: [] }, {
        channelSince: () => [chRow('c')]
    }));
    const reply = handlers['channel:since']({ after: { at: 't', id: 'b' }, limit: 50 }) as ChannelPageReply;
    assert.deepEqual(reply.rows.map((r) => r.id), ['c']);
});

test('channel:reply sanitises the message and routes it by hire id through the one write path', async () => {
    const replied: Array<{ hireId: string; text: string }> = [];
    const handlers = buildHandlers(deps({ projects: [] }, { cards: [] }, {
        channelReply: (hireId, text) => { replied.push({ hireId, text }); return Promise.resolve(); }
    }));

    const ctrlC = String.fromCharCode(0x03);
    await handlers['channel:reply']({ hireId: 'h1', text: 'ship it' + ctrlC + ' now' });
    assert.deepEqual(replied, [{ hireId: 'h1', text: 'ship it now' }],
        'sanitised, and routed by hire id, the same as the detail write');
});

test('channel:reply refuses arguments that fail the guard', () => {
    const handlers = buildHandlers(deps());
    assert.throws(() => handlers['channel:reply']({ hireId: 'h1' }), /requires/);
    assert.throws(() => handlers['channel:reply']({ text: 'hi' }), /requires/);
    assert.throws(() => handlers['channel:reply']({ hireId: 'h1', text: 'x'.repeat(64 * 1024 + 1) }), /requires/);
});

test('channel:page and channel:since refuse arguments that fail the guard', () => {
    const handlers = buildHandlers(deps());
    assert.throws(() => handlers['channel:page']({ limit: 50 }), /requires/, 'before is required, even if null');
    assert.throws(() => handlers['channel:page']({ before: null, limit: 0 }), /requires/);
    assert.throws(() => handlers['channel:since']({ limit: 50 }), /requires/, 'after cursor is required');
    assert.throws(() => handlers['channel:since']({ after: { at: 't' }, limit: 50 }), /requires/, 'cursor needs id');
});

test('checkpoints:saved returns the deps result, or null when nothing to show', () => {
    const saved = { drainId: 'd1', saves: [{ name: 'Marion', branch: 'stafford/checkpoint/marion/S1' }] };
    const withSaved = buildHandlers(deps({ projects: [] }, { cards: [] }, { savedCheckpoints: () => saved }));
    assert.deepEqual(withSaved['checkpoints:saved'](undefined), saved);
    assert.equal(buildHandlers(deps())['checkpoints:saved'](undefined), null);
});

test('checkpoints:ack is guarded and routes the drain id to ack', () => {
    const acked: string[] = [];
    const handlers = buildHandlers(deps({ projects: [] }, { cards: [] }, { ackCheckpoints: (d) => acked.push(d) }));
    handlers['checkpoints:ack']({ drainId: 'd1' });
    assert.deepEqual(acked, ['d1']);
    assert.throws(() => handlers['checkpoints:ack']({}), /checkpoints:ack requires/);
});
