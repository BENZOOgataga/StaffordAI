/**
 * The POSIX tree-teardown plan, shared by darwin and linux.
 *
 * Shared because the defect it fixes is POSIX-wide rather than macOS-specific.
 * It was found on darwin, and linux would fail identically: the assumption that
 * a tool child stays in the session's process group is not ours to make, it is
 * the spawned program's to break, and Claude Code breaks it on both.
 *
 * Windows is genuinely unaffected. `taskkill /T` walks parent to child and has
 * no group assumption to be wrong about, which is why it keeps its own plan
 * rather than sharing this one.
 */

import type { CommandSpec, KillSignal, KillTreePlan } from './types.ts';

export function posixKillTreePlan(pid: number): KillTreePlan {
    return {
        rootPid: pid,

        // Not an optimisation. After the root dies its descendants are
        // reparented to pid 1, so the parent chain that identifies them is gone
        // and there is nothing left to walk. The measurement has to happen
        // first or it cannot happen at all.
        snapshotBeforeKill: true,

        // Every distinct group in the snapshot, not just the root's. That is
        // the whole correction: the tool child's group was not the session's.
        killsEveryGroup: true,

        wholeTree: null,

        group(pgid: number, signal: KillSignal): CommandSpec {
            // A negative pid names the process group. Killing groups rather
            // than a pid list matters because anything that spawns during
            // teardown inherits its parent's group and is caught, where a list
            // collected a moment earlier would already be stale.
            return { file: 'kill', args: ['-' + signal, '-' + String(pgid)] };
        },

        process(pid2: number, signal: KillSignal): CommandSpec {
            return { file: 'kill', args: ['-' + signal, String(pid2)] };
        },

        gap:
            'a snapshot followed by a kill has a window between them. A process spawned into a ' +
            'brand new group inside that window is in neither the collected groups nor the ' +
            'survivor sweep, so it escapes both. Re-walking and killing survivors by pid narrows ' +
            'the window and does not close it. This procedure is a strong best effort rather than ' +
            'a guarantee, and anything that depends on nothing surviving has to verify it rather ' +
            'than assume it.',

        detail:
            'snapshot the tree by parent pid while it is alive, collect the distinct process ' +
            'groups, kill each group, then re-walk and kill any survivor by pid, then verify.'
    };
}
