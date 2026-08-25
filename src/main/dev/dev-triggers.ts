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
    RosterSnapshot, RosterCard, TaskBoardReply, TaskRow, TasksReply, PendingApprovals
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
    /** The tray/notification count: tasks awaiting review, and turns paused on an ask. */
    readonly trayCount: { readonly review: number; readonly paused: number };
}

/** The states a trigger can fake. `clear` removes the overlay. */
export const DEV_STATES = [
    'needs-you', 'approval', 'not-reporting', 'board-empty', 'board-no-tasks', 'board-populated', 'clear'
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
                trayCount: { review: 0, paused: 1 }
            };
        }
        case 'not-reporting':
            return {
                label: 'not reporting',
                roster: { cards: [card('dev-a', 'Iris', 'not_reporting')] },
                board: empty, byHire: { rows: [] }, approvals: { pending: [] },
                trayCount: { review: 0, paused: 0 }
            };
        case 'board-empty':
            return {
                label: 'board: no colleagues',
                roster: { cards: [] }, board: empty, byHire: { rows: [] },
                approvals: { pending: [] }, trayCount: { review: 0, paused: 0 }
            };
        case 'board-no-tasks':
            return {
                label: 'board: colleagues, no tasks',
                roster: { cards: [one, two] }, board: empty, byHire: { rows: [] },
                approvals: { pending: [] }, trayCount: { review: 0, paused: 0 }
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
                trayCount: { review: 2, paused: 0 }
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
