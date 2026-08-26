/**
 * The renderer bootstrap. It starts the live roster store (which owns the alert rules
 * and the roster:changed subscription for the whole session), wires the view switcher,
 * and mounts the four React islands: the home dashboard, the roster, the channel, and the
 * project permissions
 * timeline. All of the main UI is React in the inset island shell.
 *
 * The only vanilla left is the create-project and hire sheets, modals opened from React.
 * Each island is code-split, loaded the first time its view opens, so the base bundle
 * never carries React.
 */

import type { StaffordApi } from '../preload/index.ts';
import { rosterStore } from './roster/roster-store.ts';
import { initCreateForms } from './create-forms.ts';
import type { Lang } from './create-forms-view.ts';

const lang: Lang = typeof navigator !== 'undefined' && navigator.language.startsWith('fr') ? 'fr' : 'en';

declare global {
    interface Window {
        readonly stafford: StaffordApi;
    }
}

function main(): void {
    // The alert rules run for the whole session, not only while the roster is on screen,
    // so a chime and a badge still fire when the person is on another view. The saved-work
    // notice is React now (the roster island), so it is no longer surfaced from here.
    rosterStore.start();

    // The React islands. Each fills the window when its view is active and is hidden
    // otherwise; only one is ever shown. Each island renders the shared AppShell, so the
    // rail lives in one component.
    const homeView = document.getElementById('home') as HTMLElement;
    const rosterView = document.getElementById('roster-react') as HTMLElement;
    const channelView = document.getElementById('channel-react') as HTMLElement;
    const permissionsView = document.getElementById('permissions-react') as HTMLElement;
    const boardView = document.getElementById('board-react') as HTMLElement;
    const projectsView = document.getElementById('projects-react') as HTMLElement;
    let dashboardMounted = false;
    let rosterMounted = false;
    let channelMounted = false;
    let permissionsMounted = false;
    let boardMounted = false;
    let projectsMounted = false;

    const showView = (view: string): void => {
        const isHome = view === 'home';
        const isRoster = view === 'roster';
        const isChannel = view === 'channel';
        const isPermissions = view === 'permissions';
        const isBoard = view === 'board';
        const isProjects = view === 'projects';
        homeView.hidden = !isHome;
        rosterView.hidden = !isRoster;
        channelView.hidden = !isChannel;
        permissionsView.hidden = !isPermissions;
        boardView.hidden = !isBoard;
        projectsView.hidden = !isProjects;

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
        if (isBoard && !boardMounted) {
            boardMounted = true;
            import('./board/mount.tsx')
                .then((m) => m.mountBoard(boardView, lang, showView))
                .catch((error: unknown) => {
                    boardMounted = false;
                    boardView.textContent = 'The task board could not load.';
                    console.error('[board] mount failed:', error);
                });
        }
        if (isPermissions && !permissionsMounted) {
            permissionsMounted = true;
            import('./permissions/mount.tsx')
                .then((m) => m.mountPermissions(permissionsView, lang, showView))
                .catch((error: unknown) => {
                    permissionsMounted = false;
                    permissionsView.textContent = 'Permissions could not load.';
                    console.error('[permissions] mount failed:', error);
                });
        }
        if (isProjects && !projectsMounted) {
            projectsMounted = true;
            import('./projects/mount.tsx')
                .then((m) => m.mountProjects(projectsView, lang, showView))
                .catch((error: unknown) => {
                    projectsMounted = false;
                    projectsView.textContent = 'Projects could not load.';
                    console.error('[projects] mount failed:', error);
                });
        }
    };

    // The create forms stay vanilla sheets, opened from the React roster. A successful
    // create does not emit a state transition, so the store is reloaded directly rather
    // than waiting for a roster:changed that will not come.
    initCreateForms({ onCreated: () => { rosterStore.reload(); } });

    // The custom title bar, on a frameless window only (Windows and Linux). The frameless
    // flag comes from the preload, set by main from the launch argument, so it is known
    // synchronously here. macOS keeps its native frame and mounts nothing.
    if (window.stafford.win.frameless) {
        document.documentElement.classList.add('has-titlebar');
        const bar = document.getElementById('titlebar');
        if (bar) {
            bar.hidden = false;
            import('./title-bar/mount.tsx')
                .then((m) => m.mountTitleBar(bar))
                .catch((error: unknown) => { console.error('[titlebar] mount failed:', error); });
        }
    }

    // Main can ask the shell to switch views: the tray routes a click to the board when
    // something is waiting, so tapping the tray while the badge is up lands on the waiting
    // work. Only known views are honored, so a stray payload cannot break navigation.
    const KNOWN_VIEWS = new Set(['home', 'roster', 'board', 'channel', 'permissions', 'projects']);
    window.stafford.shell.onNavigate((view) => { if (KNOWN_VIEWS.has(view)) showView(view); });

    // The hidden dev trigger panel, in a dev build only. Code-split so its chunk never loads in
    // production, and gated on the dev bridge the preload exposes only under --stafford-dev.
    if (window.stafford.dev?.isDev) {
        void import('./dev-panel.ts').then((m) => m.initDevPanel()).catch((error: unknown) => {
            console.error('[dev-panel] mount failed:', error);
        });
    }

    // Home is the default view on launch: the overview a person wants first, rather than
    // dropping straight into the roster.
    showView('home');
}

main();
