'use strict';

/*
 * A stub of the window.stafford bridge for the screenshot harness, so the real renderer
 * (index.html and its views) mounts with sample data and no main process. Dev tool only,
 * never shipped. It mirrors the method names in src/preload/index.ts and returns fixed
 * sample data, so a screenshot shows exactly what the real app renders.
 */

const { contextBridge } = require('electron');

const cards = [
    { id: 'a', name: 'Marion', role: 'PM assistant', state: 'not_reporting', project: 'test', projectId: 'p1', task: null, apprentices: 0, queued: 0, since: null, contextLost: false },
    { id: 'b', name: 'Alexi', role: 'PM assistant', state: 'idle', project: 'test', projectId: 'p1', task: null, apprentices: 0, queued: 0, since: null, contextLost: false }
];
const unsub = () => () => {};

contextBridge.exposeInMainWorld('stafford', {
    health: async () => ({ ok: true, platform: 'win32', startedAt: '' }),
    projects: { list: async () => ({ projects: [{ id: 'p1', name: 'test' }] }), create: async () => ({ id: 'p2', name: 'x' }) },
    hire: { create: async () => ({ id: 'h1', name: 'x', title: 'x', projectId: 'p1' }) },
    roster: { snapshot: async () => ({ cards }), onChanged: unsub },
    channel: {
        page: async () => ({ rows: [] }), since: async () => ({ rows: [] }),
        conversation: async () => ({ rows: [] }), reply: async () => {}, onChanged: unsub
    },
    activity: { byHire: async () => ({ rows: [] }), onAppended: unsub },
    checkpoints: { saved: async () => null, ack: async () => {} },
    // One pending ask, so a screenshot shows both kinds of waiting at once: the approvals
    // banner on the roster, and the same colleague's running task reading as paused.
    approvals: {
        pending: async () => ({
            pending: [{
                id: 'ap1', hireId: 'b', action: 'write',
                path: '/proj/src/components/Gadget.tsx', command: null, at: '2026-08-22T09:11:00Z'
            }]
        }),
        answer: async () => {},
        onChanged: unsub
    },
    // Tasks. Sample rows covering the cases the review panel exists for: one waiting for me
    // with a result branch, declared new files and a refusal (so a refused deliverable is
    // visibly not silent), one still working, and one already approved.
    tasks: {
        byHire: async () => ({
            rows: [
                {
                    id: 't1', hireId: 'b', projectId: 'p1',
                    text: 'Add a parser for the config file and cover it with tests.',
                    state: 'needs-you',
                    createdAt: '2026-08-22T09:00:00Z', startedAt: '2026-08-22T09:00:10Z',
                    completedAt: null, updatedAt: '2026-08-22T09:06:00Z',
                    resultSummary: 'Added src/config/parse.ts with the parser and its tests. It handles the three shapes the existing config uses. I could not cover the legacy format because there is no sample of it in the repo.',
                    resultBranch: 'stafford/task/b/t1', resultCommit: '4cb6973512ab',
                    failedReason: null,
                    declaredOutputs: ['src/config/parse.ts', 'src/config/parse.test.ts', '.env.local'],
                    refusedOutputs: '.env.local (the name matches a secret file pattern, which is never committed)',
                    sessionId: 's1',
                    // Sent back twice, so the review shows the history and the attempt line.
                    sendBacks: [
                        { at: '2026-08-22T09:02:00Z', note: 'It drops blank lines. Keep them, they are significant in this format.' },
                        { at: '2026-08-22T09:04:00Z', note: 'Cover the legacy format too, there is a sample under fixtures now.' }
                    ],
                    attempts: 3
                },
                {
                    id: 't2', hireId: 'b', projectId: 'p1',
                    text: 'Rename the Widget component to Gadget everywhere and update the imports.',
                    state: 'working',
                    createdAt: '2026-08-22T09:10:00Z', startedAt: '2026-08-22T09:10:05Z',
                    completedAt: null, updatedAt: '2026-08-22T09:10:05Z',
                    resultSummary: null, resultBranch: null, resultCommit: null, failedReason: null,
                    declaredOutputs: [], refusedOutputs: null, sessionId: 's2',
                    sendBacks: [], attempts: 1
                },
                {
                    id: 't3', hireId: 'b', projectId: 'p1',
                    text: 'Fix the off-by-one in the pagination cursor.',
                    state: 'done',
                    createdAt: '2026-08-21T14:00:00Z', startedAt: '2026-08-21T14:00:04Z',
                    completedAt: '2026-08-21T14:20:00Z', updatedAt: '2026-08-21T14:20:00Z',
                    resultSummary: 'The cursor compared with < where it needed <=. One line, plus a test.',
                    resultBranch: 'stafford/task/b/t3', resultCommit: '9de1f0a7b3c2',
                    failedReason: null, declaredOutputs: [], refusedOutputs: null, sessionId: 's3',
                    sendBacks: [], attempts: 1
                }
            ]
        }),
        assign: async () => ({ ok: true, task: null, refused: null }),
        start: async () => ({ ok: true, task: null, refused: null }),
        review: async () => ({ ok: true, task: null, refused: null }),
        diff: async () => ({
            files: [
                { path: 'src/config/parse.ts', added: 84, removed: 0 },
                { path: 'src/config/parse.test.ts', added: 61, removed: 0 },
                { path: 'src/config/index.ts', added: 3, removed: 1 }
            ],
            error: null
        }),
        onChanged: unsub
    },
    // Permission configuration. Sample rules that exercise the cases worth looking at: a
    // plain baseline rule, a generated default-profile rule shown read-only, an override
    // that replaces a baseline rule, and an override that adds a scope the baseline never
    // mentioned. Those last two look identical in a naive list and must not here.
    permissions: {
        rules: async () => ({
            baseline: [
                { id: 'r1', hireId: null, action: 'write', pathScope: '/proj/src', commandPattern: null, effect: 'allow', createdAt: '' },
                { id: 'r2', hireId: null, action: 'read', pathScope: '/proj/src/secrets', commandPattern: null, effect: 'deny', createdAt: '' },
                { id: 'r3', hireId: null, action: 'fetch', pathScope: null, commandPattern: null, effect: 'ask', createdAt: '' }
            ],
            overrides: [
                { id: 'o1', hireId: 'a', action: 'write', pathScope: '/proj/src', commandPattern: null, effect: 'deny', createdAt: '' },
                { id: 'o2', hireId: 'a', action: 'write', pathScope: '/proj/docs', commandPattern: null, effect: 'allow', createdAt: '' }
            ]
        }),
        effective: async () => ({
            rules: [
                { action: 'read', pathScope: '/proj/src/secrets', commandPattern: null, effect: 'deny', source: 'baseline', overridesBaseline: false, replacedEffect: null },
                { action: 'write', pathScope: '/proj/src', commandPattern: null, effect: 'deny', source: 'override', overridesBaseline: true, replacedEffect: 'allow' },
                { action: 'write', pathScope: '/proj/docs', commandPattern: null, effect: 'allow', source: 'override', overridesBaseline: false, replacedEffect: null },
                { action: 'write', pathScope: '/userdata', commandPattern: null, effect: 'deny', source: 'default-profile', overridesBaseline: false, replacedEffect: null },
                { action: 'shell', pathScope: null, commandPattern: 'git\\s+push\\s+--force', effect: 'ask', source: 'default-profile', overridesBaseline: false, replacedEffect: null },
                { action: 'fetch', pathScope: null, commandPattern: null, effect: 'ask', source: 'baseline', overridesBaseline: false, replacedEffect: null }
            ]
        }),
        add: async () => ({ ok: true, warning: null }),
        update: async () => ({ ok: true, warning: null }),
        remove: async () => ({ ok: true, warning: null }),
        onChanged: unsub
    },
    // Frameless like the real Windows app, so the harness renders the custom title bar.
    // The control methods are no-ops here; the real controls are proven in a real window.
    win: {
        frameless: true,
        minimize: async () => {},
        toggleMaximize: async () => false,
        close: async () => {},
        isMaximized: async () => false,
        onMaximizeChange: unsub
    }
});
