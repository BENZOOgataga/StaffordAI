/**
 * Finds the Claude Code executable.
 *
 * Never assumes an npm global path. Resolution order is explicit and the error
 * names every place that was checked, because "not found" on its own is not
 * something anyone can act on.
 *
 * The candidate list comes from the platform, so this function has no idea
 * which operating system it is answering for and macOS can be asserted from
 * Windows.
 */

import type { Platform } from '../platform/types.ts';

export interface LocateClaudeInput {
    readonly platform: Platform;
    /** From configuration. Wins over everything, and a wrong one is an error. */
    readonly override?: string | null;
    readonly home: string;
    /** The PATH to scan, as the platform joins it. */
    readonly pathValue?: string;
    readonly exists: (candidate: string) => boolean;
}

export interface LocatedClaude {
    readonly path: string;
    readonly source: 'config' | 'candidates' | 'path';
}

export function locateClaude(input: LocateClaudeInput): LocatedClaude {
    const { platform, override = null, home, pathValue = '', exists } = input;
    const checked: string[] = [];

    if (override) {
        // A configured path that does not exist is a mistake worth surfacing,
        // not something to quietly fall through.
        if (exists(override)) return { path: override, source: 'config' };
        throw new Error('Claude Code executable not found at the configured path: ' + override);
    }

    for (const candidate of platform.claudeCandidates(home)) {
        checked.push(candidate);
        if (exists(candidate)) return { path: candidate, source: 'candidates' };
    }

    const binary = platform.executableName('claude');
    for (const dir of pathValue.split(platform.pathSeparator)) {
        const trimmed = dir.trim();
        if (!trimmed) continue;
        const candidate = joinFor(platform, trimmed, binary);
        checked.push(candidate);
        if (exists(candidate)) return { path: candidate, source: 'path' };
    }

    throw new Error(
        'Claude Code executable not found. Checked:\n  ' + checked.join('\n  ') +
        '\nSet the claudePath option if it lives somewhere else.'
    );
}

/**
 * Joins with the target platform's separator rather than the host's.
 *
 * `path.join` follows the machine running the code, which is how the CommonJS
 * version of this module produced Windows paths on a macOS runner and failed
 * there while passing everywhere it was ever run.
 */
function joinFor(platform: Platform, dir: string, name: string): string {
    return dir.replace(/[\/]+$/, '') + platform.directorySeparator + name;
}
