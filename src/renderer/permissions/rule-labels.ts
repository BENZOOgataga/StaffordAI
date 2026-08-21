/**
 * How a permission rule reads to a person, kept as data so the wording is tested without a
 * browser and so the two surfaces (project baselines, colleague effective policy) cannot
 * describe the same rule differently.
 *
 * Every label flexes for a longer translation. Nothing here is sized to English, and the
 * effect words in particular are short in English and longer in French, which is exactly the
 * case a fixed-width badge would break.
 */

import type {
    PermissionActionName, PermissionEffectName, EffectiveRuleView
} from '../../shared/ipc.ts';

export type UiLang = 'en' | 'fr';

const ACTION_EN: Record<PermissionActionName, string> = {
    read: 'Read', write: 'Write', shell: 'Shell', fetch: 'Fetch', delegate: 'Delegate', other: 'Other'
};
const ACTION_FR: Record<PermissionActionName, string> = {
    read: 'Lecture', write: 'Écriture', shell: 'Shell', fetch: 'Réseau', delegate: 'Délégation', other: 'Autre'
};

const EFFECT_EN: Record<PermissionEffectName, string> = { allow: 'Allow', deny: 'Deny', ask: 'Ask' };
const EFFECT_FR: Record<PermissionEffectName, string> = { allow: 'Autoriser', deny: 'Refuser', ask: 'Demander' };

const SOURCE_EN: Record<EffectiveRuleView['source'], string> = {
    baseline: 'Project baseline', override: 'Colleague override', 'default-profile': 'Default profile'
};
const SOURCE_FR: Record<EffectiveRuleView['source'], string> = {
    baseline: 'Base du projet', override: 'Exception du collègue', 'default-profile': 'Profil par défaut'
};

export function actionLabel(lang: UiLang, action: PermissionActionName): string {
    return (lang === 'fr' ? ACTION_FR : ACTION_EN)[action];
}

export function effectLabel(lang: UiLang, effect: PermissionEffectName): string {
    return (lang === 'fr' ? EFFECT_FR : EFFECT_EN)[effect];
}

export function sourceLabel(lang: UiLang, source: EffectiveRuleView['source']): string {
    return (lang === 'fr' ? SOURCE_FR : SOURCE_EN)[source];
}

/**
 * What a rule applies to, in one line. A rule carries at most one of a path scope or a
 * command pattern, and a rule with neither is category-wide, which has to say so rather than
 * showing an empty cell that reads as missing data.
 */
export function scopeLabel(lang: UiLang, rule: { pathScope: string | null; commandPattern: string | null }): string {
    if (rule.pathScope !== null) return rule.pathScope;
    if (rule.commandPattern !== null) {
        return (lang === 'fr' ? 'Commandes correspondant à ' : 'Commands matching ') + rule.commandPattern;
    }
    return lang === 'fr' ? 'Partout' : 'Everywhere';
}

/**
 * The note explaining why an effective row is what it is.
 *
 * Only a rule that genuinely replaced a baseline rule says it won over something. An override
 * that added a scope the baseline never mentioned is an addition, and calling that an
 * override would put a misleading badge on half the rows.
 */
export function attributionNote(lang: UiLang, rule: EffectiveRuleView): string | null {
    if (!rule.overridesBaseline || rule.replacedEffect === null) return null;
    const was = effectLabel(lang, rule.replacedEffect);
    return lang === 'fr'
        ? 'Remplace la base du projet, qui était ' + was.toLowerCase()
        : 'Replaces the project baseline, which was ' + was.toLowerCase();
}

/** True when a rule is generated rather than authored, so the UI can show it read-only. */
export function isReadOnly(rule: EffectiveRuleView): boolean {
    return rule.source === 'default-profile';
}
