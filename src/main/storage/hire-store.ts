/**
 * The narrow persistence slice for a hire's live state and session binding.
 *
 * Extracted from the old hook `session-registry` when the headless migration removed
 * that file. It stays because the live path still needs it: the ClaudeRunnerManager
 * writes a colleague's state and persists its Claude session id here, and the activity
 * read path resolves a hire from a session id. The registry that used to drive it is
 * gone; the store itself is not tied to hooks and never was.
 */

import type { AgentState } from '../../domain/agent-state.ts';
import type { Repositories } from './repository.ts';

/** The hire and project a Claude session belongs to. */
export interface HireBinding {
    readonly hireId: string;
    readonly projectId: string;
}

/** The narrow slice of persistence the delivery and activity paths need. Injected. */
export interface HireStore {
    /** The hire and project a session belongs to, or null if it maps to none. */
    findBySession(sessionId: string): HireBinding | null;
    /** Persist a hire's roster state. */
    setState(hireId: string, state: AgentState): void;
    /** Records the resolved Claude session id on the hire for a project, for resume. */
    bindSession(hireId: string, projectId: string, sessionId: string): void;
}

/**
 * A `HireStore` backed by the repositories. `findBySession` scans hires, which is
 * bounded by how many the person creates by hand, so it needs no index; `setState`
 * reads the hire and writes it back with the new state.
 */
export function hireStoreOver(repos: Repositories): HireStore {
    return {
        findBySession(sessionId) {
            for (const hire of repos.hires.all()) {
                for (const [projectId, sid] of Object.entries(hire.sessions)) {
                    if (sid === sessionId) return { hireId: hire.id, projectId };
                }
            }
            return null;
        },
        setState(hireId, state) {
            const hire = repos.hires.get(hireId);
            if (!hire) return;
            repos.hires.update({ ...hire, state });
        },
        bindSession(hireId, projectId, sessionId) {
            const hire = repos.hires.get(hireId);
            if (!hire) return;
            repos.hires.update({ ...hire, sessions: { ...hire.sessions, [projectId]: sessionId } });
        }
    };
}
