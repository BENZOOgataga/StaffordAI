/**
 * The teardown procedure, tested against the tree that actually defeated the
 * old one.
 *
 * The numbers here are the measured ones from 2026-08-08, so the regression
 * test is the incident rather than an invented shape: session 76638 leading its
 * own group, the Bash tool under a zsh wrapper at 77277 leading a second group,
 * and the tool child 77302 inside that second group.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { killTree, snapshotTree, groupsIn, partitionGroups } from './kill-tree.ts';
import { parseProcessTree } from './process-tree.ts';
import { darwin, win32 } from '../platform/index.ts';
import type { CommandSpec } from '../platform/types.ts';

/** The real tree, as `ps` reported it. */
const MEASURED = [
    '    1     0     1 launchd',
    '76637 76000 76637 node',
    '76638 76637 76638 claude',
    '77277 76638 77277 /bin/zsh',
    '77302 77277 77277 tail'
].join('\n');

const noWait = async () => {};

/** Kills for real against a mutable listing, so survival is observable. */
function machine(initial: string) {
    let rows = parseProcessTree(initial);
    const ran: string[] = [];
    return {
        ran,
        run(spec: CommandSpec) {
            ran.push(spec.file + ' ' + spec.args.join(' '));
            const target = spec.args[1] ?? '';
            if (target.startsWith('-')) {
                const pgid = Number(target.slice(1));
                rows = rows.filter((r) => r.pgid !== pgid);
            } else {
                const pid = Number(target);
                rows = rows.filter((r) => r.pid !== pid);
            }
        },
        read: () => rows.map((r) => [r.pid, r.ppid, r.pgid, r.command].join(' ')).join('\n')
    };
}

test('the snapshot is the root and its descendants, and nothing else', () => {
    const rows = parseProcessTree(MEASURED);
    const snap = snapshotTree(rows, 76638);
    assert.deepEqual(snap.map((r) => r.pid), [76638, 77277, 77302]);
    assert.ok(!snap.some((r) => r.pid === 76637), 'the parent of the session is not part of its tree');
});

test('the groups collected are every group in the tree, not the root group', () => {
    const snap = snapshotTree(parseProcessTree(MEASURED), 76638);
    assert.deepEqual(groupsIn(snap), [76638, 77277]);
});

test('the measured tree is torn down completely, which the single command did not do', async () => {
    const m = machine(MEASURED);
    const report = await killTree(darwin, 76638, { run: m.run, readTree: () => m.read(), waitMs: noWait });

    assert.deepEqual(report.groups, [76638, 77277]);
    assert.deepEqual(report.survivors, [], 'nothing may survive');
    assert.equal(report.ok, true);

    // The old behaviour, stated so the regression is unmistakable: killing only
    // the session's group leaves the tool child running.
    assert.ok(m.ran.includes('kill -KILL -77277'), 'the wrapper group must be killed too');
});

test('killing only the root group is exactly the defect, and is asserted as such', async () => {
    // Simulates the old single-command behaviour against the same tree.
    const m = machine(MEASURED);
    m.run(darwin.killTreePlan(76638).group(76638, 'KILL'));

    const left = parseProcessTree(m.read());
    assert.ok(left.some((r) => r.pid === 77302), 'the tool child survives a root-group kill');
    assert.ok(!left.some((r) => r.pid === 76638), 'while the session itself dies');
});

test('a survivor that changed group after the snapshot is swept by pid', async () => {
    // The window the plan's `gap` names. The snapshot sees the child in the
    // wrapper's group; by the time the kills land it has moved to a group of
    // its own, so no group kill can reach it and only the pid sweep does.
    const MOVED = MEASURED.replace('77302 77277 77277 tail', '77302 77277 99999 tail');
    let reads = 0;
    // The machine already has the child in its new group. The snapshot below
    // is served the stale view, which is exactly what a real race looks like.
    let state = parseProcessTree(MOVED);

    const report = await killTree(darwin, 76638, {
        run: (spec) => {
            const target = spec.args[1] ?? '';
            if (target.startsWith('-')) {
                const pgid = Number(target.slice(1));
                state = state.filter((r) => r.pgid !== pgid);
            } else {
                state = state.filter((r) => r.pid !== Number(target));
            }
        },
        readTree: () => {
            reads += 1;
            // The first read is the snapshot. Everything after it sees the
            // child in its new group.
            if (reads === 1) return MEASURED;
            return state.map((r) => [r.pid, r.ppid, r.pgid, r.command].join(' ')).join('\n');
        },
        waitMs: noWait
    });

    assert.ok(
        report.survivorsBeforeSweep.some((r) => r.pid === 77302),
        'the group kills cannot reach a process that left the group'
    );
    assert.deepEqual(report.survivors, [], 'the pid sweep is what catches this one');
    assert.equal(report.ok, true);
});

test('a survivor that outlives everything is reported rather than glossed', async () => {
    // Nothing dies. The procedure must say so instead of returning ok.
    const rows = MEASURED;
    const report = await killTree(darwin, 76638, {
        run: () => {},
        readTree: () => rows,
        waitMs: noWait
    });

    assert.equal(report.ok, false);
    assert.deepEqual(report.survivors.map((r) => r.pid), [76638, 77277, 77302]);
});

test('windows uses its one command and never asks for a process table', async () => {
    const ran: string[] = [];
    const report = await killTree(win32, 4242, {
        run: (spec) => { ran.push(spec.file + ' ' + spec.args.join(' ')); },
        readTree: () => { throw new Error('windows must not read a process table'); },
        waitMs: noWait
    });

    assert.deepEqual(ran, ['taskkill /PID 4242 /T /F']);
    assert.equal(report.ok, true);
    assert.deepEqual(report.groups, [], 'there are no groups to collect here');
});

test('a platform with no process table and no whole-tree command refuses to claim success', async () => {
    // The honest answer when neither route exists. Reporting ok here would be
    // a teardown that was never verified being read as one that worked.
    const broken = { ...darwin, processTreeCommand: () => null };
    const report = await killTree(broken, 1234, { run: () => {}, waitMs: noWait });
    assert.equal(report.ok, false);
    assert.match(report.detail, /cannot be verified/);
});

/**
 * The self-group guard.
 *
 * killTree kills every process group in its snapshot, which is only safe while the snapshot
 * root leads a group of its own. Managed children now do, but that has to hold at every
 * spawn site, and one missed site used to mean a dead app. These cover the line that turns
 * a missed site into a warning and an unreaped child instead.
 */

test('a group containing Stafford is refused, and the rest are still killed', () => {
    const { safe, refused } = partitionGroups([500, 900], 500);
    assert.deepEqual(refused, [500], 'our own group must never be killed');
    assert.deepEqual(safe, [900], 'refusing one group must not abandon the others');
});

test('init and the zero group are refused, since kill(0) means the callers own group', () => {
    const { safe, refused } = partitionGroups([0, 1, 42], 999);
    assert.deepEqual(refused, [0, 1]);
    assert.deepEqual(safe, [42]);
});

test('an unknown self group refuses nothing, so a guard that cannot tell does not stop the reap', () => {
    const { safe, refused } = partitionGroups([500, 900], null);
    assert.deepEqual(refused, []);
    assert.deepEqual(safe, [500, 900],
        'refusing on unknown would silently stop reaping every child, which is worse than the risk');
});

test('killTree refuses the self group end to end, and reaps the child by exact pid instead', async () => {
    // The defect's exact shape: the child (7) sits in Stafford's group (100), because it was
    // spawned without its own. Stafford is pid 5.
    const rows = [
        { pid: 5, ppid: 1, pgid: 100, command: 'stafford' },
        { pid: 7, ppid: 5, pgid: 100, command: 'claude' }
    ];
    const ran: string[] = [];

    const report = await killTree(
        darwin, 7,
        {
            selfPid: 5,
            readTree: () => rows.map((r) => `${r.pid} ${r.ppid} ${r.pgid} ${r.command}`).join('\n'),
            run: (spec) => { ran.push([spec.file, ...spec.args].join(' ')); },
            waitMs: () => Promise.resolve(),
            warn: () => { /* quiet */ }
        }
    );

    assert.deepEqual(report.refusedGroups, [100]);
    assert.deepEqual(report.groups, [], 'there was nothing safe to kill by group');
    assert.ok(!ran.some((c) => c.includes('-100')),
        'the whole point: no command may target the group Stafford is in. Ran: ' + JSON.stringify(ran));
    assert.ok(ran.some((c) => c === 'kill -KILL 7'),
        'the child is still reaped, by exact pid. Ran: ' + JSON.stringify(ran));
});
