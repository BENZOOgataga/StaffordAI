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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { currentPlatform } from './platform/index.ts';
import { WEB_PREFERENCES, applySessionSecurity, applyWindowSecurity } from './window/security.ts';
import { installTray } from './tray.ts';
import { configureLoginItem } from './login-item.ts';
import { registerHandlers } from './ipc/handlers.ts';
import { ProofPty } from './ipc/proof-pty.ts';
import { openDatabase, DATA_DIR_NAME, type OpenResult } from './storage/database.ts';
import { createRepositories, type Repositories } from './storage/repository.ts';
import { startHookTransport, stopHookTransport, assertLaunchable, type HookTransport } from './hooks/transport.ts';
import { runDrain, type DrainableAgent } from './agents/drain.ts';
import { SessionRegistry, hireStoreOver, coerceHookEvent, type HireStore } from './hooks/session-registry.ts';
import { assembleRoster } from './roster/snapshot.ts';
import { SessionLifecycle } from './agents/session-lifecycle.ts';
import { locateClaude } from './agents/claude-locator.ts';
import { readTrust } from './agents/trust.ts';
import fs from 'node:fs';
import type { RosterSnapshot } from '../shared/ipc.ts';
import type { PtyLike } from './agents/pty-session.ts';

const dir = path.dirname(fileURLToPath(import.meta.url));
const STARTED_AT = new Date().toISOString();
const APP_ID = 'Stafford';

let store: OpenResult | null = null;
let repositories: Repositories | null = null;
let transport: HookTransport | null = null;
let registry: SessionRegistry | null = null;
let lifecycle: SessionLifecycle | null = null;

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

/**
 * Brings the hook transport up at launch, and runs the agent-readiness gate.
 *
 * Placed after the DB open and before the tray. The socket is security-critical
 * and must be up before the UI can offer any action that spawns an agent, and
 * the bring-up is cheap: a named pipe create on Windows, a directory chmod plus a
 * bind on macOS, no migration-sized I/O. So it sits ahead of the tray at no
 * perceptible cost, and the transport is proven up before anything can connect.
 *
 * Two separate gates, two separate failures. `assertLaunchable` refuses if the
 * Claude binary is absent or a self-check fails, because a machine that cannot
 * run an agent should refuse rather than present a tray that does nothing.
 * `startHookTransport` refuses on a socket mode mismatch or a bind failure,
 * because a hook socket in the wrong place is an exposure. Either failure shows a
 * visible error and quits, rather than half-starting.
 *
 * Nothing consumes a hook event yet. A connection is accepted and acknowledged;
 * mapping an event to agent state is the next step, kept separate on purpose.
 */
/**
 * Spawns a throwaway pty and kills it, to prove the spawn-and-kill layer works
 * before the app claims it can run agents. The same shape the harness uses.
 *
 * process.execPath is the Electron binary in a packaged app, so it is run with
 * ELECTRON_RUN_AS_NODE to evaluate a no-op and exit, rather than launching a
 * second Stafford. In development, where execPath is already node, the env is
 * harmless.
 */
function canSpawnAndKill(): boolean {
    const require = createRequire(import.meta.url);
    const nodePty = require('node-pty') as {
        spawn: (file: string, args: readonly string[], options: Record<string, unknown>) => { kill(): void };
    };
    const term = nodePty.spawn(process.execPath, ['-e', '0'], {
        name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH ?? '' }
    });
    try { term.kill(); } catch { /* opening it is the question, not closing it */ }
    return true;
}

async function startTransport(): Promise<boolean> {
    const platform = currentPlatform();
    const home = os.homedir();
    try {
        assertLaunchable(platform, home, APP_ID, canSpawnAndKill);
        transport = await startHookTransport({ platform, home, appId: APP_ID });
        smoke('hook transport up at ' + transport.socketPath + ' | ' + transport.accessDetail);
        smoke('socket setup: ' + JSON.stringify(transport.report));
        return true;
    } catch (error) {
        const message = 'Stafford could not start its hook transport and will not run:\n\n' +
            (error instanceof Error ? error.message : String(error));
        process.stderr.write('[fatal] ' + message + '\n');
        try { dialog.showErrorBox('Stafford', message); } catch { /* headless */ }
        app.quit();
        return false;
    }
}

/**
 * The active agent sessions the drain checkpoints. Empty until a roster maps hook
 * events to live agents, which is the step after this one. The drain runs against
 * an empty set now, so the quit path is wired and proven end to end while the
 * behaviour that fills it is tested with stubs in drain.test.ts.
 */
function activeDrainables(): DrainableAgent[] {
    return registry ? registry.drainables() : [];
}

/**
 * The roster as cards, assembled from the persisted hires and the live registry.
 * Read-only and bounded, one card per hire. The task line is null until task
 * dispatch exists; the field is a real seam, not invented data.
 */
function rosterSnapshot(): RosterSnapshot {
    if (!repositories) return { cards: [] };
    const names = new Map(repositories.projects.all().map((p) => [p.id, p.name]));
    return assembleRoster({
        hires: repositories.hires.all(),
        projectName: (id) => names.get(id) ?? null,
        live: (hireId) => (registry ? registry.liveInfoByHire(hireId) : null),
        currentTask: () => null,
        contextLost: (hireId) => (lifecycle ? lifecycle.contextLost(hireId) : false)
    });
}

/** Tells the roster window a card changed, so it re-reads the snapshot. */
function notifyRosterChanged(): void {
    if (window && !window.isDestroyed()) window.webContents.send('roster:changed');
}

/**
 * Builds the session lifecycle: the owner of live Claude sessions. It is dormant
 * until the first message (the detail view is 3b), but constructing it wires the
 * shared teardown into the registry, so at quit the drain reaps a real session
 * through the same path an idle shutdown will. If no Claude binary is located, the
 * shell runs without it and a spawn would surface the error when 3b lands.
 */
function buildLifecycle(store: HireStore): void {
    if (!repositories || !transport || !registry) return;
    const platform = currentPlatform();
    const home = os.homedir();

    let claudePath: string;
    try {
        claudePath = locateClaude({
            platform, home, pathValue: process.env.PATH ?? '', exists: (c) => fs.existsSync(c)
        }).path;
    } catch (error) {
        smoke('lifecycle unavailable, no Claude binary located: ' +
            (error instanceof Error ? error.message : String(error)));
        return;
    }

    const nodePty = createRequire(import.meta.url)('node-pty') as {
        spawn: (file: string, args: readonly string[], options: Record<string, unknown>) => PtyLike;
    };

    lifecycle = new SessionLifecycle({
        platform,
        socketPath: transport.socketPath,
        secrets: transport.secrets,
        registry,
        claudePath,
        nodeDir: path.dirname(process.execPath),
        parentEnv: process.env,
        spawn: (file, args, options) => nodePty.spawn(file, args, options),
        resolveTarget: (hireId) => {
            const hire = repositories?.hires.get(hireId);
            if (!hire || !hire.activeProjectId) return null;
            const project = repositories?.projects.get(hire.activeProjectId);
            const cwd = project?.repos[0]?.path;
            if (!cwd) return null;
            // A stored session id for this project resumes; nothing cold-spawns.
            return {
                projectId: hire.activeProjectId, cwd,
                resumeSessionId: hire.sessions[hire.activeProjectId] ?? null
            };
        },
        setState: (hireId, state) => store.setState(hireId, state),
        trustFor: (cwd) => readTrust({
            platform, dir: cwd, configPath: path.join(home, '.claude.json'),
            readFile: (p) => fs.readFileSync(p, 'utf8')
        }),
        onStateChanged: () => notifyRosterChanged()
    });
    smoke('lifecycle ready, claude at ' + claudePath);
}

let proofQuitting = false;
async function quit(): Promise<void> {
    proofQuitting = true;
    proof.kill();

    // Socket first, then sessions. The hook socket is the inbound agent-event
    // channel and holds no state worth saving, so closing it first shuts the gate:
    // the drain then checkpoints a stable set of sessions with nothing new arriving.
    // The sessions hold the working trees, the valuable resource, so they get the
    // full drain grace after the gate is shut. Awaited so no stale pipe or socket
    // file lingers.
    if (transport) {
        await stopHookTransport(transport).catch(() => {});
        transport = null;
    }

    // Disarm every session's idle and not-reporting timers before the drain, so
    // neither can fire mid-drain and race the drain's own teardown. The shared
    // teardown is idempotent, so a race would still resolve cleanly, but ordering
    // it this way means the drain owns teardown for the whole shutdown.
    lifecycle?.disarmTimers();

    // Drain the active sessions: checkpoint, bounded wait, force-kill what remains,
    // one durable report row per agent. Bounded by its own total cap, so a stuck
    // agent cannot hold the quit. A drain failure must not block the quit either,
    // so it is caught and the quit proceeds.
    if (repositories) {
        try {
            await runDrain({
                agents: activeDrainables(),
                platform: currentPlatform(),
                sink: repositories.drainReports,
                drainId: 'drain-' + new Date().toISOString(),
                now: () => new Date().toISOString(),
                // Force-kill through the lifecycle's one teardown, so a timed-out
                // session is reaped the same way a checkpointed one is. When there
                // is no lifecycle, the drain falls back to its own killTree.
                ...(lifecycle ? { forceKill: (agent) => lifecycle!.teardown(agent.agentId) } : {})
            });
        } catch (error) {
            process.stderr.write('[warn] drain did not complete cleanly: ' +
                (error instanceof Error ? error.message : String(error)) + '\n');
        }
    }

    // Force the exit. node-pty can leave a non-unref'd five-second timer per
    // Windows kill (issue 886) and stacking several holds the event loop, so a
    // natural quit can look hung at the worst moment. A 3s timer turns quit into a
    // hard app.exit(0). Everything that matters is already checkpointed and killed
    // by the time the drain returns, so the forced exit only drops handles the OS
    // reclaims anyway. The timer is unref'd so it never itself keeps the app alive.
    // See plan 7.4.1: this containment is why the kill path is not changed.
    const forced = setTimeout(() => { app.exit(0); }, 3000);
    forced.unref();
    app.quit();
}

app.whenReady().then(async () => {
    applySessionSecurity(session.defaultSession);

    // The store first, before the tray or any handler. If it cannot open, the
    // app has already quit inside openStore and there is nothing more to do.
    if (!openStore()) return;

    // The hook transport next, after the store gives its socket somewhere to
    // live and before the tray can offer to spawn anything. If it cannot come
    // up, the app has already quit inside startTransport.
    if (!(await startTransport())) return;

    // Connect the live listener to the state machine. A real inbound hook event
    // now drives a hire's state through the existing applyEvent path and registers
    // its session into the drainable set, so the drain no longer drains nothing.
    // repositories and transport are both set above, or the app already quit.
    if (repositories && transport) {
        const store = hireStoreOver(repositories);
        registry = new SessionRegistry(store);
        transport.listener.on('event', (raw: Record<string, unknown>) => {
            const result = registry?.ingest(coerceHookEvent(raw), new Date().toISOString());
            if (result?.changed) {
                smoke('hook drove ' + result.hireId + ' to ' + result.state);
                // A transition, so the roster changed. The renderer re-reads on
                // this signal rather than being pushed a card per hook event.
                notifyRosterChanged();
            }
        });
        buildLifecycle(store);
    }

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
        },
        rosterSnapshot,
        // The detail view's live terminal, over the session the lifecycle owns.
        // No lifecycle (no Claude located) means no session to stream or resize.
        subscribeSession: (hireId, listener) => (lifecycle ? lifecycle.subscribe(hireId, listener) : () => {}),
        resizeSession: (hireId, cols, rows) => { lifecycle?.resize(hireId, cols, rows); },
        hasSession: (hireId) => (lifecycle ? lifecycle.has(hireId) : false),
        submitMessage: (hireId, text) => (lifecycle ? lifecycle.submitMessage(hireId, text) : Promise.resolve())
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

        // A hire in the waiting state, so the roster has the signature card to
        // render. Proves the roster path end to end, hire in the store through
        // the snapshot to the card the renderer paints.
        repositories.hires.insert({
            id: 'smoke-hire-' + STARTED_AT, name: 'Marion', type: 'lead-developer',
            title: 'Lead developer', seniority: 2, ownerId: 'owner', sessions: {},
            activeProjectId: project.id, state: 'waiting_for_you', hiredAt: STARTED_AT, firedAt: null
        });
        smoke('roster snapshot cards = ' + rosterSnapshot().cards.length);
    }

    if (SMOKE) {
        // Open the roster window so the renderer runs the real read path: the
        // snapshot over IPC, rendered as cards. Then quit. STAFFORD_SMOKE=1 only.
        openWindow();
        setTimeout(() => {
            smoke('roster window open = ' + (window !== null && !window.isDestroyed()));
            smoke('quitting');
            void quit();
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
