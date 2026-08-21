/**
 * The renderer bootstrap. It starts the live roster store (which owns the alert rules
 * and the roster:changed subscription for the whole session), wires the view switcher,
 * and mounts the three React islands: the home dashboard, the roster, and the channel
 * timeline. All of the main UI is React in the inset island shell now.
 *
 * The vanilla shell that remains (the rail, the header, the saved-work host) is the
 * launch container; the create-project and hire sheets are still vanilla modals, opened
 * from React. Each island is code-split, loaded the first time its view opens, so the
 * base bundle never carries React.
 */

import type { StaffordApi } from '../preload/index.ts';
import { rosterStore } from './roster/roster-store.ts';
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

    // The three React islands. Each is a flex child that fills the window when active;
    // the vanilla rail and content are hidden outright then, so nothing bleeds through
    // and there is no stacking order to fight.
    const homeView = document.getElementById('home') as HTMLElement;
    const rosterView = document.getElementById('roster-react') as HTMLElement;
    const channelView = document.getElementById('channel-react') as HTMLElement;
    const appEl = document.querySelector('.app') as HTMLElement;
    let dashboardMounted = false;
    let rosterMounted = false;
    let channelMounted = false;

    const showView = (view: string): void => {
        const isHome = view === 'home';
        const isRoster = view === 'roster';
        const isChannel = view === 'channel';
        // Every main view is a React island now, so the vanilla chrome is always hidden.
        appEl.classList.toggle('island-active', isHome || isRoster || isChannel);
        homeView.hidden = !isHome;
        rosterView.hidden = !isRoster;
        channelView.hidden = !isChannel;
        for (const item of document.querySelectorAll('.rail-item')) {
            item.classList.toggle('active', item.getAttribute('data-view') === view);
        }

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
        if (isChannel && !channelMounted) {
            channelMounted = true;
            import('./channel/mount.tsx')
                .then((m) => m.mountChannel(channelView, lang, showView))
                .catch((error: unknown) => {
                    channelMounted = false;
                    channelView.textContent = 'The channel could not load.';
                    console.error('[channel] mount failed:', error);
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
