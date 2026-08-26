/**
 * Managing a project after it exists: editing its name and folder, deleting it, and rebinding a
 * parked colleague. The backend of the Projects tab, over the same repository the create flow writes.
 *
 * Folder editing reuses the create flow's exact path validation (existing directory, not Stafford's
 * own tree), so an edit can never point a project somewhere a create could not. Deleting a project
 * unbinds its colleagues and parks them rather than deleting them: parking is setting activeProjectId
 * to null, so the colleague stays in the roster, cannot resolve a cwd, and cannot spawn until rebound.
 * A rebind is a fresh start on the new project, a new session and a clean history view, never a move
 * of the old session's context onto the new project.
 *
 * Injected deps (the directory check, the self-path guard, the repository reads and writes, the
 * clock), so the logic is provable headlessly against a real temp store.
 */

import type { HiredAgent, Project } from '../../domain/models.ts';
import { validateRepoPaths } from './create-flow.ts';
import { AGENT_STATES } from '../../domain/agent-state.ts';

export interface ManageDeps {
    readonly dirExists: (path: string) => boolean;
    readonly isSelfPath: (path: string) => boolean;
    readonly getProject: (id: string) => Project | null;
    readonly updateProject: (project: Project) => void;
    readonly deleteProject: (id: string) => void;
    readonly allHires: () => readonly HiredAgent[];
    readonly getHire: (id: string) => HiredAgent | null;
    readonly updateHire: (hire: HiredAgent) => void;
    readonly labelFor: (path: string) => string;
    readonly now: () => string;
}

export interface UpdateProjectInput {
    readonly id: string;
    readonly name: string;
    readonly repoPaths: readonly string[];
}

/**
 * Edits a project's name and folders. Validates the paths exactly as a create does, before writing,
 * so a bad edit never half-applies and never repoints at Stafford's own tree. The policy is preserved
 * unchanged; only the name and repos move. A missing project is an error, not a silent no-op, so a
 * stale edit is surfaced rather than swallowed.
 */
export function updateProject(deps: ManageDeps, input: UpdateProjectInput): void {
    const name = input.name?.trim();
    if (!name) throw new Error('a project needs a name');
    const existing = deps.getProject(input.id);
    if (!existing) throw new Error('no such project: ' + String(input.id));
    validateRepoPaths(deps, input.repoPaths);
    deps.updateProject({
        ...existing,
        name,
        repos: input.repoPaths.map((path) => ({ path, label: deps.labelFor(path) }))
    });
}

/** A colleague still working when a delete is attempted, so the caller can refuse rather than strand it. */
export class ProjectBusyError extends Error {
    readonly hireName: string;
    constructor(hireName: string) {
        super('a colleague on this project is still working; wait until it is idle, then delete');
        this.hireName = hireName;
    }
}

/**
 * Deletes a project and parks its colleagues. Refuses when a bound colleague is not idle, so a delete
 * never strands a turn in flight (the caller waits, then retries). Otherwise each bound colleague is
 * unbound (activeProjectId null) and the deleted project's session slot is dropped from its map, so no
 * dangling reference to the gone project is left. The colleagues are not deleted: deleting the project
 * is the person's consent to lose that project's context, and a parked colleague can be rebound.
 */
export function deleteProject(deps: ManageDeps, id: string): void {
    if (!deps.getProject(id)) throw new Error('no such project: ' + String(id));
    const bound = deps.allHires().filter((h) => h.activeProjectId === id);
    const busy = bound.find((h) => h.state !== AGENT_STATES.IDLE);
    if (busy) throw new ProjectBusyError(busy.name);

    for (const hire of bound) {
        const sessions = { ...hire.sessions };
        delete sessions[id];
        deps.updateHire({ ...hire, activeProjectId: null, sessions });
    }
    deps.deleteProject(id);
}

export interface RebindInput {
    readonly hireId: string;
    readonly projectId: string;
}

/**
 * Rebinds a colleague to a project as a fresh start. Sets activeProjectId to the new project, clears
 * that project's session slot so the next turn resolves a null resume id and Claude starts a new
 * session, and moves the binding epoch to now so the conversation and activity views read clean from
 * here, never carrying the old project's context. The colleague must exist and the target project must
 * exist; a colleague that is not idle is left alone, so a rebind never interrupts a turn in flight.
 */
export function rebindHire(deps: ManageDeps, input: RebindInput): void {
    const hire = deps.getHire(input.hireId);
    if (!hire) throw new Error('no such colleague: ' + String(input.hireId));
    if (!deps.getProject(input.projectId)) throw new Error('no such project: ' + String(input.projectId));
    if (hire.state !== AGENT_STATES.IDLE) {
        throw new Error('this colleague is still working; wait until it is idle, then rebind');
    }
    // A fresh session on the new project: drop any stored session for it, so resolveTarget resolves a
    // null resume id and Claude starts clean, matching a freshly-hired colleague.
    const sessions = { ...hire.sessions };
    delete sessions[input.projectId];
    deps.updateHire({
        ...hire,
        activeProjectId: input.projectId,
        sessions,
        activeSince: deps.now(),
        state: AGENT_STATES.IDLE
    });
}
