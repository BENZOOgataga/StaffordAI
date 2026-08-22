/**
 * Deciding which of a colleague's declared new files may be committed to a task result.
 *
 * **A declaration is a claim, not an authorisation.** The colleague says "these files are the
 * deliverable"; this decides whether each one is allowed to be staged. The distinction is the
 * whole security content of the feature: without it, "commit the files it names" would be a
 * way for a colleague to get anything on disk onto a branch I might push, which is strictly
 * worse than the blind sweep it replaced, because it would look deliberate.
 *
 * Pure, and separated from the wire format for the same reason the permission resolver is
 * pure: the rules can be tested exhaustively without a filesystem or a colleague.
 *
 * What it refuses, and why each one is here rather than assumed impossible:
 *  - anything outside the repository, including via `..` or an absolute path, because a
 *    result branch is a repository's history and nothing above it belongs there;
 *  - anything matching the secret patterns, the same list the gate denies reads and writes
 *    on, because a file the gate would not let a colleague read is not one I want committed;
 *  - anything inside `.git`, because writing history through a declared output is not a
 *    deliverable;
 *  - an ignored file, because the ignore list is a standing statement that something does not
 *    belong in the repository, and a task is not an exception to it.
 */

import { SECRET_FILE_GLOBS } from './permission-profile.ts';

/** One declared path, and what was decided about it. */
export interface OutputVerdict {
    /** As the colleague wrote it, for the message I read at review. */
    readonly declared: string;
    /** The repo-relative, forward-slash path to stage. Null when refused. */
    readonly relative: string | null;
    /** Why it was refused, or null when accepted. */
    readonly refused: string | null;
}

export interface OutputRules {
    /** True when git ignores this repo-relative path. Injected: the answer comes from git. */
    readonly isIgnored?: (relative: string) => boolean;
    /** True when the path already exists in the repository index. Tracked files need no declaring. */
    readonly isTracked?: (relative: string) => boolean;
}

/** The longest a declared path may be. A deliverable has a name, not a paragraph. */
const MAX_PATH_LENGTH = 512;

/** Matches one path segment against a secret glob. Only `*` is used in the list. */
function globMatchesSegment(glob: string, segment: string): boolean {
    let re = '^';
    for (const c of glob) {
        if (c === '*') re += '[^/]*';
        else if ('\\^$.|?+()[]{}'.includes(c)) re += '\\' + c;
        else re += c;
    }
    return new RegExp(re + '$', 'i').test(segment);
}

/** True when any segment of the path looks like a secret file. */
export function looksLikeSecret(relative: string): boolean {
    const segments = relative.split('/');
    const leaf = segments[segments.length - 1] ?? '';
    return SECRET_FILE_GLOBS.some((glob) => globMatchesSegment(glob, leaf));
}

/**
 * Normalises a declared path to a repo-relative forward-slash path, or refuses it.
 *
 * Textual, deliberately. The caller has already resolved symlinks for the repo root, and a
 * declared output is a name the colleague typed rather than a path the filesystem reported,
 * so the traversal check has to hold on the string as written. `..` is refused outright
 * rather than collapsed, because a declaration that needs to climb out of the repository to
 * name its own deliverable is not a declaration worth interpreting.
 */
function normalise(declared: string): { relative: string | null; refused: string | null } {
    const value = declared.trim().replace(/\\/g, '/');
    if (value === '') return { relative: null, refused: 'an empty path' };
    if (value.length > MAX_PATH_LENGTH) return { relative: null, refused: 'the path is too long' };
    if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
        return { relative: null, refused: 'an absolute path; a deliverable is named relative to the repository' };
    }
    const segments = value.split('/').filter((s) => s !== '' && s !== '.');
    if (segments.length === 0) return { relative: null, refused: 'an empty path' };
    if (segments.includes('..')) {
        return { relative: null, refused: 'the path leaves the repository' };
    }
    if (segments[0] === '.git') {
        return { relative: null, refused: 'the path is inside .git' };
    }
    return { relative: segments.join('/'), refused: null };
}

/**
 * Decides each declared output.
 *
 * Returns a verdict per path rather than throwing on the first bad one, so the review shows
 * the colleague what was kept and what was not. A refusal is not a failure of the task: the
 * task still lands for me to look at, with its tracked changes committed and a note saying
 * which named files were left out.
 */
export function validateDeclaredOutputs(
    declared: readonly string[], rules: OutputRules = {}
): OutputVerdict[] {
    const out: OutputVerdict[] = [];
    const taken = new Set<string>();

    for (const value of declared) {
        const { relative, refused } = normalise(value);
        if (relative === null) {
            out.push({ declared: value, relative: null, refused });
            continue;
        }
        if (taken.has(relative)) continue;
        taken.add(relative);

        if (looksLikeSecret(relative)) {
            out.push({
                declared: value, relative: null,
                refused: 'the name matches a secret file pattern, which is never committed'
            });
            continue;
        }
        if (rules.isIgnored?.(relative) === true) {
            out.push({
                declared: value, relative: null,
                refused: 'the repository ignores this path, and a task is not an exception to that'
            });
            continue;
        }
        if (rules.isTracked?.(relative) === true) {
            // Not a refusal worth reporting as a problem: a tracked file's changes are
            // already committed by the ordinary staging, so declaring it is simply redundant.
            out.push({ declared: value, relative: null, refused: 'already tracked, so its changes are already saved' });
            continue;
        }
        out.push({ declared: value, relative, refused: null });
    }

    return out;
}

/** The paths that may be staged, in declaration order. */
export function acceptedOutputs(verdicts: readonly OutputVerdict[]): string[] {
    return verdicts.filter((v) => v.relative !== null).map((v) => v.relative as string);
}

/** A short note for the review about what was left out, or null when nothing was. */
export function refusedNote(verdicts: readonly OutputVerdict[]): string | null {
    const refused = verdicts.filter((v) => v.refused !== null);
    if (refused.length === 0) return null;
    return refused.map((v) => v.declared + ' (' + v.refused + ')').join('; ');
}
