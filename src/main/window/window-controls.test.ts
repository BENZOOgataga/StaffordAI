import test from 'node:test';
import assert from 'node:assert/strict';
import { windowControlHandlers, type ControllableWindow } from './window-controls.ts';

function fakeWindow(maximized = false): ControllableWindow & { calls: string[]; maxed: boolean } {
    const w = {
        maxed: maximized,
        calls: [] as string[],
        minimize() { this.calls.push('minimize'); },
        maximize() { this.calls.push('maximize'); this.maxed = true; },
        unmaximize() { this.calls.push('unmaximize'); this.maxed = false; },
        isMaximized() { return this.maxed; },
        close() { this.calls.push('close'); }
    };
    return w;
}

test('toggle-maximize maximizes a normal window and reports the new state', () => {
    const win = fakeWindow(false);
    const result = windowControlHandlers(() => win)['window:toggle-maximize']();
    assert.equal(result, true);
    assert.deepEqual(win.calls, ['maximize']);
});

test('toggle-maximize restores a maximized window and reports the new state', () => {
    const win = fakeWindow(true);
    const result = windowControlHandlers(() => win)['window:toggle-maximize']();
    assert.equal(result, false);
    assert.deepEqual(win.calls, ['unmaximize']);
});

test('close routes to the window close, which the app hides to the tray, not a quit', () => {
    const win = fakeWindow();
    windowControlHandlers(() => win)['window:close']();
    assert.deepEqual(win.calls, ['close']);
});

test('minimize minimizes; is-maximized reports the state', () => {
    const win = fakeWindow(true);
    const h = windowControlHandlers(() => win);
    h['window:minimize']();
    assert.deepEqual(win.calls, ['minimize']);
    assert.equal(h['window:is-maximized'](), true);
});

test('a control fired with no window is a safe no-op', () => {
    const h = windowControlHandlers(() => null);
    assert.doesNotThrow(() => h['window:minimize']());
    assert.equal(h['window:toggle-maximize'](), false);
    assert.equal(h['window:is-maximized'](), false);
});
