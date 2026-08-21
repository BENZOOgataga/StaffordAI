/**
 * Tears down a process tree, and verifies that it did.
 *
 * The platform says what to do and this does it, the same split as
 * `SocketPlan` and `socket-setup.ts`. What lives here is the ordering, because
 * the ordering is what was wrong.
 *
 * **Measure before killing.** A tree is identified by parent pointers, and
 * killing the root destroys them: the children are reparented to pid 1 and
 * nothing connects them to the session any more. So the snapshot is not an
 * optimisation, it is the only moment the information exists.
 *
 * **Kill groups, not a pid list.** A process that spawns during teardown
 * inherits its parent's process group, so a group kill catches it. A list of
 * pids collected a moment earlier cannot, because it was complete when it was
 * taken and is not any more.
 *
 * **Kill every group in the snapshot, not the root's.** This is the correction.
 * `kill -9 -<session pid>` was killing a group that contained only the session,
 * because Claude Code runs its Bash tool through a wrapper that leads a group
 * of its own. Measured 2026-08-08: session pgid 76638, tool child pgid 77277,
 * the kill returned success and the child kept running.
 *
 * **Verification is part of the procedure.** Not something a caller remembers
 * to do afterwards. A kill that reports success and leaves a process behind is
 * exactly the failure this module exists for, and it was found because an
 * assertion looked rather than because anything raised an error.
 *
 * The gap this trades into is real and is named in `plan.gap`: between the
 * snapshot and the kill there is a window, and a process spawned into a brand
 * new group inside it is in neither the collected groups nor the survivor
 * sweep. Step four narrows the window. It does not close it.
 */

import { execFileSync } from 'node:child_process';
import type { CommandSpec, KillSignal, Platform } from '../platform/types.ts';
import { readProcessTree, isDescendantOf, find, type ProcessRow, type TreeReader } from './process-tree.ts';

export interface KillTreeReport {
    readonly rootPid: number;
    /** Everything the snapshot found, root included. */
    readonly snapshot: readonly ProcessRow[];
    /** The distinct process groups that were killed. */
    readonly groups: readonly number[];
    /**
     * Groups found in the snapshot and deliberately not killed, because killing them would
     * have killed Stafford. Non-empty means a managed child was spawned without its own
     * process group, which is a defect upstream of here even though this contained it.
     */
    readonly refusedGroups: readonly number[];
    /** Anything still alive after the group kills, before the survivor sweep. */
    readonly survivorsBeforeSweep: readonly ProcessRow[];
    /** Anything still alive after everything. Empty is the only good answer. */
    readonly survivors: readonly ProcessRow[];
    readonly ok: boolean;
    readonly detail: string;
}

export interface KillTreeDeps {
    readonly run?: (spec: CommandSpec) => void;
    readonly readTree?: TreeReader;
    /** Injected so tests do not wait and so the grace is configurable later. */
    readonly waitMs?: (ms: number) => Promise<void>;
    readonly settleMs?: number;
    /**
     * Stafford's own pid, for the self-group guard. Injected so a test can drive the guard
     * without being the process it is protecting. Defaults to `process.pid`.
     */
    readonly selfPid?: number;
    /** Where the guard reports a refusal. Defaults to stderr. Never carries anything but numbers. */
    readonly warn?: (message: string) => void;
}

const defaultRun = (spec: CommandSpec): void => {
    try {
        execFileSync(spec.file, [...spec.args], { stdio: 'ignore' });
    } catch {
        // kill and taskkill both report failure when nothing matched, which is
        // the normal case for a group whose members already exited. The
        // verification below is what decides whether this worked.
    }
};

const defaultWait = (ms: number): Promise<void> =>
    new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref(); });

/** The root plus every descendant, measured while they are all still alive. */
export function snapshotTree(rows: readonly ProcessRow[], rootPid: number): ProcessRow[] {
    const out: ProcessRow[] = [];
    const root = find(rows, rootPid);
    if (root) out.push(root);
    for (const row of rows) {
        if (row.pid === rootPid) continue;
        if (isDescendantOf(rows, row.pid, rootPid)) out.push(row);
    }
    return out;
}

/** Distinct groups, in first-seen order, so the kill order is deterministic. */
export function groupsIn(rows: readonly ProcessRow[]): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const row of rows) {
        if (row.pgid <= 0 || seen.has(row.pgid)) continue;
        seen.add(row.pgid);
        out.push(row.pgid);
    }
    return out;
}

/**
 * The groups it is safe to kill, and the ones refused.
 *
 * A group containing Stafford is never safe, whatever the snapshot says. This is the second
 * line behind spawning managed children into their own group: that fix has to be applied at
 * every spawn site, and this one holds even when a site is missed. It is what turns the
 * failure from "the app dies" into "one child is not reaped and it is written down".
 *
 * `selfPgid` is read from the same snapshot rather than from a syscall, because node exposes
 * no `getpgid` and the snapshot already answers it. A snapshot without Stafford in it means
 * the guard cannot tell, so nothing is refused rather than everything, since refusing on
 * unknown would silently stop reaping anything.
 */
export function partitionGroups(
    groups: readonly number[], selfPgid: number | null
): { safe: number[]; refused: number[] } {
    const safe: number[] = [];
    const refused: number[] = [];
    for (const pgid of groups) {
        // pgid 1 is init/launchd's group, and 0 would mean "the caller's group" to kill(2),
        // which is the same self-kill by another spelling.
        if (pgid <= 1 || (selfPgid !== null && pgid === selfPgid)) refused.push(pgid);
        else safe.push(pgid);
    }
    return { safe, refused };
}

export async function killTree(
    platform: Platform,
    rootPid: number,
    deps: KillTreeDeps = {}
): Promise<KillTreeReport> {
    const run = deps.run ?? defaultRun;
    const wait = deps.waitMs ?? defaultWait;
    const settleMs = deps.settleMs ?? 500;
    const selfPid = deps.selfPid ?? process.pid;
    const warn = deps.warn ?? ((m: string) => { process.stderr.write('[kill-tree] ' + m + '\n'); });
    const plan = platform.killTreePlan(rootPid);
    const signal: KillSignal = 'KILL';

    // Windows. One command walks the tree itself, so none of the procedure
    // below applies and pretending otherwise would invent a process table it
    // does not have.
    if (plan.wholeTree) {
        run(plan.wholeTree);
        await wait(settleMs);
        const after = readProcessTree(platform, deps.readTree);
        const survivors = after === null ? [] : after.filter((r) => r.pid === rootPid);
        return {
            rootPid,
            snapshot: [],
            groups: [],
            refusedGroups: [],
            survivorsBeforeSweep: survivors,
            survivors,
            ok: survivors.length === 0,
            detail: plan.detail
        };
    }

    const before = readProcessTree(platform, deps.readTree);
    if (before === null) {
        return {
            rootPid, snapshot: [], groups: [], refusedGroups: [],
            survivorsBeforeSweep: [], survivors: [],
            ok: false,
            detail: 'this platform reports no process table and has no whole-tree command, so a ' +
                'teardown here cannot be verified and must not be claimed.'
        };
    }

    // 1. Snapshot, while the parent chain still exists.
    const snapshot = snapshotTree(before, rootPid);

    // 2. Collect the distinct groups. On the run that found this, two.
    const candidateGroups = groupsIn(snapshot);

    // 3. Refuse any group that would take Stafford with it. A managed child is spawned into
    //    its own group precisely so this never fires; if it does, the spawn site is the bug
    //    and this line is the only thing standing between that bug and a dead app.
    const selfRow = find(before, selfPid);
    const { safe: groups, refused: refusedGroups } = partitionGroups(candidateGroups, selfRow?.pgid ?? null);

    if (refusedGroups.length > 0) {
        warn(
            'kill-tree refused to kill ' + refusedGroups.length + ' group(s) containing Stafford ' +
            'itself: pgid ' + refusedGroups.join(', ') + ', own pgid ' + String(selfRow?.pgid ?? 'unknown') +
            ', root pid ' + String(rootPid) + '. The child was spawned without its own process ' +
            'group, so its tree cannot be reaped by group here.'
        );
    }

    // The pids and groups actually targeted, so a teardown is inspectable after the fact
    // rather than only when it goes wrong. Numbers only, no command names, no paths.
    warn(
        'kill-tree root ' + String(rootPid) + ' targeting pgid [' + groups.join(', ') + '] over pids [' +
        snapshot.map((r) => r.pid).join(', ') + ']'
    );

    // 4. Kill each surviving candidate group, not only the root's.
    for (const pgid of groups) run(plan.group(pgid, signal));
    await wait(settleMs);

    // 5. Re-walk and sweep survivors by pid, for anything that changed group
    //    between the snapshot and the kill. This is also what reaps a child whose
    //    group was refused above: by pid, exactly, never by group.
    const mid = readProcessTree(platform, deps.readTree) ?? [];
    const survivorsBeforeSweep = snapshot
        .map((row) => find(mid, row.pid))
        .filter((row): row is ProcessRow => row !== null);

    // Belt and braces. Stafford is the parent of the root, so it cannot be a descendant and
    // cannot appear here. Checking anyway costs one comparison, and the whole reason this
    // guard exists is that an assumption about the process tree turned out to be wrong once.
    for (const row of survivorsBeforeSweep) {
        if (row.pid === selfPid) continue;
        run(plan.process(row.pid, signal));
    }
    if (survivorsBeforeSweep.length > 0) await wait(settleMs);

    // 6. Verify. Part of the procedure rather than a caller's good intentions.
    const after = readProcessTree(platform, deps.readTree) ?? [];
    const survivors = snapshot
        .map((row) => find(after, row.pid))
        .filter((row): row is ProcessRow => row !== null);

    return {
        rootPid,
        snapshot,
        groups,
        refusedGroups,
        survivorsBeforeSweep,
        survivors,
        ok: survivors.length === 0,
        detail: plan.detail
    };
}
