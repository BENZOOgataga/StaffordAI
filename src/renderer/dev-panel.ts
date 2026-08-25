/**
 * A hidden dev-only panel for triggering fake UI states, so states that only exist transiently
 * (needs-you, a pending approval, a not-reporting colleague, the board's empty cases, the tray
 * badge and the OS notification) can be eyeballed on demand.
 *
 * Dev builds only: it does nothing unless `window.stafford.dev` is present, which the preload
 * exposes only when the main process passed --stafford-dev, which a packaged build never does.
 * The panel is hidden and reachable only by the deliberate shortcut Ctrl+Shift+D, so it is never
 * in the normal UI flow even in dev.
 *
 * The triggers fake presentation only. They ask main to install an overlay the read handlers
 * prefer; nothing is written to the store. See src/main/dev/dev-triggers.ts.
 *
 * Styles are set through the CSSOM (element.style), not an inline style attribute, so the strict
 * renderer CSP does not block them.
 */

const TRIGGERS: ReadonlyArray<{ label: string; run: (n: number) => void }> = [
    { label: 'needs-you (N)', run: (n) => { void window.stafford.dev?.trigger('needs-you', n); } },
    { label: 'pending approval', run: () => { void window.stafford.dev?.trigger('approval'); } },
    { label: 'not reporting', run: () => { void window.stafford.dev?.trigger('not-reporting'); } },
    { label: 'board: empty', run: () => { void window.stafford.dev?.trigger('board-empty'); } },
    { label: 'board: no tasks', run: () => { void window.stafford.dev?.trigger('board-no-tasks'); } },
    { label: 'board: populated', run: () => { void window.stafford.dev?.trigger('board-populated'); } },
    { label: 'review diff', run: () => { void window.stafford.dev?.trigger('review-diff'); } },
    { label: 'clear (real data)', run: () => { void window.stafford.dev?.clear(); } }
];

export function initDevPanel(): void {
    const dev = window.stafford.dev;
    if (!dev?.isDev) return;

    const panel = document.createElement('div');
    panel.id = 'dev-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Dev triggers');
    panel.style.cssText =
        'position:fixed;top:44px;right:12px;z-index:99999;background:#141414;color:#eaeaea;' +
        'border:1px solid #3a3a3a;border-radius:10px;padding:12px;width:230px;' +
        'font:12px system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5)';

    const title = document.createElement('div');
    title.textContent = 'Dev triggers (fake UI only)';
    title.style.cssText = 'font-weight:600;margin-bottom:8px';
    panel.appendChild(title);

    const nRow = document.createElement('label');
    nRow.textContent = 'needs-you N: ';
    nRow.style.cssText = 'display:block;margin-bottom:8px';
    const nInput = document.createElement('input');
    nInput.type = 'number';
    nInput.value = '2';
    nInput.min = '0';
    nInput.style.cssText = 'width:52px;background:#222;color:#eaeaea;border:1px solid #3a3a3a;border-radius:4px;padding:2px 4px';
    nRow.appendChild(nInput);
    panel.appendChild(nRow);

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;flex-direction:column;gap:6px';
    for (const t of TRIGGERS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = t.label;
        b.style.cssText = 'cursor:pointer;text-align:left;padding:5px 8px;background:#222;color:#eaeaea;border:1px solid #3a3a3a;border-radius:6px';
        b.addEventListener('click', () => t.run(Math.max(0, Number(nInput.value) || 0)));
        buttons.appendChild(b);
    }
    panel.appendChild(buttons);

    const hint = document.createElement('div');
    hint.textContent = 'Ctrl+Shift+D toggles. Nothing here is persisted.';
    hint.style.cssText = 'margin-top:8px;color:#8a8a8a';
    panel.appendChild(hint);

    document.body.appendChild(panel);

    window.addEventListener('keydown', (event) => {
        if (event.ctrlKey && event.shiftKey && (event.key === 'D' || event.key === 'd')) {
            event.preventDefault();
            panel.hidden = !panel.hidden;
        }
    });
}
