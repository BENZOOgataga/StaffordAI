/**
 * The self-path guard: does a candidate directory collide with one of Stafford's own directories.
 *
 * A project must never be pointed at Stafford itself. If it is, a colleague spawns inside Stafford's
 * own source tree, reads all of it, and can write it or commit task branches into the real repo
 * through the normal permission flow, because the gate treats the project cwd as the legitimate root.
 * This is the check that refuses that, at project creation and again at spawn.
 *
 * "Collide" is three cases, all refused: the candidate IS a self-path, the candidate SITS INSIDE one
 * (a subfolder of Stafford's dir), or the candidate CONTAINS one (an ancestor, so Stafford's dir is
 * under the project). Comparison goes through the same normalisation the permission gate uses,
 * resolve to absolute, resolve symlinks, then the platform's case fold, on both sides, so a
 * case-variant or a symlinked path cannot slip past a plain string match.
 */

import { realpathSync } from 'node:fs';
import { resolveForCompare } from '../agents/permission-gate.ts';

export interface SelfPathDeps {
    /** Stafford's own directories: its install/app dir, its runtime cwd, and its userData dir. */
    readonly selfPaths: readonly string[];
    /** The platform's case rule, from `platform.normalisePath`. Lowercases on darwin/win32. */
    readonly normalise: (value: string) => string;
    /** Resolves symlinks, i.e. `fs.realpathSync.native`. Injected so the check is testable. */
    readonly realpath?: (value: string) => string;
}

/** True when `candidate` is, sits inside, or contains any of Stafford's own directories. */
export function hitsSelfPath(candidate: string, deps: SelfPathDeps): boolean {
    const realpath = deps.realpath ?? ((v: string) => realpathSync.native(v));
    const cand = resolveForCompare(deps.normalise, realpath, candidate, candidate);
    for (const self of deps.selfPaths) {
        if (self.trim() === '') continue;
        const s = resolveForCompare(deps.normalise, realpath, self, self);
        // Equal, candidate under self, or self under candidate. The folded forms are
        // forward-slashed with no trailing slash, so a slash boundary avoids matching a
        // sibling whose name merely shares a prefix (foo vs foobar).
        if (cand === s || cand.startsWith(s + '/') || s.startsWith(cand + '/')) return true;
    }
    return false;
}
