import test from 'node:test';
import assert from 'node:assert/strict';
import { trayMenuTemplate } from './tray.ts';

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
