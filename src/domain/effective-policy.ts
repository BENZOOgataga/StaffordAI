/**
 * What a colleague's policy actually resolves to, and where each part of it came from.
 *
 * This exists because a list of rules is not an answer. The baseline says one thing, the
 * colleague's overrides say another, the default profile fills the gaps, and the resolver
 * picks a winner by specificity with deny beating ask beating allow. Reading three lists and
 * doing that in your head is exactly the work a configuration screen is supposed to remove,
 * so this does it once and reports the winner together with its source.
 *
 * Pure, like `permissions.ts`, and for the same reason: it decides nothing about the
 * filesystem, the platform, or the database. Paths arrive already resolved and folded by the
 * gate. Nothing here reads a rule from disk or knows what a project is.
 *
 * It deliberately reuses `effectiveRules` and `resolvePermission` rather than reimplementing
 * the precedence. A screen that explained resolution using its own copy of the rules would
 * drift from the gate, and then the UI would be confidently wrong about what a colleague may
 * do, which is worse than having no screen at all.
 */

import {
    effectiveRules, resolvePermission,
    type PermissionRule, type PermissionEffect, type PermissionAction, type CategoryDefaults
} from './permissions.ts';

/** Where an effective rule came from. The whole point of the view. */
export type RuleSource = 'baseline' | 'override' | 'default-profile';

/**
 * One rule as it actually applies to a colleague, with its provenance.
 *
 * `overridesBaseline` is separate from `source` on purpose. A rule can come from an override
 * because the baseline never mentioned that scope (an addition), or because it replaced a
 * baseline rule for the same scope (a genuine override). Only the second is worth flagging
 * as "this wins over something", and conflating them would put a misleading badge on half
 * the rows.
 */
export interface EffectiveRule {
    readonly action: PermissionAction;
    readonly pathScope: string | null;
    readonly commandPattern: string | null;
    readonly effect: PermissionEffect;
    readonly source: RuleSource;
    /** True when this override replaced a baseline rule for the same action and scope. */
    readonly overridesBaseline: boolean;
    /** The effect the baseline had for this scope, when this override replaced one. */
    readonly replacedEffect: PermissionEffect | null;
}

export interface EffectivePolicyInput {
    /** The project's baseline rules, including the generated default profile. */
    readonly baseline: readonly PermissionRule[];
    /** This colleague's overrides on this project. */
    readonly overrides: readonly PermissionRule[];
    /**
     * Which baseline rules came from the generated default profile rather than from something
     * the person wrote. Compared by identity of action, scope and pattern, so the caller does
     * not have to tag every rule it passes in.
     */
    readonly profileKeys?: ReadonlySet<string>;
    readonly defaults: CategoryDefaults;
}

/** A rule's identity: the same key `effectiveRules` layers on, so the two agree by construction. */
export function ruleKey(rule: Pick<PermissionRule, 'action' | 'pathScope' | 'commandPattern'>): string {
    return rule.action + ' ' + (rule.pathScope ?? '') + ' ' + (rule.commandPattern ?? '');
}

/**
 * The rules that actually apply, each tagged with where it came from.
 *
 * Sorted so the screen is stable and readable rather than in whatever order the database
 * returned: by action, then most specific path first, then by scope, so a narrow rule sits
 * under the broad one it refines.
 */
export function effectivePolicy(input: EffectivePolicyInput): EffectiveRule[] {
    const baselineByKey = new Map(input.baseline.map((r) => [ruleKey(r), r]));
    const overrideKeys = new Set(input.overrides.map(ruleKey));
    const profileKeys = input.profileKeys ?? new Set<string>();

    const merged = effectiveRules(input.baseline, input.overrides);

    const rows = merged.map((rule): EffectiveRule => {
        const key = ruleKey(rule);
        const isOverride = overrideKeys.has(key);
        const replaced = isOverride ? baselineByKey.get(key) ?? null : null;
        const source: RuleSource = isOverride
            ? 'override'
            : (profileKeys.has(key) ? 'default-profile' : 'baseline');
        return {
            action: rule.action,
            pathScope: rule.pathScope,
            commandPattern: rule.commandPattern,
            effect: rule.effect,
            source,
            overridesBaseline: isOverride && replaced !== null,
            replacedEffect: replaced ? replaced.effect : null
        };
    });

    return rows.sort((a, b) => {
        if (a.action !== b.action) return a.action < b.action ? -1 : 1;
        const depth = (r: EffectiveRule): number =>
            r.commandPattern !== null ? 1000 : (r.pathScope ?? '').split('/').filter(Boolean).length;
        if (depth(a) !== depth(b)) return depth(b) - depth(a);
        return (a.pathScope ?? a.commandPattern ?? '') < (b.pathScope ?? b.commandPattern ?? '') ? -1 : 1;
    });
}

/**
 * What a concrete action on a concrete path would resolve to right now, and which rule decided.
 *
 * The screen uses this to answer "why", which is the question a list of rules cannot. It calls
 * the same `resolvePermission` the gate calls, so the explanation cannot disagree with the
 * enforcement: if this says deny, the gate denies.
 */
export interface Explanation {
    readonly effect: PermissionEffect;
    /** The rule that won, or null when nothing matched and the category default applied. */
    readonly decidedBy: EffectiveRule | null;
    /** True when no rule matched, so the category default decided. */
    readonly fromDefault: boolean;
}

export function explain(
    rules: readonly EffectiveRule[],
    request: { action: PermissionAction; path: string | null; command: string | null },
    defaults: CategoryDefaults
): Explanation {
    const asRules: PermissionRule[] = rules.map((r) => ({
        action: r.action, pathScope: r.pathScope, commandPattern: r.commandPattern, effect: r.effect
    }));
    const effect = resolvePermission(asRules, request, defaults);

    // Which rule produced it. Same ranking the resolver uses, most specific first and the
    // safer effect on a tie, so the reason shown always matches the effect enforced.
    let winner: EffectiveRule | null = null;
    for (const candidate of rules) {
        if (!matches(candidate, request)) continue;
        if (winner === null) { winner = candidate; continue; }
        const c = specificity(candidate);
        const w = specificity(winner);
        if (c > w || (c === w && rank[candidate.effect] > rank[winner.effect])) winner = candidate;
    }

    return { effect, decidedBy: winner, fromDefault: winner === null };
}

const rank: Record<PermissionEffect, number> = { deny: 3, ask: 2, allow: 1 };

function specificity(rule: EffectiveRule): number {
    if (rule.commandPattern !== null) return 1_000_000 + rule.commandPattern.length;
    if (rule.pathScope !== null) {
        const s = rule.pathScope;
        return s.split('/').filter(Boolean).length * 1000 + s.length;
    }
    return 0;
}

function matches(
    rule: EffectiveRule, request: { action: PermissionAction; path: string | null; command: string | null }
): boolean {
    if (rule.action !== request.action) return false;
    if (rule.commandPattern !== null) {
        if (request.command === null) return false;
        try { return new RegExp(rule.commandPattern, 'i').test(request.command); } catch { return false; }
    }
    if (rule.pathScope !== null) {
        if (request.path === null) return false;
        if (/[*?]/.test(rule.pathScope)) return globMatch(rule.pathScope, request.path);
        return request.path === rule.pathScope || request.path.startsWith(rule.pathScope + '/');
    }
    return true;
}

function globMatch(glob: string, value: string): boolean {
    let re = '^';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
            else re += '[^/]*';
        } else if (c === '?') re += '[^/]';
        else if ('\\^$.|+()[]{}'.includes(c as string)) re += '\\' + c;
        else re += c;
    }
    return new RegExp(re + '$').test(value);
}

/**
 * Whether an edit would weaken protection of a path the user must keep for themselves.
 *
 * Not a security boundary. The boundary is the gate, and this cannot stop anything. It exists
 * so that removing the deny on the permission store, or allowing a colleague into it, is a
 * deliberate act rather than a careless one. It is Benzoo's machine and he can insist; he
 * should not be able to do it by accident.
 */
export function widensProtectedAccess(
    rule: Pick<PermissionRule, 'action' | 'pathScope' | 'effect'>,
    protectedPaths: readonly string[]
): boolean {
    if (rule.effect === 'deny') return false;
    if (rule.pathScope === null) {
        // A category-wide allow or ask does not name the protected path, but it is what a
        // more specific deny would otherwise have to fight, so it is worth a word.
        return rule.action === 'read' || rule.action === 'write';
    }
    const scope = rule.pathScope;
    // A prefix test needs the separator, and a scope that is already the root would produce
    // a doubled one, which silently never matches. That is the shape of bug this whole file
    // keeps finding, so the root is handled rather than assumed away.
    const under = (child: string, parent: string): boolean =>
        child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');

    return protectedPaths.some((p) => under(scope, p) || under(p, scope));
}
