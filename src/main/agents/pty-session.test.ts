import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PtySession, OutputBuffer, RESET, type PtyLike } from './pty-session.ts';
import { currentPlatform } from '../platform/index.ts';

const PLATFORM = currentPlatform();
const CHILD = path.resolve(process.cwd(), 'runner', 'fixtures', 'pty-child.js');

/** Records every write, so the split-write rule can be asserted on the wire. */
function spyPty(): PtyLike & { writes: string[]; fireExit: (code: number) => void; kills: number } {
    let onExit: ((info: { exitCode: number }) => void) | null = null;
    return {
        pid: 4242,
        writes: [] as string[],
        kills: 0,
        onData() { /* nothing produces data here */ },
        onExit(listener) { onExit = listener; },
        write(data: string) { this.writes.push(data); },
        resize() { /* recorded elsewhere */ },
        kill() { this.kills += 1; },
        fireExit(code: number) { onExit?.({ exitCode: code }); }
    };
}

function makeSession(spy: PtyLike, options: Record<string, unknown> = {}) {
    return new PtySession({
        agentId: 'test-agent',
        platform: PLATFORM,
        file: process.execPath,
        args: [CHILD],
        cwd: process.cwd(),
        env: {},
        spawn: () => spy,
        submitDelayMs: 5,
        ...options
    });
}

// ---------------------------------------------------------------------------
// The split-write rule, enforced by the API rather than by callers remembering
// ---------------------------------------------------------------------------

test('submit sends the text and the Enter as separate writes', async () => {
    const spy = spyPty();
    const session = makeSession(spy);
    session.start();

    await session.submit('say ok');

    assert.deepEqual(spy.writes, ['say ok', '\r'], 'two writes, text first, Enter second');
});

test('no write the API produces is text ending in a carriage return', async () => {
    // The rule, as a rule about what the code does. A single chunk ending in a
    // carriage return is taken as a paste: the Enter lands inside the pasted
    // text and nothing is submitted. A 140 character prompt written that way
    // was never accepted, across four attempts in two runs.
    const spy = spyPty();
    const session = makeSession(spy);
    session.start();

    const long = 'Use the Task tool to launch one general-purpose agent whose entire job is to ' +
        'reply with the word hello. Then tell me what it said.';
    assert.ok(long.length > 100, 'long enough to be treated as a paste');

    await session.submit(long);

    for (const written of spy.writes) {
        const isBareSubmit = written === '\r' || written === '\n' || written === '\r\n';
        if (isBareSubmit) continue;
        assert.doesNotMatch(
            written, /[\r\n]$/,
            'submit produced a chunk of text ending in a newline, which is the paste that never submits: ' +
            JSON.stringify(written.slice(-40))
        );
    }
    assert.equal(spy.writes.length, 2);
    assert.equal(spy.writes[0], long);
    assert.equal(spy.writes[1], '\r');
});

test('submit reports failure rather than half sending when the session is gone', async () => {
    const spy = spyPty();
    const session = makeSession(spy);
    session.start();
    session.kill();

    assert.equal(await session.submit('say ok'), false);
    assert.deepEqual(spy.writes, [], 'nothing is written to a session being killed');
});

test('raw write stays available for control sequences', () => {
    const spy = spyPty();
    const session = makeSession(spy);
    session.start();

    // Escape, arrow keys, a bare Enter. None of these are prompts and none go
    // through submit.
    assert.equal(session.write('[B'), true);
    assert.equal(session.write('\r'), true);
    assert.deepEqual(spy.writes, ['[B', '\r']);
});

// ---------------------------------------------------------------------------
// The guards, carried across from the CommonJS original
// ---------------------------------------------------------------------------

test('a killed session is unusable at once, not when the exit event arrives', () => {
    const spy = spyPty();
    const session = makeSession(spy);
    session.start();

    assert.equal(session.kill(), true);
    assert.equal(session.alive, false, 'the gap between kill and exit is where resize kills the runner');
    assert.equal(session.resize(200, 50), false);
    assert.equal(session.write('anything'), false);
    assert.equal(session.kill(), false);
    assert.equal(spy.kills, 1, 'and the kill is not repeated');
});

test('an explicit kill disposes once, and a natural exit disposes when the runner did not', () => {
    const explicit = spyPty();
    const a = makeSession(explicit);
    a.start();
    a.kill();
    explicit.fireExit(0);
    assert.equal(explicit.kills, 1, 'the exit handler must not dispose a second time');

    const natural = spyPty();
    const b = makeSession(natural);
    b.start();
    natural.fireExit(7);
    assert.equal(natural.kills, 1, 'a session that ended by itself is still disposed');
    assert.equal(b.exitInfo?.exitCode, 7);
});

test('a throw from the underlying pty is contained and reported once', () => {
    const exploding: PtyLike = {
        pid: 1,
        onData() {}, onExit() {},
        write() { throw new Error('AttachConsole failed'); },
        resize() { throw new Error('AttachConsole failed'); },
        kill() { throw new Error('AttachConsole failed'); }
    };
    const warnings: string[] = [];
    const session = makeSession(exploding);
    session.on('warn', (m: string) => warnings.push(m));
    session.start();

    assert.equal(session.write('x'), false);
    assert.match(warnings[0] ?? '', /AttachConsole failed/);
    assert.equal(session.alive, false);
    assert.equal(session.resize(10, 10), false);
    assert.equal(warnings.length, 1, 'one failure settles the session rather than retrying into it');
});

test('operations before start are refused rather than throwing', () => {
    const session = makeSession(spyPty());
    assert.equal(session.alive, false);
    assert.equal(session.write('x'), false);
    assert.equal(session.resize(10, 10), false);
    assert.equal(session.kill(), false);
});

/**
 * Ported from `runner/pty-session.test.js` in 6b commit 2, because it was the
 * one test in that file with no home anywhere under `src/`.
 *
 * The TypeScript side covered resize being refused, on a killed session and on
 * a pty that throws, and never covered it working: that the new size reaches
 * the pty and that the session records it. A delete would have dropped the
 * happy path of a method whose failure mode is a crashed runner.
 */
test('resize forwards the new size to the pty and records it', () => {
    const calls: Array<[number, number]> = [];
    const spy = spyPty();
    spy.resize = (cols: number, rows: number) => { calls.push([cols, rows]); };

    const session = makeSession(spy);
    session.start();

    assert.equal(session.resize(132, 40), true);
    assert.deepEqual(calls, [[132, 40]]);
    assert.deepEqual(session.size, { cols: 132, rows: 40 });
});

test('the kill plan comes from the platform, not from a branch in here', () => {
    const spy = spyPty();
    const session = makeSession(spy);
    session.start();

    assert.deepEqual(session.killTreePlan().rootPid, PLATFORM.killTreePlan(4242).rootPid);
    assert.equal(session.killTreePlan().detail, PLATFORM.killTreePlan(4242).detail);
});

// ---------------------------------------------------------------------------
// The buffer
// ---------------------------------------------------------------------------

test('the buffer keeps the tail, counts bytes, and resets a truncated replay', () => {
    const buffer = new OutputBuffer({ capacityBytes: 20 });

    buffer.push('aaaaa');
    buffer.push('bbbbb');
    assert.equal(buffer.truncated, false);
    assert.equal(buffer.replay(), 'aaaaabbbbb');
    assert.equal(buffer.bytes, 10);

    buffer.push('ccccc');
    buffer.push('ddddd');
    buffer.push('eeeee');

    assert.equal(buffer.truncated, true);
    assert.ok(buffer.bytes <= 20);
    assert.ok(buffer.replay().startsWith(RESET), 'eviction can cut an escape sequence in half');
    assert.ok(buffer.replay().endsWith('eeeee'));
    assert.equal(buffer.replay().includes('aaaaa'), false);
});

test('an oversized single write is kept whole rather than half a repaint', () => {
    const buffer = new OutputBuffer({ capacityBytes: 100, maxChunkBytes: 1000 });
    const repaint = 'R'.repeat(400);

    buffer.push('earlier output');
    buffer.push(repaint);

    assert.equal(buffer.replay().endsWith(repaint), true);
    assert.equal(buffer.replay().includes('earlier output'), false);
});

test('a write beyond the hard ceiling keeps its tail and says so', () => {
    const buffer = new OutputBuffer({ capacityBytes: 100, maxChunkBytes: 200 });
    buffer.push('H'.repeat(5000) + 'TAIL');

    assert.equal(buffer.truncated, true);
    assert.equal(buffer.replay().endsWith('TAIL'), true);
    assert.ok(buffer.bytes <= 200);
});

test('the buffer counts bytes, not characters', () => {
    const buffer = new OutputBuffer({ capacityBytes: 100 });
    buffer.push('éé中');
    assert.equal(buffer.bytes, Buffer.byteLength('éé中'));
});

// ---------------------------------------------------------------------------
// subscribe() replays first then streams, so a late subscriber misses nothing
// ---------------------------------------------------------------------------

/** A spy that can push data, so the late-subscriber race is testable. */
function dataSpy(): PtyLike & { fireData: (chunk: string) => void } {
    let onData: ((data: string) => void) | null = null;
    return {
        pid: 4242,
        onData(listener) { onData = listener; },
        onExit() { /* not used here */ },
        write() { /* not used here */ },
        resize() { /* not used here */ },
        kill() { /* not used here */ },
        fireData(chunk: string) { onData?.(chunk); }
    };
}

test('subscribe replays what already arrived before it streams the rest', () => {
    const spy = dataSpy();
    const session = makeSession(spy);
    session.start();

    // Output arrives before anyone subscribes, which is the product's normal
    // shape: a session running a while, a card opened afterwards.
    spy.fireData('already here. ');

    const seen: string[] = [];
    session.subscribe((chunk) => seen.push(chunk));

    // The first thing the subscriber gets is the buffered output, as one chunk.
    assert.deepEqual(seen, ['already here. ']);

    // Then it streams the rest.
    spy.fireData('and now this.');
    assert.deepEqual(seen, ['already here. ', 'and now this.']);
});

test('subscribe on a session with no output yet does not deliver an empty chunk', () => {
    const spy = dataSpy();
    const session = makeSession(spy);
    session.start();

    const seen: string[] = [];
    session.subscribe((chunk) => seen.push(chunk));
    assert.deepEqual(seen, [], 'an empty replay is not a chunk worth delivering');

    spy.fireData('first byte');
    assert.deepEqual(seen, ['first byte']);
});

test('a chunk is delivered once, never lost and never doubled, across the subscribe boundary', () => {
    const spy = dataSpy();
    const session = makeSession(spy);
    session.start();

    spy.fireData('AAA');
    const seen: string[] = [];
    session.subscribe((chunk) => seen.push(chunk));
    spy.fireData('BBB');

    // Every byte appears exactly once and in order: AAA from replay, BBB from
    // the stream. Neither the loss nor the duplication the two-step version
    // risks.
    assert.equal(seen.join(''), 'AAABBB');
});

test('the returned unsubscribe stops the stream', () => {
    const spy = dataSpy();
    const session = makeSession(spy);
    session.start();

    const seen: string[] = [];
    const off = session.subscribe((chunk) => seen.push(chunk));
    spy.fireData('kept');
    off();
    spy.fireData('dropped');

    assert.deepEqual(seen, ['kept']);
});

test('a truncated buffer replays the RESET sentinel to the subscriber', () => {
    const spy = dataSpy();
    const session = makeSession(spy, { capacityBytes: 8, maxChunkBytes: 8 });
    session.start();

    // Overflow the buffer so it drops output and records truncation.
    spy.fireData('1234');
    spy.fireData('5678');
    spy.fireData('9abc');

    const seen: string[] = [];
    session.subscribe((chunk) => seen.push(chunk));

    assert.equal(seen.length, 1);
    assert.ok(seen[0]?.startsWith(RESET), 'a subscriber to a truncated buffer is reset first');
});

// ---------------------------------------------------------------------------
// killWithTree reaps the tree first, then node-pty, in that order
// ---------------------------------------------------------------------------

test('killWithTree reaps the process tree before node-pty kills the shell', async () => {
    const order: string[] = [];
    // A spy whose node-pty kill records into the shared order array, so the
    // sequence relative to the tree kill is asserted rather than assumed.
    const spy = spyPty();
    const recordingKill = spy.kill.bind(spy);
    spy.kill = () => { order.push('node-pty-kill'); recordingKill(); };

    const session = makeSession(spy);
    session.start();

    const report = await session.killWithTree({
        run: () => { order.push('tree-kill'); },
        // A tree with a lone child, so the executor has a group to kill.
        readTree: () => [
            spy.pid + ' 1 ' + spy.pid + ' shell',
            '9001 ' + spy.pid + ' 9001 child'
        ].join('\n'),
        waitMs: async () => {}
    });

    assert.ok(report !== null, 'killWithTree returns the tree-kill report');
    assert.equal(spy.kills, 1, 'node-pty was killed exactly once, for socket disposal');
    // The load-bearing order: every tree kill happens before node-pty's kill,
    // because taskkill /T and the POSIX snapshot both need the tree alive.
    const treeKills = order.filter((s) => s === 'tree-kill').length;
    assert.ok(treeKills > 0, 'the tree was reaped');
    assert.equal(order[order.length - 1], 'node-pty-kill', 'node-pty is killed last, after the tree');
    assert.ok(
        order.lastIndexOf('tree-kill') < order.indexOf('node-pty-kill'),
        'no tree kill runs after node-pty has killed the shell'
    );
});

test('killWithTree refuses a session that is already gone', async () => {
    const spy = spyPty();
    const session = makeSession(spy);
    session.start();
    session.kill();

    const report = await session.killWithTree({ run: () => {}, readTree: () => '', waitMs: async () => {} });
    assert.equal(report, null, 'a killed session has no tree left to reap');
});
