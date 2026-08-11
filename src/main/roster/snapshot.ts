/**
 * Assembles the roster snapshot from persisted hires and live session data.
 *
 * Pure and injected, so it is tested without a database or the registry. The hire
 * carries the persisted fields (name, role, state, active project); the live
 * session carries what only exists while a session runs (the apprentice count and
 * when the current state began). A hire with no live session still shows a card,
 * from its persisted state, because a colleague is on the roster whether or not a
 * process is up for them right now.
 *
 * State and the task line are the primary fields, foregrounded on the card. The
 * task line is null until task dispatch exists; the field is a real seam, not
 * invented data, and the renderer shows it only when present.
 */

import type { HiredAgent } from '../../domain/models.ts';
import type { RosterCard, RosterSnapshot } from '../../shared/ipc.ts';

/** What only exists while a session runs, keyed to a hire. */
export interface LiveInfo {
    readonly apprentices: number;
    readonly since: string | null;
}

export interface RosterSources {
    /** Every hire, fired ones already excluded by the caller or here. */
    readonly hires: readonly HiredAgent[];
    /** The active project's name for a hire, or null. Never a path. */
    readonly projectName: (projectId: string) => string | null;
    /** Live session info for a hire, or null when no session is up. */
    readonly live: (hireId: string) => LiveInfo | null;
    /** The current task text for a hire, or null. Null until dispatch exists. */
    readonly currentTask: (hireId: string) => string | null;
}

export function assembleRoster(sources: RosterSources): RosterSnapshot {
    const cards: RosterCard[] = [];
    for (const hire of sources.hires) {
        // A fired hire is not a colleague on the roster.
        if (hire.firedAt !== null) continue;

        const live = sources.live(hire.id);
        cards.push({
            id: hire.id,
            name: hire.name,
            role: hire.title,
            state: hire.state,
            project: hire.activeProjectId ? sources.projectName(hire.activeProjectId) : null,
            task: sources.currentTask(hire.id),
            apprentices: live?.apprentices ?? 0,
            queued: 0,
            since: live?.since ?? null
        });
    }
    return { cards };
}
