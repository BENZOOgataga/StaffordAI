/**
 * Reads Claude Code's own record of which directories it trusts, and turns a
 * process exit into something a card can show.
 *
 * Read only, always. Stafford never writes to Claude Code's configuration and
 * never answers a trust prompt on Benzoo's behalf. Accepting trust grants an
 * agent read, write and execute in that directory, so it stays a human
 * decision.
 *
 * Measured during Task 0, and the reason this module exists:
 *  - No hook of any kind fires while a trust prompt is up.
 *  - Declining exits the process with code 1 and fires nothing, so from the
 *    outside it is indistinguishable from a crash at startup.
 */

import type { Platform } from '../platform/types.ts';

export const TRUST = {
    TRUSTED: 'trusted',
    NOT_TRUSTED: 'not_trusted',
    UNKNOWN: 'unknown'
} as const;

export type TrustState = (typeof TRUST)[keyof typeof TRUST];

export const EXIT_REPORT = {
    IDLE: 'idle',
    CRASHED: 'crashed',
    NEEDS_TRUST: 'needs_trust'
} as const;

export type ExitReport = (typeof EXIT_REPORT)[keyof typeof EXIT_REPORT];

export interface ReadTrustInput {
    readonly platform: Platform;
    readonly dir: string;
    readonly configPath: string;
    readonly readFile: (path: string) => string;
}

export function readTrust(input: ReadTrustInput): TrustState {
    const { platform, dir, configPath, readFile } = input;
    if (!dir) throw new Error('readTrust requires a dir');

    let config: unknown;
    try {
        config = JSON.parse(readFile(configPath));
    } catch {
        // Missing or malformed is unknown, never an error. A runner that cannot
        // start because Claude Code's config is mid-write is worse than a card
        // that says it does not know yet.
        return TRUST.UNKNOWN;
    }

    const projects = (config as { projects?: Record<string, unknown> } | null)?.projects;
    if (!projects || typeof projects !== 'object') return TRUST.UNKNOWN;

    const wanted = platform.normalisePath(dir);
    for (const [key, value] of Object.entries(projects)) {
        if (platform.normalisePath(key) !== wanted) continue;
        if (!value || typeof value !== 'object') return TRUST.UNKNOWN;
        const accepted = (value as { hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted;
        if (accepted === true) return TRUST.TRUSTED;
        if (accepted === false) return TRUST.NOT_TRUSTED;
        return TRUST.UNKNOWN;
    }

    // No record at all means the directory has never been opened, so the next
    // spawn there will show a trust prompt.
    return TRUST.NOT_TRUSTED;
}

export interface ClassifyExitInput {
    readonly trustAtSpawn: TrustState;
    readonly sawSessionStart: boolean;
    readonly sawSessionEnd: boolean;
}

/**
 * The one state that does not come from a hook, because a crash fires no hook
 * at all and a card stuck on working forever is worse than the runner
 * reporting on a process it owns.
 */
export function classifyExit(input: ClassifyExitInput): ExitReport {
    const { trustAtSpawn, sawSessionStart, sawSessionEnd } = input;

    if (sawSessionStart) {
        return sawSessionEnd ? EXIT_REPORT.IDLE : EXIT_REPORT.CRASHED;
    }

    // Nothing was ever heard from this session. A trust prompt is the likely
    // cause, and needs trust is more actionable on a card than crashed. Unknown
    // is treated as not trusted here on purpose: a startup crash producing zero
    // hook events is rare, and pointing at the directory costs one click if the
    // guess is wrong.
    if (trustAtSpawn === TRUST.TRUSTED) return EXIT_REPORT.CRASHED;
    return EXIT_REPORT.NEEDS_TRUST;
}
