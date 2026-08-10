import test from 'node:test';
import assert from 'node:assert/strict';
import {
    runSelfChecks, assertStartable, UnsupportedPlatformError, SelfCheckFailed,
    type SelfCheckFs
} from './self-check.ts';
import { darwin } from '../platform/darwin.ts';
import { win32 } from '../platform/win32.ts';
import { linux } from '../platform/linux.ts';
import { currentPlatform } from '../platform/index.ts';

const INPUT = { home: '/Users/x', appId: 'Stafford', claudePath: null };

function fakeFs(present: string[] = [], unwritable: string[] = []): SelfCheckFs {
    const files = new Set(present);
    const blocked = new Set(unwritable);
    return {
        existsSync(p: string) { return files.has(p); },
        accessSync(p: string) { if (blocked.has(p)) throw new Error('EACCES'); },
        mkdirSync(p: string) { files.add(p); return p; }
    };
}

test('every platform returns checks, and every check is run', () => {
    for (const platform of [darwin, win32, linux]) {
        const specs = platform.selfChecks(INPUT);
        const report = runSelfChecks(platform, INPUT, { fs: fakeFs(), canSpawnAndKill: () => true });
        assert.equal(report.results.length, specs.length, platform.id + ' ran every check it declared');
        assert.deepEqual(report.results.map((r) => r.name), specs.map((s) => s.name));
    }
});

test('a writable app data directory passes, and an unwritable one fails with the spec words', () => {
    const dir = darwin.appDataDir(INPUT.home, INPUT.appId);

    const ok = runSelfChecks(darwin, INPUT, { fs: fakeFs([dir]), canSpawnAndKill: () => true });
    assert.equal(ok.results.find((r) => r.kind === 'dir-writable')?.ok, true);

    const blocked = runSelfChecks(darwin, INPUT, { fs: fakeFs([dir], [dir]), canSpawnAndKill: () => true });
    const failed = blocked.results.find((r) => r.kind === 'dir-writable');
    assert.equal(failed?.ok, false);
    assert.match(failed?.detail ?? '', /database|socket|logs/i, 'a failure says the spec words, not a code');
});

test('any-file-exists is satisfied by any one candidate, and names which', () => {
    const candidates = darwin.claudeCandidates(INPUT.home);
    const second = candidates[1] as string;
    const report = runSelfChecks(darwin, INPUT, { fs: fakeFs([second]), canSpawnAndKill: () => true });
    const result = report.results.find((r) => r.kind === 'any-file-exists');

    assert.equal(result?.ok, true);
    assert.equal(result?.satisfiedBy, second, 'it says which one, so a failure elsewhere is diagnosable');
});

test('a missing claude binary fails and reports every location that was checked', () => {
    const report = runSelfChecks(darwin, INPUT, { fs: fakeFs(), canSpawnAndKill: () => true });
    const result = report.results.find((r) => r.kind === 'any-file-exists');

    assert.equal(result?.ok, false);
    assert.equal(result?.satisfiedBy, null);
    assert.deepEqual([...result?.checked ?? []], [...darwin.claudeCandidates(INPUT.home)]);
});

test('with no prober, spawn-and-kill is not checked rather than passed', () => {
    // The failure mode worth refusing: a check that quietly reports success
    // because nothing was supplied to run it is worse than no check.
    const report = runSelfChecks(darwin, INPUT, { fs: fakeFs() });
    const result = report.results.find((r) => r.kind === 'spawn-and-kill');

    assert.equal(result?.ok, false);
    assert.match(result?.detail ?? '', /not checked rather than passed/);
});

test('a prober that throws is a failure, not an exception out of the report', () => {
    const report = runSelfChecks(darwin, INPUT, {
        fs: fakeFs(),
        canSpawnAndKill: () => { throw new Error('no pty here'); }
    });
    assert.equal(report.results.find((r) => r.kind === 'spawn-and-kill')?.ok, false);
});

test('an unsupported platform refuses before any check runs', () => {
    assert.equal(linux.supported, false);

    // The report form says so without throwing.
    const report = runSelfChecks(linux, INPUT, { fs: fakeFs(), canSpawnAndKill: () => true });
    assert.equal(report.supported, false);
    assert.equal(report.ok, false, 'every check can pass and it is still not startable');

    // The refusing form throws, and says why rather than which check failed.
    assert.throws(() => assertStartable(linux, INPUT, { fs: fakeFs(), canSpawnAndKill: () => true }),
        (err: unknown) => {
            assert.ok(err instanceof UnsupportedPlatformError);
            assert.match(err.message, /never been exercised on real hardware/);
            assert.match(err.message, /half-working is worse than refusing/);
            return true;
        });
});

test('assertStartable names every failure, which is what the deferral relied on', () => {
    // This is the guard the macOS deferral was justified by: fail loudly and
    // name what could not be confirmed.
    assert.throws(() => assertStartable(darwin, INPUT, { fs: fakeFs() }), (err: unknown) => {
        assert.ok(err instanceof SelfCheckFailed);
        assert.ok(err.failures.length >= 2, 'more than one thing is wrong and it says all of them');
        assert.match(err.message, /Refusing to start/);
        assert.match(err.message, /checked:/, 'a failure lists what was looked at');
        return true;
    });
});

test('a fully satisfied platform is startable', () => {
    const dir = darwin.appDataDir(INPUT.home, INPUT.appId);
    const claude = darwin.claudeCandidates(INPUT.home)[0] as string;
    const report = assertStartable(darwin, INPUT, {
        fs: fakeFs([dir, claude]),
        canSpawnAndKill: () => true
    });
    assert.equal(report.ok, true);
    assert.equal(report.failures.length, 0);
});

// @real-machine
test('on this machine, the real platform declares checks and they can be run', () => {
    const platform = currentPlatform();
    const report = runSelfChecks(platform, INPUT, { fs: fakeFs(), canSpawnAndKill: () => true });
    assert.ok(report.results.length > 0, 'a platform with no self checks proves nothing at startup');
    assert.equal(report.platform, platform.id);
});
