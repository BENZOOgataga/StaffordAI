import * as React from 'react';
import { ChevronRight, ChevronDown, Lock, Pencil, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EffectBadge } from './rule-row.tsx';
import { actionLabel, effectLabel, scopeLabel, defaultProfileCopy, type UiLang } from './rule-labels.ts';
import { permissionWrites } from './use-permissions.ts';
import { needsLoosenConfirm, targetHireId, findStoredRuleId, type EditScope } from './default-edit.ts';
import type {
    EffectiveRuleView, PermissionEffectName, PermissionRuleView, PermissionWriteReply
} from '../../shared/ipc.ts';

/**
 * The generated default profile, collapsed into one section so it stops drowning out the rules I
 * actually authored.
 *
 * The default profile is long and boring on purpose, a dozen-plus secret-file denies and the
 * destructive-command asks, and it is the same on every colleague. Shown flat it buries the one or
 * two overrides that are the reason I opened this tab. So it is one collapsed row with a count, and
 * it expands in place rather than into a modal, because editing a protection should keep the rest of
 * the policy in view.
 *
 * Editing a default rule is not a new concept. A default row is not stored; the edit authors a normal
 * rule at the same action and scope, either this colleague's override or the project baseline, and
 * the resolver does the rest. The scope choice is those two, nothing more. Loosening a deny, the only
 * edit that removes a protection, takes an explicit confirm first.
 */

const EFFECTS: readonly PermissionEffectName[] = ['allow', 'ask', 'deny'];

function keyOf(rule: EffectiveRuleView): string {
    return rule.action + ' ' + (rule.pathScope ?? '') + ' ' + (rule.commandPattern ?? '');
}

export function DefaultProfileSection({ lang, rules, projectId, colleagueHireId, stored, allowScopeChoice = true }: {
    lang: UiLang;
    rules: readonly EffectiveRuleView[];
    projectId: string;
    /**
     * The colleague this section edits for, or null on the project screen. An agent-scope edit
     * writes to this id; every other case writes the baseline.
     */
    colleagueHireId: string | null;
    /** This project's stored baseline rules plus, on the colleague view, that colleague's overrides. */
    stored: readonly PermissionRuleView[];
    /**
     * Whether to offer the this-agent / all-colleagues choice. True on a colleague's tab, where both
     * levels exist. False on the project screen, which is already the global level, so an edit there
     * always writes the baseline (hire id null) and there is no choice to make.
     */
    allowScopeChoice?: boolean;
}): React.JSX.Element {
    const copy = defaultProfileCopy(lang, rules.length);
    const [open, setOpen] = React.useState(false);
    const [editingKey, setEditingKey] = React.useState<string | null>(null);
    const [effect, setEffect] = React.useState<PermissionEffectName>('deny');
    const [scope, setScope] = React.useState<EditScope>('agent');
    const [confirming, setConfirming] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [warning, setWarning] = React.useState<string | null>(null);
    const [failure, setFailure] = React.useState<string | null>(null);

    const closeEditor = (): void => { setEditingKey(null); setConfirming(false); };

    const startEdit = (rule: EffectiveRuleView): void => {
        setFailure(null);
        setEditingKey(keyOf(rule));
        setEffect(rule.effect);
        // Default to the narrowest blast radius. Loosening for everyone should be a deliberate
        // switch, not the value the form happens to open on.
        setScope('agent');
        setConfirming(false);
    };

    const write = async (rule: EffectiveRuleView): Promise<void> => {
        setBusy(true);
        setFailure(null);
        try {
            // On the project screen there is no scope choice: an edit always writes the baseline.
            const target = allowScopeChoice && colleagueHireId ? targetHireId(scope, colleagueHireId) : null;
            const existingId = findStoredRuleId(stored, {
                action: rule.action, pathScope: rule.pathScope, hireId: target
            });
            const reply: PermissionWriteReply = existingId
                ? await permissionWrites.update({ id: existingId, action: rule.action, pathScope: rule.pathScope, effect })
                : await permissionWrites.add({ projectId, hireId: target, action: rule.action, pathScope: rule.pathScope, effect });
            if (!reply.ok) {
                setFailure(lang === 'fr' ? 'La règle n’a pas pu être enregistrée.' : 'That rule could not be saved.');
                return;
            }
            setWarning(reply.warning);
            closeEditor();
        } catch (e) {
            setFailure(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const onSave = (rule: EffectiveRuleView): void => {
        if (needsLoosenConfirm(rule.effect, effect)) { setConfirming(true); return; }
        void write(rule);
    };

    return (
        <section
            className="border-border overflow-hidden rounded-lg border"
            aria-label={copy.title}
        >
            <button
                type="button"
                data-default-profile-toggle
                className="hover:bg-muted/40 flex w-full items-center gap-2 px-4 py-3 text-left text-sm"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
            >
                <span className="text-muted-foreground [&_svg]:size-4">
                    {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                </span>
                <Lock aria-hidden="true" className="text-muted-foreground size-3.5" />
                <span className="font-medium">{copy.title}</span>
                <span className="text-muted-foreground ml-auto text-xs">{open ? copy.collapse : copy.expand}</span>
            </button>

            {open ? (
                <div className="border-border border-t">
                    {warning ? (
                        <div role="alert" className="border-destructive/50 bg-destructive/10 m-3 flex items-start gap-2 rounded-lg border p-3 text-sm">
                            <span className="text-destructive mt-0.5 [&_svg]:size-4"><TriangleAlert aria-hidden="true" /></span>
                            <div className="flex min-w-0 flex-col gap-2">
                                <p className="min-w-0">{warning}</p>
                                <Button size="sm" variant="secondary" onClick={() => setWarning(null)}>
                                    {lang === 'fr' ? 'J’ai compris' : 'Understood'}
                                </Button>
                            </div>
                        </div>
                    ) : null}
                    {failure ? <p role="alert" className="text-destructive px-4 pt-3 text-sm">{failure}</p> : null}

                    <p className="text-muted-foreground px-4 pt-3 text-xs">{copy.hint}</p>

                    <ul className="divide-border list-none divide-y p-3">
                        {rules.map((rule) => {
                            const key = keyOf(rule);
                            const editable = rule.pathScope !== null; // command-pattern rules stay read-only
                            const editing = editingKey === key;
                            return (
                                <li key={key} className="flex flex-col gap-2 px-1 py-2">
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                                        <span className="min-w-[5rem] text-sm font-medium">{actionLabel(lang, rule.action)}</span>
                                        <code className="text-muted-foreground min-w-0 flex-1 break-all font-mono text-xs">
                                            {scopeLabel(lang, rule)}
                                        </code>
                                        <EffectBadge lang={lang} effect={rule.effect} />
                                        {editable ? (
                                            <Button
                                                size="sm" variant="ghost" disabled={busy} onClick={() => startEdit(rule)}
                                                aria-label={(lang === 'fr' ? 'Modifier la règle ' : 'Edit rule ') + scopeLabel(lang, rule)}
                                            >
                                                <Pencil />
                                            </Button>
                                        ) : (
                                            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                                                <Lock aria-hidden="true" className="size-3" />
                                                {copy.lockedNote}
                                            </span>
                                        )}
                                    </div>

                                    {editing ? (
                                        <div className="border-border bg-muted/30 flex flex-col gap-3 rounded-lg border p-3">
                                            <div className="flex flex-wrap items-end gap-3">
                                                <label className="flex min-w-[8rem] flex-col gap-1 text-sm">
                                                    <span className="text-muted-foreground">{lang === 'fr' ? 'Effet' : 'Effect'}</span>
                                                    <select
                                                        className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                                                        value={effect}
                                                        onChange={(e) => { setConfirming(false); setEffect(e.target.value as PermissionEffectName); }}
                                                    >
                                                        {EFFECTS.map((f) => <option key={f} value={f}>{effectLabel(lang, f)}</option>)}
                                                    </select>
                                                </label>

                                                {allowScopeChoice ? (
                                                    <div className="flex flex-col gap-1 text-sm">
                                                        <span className="text-muted-foreground">{copy.scopeLabel}</span>
                                                        <div className="flex gap-2">
                                                            <Button
                                                                type="button" size="sm"
                                                                variant={scope === 'agent' ? 'default' : 'secondary'}
                                                                aria-pressed={scope === 'agent'}
                                                                onClick={() => { setConfirming(false); setScope('agent'); }}
                                                            >
                                                                {copy.scopeAgent}
                                                            </Button>
                                                            <Button
                                                                type="button" size="sm"
                                                                variant={scope === 'all' ? 'default' : 'secondary'}
                                                                aria-pressed={scope === 'all'}
                                                                onClick={() => { setConfirming(false); setScope('all'); }}
                                                            >
                                                                {copy.scopeAll}
                                                            </Button>
                                                        </div>
                                                    </div>
                                                ) : null}
                                            </div>

                                            {confirming ? (
                                                <div role="alert" className="border-destructive/50 bg-destructive/10 flex flex-col gap-2 rounded-lg border p-3 text-sm">
                                                    <span className="flex items-start gap-2">
                                                        <span className="text-destructive mt-0.5 [&_svg]:size-4"><TriangleAlert aria-hidden="true" /></span>
                                                        <span className="min-w-0">{copy.confirmLoosen}</span>
                                                    </span>
                                                    <span className="flex gap-2">
                                                        <Button size="sm" variant="destructive" disabled={busy} onClick={() => void write(rule)}>
                                                            {copy.apply}
                                                        </Button>
                                                        <Button size="sm" variant="secondary" disabled={busy} onClick={closeEditor}>
                                                            {copy.keep}
                                                        </Button>
                                                    </span>
                                                </div>
                                            ) : (
                                                <div className="flex gap-2">
                                                    <Button size="sm" disabled={busy} onClick={() => onSave(rule)}>{copy.save}</Button>
                                                    <Button size="sm" variant="secondary" disabled={busy} onClick={closeEditor}>{copy.cancel}</Button>
                                                </div>
                                            )}
                                        </div>
                                    ) : null}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            ) : null}
        </section>
    );
}
