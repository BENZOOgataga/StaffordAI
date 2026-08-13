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
import { fitToContainer } from './terminal-fit.ts';
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
const reply = document.getElementById('reply') as HTMLTextAreaElement;

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let offData: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let openHireId: string | null = null;

/**
 * Fits the terminal to its pane and propagates the size to the pty, but only once
 * the pane has a real layout. Fitting a zero-sized pane on the raw mount hands the
 * pty a bogus size and garbles the paint; the ResizeObserver calls this again on
 * the first real size, which is when the fit measures correctly. See terminal-fit.
 */
function fitAndResize(): void {
    if (!term || !fit || !openHireId) return;
    const hireId = openHireId;
    const activeTerm = term;
    const activeFit = fit;
    try {
        fitToContainer(
            termHost,
            { fit: () => activeFit.fit(), get cols() { return activeTerm.cols; }, get rows() { return activeTerm.rows; } },
            (cols, rows) => void window.stafford.session.resize(hireId, cols, rows)
        );
    } catch {
        // A transient degenerate layout during open or close; the observer refits
        // on the next real size.
    }
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

    // Fit on the first real layout and every later resize through one path. The
    // observer fires when the pane has a real size, which is exactly when a fit
    // measures correctly, so the pty gets the right dimensions before the first
    // output paints rather than a manual resize later. Attached before the open so
    // the replay renders at the fitted size, not the raw-mount size. A guarded
    // immediate call covers a reopen whose pane is already laid out; it is a no-op
    // while the pane is still zero-sized.
    resizeObserver = new ResizeObserver(() => fitAndResize());
    resizeObserver.observe(termHost);
    fitAndResize();

    // Stream first, then open, so no byte between subscribing and the first paint
    // is missed: main replays the buffer as the first chunk on open.
    offData = window.stafford.session.onData((data) => term?.write(data));
    await window.stafford.session.open(hireId);

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

// Enter sends the message to the open colleague; Shift-Enter adds a line. The
// write is scoped to the open card: it targets openHireId, and main only writes to
// the session whose card is open, so a message never lands on the wrong colleague.
reply.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    const text = reply.value;
    if (text.trim().length === 0 || !openHireId) return;
    reply.value = '';
    void window.stafford.session.write(openHireId, text);
    term?.focus();
});
