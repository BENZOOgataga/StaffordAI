import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildDevFake, registerDevTriggers, devFake, setDevFake, DEV_TRIGGER_CHANNELS, type DevFakeState
} from './dev-triggers.ts';

/** A recording ipcMain stub: captures which channels were registered and their handlers. */
function fakeIpc() {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    return {
        handlers,
        channels: (): string[] => [...handlers.keys()].sort(),
        ipcMain: { handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown): void => { handlers.set(channel, fn); } }
    };
}

test('THE GATE: registerDevTriggers registers no channel when packaged, so production has no surface', () => {
    // "Packaged" is simulated by passing isPackaged: true, which in the app is app.isPackaged.
    const { ipcMain, channels } = fakeIpc();
    registerDevTriggers({ ipcMain, isPackaged: true, onApply: () => {} });
    assert.deepEqual(channels(), [], 'a packaged build registers none of the dev trigger channels');
});

test('a dev build registers exactly the dev trigger channels', () => {
    const { ipcMain, channels } = fakeIpc();
    registerDevTriggers({ ipcMain, isPackaged: false, onApply: () => {} });
    assert.deepEqual(channels(), [...DEV_TRIGGER_CHANNELS].sort());
});

test('needs-you fakes N review tasks and an N-review tray count', () => {
    const f = buildDevFake('needs-you', 3);
    assert.equal(f?.board.rows.length, 3);
    assert.ok(f?.board.rows.every((r) => r.state === 'needs-you'), 'every faked row is needs-you');
    assert.deepEqual(f?.trayCount, { review: 3, paused: 0 });
    // n = 0 is a valid case (to test the empty needs-you column).
    assert.equal(buildDevFake('needs-you', 0)?.board.rows.length, 0);
});

test('approval fakes one pending approval and a paused tray count', () => {
    const f = buildDevFake('approval');
    assert.equal(f?.approvals.pending.length, 1);
    assert.deepEqual(f?.trayCount, { review: 0, paused: 1 });
    // The approval carries no free-text beyond an action and a path, no message or task body.
    assert.equal(f?.approvals.pending[0]?.command, null);
});

test('not-reporting fakes a colleague in the not_reporting state', () => {
    assert.equal(buildDevFake('not-reporting')?.roster.cards[0]?.state, 'not_reporting');
});

test('the three board cases: empty has no colleagues, no-tasks has colleagues but no rows, populated has both', () => {
    assert.equal(buildDevFake('board-empty')?.roster.cards.length, 0);
    const noTasks = buildDevFake('board-no-tasks');
    assert.ok((noTasks?.roster.cards.length ?? 0) > 0, 'no-tasks still has colleagues');
    assert.equal(noTasks?.board.rows.length, 0, 'no-tasks has no tasks');
    const populated = buildDevFake('board-populated');
    assert.ok((populated?.roster.cards.length ?? 0) > 0);
    assert.ok((populated?.board.rows.length ?? 0) > 0);
});

test('clear and any unknown state produce no overlay, so a bad trigger reverts to real data', () => {
    assert.equal(buildDevFake('clear'), null);
    assert.equal(buildDevFake('not-a-state'), null);
});

test('dev:trigger installs the overlay and dev:clear removes it; nothing here touches a store', () => {
    setDevFake(null);
    const applied: (DevFakeState | null)[] = [];
    const { ipcMain, handlers } = fakeIpc();
    // The deps carry no repository or store of any kind, so a trigger structurally cannot persist.
    registerDevTriggers({ ipcMain, isPackaged: false, onApply: (f) => applied.push(f) });

    handlers.get('dev:trigger')?.(null, { state: 'needs-you', n: 2 });
    assert.equal(devFake()?.board.rows.length, 2, 'the trigger installed the in-memory overlay');
    assert.equal(applied.at(-1)?.board.rows.length, 2, 'onApply received the same overlay');

    handlers.get('dev:clear')?.(null, null);
    assert.equal(devFake(), null, 'clear removed the overlay');
    assert.equal(applied.at(-1), null, 'onApply received the clear');
    setDevFake(null);
});
