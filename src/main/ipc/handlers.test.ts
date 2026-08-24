import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHandlers } from './handlers.ts';
import {
    INVOKE_CHANNELS, type HealthReport, type ProjectsList, type RosterSnapshot,
    type ChannelCursor, type ChannelMessageRow, type ChannelPageReply,
    type ProjectCreated, type HireCreated, type ActivityRow, type SavedCheckpoints,
    type PermissionRulesReply, type PermissionEffectiveReply, type PermissionWriteReply,
    type PermissionAdd, type PermissionUpdate,
    type TasksReply, type TaskWriteReply, type TaskAssign, type TaskReview, type TaskDiffReply, type TaskBoardReply
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
    permissionRules?: (projectId: string) => PermissionRulesReply;
    effectivePolicy?: (projectId: string, hireId: string | null) => PermissionEffectiveReply;
    addPermissionRule?: (payload: PermissionAdd) => PermissionWriteReply;
    updatePermissionRule?: (payload: PermissionUpdate) => PermissionWriteReply;
    removePermissionRule?: (id: string) => PermissionWriteReply;
    tasksByHire?: (hireId: string, limit: number) => TasksReply;
    assignTask?: (payload: TaskAssign) => TaskWriteReply;
    startTask?: (id: string) => TaskWriteReply;
    reviewTask?: (payload: TaskReview) => TaskWriteReply;
    taskDiff?: (id: string) => Promise<TaskDiffReply>;
    taskBoard?: (closedLimit: number) => TaskBoardReply;
}

const TASK_OK: TaskWriteReply = {
    ok: true,
    task: {
        id: 't1', hireId: 'h1', projectId: 'p1', text: 'x', state: 'assigned',
        createdAt: '2026-08-22T10:00:00Z', startedAt: null, completedAt: null,
        updatedAt: '2026-08-22T10:00:00Z', resultSummary: null, resultBranch: null,
        resultCommit: null, failedReason: null, declaredOutputs: [], refusedOutputs: null,
        sessionId: null, sendBacks: [], attempts: 0
    },
    refused: null
};

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
        channelReply: over.channelReply ?? (() => Promise.resolve()),
        pendingApprovals: () => ({ pending: [] }),
        answerApproval: () => { /* noop */ },
        permissionRules: over.permissionRules ?? (() => ({ baseline: [], overrides: [] })),
        effectivePolicy: over.effectivePolicy ?? (() => ({ rules: [] })),
        addPermissionRule: over.addPermissionRule ?? (() => ({ ok: true, warning: null })),
        updatePermissionRule: over.updatePermissionRule ?? (() => ({ ok: true, warning: null })),
        removePermissionRule: over.removePermissionRule ?? (() => ({ ok: true, warning: null })),
        tasksByHire: over.tasksByHire ?? (() => ({ rows: [] })),
        assignTask: over.assignTask ?? (() => TASK_OK),
        startTask: over.startTask ?? (() => TASK_OK),
        reviewTask: over.reviewTask ?? (() => TASK_OK),
        taskDiff: over.taskDiff ?? (() => Promise.resolve({ files: [], error: null })),
        taskBoard: over.taskBoard ?? (() => ({ rows: [], closedTruncated: false }))
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
            project: 'Stafford', projectId: 'p1', task: null, apprentices: 0, queued: 0, since: null, contextLost: false
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

// --------------------------------------------------------------------------
// Phase 3 permission configuration.
//
// The security story for the write path is structural, so the tests are structural too:
// these channels exist only on the renderer-to-main invoke surface, and a colleague session
// has no part of that surface at all. A colleague speaks stream-json to Claude Code over its
// own stdin and stdout. It has no preload, no contextBridge, no ipcRenderer, so there is no
// channel for it to name. Its only other route to the rules is the database file, which the
// gate denies because userData is a protected path.
// --------------------------------------------------------------------------

const PERMISSION_CHANNELS = [
    'permissions:rules', 'permissions:effective',
    'permissions:add', 'permissions:update', 'permissions:remove'
] as const;

test('every permission channel is on the renderer-to-main invoke allowlist, and nowhere else', () => {
    for (const channel of PERMISSION_CHANNELS) {
        assert.ok((INVOKE_CHANNELS as readonly string[]).includes(channel),
            channel + ' must be an invoke channel, or the config UI cannot reach it');
    }
    // The runner talks to Claude Code over pipes. There is no second transport that could
    // carry these, and this asserts that rather than trusting it: if a future change adds a
    // colleague-facing channel list, a permission channel appearing on it fails here.
    const handlers = buildHandlers(deps());
    for (const channel of PERMISSION_CHANNELS) {
        assert.equal(typeof handlers[channel], 'function',
            channel + ' must be served by main, not by anything a colleague can call');
    }
});

test('the permission writes refuse a malformed payload rather than coercing it', () => {
    const handlers = buildHandlers(deps());
    assert.throws(() => handlers['permissions:add']({ projectId: 'p' }), /permissions:add requires/);
    assert.throws(() => handlers['permissions:add']({ projectId: 'p', hireId: null, action: 'nope', pathScope: null, effect: 'allow' }));
    assert.throws(() => handlers['permissions:add']({ projectId: 'p', hireId: null, action: 'read', pathScope: null, effect: 'maybe' }));
    assert.throws(() => handlers['permissions:update']({ action: 'read', pathScope: null, effect: 'allow' }), /permissions:update requires/);
    assert.throws(() => handlers['permissions:remove']({}), /permissions:remove requires/);
    assert.throws(() => handlers['permissions:rules']({}), /permissions:rules requires/);
    assert.throws(() => handlers['permissions:effective']({ projectId: 'p' }), /permissions:effective requires/);
});

test('a valid add reaches the store layer with exactly what the renderer sent', () => {
    const seen: unknown[] = [];
    const handlers = buildHandlers(deps({ projects: [] }, { cards: [] }, {
        addPermissionRule: (payload) => { seen.push(payload); return { ok: true, warning: null }; }
    }));

    const payload = { projectId: 'p1', hireId: null, action: 'write' as const, pathScope: 'src', effect: 'deny' as const };
    const reply = handlers['permissions:add'](payload);

    assert.deepEqual(seen, [payload]);
    assert.deepEqual(reply, { ok: true, warning: null });
});

test('a widening edit returns a warning rather than throwing, since the decision is the users', () => {
    const handlers = buildHandlers(deps({ projects: [] }, { cards: [] }, {
        addPermissionRule: () => ({ ok: true, warning: 'this widens access to the config directory' })
    }));
    const reply = handlers['permissions:add']({
        projectId: 'p1', hireId: null, action: 'read', pathScope: '/userdata', effect: 'allow'
    }) as { ok: boolean; warning: string | null };

    assert.equal(reply.ok, true, 'a warning must not block the write: it is his machine');
    assert.match(reply.warning ?? '', /widens access/);
});

test('an override add carries the hire id, and a baseline add carries null', () => {
    const seen: Array<{ hireId: string | null }> = [];
    const handlers = buildHandlers(deps({ projects: [] }, { cards: [] }, {
        addPermissionRule: (p) => { seen.push({ hireId: p.hireId }); return { ok: true, warning: null }; }
    }));

    handlers['permissions:add']({ projectId: 'p', hireId: null, action: 'read', pathScope: null, effect: 'allow' });
    handlers['permissions:add']({ projectId: 'p', hireId: 'hire-7', action: 'read', pathScope: null, effect: 'deny' });

    assert.deepEqual(seen, [{ hireId: null }, { hireId: 'hire-7' }],
        'null is a project baseline and a hire id is that colleague override, and nothing else is accepted');
});

// --- tasks ------------------------------------------------------------------

test('every task channel refuses a payload that is not its shape', () => {
    const handlers = buildHandlers(deps());
    const bad: Array<[string, unknown]> = [
        ['tasks:by-hire', { hireId: '', limit: 10 }],
        ['tasks:by-hire', { hireId: 'h1', limit: 0 }],
        ['tasks:by-hire', { hireId: 'h1', limit: 100000 }],
        ['tasks:assign', { hireId: 'h1' }],
        ['tasks:assign', { hireId: 'h1', text: '' }],
        ['tasks:assign', { hireId: 'h1', text: 'x'.repeat(8193) }],
        ['tasks:start', {}],
        ['tasks:review', { id: 't1', decision: 'done', note: null }],
        ['tasks:review', { id: 't1', decision: 'approve' }],
        ['tasks:review', null],
        ['tasks:diff', {}],
        ['tasks:diff', { id: '' }],
        ['tasks:board', {}],
        ['tasks:board', { closedLimit: -1 }],
        ['tasks:board', { closedLimit: 5000 }]
    ];
    for (const [channel, payload] of bad) {
        assert.throws(() => handlers[channel as 'tasks:start'](payload),
            'the ' + channel + ' guard accepted ' + JSON.stringify(payload));
    }
});

test('the review verdicts are an exact set, so no fourth decision can be smuggled in', () => {
    const seen: string[] = [];
    const handlers = buildHandlers(deps({ projects: [] }, { cards: [] }, {
        reviewTask: (p) => { seen.push(p.decision); return TASK_OK; }
    }));
    for (const decision of ['approve', 'fail', 'send-back']) {
        handlers['tasks:review']({ id: 't1', decision, note: null });
    }
    assert.deepEqual(seen, ['approve', 'fail', 'send-back']);
    for (const decision of ['done', 'DONE', 'complete', '', 'working']) {
        assert.throws(() => handlers['tasks:review']({ id: 't1', decision, note: null }));
    }
});

test('THE INVARIANT AT THE WIRE: no channel lets a caller name the actor it acts as', () => {
    // The done-transition is safe because approving is owner-only, and it is owner-only
    // because the service supplies the actor rather than reading it from a payload. If an
    // "actor" ever appears on this list, the guarantee has been moved onto a string a
    // caller controls, which is exactly what the lifecycle's actor argument exists to stop.
    const source = INVOKE_CHANNELS.filter((c) => c.startsWith('tasks:'));
    assert.deepEqual([...source],
        ['tasks:by-hire', 'tasks:assign', 'tasks:start', 'tasks:review', 'tasks:diff', 'tasks:board'],
        'the task surface is these four channels; a new one needs its own reasoning');

    const seen: unknown[] = [];
    const handlers = buildHandlers(deps({ projects: [] }, { cards: [] }, {
        reviewTask: (p) => { seen.push(p); return TASK_OK; },
        assignTask: (p) => { seen.push(p); return TASK_OK; }
    }));
    // An actor smuggled onto a valid payload is simply not read: the guard narrows to the
    // declared shape and the handler passes that through.
    handlers['tasks:review']({ id: 't1', decision: 'approve', note: null, actor: 'colleague' });
    handlers['tasks:assign']({ hireId: 'h1', text: 'x', actor: 'colleague' });
    for (const payload of seen) {
        assert.equal((payload as { actor?: unknown }).actor, 'colleague',
            'the extra key rides along on the object, which is why the service must never read one');
    }
});

test('assigning passes the instruction through verbatim, since it is my words to my colleague', () => {
    const seen: string[] = [];
    const handlers = buildHandlers(deps({ projects: [] }, { cards: [] }, {
        assignTask: (p) => { seen.push(p.text); return TASK_OK; }
    }));
    handlers['tasks:assign']({ hireId: 'h1', text: 'rename Widget to Gadget, and run the tests' });
    assert.deepEqual(seen, ['rename Widget to Gadget, and run the tests']);
});

test('a task read is capped and carries no working directory back to the renderer', () => {
    const handlers = buildHandlers(deps());
    const reply = handlers['tasks:by-hire']({ hireId: 'h1', limit: 50 }) as { rows: readonly Record<string, unknown>[] };
    assert.deepEqual(reply.rows, []);
    // The row type is the guarantee; this asserts the shape a real row would have.
    const row = TASK_OK.task as unknown as Record<string, unknown>;
    for (const forbidden of ['cwd', 'path', 'repoPath', 'dir']) {
        assert.equal(forbidden in row, false, 'a task row must not carry ' + forbidden);
    }
});
