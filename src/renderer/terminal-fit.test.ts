/**
 * The fit-on-open sizing: it propagates the container's real size to the pty on
 * open, it never fires with a zero or bogus size (the first-mount trap), and it
 * refits on every later resize through the one path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRealSize, fitToContainer, type Fitter } from './terminal-fit.ts';

function fakeFitter(cols: number, rows: number): Fitter & { fitted: number } {
    return {
        fitted: 0,
        // fit() sets the measured size, the way FitAddon resizes the terminal.
        fit() { this.fitted += 1; },
        cols,
        rows
    };
}

test('a real size is required before a fit can measure anything', () => {
    assert.equal(hasRealSize({ clientWidth: 800, clientHeight: 600 }), true);
    assert.equal(hasRealSize({ clientWidth: 0, clientHeight: 600 }), false);
    assert.equal(hasRealSize({ clientWidth: 800, clientHeight: 0 }), false);
    assert.equal(hasRealSize({ clientWidth: 0, clientHeight: 0 }), false);
});

test('on open, the pty gets the container real size without a manual resize', () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const fitter = fakeFitter(120, 40);
    const did = fitToContainer({ clientWidth: 960, clientHeight: 520 }, fitter, (cols, rows) => sent.push({ cols, rows }));
    assert.equal(did, true, 'it fit and propagated');
    assert.equal(fitter.fitted, 1, 'the container was measured once');
    assert.deepEqual(sent, [{ cols: 120, rows: 40 }], 'the pty received the fitted size on open');
});

test('the first-mount trap: a zero-sized container never fits or propagates', () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const fitter = fakeFitter(120, 40);
    const did = fitToContainer({ clientWidth: 0, clientHeight: 0 }, fitter, (cols, rows) => sent.push({ cols, rows }));
    assert.equal(did, false, 'a zero-sized container is a no-op');
    assert.equal(fitter.fitted, 0, 'fit was never called on a container with no layout');
    assert.deepEqual(sent, [], 'the pty never got a garbage dimension');
});

test('a degenerate zero-cols measurement does not propagate', () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const fitter = fakeFitter(0, 24);
    const did = fitToContainer({ clientWidth: 960, clientHeight: 520 }, fitter, (cols, rows) => sent.push({ cols, rows }));
    assert.equal(did, false, 'a zero-column fit is refused');
    assert.deepEqual(sent, [], 'no bogus size reaches the pty');
});

test('a later resize refits and propagates again through the one path', () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const open = fakeFitter(120, 40);
    fitToContainer({ clientWidth: 960, clientHeight: 520 }, open, (c, r) => sent.push({ cols: c, rows: r }));
    const resized = fakeFitter(80, 30);
    fitToContainer({ clientWidth: 640, clientHeight: 400 }, resized, (c, r) => sent.push({ cols: c, rows: r }));
    assert.deepEqual(sent, [{ cols: 120, rows: 40 }, { cols: 80, rows: 30 }],
        'open and a later resize both propagate, the manual-resize path is not regressed');
});
