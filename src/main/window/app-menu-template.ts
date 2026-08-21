/**
 * The application menu template, kept pure so it is tested without Electron. The point
 * of setting a menu at all, rather than clearing it, is the accelerators: the roles here
 * carry the clipboard, quit, and close shortcuts, so hiding the menu bar on Windows and
 * Linux does not lose them. On macOS it keeps the conventional app and window menus that
 * belong in the system bar; a null menu there is unusual and strips the standard app
 * shortcuts. Dev builds add a View submenu with reload and DevTools; production omits it.
 *
 * The type-only Electron import is erased at build, so this module has no runtime
 * dependency on Electron and runs under node:test.
 */

import type { MenuItemConstructorOptions } from 'electron';

export function buildMenuTemplate(isMac: boolean, isDev: boolean): MenuItemConstructorOptions[] {
    const template: MenuItemConstructorOptions[] = [];
    // macOS expects the app menu (about, hide, quit) as the first item, in the system bar.
    if (isMac) template.push({ role: 'appMenu' });
    // Quit and Close Window. On macOS quit lives in the app menu; this still carries Close.
    template.push({ role: 'fileMenu' });
    // Undo, Redo, Cut, Copy, Paste, Select All: the clipboard accelerators the app needs
    // so a person can copy a message or edit the input even with the bar hidden.
    template.push({ role: 'editMenu' });
    // The window menu (minimize, zoom) is a macOS convention; skip it elsewhere.
    if (isMac) template.push({ role: 'windowMenu' });
    // DevTools is a dev-only affordance: reachable while developing, absent in production.
    if (isDev) {
        template.push({
            label: 'View',
            submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }]
        });
    }
    return template;
}
