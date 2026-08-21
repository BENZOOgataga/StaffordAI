/**
 * The window-control handlers behind the custom frameless title bar: minimize, toggle
 * maximize/restore, close, and the maximized-state query. Close routes through the
 * window's own close(), which the app intercepts to hide to the tray, so a click on the
 * custom Close button returns to the tray exactly as the OS close did, and the drain on
 * tray Quit is untouched. The pure handler map is testable without Electron; the register
 * and the event wiring bind it to ipcMain and a real window.
 */

import type { IpcMain, BrowserWindow } from 'electron';
import { WINDOW_INVOKE_CHANNELS, type WindowInvokeChannel } from '../../shared/ipc.ts';

/** The slice of a window the controls need, so the handlers are tested with a fake. */
export interface ControllableWindow {
    minimize(): void;
    maximize(): void;
    unmaximize(): void;
    isMaximized(): boolean;
    close(): void;
}

/**
 * The handler per window-control channel. toggle-maximize returns the new maximized state
 * so the button can reflect it; is-maximized reports the current one. A missing window is
 * a no-op, so a control fired between windows cannot throw.
 */
export function windowControlHandlers(
    getWindow: () => ControllableWindow | null
): Record<WindowInvokeChannel, () => unknown> {
    return {
        'window:minimize': () => { getWindow()?.minimize(); },
        'window:toggle-maximize': () => {
            const win = getWindow();
            if (!win) return false;
            if (win.isMaximized()) { win.unmaximize(); return false; }
            win.maximize();
            return true;
        },
        // Route through close(), which the app intercepts to hide to the tray. The custom
        // Close button must not quit or bypass the drain.
        'window:close': () => { getWindow()?.close(); },
        'window:is-maximized': () => getWindow()?.isMaximized() ?? false
    };
}

/** Wires the control handlers into ipcMain, one handle per window-control channel. */
export function registerWindowControls(ipcMain: IpcMain, getWindow: () => BrowserWindow | null): void {
    const handlers = windowControlHandlers(getWindow);
    for (const channel of WINDOW_INVOKE_CHANNELS) {
        ipcMain.handle(channel, () => handlers[channel]());
    }
}

/**
 * Pushes the maximized state to the renderer whenever it changes, so the maximize/restore
 * button reflects the real window state (including a state change from an OS gesture like
 * aero-snap or a double-click on the drag region, not just the button).
 */
export function wireMaximizeEvents(win: BrowserWindow): void {
    const send = (): void => {
        if (!win.isDestroyed()) win.webContents.send('window:maximized-changed', win.isMaximized());
    };
    win.on('maximize', send);
    win.on('unmaximize', send);
}
