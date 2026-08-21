/**
 * The window opens at a sensible size on first launch and remembers the user's
 * choice, and a saved bounds is clamped to the current display so it always opens
 * fully visible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWindowBounds, readWindowState, saveWindowState, WINDOW_DEFAULTS, type Rect } from './window-state.ts';

// A 2K work area with a taskbar taken off the bottom.
const WORK_2K: Rect = { x: 0, y: 0, width: 2560, height: 1400 };
const OPTS = WINDOW_DEFAULTS;

test('first launch fills the fraction of the work area, capped, and centred', () => {
    const b = resolveWindowBounds(WORK_2K, null, OPTS);
    // 66% of 2560 is 1690, over the 1600 cap, so it caps. 70% of 1400 is 980.
    assert.equal(b.width, 1600, 'width caps at the max, not the full 66%');
    assert.equal(b.height, 980, 'height is 70% of the work area, under the cap');
    assert.equal(b.x, Math.round((2560 - 1600) / 2), 'centred horizontally');
    assert.equal(b.y, Math.round((1400 - 980) / 2), 'centred vertically');
});

test('first launch on a small display floors to the minimum, still centred', () => {
    const small: Rect = { x: 0, y: 0, width: 900, height: 650 };
    const b = resolveWindowBounds(small, null, OPTS);
    // 75% of 900 is 675, under the 720 floor.
    assert.equal(b.width, 720, 'width floors at the minimum');
    assert.equal(b.height, 520, 'height floors at the minimum');
    assert.equal(b.x, Math.round((900 - 720) / 2));
});

test('first launch never exceeds the work area, even below the minimum', () => {
    const tiny: Rect = { x: 0, y: 0, width: 640, height: 480 };
    const b = resolveWindowBounds(tiny, null, OPTS);
    assert.equal(b.width, 640, 'never wider than the work area');
    assert.equal(b.height, 480, 'never taller than the work area');
});

test('a saved bounds inside the work area is restored, position kept', () => {
    const saved: Rect = { x: 300, y: 200, width: 1100, height: 800 };
    const b = resolveWindowBounds(WORK_2K, saved, OPTS);
    assert.deepEqual(b, saved, 'the remembered size and position come back exactly');
});

test('the work area is used, not raw screen: a taskbar offset is honoured', () => {
    // Work area starts below a top bar; a first-launch window sits inside it.
    const offset: Rect = { x: 0, y: 40, width: 1920, height: 1040 };
    const b = resolveWindowBounds(offset, null, OPTS);
    assert.ok(b.y >= 40, 'the window never opens above the work area, so not under the top bar');
    assert.ok(b.y + b.height <= 40 + 1040, 'and never below it');
});

test('a saved window larger than the current work area is clamped to fit', () => {
    const saved: Rect = { x: 0, y: 0, width: 4000, height: 3000 };
    const b = resolveWindowBounds(WORK_2K, saved, OPTS);
    assert.equal(b.width, 1600, 'clamped to the max, which is under the work area');
    assert.equal(b.height, 1100, 'clamped to the max height, under the work area');
    // Its centre is below the work area, so it re-centres rather than corner-clamps.
    assert.ok(b.x + b.width <= 2560 && b.y + b.height <= 1400, 'fully inside the work area');
    assert.equal(b.x, Math.round((2560 - 1600) / 2), 'centred');
});

test('a saved window partly off the right edge, centre still on screen, is nudged fully visible', () => {
    const saved: Rect = { x: 1800, y: 100, width: 900, height: 700 };
    const b = resolveWindowBounds(WORK_2K, saved, OPTS);
    assert.equal(b.width, 900);
    assert.equal(b.x + b.width, 2560, 'nudged so the right edge sits on the work-area edge');
    assert.ok(b.x >= 0, 'and not off the left');
});

test('a saved window on a display that is gone re-centres on the current one', () => {
    // Its centre is far off to a second monitor at x=3000, now disconnected.
    const saved: Rect = { x: 3000, y: 200, width: 1000, height: 700 };
    const b = resolveWindowBounds(WORK_2K, saved, OPTS);
    assert.equal(b.x, Math.round((2560 - 1000) / 2), 're-centred, not clamped to a corner');
    assert.equal(b.y, Math.round((1400 - 700) / 2));
});

test('a saved window smaller than the minimum floors up', () => {
    const saved: Rect = { x: 100, y: 100, width: 300, height: 200 };
    const b = resolveWindowBounds(WORK_2K, saved, OPTS);
    assert.equal(b.width, 720, 'floored to the minimum width');
    assert.equal(b.height, 520, 'floored to the minimum height');
});

test('readWindowState returns the rect, and null for missing or malformed', () => {
    const good = JSON.stringify({ x: 10, y: 20, width: 800, height: 600 });
    assert.deepEqual(readWindowState(() => good, '/state'), { x: 10, y: 20, width: 800, height: 600 });
    assert.equal(readWindowState(() => { throw new Error('ENOENT'); }, '/state'), null, 'missing file is null');
    assert.equal(readWindowState(() => '{ not json', '/state'), null, 'malformed is null');
    assert.equal(readWindowState(() => JSON.stringify({ x: 1, y: 2, width: 0, height: 600 }), '/state'), null,
        'a non-positive size is rejected');
    assert.equal(readWindowState(() => JSON.stringify({ x: 'a', y: 2, width: 800, height: 600 }), '/state'), null,
        'a non-number field is rejected');
});

test('saveWindowState writes exactly the four fields it round-trips', () => {
    let written = '';
    saveWindowState((_p, data) => { written = data; }, '/state', { x: 5, y: 6, width: 900, height: 700 });
    assert.deepEqual(JSON.parse(written), { x: 5, y: 6, width: 900, height: 700 });
    assert.deepEqual(readWindowState(() => written, '/state'), { x: 5, y: 6, width: 900, height: 700 });
});
