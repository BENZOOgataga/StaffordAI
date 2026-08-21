import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Pencil, Trash2, Lock } from 'lucide-react';
import { actionLabel, effectLabel, scopeLabel, sourceLabel, attributionNote, type UiLang } from './rule-labels.ts';
import type { PermissionEffectName, PermissionRuleView, EffectiveRuleView } from '../../shared/ipc.ts';

/**
 * One rule, rendered the same way wherever it appears.
 *
 * Both surfaces render through this, so a rule cannot describe itself differently on the
 * project screen than on a colleague's. That mattered enough to be a component rather than
 * two similar blocks: the whole point of the screen is that what it says matches what the
 * gate does, and two renderers would be two chances to drift.
 */

/**
 * The three effects, separated by weight rather than by colour.
 *
 * The design spec is explicit that the palette is mostly monochrome with one accent, spent
 * only on waiting. A filled red badge would spend a second one on a list where a third of the
 * rows are denies, which is both off register and self-defeating: a warning that appears
 * everywhere stops reading as a warning.
 *
 * So deny is the solid one, ask is the recessed one, and allow is a quiet outline. That is a
 * legible hierarchy in grayscale, and it keeps amber meaning the one thing it means.
 */
function effectVariant(effect: PermissionEffectName): 'default' | 'secondary' | 'outline' {
    if (effect === 'deny') return 'default';
    if (effect === 'ask') return 'secondary';
    return 'outline';
}

export function EffectBadge({ lang, effect }: { lang: UiLang; effect: PermissionEffectName }): React.JSX.Element {
    return <Badge variant={effectVariant(effect)}>{effectLabel(lang, effect)}</Badge>;
}

/**
 * A row on the project baseline screen, which is editable.
 *
 * The scope is the widest column and wraps, since a path is the one field with no bound and
 * truncating it would hide exactly the part that distinguishes two rules.
 */
export function EditableRuleRow({ lang, rule, onEdit, onRemove, busy }: {
    lang: UiLang;
    rule: PermissionRuleView;
    onEdit: () => void;
    onRemove: () => void;
    busy: boolean;
}): React.JSX.Element {
    return (
        <li className="border-border flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3 last:border-b-0">
            <span className="min-w-[5rem] text-sm font-medium">{actionLabel(lang, rule.action)}</span>
            <code className="text-muted-foreground min-w-0 flex-1 break-all font-mono text-xs">
                {scopeLabel(lang, rule)}
            </code>
            <EffectBadge lang={lang} effect={rule.effect} />
            <span className="flex gap-1">
                <Button
                    size="sm" variant="ghost" onClick={onEdit} disabled={busy}
                    aria-label={(lang === 'fr' ? 'Modifier la règle ' : 'Edit rule ') + scopeLabel(lang, rule)}
                >
                    <Pencil />
                </Button>
                <Button
                    size="sm" variant="ghost" onClick={onRemove} disabled={busy}
                    aria-label={(lang === 'fr' ? 'Supprimer la règle ' : 'Remove rule ') + scopeLabel(lang, rule)}
                >
                    <Trash2 />
                </Button>
            </span>
        </li>
    );
}

/**
 * A row of a colleague's effective policy, with where it came from.
 *
 * The attribution is the payoff of the whole screen. A list of rules cannot tell me why an
 * action resolves the way it does when a baseline and an override both mention it, so the
 * source is on every row and the replacement note is on the ones that actually replaced
 * something. An override that merely added a scope says override without claiming it beat
 * anything, because badging an addition as a win would mislead on half the rows.
 */
export function EffectiveRuleRow({ lang, rule }: { lang: UiLang; rule: EffectiveRuleView }): React.JSX.Element {
    const note = attributionNote(lang, rule);
    const generated = rule.source === 'default-profile';

    return (
        <li className="border-border flex flex-col gap-1 border-b px-4 py-3 last:border-b-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="min-w-[5rem] text-sm font-medium">{actionLabel(lang, rule.action)}</span>
                <code className="text-muted-foreground min-w-0 flex-1 break-all font-mono text-xs">
                    {scopeLabel(lang, rule)}
                </code>
                <EffectBadge lang={lang} effect={rule.effect} />
                <Badge variant="outline" className="gap-1">
                    {generated ? <Lock aria-hidden="true" /> : null}
                    {sourceLabel(lang, rule.source)}
                </Badge>
            </div>
            {note ? <p className="text-muted-foreground pl-[5rem] text-xs">{note}</p> : null}
        </li>
    );
}
