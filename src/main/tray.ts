/**
 * The tray, which is where Stafford lives. No window at launch.
 *
 * A tray-resident app is the shape from the start, not a windowed app with a
 * tray bolted on: the process boots to an icon in the menu bar, and a window is
 * opened on demand from the tray menu. Closing the window returns to the tray
 * rather than quitting.
 *
 * The window factory is injected so the tray does not import BrowserWindow
 * directly, which keeps this file's logic testable and the electron surface in
 * one place.
 */

import type { Tray, Menu as MenuType } from 'electron';

export interface TrayDeps {
    /** Builds a Tray with the app icon. */
    readonly createTray: () => Tray;
    /** Builds the context menu from a template. */
    readonly buildMenu: (template: TrayMenuItem[]) => MenuType;
    /** Opens the on-demand window, or focuses it if already open. */
    readonly openWindow: () => void;
    /** Begins the quit sequence. */
    readonly quit: () => void;
}

export interface TrayMenuItem {
    readonly label?: string;
    readonly click?: () => void;
    readonly type?: 'separator';
}

/**
 * The menu template. Data, so a test can assert the labels and that the actions
 * point where they should without constructing a real Menu.
 */
export function trayMenuTemplate(deps: Pick<TrayDeps, 'openWindow' | 'quit'>): TrayMenuItem[] {
    return [
        { label: 'Open Stafford', click: deps.openWindow },
        { type: 'separator' },
        { label: 'Quit', click: deps.quit }
    ];
}

/** Wires the tray up. Returns the Tray so the caller can hold a reference. */
export function installTray(deps: TrayDeps): Tray {
    const tray = deps.createTray();
    const menu = deps.buildMenu(trayMenuTemplate(deps));
    tray.setToolTip('Stafford');
    tray.setContextMenu(menu);
    // Clicking the icon opens the window too, which is the expected tray gesture.
    tray.on('click', () => deps.openWindow());
    return tray;
}
