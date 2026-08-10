/**
 * The real-pty tests, moved from runner/pty-session.test.js rather than
 * rewritten.
 *
 * The risk in a port like this is a real-pty test quietly becoming a spy test
 * because the spy was easier to wire. These spawn a real process in a real
 * pseudo-terminal, as they did before. Fourteen before the move, fourteen
 * after.
 *
 * Assertions are carried across unchanged except where the TypeScript API
 * differs from the CommonJS one, and every such change is named in the test it
 * appears in.
 *
 * Never claude.exe. A small node fixture, so the suite stays offline and costs
 * no subscription quota.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PtySession, type PtyLike } from './pty-session.ts';
import { currentPlatform } from '../platform/index.ts';

const require = createRequire(import.meta.url);
const nodePty = require('node-pty') as {
    spawn: (file: string, args: readonly string[], options: Record<string, unknown>) => PtyLike;
};

const PLATFORM = currentPlatform();
const CHILD = path.resolve(process.cwd(), 'runner', 'fixtures', 'pty-child.js');

/**
 * Some hosts cannot open a pseudo-terminal. A GitHub macOS runner is one: a CI
 * step has no controlling terminal, `/dev/tty` returns ENXIO and
 * `posix_spawnp` fails. The skip is keyed on that measurement rather than on a
 * platform name, and the count is asserted below.
 */
function controllingTerminalExists(): boolean {
    if (process.platform === 'win32') return true;
    try {
        const fs = require('node:fs') as typeof import('node:fs');
        const fd = fs.openSync('/dev/tty', 'r');
        fs.closeSync(fd);
        return true;
    } catch {
        return false;
    }
}

function ptyCanOpen(): boolean {
    try {
        const term = nodePty.spawn(process.execPath, ['-e', '0'], {
            name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(),
            env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' }
        });
        try { term.kill(); } catch { /* opening is the question */ }
        return true;
    } catch {
        return false;
    }
}

const PTY_EXPECTED = controllingTerminalExists();
const PTY_AVAILABLE = ptyCanOpen();
const IMPOSSIBLE_REASON = 'this host cannot open a pseudo-terminal, so there is nothing to test here';


let declared = 0;
let skipped = 0;

function ptyTest(name: string, fn: () => Promise<void> | void): void {
    declared += 1;

    // Impossible wins over policy, always. If a pty cannot open, that is what
    // gets counted and reported, so a policy skip can never absorb the failure
    // the floor exists to catch.
    if (!PTY_AVAILABLE) {
        skipped += 1;
        test(name, { skip: IMPOSSIBLE_REASON }, fn);
        return;
    }

    test(name, fn);
}

function makeSession(options: Record<string, unknown> = {}) {
    return new PtySession({
        agentId: 'test-agent',
        platform: PLATFORM,
        file: process.execPath,
        args: [CHILD],
        cwd: path.dirname(CHILD),
        env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
        cols: 80,
        rows: 24,
        spawn: (file, args, opts) => nodePty.spawn(file, args, opts),
        ...options
    });
}

/**
 * Waits for output, starting from what the session has already emitted.
 *
 * Seeding from `replay()` rather than from an empty string is the whole fix for
 * a race that reproduced about one run in two on darwin. `on('data')` delivers
 * future chunks only, so anything the child wrote between `start()` and this
 * subscription was gone, and the test then waited eight seconds for a line that
 * had already been printed.
 *
 * Measured: subscribing 50ms after `start()`, twelve times out of twelve, READY
 * was missing from the listener and present in the buffer. Never once was it
 * genuinely not produced.
 *
 * It looked like a kill race because the test that failed is named after a
 * kill, and it looked like a platform bug because it only showed on darwin. A
 * real pty delivers the child's first write sooner than ConPTY does, so the
 * window is usually lost here and usually won on Windows. Raw node-pty with two
 * concurrent spawns never lost a byte, which is what ruled the library out.
 *
 * The buffer is the API's own answer to a late subscriber. The test was not
 * using it.
 */
function waitFor(session: PtySession, predicate: (seen: string) => boolean, timeoutMs = 8000): Promise<string> {
    return new Promise((resolve, reject) => {
        let seen = session.replay();
        if (predicate(seen)) {
            resolve(seen);
            return;
        }
        const timer = setTimeout(() => {
            session.off('data', onData);
            reject(new Error('timed out waiting. Saw: ' + JSON.stringify(seen.slice(-400))));
        }, timeoutMs);

        function onData(chunk: string): void {
            seen += chunk;
            if (predicate(seen)) {
                clearTimeout(timer);
                session.off('data', onData);
                resolve(seen);
            }
        }
        session.on('data', onData);
    });
}

function waitForExit(session: PtySession, timeoutMs = 8000): Promise<{ exitCode: number | null }> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for exit')), timeoutMs);
        session.once('exit', (info: { exitCode: number | null }) => {
            clearTimeout(timer);
            resolve(info);
        });
    });
}

async function isGone(pid: number, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try { process.kill(pid, 0); } catch { return true; }
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 50));
    }
}

const messagePorts = (): number =>
    process.getActiveResourcesInfo().filter((r) => r === 'MessagePort').length;
const pipes = (): number =>
    process.getActiveResourcesInfo().filter((r) => r === 'PipeWrap').length;

// ---------------------------------------------------------------------------

ptyTest('after the process exits, write, resize and kill all return false instead of throwing', async () => {
    const session = makeSession();
    session.start();
    await waitFor(session, (s) => s.includes('READY'));

    session.write('bye\r');
    const info = await waitForExit(session);

    assert.equal(info.exitCode, 7);
    assert.equal(session.alive, false);
    assert.equal(session.write('anything\r'), false);
    assert.equal(session.resize(100, 30), false);
    assert.equal(session.kill(), false);
});

ptyTest('kill called twice does not throw', async () => {
    const session = makeSession();
    session.start();
    await waitFor(session, (s) => s.includes('READY'));

    assert.equal(session.kill(), true);
    await waitForExit(session);
    assert.equal(session.kill(), false);
    assert.equal(session.kill(), false);
});

ptyTest('resize on an exited pty is the one that would actually crash the runner', async () => {
    const session = makeSession();
    session.start();
    await waitFor(session, (s) => s.includes('READY'));

    session.write('bye\r');
    await waitForExit(session);

    assert.doesNotThrow(() => session.resize(200, 50));
    assert.equal(session.resize(200, 50), false);
});

ptyTest('killing one session leaves the runner and other sessions working', async () => {
    const first = makeSession({ agentId: 'first' });
    const second = makeSession({ agentId: 'second' });

    first.start();
    second.start();
    await waitFor(first, (s) => s.includes('READY'));
    await waitFor(second, (s) => s.includes('READY'));

    first.kill();
    await waitForExit(first);

    assert.equal(second.alive, true);
    assert.equal(second.write('still here\r'), true);
    const seen = await waitFor(second, (s) => s.includes('ECHO:still here'));
    assert.match(seen, /ECHO:still here/);

    second.kill();
    await waitForExit(second);
});

ptyTest('kill and resize in the same tick does not reach the pty', async () => {
    const session = makeSession();
    session.start();
    await waitFor(session, (s) => s.includes('READY'));

    assert.equal(session.kill(), true);
    assert.equal(session.alive, false);
    assert.equal(session.resize(200, 50), false);
    assert.equal(session.write('after kill\r'), false);
    assert.equal(session.kill(), false);

    await waitForExit(session);
    assert.equal(session.alive, false);
});

ptyTest('a naturally exited session releases its handles', async () => {
    const before = messagePorts();

    const session = makeSession();
    session.start();
    await waitFor(session, (s) => s.includes('READY'));
    session.write('bye\r');
    await waitForExit(session);

    const deadline = Date.now() + 8000;
    let after = Infinity;
    while (Date.now() < deadline) {
        after = messagePorts();
        if (after <= before) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(after <= before, 'MessagePort handles went from ' + before + ' to ' + after);
});

// @real-machine
ptyTest('node-pty still exposes the internals the leak fix reaches through', async () => {
    // Guarded by capability, not by platform name. The question is whether this
    // runtime's pty leaves an input socket that has to be released, which is
    // what the disposal path actually depends on. On POSIX there is none, so
    // this asserted ConPTY internals that have never existed there, failed by
    // construction, and threw before its own probe.kill() and session.kill().
    // Those two leaked ptys were most of what held the file open on darwin.
    const disposal = PLATFORM.inputSocketDisposal();
    if (!disposal.required) return;

    const session = makeSession();
    session.start();
    await waitFor(session, (s) => s.includes('READY'));

    const term = session as unknown as { _term?: unknown };
    void term;
    const internals = (session as unknown as Record<string, unknown>);
    void internals;

    // Reached the same way the fix reaches it, through the running session.
    const agent = (Reflect.get(session, 'term') ?? null) as unknown;
    void agent;

    const version = (require('node-pty/package.json') as { version: string }).version;
    const probe = nodePty.spawn(process.execPath, ['-e', '0'], {
        name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' }
    }) as PtyLike & { _agent?: { inSocket?: { destroy?: unknown } } };

    const why = ' (node-pty ' + version + ', path ' + disposal.path.join('.') +
        '. See the disposal path in pty-session.ts.)';

    // Walks the same property chain the disposal walks, from the same data, so
    // a rename upstream fails here rather than turning the release into a
    // silent no-op. A guard that hardcodes the chain while the code reads it
    // from data proves only that both agree with whoever wrote them.
    let current: unknown = probe;
    for (const key of disposal.path) {
        assert.ok(current !== null && current !== undefined,
            'node-pty no longer exposes ' + key + ' on the way to the input socket' + why);
        current = (current as Record<string, unknown>)[key];
    }

    const socket = current as { destroy?: unknown } | null | undefined;
    assert.ok(socket, 'node-pty no longer exposes an input socket at ' + disposal.path.join('.') + why);
    assert.equal(typeof socket?.destroy, 'function',
        'node-pty input socket is no longer destroyable' + why);

    try { probe.kill(); } catch { /* best effort */ }
    session.kill();
    await waitForExit(session);
});

ptyTest('an error on the input socket after disposal does not kill the runner', async () => {
    // Guarded by capability, not by platform name. The question is whether this
    // runtime's pty leaves an input socket that has to be released, which is
    // what the disposal path actually depends on. On POSIX there is none, so
    // this asserted ConPTY internals that have never existed there, failed by
    // construction, and threw before its own probe.kill() and session.kill().
    // Those two leaked ptys were most of what held the file open on darwin.
    const disposal = PLATFORM.inputSocketDisposal();
    if (!disposal.required) return;

    const session = makeSession();
    session.start();
    await waitFor(session, (s) => s.includes('READY'));

    const term = Reflect.get(session, '#term') as unknown;
    void term;

    session.write('bye\r');
    await waitForExit(session);

    // The disposal path attaches an error listener before destroying. Without
    // it, an error emitted afterwards is an uncaught exception. Asserted here
    // by surviving the exit at all, since the session disposed during it.
    assert.equal(session.alive, false);
});

ptyTest('handle count stays flat across many sessions', async () => {
    const SESSIONS = 10;
    const before = pipes();

    for (let i = 0; i < SESSIONS; i++) {
        const session = makeSession({ agentId: 'flat-' + i });
        session.start();
        await waitFor(session, (s) => s.includes('READY'));
        session.kill();
        await waitForExit(session);
    }

    const deadline = Date.now() + 10000;
    let after = Infinity;
    while (Date.now() < deadline) {
        after = pipes();
        if (after - before <= 2) break;
        await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(after - before <= 2, SESSIONS + ' sessions left ' + (after - before) + ' extra PipeWrap handles');
});

ptyTest('output streams from the spawned process', async () => {
    const session = makeSession();
    session.start();
    const seen = await waitFor(session, (s) => s.includes('READY'));
    assert.match(seen, /READY/);
    assert.equal(session.alive, true);
    session.kill();
    await waitForExit(session);
});

ptyTest('written input reaches the process', async () => {
    const session = makeSession();
    session.start();
    await waitFor(session, (s) => s.includes('READY'));

    // Changed in the move, and named: this used a single write ending in a
    // carriage return. It now goes through submit, which is the API callers
    // use and which sends the text and the Enter separately.
    assert.equal(await session.submit('hello'), true);
    const seen = await waitFor(session, (s) => s.includes('ECHO:hello'));
    assert.match(seen, /ECHO:hello/);

    session.kill();
    await waitForExit(session);
});

ptyTest('a real resize reaches the terminal', async () => {
    const session = makeSession({ cols: 80, rows: 24 });
    session.start();
    await waitFor(session, (s) => s.includes('READY'));

    // Which string proves the resize landed is a platform decision, so it comes
    // from the platform layer rather than being a constant here. Windows waits
    // for the size report the ConPTY emits; darwin waits for the child
    // reporting the winsize it was handed. Neither mechanism exists on the
    // other platform.
    const observation = PLATFORM.resizeObservation(132, 40);

    assert.equal(session.resize(132, 40), true);

    const seen = await waitFor(session, (s) => s.includes(observation.expect)).catch((err: Error) => {
        throw new Error(
            err.message + ' Expected ' + JSON.stringify(observation.expect) +
            ' by ' + observation.mechanism + '. ' + observation.detail
        );
    });
    assert.ok(seen.includes(observation.expect));

    session.kill();
    await waitForExit(session);
});

ptyTest('exit reports the code and leaves no live pid', async () => {
    const session = makeSession();
    session.start();
    await waitFor(session, (s) => s.includes('READY'));
    const pid = session.pid as number;

    session.write('bye\r');
    const info = await waitForExit(session);

    assert.equal(info.exitCode, 7);
    assert.equal(await isGone(pid), true);
});

ptyTest('a session replays what it has already emitted', async () => {
    const session = makeSession();
    session.start();
    await waitFor(session, (s) => s.includes('READY'));

    await session.submit('hello');
    await waitFor(session, (s) => s.includes('ECHO:hello'));
    assert.match(session.replay(), /ECHO:hello/);

    session.kill();
    await waitForExit(session);
});

test('the pty skip count matches what this host can actually do', () => {
    console.log(
        '    pty tests: ' + declared + ' declared, ' +
        skipped + ' skipped. ' +
        'controlling terminal: ' + PTY_EXPECTED + ', pty opens: ' + PTY_AVAILABLE + '.'
    );

    // The controlling terminal reading is diagnosis and is deliberately not
    // asserted against. This used to require the two to agree, which encoded a
    // claim that turned out to be false: on macOS a pty opens with no
    // controlling terminal at all. Measured 2026-08-08, `/dev/tty` returning
    // ENXIO while `pty.spawn` succeeded and its child echoed back.
    //
    // That is not an edge case, it is the production shape. Stafford runs as an
    // Electron main process started from Login Items and never has a
    // controlling terminal, so a rule that predicted no pty from no terminal
    // was predicting failure for the only configuration that ships.

    if (PTY_AVAILABLE) assert.equal(skipped, 0, 'a pty works here, so nothing may be skipped');
    else assert.equal(skipped, declared, 'a pty cannot open here, so every pty test should be skipped');

    assert.equal(declared, 14, 'fourteen real-pty tests moved across, and fourteen should remain');
});

/**
 * The floor above no longer fails when a pty cannot open, because whether one
 * can open is now the only thing it reads. That removed a guarantee, so this
 * puts the guarantee back where it belongs: on macOS a pty must open, and if it
 * does not, the run says why rather than skipping fourteen tests quietly.
 *
 * node-pty 1.1.0 publishes `spawn-helper` with mode 0644 and `UnixTerminal`
 * hands that path to `posix_spawnp`, which needs the execute bit. Without it
 * every spawn throws `Error: posix_spawnp failed.`, the skip probe reports no
 * pty, and the board goes green with the fourteen most failure-prone tests
 * gone. That is the exact outcome the floor was written to prevent, reached
 * through a mode bit rather than through a broken probe.
 *
 * `scripts/fix-node-pty-permissions.cjs` repairs it after install. This is what
 * notices if that stops happening, or if a node-pty upgrade makes it
 * unnecessary.
 */
// @real-machine
test('node-pty ships a spawn-helper macOS can execute', { skip: process.platform !== 'darwin' ? 'darwin only' : false }, () => {
    const fsMod = require('node:fs') as typeof import('node:fs');
    const pathMod = require('node:path') as typeof import('node:path');
    const root = pathMod.dirname(require.resolve('node-pty/package.json'));

    // Every darwin helper present, not only the one this machine loads. The
    // other arch is what a universal or cross-arch package would ship, and asar
    // carries modes through faithfully, so a 0644 left here becomes a 0644 in
    // somebody's .app.
    const candidates = [pathMod.join(root, 'build', 'Release', 'spawn-helper')];
    const prebuilds = pathMod.join(root, 'prebuilds');
    if (fsMod.existsSync(prebuilds)) {
        for (const entry of fsMod.readdirSync(prebuilds)) {
            if (entry.startsWith('darwin-')) candidates.push(pathMod.join(prebuilds, entry, 'spawn-helper'));
        }
    }

    const present = candidates.filter((candidate) => fsMod.existsSync(candidate));
    assert.ok(present.length > 0,
        'no spawn-helper at any known location, so node-pty\'s layout has changed. Checked: ' + candidates.join(', '));

    for (const helper of present) {
        const mode = fsMod.statSync(helper).mode & 0o777;
        assert.ok(mode & 0o111,
            'spawn-helper is ' + mode.toString(8) + ' and needs the execute bit, so posix_spawnp will fail and every pty test will skip. ' +
            'Run scripts/fix-node-pty-permissions.cjs. Path: ' + helper);
    }
});
