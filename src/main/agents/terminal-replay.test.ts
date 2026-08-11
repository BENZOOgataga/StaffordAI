/**
 * The one part the plan flags as unproven: replaying a fullscreen TUI's captured
 * bytes into xterm has to reconstruct the screen, not print it as a scrambled log.
 *
 * These feed a real alternate-screen-buffer stream (`?1049h`, screen clears,
 * cursor addressing, full repaints) through the OutputBuffer and PtySession replay
 * path, then into a headless xterm, the same engine the renderer uses, and read the
 * reconstructed screen back. A plain-echo test would pass and prove nothing about
 * this case, which is why the fixture is a real TUI stream.
 *
 * The capped case is the sharp one. When the buffer drops the enter-alt-screen and
 * the early frames, the RESET sentinel (RIS, the full reset) has to put xterm into
 * a known state so the most recent full repaint in the tail rebuilds the screen. A
 * literal `c` there, or no reset, would leave xterm mid-escape and render garbage.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { OutputBuffer, PtySession, RESET, type PtyLike } from './pty-session.ts';
import { currentPlatform } from '../platform/index.ts';

// @xterm/headless is CommonJS, so it is required rather than named-imported. It is
// the same terminal engine the renderer's xterm uses, so a screen it reconstructs
// headlessly is the screen the renderer will paint.
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
type Terminal = import('@xterm/headless').Terminal;

const ENTER_ALT = '[?1049h';
const CLEAR_HOME = '[2J[H';

/** One full-screen repaint: clear, home, then the frame's content on line one. */
function frame(content: string): string {
    return CLEAR_HOME + content;
}

function writeAll(term: Terminal, data: string): Promise<void> {
    return new Promise((resolve) => term.write(data, resolve));
}

/** The first line of the reconstructed screen, trimmed. */
async function firstLine(data: string, cols = 40, rows = 6): Promise<string> {
    const term = new Terminal({ cols, rows, allowProposedApi: true });
    await writeAll(term, data);
    const line = term.buffer.active.getLine(0)?.translateToString(true) ?? '';
    term.dispose();
    return line;
}

test('an uncaptured alt-screen stream replays to the latest frame, coherent', async () => {
    const buffer = new OutputBuffer();
    buffer.push(ENTER_ALT);
    buffer.push(frame('FRAME-ONE'));
    buffer.push(frame('FRAME-TWO'));
    buffer.push(frame('FRAME-THREE'));

    const replay = buffer.replay();
    assert.equal(replay.startsWith(RESET), false, 'nothing dropped, so no reset prefix');
    assert.equal(await firstLine(replay), 'FRAME-THREE', 'the reconstructed screen is the latest frame');
});

test('a truncated alt-screen buffer replays coherently after the RESET, not as garbage', async () => {
    // A small cap so the enter-alt-screen and early frames are dropped and only the
    // latest full repaints survive. Each frame is one whole chunk, so a frame is
    // never cut in half.
    const buffer = new OutputBuffer({ capacityBytes: 64 });
    buffer.push(ENTER_ALT);
    for (let i = 1; i <= 20; i++) buffer.push(frame('FRAME-' + i));

    const replay = buffer.replay();
    assert.equal(replay.startsWith(RESET), true, 'dropping output prefixes the reset');
    // Fed into xterm, the reset clears the mid-alt-screen state and the last full
    // repaint in the tail rebuilds the screen. Without a real reset this line would
    // be scrambled by the leftover escape state.
    assert.equal(await firstLine(replay), 'FRAME-20', 'the latest frame reconstructs cleanly');
});

test('the replay reconstructs the same screen the full stream would have', async () => {
    // The whole point: a late subscriber replaying the capped tail sees the same
    // screen a subscriber who watched from the start would, for the current frame.
    const full = ENTER_ALT + frame('A') + frame('B') + frame('FINAL');
    const buffer = new OutputBuffer();
    for (const chunk of [ENTER_ALT, frame('A'), frame('B'), frame('FINAL')]) buffer.push(chunk);

    assert.equal(await firstLine(full), await firstLine(buffer.replay()),
        'replay and live arrive at the same current screen');
});

// --- through the session's subscribe: replay first, then live ----------------

function stubPty(): PtyLike & { emit: (data: string) => void } {
    let onData: (d: string) => void = () => {};
    return {
        pid: 1, onData: (l) => { onData = l; }, onExit: () => {}, write: () => {},
        resize: () => {}, kill: () => {}, emit: (d) => onData(d)
    };
}

test('subscribe replays the alt-screen buffer then streams the next frame', async () => {
    const pty = stubPty();
    const session = new PtySession({
        agentId: 'h1', platform: currentPlatform(), file: 'x', cwd: '/x',
        env: {}, spawn: () => pty
    });
    session.start();

    // The session runs a while and repaints, filling its buffer.
    pty.emit(ENTER_ALT);
    pty.emit(frame('EARLY'));
    pty.emit(frame('CURRENT'));

    // A card opens late and subscribes: it must see the current screen at once,
    // then the next live frame.
    const received: string[] = [];
    session.subscribe((data) => received.push(data));
    pty.emit(frame('NEXT'));

    // The first chunk is the replay, carrying the current screen; the second is the
    // live frame. Concatenated and reconstructed, the screen is the live frame.
    assert.ok(received.length >= 2, 'replay chunk then a live chunk');
    assert.equal(await firstLine(received.join('')), 'NEXT', 'reopened terminal is coherent and live');

    session.kill();
});
