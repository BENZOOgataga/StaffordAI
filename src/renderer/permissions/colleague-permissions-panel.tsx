import * as React from 'react';
import { RulesPanel } from './rules-panel.tsx';
import { EffectiveRuleRow } from './rule-row.tsx';
import { DefaultProfileSection } from './default-profile-section.tsx';
import { useProjectRules, useEffectivePolicy } from './use-permissions.ts';
import type { UiLang } from './rule-labels.ts';
import type { PermissionRuleView } from '../../shared/ipc.ts';

/**
 * A colleague's permissions tab: what actually applies to them, and their own exceptions.
 *
 * The effective list comes first because it is the question I actually have. A colleague's
 * override list on its own cannot tell me what that colleague may do, since most of the
 * answer comes from the project baseline and the default profile. Reading three lists and
 * resolving them in my head is precisely the work this screen exists to remove.
 *
 * The effective list is read-only. Every row on it is editable somewhere, but not all in the
 * same place: a baseline row belongs to the project, a generated row belongs to the default
 * profile and is not authored at all, and only the override rows belong here. Offering an
 * edit control on a row whose home is elsewhere would either silently create an override or
 * lead somewhere else, and both are worse than sending me to the right screen.
 */
export function ColleaguePermissionsPanel({ lang, projectId, hireId }: {
    lang: UiLang;
    /** The colleague's active project, or null when it is on none. */
    projectId: string | null;
    hireId: string | null;
}): React.JSX.Element {
    const effective = useEffectivePolicy(projectId, hireId);
    const { baseline, overrides, loaded, error } = useProjectRules(projectId);

    // Only this colleague's own overrides are editable here. The reply carries every
    // colleague's, since it is a project read.
    const mine: readonly PermissionRuleView[] = React.useMemo(
        () => overrides.filter((r) => r.hireId === hireId),
        [overrides, hireId]
    );

    // The default profile is split out of the effective list into its own collapsed section, so the
    // rules I authored are not buried under a dozen built-in denies. Editing a default row writes a
    // baseline or an override through this project's baseline and this colleague's overrides.
    const authored = React.useMemo(
        () => effective.rules.filter((r) => r.source !== 'default-profile'),
        [effective.rules]
    );
    const generated = React.useMemo(
        () => effective.rules.filter((r) => r.source === 'default-profile'),
        [effective.rules]
    );
    const storedForEdit: readonly PermissionRuleView[] = React.useMemo(
        () => [...baseline, ...mine],
        [baseline, mine]
    );

    if (!projectId || !hireId) {
        return (
            <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-10 text-center text-sm">
                {lang === 'fr'
                    ? 'Ce collègue n’est sur aucun projet, il n’y a donc pas de permissions à afficher.'
                    : 'This colleague is on no project, so there are no permissions to show.'}
            </div>
        );
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-5">
            <section className="flex max-w-5xl flex-col gap-3" aria-label={lang === 'fr' ? 'Politique effective' : 'Effective policy'}>
                <div className="flex flex-col gap-0.5">
                    <h2 className="text-sm font-medium">
                        {lang === 'fr' ? 'Politique effective' : 'Effective policy'}
                    </h2>
                    <p className="text-muted-foreground text-xs">
                        {lang === 'fr'
                            ? 'Ce qui s’applique réellement à ce collègue, et d’où chaque règle vient. La règle la plus précise gagne, et à égalité refuser l’emporte sur demander, qui l’emporte sur autoriser.'
                            : 'What actually applies to this colleague, and where each rule comes from. The most specific rule wins, and on a tie deny beats ask beats allow.'}
                    </p>
                </div>

                <ul className="border-border list-none overflow-hidden rounded-lg border">
                    {!effective.loaded ? (
                        <li className="text-muted-foreground px-4 py-6 text-center text-sm">
                            {lang === 'fr' ? 'Chargement' : 'Loading'}
                        </li>
                    ) : effective.error ? (
                        <li role="alert" className="text-destructive px-4 py-6 text-center text-sm">{effective.error}</li>
                    ) : effective.rules.length === 0 ? (
                        <li className="text-muted-foreground px-4 py-6 text-center text-sm">
                            {lang === 'fr' ? 'Aucune règle ne s’applique.' : 'No rules apply.'}
                        </li>
                    ) : authored.length === 0 ? (
                        <li className="text-muted-foreground px-4 py-6 text-center text-sm">
                            {lang === 'fr'
                                ? 'Seul le profil par défaut s’applique, voir ci-dessous.'
                                : 'Only the default profile applies, see below.'}
                        </li>
                    ) : authored.map((rule, i) => (
                        <EffectiveRuleRow key={rule.action + (rule.pathScope ?? rule.commandPattern ?? '') + String(i)} lang={lang} rule={rule} />
                    ))}
                </ul>

                {effective.loaded && !effective.error && generated.length > 0 ? (
                    <DefaultProfileSection
                        lang={lang}
                        rules={generated}
                        projectId={projectId}
                        colleagueHireId={hireId}
                        stored={storedForEdit}
                    />
                ) : null}
            </section>

            <RulesPanel
                lang={lang}
                title={lang === 'fr' ? 'Exceptions pour ce collègue' : 'This colleague’s overrides'}
                hint={lang === 'fr'
                    ? 'Ces règles ne concernent que ce collègue et l’emportent sur la base du projet.'
                    : 'These apply to this colleague only, and win over the project baseline.'}
                rules={mine}
                projectId={projectId}
                hireId={hireId}
                loaded={loaded}
                error={error}
            />
        </div>
    );
}
