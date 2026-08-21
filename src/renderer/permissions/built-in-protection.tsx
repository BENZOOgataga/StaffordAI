import * as React from 'react';
import { ShieldCheck, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EffectBadge } from './rule-row.tsx';
import type { UiLang } from './rule-labels.ts';
import type { ProfileGroupView } from '../../shared/ipc.ts';

/**
 * The protection that is always on, as a handful of summary rows.
 *
 * This exists because the flat list was unusable. The profile generates 47 rules for a normal
 * project, and every one is correct and none is interesting alone: twelve secret globs times
 * read and write is twenty-four rows saying the same thing. Shown as peers of the two or three
 * rules I actually wrote, they buried them, and the screen that was supposed to answer "what
 * can this colleague do" answered it with a wall.
 *
 * It also gives a project with no stored rules something true to show. That screen used to be
 * empty, which read as unprotected when the project was in fact fully governed.
 *
 * Read-only, and labelled as such rather than presented as rules with the controls greyed out.
 * These are not rules I wrote and forgot about; they are the floor. If I want to change one I
 * write my own rule for that scope, which wins, and the panel below is where that goes.
 */

interface GroupCopy {
    readonly title: string;
    readonly unit: (n: number) => string;
    readonly why: string;
}

function copyFor(lang: UiLang, id: ProfileGroupView['id']): GroupCopy {
    const en: Record<ProfileGroupView['id'], GroupCopy> = {
        'project-files': {
            title: 'Project files',
            unit: (n) => (n === 1 ? '1 location' : n + ' locations'),
            why: 'A colleague can change the project it works on.'
        },
        'protected-locations': {
            title: 'Protected locations',
            unit: (n) => (n === 1 ? '1 place' : n + ' places'),
            why: 'Stafford’s own configuration and your credential directories, which no colleague may read or write.'
        },
        'secret-files': {
            title: 'Secret files',
            unit: (n) => (n === 1 ? '1 pattern' : n + ' patterns'),
            why: 'Files inside the project whose purpose is to hold a credential, such as .env and private keys.'
        },
        'destructive-commands': {
            title: 'Destructive commands',
            unit: (n) => (n === 1 ? '1 command' : n + ' commands'),
            why: 'Shell commands that cannot be undone, such as a force push or a hard reset. These pause and wait for you.'
        }
    };

    const fr: Record<ProfileGroupView['id'], GroupCopy> = {
        'project-files': {
            title: 'Fichiers du projet',
            unit: (n) => (n === 1 ? '1 emplacement' : n + ' emplacements'),
            why: 'Un collègue peut modifier le projet sur lequel il travaille.'
        },
        'protected-locations': {
            title: 'Emplacements protégés',
            unit: (n) => (n === 1 ? '1 endroit' : n + ' endroits'),
            why: 'La configuration de Stafford et vos dossiers d’identifiants, qu’aucun collègue ne peut lire ni modifier.'
        },
        'secret-files': {
            title: 'Fichiers sensibles',
            unit: (n) => (n === 1 ? '1 motif' : n + ' motifs'),
            why: 'Les fichiers du projet dont le rôle est de contenir un secret, comme .env et les clés privées.'
        },
        'destructive-commands': {
            title: 'Commandes destructrices',
            unit: (n) => (n === 1 ? '1 commande' : n + ' commandes'),
            why: 'Les commandes irréversibles, comme un push forcé ou un reset dur. Elles s’arrêtent et vous attendent.'
        }
    };

    return (lang === 'fr' ? fr : en)[id];
}

function Group({ lang, group }: { lang: UiLang; group: ProfileGroupView }): React.JSX.Element {
    const [open, setOpen] = React.useState(false);
    const copy = copyFor(lang, group.id);

    return (
        <li className="border-border border-b last:border-b-0">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="hover:bg-muted/40 flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left"
            >
                <span
                    className={'text-muted-foreground [&_svg]:size-4 transition-transform ' + (open ? 'rotate-90' : '')}
                    aria-hidden="true"
                >
                    <ChevronRight />
                </span>
                <span className="text-sm font-medium">{copy.title}</span>
                <span className="text-muted-foreground text-xs tabular-nums">{copy.unit(group.covers)}</span>
                <span className="ml-auto">
                    {group.effect ? <EffectBadge lang={lang} effect={group.effect} /> : null}
                </span>
            </button>

            {open ? (
                <div className="flex flex-col gap-2 px-4 pb-3 pl-11">
                    <p className="text-muted-foreground text-xs">{copy.why}</p>
                    <ul className="flex list-none flex-col gap-1">
                        {group.detail.map((d) => (
                            <li key={d} className="text-muted-foreground break-all font-mono text-xs">{d}</li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </li>
    );
}

export function BuiltInProtection({ lang, groups }: {
    lang: UiLang;
    groups: readonly ProfileGroupView[];
}): React.JSX.Element | null {
    if (groups.length === 0) return null;

    return (
        <section
            className="flex max-w-5xl flex-col gap-3"
            aria-label={lang === 'fr' ? 'Protection intégrée' : 'Built-in protection'}
        >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-muted-foreground [&_svg]:size-4" aria-hidden="true"><ShieldCheck /></span>
                <h2 className="text-sm font-medium">
                    {lang === 'fr' ? 'Protection intégrée' : 'Built-in protection'}
                </h2>
                <Badge variant="outline">{lang === 'fr' ? 'toujours active' : 'always on'}</Badge>
                <p className="text-muted-foreground w-full text-xs">
                    {lang === 'fr'
                        ? 'Appliquée à tout projet, sans rien à configurer. Pour en changer une, écrivez votre propre règle ci-dessous : la vôtre l’emporte.'
                        : 'Applied to every project with nothing to configure. To change one, write your own rule below and yours wins.'}
                </p>
            </div>

            <ul className="border-border list-none overflow-hidden rounded-lg border">
                {groups.map((group) => <Group key={group.id} lang={lang} group={group} />)}
            </ul>
        </section>
    );
}
