'use strict';

/*
 * A stub of the window.stafford bridge for the screenshot harness, so the real renderer
 * (index.html and its views) mounts with sample data and no main process. Dev tool only,
 * never shipped. It mirrors the method names in src/preload/index.ts and returns fixed
 * sample data, so a screenshot shows exactly what the real app renders.
 */

const { contextBridge } = require('electron');

// Demo data only. Neutral names from the built-in pool, a neutral demo user in every path, and demo
// project names, so a screenshot for the README carries no real identifier of any kind.
const cards = [
    { id: 'b', name: 'Alexi', role: 'Developer', state: 'working', project: 'Acme Web', projectId: 'p1', task: null, apprentices: 0, queued: 0, since: '2026-08-25T08:58:00Z', contextLost: false },
    { id: 'a', name: 'Marion', role: 'PM assistant', state: 'waiting_for_you', project: 'Acme Web', projectId: 'p1', task: null, apprentices: 0, queued: 0, since: null, contextLost: false }
];
const unsub = () => () => {};

contextBridge.exposeInMainWorld('stafford', {
    health: async () => ({ ok: true, platform: 'win32', startedAt: '' }),
    projects: {
        list: async () => ({ projects: [{ id: 'p1', name: 'Acme Web' }] }),
        create: async () => ({ id: 'p2', name: 'x' }),
        pickFolder: async () => 'C:/Users/dev/Projects/acme-web',
        // The Projects management tab: two projects (one with a missing folder, to show the repoint
        // affordance), a bound colleague, and a parked colleague, so a screenshot shows the states the
        // tab manages at once. Every path uses a neutral demo user, never a real home directory.
        manageView: async () => ({
            projects: [
                { id: 'p1', name: 'Acme Web', repos: [{ path: 'C:/Users/dev/Projects/acme-web', label: 'acme-web' }], folderValid: true,
                    colleagues: [{ id: 'b', name: 'Alexi', title: 'Developer', state: 'working', parked: false }] },
                { id: 'p2', name: 'Design System', repos: [{ path: 'C:/Users/dev/Projects/design-system', label: 'design-system' }], folderValid: false, colleagues: [] }
            ],
            parked: [{ id: 'a', name: 'Marion', title: 'PM assistant', state: 'idle', parked: true }]
        }),
        update: async () => ({ ok: true, warning: null }),
        remove: async () => ({ ok: true, warning: null }),
        rebind: async () => ({ ok: true, warning: null }),
        onChanged: unsub
    },
    hire: { create: async () => ({ id: 'h1', name: 'x', title: 'x', projectId: 'p1' }) },
    roster: { snapshot: async () => ({ cards }), onChanged: unsub },
    channel: (() => {
        // A seeded conversation for colleague 'b' plus live-stream plumbing, so the harness can
        // drive the phase-1 streaming path through the real renderer. streamListeners and
        // changedListeners hold the renderer's own callbacks; the __test hooks below fire them.
        const rows = { b: [
            { id: 'you1', projectId: 'p1', senderId: 'benzoo', kind: 'message', body: 'Can you summarize the parser design in a sentence?', reference: null, at: '2026-08-25T09:00:00Z' }
        ] };
        const streamListeners = [];
        const changedListeners = [];
        // Persisted rich turns per hire, keyed by message id, so a reopen re-renders the rich blocks.
        const turnEvents = {};
        return {
            page: async () => ({ rows: [] }), since: async () => ({ rows: [] }),
            conversation: async (hireId) => ({ rows: rows[hireId] || [] }),
            turnEvents: async (hireId) => ({ byMessage: turnEvents[hireId] || {} }),
            reply: async () => {},
            onChanged: (l) => { changedListeners.push(l); return () => {}; },
            onStreamDelta: (l) => { streamListeners.push(l); return () => {}; },
            // Harness-only. Fire a live text snapshot, and commit the final text as a persisted row
            // (what recordReply plus channel:changed do in the real app), so a screenshot can show
            // the mid-stream bubble and the reconciled final message.
            __test: {
                stream: (hireId, blocks, done) => { for (const l of streamListeners) l({ hireId, blocks, done: !!done }); },
                commit: (hireId, text) => {
                    (rows[hireId] = rows[hireId] || []).push({
                        id: 'final1', projectId: 'p1', senderId: hireId, kind: 'message', body: text, reference: null, at: '2026-08-25T09:00:05Z'
                    });
                    for (const l of changedListeners) l();
                },
                // Persists a finished turn's rich blocks against a new colleague message (what
                // recordReply plus turn_events do in the real app), so a screenshot can show a past
                // turn re-rendering its full rich content on reopen, not just its text.
                persistTurn: (hireId, messageId, text, blocks) => {
                    (rows[hireId] = rows[hireId] || []).push({
                        id: messageId, projectId: 'p1', senderId: hireId, kind: 'message', body: text, reference: null, at: '2026-08-25T09:02:00Z'
                    });
                    (turnEvents[hireId] = turnEvents[hireId] || {})[messageId] = blocks;
                    for (const l of changedListeners) l();
                },
                // Reproduces the REAL send sequence that the plain `stream` hook missed and that let a
                // broken indicator pass: the person's own message lands and fires channel:changed
                // (which re-reads the conversation), racing the turn-start empty snapshot. The old
                // clear-on-re-read logic blanked the indicator here; the fix keeps it. A harness run
                // that drives this and checks the indicator is still present would have caught the bug.
                sendRace: (hireId) => {
                    (rows[hireId] = rows[hireId] || []).push({
                        id: 'you-race', projectId: 'p1', senderId: 'benzoo', kind: 'message', body: 'run the tests please', reference: null, at: '2026-08-25T09:01:00Z'
                    });
                    for (const l of changedListeners) l();                          // channel:changed -> re-read
                    for (const l of streamListeners) l({ hireId, blocks: [], done: false }); // turn-start indicator
                }
            }
        };
    })(),
    activity: { byHire: async () => ({ rows: [] }), onAppended: unsub },
    shell: { onNavigate: unsub },
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
    // The AskUserQuestion prompts. Harness-injectable: __test.setPending seeds a pending ask and
    // fires the renderer's onChanged, so the live answer form renders against a real pending entry.
    questions: (() => {
        let pending = [];
        const listeners = [];
        return {
            pending: async () => ({ pending }),
            answer: async (id, answers) => { console.log('[stub] question:answer', id, JSON.stringify(answers)); },
            onChanged: (l) => { listeners.push(l); return () => {}; },
            __test: {
                setPending: (list) => { pending = list; for (const l of listeners) l(); }
            }
        };
    })(),
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
        // The board: tasks across BOTH colleagues, so a screenshot shows the thing the board
        // exists for, every waiting task in one column regardless of whose it is.
        board: async () => ({
            rows: [
                {
                    id: 't1', hireId: 'b', projectId: 'p1',
                    text: 'Add a parser for the config file and cover it with tests.',
                    state: 'needs-you', createdAt: '2026-08-23T09:00:00Z', startedAt: '2026-08-23T09:00:10Z',
                    completedAt: null, updatedAt: '2026-08-23T09:06:00Z',
                    resultSummary: 'Added the parser and its tests.',
                    resultBranch: 'stafford/task/b/t1', resultCommit: '4cb6973512ab', failedReason: null,
                    declaredOutputs: [], refusedOutputs: null, sessionId: 's1',
                    sendBacks: [
                        { at: '2026-08-23T09:02:00Z', note: 'It drops blank lines.' },
                        { at: '2026-08-23T09:04:00Z', note: 'Cover the legacy format too.' }
                    ],
                    attempts: 3
                },
                {
                    id: 't4', hireId: 'a', projectId: 'p1',
                    text: 'Write the migration notes for the storage change.',
                    state: 'needs-you', createdAt: '2026-08-23T08:30:00Z', startedAt: '2026-08-23T08:30:05Z',
                    completedAt: null, updatedAt: '2026-08-23T08:52:00Z',
                    resultSummary: 'Wrote docs/migration.md.',
                    resultBranch: 'stafford/task/a/t4', resultCommit: 'b71c40de9a11', failedReason: null,
                    declaredOutputs: ['docs/migration.md'], refusedOutputs: null, sessionId: 's4',
                    sendBacks: [], attempts: 1
                },
                {
                    id: 't2', hireId: 'b', projectId: 'p1',
                    text: 'Rename the Widget component to Gadget everywhere and update the imports.',
                    state: 'working', createdAt: '2026-08-23T09:10:00Z', startedAt: '2026-08-23T09:10:05Z',
                    completedAt: null, updatedAt: '2026-08-23T09:10:05Z',
                    resultSummary: null, resultBranch: null, resultCommit: null, failedReason: null,
                    declaredOutputs: [], refusedOutputs: null, sessionId: 's2', sendBacks: [], attempts: 1
                },
                {
                    id: 't5', hireId: 'a', projectId: 'p1',
                    text: 'Audit the dependency tree for anything unmaintained.',
                    state: 'working', createdAt: '2026-08-23T09:12:00Z', startedAt: '2026-08-23T09:12:02Z',
                    completedAt: null, updatedAt: '2026-08-23T09:12:02Z',
                    resultSummary: null, resultBranch: null, resultCommit: null, failedReason: null,
                    declaredOutputs: [], refusedOutputs: null, sessionId: 's5', sendBacks: [], attempts: 1
                },
                {
                    id: 't6', hireId: 'a', projectId: 'p1',
                    text: 'Draft the release notes for 0.2.',
                    state: 'assigned', createdAt: '2026-08-23T09:20:00Z', startedAt: null,
                    completedAt: null, updatedAt: '2026-08-23T09:20:00Z',
                    resultSummary: null, resultBranch: null, resultCommit: null, failedReason: null,
                    declaredOutputs: [], refusedOutputs: null, sessionId: null, sendBacks: [], attempts: 0
                },
                {
                    id: 't3', hireId: 'b', projectId: 'p1',
                    text: 'Fix the off-by-one in the pagination cursor.',
                    state: 'done', createdAt: '2026-08-22T14:00:00Z', startedAt: '2026-08-22T14:00:04Z',
                    completedAt: '2026-08-22T14:20:00Z', updatedAt: '2026-08-22T14:20:00Z',
                    resultSummary: 'One line, plus a test.',
                    resultBranch: 'stafford/task/b/t3', resultCommit: '9de1f0a7b3c2', failedReason: null,
                    declaredOutputs: [], refusedOutputs: null, sessionId: 's3', sendBacks: [], attempts: 1
                },
                {
                    id: 't7', hireId: 'a', projectId: 'p1',
                    text: 'Port the old settings screen to the new shell.',
                    state: 'failed', createdAt: '2026-08-22T11:00:00Z', startedAt: '2026-08-22T11:00:03Z',
                    completedAt: '2026-08-22T11:40:00Z', updatedAt: '2026-08-22T11:40:00Z',
                    resultSummary: null, resultBranch: null, resultCommit: null,
                    failedReason: 'the old screen is gone, so there is nothing to port',
                    declaredOutputs: [], refusedOutputs: null, sessionId: 's7', sendBacks: [], attempts: 1
                }
            ],
            closedTruncated: true
        }),
        // A canned diff with hunks, so the harness renders the inline diff viewer: a .ts file with
        // two hunks and a long unchanged run to collapse, a .tsx file, and a plain .md file.
        diff: async () => {
            const c = (text) => ({ kind: 'context', text });
            const add = (text) => ({ kind: 'add', text });
            const del = (text) => ({ kind: 'del', text });
            return {
                files: [
                    {
                        path: 'src/parser/tokenize.ts', added: 4, removed: 3, binary: false,
                        hunks: [
                            { header: '@@ -1,18 +1,19 @@ export function tokenize', lines: [
                                c("import { Token } from './types';"), c(''),
                                c('export function tokenize(input: string): Token[] {'),
                                del('  const out = [];'), add('  const out: Token[] = [];'),
                                c('  let i = 0;'), c(''),
                                c('  // Skip leading whitespace and count the columns as we go, so a later'),
                                c('  // error can point at the exact character rather than the whole line.'),
                                c('  let column = 0;'), c('  while (i < input.length && input[i] === " ") {'),
                                c('    column += 1;'), c('    i += 1;'), c('  }'), c(''),
                                c('  while (i < input.length) {'), c('    const ch = input[i];'),
                                del("    out.push({ kind: 'op', text: ch });"),
                                add("    out.push({ kind: 'operator', value: ch, column });"),
                                c('    i += 1;'), c('  }'), c('  return out;'), c('}')
                            ] },
                            { header: '@@ -40,7 +41,8 @@ function classify', lines: [
                                c('function classify(ch: string): Kind {'),
                                c('  if (ch >= "0" && ch <= "9") return "number";'),
                                del('  if (ch === "+" || ch === "-") return "op";'),
                                add('  if (ch === "+" || ch === "-" || ch === "*") return "operator";'),
                                c('  return "text";'), c('}')
                            ] }
                        ]
                    },
                    {
                        path: 'src/ui/Toolbar.tsx', added: 2, removed: 1, binary: false,
                        hunks: [{ header: '@@ -12,9 +12,10 @@ export function Toolbar', lines: [
                            c('  return ('), c('    <div className="toolbar">'),
                            del('      <button onClick={onSave}>Save</button>'),
                            add('      <button onClick={onSave} disabled={busy}>Save</button>'),
                            add('      <button onClick={onRun}>Run</button>'),
                            c('    </div>'), c('  );'), c('}')
                        ] }]
                    },
                    {
                        path: 'docs/notes.md', added: 1, removed: 0, binary: false,
                        hunks: [{ header: '@@ -3,3 +3,4 @@', lines: [
                            c('## Tokenizer'), c(''),
                            add('The tokenizer now records a column on every token.'),
                            c('It reads left to right in one pass.')
                        ] }]
                    }
                ],
                error: null
            };
        },
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
                // Authored rows: the ones that stay visible in the effective list.
                { action: 'read', pathScope: '/proj/src/secrets', commandPattern: null, effect: 'deny', source: 'baseline', overridesBaseline: false, replacedEffect: null },
                { action: 'write', pathScope: '/proj/src', commandPattern: null, effect: 'deny', source: 'override', overridesBaseline: true, replacedEffect: 'allow' },
                { action: 'write', pathScope: '/proj/docs', commandPattern: null, effect: 'allow', source: 'override', overridesBaseline: false, replacedEffect: null },
                { action: 'fetch', pathScope: null, commandPattern: null, effect: 'ask', source: 'baseline', overridesBaseline: false, replacedEffect: null },
                // The generated default profile: collapsed into its own section. The protected-dir
                // denies, the secret-file family, and a read-only destructive-command ask.
                { action: 'read', pathScope: '/userdata', commandPattern: null, effect: 'deny', source: 'default-profile', overridesBaseline: false, replacedEffect: null },
                { action: 'write', pathScope: '/userdata', commandPattern: null, effect: 'deny', source: 'default-profile', overridesBaseline: false, replacedEffect: null },
                { action: 'read', pathScope: '/proj/**/.env', commandPattern: null, effect: 'deny', source: 'default-profile', overridesBaseline: false, replacedEffect: null },
                { action: 'read', pathScope: '/proj/**/.env.*', commandPattern: null, effect: 'deny', source: 'default-profile', overridesBaseline: false, replacedEffect: null },
                { action: 'read', pathScope: '/proj/**/*.pem', commandPattern: null, effect: 'deny', source: 'default-profile', overridesBaseline: false, replacedEffect: null },
                { action: 'read', pathScope: '/proj/**/*.key', commandPattern: null, effect: 'deny', source: 'default-profile', overridesBaseline: false, replacedEffect: null },
                { action: 'read', pathScope: '/proj/**/id_rsa', commandPattern: null, effect: 'deny', source: 'default-profile', overridesBaseline: false, replacedEffect: null },
                { action: 'read', pathScope: '/proj/**/credentials.json', commandPattern: null, effect: 'deny', source: 'default-profile', overridesBaseline: false, replacedEffect: null },
                { action: 'write', pathScope: '/proj/**/.env', commandPattern: null, effect: 'deny', source: 'default-profile', overridesBaseline: false, replacedEffect: null },
                { action: 'write', pathScope: '/proj/**/*.pem', commandPattern: null, effect: 'deny', source: 'default-profile', overridesBaseline: false, replacedEffect: null },
                { action: 'write', pathScope: '/proj/**/*.key', commandPattern: null, effect: 'deny', source: 'default-profile', overridesBaseline: false, replacedEffect: null },
                { action: 'shell', pathScope: null, commandPattern: 'git\\s+push\\s+--force', effect: 'ask', source: 'default-profile', overridesBaseline: false, replacedEffect: null }
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
