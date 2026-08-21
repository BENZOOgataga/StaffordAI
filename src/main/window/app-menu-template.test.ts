import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuTemplate } from './app-menu-template.ts';

function roles(t: ReturnType<typeof buildMenuTemplate>): (string | undefined)[] {
    return t.map((item) => item.role);
}

test('every platform keeps the edit menu, so the clipboard accelerators survive', () => {
    for (const isMac of [true, false]) {
        for (const isDev of [true, false]) {
            assert.ok(roles(buildMenuTemplate(isMac, isDev)).includes('editMenu'),
                `editMenu missing for isMac=${isMac} isDev=${isDev}`);
        }
    }
});

test('on Windows and Linux the menu is minimal: file and edit, no macOS-only menus', () => {
    const t = buildMenuTemplate(false, false);
    assert.deepEqual(roles(t), ['fileMenu', 'editMenu']);
});

test('a dev build adds a View submenu with DevTools; production does not', () => {
    const dev = buildMenuTemplate(false, true);
    const view = dev.find((i) => i.label === 'View');
    assert.ok(view, 'dev build should have a View menu');
    const subRoles = (view.submenu as { role?: string }[]).map((s) => s.role);
    assert.ok(subRoles.includes('toggleDevTools'), 'View should expose DevTools in dev');

    const prod = buildMenuTemplate(false, false);
    assert.equal(prod.find((i) => i.label === 'View'), undefined, 'production should have no View/DevTools menu');
});

test('macOS keeps the conventional app and window menus in the system bar', () => {
    const t = buildMenuTemplate(true, false);
    assert.equal(t[0]?.role, 'appMenu');
    assert.ok(roles(t).includes('windowMenu'));
    assert.ok(roles(t).includes('editMenu'));
});
