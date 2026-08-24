import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Plus, TriangleAlert, Undo2 } from 'lucide-react';
import { RuleEditor, EMPTY_DRAFT, type RuleDraft } from './rule-editor.tsx';
import { EditableRuleRow } from './rule-row.tsx';
import { permissionWrites } from './use-permissions.ts';
import type { UiLang } from './rule-labels.ts';
import type { PermissionRuleView, PermissionWriteReply } from '../../shared/ipc.ts';

/**
 * An editable list of rules, used for a project's baseline and for one colleague's overrides.
 *
 * The two differ only in which rows they hold and whether a hire id is attached on write, so
 * they share this rather than existing twice. A second copy would be a second place for the
 * warning handling to be forgotten.
 *
 * The warning is the interesting part. The backend returns one when an edit widens access
 * toward Stafford's own configuration directory, and it advises rather than blocking, because
 * it is my machine and I may mean it. What I should not be able to do is open that directory
 * by a careless click, so the warning is shown after the write with what it means, and it
 * stays until I dismiss it rather than flashing past.
 */
export function RulesPanel({ lang, title, hint, rules, projectId, hireId, loaded, error }: {
    lang: UiLang;
    title: string;
    hint: string;
    rules: readonly PermissionRuleView[];
    projectId: string | null;
    /** null writes a project baseline rule; a hire id writes that colleague's override. */
    hireId: string | null;
    loaded: boolean;
    error: string | null;
}): React.JSX.Element {
    const [adding, setAdding] = React.useState(false);
    const [editingId, setEditingId] = React.useState<string | null>(null);
    const [draft, setDraft] = React.useState<RuleDraft>(EMPTY_DRAFT);
    const [busy, setBusy] = React.useState(false);
    const [warning, setWarning] = React.useState<string | null>(null);
    const [failure, setFailure] = React.useState<string | null>(null);
    // The last removed rule, kept so removal can be undone. Removal is immediate (no confirm),
    // and this is the recoverable half: an Undo restores the rule rather than a modal blocking
    // every delete. It matters most on a colleague's deny rules, where a mis-clicked removal
    // silently widens what that colleague may do.
    const [removed, setRemoved] = React.useState<PermissionRuleView | null>(null);

    const closeEditor = (): void => { setAdding(false); setEditingId(null); setDraft(EMPTY_DRAFT); };

    // The Undo offer is transient: it clears itself after a while so a stale "rule removed"
    // does not linger and invite an accidental restore long after the fact.
    React.useEffect(() => {
        if (!removed) return;
        const timer = setTimeout(() => setRemoved(null), 8000);
        return () => clearTimeout(timer);
    }, [removed]);

    const run = async (write: () => Promise<PermissionWriteReply>): Promise<void> => {
        setBusy(true);
        setFailure(null);
        try {
            const reply = await write();
            if (!reply.ok) {
                // A write that did not land must say so. Silence here would read as success
                // on a screen whose entire job is telling me what is enforced.
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

    const submit = (): void => {
        if (!projectId) return;
        const pathScope = draft.pathScope.trim() === '' ? null : draft.pathScope.trim();
        if (editingId) {
            void run(() => permissionWrites.update({ id: editingId, action: draft.action, pathScope, effect: draft.effect }));
        } else {
            void run(() => permissionWrites.add({ projectId, hireId, action: draft.action, pathScope, effect: draft.effect }));
        }
    };

    const startEdit = (rule: PermissionRuleView): void => {
        setAdding(false);
        setEditingId(rule.id);
        setDraft({ action: rule.action, pathScope: rule.pathScope ?? '', effect: rule.effect });
    };

    // Remove immediately, then offer Undo. A failed remove says so and offers nothing to undo.
    const removeRule = (rule: PermissionRuleView): void => {
        setBusy(true);
        setFailure(null);
        void (async () => {
            try {
                const reply = await permissionWrites.remove(rule.id);
                if (!reply.ok) {
                    setFailure(lang === 'fr' ? 'La règle n’a pas pu être supprimée.' : 'That rule could not be removed.');
                    return;
                }
                setWarning(reply.warning);
                setRemoved(rule);
            } catch (e) {
                setFailure(e instanceof Error ? e.message : String(e));
            } finally {
                setBusy(false);
            }
        })();
    };

    // Restore the removed rule by adding it back with the same action, scope and effect. UI
    // rules carry no command pattern, so this is a faithful restore. A new id is fine: what a
    // rule does is its action, scope and effect, not its id.
    const undoRemove = (): void => {
        const rule = removed;
        if (!rule || !projectId) return;
        setRemoved(null);
        void run(() => permissionWrites.add({
            projectId, hireId, action: rule.action, pathScope: rule.pathScope, effect: rule.effect
        }));
    };

    // Capped rather than full bleed. A rule is action, scope, effect, and on a wide window an
    // uncapped row strands the effect badge a screen away from the path it belongs to, which
    // is the one pairing I am reading for. max-w in rem also leaves room for a longer
    // translated label without a fixed pixel width.
    return (
        <section className="flex max-w-5xl flex-col gap-3" aria-label={title}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-col gap-0.5">
                    <h2 className="text-sm font-medium">{title}</h2>
                    <p className="text-muted-foreground text-xs">{hint}</p>
                </div>
                <Button
                    size="sm" variant="secondary" disabled={!projectId || busy}
                    onClick={() => { setEditingId(null); setDraft(EMPTY_DRAFT); setAdding(true); }}
                >
                    <Plus /> {lang === 'fr' ? 'Ajouter une règle' : 'Add rule'}
                </Button>
            </div>

            {warning ? (
                <div
                    role="alert"
                    className="border-destructive/50 bg-destructive/10 flex items-start gap-2 rounded-lg border p-3 text-sm"
                >
                    <span className="text-destructive mt-0.5 [&_svg]:size-4"><TriangleAlert aria-hidden="true" /></span>
                    <div className="flex min-w-0 flex-col gap-2">
                        <p className="min-w-0">{warning}</p>
                        <Button size="sm" variant="secondary" onClick={() => setWarning(null)}>
                            {lang === 'fr' ? 'J’ai compris' : 'Understood'}
                        </Button>
                    </div>
                </div>
            ) : null}

            {failure ? <p role="alert" className="text-destructive text-sm">{failure}</p> : null}
            {error ? <p role="alert" className="text-destructive text-sm">{error}</p> : null}

            {removed ? (
                <div
                    role="status"
                    className="border-border bg-muted/40 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
                >
                    <span className="min-w-0">{lang === 'fr' ? 'Règle supprimée.' : 'Rule removed.'}</span>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={undoRemove}>
                        <Undo2 aria-hidden="true" /> {lang === 'fr' ? 'Annuler' : 'Undo'}
                    </Button>
                </div>
            ) : null}

            {adding || editingId ? (
                <RuleEditor
                    lang={lang}
                    draft={draft}
                    onChange={setDraft}
                    onSubmit={submit}
                    onCancel={closeEditor}
                    busy={busy}
                    submitLabel={editingId
                        ? (lang === 'fr' ? 'Enregistrer' : 'Save')
                        : (lang === 'fr' ? 'Ajouter' : 'Add')}
                />
            ) : null}

            <ul className="border-border divide-border list-none overflow-hidden rounded-lg border">
                {!loaded ? (
                    <li className="text-muted-foreground px-4 py-6 text-center text-sm">
                        {lang === 'fr' ? 'Chargement' : 'Loading'}
                    </li>
                ) : rules.length === 0 ? (
                    <li className="text-muted-foreground px-4 py-6 text-center text-sm">
                        {lang === 'fr'
                            ? 'Aucune règle ici. Le profil par défaut s’applique.'
                            : 'No rules here. The default profile applies.'}
                    </li>
                ) : rules.map((rule) => (
                    <EditableRuleRow
                        key={rule.id}
                        lang={lang}
                        rule={rule}
                        busy={busy}
                        onEdit={() => startEdit(rule)}
                        onRemove={() => removeRule(rule)}
                    />
                ))}
            </ul>
        </section>
    );
}
