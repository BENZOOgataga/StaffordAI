/**
 * Editing a generated default-profile rule, expressed entirely in the existing resolver model.
 *
 * A default-profile row is not a stored rule. It is produced by `defaultBaselineRules` and shown
 * read only in the effective list. Editing one does not mutate the default profile: it authors a
 * normal stored rule at the same action and scope, either a project baseline (hire id null, every
 * colleague inherits it) or one colleague's override (hire id set, only that colleague). That is
 * the same mechanism any other override uses, so the gate needs no new concept and this file adds
 * no permission logic, only the small decisions the edit UI makes before it calls the same writes.
 *
 * Pure and tested, no React and no IPC, so the confirm gate and the add-versus-update choice are
 * provable without a browser.
 */

import type {
    PermissionActionName, PermissionEffectName, PermissionRuleView
} from '../../shared/ipc.ts';

/** Whose policy an edit writes to: this colleague only, or every colleague on the project. */
export type EditScope = 'agent' | 'all';

/**
 * Whether loosening this default rule needs an explicit confirm before it applies.
 *
 * Every rule the default profile denies is a secret-bearing or protected path, so moving one off
 * deny is the one edit that removes a protection rather than adding or tightening one. Keeping it
 * at deny, or tightening allow or ask down to deny, needs no confirm. This is the whole loosen
 * gate, kept here so it is decided once and the same way whether the edit is agent or all.
 */
export function needsLoosenConfirm(current: PermissionEffectName, next: PermissionEffectName): boolean {
    return current === 'deny' && next !== 'deny';
}

/** The hire id a chosen scope writes to: the colleague for agent scope, null for the baseline. */
export function targetHireId(scope: EditScope, colleagueHireId: string): string | null {
    return scope === 'agent' ? colleagueHireId : null;
}

/**
 * The id of an already stored rule at the same identity and level, or null when there is none.
 *
 * A genuine default-profile row has no stored rule at its key, so an edit is normally an add. This
 * still checks, so a stale list or a repeated edit updates the existing row instead of inserting a
 * duplicate the resolver would then have to dedupe. Command-pattern rules are out of scope here, so
 * the match is on a path rule only.
 */
export function findStoredRuleId(
    stored: readonly PermissionRuleView[],
    target: { action: PermissionActionName; pathScope: string | null; hireId: string | null }
): string | null {
    const hit = stored.find((r) =>
        r.action === target.action &&
        r.pathScope === target.pathScope &&
        r.commandPattern === null &&
        r.hireId === target.hireId
    );
    return hit ? hit.id : null;
}
