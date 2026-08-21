import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { actionLabel, effectLabel, type UiLang } from './rule-labels.ts';
import type { PermissionActionName, PermissionEffectName } from '../../shared/ipc.ts';

/**
 * The add and edit form for one rule: a category, a scope, and an effect.
 *
 * Native selects, deliberately, for the same reason the create and hire sheets still use
 * them. Swapping them for the shadcn Select is a separate cleanup that belongs with those,
 * not smuggled into a permission change.
 *
 * There is no command-pattern field. The destructive shell patterns come from the default
 * profile and are shown read-only, so this form cannot author a regex that would silently
 * stop matching if it were malformed.
 */

const ACTIONS: readonly PermissionActionName[] = ['read', 'write', 'shell', 'fetch', 'delegate', 'other'];
const EFFECTS: readonly PermissionEffectName[] = ['allow', 'ask', 'deny'];

export interface RuleDraft {
    readonly action: PermissionActionName;
    readonly pathScope: string;
    readonly effect: PermissionEffectName;
}

export const EMPTY_DRAFT: RuleDraft = { action: 'read', pathScope: '', effect: 'allow' };

export function RuleEditor({ lang, draft, onChange, onSubmit, onCancel, submitLabel, busy }: {
    lang: UiLang;
    draft: RuleDraft;
    onChange: (next: RuleDraft) => void;
    onSubmit: () => void;
    onCancel: () => void;
    submitLabel: string;
    busy: boolean;
}): React.JSX.Element {
    const shellNote = draft.action === 'shell'
        ? (lang === 'fr'
            ? 'Le champ d’application par chemin est approximatif pour le shell. Pour un projet sensible, préférez Demander ou Refuser.'
            : 'Path scoping is coarse for shell. On a sensitive project, lean on Ask or Deny instead.')
        : null;

    return (
        <form
            className="border-border bg-muted/30 flex flex-col gap-3 rounded-lg border p-3"
            onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
        >
            {/* Wraps rather than sitting on a fixed grid, so a longer translated label does
                not squeeze the inputs or overflow the row. */}
            <div className="flex flex-wrap items-end gap-3">
                <label className="flex min-w-[8rem] flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">{lang === 'fr' ? 'Catégorie' : 'Category'}</span>
                    <select
                        className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                        value={draft.action}
                        onChange={(e) => onChange({ ...draft, action: e.target.value as PermissionActionName })}
                    >
                        {ACTIONS.map((a) => <option key={a} value={a}>{actionLabel(lang, a)}</option>)}
                    </select>
                </label>

                <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">
                        {lang === 'fr' ? 'Chemin (vide = partout)' : 'Path scope (empty means everywhere)'}
                    </span>
                    <Input
                        value={draft.pathScope}
                        spellCheck={false}
                        placeholder={lang === 'fr' ? 'src/ ou src/**/*.ts' : 'src/ or src/**/*.ts'}
                        onChange={(e) => onChange({ ...draft, pathScope: e.target.value })}
                    />
                </label>

                <label className="flex min-w-[8rem] flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">{lang === 'fr' ? 'Effet' : 'Effect'}</span>
                    <select
                        className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                        value={draft.effect}
                        onChange={(e) => onChange({ ...draft, effect: e.target.value as PermissionEffectName })}
                    >
                        {EFFECTS.map((f) => <option key={f} value={f}>{effectLabel(lang, f)}</option>)}
                    </select>
                </label>
            </div>

            {shellNote ? <p className="text-muted-foreground text-xs">{shellNote}</p> : null}

            <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={busy}>{submitLabel}</Button>
                <Button type="button" size="sm" variant="secondary" onClick={onCancel} disabled={busy}>
                    {lang === 'fr' ? 'Annuler' : 'Cancel'}
                </Button>
            </div>
        </form>
    );
}
