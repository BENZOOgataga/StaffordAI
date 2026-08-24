import test from 'node:test';
import assert from 'node:assert/strict';
import { trayMenuTemplate, trayPresentation, waitingSummary } from './tray.ts';

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
