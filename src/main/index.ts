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

import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, session, dialog, screen } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { currentPlatform } from './platform/index.ts';
import { WEB_PREFERENCES, applySessionSecurity, applyWindowSecurity } from './window/security.ts';
import { resolveWindowBounds, readWindowState, saveWindowState, WINDOW_DEFAULTS, type Rect } from './window/window-state.ts';
import { installTray } from './tray.ts';
import { configureLoginItem } from './login-item.ts';
import { registerHandlers } from './ipc/handlers.ts';
import { ProofPty } from './ipc/proof-pty.ts';
import { openDatabase, type OpenResult } from './storage/database.ts';
import { resolveStoreBase } from './storage/store-location.ts';
import { resolveAppId } from './app-id.ts';
import { createProject as createProjectService, createHire as createHireService, type CreateDeps } from './create/create-flow.ts';
import { preTrustDirectory } from './agents/pre-trust.ts';
import { seedManagedConfig, type ManagedFs } from './agents/managed-config.ts';
import { buildCommand, hookShellFor, merge, addExcludeEntry, type Settings } from './hooks/registration.ts';
import { createRepositories, type Repositories } from './storage/repository.ts';
import { startHookTransport, stopHookTransport, assertLaunchable, type HookTransport } from './hooks/transport.ts';
import { runDrain, type DrainableAgent, type CheckpointResult } from './agents/drain.ts';
import { checkpointRepo } from './agents/checkpoint-executor.ts';
import { realCheckpointDeps } from './agents/checkpoint-git.ts';
import { SessionRegistry, hireStoreOver, coerceHookEvent, type HireStore } from './hooks/session-registry.ts';
import { assembleRoster } from './roster/snapshot.ts';
import { SessionLifecycle } from './agents/session-lifecycle.ts';
import { locateClaude } from './agents/claude-locator.ts';
import { readTrust } from './agents/trust.ts';
import { recordTransition } from './channel/channel-events.ts';
import { TranscriptManager, coerceObservation } from './activity/transcript-manager.ts';
import { savedNoticeFor } from './checkpoints/saved-work.ts';
import { ActivityCoalescer, shouldPersist, type CoalescedAction } from './activity/activity-coalesce.ts';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { RosterSnapshot, ActivityRow, SavedCheckpoints } from '../shared/ipc.ts';
import { CHANNEL_SELF_SENDER } from '../shared/ipc.ts';
import type { PtyLike } from './agents/pty-session.ts';

const dir = path.dirname(fileURLToPath(import.meta.url));
const STARTED_AT = new Date().toISOString();
// The runtime app id, `Stafford` by default. STAFFORD_APP_ID overrides it for an
// isolated verification run, scoping the hook pipe and the data dir together so
// the run coexists with a running Stafford instead of colliding on its endpoints.
const { appId: APP_ID, overridden: APP_ID_OVERRIDDEN } = resolveAppId(process.env);

let store: OpenResult | null = null;
let repositories: Repositories | null = null;
let transport: HookTransport | null = null;
let registry: SessionRegistry | null = null;
let lifecycle: SessionLifecycle | null = null;
let transcriptManager: TranscriptManager | null = null;

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
 *
 * Under STAFFORD_SMOKE=1 the base is a throwaway temp directory instead, so the
 * smoke seed never writes into the real store. See store-location.ts.
 */
function openStore(): boolean {
    try {
        const realBase = path.dirname(currentPlatform().appDataDir(os.homedir(), APP_ID));
        // A smoke run opens a throwaway store instead of the real one, so its seed
        // never lands in user data. A normal launch is unchanged.
        const base = resolveStoreBase({ smoke: SMOKE, realBase });
        // The store folder is named for the app id, so an overridden run keeps its
        // store beside the real one rather than in it. The default id is DATA_DIR_NAME.
        store = openDatabase({ appDataDir: base, dirName: APP_ID });
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
 * Writes to a path atomically: a temp file in the same directory, then a rename,
 * so a concurrent reader of Claude Code's config never sees a half-written file.
 */
function writeConfigAtomic(target: string, data: string): void {
    const tmp = target + '.stafford-' + process.pid + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
}

/**
 * Locks a managed-config path to the current user, where the platform needs a
 * command to do it.
 *
 * The platform decides: Windows returns an `icacls` plan because node's `chmod`
 * cannot set an ACL there and a userData path can inherit a group-readable ACE;
 * POSIX returns null because the seed's `chmod` to 0600/0700 is already the whole
 * guarantee. Best-effort by design: a failure warns rather than blocking the spawn,
 * and no message carries the path or the file's contents.
 */
function restrictToOwner(target: string, opts: { tree: boolean }): void {
    const username = process.env.USERNAME;
    if (!username) return;
    const account = (process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : '') + username;
    const plan = currentPlatform().ownerOnlyAclPlan(target, { tree: opts.tree, account });
    if (!plan) return;
    try {
        const r = spawnSync(plan.file, [...plan.args], { windowsHide: true });
        if (r.status !== 0) process.stderr.write('[managed-config] could not lock ACL on a managed config path\n');
    } catch {
        process.stderr.write('[managed-config] ACL tool unavailable; managed config relies on the inherited ACL\n');
    }
}

/**
 * A real on-disk path to the hook forwarder that the hook can read.
 *
 * The forwarder is bundled next to the built main (`out/main/claude-hook.cjs`),
 * which in a packaged app is inside `app.asar`. The hook launches the forwarder
 * with `ELECTRON_RUN_AS_NODE`, where Electron's asar support is off, so a path
 * inside the asar would not be readable. This process is asar-aware, so it reads
 * the bundled copy and writes it once to a real path under userData, and the hook
 * points at that. In development the bundled copy is already a real file, but the
 * same copy keeps the two paths identical. Falls back to the source tree if the
 * bundled copy is somehow absent.
 */
function resolveForwarder(): string {
    const bundled = path.join(dir, 'claude-hook.cjs');
    try {
        const source = fs.readFileSync(bundled);
        const target = path.join(app.getPath('userData'), 'claude-hook.cjs');
        let current: Buffer | null = null;
        try { current = fs.readFileSync(target); } catch { current = null; }
        if (!current || !current.equals(source)) fs.writeFileSync(target, source);
        return target;
    } catch {
        return path.join(process.cwd(), 'hooks', 'claude-hook.cjs');
    }
}

/**
 * Registers Stafford's hooks in a project's own `.claude/settings.local.json`,
 * merging with whatever is there, and keeps the file out of the user's git via
 * `.git/info/exclude`. Runs before each spawn; merge is idempotent, so a
 * re-registration cannot double an entry. This is what makes a spawned colleague's
 * state actually reach Stafford.
 */
function registerHooksInProject(cwd: string): void {
    const command = buildCommand(process.execPath, resolveForwarder(), hookShellFor(currentPlatform().id));
    const settingsDir = path.join(cwd, '.claude');
    const settingsPath = path.join(settingsDir, 'settings.local.json');

    let existing: Settings = {};
    try {
        existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Settings;
    } catch {
        existing = {};
    }
    fs.mkdirSync(settingsDir, { recursive: true });
    writeConfigAtomic(settingsPath, JSON.stringify(merge(existing, command), null, 2) + '\n');

    // Local to this clone, never committed, so an agent running git status in the
    // project cannot commit Stafford's config into the user's repository.
    try {
        if (!fs.existsSync(path.join(cwd, '.git'))) return;
        const excludePath = path.join(cwd, '.git', 'info', 'exclude');
        fs.mkdirSync(path.dirname(excludePath), { recursive: true });
        const content = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
        const next = addExcludeEntry(content);
        if (next !== content) fs.writeFileSync(excludePath, next);
    } catch {
        // Best effort: a missing or unwritable .git is not worth failing the spawn.
    }
}

/** True iff the path is an existing directory. The create flow's load-bearing check. */
function dirExists(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/**
 * The create flow's dependencies over the real store and filesystem. The
 * validation and the shapes live in create-flow.ts; this binds them to the real
 * repository inserts, the real directory check, and a fresh randomUUID id.
 */
function createDeps(repositories: Repositories): CreateDeps {
    return {
        dirExists,
        insertProject: (project) => repositories.projects.insert(project),
        getProject: (id) => repositories.projects.get(id),
        insertHire: (hire) => repositories.hires.insert(hire),
        uuid: () => randomUUID(),
        now: () => new Date().toISOString(),
        ownerId: 'owner',
        labelFor: (p) => path.basename(p) || p
    };
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

/** The remembered window bounds live beside the DB, in userData, never committed. */
function windowStatePath(): string {
    return path.join(app.getPath('userData'), 'window-state.json');
}

/** The last saved-work notice the person dismissed, in userData, so it does not show again. */
function checkpointsSeenPath(): string {
    return path.join(app.getPath('userData'), 'checkpoints-seen.json');
}

function readSeenDrainId(): string | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(checkpointsSeenPath(), 'utf8')) as { drainId?: unknown };
        return typeof parsed.drainId === 'string' ? parsed.drainId : null;
    } catch {
        return null;
    }
}

/**
 * The saved work from the most recent committed drain, for the launch notice, or null
 * when there is none or the person already dismissed it. A read of the drain report,
 * never git; a committed row carries the branch, and the agent id is the hire id, so
 * the name is a store lookup.
 */
function savedCheckpoints(): SavedCheckpoints | null {
    if (!repositories) return null;
    const hires = repositories.hires;
    return savedNoticeFor(
        repositories.drainReports.latestCommittedDrain(),
        readSeenDrainId(),
        (hireId) => hires.get(hireId)?.name ?? hireId
    );
}

function ackCheckpoints(drainId: string): void {
    try {
        fs.writeFileSync(checkpointsSeenPath(), JSON.stringify({ drainId }));
    } catch {
        // A best-effort marker: a failure only means the notice may show once more.
    }
}

/**
 * The bounds to open at. On first launch, a fraction of the current display's
 * work area, clamped and centred. Otherwise the user's saved size and position,
 * clamped to the display it now lands on so it always opens fully visible.
 */
function resolveOpenBounds(): { bounds: Rect; min: { width: number; height: number } } {
    const saved = readWindowState((p) => fs.readFileSync(p, 'utf8'), windowStatePath());
    // Clamp against the display the saved window lands on, or the primary on a
    // first launch, using the work area so it never sits under the taskbar.
    const display = saved
        ? screen.getDisplayMatching({ x: saved.x, y: saved.y, width: saved.width, height: saved.height })
        : screen.getPrimaryDisplay();
    const bounds = resolveWindowBounds(display.workArea, saved, WINDOW_DEFAULTS);
    return { bounds, min: WINDOW_DEFAULTS.min };
}

function openWindow(): void {
    if (window && !window.isDestroyed()) {
        window.show();
        window.focus();
        return;
    }

    const { bounds, min } = resolveOpenBounds();
    const win = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        minWidth: min.width,
        minHeight: min.height,
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

    // Remember the user's size and position after they adjust it. Debounced, and
    // only a normal window (not minimised or maximised) is worth saving, so a
    // restore opens at a real size rather than a zero or a maximised sentinel.
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const rememberBounds = (): void => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
            try {
                saveWindowState((p, data) => fs.writeFileSync(p, data), windowStatePath(), win.getBounds());
            } catch {
                // A window-state write is best effort: a failure loses the memory,
                // never a launch.
            }
        }, 400);
    };
    win.on('resize', rememberBounds);
    win.on('move', rememberBounds);

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
        smoke('app id ' + APP_ID + (APP_ID_OVERRIDDEN ? ' (overridden, isolated run)' : ' (default)'));
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

/** Tells the channel view a row landed, so it fetches the tail, not the whole timeline. */
function notifyChannelChanged(): void {
    if (window && !window.isDestroyed()) window.webContents.send('channel:changed');
}

/** Pushes one activity action to the Activity feed, so it appends the row live. */
function notifyActivityAppended(row: ActivityRow): void {
    if (window && !window.isDestroyed()) window.webContents.send('activity:appended', row);
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

    // Stafford's own Claude config dir, under userData and so outside every project
    // repo: the checkpoint executor only commits tracked files inside the project
    // cwd, so nothing here can ever enter a checkpoint. Pointing CLAUDE_CONFIG_DIR at
    // it relocates Claude's config off the user's ~/.claude, which is what keeps the
    // user's global plugins and foreign hooks out of a colleague session.
    const managedConfigDir = path.join(app.getPath('userData'), 'claude-config');
    const managedConfigJson = path.join(managedConfigDir, '.claude.json');

    // The key Claude matches a cwd to: real case, forward slashes. Shared by the seed
    // and pre-trust so their keys agree, which keeps pre-trust a no-op after the seed
    // has already set the trust key (so it never rewrites the credential-bearing
    // .claude.json at broadened permissions).
    const resolveTrustKey = (dir: string): string => {
        try {
            return fs.realpathSync.native(dir).replace(/\\/g, '/');
        } catch {
            return dir.replace(/\\/g, '/');
        }
    };

    // The real filesystem behind the managed-config seed. Writes are atomic and every
    // secret-bearing file is chmod'd owner-only; the credential is never read into a
    // log. On Windows chmod only toggles the read-only bit and the file inherits the
    // user-profile ACL under userData, so it is not broadened.
    const managedFs: ManagedFs = {
        exists: (p) => fs.existsSync(p),
        readText: (p) => fs.readFileSync(p, 'utf8'),
        writeText: (p, data, mode) => {
            writeConfigAtomic(p, data);
            try { fs.chmodSync(p, mode); } catch {}
            // The account file carries oauthAccount; lock it owner-only on Windows.
            if (p.endsWith('.claude.json')) restrictToOwner(p, { tree: false });
        },
        mkdirp: (p, mode) => {
            const existed = fs.existsSync(p);
            fs.mkdirSync(p, { recursive: true, mode });
            // Lock the dir and its future children owner-only on first create. POSIX
            // uses the mode above; the explicit chmod in the seed covers umask.
            if (!existed) restrictToOwner(p, { tree: true });
        },
        copyFile: (from, to, mode) => {
            fs.copyFileSync(from, to);
            try { fs.chmodSync(to, mode); } catch {}
            // The credential is the secret; lock it owner-only every copy on Windows,
            // regardless of any ACL a prior copy left behind.
            restrictToOwner(to, { tree: false });
        },
        chmod: (p, mode) => { try { fs.chmodSync(p, mode); } catch {} },
        join: (...parts) => path.join(...parts)
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
        // Trust is read from the managed config the isolated session actually reads,
        // not the user's ~/.claude.json.
        trustFor: (cwd) => readTrust({
            platform, dir: cwd, configPath: managedConfigJson,
            readFile: (p) => fs.readFileSync(p, 'utf8')
        }),
        // Seed the managed config dir: credential carried in, project trust and
        // account written, plugin-free settings. This is what isolates the user's
        // global plugins from the colleague. Directory 0700, credential 0600.
        seedManagedConfig: (cwd) => {
            const result = seedManagedConfig(
                { fs: managedFs, managedDir: managedConfigDir, realHome: home, resolveKey: resolveTrustKey,
                    warn: (m) => process.stderr.write('[managed-config] ' + m + '\n') },
                cwd
            );
            // A one-line log with no token and no listing: just whether auth was carried.
            smoke('managed config seeded, credential carried: ' + result.credentialCopied);
        },
        claudeConfigDir: managedConfigDir,
        // Pre-trust the project directory the user chose, so the spawn skips the
        // startup trust prompt. Writes into the managed config the isolated session
        // reads. Idempotent after the seed, which already set this key.
        preTrust: (cwd) => preTrustDirectory({
            configPath: managedConfigJson,
            readFile: (p) => fs.readFileSync(p, 'utf8'),
            writeFile: writeConfigAtomic,
            resolveKey: resolveTrustKey,
            warn: (message) => process.stderr.write('[pre-trust] ' + message + '\n')
        }, cwd),
        // Register the state-reporting hooks in the project, so Claude Code runs
        // the forwarder and the roster hears what the colleague is doing.
        registerHooks: (cwd) => registerHooksInProject(cwd),
        // Drop a stale session id whose resume failed, so the next open does not
        // resume it again. The fresh session records its own id through the rendezvous.
        clearStoredSession: (hireId) => {
            const hire = repositories?.hires.get(hireId);
            if (!hire || !hire.activeProjectId) return;
            if (!(hire.activeProjectId in hire.sessions)) return;
            const sessions = { ...hire.sessions };
            delete sessions[hire.activeProjectId];
            repositories?.hires.update({ ...hire, sessions });
        },
        onStateChanged: () => notifyRosterChanged()
    });
    smoke('lifecycle ready, claude at ' + claudePath);
}

let proofQuitting = false;
async function quit(): Promise<void> {
    proofQuitting = true;
    proof.kill();

    // Stop the transcript tailers. They only read files and hold an unref'd timer,
    // so they cannot block the quit, but stopping them is tidy and deterministic.
    transcriptManager?.stopAll();
    transcriptManager = null;

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
        // The git checkpoint executor. On drain, a session's tracked work is committed
        // to a checkpoint branch before the session is reaped, so committed=true in the
        // drain report is real. The executor is bounded and always resolves, so it fits
        // inside the drain's per-agent budget without a new unbounded path.
        registry.setCheckpointRunner((cwd, hireId) =>
            checkpointRepo(realCheckpointDeps(currentPlatform()), {
                cwd, hireId, stamp: new Date().toISOString()
            }).then((o): CheckpointResult => ({
                committed: o.committed, branch: o.branch, commitId: o.commitId,
                reason: o.committed ? null : (o.reason === 'error' && o.detail ? 'error: ' + o.detail : o.reason)
            })));
        transport.listener.on('event', (raw: Record<string, unknown>) => {
            const now = new Date().toISOString();
            const result = registry?.ingest(coerceHookEvent(raw), now);
            if (result?.changed) {
                smoke('hook drove ' + result.hireId + ' to ' + result.state);
                // A transition, so the roster changed. The renderer re-reads on
                // this signal rather than being pushed a card per hook event.
                notifyRosterChanged();
                // The same real-change signal drives a channel timeline row, when
                // the state earns one. A card-only state writes nothing.
                if (repositories && recordTransition(repositories.channel, result, now, randomUUID())) {
                    smoke('channel event for ' + result.hireId + ' ' + result.state);
                    // A row landed, so the channel view fetches the new tail.
                    notifyChannelChanged();
                }
            }
        });
        buildLifecycle(store);

        // A second, independent consumer of the same hook stream, for the rich
        // activity feed. It reads only the transcript path off each record and
        // tails Claude's own transcript for tool events. It is wrapped so a fault
        // in it can never reach the state path above: a throw here is swallowed,
        // and the module cannot even import the registry, state, or drain, which a
        // test asserts.
        //
        // The events are coalesced (a use plus its result become one action) and the
        // accomplishment set is persisted per colleague, resolving the hire from the
        // session read-only. This write path is separate from the state path: it
        // touches only activity_events, never a state table, the registry, or the
        // turn-paced transition writes, so it cannot regress the state cadence or the
        // drain. The rich rows are piece 3.
        const coalescer = new ActivityCoalescer();
        const handleAction = (action: CoalescedAction): void => {
            const sessionId = action.sessionId;
            const binding = sessionId ? store.findBySession(sessionId) : null;
            if (!binding || !repositories) return; // unattributable, so neither stored nor shown
            // The accomplishment set is persisted; a read or search is live-only, shown
            // while the colleague is open and gone on reopen. Either way the action is
            // pushed to the open renderer so the feed is rich in the moment.
            const id = randomUUID();
            const stored = shouldPersist(action.tool);
            if (stored) {
                repositories.activity.append({
                    id, hireId: binding.hireId, sessionId,
                    tool: action.tool, target: action.target, status: action.status, at: action.at
                });
            }
            notifyActivityAppended({
                id, hireId: binding.hireId, tool: action.tool, target: action.target,
                status: action.status, at: action.at, live: !stored
            });
            smoke('activity ' + (stored ? 'persisted' : 'live') + ' ' + binding.hireId + ' ' +
                action.tool + (action.target ? ' ' + action.target : '') + ' [' + action.status + ']');
        };
        transcriptManager = new TranscriptManager({
            now: () => new Date().toISOString(),
            onEvents: (events) => { for (const action of coalescer.ingest(events)) handleAction(action); },
            onSessionEnd: (agentId) => { for (const action of coalescer.flush(agentId)) handleAction(action); },
            onDebug: (message) => smoke('transcript: ' + message)
        });
        transport.listener.on('event', (raw: Record<string, unknown>) => {
            try {
                transcriptManager?.observe(coerceObservation(raw));
            } catch (error) {
                // The rich feed must never disturb the state feed. Swallow and note.
                smoke('transcript observe error (ignored): ' +
                    (error instanceof Error ? error.message : String(error)));
            }
        });
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
        // The create flow's backend. The repository inserts already exist; this
        // validates (a repo path must be a real directory, a hire's type must be a
        // known definition) and writes through the repository, never raw SQL. A
        // fresh randomUUID id, no smoke- prefix. Throws on a bad input, which the
        // handler turns into a rejected invoke.
        createProject: (payload) => {
            if (!repositories) throw new Error('project:create: the store is not open');
            return createProjectService(createDeps(repositories), payload);
        },
        createHire: (payload) => {
            if (!repositories) throw new Error('hire:create: the store is not open');
            return createHireService(createDeps(repositories), payload);
        },
        rosterSnapshot,
        // The detail view's live terminal, over the session the lifecycle owns.
        // No lifecycle (no Claude located) means no session to stream or resize.
        subscribeSession: (hireId, listener) => (lifecycle ? lifecycle.subscribe(hireId, listener) : () => {}),
        resizeSession: (hireId, cols, rows) => { lifecycle?.resize(hireId, cols, rows); },
        hasSession: (hireId) => (lifecycle ? lifecycle.has(hireId) : false),
        submitMessage: (hireId, text) => (lifecycle ? lifecycle.submitMessage(hireId, text) : Promise.resolve()),
        // The timeline reads: the newest page, older rows for scroll-back, and the
        // tail after a cursor for the append on channel:changed.
        channelPage: (before, limit) => (repositories
            ? (before ? repositories.channel.before(before, limit) : repositories.channel.newest(limit))
            : []),
        channelSince: (after, limit) => (repositories ? repositories.channel.after(after, limit) : []),
        // One colleague's persisted activity history, mapped to the renderer's row. The
        // stored rows are the durable accomplishments; live is false because a reload
        // is the reopen case, where only the persisted history remains.
        activityByHire: (hireId, limit) => (repositories
            ? repositories.activity.byHire(hireId, limit).map((r): ActivityRow => ({
                id: r.id, hireId: r.hireId, tool: r.tool, target: r.target, status: r.status, at: r.at, live: false
            }))
            : []),
        // The saved-work notice: the most recent committed drain, and the dismissal.
        savedCheckpoints: () => savedCheckpoints(),
        ackCheckpoints: (drainId) => ackCheckpoints(drainId),
        // A reply records a message from the person in the timeline, then delivers
        // it to the colleague through the lifecycle, the same submitMessage path a
        // first message and the 3b input use. No second session path: the lifecycle
        // spawns, resumes, or writes to a live session, and a fresh start after a
        // dead session surfaces the existing context-lost note.
        channelReply: async (hireId, text) => {
            if (repositories) {
                const hire = repositories.hires.get(hireId);
                repositories.channel.append({
                    id: randomUUID(), projectId: hire?.activeProjectId ?? '', senderId: CHANNEL_SELF_SENDER,
                    kind: 'message', body: text, reference: null, at: new Date().toISOString()
                });
                notifyChannelChanged();
            }
            await (lifecycle ? lifecycle.submitMessage(hireId, text) : Promise.resolve());
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
