/**
 * The pure view model behind the React roster: it turns the raw snapshot into the
 * groups and rows the screen renders, so the grouping, ordering, labels, and per-row
 * treatment have one tested definition and the component stays presentational.
 *
 * It reuses the existing pure roster logic (groupCardsByState, groupLabel, stateLabel)
 * and the dashboard's state-to-dot mapping, so the React roster and the old vanilla
 * roster read the same rules. No data fetching here; the store feeds it.
 */

import type { RosterCard } from '../../shared/ipc.ts';
import { groupCardsByState, groupLabel, stateLabel } from '../roster-view.ts';
import { statusForState, type DotStatus } from '../dashboard/dashboard-data.ts';
import type { Lang } from '../create-forms-view.ts';

export interface RosterRow {
    readonly card: RosterCard;
    readonly status: DotStatus;
    /** The state in plain language, with the project appended: "Working on Stafford". */
    readonly stateText: string;
    /** The unseen waiting badge, from the alert rules. */
    readonly badged: boolean;
    /** Whether this colleague's detail fills the pane, so its row reads selected. */
    readonly selected: boolean;
}

export interface RosterGroup {
    readonly state: string;
    readonly label: string;
    readonly count: number;
    readonly rows: readonly RosterRow[];
}

/**
 * Builds the grouped rows, waiting first, exactly as the vanilla roster did. `now`
 * is passed in so the elapsed labels are deterministic and testable; `badged` and
 * `selectedId` come from the store's alert and selection state.
 */
export function buildRosterGroups(
    cards: readonly RosterCard[],
    lang: Lang,
    now: number,
    badged: ReadonlySet<string>,
    selectedId: string | null
): RosterGroup[] {
    return groupCardsByState(cards).map((group) => ({
        state: group.state,
        label: groupLabel(group.state, lang),
        count: group.cards.length,
        rows: group.cards.map((card) => ({
            card,
            status: statusForState(card.state),
            stateText: stateLabel(card, now) + (card.project ? ' on ' + card.project : ''),
            badged: badged.has(card.id),
            selected: card.id === selectedId
        }))
    }));
}
