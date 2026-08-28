/**
 * The pure view logic behind a roster card: the class it carries and the plain
 * language it shows for a state. Kept out of the DOM shell so it is tested without
 * a browser, and so the state-to-treatment mapping has one definition both the
 * card and its tests read.
 */

import type { RosterCard } from '../shared/ipc.ts';

/**
 * The card's class list. The state is a class, so the stylesheet gives each state
 * its own treatment: idle recedes, working is cool, waiting is the warm summons,
 * and not_reporting is the dashed, unreachable one. The badge is separate, the
 * unseen-waiting marker.
 */
export function cardClassName(state: string, badged: boolean): string {
    return 'card ' + state + (badged ? ' badged' : '');
}

/** The state in plain language, never a raw enum, and language-flexible. */
export function stateLabel(card: RosterCard, now: number): string {
    switch (card.state) {
        case 'working': return 'Working';
        case 'waiting_for_you': return 'Waiting for you';
        case 'rate_limited': return 'Rate limited';
        case 'crashed': return 'Crashed';
        case 'needs_trust': return 'Needs trust';
        // A turn that could not start: containment refused the spawn, the config seed failed, or the
        // process could not launch. The specific reason is recorded in the conversation. Not idle (it
        // did not rest, it never ran) and not crashed (nothing exited). The state value stays
        // `not_reporting`, the old hook-era state that nothing sets any more, repurposed here.
        case 'not_reporting': return 'Blocked';
        default: return elapsedLabel('Idle', card.since, now);
    }
}

export interface CardGroup {
    readonly state: string;
    readonly cards: readonly RosterCard[];
}

/**
 * The order the roster groups states in: the one that needs the person first, then
 * the other states that also need attention, then the active ones, then the quiet.
 * The spec names waiting, working, idle, not_reporting in that relative order; the
 * three attention states (needs_trust, crashed, rate_limited) sit just after
 * waiting, since they also need the person, rather than at the bottom below idle.
 */
export const GROUP_ORDER: readonly string[] = [
    'waiting_for_you', 'needs_trust', 'crashed', 'not_reporting', 'rate_limited', 'working', 'idle'
];

/**
 * Groups the cards by state in GROUP_ORDER, dropping empty groups so a state with
 * no colleagues shows no header. A state not in the order keeps its cards visible,
 * appended, so a new state can never make a colleague vanish.
 */
export function groupCardsByState(cards: readonly RosterCard[]): CardGroup[] {
    const byState = new Map<string, RosterCard[]>();
    for (const card of cards) {
        const list = byState.get(card.state) ?? [];
        list.push(card);
        byState.set(card.state, list);
    }
    const groups: CardGroup[] = [];
    for (const state of GROUP_ORDER) {
        const list = byState.get(state);
        if (list && list.length > 0) { groups.push({ state, cards: list }); byState.delete(state); }
    }
    for (const [state, list] of byState) {
        if (list.length > 0) groups.push({ state, cards: list });
    }
    return groups;
}

/** The state name for a group header, in plain language, localized. */
export function groupLabel(state: string, lang: 'en' | 'fr'): string {
    const en: Record<string, string> = {
        waiting_for_you: 'Waiting for you', needs_trust: 'Needs trust', crashed: 'Crashed',
        rate_limited: 'Rate limited', working: 'Working', idle: 'Idle', not_reporting: 'Blocked'
    };
    const fr: Record<string, string> = {
        waiting_for_you: 'En attente de vous', needs_trust: 'Confiance requise', crashed: 'Planté',
        rate_limited: 'Limite atteinte', working: 'Au travail', idle: 'Inactif', not_reporting: 'Bloqué'
    };
    return (lang === 'fr' ? fr : en)[state] ?? state;
}

/** Turns an ISO start time into a quiet "for 12m" suffix, or nothing. */
export function elapsedLabel(base: string, since: string | null, now: number): string {
    if (!since) return base;
    const started = Date.parse(since);
    if (Number.isNaN(started)) return base;
    const minutes = Math.floor((now - started) / 60_000);
    if (minutes < 1) return base;
    if (minutes < 60) return base + ' for ' + minutes + 'm';
    const hours = Math.floor(minutes / 60);
    return base + ' for ' + hours + 'h';
}
