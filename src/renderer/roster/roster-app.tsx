import * as React from 'react';
import { RosterScreen } from './roster-screen.tsx';
import { useRoster } from './use-roster.ts';
import { rosterStore } from './roster-store.ts';
import { openProjectForm, openHireForm } from '../create-forms.ts';
import { formCopy, type Lang } from '../create-forms-view.ts';

/**
 * The roster, wired: it reads the live store through the hook and hands the screen the
 * state plus the actions. onNavigate is the seam back to the shell, so a Sidebar click
 * switches the view; detailNode is the still-vanilla detail pane the screen reparents.
 */
export function RosterApp({ lang, onNavigate, detailNode }: {
    lang: Lang;
    onNavigate: (view: string) => void;
    detailNode: HTMLElement | null;
}): React.JSX.Element {
    const state = useRoster();
    const copy = formCopy(lang);
    return (
        <RosterScreen
            state={state}
            lang={lang}
            copy={copy}
            current="roster"
            onNavigate={onNavigate}
            onSelect={(card) => rosterStore.select(card)}
            onToggleMute={() => rosterStore.toggleMute()}
            onHire={() => { void openHireForm(); }}
            onAddProject={() => openProjectForm()}
            detailNode={detailNode}
        />
    );
}
