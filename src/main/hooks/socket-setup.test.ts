import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSocket, prepareSocketFor, SocketModeError, type SocketFs } from './socket-setup.ts';
import { currentPlatform } from '../platform/index.ts';
import { darwin } from '../platform/darwin.ts';
import { win32 } from '../platform/win32.ts';
import { linux } from '../platform/linux.ts';

/** A filesystem that records what was done to it, so nothing touches a disk. */
function fakeFs(initial: { dirs?: Record<string, number>; files?: string[] } = {}) {
    const dirs: Record<string, number> = { ...(initial.dirs ?? {}) };
    const files = new Set(initial.files ?? []);
    const calls: string[] = [];
    const fs: SocketFs & { calls: string[]; dirs: Record<string, number>; files: Set<string> } = {
        calls, dirs, files,
        existsSync(p: string) { return p in dirs || files.has(p); },
        mkdirSync(p: string) { calls.push('mkdir ' + p); dirs[p] = 0o755; return p; },
        chmodSync(p: string, mode: number) { calls.push('chmod ' + mode.toString(8) + ' ' + p); dirs[p] = mode; },
        statSync(p: string) { return { mode: dirs[p] ?? 0o644 }; },
        unlinkSync(p: string) { calls.push('unlink ' + p); files.delete(p); }
    };
    return fs;
}

const PLAN = darwin.hookSocket('Stafford', '/Users/x');

test('the directory is created when it does not exist, and the mode applied after', () => {
    const fs = fakeFs();
    const report = prepareSocket(PLAN, fs);

    assert.equal(report.created, true);
    assert.equal(report.modeBefore, null);
    assert.equal(report.modeAfter, 0o700);

    // chmod after mkdir, not a mode argument to mkdir: mkdir's mode is masked
    // by umask and this is the one place that must not depend on it.
    assert.deepEqual(fs.calls, ['mkdir ' + PLAN.parentDir, 'chmod 700 ' + PLAN.parentDir]);
});

test('an existing directory left at 0755 is corrected rather than trusted', () => {
    const fs = fakeFs({ dirs: { [PLAN.parentDir as string]: 0o755 } });
    const report = prepareSocket(PLAN, fs);

    assert.equal(report.created, false, 'it already existed, so nothing is created');
    assert.equal(report.modeBefore, 0o755);
    assert.equal(report.modeAfter, 0o700);
    assert.ok(fs.calls.includes('chmod 700 ' + PLAN.parentDir));
});

test('the mode is asserted on every startup, not only at creation', () => {
    // The failure this is written for: mkdirSync with a mode does nothing at
    // all when the directory already exists, so a directory left at 0755 by an
    // earlier version or a restore stays 0755 forever.
    const dir = PLAN.parentDir as string;
    const fs = fakeFs({ dirs: { [dir]: 0o755 } });

    prepareSocket(PLAN, fs);
    assert.equal(fs.dirs[dir], 0o700);

    // Second startup, already correct, still checked.
    const second = fakeFs({ dirs: { [dir]: 0o700 } });
    const report = prepareSocket(PLAN, second);
    assert.equal(report.modeBefore, 0o700);
    assert.ok(second.calls.includes('chmod 700 ' + dir), 'the check runs even when nothing needs changing');
});

test('a mode that will not take refuses to start rather than continuing', () => {
    const dir = PLAN.parentDir as string;
    const fs = fakeFs({ dirs: { [dir]: 0o755 } });
    // A filesystem that accepts the call and changes nothing, which is what a
    // mounted volume with no POSIX modes does.
    fs.chmodSync = () => { /* silently ignored */ };

    assert.throws(() => prepareSocket(PLAN, fs), (err: unknown) => {
        assert.ok(err instanceof SocketModeError);
        assert.equal(err.expected, 0o700);
        assert.equal(err.actual, 0o755);
        assert.match(err.message, /Refusing to start/);
        assert.match(err.message, /worse than no hook socket/);
        return true;
    });
});

test('a stale socket file is removed, because it blocks the next bind', () => {
    const fs = fakeFs({ dirs: { [PLAN.parentDir as string]: 0o700 }, files: [PLAN.path] });
    const report = prepareSocket(PLAN, fs);

    assert.equal(report.staleRemoved, true);
    assert.ok(fs.calls.includes('unlink ' + PLAN.path));
    assert.equal(fs.files.has(PLAN.path), false);
});

test('nothing is removed when there is no stale file', () => {
    const fs = fakeFs({ dirs: { [PLAN.parentDir as string]: 0o700 } });
    const report = prepareSocket(PLAN, fs);
    assert.equal(report.staleRemoved, false);
    assert.equal(fs.calls.some((c) => c.startsWith('unlink')), false);
});

test('a pipe platform takes the early return and touches no filesystem', () => {
    const fs = fakeFs();
    const report = prepareSocket(win32.hookSocket('Stafford', 'C:\\Users\\x'), fs);

    assert.equal(report.parentDir, null);
    assert.equal(report.modeAfter, null);
    assert.deepEqual(fs.calls, [], 'a named pipe has no directory to create and leaves no file');
});

// @real-machine
test('on this machine, the plan the platform returns can actually be prepared', () => {
    // Runs against the real platform rather than a fixture, without touching
    // the real directory: the plan is redirected under a scratch path.
    const platform = currentPlatform();
    const real = platform.hookSocket('Stafford', '/tmp/stafford-selftest-home');
    const fs = fakeFs();

    const report = prepareSocket(real, fs);
    if (real.parentDir === null) {
        assert.equal(report.parentDir, null);
    } else {
        assert.equal(report.created, true);
        assert.equal(report.modeAfter, real.parentMode);
    }
});

test('prepareSocketFor asks the platform where the socket goes and prepares it', () => {
    const fs = fakeFs();
    const { plan, report } = prepareSocketFor(darwin, { appId: 'Stafford', home: '/Users/x' }, fs);

    assert.equal(plan.path, PLAN.path, 'the plan comes from the platform, not from the caller');
    assert.equal(report.created, true);
    assert.equal(report.modeAfter, 0o700);
});

test('the socket directory is the app data directory, not a second definition of it', () => {
    // Two independently computed paths for where Stafford's data lives diverge
    // the first time either changes. darwin derives one from the other.
    const home = '/Users/x';
    assert.equal(darwin.hookSocket('Stafford', home).parentDir, darwin.appDataDir(home, 'Stafford'));

    // linux deliberately differs: XDG separates runtime state from data.
    assert.notEqual(linux.hookSocket('Stafford', home).parentDir, linux.appDataDir(home, 'Stafford'));
});
