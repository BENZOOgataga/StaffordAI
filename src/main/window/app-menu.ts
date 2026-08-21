/**
 * Applies the application menu and hides its bar on Windows and Linux, so Stafford does
 * not read as a generic Electron shell. The menu itself stays set, because clearing it
 * would strip the clipboard, quit, and close accelerators the app relies on; hiding the
 * bar keeps those live while removing the File/Edit/View/Window strip from view. On
 * macOS the menu belongs in the system bar and is left visible.
 */

import { Menu, type BrowserWindow } from 'electron';
import { buildMenuTemplate } from './app-menu-template.ts';

/**
 * Sets the minimal application menu. Dev adds a View submenu with DevTools. `isMac` is
 * passed in from currentPlatform by the caller, so the platform check stays behind the
 * platform abstraction the rest of main uses rather than reading the raw node value.
 */
export function applyAppMenu(isMac: boolean, isDev: boolean): void {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(isMac, isDev)));
}

/**
 * Hides the in-window menu bar on Windows and Linux. The application menu is still set,
 * so its accelerators keep working; only the visible strip goes. macOS renders its menu
 * in the system bar, not the window, so it is left alone.
 */
export function hideMenuBar(win: BrowserWindow, isMac: boolean): void {
    if (isMac) return;
    win.autoHideMenuBar = true;
    win.setMenuBarVisibility(false);
}
