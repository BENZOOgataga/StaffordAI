/**
 * The config view's data: a project's stored rules, and a colleague's effective policy.
 *
 * It re-reads on `permissions:changed`, which main sends after every write. That signal is
 * also what drops the gate's rule cache, so the screen and the enforcement move together: if
 * the list has refreshed, the next turn is already resolving against the new rules.
 *
 * It talks only to `window.stafford`, the frozen bridge, like every other view.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
    PermissionRuleView, EffectiveRuleView, PermissionRulesReply, PermissionEffectiveReply,
    PermissionWriteReply, PermissionActionName, PermissionEffectName
} from '../../shared/ipc.ts';

export interface RulesState {
    readonly baseline: readonly PermissionRuleView[];
    readonly overrides: readonly PermissionRuleView[];
    /** Null before the first read lands, so the screen can tell empty from not-yet-loaded. */
    readonly loaded: boolean;
    readonly error: string | null;
}

const EMPTY: RulesState = { baseline: [], overrides: [], loaded: false, error: null };

/** A project's stored rules, live. */
export function useProjectRules(projectId: string | null): RulesState & { reload: () => void } {
    const [state, setState] = useState<RulesState>(EMPTY);

    const read = useCallback((): void => {
        if (!projectId) { setState({ ...EMPTY, loaded: true }); return; }
        void (async () => {
            try {
                const reply = await window.stafford.permissions.rules(projectId) as PermissionRulesReply;
                setState({ baseline: reply.baseline, overrides: reply.overrides, loaded: true, error: null });
            } catch (error) {
                // Kept visible rather than swallowed. A permission screen that silently shows
                // nothing reads as "no rules", which is the most dangerous possible lie here.
                setState((prev) => ({ ...prev, loaded: true, error: describe(error) }));
            }
        })();
    }, [projectId]);

    useEffect(() => {
        read();
        return window.stafford.permissions.onChanged(() => { read(); });
    }, [read]);

    return { ...state, reload: read };
}

export interface EffectiveState {
    readonly rules: readonly EffectiveRuleView[];
    readonly loaded: boolean;
    readonly error: string | null;
}

/** One colleague's resolved policy on a project, live. */
export function useEffectivePolicy(projectId: string | null, hireId: string | null): EffectiveState {
    const [state, setState] = useState<EffectiveState>({ rules: [], loaded: false, error: null });

    const read = useCallback((): void => {
        // A null hireId is valid: it reads the project-level policy (default profile plus baseline).
        // Only a missing project has nothing to resolve.
        if (!projectId) { setState({ rules: [], loaded: true, error: null }); return; }
        void (async () => {
            try {
                const reply = await window.stafford.permissions.effective(projectId, hireId) as PermissionEffectiveReply;
                setState({ rules: reply.rules, loaded: true, error: null });
            } catch (error) {
                setState({ rules: [], loaded: true, error: describe(error) });
            }
        })();
    }, [projectId, hireId]);

    useEffect(() => {
        read();
        return window.stafford.permissions.onChanged(() => { read(); });
    }, [read]);

    return state;
}

/** The three writes, each returning the reply so the caller can surface a warning. */
export const permissionWrites = {
    add: (payload: {
        projectId: string; hireId: string | null;
        action: PermissionActionName; pathScope: string | null; effect: PermissionEffectName;
    }): Promise<PermissionWriteReply> =>
        window.stafford.permissions.add(payload) as Promise<PermissionWriteReply>,

    update: (payload: {
        id: string; action: PermissionActionName; pathScope: string | null; effect: PermissionEffectName;
    }): Promise<PermissionWriteReply> =>
        window.stafford.permissions.update(payload) as Promise<PermissionWriteReply>,

    remove: (id: string): Promise<PermissionWriteReply> =>
        window.stafford.permissions.remove(id) as Promise<PermissionWriteReply>
};

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
