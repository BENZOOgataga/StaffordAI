/**
 * The dashboard's data logic, kept pure and out of the view so it is tested without a
 * browser or React. It reduces the real roster cards and the real project count into
 * the overview the dashboard shows: counts by colleague state, and the list of
 * colleagues. No invented metrics; every number comes from data Stafford already has.
 */

import type { RosterCard } from '../../shared/ipc.ts';

/** A colleague's state mapped to a StatusDot status, so the view stays presentational. */
export type DotStatus = 'working' | 'idle' | 'waiting' | 'error' | 'offline';

export function statusForState(state: string): DotStatus {
    switch (state) {
        case 'working':
            return 'working';
        case 'idle':
            return 'idle';
        case 'waiting_for_you':
            return 'waiting';
        case 'rate_limited':
            return 'waiting';
        case 'crashed':
        case 'needs_trust':
        case 'not_reporting':
            return 'error';
        default:
            return 'offline';
    }
}

export interface StateCounts {
    readonly working: number;
    readonly idle: number;
    readonly waiting: number;
    readonly other: number;
}

export interface OverviewStats {
    /** Total colleagues. */
    readonly total: number;
    /** Colleagues that are working or waiting for you, the ones needing attention. */
    readonly active: number;
    /** Real project count, from projects.list. */
    readonly projects: number;
    readonly byState: StateCounts;
}

export interface Overview {
    readonly stats: OverviewStats;
    readonly cards: readonly RosterCard[];
    /** True when there are no colleagues yet, so the view shows a real empty state. */
    readonly empty: boolean;
}

/** Reduces the real snapshot and project count into the overview. Pure. */
export function computeOverview(cards: readonly RosterCard[], projectCount: number): Overview {
    let working = 0;
    let idle = 0;
    let waiting = 0;
    let other = 0;
    for (const card of cards) {
        switch (statusForState(card.state)) {
            case 'working':
                working += 1;
                break;
            case 'idle':
                idle += 1;
                break;
            case 'waiting':
                waiting += 1;
                break;
            default:
                other += 1;
        }
    }
    return {
        stats: {
            total: cards.length,
            active: working + waiting,
            projects: projectCount,
            byState: { working, idle, waiting, other }
        },
        cards,
        empty: cards.length === 0
    };
}
