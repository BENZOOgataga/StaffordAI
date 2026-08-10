/**
 * Registers the app to start at logon, and refuses to do so in development.
 *
 * A login item is a change to a live system, and that is Benzoo's decision, not
 * a side effect of `npm run dev`. So the registration is guarded: it runs only
 * in a packaged build, or when an explicit opt-in env var is set for a
 * deliberate test. A development run never touches the login item.
 *
 * The decision is a pure function so it can be tested without electron and
 * without changing any real system state. The applier calls
 * `app.setLoginItemSettings`, which is reversible: `setLoginItemSettings({
 * openAtLogin: false })`, or the same toggle in System Settings > General >
 * Login Items.
 */

import type { App } from 'electron';

export interface LoginItemContext {
    /** `app.isPackaged`. False under `npm run dev`. */
    readonly isPackaged: boolean;
    /** `STAFFORD_ENABLE_LOGIN_ITEM=1` for a deliberate opt-in in a dev test. */
    readonly optIn: boolean;
}

/**
 * Register only in a packaged build, or on an explicit opt-in. Anything else,
 * including an ordinary development run, leaves the login item untouched.
 */
export function shouldRegisterLoginItem(ctx: LoginItemContext): boolean {
    return ctx.isPackaged || ctx.optIn;
}

/**
 * Applies the decision. A no-op when it should not register, so a dev run is
 * safe by construction rather than by the caller remembering.
 */
export function configureLoginItem(app: Pick<App, 'setLoginItemSettings' | 'isPackaged'>): boolean {
    const ctx: LoginItemContext = {
        isPackaged: app.isPackaged,
        optIn: process.env.STAFFORD_ENABLE_LOGIN_ITEM === '1'
    };
    if (!shouldRegisterLoginItem(ctx)) return false;

    app.setLoginItemSettings({ openAtLogin: true });
    return true;
}
