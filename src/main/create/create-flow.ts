/**
 * Creating a real project and a real hire, over the repository inserts that
 * already exist. This is the backend of the create flow: no forms, just the
 * validated path from a name and a directory to a persisted project, and from a
 * type and a project to a persisted hire whose cold-spawn resolves to that
 * project's real directory.
 *
 * Path validation is the load-bearing check. A project's repo path must be an
 * existing directory on disk, refused at create time otherwise, because a project
 * pointing at a directory that is not there is the `/x` failure the smoke fixture
 * had: a dead terminal after a first message instead of an error the moment the
 * project is made. Everything is validated before anything is written, so a bad
 * input never half-creates.
 *
 * The dependencies are injected (the directory check, the repository inserts, the
 * id and clock), so the logic is provable headlessly against a real temp
 * directory without electron or the store.
 */

import { PUSH_POLICIES, type Project, type ProjectPolicy, type HiredAgent } from '../../domain/models.ts';
import { AGENT_STATES } from '../../domain/agent-state.ts';
import { definitionFor } from '../../domain/definitions.ts';

export interface CreateProjectInput {
    readonly name: string;
    readonly repoPaths: readonly string[];
}

export interface CreateHireInput {
    readonly name: string;
    readonly type: string;
    readonly title: string;
    readonly projectId: string;
}

/** Ids and names only cross back, never a repo path. */
export interface ProjectView {
    readonly id: string;
    readonly name: string;
}

export interface HireView {
    readonly id: string;
    readonly name: string;
    readonly title: string;
    readonly projectId: string;
}

export interface CreateDeps {
    /** True iff the path is an existing directory. The load-bearing check. */
    readonly dirExists: (path: string) => boolean;
    readonly insertProject: (project: Project) => void;
    readonly getProject: (id: string) => Project | null;
    readonly insertHire: (hire: HiredAgent) => void;
    readonly uuid: () => string;
    readonly now: () => string;
    /** No implicit single user, for the eventual hosted plane. */
    readonly ownerId: string;
    /** The label for a repo, defaulting to the path's last segment. */
    readonly labelFor: (path: string) => string;
}

/**
 * The conservative v1 default policy. No `sandbox` field, deferred: the create
 * flow ships a colleague that can push nothing, fetch nothing, and runs one at a
 * time, with the definition's own tools allowlist as the ceiling (toolCeiling
 * null, so it is not widened). Set here so a created project is scoped safely
 * without the form asking.
 */
export function defaultPolicy(): ProjectPolicy {
    return {
        push: PUSH_POLICIES.NONE,
        allowedRoles: [],
        toolCeiling: null,
        writePaths: null,
        requirePipeline: false,
        allowWebFetch: false,
        permissionMode: 'default',
        maxConcurrentAgents: 1
    };
}

export function createProject(deps: CreateDeps, input: CreateProjectInput): ProjectView {
    const name = input.name?.trim();
    if (!name) throw new Error('a project needs a name');
    if (!Array.isArray(input.repoPaths) || input.repoPaths.length === 0) {
        throw new Error('a project needs at least one repo path');
    }
    // Validate every path before writing anything, so a bad one never half-creates.
    for (const path of input.repoPaths) {
        if (typeof path !== 'string' || path.trim().length === 0) {
            throw new Error('a repo path must be a non-empty string');
        }
        if (!deps.dirExists(path)) {
            throw new Error('repo path is not an existing directory: ' + path);
        }
    }

    const project: Project = {
        id: deps.uuid(),
        name,
        repos: input.repoPaths.map((path) => ({ path, label: deps.labelFor(path) })),
        policy: defaultPolicy()
    };
    deps.insertProject(project);
    return { id: project.id, name: project.name };
}

export function createHire(deps: CreateDeps, input: CreateHireInput): HireView {
    const name = input.name?.trim();
    if (!name) throw new Error('a hire needs a name');
    const title = input.title?.trim();
    if (!title) throw new Error('a hire needs a title');

    const definition = definitionFor(input.type);
    if (!definition) throw new Error('unknown definition type: ' + String(input.type));

    if (!deps.getProject(input.projectId)) {
        throw new Error('no such project: ' + String(input.projectId));
    }

    // Bind to the owning project so resolveTarget resolves the cold-spawn cwd to
    // that project's first repo path, which createProject validated is real.
    const hire: HiredAgent = {
        id: deps.uuid(),
        name,
        type: definition.type,
        title,
        seniority: definition.seniority,
        ownerId: deps.ownerId,
        sessions: {},
        activeProjectId: input.projectId,
        state: AGENT_STATES.IDLE,
        hiredAt: deps.now(),
        firedAt: null
    };
    deps.insertHire(hire);
    return { id: hire.id, name: hire.name, title: hire.title, projectId: input.projectId };
}
