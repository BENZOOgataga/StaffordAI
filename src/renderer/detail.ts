/**
 * The detail pane: the selected colleague filling the right pane, with three tabs
 * in priority order, Conversation (default), Activity, and Terminal (last, the raw
 * pty as it worked before).
 *
 * The terminal is unchanged in behaviour: the same xterm, the same
 * replay-then-stream subscription, the same fit-to-pane sizing. It has only moved
 * from the front door to the last tab. The Conversation tab reuses the channel's
 * own message rendering, scoped to this colleague, and its composer sends through
 * the existing reply path, so no new message logic is introduced here.
 *
 * The Activity tab renders this colleague's stored events as a feed (activity.ts),
 * fed from the same channel window the Conversation reads, so one fetch serves both
 * and a change appends to the feed off the existing channel:changed signal.
 */

import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { fitToContainer } from './terminal-fit.ts';
import { DEFAULT_TAB, isTabId, type TabId } from './detail-tabs.ts';
import { channelRowClass, eventLabel, referenceLabel, type Lang } from './channel-view.ts';
import { activityRows } from './activity-view.ts';
import { ActivityFeed } from './activity.ts';
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
const activityHost = document.getElementById('panel-activity') as HTMLElement;
const reply = document.getElementById('reply') as HTMLTextAreaElement;

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let offData: (() => void) | null = null;
let offChanged: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let openHireId: string | null = null;
let feed: ActivityFeed | null = null;
let refreshScheduled = false;
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
 * Loads the channel window once and updates both tabs from it: Conversation gets
 * this colleague's messages and events plus the person's own messages, reusing the
 * channel's rendering; Activity gets only this colleague's events, as a feed. One
 * fetch feeds both so a change does not read the stream twice.
 *
 * On the first load the feed is painted whole; a later change appends only its new
 * rows rather than rebuilding, which is why Activity takes the row list through
 * setInitial once and apply after. The Conversation tab keeps its simple full
 * re-render, which it already had and which is cheap for its window.
 */
async function refreshDetail(hireId: string, initial: boolean): Promise<void> {
    const { rows } = await window.stafford.channel.page(null, 100);
    const mine = rows.filter((r) => r.senderId === hireId || r.senderId === CHANNEL_SELF_SENDER);
    conversationEl.replaceChildren(...mine.map(conversationRow));
    conversationEl.scrollTop = conversationEl.scrollHeight;

    const acts = activityRows(rows, hireId);
    if (initial) feed?.setInitial(acts);
    else feed?.apply(acts);
}

/**
 * Coalesces a burst of channel:changed signals into one refresh on the next frame,
 * so several transitions arriving together redraw the detail once rather than once
 * each. It fires off the same signal the roster and channel already use, not a
 * poll, and the append seam in the feed means the extra rows are added, not redrawn.
 */
function scheduleRefresh(): void {
    if (refreshScheduled || !openHireId) return;
    refreshScheduled = true;
    const run = (): void => {
        refreshScheduled = false;
        const hireId = openHireId;
        if (hireId) void refreshDetail(hireId, false);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
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
    feed = new ActivityFeed(activityHost, { nameOf: nameFor, now: () => Date.now(), lang });
    await refreshDetail(hireId, true);
    offChanged = window.stafford.channel.onChanged(() => scheduleRefresh());

    reply.focus();
}

export async function closeDetail(): Promise<void> {
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    if (offData) { offData(); offData = null; }
    if (offChanged) { offChanged(); offChanged = null; }
    if (openHireId) { await window.stafford.session.close(); }
    if (term) { term.dispose(); term = null; }
    fit = null;
    openHireId = null;
    feed = null;
    refreshScheduled = false;
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
