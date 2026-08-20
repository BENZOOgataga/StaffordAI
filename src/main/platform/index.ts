/**
 * Platform selection, and the shared code that turns the platform layer's data
 * into answers.
 *
 * Everything that touches an operating system lives here and nowhere else. The
 * three implementations return lists and rules; this file is what reads a
 * filesystem, compares two paths and decides that a platform is unsupported.
 * Write it once, and darwin's behaviour is exercised by every Windows test run
 * that goes through these functions.
 */

import { win32 } from './win32.ts';
import { darwin } from './darwin.ts';
import { linux } from './linux.ts';
import type { Platform, PlatformId } from './types.ts';

export type { Platform, PlatformId, CommandSpec, SelfCheckSpec, PathInputs, RegistryLookup } from './types.ts';
export { win32, darwin, linux };

const PLATFORMS: Readonly<Record<PlatformId, Platform>> = Object.freeze({ win32, darwin, linux });

export function isPlatformId(value: unknown): value is PlatformId {
    return value === 'win32' || value === 'darwin' || value === 'linux';
}

/**
 * @throws when the operating system is not one of the three. Better than
 * guessing: a fourth platform would silently get Linux's rules otherwise.
 */
export function platformFor(id: string): Platform {
    if (!isPlatformId(id)) {
        throw new Error(
            'Stafford has no platform implementation for "' + id + '". ' +
            'Supported: ' + Object.keys(PLATFORMS).join(', ') + '.'
        );
    }
    return PLATFORMS[id];
}

export function currentPlatform(id: string = process.platform): Platform {
    return platformFor(id);
}

/**
 * Two paths refer to the same place.
 *
 * The only caller of `normalisePath`. Feature code calls this and never reads
 * the rule, which is what keeps the case-sensitivity difference from leaking
 * back out into the codebase.
 */
export function pathsEqual(platform: Platform, a: string, b: string): boolean {
    return platform.normalisePath(a) === platform.normalisePath(b);
}

/**
 * First candidate that exists, or null.
 *
 * `exists` is injected so this is testable against any platform's candidate
 * list from any machine, which is the whole point of the lists being data.
 */
export function firstExisting(
    candidates: readonly string[],
    exists: (p: string) => boolean
): string | null {
    for (const candidate of candidates) {
        if (candidate && exists(candidate)) return candidate;
    }
    return null;
}

/**
 * Locates a POSIX shell, consulting the registry first where there is one.
 *
 * `readRegistry` is injected and returns an install root or null. On platforms
 * with no registry the lookup list is empty, so the loop simply does not run
 * and there is no branch on platform anywhere in here.
 */
export function findPosixShell(
    platform: Platform,
    input: { home: string; nodeDir: string; parentPath: string },
    exists: (p: string) => boolean,
    readRegistry: (key: string, value: string) => string | null,
    /**
     * Configured shell executable. Wins over everything, and a configured path
     * that does not exist resolves to null rather than falling through, so a
     * wrong setting is visible instead of being silently ignored.
     *
     * This existed in the CommonJS version and was dropped in the port. Caught
     * by auditing what the deleted tests covered rather than by anyone hitting
     * it, which is the only reason it is here rather than in a bug report from
     * someone whose Git install is somewhere unusual.
     */
    override: string | null = null
): string | null {
    if (override) return exists(override) ? override : null;

    for (const lookup of platform.shellRegistryLookups()) {
        const root = readRegistry(lookup.key, lookup.value);
        if (!root) continue;
        const candidate = platform.posixShellCandidates({ ...input, home: root })[0];
        // The registry gives an install root, and the first candidate derived
        // from it is the one under that root.
        for (const c of [candidate, root + '\\bin\\bash.exe']) {
            if (c && exists(c)) return c;
        }
    }
    return firstExisting(platform.posixShellCandidates(input), exists);
}

/**
 * Refuses to run on a platform that has never been exercised on hardware.
 *
 * @throws with a message naming the platform, because "it did not start" is not
 * an answer anyone can act on.
 */
export function assertSupported(platform: Platform): void {
    if (platform.supported) return;
    throw new Error(
        'Stafford does not support ' + platform.id + ' yet. ' +
        'The platform layer is written but has never run there, and starting anyway ' +
        'would be worse than refusing. See docs/plans/stack-migration.technical.md section 8.'
    );
}
