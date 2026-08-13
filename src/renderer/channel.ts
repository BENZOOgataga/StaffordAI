/**
 * The channel timeline view. Renders the unified message-and-event stream piece 1
 * writes, in time order, and keeps it current off the channel:changed signal
 * rather than re-reading the whole stream: on a signal it fetches only the rows
 * after the newest it holds, and scrolling to the top loads an older page.
 *
 * It talks only to `window.stafford`, the frozen bridge. Sender names come from the
 * roster snapshot, so an event row's id resolves to the colleague's name. Event
 * text is localized from the state enum, never read as a phrase from the row, which
 * is the i18n seam. No reply box; that is piece 3.
 */

import {
    eventLabel, referenceLabel, channelRowClass, resolveReplyTarget, Timeline, type Lang
} from './channel-view.ts';
import { CHANNEL_SELF_SENDER, type ChannelMessageRow } from '../shared/ipc.ts';

const timelineEl = document.getElementById('timeline') as HTMLElement;

const PAGE = 50;

const timeline = new Timeline();
const names = new Map<string, string>();
let active = false;
let offChanged: (() => void) | null = null;
let loadingOlder = false;

const lang: Lang = typeof navigator !== 'undefined' && navigator.language.startsWith('fr') ? 'fr' : 'en';

function nameFor(senderId: string): string {
    return names.get(senderId) ?? (senderId === CHANNEL_SELF_SENDER ? 'You' : senderId);
}

/**
 * The inline reply on a colleague row: a quiet control that reveals a one-line
 * input. Enter sends to the colleague the row is about, Shift-Enter adds a line,
 * consistent with the detail view. The reply lands in the timeline as a message
 * from You through the tail append, so nothing is re-fetched.
 */
function replyAffordance(hireId: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'row-reply';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'row-reply-toggle';
    toggle.textContent = 'Reply';

    const input = document.createElement('textarea');
    input.className = 'row-reply-input';
    input.rows = 1;
    input.hidden = true;
    input.placeholder = 'Reply to ' + nameFor(hireId) + '. Enter sends, Shift-Enter adds a line.';

    toggle.addEventListener('click', () => {
        input.hidden = !input.hidden;
        if (!input.hidden) input.focus();
    });
    input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        const text = input.value;
        if (text.trim().length === 0) return;
        input.value = '';
        input.hidden = true;
        void window.stafford.channel.reply(hireId, text);
    });

    wrap.append(toggle, input);
    return wrap;
}

function rowElement(row: ChannelMessageRow): HTMLElement {
    const el = document.createElement('div');
    el.className = channelRowClass(row.kind, row.body);

    if (row.kind === 'event') {
        // The whole line, name included, localized from the enum.
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

    // A reply goes to the colleague the row is about. The person's own messages are
    // not reply targets.
    const target = resolveReplyTarget(row);
    if (target) el.appendChild(replyAffordance(target));
    return el;
}

function renderAll(): void {
    timelineEl.replaceChildren(...timeline.rows.map(rowElement));
    timelineEl.scrollTop = timelineEl.scrollHeight;
}

async function loadNames(): Promise<void> {
    const snapshot = await window.stafford.roster.snapshot();
    names.clear();
    for (const card of snapshot.cards) names.set(card.id, card.name);
}

async function loadInitial(): Promise<void> {
    const { rows } = await window.stafford.channel.page(null, PAGE);
    timeline.setInitial(rows);
    renderAll();
}

/** On a signal, fetch only the rows newer than the newest held, and append them. */
async function pullTail(): Promise<void> {
    const cursor = timeline.newestCursor();
    if (!cursor) { await loadInitial(); return; }
    const { rows } = await window.stafford.channel.since(cursor, PAGE);
    const added = timeline.appendTail(rows);
    if (added.length === 0) return;
    for (const row of added) timelineEl.appendChild(rowElement(row));
    timelineEl.scrollTop = timelineEl.scrollHeight;
}

/** Scrolling to the top loads an older page, prepending without touching the tail. */
async function loadOlder(): Promise<void> {
    if (loadingOlder) return;
    const cursor = timeline.oldestCursor();
    if (!cursor) return;
    loadingOlder = true;
    try {
        const { rows } = await window.stafford.channel.page(cursor, PAGE);
        const added = timeline.prependOlder(rows);
        if (added.length === 0) return;
        const before = timelineEl.scrollHeight;
        for (const row of [...added].reverse()) timelineEl.insertBefore(rowElement(row), timelineEl.firstChild);
        // Keep the reading position steady as older rows push the view down.
        timelineEl.scrollTop += timelineEl.scrollHeight - before;
    } finally {
        loadingOlder = false;
    }
}

timelineEl.addEventListener('scroll', () => { if (timelineEl.scrollTop < 40) void loadOlder(); });

export async function activateChannel(): Promise<void> {
    active = true;
    await loadNames();
    await loadInitial();
    offChanged = window.stafford.channel.onChanged(() => { if (active) void pullTail(); });
}

export function deactivateChannel(): void {
    active = false;
    if (offChanged) { offChanged(); offChanged = null; }
}
