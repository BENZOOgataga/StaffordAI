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
        // Spawned, cannot be heard from, cause unknown. Not idle (it is not
        // resting) and not waiting (it is not a summons): the person cannot reach
        // this one.
        case 'not_reporting': return 'Not reporting';
        default: return elapsedLabel('Idle', card.since, now);
    }
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
