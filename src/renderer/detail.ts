/**
 * The detail view's live terminal, the read half. Click a card, this fills the
 * same window with a two-pane detail: the colleague's terminal on one side, and a
 * placeholder for the input box the write half will add on the other.
 *
 * It talks only to `window.stafford.session`, the frozen bridge. On open it asks
 * main to subscribe, so the capped buffer replays first and then live output
 * streams, into xterm. xterm is a real terminal emulator, so feeding it the pty's
 * own byte stream reconstructs a fullscreen TUI, alternate screen buffer and all,
 * rather than printing it as a scrolling log. Reconstruction is proven headlessly
 * in the tests against the same xterm engine.
 *
 * A pane resize propagates to the pty so the TUI reflows to the pane, and closing
 * unsubscribes so a card that is not open does not stream.
 */

import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { StaffordApi } from '../preload/index.ts';

declare global {
    interface Window {
        readonly stafford: StaffordApi;
    }
}

const overlay = document.getElementById('detail') as HTMLElement;
const nameEl = document.getElementById('detail-name') as HTMLElement;
const roleEl = document.getElementById('detail-role') as HTMLElement;
const termHost = document.getElementById('term') as HTMLElement;
const backButton = document.getElementById('detail-back') as HTMLButtonElement;

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let offData: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let openHireId: string | null = null;

/** Fits the terminal to its pane and propagates the new size to the pty. */
function fitAndResize(): void {
    if (!term || !fit || !openHireId) return;
    try {
        fit.fit();
    } catch {
        // The pane can be zero-sized for a frame during open or close; a failed
        // fit there is harmless and the next observer tick fixes it.
        return;
    }
    void window.stafford.session.resize(openHireId, term.cols, term.rows);
}

export async function openDetail(hireId: string, name: string, role: string): Promise<void> {
    await closeDetail();
    openHireId = hireId;
    nameEl.textContent = name;
    roleEl.textContent = role;

    term = new Terminal({
        fontFamily: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace',
        fontSize: 13,
        cursorBlink: false,
        // A terminal the roster's dark room can hold without a seam.
        theme: { background: '#0F1319', foreground: '#E7EAF0', cursor: '#57B6A3' },
        scrollback: 4000
    });
    fit = new FitAddon();
    term.loadAddon(fit);

    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
    term.open(termHost);
    fitAndResize();

    // Stream first, then open, so no byte between subscribing and the first paint
    // is missed: main replays the buffer as the first chunk on open.
    offData = window.stafford.session.onData((data) => term?.write(data));
    await window.stafford.session.open(hireId);

    resizeObserver = new ResizeObserver(() => fitAndResize());
    resizeObserver.observe(termHost);
    term.focus();
}

export async function closeDetail(): Promise<void> {
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    if (offData) { offData(); offData = null; }
    if (openHireId) { await window.stafford.session.close(); }
    if (term) { term.dispose(); term = null; }
    fit = null;
    openHireId = null;
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');
}

backButton.addEventListener('click', () => { void closeDetail(); });
