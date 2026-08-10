/**
 * The window security configuration from section 6, as data plus thin appliers.
 *
 * The values are exported and tested, because each one is a decision a later
 * contributor has to argue with a written reason rather than flip a default.
 * The appliers take the electron objects and wire the values in; they are thin
 * on purpose so the decisions live in the constants a test can read without
 * launching electron.
 */

import type { BrowserWindow, Session, WebPreferences } from 'electron';

/**
 * Every field is off that can be off. `sandbox: true` is the renderer's own OS
 * sandbox, separate from the Bash tool sandbox the agents run under.
 */
export const WEB_PREFERENCES: WebPreferences = Object.freeze({
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false
});

/**
 * Applied as a response header from main, not a meta tag, so the renderer
 * cannot weaken it. `connect-src 'none'` is the important line: the renderer
 * makes no network request at all, everything outward goes through main behind
 * IPC. `style-src` allows inline styles as the one concession, for animation
 * through the style attribute.
 */
export const CONTENT_SECURITY_POLICY = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
].join('; ');

/** True only for `https:`. External links open in the OS browser, nothing else. */
export function isOpenableExternal(url: string): boolean {
    try {
        return new URL(url).protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Sets the CSP header on every response, denies every permission request, and
 * refuses every attempt to open a new window. The renderer that comes out of
 * this can render its own entry point and nothing else.
 */
export function applySessionSecurity(session: Session): void {
    session.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [CONTENT_SECURITY_POLICY]
            }
        });
    });

    // No camera, microphone, geolocation, web notifications, clipboard read.
    session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
}

/**
 * Cancels navigation away from the app's own entry point and denies every
 * window-open request. An external https link is handed to the OS browser
 * instead of opened in-app.
 */
export function applyWindowSecurity(window: BrowserWindow, entryUrl: string): void {
    window.webContents.on('will-navigate', (event, url) => {
        if (url !== entryUrl) event.preventDefault();
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
        // electron is imported lazily so the pure exports above (the values a
        // test reads) load under plain node without pulling in the electron
        // runtime, which only exists inside the app. openExternal is
        // fire-and-forget, so the async import does not change behaviour.
        if (isOpenableExternal(url)) {
            void import('electron').then(({ shell }) => shell.openExternal(url));
        }
        return { action: 'deny' };
    });
}
