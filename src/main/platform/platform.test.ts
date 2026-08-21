import test from 'node:test';
import assert from 'node:assert/strict';
import {
    win32, darwin, linux,
    platformFor, currentPlatform, isPlatformId,
    pathsEqual, firstExisting, findPosixShell, assertSupported
} from './index.ts';
import type { Platform } from './types.ts';

const ALL: readonly Platform[] = [win32, darwin, linux];
const HOME = { win32: 'C:\\Users\\someone', posix: '/Users/someone' };

function inputs(platform: Platform) {
    const home = platform.id === 'win32' ? HOME.win32 : HOME.posix;
    return {
        home,
        nodeDir: platform.id === 'win32' ? 'C:\\Program Files\\nodejs' : '/usr/local/bin',
        parentPath: platform.id === 'win32' ? 'C:\\Windows;D:\\Portable\\Git\\cmd' : '/usr/bin:/bin'
    };
}

function existsOnly(...paths: string[]) {
    const set = new Set(paths.map((p) => p.toLowerCase()));
    return (p: string) => set.has(String(p).toLowerCase());
}

// ---------------------------------------------------------------------------
// Totality. The interface exists in full on every platform, or it is not an
// interface, it is a suggestion with holes that callers fill with if statements.
// ---------------------------------------------------------------------------

test('every platform implements every member', () => {
    const members = [
        'inheritedEnvKeys', 'pathDirectories', 'posixShellCandidates',
        'shellRegistryLookups', 'shellPathDirectories', 'executableName',
        'claudeCandidates', 'killTreePlan', 'normalisePath', 'appDataDir', 'selfChecks'
    ] as const;

    for (const platform of ALL) {
        for (const member of members) {
            assert.equal(
                typeof platform[member], 'function',
                platform.id + ' is missing ' + member
            );
        }
        assert.equal(typeof platform.id, 'string');
        assert.equal(typeof platform.supported, 'boolean');
    }
});

test('no member returns undefined on any platform', () => {
    // An optional member and a member that returns nothing are the same problem
    // wearing different clothes.
    for (const platform of ALL) {
        const input = inputs(platform);
        const answers: Record<string, unknown> = {
            inheritedEnvKeys: platform.inheritedEnvKeys(),
            pathDirectories: platform.pathDirectories(input),
            posixShellCandidates: platform.posixShellCandidates(input),
            shellRegistryLookups: platform.shellRegistryLookups(),
            shellPathDirectories: platform.shellPathDirectories('/bin/bash'),
            executableName: platform.executableName('claude'),
            claudeCandidates: platform.claudeCandidates(input.home),
            killTreePlan: platform.killTreePlan(1234).detail,
            normalisePath: platform.normalisePath('/a/B/'),
            appDataDir: platform.appDataDir(input.home, 'stafford'),
            selfChecks: platform.selfChecks({ home: input.home, appId: 'stafford', claudePath: null })
        };

        for (const [name, value] of Object.entries(answers)) {
            assert.notEqual(value, undefined, platform.id + '.' + name + ' returned undefined');
            assert.notEqual(value, null, platform.id + '.' + name + ' returned null');
        }
    }
});

test('environment allowlists are disjoint where the platforms genuinely differ', () => {
    const w = new Set(win32.inheritedEnvKeys());
    const d = new Set(darwin.inheritedEnvKeys());

    assert.ok(w.has('SystemRoot') && w.has('COMSPEC') && w.has('PATHEXT'));
    assert.ok(!d.has('SystemRoot'), 'SystemRoot is meaningless on macOS');
    assert.ok(d.has('HOME') && d.has('SHELL') && d.has('TMPDIR'));
    assert.ok(!w.has('HOME'), 'Windows uses USERPROFILE');
});

test('no allowlist carries anything that looks like a secret', () => {
    for (const platform of ALL) {
        for (const key of platform.inheritedEnvKeys()) {
            assert.doesNotMatch(key, /TOKEN|SECRET|KEY|PASSWORD|AUTH/i, platform.id + ' allowlists ' + key);
        }
    }
});

test('PATH is a list of absolute directories, in order, on every platform', () => {
    for (const platform of ALL) {
        const dirs = platform.pathDirectories(inputs(platform));
        assert.ok(dirs.length >= 4, platform.id + ' has a suspiciously short PATH');
        for (const dir of dirs) {
            const absolute = platform.id === 'win32' ? /^[A-Za-z]:\\/.test(dir) : dir.startsWith('/');
            assert.ok(absolute, platform.id + ' PATH entry is not absolute: ' + dir);
        }
    }
});

test('macOS PATH carries both homebrew prefixes, in arm64-first order', () => {
    const dirs = darwin.pathDirectories(inputs(darwin));
    assert.ok(dirs.indexOf('/opt/homebrew/bin') < dirs.indexOf('/usr/local/bin'));
});

test('the claude candidate list matches the platform', () => {
    assert.deepEqual(win32.claudeCandidates(HOME.win32), ['C:\\Users\\someone\\.local\\bin\\claude.exe']);

    const mac = darwin.claudeCandidates(HOME.posix);
    assert.equal(mac[0], '/Users/someone/.local/bin/claude', 'the user profile is checked first');
    assert.ok(mac.includes('/opt/homebrew/bin/claude'), 'arm64 homebrew');
    assert.ok(mac.includes('/usr/local/bin/claude'), 'intel homebrew');
});

test('executable naming follows the platform', () => {
    assert.equal(win32.executableName('claude'), 'claude.exe');
    assert.equal(darwin.executableName('claude'), 'claude');
    assert.equal(linux.executableName('claude'), 'claude');
});

test('kill plans are specifications, not actions', () => {
    // Asserting on darwin's plan from a Windows machine is the payoff for the
    // interface returning data rather than doing work.
    const w = win32.killTreePlan(4242);
    assert.deepEqual(w.wholeTree, { file: 'taskkill', args: ['/PID', '4242', '/T', '/F'] });
    assert.equal(w.snapshotBeforeKill, false, 'taskkill /T walks the tree itself');
    assert.equal(w.killsEveryGroup, false, 'there are no process groups to collect');

    for (const platform of [darwin, linux]) {
        const p = platform.killTreePlan(4242);
        assert.equal(p.wholeTree, null, platform.id + ' has no single command that does this');
        assert.equal(p.snapshotBeforeKill, true, 'the parent chain is gone once the root dies');
        assert.equal(p.killsEveryGroup, true, 'the tool child was not in the session group');
        assert.deepEqual(p.group(77277, 'KILL'), { file: 'kill', args: ['-KILL', '-77277'] });
        assert.deepEqual(p.process(77302, 'TERM'), { file: 'kill', args: ['-TERM', '77302'] });
    }
});

test('the owner-only ACL plan is a Windows icacls command and null on POSIX', () => {
    // A file: reset inheritance, grant only the owner, no container flags.
    assert.deepEqual(
        win32.ownerOnlyAclPlan('C:\\cfg\\.credentials.json', { tree: false, account: 'MIN\\Morice_L' }),
        { file: 'icacls', args: ['C:\\cfg\\.credentials.json', '/inheritance:r', '/grant:r', 'MIN\\Morice_L:F', '/C', '/Q'] }
    );
    // A directory: (OI)(CI) so children inherit, and /T to reapply to existing ones.
    assert.deepEqual(
        win32.ownerOnlyAclPlan('C:\\cfg', { tree: true, account: 'MIN\\Morice_L' }),
        { file: 'icacls', args: ['C:\\cfg', '/inheritance:r', '/grant:r', 'MIN\\Morice_L:(OI)(CI)F', '/C', '/Q', '/T'] }
    );
    // POSIX has real mode bits; the seed's chmod is the whole guarantee, no command.
    for (const platform of [darwin, linux]) {
        assert.equal(platform.ownerOnlyAclPlan('/cfg/.credentials.json', { tree: false, account: 'me' }), null,
            platform.id + ' secures the path with chmod, not a command');
    }
});

/**
 * The regression, stated as the thing that was actually wrong.
 *
 * The old member returned `kill -9 -<session pid>` and that reached a group
 * containing only the session, because Claude Code's Bash tool runs under a
 * wrapper leading its own group. Measured 2026-08-08: session pgid 76638, tool
 * child pgid 77277, kill returned success, child kept running.
 */
test('the posix plan cannot express itself as one command, which is why it is a plan', () => {
    for (const platform of [darwin, linux]) {
        const plan = platform.killTreePlan(76638);

        // The old shape. If a single command ever comes back here, it will be
        // this one, and it is the one that orphaned a process.
        assert.equal(plan.wholeTree, null);

        // The group killed is whichever the snapshot found, never assumed to be
        // the root's. Passing the wrapper's group must produce the wrapper's
        // kill rather than the session's.
        assert.deepEqual(plan.group(77277, 'KILL'), { file: 'kill', args: ['-KILL', '-77277'] });
        assert.notDeepEqual(plan.group(77277, 'KILL'), plan.group(76638, 'KILL'));

        // The window between snapshot and kill is named rather than implied.
        assert.match(plan.gap, /window/i, platform.id + ' must say what it cannot guarantee');
    }
});

test('path comparison is case insensitive on windows and macos, sensitive on linux', () => {
    assert.equal(pathsEqual(win32, 'C:\\Git\\Stafford', 'c:/git/stafford/'), true);
    assert.equal(pathsEqual(darwin, '/Users/A/Repo', '/users/a/repo/'), true);
    assert.equal(pathsEqual(linux, '/home/a/Repo', '/home/a/repo'), false);
    assert.equal(pathsEqual(linux, '/home/a/repo/', '/home/a/repo'), true);
});

test('only windows has a registry to consult', () => {
    assert.equal(win32.shellRegistryLookups().length, 2);
    assert.equal(darwin.shellRegistryLookups().length, 0);
    assert.equal(linux.shellRegistryLookups().length, 0);
});

test('finding a shell adds directories on windows and none on posix', () => {
    assert.deepEqual(
        win32.shellPathDirectories('C:\\Program Files\\Git\\bin\\bash.exe'),
        ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\Git\\bin', 'C:\\Program Files\\Git\\usr\\bin']
    );
    assert.deepEqual(darwin.shellPathDirectories('/bin/bash'), []);
});

// ---------------------------------------------------------------------------
// The shared code, which is where the operating system actually gets touched
// ---------------------------------------------------------------------------

test('firstExisting walks the candidates in order', () => {
    const exists = existsOnly('/usr/local/bin/claude');
    assert.equal(firstExisting(darwin.claudeCandidates(HOME.posix), exists), '/usr/local/bin/claude');
    assert.equal(firstExisting(darwin.claudeCandidates(HOME.posix), () => false), null);
});

test('a shell is found through the registry on windows and directly on posix', () => {
    const custom = 'D:\\Git';
    const found = findPosixShell(
        win32,
        inputs(win32),
        existsOnly(custom + '\\bin\\bash.exe'),
        (key) => (key.startsWith('HKLM') ? custom : null)
    );
    assert.equal(found, custom + '\\bin\\bash.exe');

    // No registry, so the loop does not run and there is no platform branch.
    assert.equal(
        findPosixShell(darwin, inputs(darwin), existsOnly('/bin/bash'), () => null),
        '/bin/bash'
    );
});

test('a windows shell is still found from git.exe on the inherited PATH', () => {
    const found = findPosixShell(
        win32,
        { ...inputs(win32), parentPath: 'C:\\Windows;D:\\Portable\\Git\\cmd' },
        existsOnly('D:\\Portable\\Git\\bin\\bash.exe'),
        () => null
    );
    assert.equal(found, 'D:\\Portable\\Git\\bin\\bash.exe');
});

test('platform selection refuses an operating system it has no implementation for', () => {
    assert.equal(platformFor('win32').id, 'win32');
    assert.equal(currentPlatform('darwin').id, 'darwin');
    assert.throws(() => platformFor('aix'), /no platform implementation for "aix"/);
    assert.equal(isPlatformId('freebsd'), false);
});

test('linux is written, and refuses to run', () => {
    // Writing the third implementation is what turns "the interface is designed
    // for three" from a claim into a fact. Shipping it is a separate question.
    assert.equal(linux.supported, false);
    assert.equal(win32.supported, true);
    assert.equal(darwin.supported, true);

    assert.doesNotThrow(() => assertSupported(win32));
    assert.throws(() => assertSupported(linux), /does not support linux yet/);
});

test('self checks are specifications and name what to do when they fail', () => {
    for (const platform of ALL) {
        const checks = platform.selfChecks({ home: inputs(platform).home, appId: 'stafford', claudePath: null });
        assert.ok(checks.length >= 3, platform.id + ' checks too little');
        for (const check of checks) {
            assert.ok(check.name.length > 0);
            assert.ok(check.detail.length > 0, platform.id + '/' + check.name + ' does not say why it matters');
            assert.ok(['dir-writable', 'any-file-exists', 'spawn-and-kill'].includes(check.kind));
        }
    }
});

test('a supplied claude path replaces the candidate list in the self check', () => {
    const checks = darwin.selfChecks({ home: HOME.posix, appId: 'stafford', claudePath: '/opt/claude' });
    const binary = checks.find((c) => c.name === 'claude binary is present');
    assert.deepEqual(binary?.targets, ['/opt/claude']);
});

// ---------------------------------------------------------------------------
// The darwin markers, and the deadline on the transitional package.json
// ---------------------------------------------------------------------------

/**
 * Every member of the Platform interface has a caller.
 *
 * `SocketPlan` was a complete, correct description of the socket directory that
 * nothing consumed, and it was found five tasks later by a harness section going
 * red. `selfChecks` was worse: when macOS hardware was deferred, the stated
 * reason it was safe was that selfCheck would fail loudly on an unverified
 * platform and name what it could not confirm. That guard was specified and
 * never wired, so the safety of deferring rested on code that did not run.
 *
 * The interface makes this easy on purpose. It returns data wherever it can, and
 * **a well-specified return value that nobody calls looks exactly like one that
 * is wired in.** An instruction to audit periodically is the weakest form of
 * this test and would be skipped precisely when a task is busy adding members.
 *
 * An exemption is a deliberate act with a stated reason, the way adding a file
 * type to the tracked-paths allowlist is. If you are adding a name below to make
 * this pass, that is the test working.
 */
const CONSUMER_EXEMPT: Record<string, string> = {
    resizeObservation:
        'test-facing by design. It exists to tell a test which mechanism proves a resize on this ' +
        'platform, and there is no product code that should be asking.',
    appDataDir:
        'owed to Task 8, storage. Nothing should choose where the database lives before anything ' +
        'needs a database. Tracked as an owed item in docs/agents/HANDOFF.md.'
};

/**
 * A risk declared contained by a mechanism needs that mechanism to run.
 *
 * Section 8's macOS risk said "Contained by `selfCheck` and by refusing to start
 * rather than half working". `selfCheck` was specified on every platform and
 * executed by nothing, so for several tasks the safety of deferring macOS rested
 * on code that had never run. Nothing failed. Every other defect in this project
 * announced itself eventually; this one would have sat until someone read the
 * interface member by member, which is exactly what nobody does.
 *
 * **A test that a mechanism works is not a test that it runs.** `selfChecks` had
 * tests. Every platform returned well-formed specs and the tests proved it. What
 * no test asked was whether anything called them.
 *
 * So every backticked identifier in a "Contained by" claim must have a caller.
 * Prose is ignored: "refusing to start rather than half working" is a
 * description, not a symbol, and only symbols can be checked.
 */
test('every mechanism a risk is declared contained by has a caller', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    // fileURLToPath, not new URL(...).pathname. On Windows the latter yields
    // "/D:/a/..." with a leading slash, and resolving that against a drive
    // produces "D:\D:\a\...". Written on macOS, caught by the Windows job,
    // which is the only reason this file has two correct patterns to copy from
    // rather than three broken ones.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const srcRoot = path.resolve(here, '..', '..');
    const planPath = path.resolve(srcRoot, '..', 'docs', 'plans', 'stack-migration.technical.md');
    const plan = readFileSync(planPath, 'utf8');

    const claims = plan.split('\n').filter((line) => /ontained by/.test(line));
    assert.ok(claims.length > 0, 'no containment claims found, so this test is reading the wrong file');

    const cited = new Set<string>();
    for (const line of claims) {
        for (const match of line.matchAll(/`([A-Za-z][A-Za-z0-9_.]*)`/g)) {
            cited.add((match[1] as string).split('.')[0] as string);
        }
    }
    assert.ok(cited.size > 0, 'a containment claim cited no identifier, so nothing can be checked');

    function sources(dir: string, out: string[] = []): string[] {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { sources(full, out); continue; }
            if (!full.endsWith('.ts') || full.endsWith('.test.ts')) continue;
            out.push(full);
        }
        return out;
    }
    const body = sources(srcRoot).map((f) => readFileSync(f, 'utf8')).join('\n');

    // A mechanism is cited by name; the code may implement it under a close
    // name, so both the exact token and its lowercased stem count.
    const uncalled = [...cited].filter((name) => {
        const stem = name.replace(/s$/, '');
        return !body.includes(name) && !body.includes(stem);
    });

    assert.deepEqual(uncalled, [],
        'The plan says a risk is contained by ' + uncalled.join(', ') + ', and nothing under src/ ' +
        'references it. A risk contained by code that does not run is not contained. Either wire ' +
        'the mechanism in, or stop citing it as the containment.');
});

test('every Platform member has a consumer, or a named exemption', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    // fileURLToPath for the same Windows reason as the test above.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const srcRoot = path.resolve(here, '..', '..');
    const typesSource = readFileSync(path.join(here, 'types.ts'), 'utf8');

    // The Platform interface body, then the member names declared in it.
    const body = typesSource.slice(typesSource.indexOf('export interface Platform {'));
    const members = [...body.matchAll(/^    (?:readonly )?([a-zA-Z][a-zA-Z0-9]*)[(:]/gm)].map((m) => m[1] as string);
    assert.ok(members.length > 10, 'failed to parse the interface, so this test proves nothing');

    /** Every non-test file under src/ that is not a platform definition. */
    function candidates(dir: string, out: string[] = []): string[] {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { candidates(full, out); continue; }
            if (!full.endsWith('.ts')) continue;
            if (full.endsWith('.test.ts')) continue;
            const rel = path.relative(srcRoot, full);
            // The definitions themselves are not consumers. index.ts is, since
            // it is the shared code that does the work for every platform.
            if (/^main[/\\]platform[/\\](?!index\.ts)/.test(rel)) continue;
            out.push(full);
        }
        return out;
    }

    const sources = candidates(srcRoot).map((f) => readFileSync(f, 'utf8')).join('\n');

    const unconsumed = members.filter((m) => !CONSUMER_EXEMPT[m] && !sources.includes(m));
    assert.deepEqual(unconsumed, [],
        'Platform members with no caller under src/: ' + unconsumed.join(', ') + '. ' +
        'Either wire them in, or add them to CONSUMER_EXEMPT with a reason. A member nobody calls ' +
        'is a description, not a feature, and it reads identically to one that works.');

    // An exemption for a member that no longer exists is stale, and a stale
    // exemption is how a real hole gets hidden later.
    const stale = Object.keys(CONSUMER_EXEMPT).filter((m) => !members.includes(m));
    assert.deepEqual(stale, [], 'CONSUMER_EXEMPT names members that are not on the interface: ' + stale.join(', '));
});

test('every unverified darwin claim carries a marker pointing at the verification log', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./darwin.ts', import.meta.url), 'utf8');

    const marker = /UNVERIFIED\(darwin\)/g;
    const positions: number[] = [];
    for (let m = marker.exec(source); m; m = marker.exec(source)) positions.push(m.index);

    // No floor on the count, deliberately, and this replaced one.
    //
    // **A floor asserts a count that only ever decreases, so it fails on
    // progress.** This one required at least three markers. Confirming
    // ownerOnly on hardware on 2026-08-08 removed one and the suite went red,
    // which is the guard failing for doing the thing the marker existed to
    // encourage.
    //
    // Same shape as the pty skip count needing two counters rather than one. A
    // single number cannot separate the case being guarded against from the
    // case being worked towards, and whichever was true the day it was written
    // is the one that ends up asserted.
    //
    // What carries the guarantee is per marker and is unchanged: a marker that
    // does not say where its answer will be recorded is a note to nobody. Zero
    // markers is the finished state, not a broken test.

    // Per marker rather than by aggregate count: three markers and three
    // pointers can still leave one marker orphaned and one doubled up.
    for (const at of positions) {
        const nearby = source.slice(at, at + 400);
        assert.match(
            nearby,
            /docs\/stack-migration-verification\.md/,
            'the UNVERIFIED marker at character ' + at +
            ' has no pointer to where its answer will be recorded. A marker without one is a note to nobody.'
        );
    }
});

test('the transitional src/package.json is deleted when the root flips to ESM', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const rootUrl = new URL('../../../package.json', import.meta.url);
    const nestedUrl = new URL('../../package.json', import.meta.url);

    const root = JSON.parse(readFileSync(rootUrl, 'utf8')) as { type?: string };
    const nestedExists = existsSync(nestedUrl);

    if (root.type === 'module') {
        // This is the deadline. A comment saying temporary is a hope.
        assert.equal(
            nestedExists, false,
            'The root package.json is now type module, so src/package.json has done its job. ' +
            'Delete it, and src/package.json with it. This is Task 6, not Task 3: runner/ still holds ' +
            'hook-endpoint, server.js and pty-session until then. See docs/CONVENTIONS.md.'
        );
    } else {
        assert.equal(
            nestedExists, true,
            'src/ needs its own package.json to be ESM while the root is commonjs.'
        );
    }
});

// ---------------------------------------------------------------------------
// The guard on the layer itself.
//
// A platform layer does not erode because someone ignores it. It erodes because
// a separator looks like a detail rather than a platform decision, which is
// exactly how `platform.id === 'win32' ? '\' : '/'` got written inside the
// locator during the port and had to be caught by eye.
//
// CONVENTIONS.md states the rule. A convention that only lives in a document is
// a hope, so this is the same shape as the marker check and the deadline test.
// ---------------------------------------------------------------------------

test('no feature code branches on the platform outside the platform layer', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const nodePath = await import('node:path');

    const srcRoot = nodePath.resolve(fileURLToPath(new URL('../../', import.meta.url)));
    const layerDir = nodePath.join(srcRoot, 'main', 'platform');

    function walk(dir: string): string[] {
        const out: string[] = [];
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = nodePath.join(dir, entry.name);
            if (entry.isDirectory()) {
                out.push(...walk(full));
            } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
                out.push(full);
            }
        }
        return out;
    }

    // Tests are exempt on purpose: an equivalence test has to name platforms to
    // assert they differ. Production code has no such excuse.
    const files = walk(srcRoot).filter((f) => !f.startsWith(layerDir));
    assert.ok(files.length >= 3, 'the sweep found almost nothing, so it is probably looking in the wrong place');

    const offences: string[] = [];
    for (const file of files) {
        const source = readFileSync(file, 'utf8');
        source.split('\n').forEach((line, index) => {
            if (/process\.platform/.test(line)) {
                offences.push(nodePath.relative(srcRoot, file) + ':' + (index + 1) + '  process.platform');
            }
            if (/\.id\s*===\s*['"](win32|darwin|linux)['"]/.test(line)) {
                offences.push(nodePath.relative(srcRoot, file) + ':' + (index + 1) + '  compares platform.id');
            }
        });
    }

    assert.deepEqual(
        offences, [],
        'platform knowledge has leaked out of src/main/platform. Add data to the interface instead:\n  ' +
        offences.join('\n  ')
    );
});

test('a configured shell wins, and a wrong one resolves to null rather than falling through', () => {
    // Restored after the port dropped it. Found by auditing what the deleted
    // CommonJS tests covered, not by anyone hitting it.
    const configured = 'D:\Custom\Git\bin\bash.exe';

    assert.equal(
        findPosixShell(win32, inputs(win32), existsOnly(configured, 'C:\Program Files\Git\bin\bash.exe'),
            () => null, configured),
        configured,
        'a configured shell beats every candidate'
    );

    assert.equal(
        findPosixShell(win32, inputs(win32), existsOnly('C:\Program Files\Git\bin\bash.exe'),
            () => null, 'D:\Wrong\bash.exe'),
        null,
        'a wrong setting must be visible, not silently replaced by a working default'
    );
});

// Runs against this machine rather than a fixture. Restored after being deleted
// with the CommonJS agent-env tests: it earned its place once already by finding
// a per-user Git install under AppData that a well-known-paths resolver missed,
// and a suite where every path is a fixture proves only that the fixtures agree
// with each other.
// @real-machine
test('on this machine, a POSIX shell is actually found', async () => {
    const { existsSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');

    const platform = currentPlatform();
    const readRegistry = (key: string, value: string): string | null => {
        try {
            const out = execFileSync('reg', ['query', key, '/v', value], {
                encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000
            });
            const match = out.match(/REG_[A-Z_]+\s+(.+)/);
            return match?.[1]?.trim() ?? null;
        } catch {
            return null;
        }
    };

    const found = findPosixShell(
        platform,
        {
            home: process.env.USERPROFILE ?? process.env.HOME ?? '',
            nodeDir: '',
            parentPath: process.env.PATH ?? ''
        },
        (p) => existsSync(p),
        platform.shellRegistryLookups().length > 0 ? readRegistry : () => null
    );

    assert.notEqual(found, null, 'no POSIX shell found on this machine, so agent status lines would fail silently');
    assert.equal(existsSync(found as string), true);
    console.log('    real machine: POSIX shell resolved to ' + found);
});

/**
 * The spawn options a managed child needs, and the credential source.
 *
 * Both members exist because of defects measured on macOS 2026-08-21: a child that inherited
 * Stafford's process group made killTree kill Stafford, and a config-dir relocation that
 * Keychain does not follow left every isolated colleague unauthenticated.
 */

test('POSIX spawns a managed child into its own process group, which killTree depends on', () => {
    assert.equal(darwin.managedChildSpawnOptions().detached, true);
    assert.equal(linux.managedChildSpawnOptions().detached, true);
});

test('Windows does not detach, since taskkill needs no group and detaching adds a console window', () => {
    assert.equal(win32.managedChildSpawnOptions().detached, false,
        'this is a decision, not an oversight: detaching on Windows would trade a fixed POSIX ' +
        'crash for a visible console window on a piped child.');
});

test('every platform that kills by group also detaches, which is the invariant that pairs them', () => {
    for (const platform of [darwin, linux, win32]) {
        const plan = platform.killTreePlan(1234);
        if (plan.killsEveryGroup) {
            assert.equal(platform.managedChildSpawnOptions().detached, true,
                platform.id + ' kills every group in the snapshot, so its children must lead ' +
                'their own group or the snapshot will contain Stafford.');
        }
    }
});

test('macOS reads the Keychain for the credential, because a relocated config dir does not', () => {
    const spec = darwin.osCredentialCommand('someuser');
    assert.ok(spec, 'macOS has no credential file, so without this an isolated session is never logged in');
    assert.equal(spec.file, 'security');
    assert.ok(spec.args.includes('-w'),
        '-w prints the secret alone, so no attribute dump has to be parsed or logged');
    assert.ok(spec.args.includes('someuser'), 'the account is the caller\'s, never hardcoded');
});

test('Windows and Linux read no store, because their credential is a file the seed copies', () => {
    assert.equal(win32.osCredentialCommand('someuser'), null);
    assert.equal(linux.osCredentialCommand('someuser'), null);
});
