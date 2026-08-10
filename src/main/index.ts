/**
 * Main process entry point. Boots to the tray, opens a window on demand.
 *
 * The order matters and is the shape from the start: the app is tray-resident,
 * so it boots to an icon with no window, and a window is created only when the
 * tray asks for one. `app.dock.hide()` on macOS keeps it out of the Dock, since
 * a tray app in the Dock is two homes for one process.
 *
 * Everything privileged is in main behind validated IPC. The renderer that this
 * opens has the section 6 security configuration, no Node integration, and a
 * CSP set from here rather than from a meta tag it could weaken.
 *
 * Task 7a. No packaging, no update checker, no drain. Those are 7b and Task 8.
 */

import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, session, dialog } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { currentPlatform } from './platform/index.ts';
import { WEB_PREFERENCES, applySessionSecurity, applyWindowSecurity } from './window/security.ts';
import { installTray } from './tray.ts';
import { configureLoginItem } from './login-item.ts';
import { registerHandlers } from './ipc/handlers.ts';
import { ProofPty } from './ipc/proof-pty.ts';
import { openDatabase, DATA_DIR_NAME, type OpenResult } from './storage/database.ts';
import { createRepositories, type Repositories } from './storage/repository.ts';

const dir = path.dirname(fileURLToPath(import.meta.url));
const STARTED_AT = new Date().toISOString();

let store: OpenResult | null = null;
let repositories: Repositories | null = null;

/**
 * Opens the database and brings it to the current schema, before anything a user
 * can see.
 *
 * On the critical path to the tray on purpose. It runs the migrations
 * synchronously and blocks until they finish, and better-sqlite3 blocks the
 * event loop while it does, so the tray does not appear until the store is
 * ready. For the expected database size, a handful of projects and hires and a
 * capped run of tasks, migration 0001 is sub-millisecond, so the delay is not
 * perceptible. If migrations ever grow heavy enough to be felt at launch, that
 * is the point to move the tray ahead of the open and show a preparing state,
 * not before.
 *
 * If it throws, migrations failed, the file is corrupt, or its version is ahead
 * of this build. The app must not run with no store, half a product, so this
 * shows a visible error and quits rather than continuing into a tray backed by
 * nothing.
 *
 * The base passed to openDatabase is the platform app-data directory with its
 * appId segment stripped, because openDatabase appends its own `Stafford`
 * segment (the runtime APP_ID, human-readable, deliberately not the reverse-DNS
 * packaging appId). The result is `<app data>/Stafford/stafford.db`, one Stafford
 * rather than two.
 */
function openStore(): boolean {
    try {
        const base = path.dirname(currentPlatform().appDataDir(os.homedir(), DATA_DIR_NAME));
        store = openDatabase({ appDataDir: base });
        repositories = createRepositories(store.db);
        smoke('db open ' + store.path + ', migration ' + JSON.stringify(store.migration));
        return true;
    } catch (error) {
        const message = 'Stafford could not open its database and will not start:\n\n' +
            (error instanceof Error ? error.message : String(error));
        process.stderr.write('[fatal] ' + message + '\n');
        // showErrorBox works before any window exists. Then quit hard.
        try { dialog.showErrorBox('Stafford', message); } catch { /* headless */ }
        app.quit();
        return false;
    }
}

/**
 * A non-interactive proof path, for verifying the shell without a human at the
 * window. `STAFFORD_SMOKE=1` logs the boot, the health call and the first pty
 * bytes to stderr, then quits. It changes nothing about the normal run: without
 * the flag none of these lines fire.
 */
const SMOKE = process.env.STAFFORD_SMOKE === '1';
function smoke(line: string): void { if (SMOKE) process.stderr.write('[smoke] ' + line + '\n'); }

let tray: Tray | null = null;
let window: BrowserWindow | null = null;
const proof = new ProofPty();

function rendererEntry(): string {
    // electron-vite serves the renderer from a dev server URL in development and
    // from a built file once packaged. 7a runs in development.
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    return devUrl ?? 'file://' + path.join(dir, '../renderer/index.html');
}

function openWindow(): void {
    if (window && !window.isDestroyed()) {
        window.show();
        window.focus();
        return;
    }

    const win = new BrowserWindow({
        width: 720,
        height: 520,
        show: false,
        title: 'Stafford',
        webPreferences: {
            ...WEB_PREFERENCES,
            // .cjs: a sandboxed preload is CommonJS. See electron.vite.config.ts.
            preload: path.join(dir, '../preload/index.cjs')
        }
    });

    const entry = rendererEntry();
    applyWindowSecurity(win, entry);
    win.once('ready-to-show', () => win.show());

    // Closing returns to the tray rather than quitting.
    win.on('close', (event) => {
        if (proofQuitting) return;
        event.preventDefault();
        win.hide();
    });
    win.on('closed', () => { if (window === win) window = null; });

    void win.loadURL(entry);
    window = win;
}

let proofQuitting = false;
function quit(): void {
    proofQuitting = true;
    proof.kill();
    app.quit();
}

app.whenReady().then(() => {
    applySessionSecurity(session.defaultSession);

    // The store first, before the tray or any handler. If it cannot open, the
    // app has already quit inside openStore and there is nothing more to do.
    if (!openStore()) return;

    // Never register the login item during a smoke run. A smoke run launches
    // the packaged app for verification, where app.isPackaged is true and the
    // login item would otherwise register, which is a change to a live system
    // and is not verification's to make.
    if (!SMOKE) configureLoginItem(app);

    registerHandlers(ipcMain, {
        startedAt: STARTED_AT,
        platformId: currentPlatform().id,
        proof,
        sender: () => (window && !window.isDestroyed() ? window.webContents : null),
        // The store's one live consumer. Read-only, bounded, ids and names only.
        // repositories is set by openStore above, which the app quits without if
        // it failed, so it is present here. The only caller of this is the
        // renderer through ipcMain, so the smoke line firing proves the IPC read
        // reached main and returned rows, the way proof.isOpen() proved the pty.
        listProjects: () => {
            const projects = repositories
                ? repositories.projects.all().map((p) => ({ id: p.id, name: p.name }))
                : [];
            smoke('projects:list served ' + projects.length + ' rows over IPC');
            return { projects };
        }
    });

    smoke('boot ok: tray-resident, no window at launch, platform ' + currentPlatform().id +
        ', windows open now ' + BrowserWindow.getAllWindows().length);

    if (SMOKE && repositories) {
        // A real repository write and read from the running app, not a test, the
        // way 7a proved the pty path. Proves the DB opened, migrated, and the
        // repository round-trips against the on-disk file.
        const project = {
            id: 'smoke-' + STARTED_AT, name: 'smoke', repos: [{ path: '/x', label: 'x' }],
            policy: {
                push: 'none' as const, allowedRoles: [], toolCeiling: null, writePaths: null,
                requirePipeline: false, allowWebFetch: false, permissionMode: 'default', maxConcurrentAgents: 1
            }
        };
        repositories.projects.insert(project);
        const back = repositories.projects.get(project.id);
        smoke('repository write+read ok = ' + (back !== null && back.id === project.id));
        smoke('projects in store now = ' + repositories.projects.all().length);
    }

    if (SMOKE) {
        // Open the window so the renderer runs the real chain end to end: health
        // over IPC, a shell spawned through main, then streamed back. proof.isOpen
        // afterwards is true only if the preload bridge, the renderer, the IPC
        // handler and node-pty all worked. Then quit. STAFFORD_SMOKE=1 only.
        openWindow();
        setTimeout(() => {
            smoke('renderer drove a pty open through the bridge = ' + proof.isOpen());
            smoke('quitting');
            quit();
        }, 6000);
    }

    // Out of the Dock, tray only. Keyed on the capability rather than the
    // platform name: app.dock exists only where there is a Dock, which is
    // macOS, so this needs no platform branch and the platform-leak guard stays
    // satisfied.
    if (app.dock) app.dock.hide();

    tray = installTray({
        createTray: () => new Tray(nativeImage.createEmpty()),
        buildMenu: (template) => Menu.buildFromTemplate(template),
        openWindow,
        quit
    });
    void tray;
});

// No window at launch and none when the last window closes: the tray keeps the
// process alive, which is the whole point of a tray-resident app. Not quitting
// here is what makes it tray-resident; the default would quit on last close.
app.on('window-all-closed', () => {
    // Deliberately empty. Do not call app.quit(): the tray is the home.
});
