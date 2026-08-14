/**
 * The detail pane: the selected colleague filling the right pane, with three tabs
 * in priority order, Conversation (default), Activity (a placeholder this piece),
 * and Terminal (last, the raw pty as it worked before).
 *
 * The terminal is unchanged in behaviour: the same xterm, the same
 * replay-then-stream subscription, the same fit-to-pane sizing. It has only moved
 * from the front door to the last tab. The Conversation tab reuses the channel's
 * own message rendering, scoped to this colleague, and its composer sends through
 * the existing reply path, so no new message logic is introduced here.
 *
 * The Activity tab is a placeholder in this piece. Its events feed is piece 2.
 */

import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { fitToContainer } from './terminal-fit.ts';
import { DEFAULT_TAB, isTabId, type TabId } from './detail-tabs.ts';
import { channelRowClass, eventLabel, referenceLabel, type Lang } from './channel-view.ts';
import { CHANNEL_SELF_SENDER, type ChannelMessageRow } from '../shared/ipc.ts';
import type { StaffordApi } from '../preload/index.ts';

declare global {
    interface Window {
        readonly stafford: StaffordApi;
    }
}

const lang: Lang = typeof navigator !== 'undefined' && navigator.language.startsWith('fr') ? 'fr' : 'en';

const emptyState = document.getElementById('detail-empty') as HTMLElement;
const detail = document.getElementById('detail') as HTMLElement;
const nameEl = document.getElementById('detail-name') as HTMLElement;
const roleEl = document.getElementById('detail-role') as HTMLElement;
const termHost = document.getElementById('term') as HTMLElement;
const conversationEl = document.getElementById('conversation') as HTMLElement;
const reply = document.getElementById('reply') as HTMLTextAreaElement;

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let offData: (() => void) | null = null;
let offConversation: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let openHireId: string | null = null;
const names = new Map<string, string>();

function nameFor(senderId: string): string {
    return names.get(senderId) ?? (senderId === CHANNEL_SELF_SENDER ? 'You' : senderId);
}

/** Fits the terminal to its pane, but only once the pane has a real size. */
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
        // A transient degenerate layout while a tab is hidden; the observer refits.
    }
}

/** Shows the given tab's panel and marks its tab active. Fits the terminal on show. */
function setTab(id: TabId): void {
    for (const tab of document.querySelectorAll('.tab')) {
        const on = tab.getAttribute('data-tab') === id;
        tab.classList.toggle('active', on);
        tab.setAttribute('aria-selected', String(on));
    }
    for (const panel of document.querySelectorAll('.panel')) {
        (panel as HTMLElement).hidden = panel.id !== 'panel-' + id;
    }
    // The terminal panel was zero-sized while hidden, so fit it now that it shows.
    if (id === 'terminal') fitAndResize();
}

function conversationRow(row: ChannelMessageRow): HTMLElement {
    const el = document.createElement('div');
    el.className = channelRowClass(row.kind, row.body);
    if (row.kind === 'event') {
        const line = document.createElement('span');
        line.className = 'line';
        line.textContent = eventLabel(row.body, nameFor(row.senderId), lang);
        el.appendChild(line);
    } else {
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = nameFor(row.senderId);
        const body = document.createElement('span');
        body.className = 'body';
        body.textContent = row.body;
        el.append(who, body);
    }
    const ref = referenceLabel(row.reference);
    if (ref) {
        const chip = document.createElement('span');
        chip.className = 'ref';
        chip.textContent = ref;
        el.appendChild(chip);
    }
    return el;
}

/**
 * Loads the colleague's messages and events from the channel, reusing its
 * rendering. Scoped to this colleague by sender, plus the person's own messages.
 * A per-colleague conversation store, and the colleague's structured replies, are
 * later work; today the replies live in the Terminal tab.
 */
async function loadConversation(hireId: string): Promise<void> {
    const { rows } = await window.stafford.channel.page(null, 100);
    const mine = rows.filter((r) => r.senderId === hireId || r.senderId === CHANNEL_SELF_SENDER);
    conversationEl.replaceChildren(...mine.map(conversationRow));
    conversationEl.scrollTop = conversationEl.scrollHeight;
    void hireId;
}

async function loadNames(): Promise<void> {
    const snapshot = await window.stafford.roster.snapshot();
    names.clear();
    for (const card of snapshot.cards) names.set(card.id, card.name);
}

export async function openDetail(hireId: string, name: string, role: string): Promise<void> {
    await closeDetail();
    openHireId = hireId;
    nameEl.textContent = name;
    roleEl.textContent = role;
    emptyState.hidden = true;
    detail.hidden = false;
    setTab(DEFAULT_TAB);

    term = new Terminal({
        fontFamily: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace',
        fontSize: 13,
        cursorBlink: false,
        theme: { background: '#0A0A0A', foreground: '#EDEDED', cursor: '#8F8F8F' },
        scrollback: 4000
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHost);

    // Fit on the terminal panel's first real layout and every later resize.
    resizeObserver = new ResizeObserver(() => fitAndResize());
    resizeObserver.observe(termHost);
    fitAndResize();

    offData = window.stafford.session.onData((data) => term?.write(data));
    await window.stafford.session.open(hireId);

    await loadNames();
    await loadConversation(hireId);
    offConversation = window.stafford.channel.onChanged(() => { if (openHireId) void loadConversation(openHireId); });

    reply.focus();
}

export async function closeDetail(): Promise<void> {
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    if (offData) { offData(); offData = null; }
    if (offConversation) { offConversation(); offConversation = null; }
    if (openHireId) { await window.stafford.session.close(); }
    if (term) { term.dispose(); term = null; }
    fit = null;
    openHireId = null;
    conversationEl.replaceChildren();
    detail.hidden = true;
    emptyState.hidden = false;
}

// The tab bar switches panels. Instant on click.
for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
        const id = tab.getAttribute('data-tab') ?? '';
        if (isTabId(id)) setTab(id);
    });
}

// The composer: Enter sends to the colleague, Shift-Enter adds a line. It records
// the message in the channel and delivers it to the session through the one reply
// path, so the transcript above shows it and no new send logic is introduced.
reply.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    const text = reply.value;
    if (text.trim().length === 0 || !openHireId) return;
    reply.value = '';
    void window.stafford.channel.reply(openHireId, text);
});
