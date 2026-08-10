import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRegisterLoginItem, configureLoginItem } from './login-item.ts';

test('a login item registers in a packaged build', () => {
    assert.equal(shouldRegisterLoginItem({ isPackaged: true, optIn: false }), true);
});

test('a development run never registers a login item', () => {
    // The rule that matters: npm run dev must not change a live system.
    assert.equal(shouldRegisterLoginItem({ isPackaged: false, optIn: false }), false);
});

test('an explicit opt-in registers even in development, for a deliberate test', () => {
    assert.equal(shouldRegisterLoginItem({ isPackaged: false, optIn: true }), true);
});

test('configureLoginItem does not touch the system in a dev run', () => {
    let called = false;
    const app = {
        isPackaged: false,
        setLoginItemSettings: () => { called = true; }
    };
    const registered = configureLoginItem(app);
    assert.equal(registered, false);
    assert.equal(called, false, 'setLoginItemSettings must not be called in a dev run');
});

test('configureLoginItem registers in a packaged build', () => {
    let settings: unknown = null;
    const app = {
        isPackaged: true,
        setLoginItemSettings: (s: unknown) => { settings = s; }
    };
    const registered = configureLoginItem(app);
    assert.equal(registered, true);
    assert.deepEqual(settings, { openAtLogin: true });
});
