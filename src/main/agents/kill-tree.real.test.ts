/**
 * killTree reaps a real grandchild process, on this machine, including Windows.
 *
 * The question this settles: node-pty #886 can leave console grandchildren
 * orphaned on a Windows session kill, and Stafford has killTree whose whole
 * purpose is reaping a tree the session's own kill missed. So does killTree
 * actually kill a grandchild that leads its own process group, on the platform
 * that matters.
 *
 * It spawns a real process tree with child_process rather than a pty, because
 * killTree operates on a pid and knows nothing about ptys, and using a pty here
 * would drag in node-pty's own kill path, which is the #886 fork this is meant
 * to be independent of. A grandchild is spawned detached so it leads its own
 * process group, which is exactly the shape killTree exists for: on POSIX its
 * group is collected from the snapshot, and on Windows taskkill /T walks the
 * parent-child tree to it.
 *
 * It runs on Windows and macOS CI both, because it needs no pty. That is the
 * point: a test that only ran on darwin would prove nothing about the Windows
 * exposure.
 *
 * What it does NOT prove: that anything calls killTree on a real session
 * teardown today. It does not. killTree is invoked only by the 6c harness, and
 * PtySession.kill goes straight to node-pty. So this establishes that the
 * mechanism reaps grandchildren, and wiring it into teardown is the fix for the
 * runtime orphan, not a change to node-pty.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { currentPlatform } from '../platform/index.ts';
import { killTree } from './kill-tree.ts';

const PLATFORM = currentPlatform();

/** True while the pid exists. Signal 0 checks existence without killing. */
function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // ESRCH means gone. EPERM means alive but not ours to signal, which
        // does not happen for our own children.
        return (error as { code?: string }).code === 'EPERM';
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref(); });
}

// A parent process that spawns a detached, long-lived grandchild and prints its
// pid. Both outlive the spawn so the tree is alive when killTree runs.
const PARENT_SCRIPT = `
const cp = require('child_process');
const grand = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
    detached: true, stdio: 'ignore'
});
process.stdout.write('GPID=' + grand.pid + '\\n');
setInterval(() => {}, 1e9);
`;

// @real-machine
test('killTree reaps a detached grandchild, not just the root', async () => {
    // The root is spawned detached so it leads its own process group. This is
    // not a detail: killTree kills every group in the tree, so a root sharing
    // the test runner's group would take the runner down with it. The runner
    // spawns real agents into their own group for exactly this reason, and the
    // test has to match that or it kills itself, which it did once before this
    // line was added.
    const parent = spawn(process.execPath, ['-e', PARENT_SCRIPT], {
        stdio: ['ignore', 'pipe', 'ignore'], detached: true
    });
    parent.unref();
    const parentPid = parent.pid ?? 0;

    // Read the grandchild pid the parent prints.
    const grandPid = await new Promise<number>((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error('parent never printed a grandchild pid')), 10_000);
        timer.unref();
        parent.stdout.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            const match = /GPID=(\d+)/.exec(buffer);
            if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
    });

    assert.ok(parentPid > 0 && grandPid > 0, 'both pids must be real');
    assert.ok(isAlive(parentPid), 'the parent must be alive before teardown');
    assert.ok(isAlive(grandPid), 'the grandchild must be alive before teardown');

    // Stafford's tree teardown, against the root. The grandchild leads its own
    // group and is a descendant, so it is exactly what killTree is for.
    await killTree(PLATFORM, parentPid);

    // Give the OS a moment to reap after the kill returns.
    for (let i = 0; i < 20 && isAlive(grandPid); i += 1) await sleep(100);

    assert.equal(isAlive(grandPid), false,
        'the grandchild survived killTree, so a session teardown wired through it would orphan it');
    assert.equal(isAlive(parentPid), false, 'the root survived killTree');
});
