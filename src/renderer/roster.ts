/**
 * The roster renderer. Talks only to `window.stafford`, the frozen bridge: no
 * Node, no ipcRenderer, no network. It reads the snapshot, renders a card per
 * colleague, and re-reads on a roster:changed signal rather than on every hook
 * event, so the view updates on a real state change and nothing else.
 *
 * The alert rules live in roster-alerts.ts, pure and tested. This file is the
 * shell around them: it plays the sound when they say to, paints the badge when
 * they say a card is unseen, and marks everything seen when the window is
 * focused, which is what "the person looked" means here.
 */

import type { StaffordApi } from '../preload/index.ts';
import type { RosterCard } from '../shared/ipc.ts';
import { RosterAlerts } from './roster-alerts.ts';
import { cardClassName, stateLabel } from './roster-view.ts';

declare global {
    interface Window {
        readonly stafford: StaffordApi;
    }
}

const roster = document.getElementById('roster') as HTMLElement;
const waitingCount = document.getElementById('waiting-count') as HTMLElement;
const muteButton = document.getElementById('mute') as HTMLButtonElement;

const alerts = new RosterAlerts();
let muted = false;
let latest: readonly RosterCard[] = [];

function chip(label: string): HTMLElement {
    const el = document.createElement('span');
    el.className = 'chip';
    el.textContent = label;
    return el;
}

function cardElement(card: RosterCard): HTMLElement {
    const el = document.createElement('article');
    el.className = cardClassName(card.state, alerts.isBadged(card.id));

    const rail = document.createElement('span');
    rail.className = 'rail';
    rail.setAttribute('aria-hidden', 'true');
    el.appendChild(rail);

    const body = document.createElement('div');
    body.className = 'body';

    const nameRow = document.createElement('div');
    nameRow.className = 'name-row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = card.name;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.setAttribute('aria-hidden', 'true');
    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = card.role;
    nameRow.append(name, badge, role);
    body.appendChild(nameRow);

    const state = document.createElement('div');
    state.className = 'state-line';
    state.textContent = stateLabel(card, Date.now()) + (card.project ? ' on ' + card.project : '');
    body.appendChild(state);

    if (card.task) {
        const task = document.createElement('div');
        task.className = 'task';
        task.textContent = card.task;
        body.appendChild(task);
    }

    if (card.contextLost) {
        // A quiet note, not an alarm: the resume did not take, so this colleague
        // started clean and remembers nothing from before.
        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = 'Started clean, earlier context lost';
        body.appendChild(note);
    }

    el.appendChild(body);

    const meta = document.createElement('div');
    meta.className = 'meta';
    if (card.apprentices > 0) meta.appendChild(chip(card.apprentices + ' apprentices'));
    if (card.queued > 0) meta.appendChild(chip(card.queued + ' queued'));
    if (meta.childElementCount > 0) el.appendChild(meta);

    return el;
}

function render(): void {
    roster.replaceChildren();

    if (latest.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        const lead = document.createElement('strong');
        lead.textContent = 'No colleagues yet';
        const rest = document.createTextNode('Hire your first colleague to see them here.');
        empty.append(lead, rest);
        roster.appendChild(empty);
        waitingCount.textContent = '';
        waitingCount.classList.remove('active');
        return;
    }

    for (const card of latest) roster.appendChild(cardElement(card));

    const unseen = alerts.unseenCount;
    if (unseen > 0) {
        waitingCount.textContent = unseen === 1 ? '1 waiting for you' : unseen + ' waiting for you';
        waitingCount.classList.add('active');
    } else {
        waitingCount.textContent = '';
        waitingCount.classList.remove('active');
    }
}

/**
 * A short, soft two-note chime, synthesized so no audio file has to load under
 * the CSP. Wrapped in try and catch: a blocked or unavailable audio context must
 * never break the view, since the badge already carries the signal visually.
 */
function playChime(): void {
    if (muted) return;
    try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const now = ctx.currentTime;
        for (const [i, freq] of [523.25, 698.46].entries()) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            const start = now + i * 0.12;
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(0.12, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
            osc.connect(gain).connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 0.3);
        }
        setTimeout(() => void ctx.close(), 800);
    } catch {
        // The badge is the visual half of the same signal, so a silent failure
        // here loses nothing the person cannot see.
    }
}

async function refresh(): Promise<void> {
    const snapshot = await window.stafford.roster.snapshot();
    latest = snapshot.cards;
    const { sound } = alerts.update(latest);
    if (sound) playChime();
    render();
}

function main(): void {
    muteButton.addEventListener('click', () => {
        muted = !muted;
        // The label names the action, not the state, so it is never ambiguous:
        // it says what a click does next.
        muteButton.textContent = muted ? 'Unmute' : 'Mute';
        muteButton.setAttribute('aria-pressed', String(muted));
    });

    // Focusing the window is the person looking: every waiting card is now seen,
    // so the badges clear. A card that enters waiting afterwards badges again.
    window.addEventListener('focus', () => { alerts.markSeen(); render(); });

    // The roster updates on a real state change, not on every hook event: main
    // emits roster:changed only on a transition, and this re-reads then.
    window.stafford.roster.onChanged(() => { void refresh(); });

    // Elapsed labels drift without a repaint, so tick them on a slow timer. This
    // reads no new data and fires no alert; it only re-renders the times.
    setInterval(() => { if (latest.length > 0) render(); }, 30_000);

    void refresh();
}

main();
