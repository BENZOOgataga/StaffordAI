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
    approvals: { pending: async () => ({ pending: [] }), answer: async () => {}, onChanged: unsub },
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
