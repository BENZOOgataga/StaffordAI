'use strict';

/*
 * A stub of the window.stafford bridge for the screenshot harness, so the real renderer
 * (index.html and its views) mounts with sample data and no main process. Dev tool only,
 * never shipped. It mirrors the method names in src/preload/index.ts and returns fixed
 * sample data, so a screenshot shows exactly what the real app renders.
 */

const { contextBridge } = require('electron');

const cards = [
    { id: 'a', name: 'Marion', role: 'PM assistant', state: 'not_reporting', project: 'test', task: null, apprentices: 0, queued: 0, since: null, contextLost: false },
    { id: 'b', name: 'Alexi', role: 'PM assistant', state: 'idle', project: 'test', task: null, apprentices: 0, queued: 0, since: null, contextLost: false }
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
