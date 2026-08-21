/**
 * The roster's live state, held outside React so it runs for the whole session, not
 * only while the roster screen is mounted. The alert rules (a chime on a transition
 * into waiting, a badge that persists until the person looks) must fire even when the
 * person is on another view, so the subscription and the RosterAlerts instance live
 * here and start at launch. React reads this through useSyncExternalStore.
 *
 * It talks only to window.stafford, the frozen bridge: it reads the snapshot and
 * re-reads on a roster:changed signal, the same contract the vanilla roster used.
 */

import type { RosterCard } from '../../shared/ipc.ts';
import { RosterAlerts } from '../roster-alerts.ts';
import { playChime } from './roster-chime.ts';

export interface RosterState {
    readonly cards: readonly RosterCard[];
    /** Waiting colleagues the person has not looked at yet: the badged set. */
    readonly badged: ReadonlySet<string>;
    readonly unseenCount: number;
    /** The colleague whose detail fills the pane, or null. */
    readonly selectedId: string | null;
    /** The selected colleague's card, kept fresh from the snapshot, for the detail header. */
    readonly selectedCard: RosterCard | null;
    readonly muted: boolean;
    /** A clock for the elapsed labels, bumped on a slow timer. */
    readonly now: number;
}

const alerts = new RosterAlerts();
const listeners = new Set<() => void>();

let cards: readonly RosterCard[] = [];
let selectedId: string | null = null;
let selectedCard: RosterCard | null = null;
let muted = false;
let started = false;

/**
 * The cached immutable snapshot. useSyncExternalStore requires getSnapshot to return a
 * stable reference between changes, so the object is rebuilt only in emit(), never per
 * call, and returned as-is otherwise.
 */
let snapshot: RosterState = { cards: [], badged: new Set(), unseenCount: 0, selectedId: null, selectedCard: null, muted: false, now: Date.now() };

function rebuild(): void {
    const badged = new Set<string>();
    for (const card of cards) {
        if (alerts.isBadged(card.id)) badged.add(card.id);
    }
    snapshot = { cards, badged, unseenCount: alerts.unseenCount, selectedId, selectedCard, muted, now: Date.now() };
}

function emit(): void {
    rebuild();
    for (const listener of listeners) listener();
}

async function refresh(): Promise<void> {
    const next = await window.stafford.roster.snapshot();
    cards = next.cards;
    // Keep the selected card fresh so the detail header follows a state change.
    if (selectedId) selectedCard = cards.find((c) => c.id === selectedId) ?? selectedCard;
    const { sound } = alerts.update(cards);
    if (sound && !muted) playChime();
    emit();
}

export const rosterStore = {
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    },

    getSnapshot(): RosterState {
        return snapshot;
    },

    /** Selects a colleague, so the React detail pane shows it and its row reads selected. */
    select(card: RosterCard): void {
        selectedId = card.id;
        selectedCard = card;
        emit();
    },

    toggleMute(): void {
        muted = !muted;
        emit();
    },

    /** The person looked: every currently-waiting card is now seen, so the badges clear. */
    markSeen(): void {
        alerts.markSeen();
        emit();
    },

    /**
     * Re-reads the snapshot now. Creating a hire or a project does not emit a state
     * transition, so the shell calls this after a successful create rather than waiting
     * for a roster:changed that will not come.
     */
    reload(): void {
        void refresh();
    },

    /**
     * Starts the live subscription once, at launch. Idempotent, so a re-import or a
     * second mount cannot double-subscribe. Kept separate from module load so a test
     * can import the pure pieces without a bridge.
     */
    start(): void {
        if (started) return;
        started = true;
        window.stafford.roster.onChanged(() => { void refresh(); });
        // Focusing the window is the person looking: every waiting card is now seen.
        window.addEventListener('focus', () => { rosterStore.markSeen(); });
        // Elapsed labels drift without a repaint, so bump the clock on a slow timer.
        // This reads no new data and fires no alert; it only re-renders the times.
        setInterval(() => { if (cards.length > 0) emit(); }, 30_000);
        void refresh();
    }
};
