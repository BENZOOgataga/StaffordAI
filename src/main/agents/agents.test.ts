import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentEnv, FORBIDDEN_KEYS } from './agent-env.ts';
import { locateClaude } from './claude-locator.ts';
import { readTrust, classifyExit, TRUST, EXIT_REPORT } from './trust.ts';
import { win32, darwin, linux } from '../platform/index.ts';
import type { Platform } from '../platform/types.ts';

const WIN_PARENT: Record<string, string | undefined> = {
    SystemRoot: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT',
    USERPROFILE: 'C:\\Users\\someone',
    APPDATA: 'C:\\Users\\someone\\AppData\\Roaming',
    TEMP: 'C:\\Temp',
    PATH: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd',

    // None of these are on any allowlist and none may reach an agent.
    AGENT_DASHBOARD_TOKEN: 'super-secret-token',
    AWS_SECRET_ACCESS_KEY: 'also-secret',
    npm_config_registry: 'https://example.invalid'
};

const POSIX_PARENT: Record<string, string | undefined> = {
    HOME: '/Users/someone',
    USER: 'someone',
    SHELL: '/bin/zsh',
    TMPDIR: '/var/folders/tmp',
    LANG: 'en_GB.UTF-8',
    PATH: '/usr/bin:/bin',

    AGENT_DASHBOARD_TOKEN: 'super-secret-token',
    AWS_SECRET_ACCESS_KEY: 'also-secret'
};

function parentFor(platform: Platform) {
    return platform.id === 'win32' ? WIN_PARENT : POSIX_PARENT;
}

function nodeDirFor(platform: Platform) {
    return platform.id === 'win32' ? 'C:\\Program Files\\nodejs' : '/usr/local/bin';
}

function existsOnly(...paths: string[]) {
    const set = new Set(paths.map((p) => p.toLowerCase()));
    return (p: string) => set.has(String(p).toLowerCase());
}

// ---------------------------------------------------------------------------
// Equivalence. Written against what the ports should do rather than against
// what they happen to do, because this is the assertion that would have caught
// the bug the macOS runner found in the CommonJS originals: they used the
// host's path rules instead of the target's, so every answer was right on the
// machine the suite ran on and wrong everywhere else.
// ---------------------------------------------------------------------------

const ALL: readonly Platform[] = [win32, darwin, linux];

test('no module leaks the host separator into another platform answer', () => {
    for (const platform of ALL) {
        const { env } = buildAgentEnv({
            agentId: 'a1',
            platform,
            parentEnv: parentFor(platform),
            nodeDir: nodeDirFor(platform)
        });

        const entries = env.PATH.split(platform.pathSeparator);
        assert.ok(entries.length > 1, platform.id + ' PATH did not split on its own separator');

        for (const entry of entries) {
            if (platform.id === 'win32') {
                assert.match(entry, /^[A-Za-z]:\\/, 'win32 PATH entry is not a Windows path: ' + entry);
            } else {
                assert.ok(entry.startsWith('/'), platform.id + ' PATH entry is not a POSIX path: ' + entry);
                assert.doesNotMatch(entry, /\\/, platform.id + ' PATH entry carries a backslash: ' + entry);
            }
        }
    }
});

test('the same answers come out regardless of which host is running', () => {
    // The host cannot be changed inside a test, so this asserts the property
    // that makes host independence true: every answer is derived from the
    // platform argument, and the platform's own separators appear in it.
    const mac = buildAgentEnv({
        agentId: 'a1', platform: darwin, parentEnv: POSIX_PARENT, nodeDir: '/usr/local/bin'
    });
    const win = buildAgentEnv({
        agentId: 'a1', platform: win32, parentEnv: WIN_PARENT, nodeDir: 'C:\\Program Files\\nodejs'
    });

    assert.ok(mac.env.PATH.includes(':'), 'macOS PATH must join with a colon');
    assert.equal(mac.env.PATH.includes(';'), false, 'macOS PATH must not join with a semicolon');
    assert.ok(win.env.PATH.includes(';'), 'Windows PATH must join with a semicolon');

    // Both carry the same shape of answer, which is the part that matters: the
    // modules do not have a Windows path and a macOS afterthought.
    for (const built of [mac, win]) {
        assert.equal(built.env.STAFFORD_AGENT_ID, 'a1');
        assert.ok(built.env.PATH.length > 0);
    }
});

test('locating the binary uses the target platform separators, not the host', () => {
    const found = locateClaude({
        platform: darwin,
        home: '/Users/someone',
        pathValue: '/opt/tools:/usr/bin',
        exists: existsOnly('/opt/tools/claude')
    });
    assert.equal(found.path, '/opt/tools/claude');
    assert.equal(found.source, 'path');
    assert.doesNotMatch(found.path, /\\/, 'a macOS answer must not contain a backslash');

    const win = locateClaude({
        platform: win32,
        home: 'C:\\Users\\someone',
        pathValue: 'C:\\tools;C:\\Windows',
        exists: existsOnly('C:\\tools\\claude.exe')
    });
    assert.equal(win.path, 'C:\\tools\\claude.exe');
    assert.doesNotMatch(win.path, /\//, 'a Windows answer must not contain a forward slash');
});

test('trust comparison follows the platform rule, not the host filesystem', () => {
    const config = JSON.stringify({
        projects: {
            '/Users/someone/Git/Repo': { hasTrustDialogAccepted: true },
            'C:/Users/someone/Git/Repo': { hasTrustDialogAccepted: true }
        }
    });
    const readFile = () => config;

    assert.equal(readTrust({ platform: darwin, dir: '/users/someone/git/repo', configPath: 'x', readFile }), TRUST.TRUSTED);
    assert.equal(readTrust({ platform: linux, dir: '/users/someone/git/repo', configPath: 'x', readFile }), TRUST.NOT_TRUSTED);
    assert.equal(readTrust({ platform: win32, dir: 'C:\\Users\\someone\\Git\\Repo\\', configPath: 'x', readFile }), TRUST.TRUSTED);
});

// ---------------------------------------------------------------------------
// agent-env
// ---------------------------------------------------------------------------

test('only allowlisted variables are copied, and no secret crosses', () => {
    for (const platform of ALL) {
        const { env } = buildAgentEnv({
            agentId: 'a1', platform, parentEnv: parentFor(platform), nodeDir: nodeDirFor(platform)
        });

        const allowed = new Set([...platform.inheritedEnvKeys(), 'PATH', 'STAFFORD_AGENT_ID', 'AGENT_DASHBOARD_PORT']);
        for (const key of Object.keys(env)) {
            assert.ok(allowed.has(key), platform.id + ' leaked ' + key);
        }

        const serialised = JSON.stringify(env);
        assert.equal(serialised.includes('super-secret-token'), false, platform.id + ' leaked the token');
        assert.equal(serialised.includes('also-secret'), false, platform.id + ' leaked a secret');
    }
});

test('the parent PATH is rebuilt, never inherited', () => {
    const { env } = buildAgentEnv({
        agentId: 'a1',
        platform: win32,
        parentEnv: { ...WIN_PARENT, PATH: 'C:\\poisoned;C:\\Windows\\system32' },
        nodeDir: 'C:\\Program Files\\nodejs'
    });
    assert.equal(env.PATH.includes('C:\\poisoned'), false);
});

test('the shared token cannot be injected through extra', () => {
    for (const key of FORBIDDEN_KEYS) {
        assert.throws(
            () => buildAgentEnv({
                agentId: 'a1', platform: win32, parentEnv: WIN_PARENT,
                nodeDir: 'C:\\nodejs', extra: { [key]: 'sneaky' }
            }),
            /Refusing to place/
        );
    }
});

test('a relative path in extra is refused, because hooks run in the agent cwd', () => {
    assert.throws(
        () => buildAgentEnv({
            agentId: 'a1', platform: win32, parentEnv: WIN_PARENT,
            nodeDir: 'C:\\nodejs', extra: { STAFFORD_PROBE_FILE: './probe.jsonl' }
        }),
        /must be an absolute path/
    );
    assert.doesNotThrow(() => buildAgentEnv({
        agentId: 'a1', platform: win32, parentEnv: WIN_PARENT,
        nodeDir: 'C:\\nodejs', extra: { STAFFORD_PROBE_FILE: 'C:\\logs\\probe.jsonl' }
    }));
});

/**
 * The assertion that was missing, and the reason the defect survived.
 *
 * Every existing case here used `win32` with Windows paths, so the check and
 * its test agreed and both were describing Windows. The harness passed
 * `/Users/<user>/Library/Application Support/Stafford/hook.sock` and it was
 * refused as relative, which is every absolute path on the platform.
 */
test('an absolute POSIX path in extra is accepted, which the Windows-shaped rule refused', () => {
    for (const platform of [darwin, linux]) {
        assert.doesNotThrow(
            () => buildAgentEnv({
                agentId: 'a1', platform, parentEnv: POSIX_PARENT, nodeDir: '/usr/local/bin',
                extra: { STAFFORD_SOCKET: '/Users/someone/Library/Application Support/Stafford/hook.sock' }
            }),
            'an absolute path must not be refused on ' + platform.id
        );
        assert.throws(
            () => buildAgentEnv({
                agentId: 'a1', platform, parentEnv: POSIX_PARENT, nodeDir: '/usr/local/bin',
                extra: { STAFFORD_SOCKET: './hook.sock' }
            }),
            /must be an absolute path/
        );
    }
});

/**
 * Asked of each platform directly, because the interesting case has no caller
 * yet: a bare leading separator is absolute on POSIX and drive-relative on
 * Windows, and that single disagreement is the whole defect.
 */
test('each platform decides what absolute means, and they disagree about a bare separator', () => {
    assert.equal(darwin.isAbsolutePath('/Users/someone/x'), true);
    assert.equal(linux.isAbsolutePath('/home/someone/x'), true);
    assert.equal(darwin.isAbsolutePath('./x'), false);
    assert.equal(darwin.isAbsolutePath('x/y'), false);

    assert.equal(win32.isAbsolutePath('C:\\logs\\x'), true);
    assert.equal(win32.isAbsolutePath('C:/logs/x'), true);
    assert.equal(win32.isAbsolutePath('\\\\server\\share\\x'), true);
    assert.equal(win32.isAbsolutePath('./x'), false);

    // The disagreement, stated rather than implied.
    assert.equal(darwin.isAbsolutePath('/x'), true);
    assert.equal(win32.isAbsolutePath('\\x'), false);
    assert.equal(win32.isAbsolutePath('/x'), false);
});

test('a located shell adds its directories, and a missing one warns', () => {
    const withShell = buildAgentEnv({
        agentId: 'a1', platform: win32, parentEnv: WIN_PARENT, nodeDir: 'C:\\nodejs',
        shellExecutable: 'C:\\Program Files\\Git\\bin\\bash.exe'
    });
    assert.ok(withShell.env.PATH.includes('C:\\Program Files\\Git\\usr\\bin'));

    const warnings: string[] = [];
    const without = buildAgentEnv({
        agentId: 'a1', platform: win32, parentEnv: WIN_PARENT, nodeDir: 'C:\\nodejs',
        onWarn: (m) => warnings.push(m)
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /status line/);
    assert.ok(without.env.PATH.length > 0, 'it still returns a usable environment');
});

test('a missing agent id is refused', () => {
    assert.throws(
        () => buildAgentEnv({ agentId: '', platform: win32, parentEnv: WIN_PARENT, nodeDir: 'C:\\nodejs' }),
        /requires an agentId/
    );
});

test('the hook port is passed as a string when set, and absent when not', () => {
    const withPort = buildAgentEnv({
        agentId: 'a1', platform: win32, parentEnv: WIN_PARENT, nodeDir: 'C:\\nodejs', hookPort: 4271
    });
    assert.equal(withPort.env.AGENT_DASHBOARD_PORT, '4271');

    const without = buildAgentEnv({
        agentId: 'a1', platform: win32, parentEnv: WIN_PARENT, nodeDir: 'C:\\nodejs'
    });
    assert.equal(without.env.AGENT_DASHBOARD_PORT, undefined);
});

// ---------------------------------------------------------------------------
// claude-locator
// ---------------------------------------------------------------------------

test('a configured path wins, and a wrong one is an error rather than a fallback', () => {
    const found = locateClaude({
        platform: win32, override: 'D:\\tools\\claude.exe', home: 'C:\\Users\\someone',
        exists: existsOnly('D:\\tools\\claude.exe', 'C:\\Users\\someone\\.local\\bin\\claude.exe')
    });
    assert.equal(found.source, 'config');

    assert.throws(
        () => locateClaude({
            platform: win32, override: 'D:\\gone\\claude.exe', home: 'C:\\Users\\someone',
            exists: existsOnly('C:\\Users\\someone\\.local\\bin\\claude.exe')
        }),
        /configured path/
    );
});

test('the platform candidates are checked before PATH', () => {
    const found = locateClaude({
        platform: win32, home: 'C:\\Users\\someone', pathValue: 'C:\\bin',
        exists: existsOnly('C:\\Users\\someone\\.local\\bin\\claude.exe', 'C:\\bin\\claude.exe')
    });
    assert.equal(found.source, 'candidates');
});

test('the error names every location that was checked', () => {
    try {
        locateClaude({ platform: darwin, home: '/Users/someone', pathValue: '/usr/bin', exists: () => false });
        assert.fail('expected a throw');
    } catch (err) {
        const message = (err as Error).message;
        assert.match(message, /not found/);
        assert.match(message, /\.local\/bin\/claude/);
        assert.match(message, /\/opt\/homebrew\/bin\/claude/);
        assert.match(message, /\/usr\/bin\/claude/);
    }
});

// ---------------------------------------------------------------------------
// trust
// ---------------------------------------------------------------------------

const TRUST_CONFIG = JSON.stringify({
    projects: {
        'C:/Users/someone/Git/Stafford': { hasTrustDialogAccepted: true },
        'C:/Users/someone/Git/Refused': { hasTrustDialogAccepted: false },
        'C:/Users/someone/Git/Partial': { lastCost: 0 }
    }
});

function trustOf(dir: string, content: string | null = TRUST_CONFIG) {
    return readTrust({
        platform: win32,
        dir,
        configPath: 'fixture',
        readFile: () => {
            if (content === null) throw new Error('ENOENT');
            return content;
        }
    });
}

test('trust reads the three states, and anything unreadable is unknown', () => {
    assert.equal(trustOf('C:/Users/someone/Git/Stafford'), TRUST.TRUSTED);
    assert.equal(trustOf('C:/Users/someone/Git/Refused'), TRUST.NOT_TRUSTED);
    assert.equal(trustOf('C:/Users/someone/Git/Partial'), TRUST.UNKNOWN);
    assert.equal(trustOf('C:/Users/someone/Git/NeverOpened'), TRUST.NOT_TRUSTED);
    assert.equal(trustOf('C:/anything', null), TRUST.UNKNOWN);
    assert.equal(trustOf('C:/anything', '{ not json'), TRUST.UNKNOWN);
    assert.equal(trustOf('C:/anything', '{"projects":"nonsense"}'), TRUST.UNKNOWN);
});

test('the trust module exposes no way to write', async () => {
    const module = await import('./trust.ts');
    const writers = Object.keys(module).filter((k) => /write|save|set|accept/i.test(k));
    assert.deepEqual(writers, []);
});

test('classifyExit covers the whole table', () => {
    const rows = [
        { trustAtSpawn: TRUST.TRUSTED, sawSessionStart: true, sawSessionEnd: true, expected: EXIT_REPORT.IDLE },
        { trustAtSpawn: TRUST.NOT_TRUSTED, sawSessionStart: true, sawSessionEnd: true, expected: EXIT_REPORT.IDLE },
        { trustAtSpawn: TRUST.UNKNOWN, sawSessionStart: true, sawSessionEnd: true, expected: EXIT_REPORT.IDLE },
        { trustAtSpawn: TRUST.TRUSTED, sawSessionStart: true, sawSessionEnd: false, expected: EXIT_REPORT.CRASHED },
        { trustAtSpawn: TRUST.NOT_TRUSTED, sawSessionStart: true, sawSessionEnd: false, expected: EXIT_REPORT.CRASHED },
        { trustAtSpawn: TRUST.UNKNOWN, sawSessionStart: true, sawSessionEnd: false, expected: EXIT_REPORT.CRASHED },
        { trustAtSpawn: TRUST.TRUSTED, sawSessionStart: false, sawSessionEnd: false, expected: EXIT_REPORT.CRASHED },
        { trustAtSpawn: TRUST.NOT_TRUSTED, sawSessionStart: false, sawSessionEnd: false, expected: EXIT_REPORT.NEEDS_TRUST },
        { trustAtSpawn: TRUST.UNKNOWN, sawSessionStart: false, sawSessionEnd: false, expected: EXIT_REPORT.NEEDS_TRUST }
    ] as const;

    for (const row of rows) {
        assert.equal(
            classifyExit(row),
            row.expected,
            row.trustAtSpawn + ' start=' + row.sawSessionStart + ' end=' + row.sawSessionEnd
        );
    }
});
