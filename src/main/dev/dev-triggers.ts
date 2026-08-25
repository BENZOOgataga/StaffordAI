/**
 * Dev-only triggers that fake the UI's VISUAL state, so states that only exist transiently (a
 * needs-you task, a pending approval, a not-reporting colleague, the board's empty cases, the
 * tray badge, the OS notification) can be eyeballed on demand without setting up real colleagues
 * and real tasks.
 *
 * **Presentation only. Nothing here touches the database or the real task and approval lifecycle.**
 * A trigger sets an in-memory overlay that the read handlers prefer over the real sources, and
 * emits the same change events the real writes would, so the renderer re-reads and renders the
 * fake through its normal read paths. Clearing the overlay reverts to the real data. Nothing
 * persists: restart the app and the fakes are gone.
 *
 * **Never reachable in a packaged build.** `registerDevTriggers` is a no-op when packaged, so the
 * trigger IPC channels are never registered and there is no surface to reach. `dev-triggers.test.ts`
 * asserts that. The read handlers that consult the overlay only do so behind an `!app.isPackaged`
 * guard in the caller, so a production build never even reads the overlay.
 */

import type {
    RosterSnapshot, RosterCard, TaskBoardReply, TaskRow, TasksReply, PendingApprovals,
    TaskDiffReply, TaskDiffFile, TaskDiffLine
} from '../../shared/ipc.ts';

/** The presentation-only overlay a trigger installs. Null means no dev state is active. */
export interface DevFakeState {
    /** Which trigger produced this, for the log line. */
    readonly label: string;
    readonly roster: RosterSnapshot;
    readonly board: TaskBoardReply;
    /** One colleague's tasks, for the detail Tasks tab. */
    readonly byHire: TasksReply;
    readonly approvals: PendingApprovals;
    /** The canned diff for the review surface, so the diff viewer renders without a real branch. */
    readonly diff: TaskDiffReply;
    /** The tray/notification count: tasks awaiting review, and turns paused on an ask. */
    readonly trayCount: { readonly review: number; readonly paused: number };
}

/** The states a trigger can fake. `clear` removes the overlay. */
export const DEV_STATES = [
    'needs-you', 'approval', 'not-reporting', 'board-empty', 'board-no-tasks', 'board-populated',
    'review-diff', 'clear'
] as const;
export type DevState = (typeof DEV_STATES)[number];

/** The dev trigger IPC channels. Registered only in a dev build, never when packaged. */
export const DEV_TRIGGER_CHANNELS = ['dev:trigger', 'dev:clear'] as const;

// Fixed timestamps, so a fake is deterministic and never calls a clock.
const AT = '2026-08-25T09:00:00Z';

function card(id: string, name: string, state: string): RosterCard {
    return {
        id, name, role: 'PM assistant', state, project: 'demo', projectId: 'p-demo',
        task: null, apprentices: 0, queued: 0, since: null, contextLost: false
    };
}

function task(id: string, hireId: string, state: string, over: Partial<TaskRow> = {}): TaskRow {
    return {
        id, hireId, projectId: 'p-demo',
        text: 'Demo task ' + id + ': a stand-in instruction for eyeballing the UI.',
        state, createdAt: AT, startedAt: AT, completedAt: null, updatedAt: AT,
        resultSummary: state === 'needs-you' ? 'Did the demo work and came back for review.' : null,
        resultBranch: state === 'needs-you' || state === 'done' ? 'stafford/task/' + hireId + '/' + id : null,
        resultCommit: state === 'needs-you' || state === 'done' ? 'democ0mm1t' : null,
        failedReason: state === 'failed' ? 'demo failure reason' : null,
        declaredOutputs: [], refusedOutputs: null, sendBacks: [], attempts: 1, sessionId: 's-' + id,
        ...over
    };
}

const EMPTY_DIFF: TaskDiffReply = { files: [], error: null };

// Compact constructors for canned diff lines.
const c = (text: string): TaskDiffLine => ({ kind: 'context', text });
const add = (text: string): TaskDiffLine => ({ kind: 'add', text });
const del = (text: string): TaskDiffLine => ({ kind: 'del', text });

/**
 * A canned, entirely fake diff that exercises the viewer's real cases: three files, a .ts file with
 * two hunks and a long unchanged run to collapse, a .tsx file, and a plain .md file, with a mix of
 * additions and removals. Invented content, no real repo paths, no secrets.
 */
function fakeReviewDiff(): TaskDiffReply {
    const parser: TaskDiffFile = {
        path: 'src/parser/tokenize.ts', added: 4, removed: 3, binary: false,
        hunks: [
            {
                header: '@@ -1,18 +1,19 @@ export function tokenize',
                lines: [
                    c("import { Token } from './types';"),
                    c(''),
                    c('export function tokenize(input: string): Token[] {'),
                    del('  const out = [];'),
                    add('  const out: Token[] = [];'),
                    c('  let i = 0;'),
                    c(''),
                    c('  // Skip leading whitespace and count the columns as we go, so a later'),
                    c('  // error can point at the exact character rather than the whole line.'),
                    c('  let column = 0;'),
                    c('  while (i < input.length && input[i] === " ") {'),
                    c('    column += 1;'),
                    c('    i += 1;'),
                    c('  }'),
                    c(''),
                    c('  while (i < input.length) {'),
                    c('    const ch = input[i];'),
                    del("    out.push({ kind: 'op', text: ch });"),
                    add("    out.push({ kind: 'operator', value: ch, column });"),
                    c('    i += 1;'),
                    c('  }'),
                    c('  return out;'),
                    c('}')
                ]
            },
            {
                header: '@@ -40,7 +41,8 @@ function classify',
                lines: [
                    c('function classify(ch: string): Kind {'),
                    c('  if (ch >= "0" && ch <= "9") return "number";'),
                    del('  if (ch === "+" || ch === "-") return "op";'),
                    add('  if (ch === "+" || ch === "-" || ch === "*") return "operator";'),
                    c('  return "text";'),
                    c('}')
                ]
            }
        ]
    };
    const toolbar: TaskDiffFile = {
        path: 'src/ui/Toolbar.tsx', added: 2, removed: 1, binary: false,
        hunks: [
            {
                header: '@@ -12,9 +12,10 @@ export function Toolbar',
                lines: [
                    c('  return ('),
                    c('    <div className="toolbar">'),
                    del('      <button onClick={onSave}>Save</button>'),
                    add('      <button onClick={onSave} disabled={busy}>Save</button>'),
                    add('      <button onClick={onRun}>Run</button>'),
                    c('    </div>'),
                    c('  );'),
                    c('}')
                ]
            }
        ]
    };
    const notes: TaskDiffFile = {
        path: 'docs/notes.md', added: 1, removed: 0, binary: false,
        hunks: [
            {
                header: '@@ -3,3 +3,4 @@',
                lines: [
                    c('## Tokenizer'),
                    c(''),
                    add('The tokenizer now records a column on every token.'),
                    c('It reads left to right in one pass.')
                ]
            }
        ]
    };
    return { files: [parser, toolbar, notes], error: null };
}

/**
 * Builds the fake overlay for a state, or null for `clear` (and for an unknown state, so a bad
 * trigger reverts to real rather than rendering nothing). `n` sizes the needs-you state.
 */
export function buildDevFake(state: string, n = 1): DevFakeState | null {
    const one = card('dev-a', 'Iris', 'idle');
    const two = card('dev-b', 'Milo', 'idle');
    const empty: TaskBoardReply = { rows: [], closedTruncated: false };

    switch (state) {
        case 'needs-you': {
            const count = Math.max(0, n);
            const rows = Array.from({ length: count }, (_v, i) => task('n' + i, 'dev-a', 'needs-you'));
            return {
                label: 'needs-you x' + count,
                roster: { cards: [{ ...one }] },
                board: { rows, closedTruncated: false },
                byHire: { rows },
                approvals: { pending: [] },
                diff: EMPTY_DIFF,
                trayCount: { review: count, paused: 0 }
            };
        }
        case 'approval': {
            const t = task('ap', 'dev-a', 'working');
            return {
                label: 'pending approval',
                roster: { cards: [card('dev-a', 'Iris', 'waiting_for_you')] },
                board: { rows: [t], closedTruncated: false },
                byHire: { rows: [t] },
                approvals: { pending: [{ id: 'dev-ap', hireId: 'dev-a', action: 'write', path: '/demo/src/Widget.tsx', command: null, at: AT }] },
                diff: EMPTY_DIFF,
                trayCount: { review: 0, paused: 1 }
            };
        }
        case 'not-reporting':
            return {
                label: 'not reporting',
                roster: { cards: [card('dev-a', 'Iris', 'not_reporting')] },
                board: empty, byHire: { rows: [] }, approvals: { pending: [] },
                diff: EMPTY_DIFF,
                trayCount: { review: 0, paused: 0 }
            };
        case 'board-empty':
            return {
                label: 'board: no colleagues',
                roster: { cards: [] }, board: empty, byHire: { rows: [] },
                approvals: { pending: [] }, diff: EMPTY_DIFF, trayCount: { review: 0, paused: 0 }
            };
        case 'board-no-tasks':
            return {
                label: 'board: colleagues, no tasks',
                roster: { cards: [one, two] }, board: empty, byHire: { rows: [] },
                approvals: { pending: [] }, diff: EMPTY_DIFF, trayCount: { review: 0, paused: 0 }
            };
        case 'board-populated': {
            const rows = [
                task('p1', 'dev-a', 'needs-you'),
                task('p2', 'dev-b', 'needs-you'),
                task('p3', 'dev-a', 'working'),
                task('p4', 'dev-b', 'assigned'),
                task('p5', 'dev-a', 'done'),
                task('p6', 'dev-b', 'failed')
            ];
            return {
                label: 'board: populated',
                roster: { cards: [one, two] },
                board: { rows, closedTruncated: false },
                byHire: { rows: rows.filter((r) => r.hireId === 'dev-a') },
                approvals: { pending: [] },
                diff: EMPTY_DIFF,
                trayCount: { review: 2, paused: 0 }
            };
        }
        case 'review-diff': {
            // A needs-you task whose review surface shows the canned diff. resultBranch and
            // resultCommit are set so the review renders its "what actually changed" section, whose
            // diff comes from the overlay rather than a real git branch.
            const reviewTask = task('rd', 'dev-a', 'needs-you', {
                text: 'Add a column field to every token and thread it through the parser.',
                resultBranch: 'stafford/task/dev-a/rd', resultCommit: 'democ0mm1t',
                resultSummary: 'Threaded a column through the tokenizer and updated the classifier and the toolbar.'
            });
            return {
                label: 'review with diff',
                roster: { cards: [{ ...one }] },
                board: { rows: [reviewTask], closedTruncated: false },
                byHire: { rows: [reviewTask] },
                approvals: { pending: [] },
                diff: fakeReviewDiff(),
                trayCount: { review: 1, paused: 0 }
            };
        }
        case 'clear':
        default:
            return null;
    }
}

// The live overlay. Module-level, set only through a registered dev trigger, which never happens
// in a packaged build. Read by the caller's source wrappers, again only in a dev build.
let overlay: DevFakeState | null = null;
export function devFake(): DevFakeState | null { return overlay; }
export function setDevFake(fake: DevFakeState | null): void { overlay = fake; }

export interface DevTriggerDeps {
    /** The ipcMain-like surface. Only `handle` is used. */
    readonly ipcMain: { handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void };
    /** app.isPackaged. When true, nothing is registered. */
    readonly isPackaged: boolean;
    /** Applies an overlay: emit the change events, refresh the tray, fire the notification on a rise. */
    readonly onApply: (fake: DevFakeState | null) => void;
}

/**
 * Registers the dev trigger IPC, or does nothing when packaged. The no-op is the security boundary:
 * a packaged build never registers `dev:trigger` or `dev:clear`, so there is no channel to invoke.
 */
export function registerDevTriggers(deps: DevTriggerDeps): void {
    if (deps.isPackaged) return;
    deps.ipcMain.handle('dev:trigger', (_event, payload) => {
        const p = (payload ?? {}) as { state?: unknown; n?: unknown };
        const fake = buildDevFake(String(p.state ?? 'clear'), typeof p.n === 'number' ? p.n : 1);
        setDevFake(fake);
        deps.onApply(fake);
        return { ok: true, label: fake?.label ?? 'clear' };
    });
    deps.ipcMain.handle('dev:clear', () => {
        setDevFake(null);
        deps.onApply(null);
        return { ok: true, label: 'clear' };
    });
}

/** Applies a trigger by state name, for the CLI file-watch path. Returns the overlay it installed. */
export function applyDevState(state: string, n: number, onApply: (fake: DevFakeState | null) => void): DevFakeState | null {
    const fake = buildDevFake(state, n);
    setDevFake(fake);
    onApply(fake);
    return fake;
}
