import * as React from 'react';
import { Button } from '@/components/ui/button';
import type { Lang } from '../channel-view.ts';

/**
 * The remove-colleague action on the detail header. Firing is archive, not delete: the confirmation
 * says what stops and what is kept, specifically, so nothing is destroyed without the person seeing it
 * named. A refusal from the fireable guard is shown inline with its concrete reason, never a generic
 * message. It lives on the detail surface, not the roster, so a misclick cannot remove a colleague.
 *
 * The confirmation is a two-step reveal in the header rather than a full dialog: one click arms it, a
 * second confirms. On success the roster re-reads through the change signals and the card leaves, so
 * this component does not navigate; it only reports a refusal.
 */

type Copy = {
    remove: string;
    title: (name: string) => string;
    body: string;
    confirm: string;
    cancel: string;
    working: string;
};

const COPY: Record<Lang, Copy> = {
    en: {
        remove: 'Remove colleague',
        title: (name) => 'Remove ' + name + '?',
        body: 'Its running session will be stopped. Its conversation, tasks, and activity are kept. No git branches are touched, and any it created stay on disk.',
        confirm: 'Remove',
        cancel: 'Cancel',
        working: 'Removing'
    },
    fr: {
        remove: 'Retirer le collègue',
        title: (name) => 'Retirer ' + name + ' ?',
        body: "Sa session en cours sera arrêtée. Sa conversation, ses tâches et son activité sont conservées. Aucune branche git n'est touchée, et celles qu'il a créées restent sur le disque.",
        confirm: 'Retirer',
        cancel: 'Annuler',
        working: 'Retrait en cours'
    }
};

export function FireColleague({ hireId, name, lang }: {
    hireId: string;
    name: string;
    lang: Lang;
}): React.JSX.Element {
    const copy = COPY[lang];
    const [confirming, setConfirming] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [refused, setRefused] = React.useState<string | null>(null);

    // Reset the affordance when the selected colleague changes, so an armed confirm or a stale refusal
    // from one colleague never carries onto the next.
    React.useEffect(() => {
        setConfirming(false);
        setBusy(false);
        setRefused(null);
    }, [hireId]);

    const onConfirm = async (): Promise<void> => {
        setBusy(true);
        setRefused(null);
        try {
            const reply = await window.stafford.projects.fire(hireId);
            if (reply.ok) {
                // The roster re-reads on the change signals and this card leaves; nothing to do here.
                return;
            }
            const reason = (lang === 'fr' ? reply.refusedFr : reply.refused) ?? reply.refused;
            setRefused(reason ?? copy.remove);
            setConfirming(false);
        } finally {
            setBusy(false);
        }
    };

    if (!confirming) {
        return (
            <div className="flex flex-col items-end gap-1">
                <Button size="sm" variant="ghost" disabled={busy}
                    onClick={() => { setRefused(null); setConfirming(true); }}>
                    {copy.remove}
                </Button>
                {refused ? <p className="text-muted-foreground max-w-xs text-right text-xs">{refused}</p> : null}
            </div>
        );
    }

    return (
        <div className="flex max-w-md flex-col items-end gap-2">
            <p className="text-sm font-medium">{copy.title(name)}</p>
            <p className="text-muted-foreground text-right text-xs">{copy.body}</p>
            <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                    {copy.cancel}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => { void onConfirm(); }}>
                    {busy ? copy.working : copy.confirm}
                </Button>
            </div>
        </div>
    );
}
