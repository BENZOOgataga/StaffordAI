/**
 * The process-tree reader, tested against listings rather than a real machine.
 *
 * The questions here decide whether `kill -9 -<pid>` reaches a tool child, and
 * both failure modes are silent: a kill that misses still returns, and the only
 * symptom is a process nobody is attached to. So the sibling case and the
 * separate-group case are asserted explicitly rather than left to the one real
 * run that happens to exercise them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseProcessTree, isDescendantOf, find, inGroup, descendantsMatching, readProcessTree
} from './process-tree.ts';
import { darwin, linux, win32 } from '../platform/index.ts';

const LISTING = [
    '    1     0     1 launchd',
    '  500     1   500 login',
    '  600   500   600 claude',
    '  700   600   600 bash',
    '  800   700   600 sleep',
    '  900     1   900 unrelated',
    ' 1000   900   900 sleep'
].join('\n');

test('a listing parses into pid, parent, group and command', () => {
    const rows = parseProcessTree(LISTING);
    assert.equal(rows.length, 7);
    assert.deepEqual(rows[4], { pid: 800, ppid: 700, pgid: 600, command: 'sleep' });
});

test('a line that is not a process is dropped rather than parsed into zeroes', () => {
    const rows = parseProcessTree('  PID  PPID  PGID COMMAND\n' + LISTING + '\n\n');
    assert.equal(rows.length, 7);
    assert.ok(rows.every((row) => row.pid > 0));
});

test('a descendant is found through the parent chain, and a sibling is not', () => {
    const rows = parseProcessTree(LISTING);

    // Two hops: sleep 800 to bash 700 to claude 600.
    assert.equal(isDescendantOf(rows, 800, 600), true);

    // The whole point. 1000 is also called sleep, is also in a group, and has
    // nothing to do with the session. A check by name alone would accept it.
    assert.equal(isDescendantOf(rows, 1000, 600), false);
});

test('descendants are matched by walking the tree, never by command name alone', () => {
    const rows = parseProcessTree(LISTING);
    const found = descendantsMatching(rows, 600, /(^|\/)sleep\b/);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.pid, 800);
});

test('the group is what the kill reaches, so it is asked for directly', () => {
    const rows = parseProcessTree(LISTING);
    assert.deepEqual(inGroup(rows, 600).map((r) => r.pid), [600, 700, 800]);
    assert.deepEqual(inGroup(rows, 900).map((r) => r.pid), [900, 1000]);
});

test('a child outside the session group is visible, which is the case that orphans it', () => {
    // Same tree, except the child was given its own process group. It is still
    // a descendant, so a parent-chain check alone would pass it, and
    // kill -9 -600 would never touch it.
    const rows = parseProcessTree(LISTING.replace('  800   700   600 sleep', '  800   700   800 sleep'));
    assert.equal(isDescendantOf(rows, 800, 600), true);
    assert.equal(find(rows, 800)?.pgid, 800);
    assert.equal(inGroup(rows, 600).some((r) => r.pid === 800), false);
});

test('a cycle in the listing terminates rather than spinning', () => {
    const rows = parseProcessTree(['  10    20    10 a', '  20    10    10 b'].join('\n'));
    assert.equal(isDescendantOf(rows, 10, 999), false);
});

test('the command comes from the platform, and Windows has no answer to give', () => {
    for (const platform of [darwin, linux]) {
        const spec = platform.processTreeCommand();
        assert.ok(spec, platform.id + ' must name a command');
        assert.equal(spec.file, 'ps');
        // The columns are fixed by the command, which is what lets one parser
        // serve every platform that answers.
        assert.ok(spec.args.some((a) => a.includes('pgid')), 'the group must be one of the columns');
    }

    // Not a gap. taskkill /T walks parent to child and does not depend on a
    // shared process group, so there is no assumption here to check.
    assert.equal(win32.processTreeCommand(), null);
    assert.equal(readProcessTree(win32, () => { throw new Error('must not run'); }), null);
});

test('reading uses the platform command and nothing else', () => {
    const calls: string[] = [];
    const rows = readProcessTree(darwin, (file, args) => {
        calls.push(file + ' ' + args.join(' '));
        return LISTING;
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? '', /^ps /);
    assert.equal(rows?.length, 7);
});
