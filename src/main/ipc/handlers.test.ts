import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHandlers } from './handlers.ts';
import {
    INVOKE_CHANNELS, type HealthReport, type ProjectsList, type RosterSnapshot, type SessionOpened,
    type ChannelCursor, type ChannelMessageRow, type ChannelPageReply
} from '../../shared/ipc.ts';
import type { ProofPty } from './proof-pty.ts';

function fakeProof(open = false): ProofPty {
    return {
        isOpen: () => open,
        spawn: () => {},
        write: () => {},
        kill: () => {}
    } as unknown as ProofPty;
}

interface SessionOverrides {
    sender?: () => { send: (channel: string, data: string) => void } | null;
    subscribeSession?: (hireId: string, listener: (data: string) => void) => () => void;
    resizeSession?: (hireId: string, cols: number, rows: number) => void;
    hasSession?: (hireId: string) => boolean;
    submitMessage?: (hireId: string, text: string) => Promise<void>;
    channelPage?: (before: ChannelCursor | null, limit: number) => readonly ChannelMessageRow[];
    channelSince?: (after: ChannelCursor, limit: number) => readonly ChannelMessageRow[];
    channelReply?: (hireId: string, text: string) => Promise<void>;
}

function deps(
    proof = fakeProof(),
    projects: ProjectsList = { projects: [] },
    roster: RosterSnapshot = { cards: [] },
    over: SessionOverrides = {}
) {
    return {
        startedAt: '2026-08-08T00:00:00.000Z',
        platformId: 'darwin',
        proof,
        sender: (over.sender ?? (() => null)) as unknown as HandlerDepsSender,
        listProjects: () => projects,
        rosterSnapshot: () => roster,
        subscribeSession: over.subscribeSession ?? (() => () => {}),
        resizeSession: over.resizeSession ?? (() => {}),
        hasSession: over.hasSession ?? (() => false),
        submitMessage: over.submitMessage ?? (() => Promise.resolve()),
        channelPage: over.channelPage ?? (() => []),
        channelSince: over.channelSince ?? (() => []),
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

const settle = () => new Promise((r) => setTimeout(r, 20));

test('session:open subscribes and streams coalesced output; close stops it', async () => {
    const sent: string[] = [];
    let listener: (data: string) => void = () => {};
    let unsubscribed = false;
    const handlers = buildHandlers(deps(fakeProof(), { projects: [] }, { cards: [] }, {
        sender: () => ({ send: (_ch, data) => { sent.push(data); } }),
        subscribeSession: (_hireId, l) => { listener = l; return () => { unsubscribed = true; }; },
        hasSession: () => true
    }));

    const opened = handlers['session:open']({ hireId: 'h1' }) as SessionOpened;
    assert.equal(opened.live, true, 'a live session reports live');

    // A burst of pty writes coalesces into one session:data message.
    listener('a');
    listener('b');
    listener('c');
    await settle();
    assert.deepEqual(sent, ['abc'], 'the burst became one message, not three');

    handlers['session:close'](undefined);
    assert.equal(unsubscribed, true, 'closing unsubscribes from the session');

    // A closed card receives no data: further pty output does not reach the renderer.
    sent.length = 0;
    listener('after close');
    await settle();
    assert.deepEqual(sent, [], 'a closed card streams nothing');
});

test('opening a second card closes the first, so only the open card streams', () => {
    const unsubscribed: string[] = [];
    const handlers = buildHandlers(deps(fakeProof(), { projects: [] }, { cards: [] }, {
        sender: () => ({ send: () => {} }),
        subscribeSession: (hireId) => () => { unsubscribed.push(hireId); },
        hasSession: () => true
    }));
    handlers['session:open']({ hireId: 'h1' });
    handlers['session:open']({ hireId: 'h2' });
    assert.deepEqual(unsubscribed, ['h1'], 'opening h2 unsubscribed h1 first');
});

test('session:open on a hire with no live session reports not live', () => {
    const handlers = buildHandlers(deps(fakeProof(), { projects: [] }, { cards: [] }, {
        sender: () => ({ send: () => {} }),
        hasSession: () => false
    }));
    const opened = handlers['session:open']({ hireId: 'h1' }) as SessionOpened;
    assert.equal(opened.live, false);
});

test('session:resize propagates the hire and bounded size to the pty', () => {
    const resizes: Array<{ hireId: string; cols: number; rows: number }> = [];
    const handlers = buildHandlers(deps(fakeProof(), { projects: [] }, { cards: [] }, {
        resizeSession: (hireId, cols, rows) => { resizes.push({ hireId, cols, rows }); }
    }));
    handlers['session:resize']({ hireId: 'h1', cols: 120, rows: 40 });
    assert.deepEqual(resizes, [{ hireId: 'h1', cols: 120, rows: 40 }]);
});

test('session:write routes a sanitised message to the open card and strips control bytes', async () => {
    const submitted: Array<{ hireId: string; text: string }> = [];
    const handlers = buildHandlers(deps(fakeProof(), { projects: [] }, { cards: [] }, {
        sender: () => ({ send: () => {} }),
        hasSession: () => true,
        submitMessage: (hireId, text) => { submitted.push({ hireId, text }); return Promise.resolve(); }
    }));
    handlers['session:open']({ hireId: 'h1' });

    const ctrlC = String.fromCharCode(0x03);
    const esc = String.fromCharCode(0x1b);
    await handlers['session:write']({ hireId: 'h1', text: 'stop' + ctrlC + esc + '[31m now' });

    assert.deepEqual(submitted, [{ hireId: 'h1', text: 'stop[31m now' }],
        'the message reached the open session with the Ctrl-C and ESC removed');
});

test('session:write is scoped to the open card: a write to another session is refused', () => {
    const submitted: string[] = [];
    const handlers = buildHandlers(deps(fakeProof(), { projects: [] }, { cards: [] }, {
        sender: () => ({ send: () => {} }),
        hasSession: () => true,
        submitMessage: (hireId) => { submitted.push(hireId); return Promise.resolve(); }
    }));
    handlers['session:open']({ hireId: 'h1' });

    assert.throws(() => handlers['session:write']({ hireId: 'h2', text: 'hi' }), /not the open card/,
        'a write naming a different session is refused, not misrouted');
    assert.deepEqual(submitted, [], 'nothing was written to the wrong session');
});

test('session:write with no card open is refused, so a stale write lands nowhere', () => {
    const submitted: string[] = [];
    const handlers = buildHandlers(deps(fakeProof(), { projects: [] }, { cards: [] }, {
        sender: () => ({ send: () => {} }),
        submitMessage: (hireId) => { submitted.push(hireId); return Promise.resolve(); }
    }));
    assert.throws(() => handlers['session:write']({ hireId: 'h1', text: 'hi' }), /not the open card/);

    // Opening then closing means no open card, so a write after close is refused.
    handlers['session:open']({ hireId: 'h1' });
    handlers['session:close'](undefined);
    assert.throws(() => handlers['session:write']({ hireId: 'h1', text: 'hi' }), /not the open card/);
    assert.deepEqual(submitted, []);
});

test('switching cards rebinds the write target', async () => {
    const submitted: string[] = [];
    const handlers = buildHandlers(deps(fakeProof(), { projects: [] }, { cards: [] }, {
        sender: () => ({ send: () => {} }),
        hasSession: () => true,
        submitMessage: (hireId) => { submitted.push(hireId); return Promise.resolve(); }
    }));
    handlers['session:open']({ hireId: 'h1' });
    handlers['session:open']({ hireId: 'h2' });         // switch cards
    assert.throws(() => handlers['session:write']({ hireId: 'h1', text: 'stale' }), /not the open card/,
        'a write to the previous card is refused');
    await handlers['session:write']({ hireId: 'h2', text: 'fresh' });
    assert.deepEqual(submitted, ['h2'], 'the write went to the now-open card');
});

test('session:write refuses arguments that fail the guard', () => {
    const handlers = buildHandlers(deps());
    assert.throws(() => handlers['session:write']({ hireId: 'h1' }), /requires/);
    assert.throws(() => handlers['session:write']({ text: 'hi' }), /requires/);
    assert.throws(() => handlers['session:write']({ hireId: 'h1', text: 'x'.repeat(64 * 1024 + 1) }), /requires/);
});

function chRow(id: string): ChannelMessageRow {
    return { id, projectId: 'p1', senderId: 'h1', kind: 'event', body: 'waiting_for_you', reference: null, at: 't' };
}

test('channel:page returns rows and passes the cursor and limit through', () => {
    const calls: Array<{ before: ChannelCursor | null; limit: number }> = [];
    const handlers = buildHandlers(deps(fakeProof(), { projects: [] }, { cards: [] }, {
        channelPage: (before, limit) => { calls.push({ before, limit }); return [chRow('a'), chRow('b')]; }
    }));
    const newest = handlers['channel:page']({ before: null, limit: 50 }) as ChannelPageReply;
    assert.deepEqual(newest.rows.map((r) => r.id), ['a', 'b']);
    assert.deepEqual(calls[0], { before: null, limit: 50 }, 'null before loads the newest page');

    handlers['channel:page']({ before: { at: 't', id: 'a' }, limit: 20 });
    assert.deepEqual(calls[1], { before: { at: 't', id: 'a' }, limit: 20 }, 'a cursor loads older rows');
});

test('channel:since returns rows newer than the cursor', () => {
    const handlers = buildHandlers(deps(fakeProof(), { projects: [] }, { cards: [] }, {
        channelSince: () => [chRow('c')]
    }));
    const reply = handlers['channel:since']({ after: { at: 't', id: 'b' }, limit: 50 }) as ChannelPageReply;
    assert.deepEqual(reply.rows.map((r) => r.id), ['c']);
});

test('channel:reply sanitises the message and routes it by hire id through the one write path', async () => {
    const replied: Array<{ hireId: string; text: string }> = [];
    const handlers = buildHandlers(deps(fakeProof(), { projects: [] }, { cards: [] }, {
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

test('session:open and session:resize refuse arguments that fail the guard', () => {
    const handlers = buildHandlers(deps());
    assert.throws(() => handlers['session:open']({}), /requires/);
    assert.throws(() => handlers['session:open'](null), /requires/);
    assert.throws(() => handlers['session:resize']({ hireId: 'h1', cols: 0, rows: 40 }), /requires/);
    assert.throws(() => handlers['session:resize']({ cols: 80, rows: 24 }), /requires/);
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
