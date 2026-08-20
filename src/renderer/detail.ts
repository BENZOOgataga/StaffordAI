/**
 * The detail pane: the selected colleague filling the right pane, with three tabs
 * in priority order, Conversation (default), Activity, and Transcript (last, advanced).
 *
 * Transcript replaced the old raw Terminal once the pty was removed. It is a rendered
 * turn view built from the headless runner's stream, not a terminal: the colleague's
 * own replies interleaved with the tool calls it made, keyed by hire id and read from
 * the same conversation and activity stores the other tabs use. Switching colleagues
 * switches it; a new turn refreshes it off the existing channel:changed signal.
 *
 * The Conversation tab reuses the channel's own message rendering, scoped to this
 * colleague, and its composer sends through the existing reply path. The Activity tab
 * renders this colleague's stored events and tool actions as a feed (activity.ts).
 */

import { DEFAULT_TAB, isTabId, type TabId } from './detail-tabs.ts';
import { channelRowClass, eventLabel, referenceLabel, type Lang } from './channel-view.ts';
import {
    activityRows, stateRowToFeed, activityRowToFeed, mergeFeed,
    feedIcon, toolPhrase, toolStatusLabel, activityTime, type FeedRow
} from './activity-view.ts';
import { ActivityFeed, icon } from './activity.ts';
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
const conversationEl = document.getElementById('conversation') as HTMLElement;
const activityHost = document.getElementById('panel-activity') as HTMLElement;
const transcriptEl = document.getElementById('transcript') as HTMLElement;
const reply = document.getElementById('reply') as HTMLTextAreaElement;

let offChanged: (() => void) | null = null;
let offActivity: (() => void) | null = null;
let openHireId: string | null = null;
let feed: ActivityFeed | null = null;
let refreshScheduled = false;
const names = new Map<string, string>();

function nameFor(senderId: string): string {
    return names.get(senderId) ?? (senderId === CHANNEL_SELF_SENDER ? 'You' : senderId);
}

/** Shows the given tab's panel and marks its tab active. Refreshes the transcript on show. */
function setTab(id: TabId): void {
    for (const tab of document.querySelectorAll('.tab')) {
        const on = tab.getAttribute('data-tab') === id;
        tab.classList.toggle('active', on);
        tab.setAttribute('aria-selected', String(on));
    }
    for (const panel of document.querySelectorAll('.panel')) {
        (panel as HTMLElement).hidden = panel.id !== 'panel-' + id;
    }
    if (id === 'transcript') void refreshTranscript();
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

/** One transcript entry: a colleague reply, or a tool it used, both timestamped. */
type TranscriptItem =
    | { readonly kind: 'text'; readonly id: string; readonly who: string; readonly body: string; readonly at: string }
    | { readonly kind: 'tool'; readonly id: string; readonly row: FeedRow; readonly at: string };

/** A colleague reply renders as a message row; a tool renders in the activity style. */
function transcriptRow(item: TranscriptItem): HTMLElement {
    if (item.kind === 'text') {
        const el = document.createElement('div');
        el.className = 'row message';
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = item.who;
        const body = document.createElement('span');
        body.className = 'body';
        body.textContent = item.body;
        el.append(who, body);
        return el;
    }
    const row = item.row;
    const el = document.createElement('div');
    el.className = 'act-row act-tool';
    const ic = document.createElement('span');
    ic.className = 'act-icon';
    ic.appendChild(icon(feedIcon(row)));
    const line = document.createElement('span');
    line.className = 'act-line';
    line.textContent = row.kind === 'tool' ? toolPhrase(row.tool, row.target, lang) : '';
    el.append(ic, line);
    const statusLabel = row.kind === 'tool' ? toolStatusLabel(row.status, lang) : null;
    if (statusLabel) {
        const status = document.createElement('span');
        status.className = 'act-status';
        status.textContent = statusLabel;
        el.appendChild(status);
        if (row.kind === 'tool' && row.status === 'error') el.classList.add('act-error');
    }
    const time = document.createElement('time');
    time.className = 'act-time';
    time.textContent = activityTime(item.at, Date.now(), lang);
    el.appendChild(time);
    return el;
}

/**
 * Builds the Transcript from this colleague's own replies and its tool actions, merged
 * by time. The colleague's replies are its conversation messages (sender is the hire);
 * the person's own messages are not in the transcript. Tool actions come from the same
 * activity store the Activity tab reads. Re-read in full on each refresh, which is cheap
 * and bounded, so a new turn's rows appear without a separate live stream.
 */
async function refreshTranscript(): Promise<void> {
    const hireId = openHireId;
    if (!hireId) return;
    const [conv, acts] = await Promise.all([
        window.stafford.channel.conversation(hireId, 200),
        window.stafford.activity.byHire(hireId, 200)
    ]);
    const items: TranscriptItem[] = [];
    for (const r of conv.rows) {
        if (r.kind === 'message' && r.senderId === hireId) {
            items.push({ kind: 'text', id: r.id, who: nameFor(r.senderId), body: r.body, at: r.at });
        }
    }
    for (const a of acts.rows) {
        items.push({ kind: 'tool', id: a.id, row: activityRowToFeed(a), at: a.at });
    }
    items.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    transcriptEl.replaceChildren(...items.map(transcriptRow));
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

/**
 * Loads the channel window and updates the tabs. Conversation gets this colleague's
 * messages and events plus the person's own messages. Activity merges the state rows
 * from the channel with, on the first load, the persisted tool history from
 * activity.byHire. The Transcript re-reads on the same signal.
 */
async function refreshDetail(hireId: string, initial: boolean): Promise<void> {
    const { rows } = await window.stafford.channel.conversation(hireId, 100);
    conversationEl.replaceChildren(...rows.map(conversationRow));
    conversationEl.scrollTop = conversationEl.scrollHeight;

    const stateFeed = activityRows(rows, hireId).map(stateRowToFeed);
    if (initial) {
        const { rows: acts } = await window.stafford.activity.byHire(hireId, 200);
        feed?.setInitial(mergeFeed([...stateFeed, ...acts.map(activityRowToFeed)]));
    } else {
        feed?.apply(stateFeed);
    }

    // Keep the Transcript current too, so a turn's replies and tools show as they land.
    void refreshTranscript();
}

/**
 * Coalesces a burst of channel:changed signals into one refresh on the next frame, so
 * several transitions arriving together redraw the detail once rather than once each.
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

    await loadNames();
    feed = new ActivityFeed(activityHost, { nameOf: nameFor, now: () => Date.now(), lang });
    await refreshDetail(hireId, true);
    offChanged = window.stafford.channel.onChanged(() => scheduleRefresh());
    // A live tool action pushes in one at a time, appended to the feed.
    offActivity = window.stafford.activity.onAppended((row) => {
        if (openHireId && row.hireId === openHireId) feed?.apply([activityRowToFeed(row)]);
    });

    reply.focus();
}

export async function closeDetail(): Promise<void> {
    if (offChanged) { offChanged(); offChanged = null; }
    if (offActivity) { offActivity(); offActivity = null; }
    openHireId = null;
    feed = null;
    refreshScheduled = false;
    conversationEl.replaceChildren();
    transcriptEl.replaceChildren();
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

// The composer: Enter sends to the colleague, Shift-Enter adds a line. It records the
// message in the channel and delivers it to the colleague through the one reply path,
// so the Conversation shows it and no new send logic is introduced here.
reply.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    const text = reply.value;
    if (text.trim().length === 0 || !openHireId) return;
    reply.value = '';
    void window.stafford.channel.reply(openHireId, text);
});
