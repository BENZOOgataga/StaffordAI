/**
 * Brings a `SocketPlan` into existence, and checks it on every startup.
 *
 * The plan described the directory, its mode, and what to do about a stale
 * socket file, completely and correctly, and nothing consumed any of it. So
 * `HookListener.listen()` threw EACCES on a machine where the directory did not
 * exist, and on a machine where it did it would have inherited whatever mode it
 * found. Measured 2026-08-08, macOS harness section 3.
 *
 * **Assert on every startup, not only at creation.** `mkdirSync` with a mode is
 * subject to umask, and with `recursive: true` it does nothing at all when the
 * directory already exists. The directory outlives the app: an earlier version,
 * a restore from backup, a migration or an unusual umask can leave it at 0755,
 * and the app would then trust a directory anyone on the machine can read. So
 * the mode is applied after creation rather than during it, and verified after
 * that rather than assumed.
 *
 * **Refusing is a real outcome.** If the mode cannot be made what the platform
 * requires, this throws. A hook socket in a world-readable directory is worse
 * than no hook socket, and per-agent secrets are authentication rather than an
 * excuse to skip the filesystem's half.
 *
 * Windows takes the early return. A named pipe has no parent directory, leaves
 * no file behind, and its access is decided by a descriptor rather than a mode,
 * which is why `parentDir` and `parentMode` are null there rather than absent.
 */

import nodeFs from 'node:fs';
import type { Platform, SocketPlan } from '../platform/types.ts';

/** The filesystem calls this needs, injectable so the tests do not touch a disk. */
export interface SocketFs {
    existsSync(path: string): boolean;
    mkdirSync(path: string, options: { recursive: true }): string | undefined;
    chmodSync(path: string, mode: number): void;
    statSync(path: string): { mode: number };
    unlinkSync(path: string): void;
}

export interface SocketSetupReport {
    /** The directory that was created or found, or null on a pipe platform. */
    readonly parentDir: string | null;
    /** True when this run created it rather than finding it. */
    readonly created: boolean;
    /** The mode found before anything was applied, or null if it did not exist. */
    readonly modeBefore: number | null;
    /** The mode after applying and verifying, or null on a pipe platform. */
    readonly modeAfter: number | null;
    /** True when a leftover socket file was removed. */
    readonly staleRemoved: boolean;
}

export class SocketModeError extends Error {
    readonly path: string;
    readonly expected: number;
    readonly actual: number;

    constructor(path: string, expected: number, actual: number) {
        super(
            'Refusing to start: ' + path + ' is mode 0' + actual.toString(8) +
            ' and must be 0' + expected.toString(8) + '. ' +
            'A hook socket in a directory other accounts can read is worse than no hook socket. ' +
            'Fix it with chmod ' + expected.toString(8) + ' ' + JSON.stringify(path) + ' and start again.'
        );
        this.name = 'SocketModeError';
        this.path = path;
        this.expected = expected;
        this.actual = actual;
    }
}

/**
 * The form a caller actually wants: ask the platform where the socket goes, and
 * prepare it, in one call.
 *
 * Returns the plan alongside the report because the caller needs `plan.path` to
 * hand to `HookListener`, and because `plan.accessDetail` is what gets written
 * to the log at startup so the guarantee is visible rather than implied.
 */
export function prepareSocketFor(
    platform: Pick<Platform, 'hookSocket'>,
    input: { appId: string; home: string },
    fs: SocketFs = nodeFs as unknown as SocketFs
): { plan: SocketPlan; report: SocketSetupReport } {
    const plan = platform.hookSocket(input.appId, input.home);
    return { plan, report: prepareSocket(plan, fs) };
}

/**
 * Prepares the socket's directory and clears a stale socket file.
 *
 * Call before `HookListener.listen()`, every time, not once at install.
 */
export function prepareSocket(plan: SocketPlan, fs: SocketFs = nodeFs as unknown as SocketFs): SocketSetupReport {
    if (plan.parentDir === null) {
        // A named pipe. Nothing to create, nothing left behind, and the mode
        // concept does not apply.
        return { parentDir: null, created: false, modeBefore: null, modeAfter: null, staleRemoved: false };
    }

    const dir = plan.parentDir;
    const existed = fs.existsSync(dir);
    const modeBefore = existed ? fs.statSync(dir).mode & 0o777 : null;

    if (!existed) {
        fs.mkdirSync(dir, { recursive: true });
    }

    let modeAfter = modeBefore;
    if (plan.parentMode !== null) {
        // Applied after creation on purpose. mkdirSync's mode is masked by
        // umask, and it is ignored entirely when the directory already exists.
        fs.chmodSync(dir, plan.parentMode);

        // Read it back. A chmod that did not take leaves the same exposure as
        // no chmod at all, and this is the one place in the codebase where
        // getting it wrong is a security question rather than a bug.
        modeAfter = fs.statSync(dir).mode & 0o777;
        if (modeAfter !== plan.parentMode) {
            throw new SocketModeError(dir, plan.parentMode, modeAfter);
        }
    }

    let staleRemoved = false;
    if (plan.removeStaleFile && fs.existsSync(plan.path)) {
        // A unix socket file survives a crash and blocks the next bind with
        // EADDRINUSE. Nothing is listening on it, or this process would not
        // have got this far.
        fs.unlinkSync(plan.path);
        staleRemoved = true;
    }

    return { parentDir: dir, created: !existed, modeBefore, modeAfter, staleRemoved };
}
