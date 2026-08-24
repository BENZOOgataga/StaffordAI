import test from 'node:test';
import assert from 'node:assert/strict';
import { trayMenuTemplate, trayPresentation, waitingSummary, needsYouSignal } from './tray.ts';

test('the tray menu opens the window and quits, with a separator between', () => {
    let opened = 0;
    let quit = 0;
    const template = trayMenuTemplate({ openWindow: () => { opened += 1; }, quit: () => { quit += 1; } });

    const labels = template.map((item) => item.type === 'separator' ? '---' : item.label);
    assert.deepEqual(labels, ['Open Stafford', '---', 'Quit']);

    // The actions point where the labels say.
    template.find((i) => i.label === 'Open Stafford')?.click?.();
    template.find((i) => i.label === 'Quit')?.click?.();
    assert.equal(opened, 1);
    assert.equal(quit, 1);
});

test('nothing waiting is the idle presentation: no attention, no count, the plain tooltip', () => {
    const p = trayPresentation(0, 0);
    assert.equal(p.attention, false);
    assert.equal(p.count, 0);
    assert.equal(p.tooltip, 'Stafford');
});

test('a waiting count raises attention and words the tooltip like the board header', () => {
    // Review only.
    assert.deepEqual(trayPresentation(1, 0), { attention: true, count: 1, tooltip: '1 waiting for review' });
    assert.deepEqual(trayPresentation(2, 0), { attention: true, count: 2, tooltip: '2 waiting for review' });
    // Paused only.
    assert.deepEqual(trayPresentation(0, 1), { attention: true, count: 1, tooltip: '1 paused for approval' });
    // Both, joined the same way the board joins them.
    assert.deepEqual(trayPresentation(2, 1), { attention: true, count: 3, tooltip: '2 waiting for review, 1 paused for approval' });
});

test('the waiting summary matches the board header phrasing exactly', () => {
    assert.equal(waitingSummary(1, 0), '1 waiting for review');
    assert.equal(waitingSummary(3, 2), '3 waiting for review, 2 paused for approval');
    assert.equal(waitingSummary(0, 0), '');
});

test('needsYouSignal fires only when the count rises, never on a drop or an unchanged re-render', () => {
    assert.equal(needsYouSignal(0, 1, 0).fire, true, '0 to 1 fires');
    assert.equal(needsYouSignal(1, 2, 0).fire, true, '1 to 2 fires');
    assert.equal(needsYouSignal(2, 2, 1).fire, true, '2 to 3 fires');
    assert.equal(needsYouSignal(1, 1, 0).fire, false, 'unchanged is silent');
    assert.equal(needsYouSignal(3, 1, 0).fire, false, 'a drop is silent');
    assert.equal(needsYouSignal(0, 0, 0).fire, false, 'nothing waiting is silent');
});

test('needsYouSignal content is count-only, worded like the board header', () => {
    const s = needsYouSignal(0, 2, 1);
    assert.equal(s.title, 'Stafford');
    assert.equal(s.body, '2 waiting for review, 1 paused for approval');
    assert.equal(s.count, 3);
});

test('a run of counts fires once per rise and stays silent on repeats and drops (no spam)', () => {
    // Mirrors how refreshTray tracks the previous count across a session.
    let prev = 0;
    const fired: number[] = [];
    for (const [review, paused] of [[0, 0], [1, 0], [1, 0], [2, 0], [2, 1], [1, 1], [0, 0]] as const) {
        const s = needsYouSignal(prev, review, paused);
        if (s.fire) fired.push(s.count);
        prev = s.count;
    }
    // Rises at 1 (0->1), 2 (1->2), 3 (2->3). The repeated 1, and every drop, fired nothing.
    assert.deepEqual(fired, [1, 2, 3]);
});
