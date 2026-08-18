/**
 * The runtime app id, and its one supported override.
 *
 * The app id names two things at once: the Windows hook pipe (`\\.\pipe\<appId>`)
 * and the data-dir segment (`<app data>/<appId>`). A normal launch is always
 * `Stafford`, so a running instance owns `\\.\pipe\Stafford` and its real store.
 * A verification or screenshot run cannot bind that pipe while the app holds it,
 * and two such runs collide with each other, which is what blocked packaged
 * verification while Stafford was running.
 *
 * `STAFFORD_APP_ID` overrides the id for an isolated run, so it gets a distinct
 * pipe and a distinct data dir together, cleanly beside a running instance rather
 * than fighting it for the same endpoints. The default is unchanged: with no
 * override, the id is `Stafford` and the app behaves exactly as before.
 *
 * The value becomes a pipe name and a directory segment, so it is validated to a
 * safe token: letters, digits, dot, dash, underscore, up to 64, and at least one
 * letter or digit. Anything else (a path separator, a pipe-breaking character, an
 * empty string, or a dots-only name like `..` that would climb a directory) is
 * rejected and the default stands, so a malformed override can never redirect the
 * store out of bounds or craft a pipe path.
 */

export const DEFAULT_APP_ID = 'Stafford';

const SAFE_APP_ID = /^[A-Za-z0-9._-]{1,64}$/;
const HAS_ALNUM = /[A-Za-z0-9]/;

export interface ResolvedAppId {
    readonly appId: string;
    /** True when a valid override was applied, for the caller to log the isolation. */
    readonly overridden: boolean;
}

/** Resolves the app id from an environment, falling back to the default on anything unsafe. */
export function resolveAppId(env: Record<string, string | undefined>): ResolvedAppId {
    const raw = env.STAFFORD_APP_ID?.trim();
    if (raw && SAFE_APP_ID.test(raw) && HAS_ALNUM.test(raw)) return { appId: raw, overridden: true };
    return { appId: DEFAULT_APP_ID, overridden: false };
}
