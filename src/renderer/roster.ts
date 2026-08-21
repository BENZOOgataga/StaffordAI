/**
 * The renderer bootstrap. It starts the live roster store (which owns the alert rules
 * and the roster:changed subscription for the whole session), wires the left rail to
 * the view switcher, and mounts the React islands: the home dashboard and, now, the
 * roster. Both are React screens in the inset island shell; the channel timeline is
 * still the vanilla view until its own phase.
 *
 * The roster's list moved to React (src/renderer/roster/*), so this file no longer
 * builds cards. The still-vanilla detail pane is reparented into the React roster on
 * mount, so clicking a colleague opens it in place exactly as before.
 */

import type { StaffordApi } from '../preload/index.ts';
import { rosterStore } from './roster/roster-store.ts';
import { activateChannel, deactivateChannel } from './channel.ts';
import { initCreateForms, openProjectForm, openHireForm } from './create-forms.ts';
import type { Lang } from './create-forms-view.ts';
import { renderSavedWork } from './checkpoints.ts';

const lang: Lang = typeof navigator !== 'undefined' && navigator.language.startsWith('fr') ? 'fr' : 'en';

declare global {
    interface Window {
        readonly stafford: StaffordApi;
    }
}

function main(): void {
    // The alert rules run for the whole session, not only while the roster is on
    // screen, so a chime and a badge still fire when the person is on another view.
    rosterStore.start();

    const channelView = document.getElementById('channel') as HTMLElement;
    // The two React islands. Each is a flex child that fills the window when active; the
    // vanilla rail and content are hidden outright then, so nothing bleeds through and
    // there is no stacking order to fight. React is code-split, loaded the first time
    // its view opens, so the vanilla bundle never carries it.
    const homeView = document.getElementById('home') as HTMLElement;
    const rosterView = document.getElementById('roster-react') as HTMLElement;
    const appEl = document.querySelector('.app') as HTMLElement;
    let dashboardMounted = false;
    let rosterMounted = false;

    const showView = (view: string): void => {
        const isHome = view === 'home';
        const isRoster = view === 'roster';
        const isChannel = view === 'channel';
        // The React islands cover the vanilla chrome; the vanilla channel restores it.
        appEl.classList.toggle('island-active', isHome || isRoster);
        homeView.hidden = !isHome;
        rosterView.hidden = !isRoster;
        // The roster and its detail are React now; only the channel still uses the
        // vanilla content region.
        channelView.hidden = !isChannel;
        for (const item of document.querySelectorAll('.rail-item')) {
            item.classList.toggle('active', item.getAttribute('data-view') === view);
        }
        if (isChannel) void activateChannel();
        else deactivateChannel();

        if (isHome && !dashboardMounted) {
            dashboardMounted = true;
            import('./dashboard/mount.tsx')
                .then((m) => m.mountDashboard(homeView, showView))
                .catch((error: unknown) => {
                    dashboardMounted = false;
                    homeView.textContent = 'The dashboard could not load.';
                    console.error('[dashboard] mount failed:', error);
                });
        }
        if (isRoster && !rosterMounted) {
            rosterMounted = true;
            import('./roster/mount.tsx')
                .then((m) => m.mountRoster(rosterView, lang, showView))
                .catch((error: unknown) => {
                    rosterMounted = false;
                    rosterView.textContent = 'The roster could not load.';
                    console.error('[roster] mount failed:', error);
                });
        }
    };

    for (const item of document.querySelectorAll('.rail-item')) {
        item.addEventListener('click', () => showView(item.getAttribute('data-view') ?? 'roster'));
    }

    // On launch, quietly surface any work a drain saved, so a save nobody could find
    // becomes findable. Read-only, off the drain report; dismissing marks it seen.
    const savedHost = document.getElementById('saved-work') as HTMLElement;
    void window.stafford.checkpoints.saved().then((data) => {
        if (data && data.saves.length > 0) {
            renderSavedWork(savedHost, data, lang, () => { void window.stafford.checkpoints.ack(data.drainId); });
        }
    });

    // The create forms. A successful create does not emit a state transition, so the
    // store is reloaded directly rather than waiting for a roster:changed that will not
    // come. The sheets stay vanilla, opened from either the React roster or the header.
    initCreateForms({ onCreated: () => { rosterStore.reload(); } });
    (document.getElementById('add-project-header') as HTMLButtonElement)
        .addEventListener('click', () => openProjectForm());
    (document.getElementById('hire-header') as HTMLButtonElement)
        .addEventListener('click', () => { void openHireForm(); });

    // The roster is the default view: mount and show it now.
    showView('roster');
}

main();
