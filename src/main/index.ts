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
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { currentPlatform } from './platform/index.ts';
import { WEB_PREFERENCES, applySessionSecurity, applyWindowSecurity } from './window/security.ts';
import { applyAppMenu, hideMenuBar } from './window/app-menu.ts';
import { registerWindowControls, wireMaximizeEvents } from './window/window-controls.ts';
import { resolveWindowBounds, readWindowState, saveWindowState, WINDOW_DEFAULTS, type Rect } from './window/window-state.ts';
import { installTray } from './tray.ts';
import { configureLoginItem } from './login-item.ts';
import { registerHandlers } from './ipc/handlers.ts';
import { openDatabase, type OpenResult } from './storage/database.ts';
import { resolveStoreBase } from './storage/store-location.ts';
import { resolveAppId } from './app-id.ts';
import { createProject as createProjectService, createHire as createHireService, type CreateDeps } from './create/create-flow.ts';
import { seedManagedConfig, type ManagedFs } from './agents/managed-config.ts';
import { createRepositories, type Repositories } from './storage/repository.ts';
import { runDrain, type DrainableAgent, type CheckpointResult } from './agents/drain.ts';
import { checkpointRepo } from './agents/checkpoint-executor.ts';
import { realCheckpointDeps } from './agents/checkpoint-git.ts';
import { killTree } from './agents/kill-tree.ts';
import { hireStoreOver, type HireStore } from './storage/hire-store.ts';
import { assembleRoster } from './roster/snapshot.ts';
import { ClaudeRunnerManager } from './agents/runner-manager.ts';
import { makePermissionGate, type PermissionGate } from './agents/permission-gate.ts';
import { effectivePolicy, ruleKey, widensProtectedAccess } from '../domain/effective-policy.ts';
import { defaultBaselineRules, defaultCategoryDefaults } from '../domain/permission-profile.ts';
import type { PermissionRule, PermissionAction, PermissionEffect } from '../domain/permissions.ts';
import type { PermissionRuleRecord } from '../domain/models.ts';
import { ApprovalRegistry } from './agents/approval-registry.ts';
import { locateClaude } from './agents/claude-locator.ts';
import { savedNoticeFor } from './checkpoints/saved-work.ts';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
    RosterSnapshot, ActivityRow, SavedCheckpoints,
    PermissionRuleView, PermissionRulesReply, PermissionEffectiveReply, PermissionWriteReply,
    PermissionAdd, PermissionUpdate
} from '../shared/ipc.ts';
import { CHANNEL_SELF_SENDER } from '../shared/ipc.ts';

const dir = path.dirname(fileURLToPath(import.meta.url));
const STARTED_AT = new Date().toISOString();
// The runtime app id, `Stafford` by default. STAFFORD_APP_ID overrides it for an
// isolated verification run, scoping the hook pipe and the data dir together so
// the run coexists with a running Stafford instead of colliding on its endpoints.
const { appId: APP_ID } = resolveAppId(process.env);

let store: OpenResult | null = null;
let repositories: Repositories | null = null;
// The pending permission approvals (phase 2). Created once the store is open, so a paused
// tool call can set the colleague's waiting state; denyAll runs on quit.
let approvalRegistry: ApprovalRegistry | null = null;
// The headless delivery path (the stream-json runner). It is the only path that
// handles messages now; the old pty/hook/lifecycle stack was removed in phase 4.
let runnerManager: ClaudeRunnerManager | null = null;
// The permission gate, held at module scope so a rule edit can drop its cache. It is built in
// buildDelivery once the store is open.
let permissionGate: PermissionGate | null = null;

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

/**
 * Whether this process presents as an ordinary application right now.
 *
 * **On macOS this is what decides z-order, and getting it wrong is why the window sat on top
 * of everything.** `app.dock.hide()` puts the process into the accessory activation policy,
 * which is correct for a tray app with no window: no Dock tile, no application switcher
 * entry. It is wrong the moment a real window is on screen, because an accessory process
 * never becomes the active application, so it never properly resigns when I click another
 * app, and its window keeps painting over whatever I just focused.
 *
 * There is no always-on-top flag anywhere in this file. The pin was a side effect of the
 * activation policy, which is also why the application menu never installed on macOS: one
 * call, two symptoms.
 *
 * So the policy follows the window rather than the process. Ordinary while a window is up,
 * accessory again once the last one is gone, which keeps the tray-resident shape intact.
 * `app.dock` exists only where there is a Dock, so this stays a capability check rather than
 * a platform name and the platform-leak guard is satisfied.
 */
function presentAsOrdinaryApp(ordinary: boolean): void {
    if (!app.dock) return;
    if (ordinary) void app.dock.show();
    else app.dock.hide();
}

function openWindow(): void {
    // Ordinary first, then show. Raising a window while the process is still an accessory is
    // what produced a window that came forward and then refused to go behind anything.
    presentAsOrdinaryApp(true);

    if (window && !window.isDestroyed()) {
        window.show();
        window.focus();
        return;
    }

    const { bounds, min } = resolveOpenBounds();
    // Frameless on Windows and Linux, where the custom title bar draws its own controls;
    // native frame on macOS, where the traffic lights and system bar are the convention.
    // Keyed on the app.dock capability (macOS-only), not a platform name, so the
    // platform-leak guard stays satisfied.
    const isMac = Boolean(app.dock);
    const win = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        minWidth: min.width,
        minHeight: min.height,
        show: false,
        title: 'Stafford',
        frame: isMac,
        // No visible menu bar on Windows and Linux; the application menu is still set so
        // its accelerators stay live. hideMenuBar reinforces this after the window exists.
        autoHideMenuBar: true,
        webPreferences: {
            ...WEB_PREFERENCES,
            // .cjs: a sandboxed preload is CommonJS. See electron.vite.config.ts.
            preload: path.join(dir, '../preload/index.cjs'),
            // Tell the sandboxed preload whether this window is frameless, so the renderer
            // mounts the custom title bar only where the OS frame was removed. Passed as a
            // launch argument rather than over IPC so it is available synchronously at load.
            additionalArguments: isMac ? [] : ['--stafford-frameless']
        }
    });

    const entry = rendererEntry();
    applyWindowSecurity(win, entry);
    // Hide the menu bar on Windows and Linux (macOS keeps its system bar). The menu is
    // set once at startup, so the clipboard, quit, and close accelerators still work.
    hideMenuBar(win, isMac);
    // Reflect the maximized state to the custom title bar so its maximize/restore button
    // tracks the real window, including a change from an OS gesture.
    wireMaximizeEvents(win);
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

    // Closing returns to the tray rather than quitting. Back to accessory as it goes, so a
    // Stafford with no window is a tray icon and nothing else, which is the whole shape.
    win.on('close', (event) => {
        if (quitting) return;
        event.preventDefault();
        win.hide();
        presentAsOrdinaryApp(false);
    });
    win.on('closed', () => {
        if (window === win) window = null;
        presentAsOrdinaryApp(false);
    });

    void win.loadURL(entry);
    window = win;
}

/**
 * The active colleagues the drain checkpoints on quit: whichever the runner served
 * this run. Each carries its in-flight child pid (or null between turns) and a
 * checkpoint that commits its tracked work.
 */
function activeDrainables(): DrainableAgent[] {
    return runnerManager ? runnerManager.drainables() : [];
}

/**
 * The roster as cards, assembled from the persisted hires. Read-only and bounded,
 * one card per hire. State is written by the runner on the hire itself, so a card
 * reads its state straight from the store; the live overlay (elapsed time) and the
 * context-lost flag belonged to the removed pty lifecycle and are null/false now.
 * The task line is null until task dispatch exists; the field is a real seam.
 */
function rosterSnapshot(): RosterSnapshot {
    if (!repositories) return { cards: [] };
    const names = new Map(repositories.projects.all().map((p) => [p.id, p.name]));
    return assembleRoster({
        hires: repositories.hires.all(),
        projectName: (id) => names.get(id) ?? null,
        live: () => null,
        currentTask: () => null,
        contextLost: () => false
    });
}

/** Tells the roster window a card changed, so it re-reads the snapshot. */
function notifyRosterChanged(): void {
    if (window && !window.isDestroyed()) window.webContents.send('roster:changed');
}

/**
 * Tells any open permission config view that the rules changed, and drops the gate's cache so
 * the next turn resolves against what was just written rather than what was loaded at session
 * start. Both halves matter: without the event the screen goes stale, without the invalidate
 * the enforcement does.
 */
function notifyPermissionsChanged(): void {
    permissionGate?.invalidate();
    if (window && !window.isDestroyed()) window.webContents.send('permissions:changed');
}


// --- permission configuration (phase 3) ------------------------------------
//
// The write path for permission rules. It is reachable only from the renderer over ipcMain,
// which is Stafford's own window. A colleague has no part of this: it talks stream-json to
// Claude Code over its own stdin and stdout, it has no preload, no contextBridge and no
// ipcRenderer, so there is no channel for it to call. The other conceivable route, editing
// the database file directly with a tool, is denied by the gate because userData is a
// protected path. So "only I set permissions" is a property of the wiring, not a convention.

/** The paths a colleague must never reach, and the ones an edit gets warned about. */
function protectedConfigPaths(): string[] {
    return [app.getPath('userData')];
}

function ruleToView(r: PermissionRuleRecord): PermissionRuleView {
    return {
        id: r.id, hireId: r.hireId, action: r.action, pathScope: r.pathScope,
        commandPattern: r.commandPattern, effect: r.effect, createdAt: r.createdAt
    };
}

function permissionRulesFor(projectId: string): PermissionRulesReply {
    const all = repositories?.permissionRules.forProject(projectId) ?? [];
    return {
        baseline: all.filter((r) => r.hireId === null).map(ruleToView),
        overrides: all.filter((r) => r.hireId !== null).map(ruleToView)
    };
}

/**
 * A colleague's resolved policy, built from the same pieces the gate uses: the generated
 * default profile plus the stored baseline, with the colleague's overrides layered on.
 *
 * The scopes are shown as stored rather than resolved to real absolute paths. The gate
 * resolves them against the project root, the filesystem and the platform's case rule at the
 * moment it decides; reproducing that here would either duplicate the pipeline or show
 * Benzoo a lowercased, symlink-resolved string he never typed. The attribution is the point
 * of this view, and it is exact.
 */
function effectivePolicyFor(projectId: string, hireId: string): PermissionEffectiveReply {
    if (!repositories) return { rules: [] };
    const project = repositories.projects.get(projectId);
    const repoRoot = project?.repos[0]?.path ?? '';
    const stored = repositories.permissionRules.forProject(projectId);

    const profile = defaultBaselineRules({
        repoRoot,
        writePaths: project?.policy.writePaths ?? null,
        protectedPaths: protectedConfigPaths()
    });
    const profileKeys = new Set(profile.map(ruleKey));
    const toRule = (r: PermissionRuleRecord): PermissionRule => ({
        action: r.action, pathScope: r.pathScope, commandPattern: r.commandPattern, effect: r.effect
    });

    const rows = effectivePolicy({
        baseline: [...profile, ...stored.filter((r) => r.hireId === null).map(toRule)],
        overrides: stored.filter((r) => r.hireId === hireId).map(toRule),
        profileKeys,
        defaults: defaultCategoryDefaults(project?.policy.allowWebFetch ?? false)
    });

    return { rules: rows };
}

/**
 * The warning shown when an edit weakens protection of the user-only config.
 *
 * Advisory on purpose. It is Benzoo's machine and he may insist; what he should not be able
 * to do is widen access to the permission store, the database or the managed credential by a
 * careless click. Returning it rather than throwing keeps the decision his.
 */
function widenWarning(rule: { action: PermissionAction; pathScope: string | null; effect: PermissionEffect }): string | null {
    if (!widensProtectedAccess(rule, protectedConfigPaths())) return null;
    return 'This rule widens access toward Stafford\'s own configuration directory, which holds the ' +
        'permission rules, the database and the managed credential. A colleague that can read it can ' +
        'read its own policy; one that can write it can change what it is allowed to do.';
}

function addPermissionRule(payload: PermissionAdd): PermissionWriteReply {
    if (!repositories) return { ok: false, warning: null };
    repositories.permissionRules.insert({
        id: randomUUID(),
        projectId: payload.projectId,
        hireId: payload.hireId,
        action: payload.action,
        pathScope: payload.pathScope,
        // Not authorable in this phase. The destructive shell patterns come from the default
        // profile and are shown read-only, so a malformed regex cannot be introduced here and
        // then silently stop matching.
        commandPattern: null,
        effect: payload.effect,
        createdAt: new Date().toISOString(),
        createdBy: 'owner'
    });
    notifyPermissionsChanged();
    return { ok: true, warning: widenWarning(payload) };
}

function updatePermissionRule(payload: PermissionUpdate): PermissionWriteReply {
    if (!repositories) return { ok: false, warning: null };
    const existing = repositories.permissionRules.get(payload.id);
    if (!existing) return { ok: false, warning: null };
    const ok = repositories.permissionRules.update(payload.id, {
        action: payload.action,
        pathScope: payload.pathScope,
        commandPattern: existing.commandPattern,
        effect: payload.effect
    });
    if (ok) notifyPermissionsChanged();
    return { ok, warning: ok ? widenWarning(payload) : null };
}

function removePermissionRule(id: string): PermissionWriteReply {
    if (!repositories) return { ok: false, warning: null };
    const existing = repositories.permissionRules.get(id);
    if (!existing) return { ok: false, warning: null };
    const ok = repositories.permissionRules.deleteById(id);
    if (ok) notifyPermissionsChanged();
    // Removing a rule that was DENYING a protected path is the dangerous direction, which is
    // the mirror of the add case: the warning fires on what the removal leaves behind.
    const warning = ok && existing.effect === 'deny' && widensProtectedAccess(
        { action: existing.action, pathScope: existing.pathScope, effect: 'allow' }, protectedConfigPaths()
    )
        ? 'That rule was denying access to Stafford\'s own configuration directory. Removing it ' +
          'leaves the protection to the default profile alone.'
        : null;
    return { ok, warning };
}

/** Tells the channel view a row landed, so it fetches the tail, not the whole timeline. */
function notifyChannelChanged(): void {
    if (window && !window.isDestroyed()) window.webContents.send('channel:changed');
}


/**
 * Builds the headless delivery path: the ClaudeRunnerManager, the only thing that
 * runs Claude sessions now. If no Claude binary is located, the shell runs without
 * it and a submit would surface the error.
 */
function buildDelivery(store: HireStore): void {
    if (!repositories) return;
    const platform = currentPlatform();
    const home = os.homedir();

    let claudePath: string;
    try {
        claudePath = locateClaude({
            platform, home, pathValue: process.env.PATH ?? '', exists: (c) => fs.existsSync(c)
        }).path;
    } catch (error) {
        smoke('delivery unavailable, no Claude binary located: ' +
            (error instanceof Error ? error.message : String(error)));
        return;
    }

    // Stafford's own Claude config dir, under userData and so outside every project
    // repo: the checkpoint executor only commits tracked files inside the project
    // cwd, so nothing here can ever enter a checkpoint. Pointing CLAUDE_CONFIG_DIR at
    // it relocates Claude's config off the user's ~/.claude, which is what keeps the
    // user's global plugins and foreign hooks out of a colleague session.
    const managedConfigDir = path.join(app.getPath('userData'), 'claude-config');

    /**
     * The Claude Code credential out of this platform's OS store, or null where there is no
     * store to read (Windows and Linux, where it is a file the seed copies instead).
     *
     * This is the one place a live token is handled. It goes from the store straight into the
     * seed, which writes it to a 0600 file. It is never logged, never returned over IPC, and
     * never attached to an error: the catch below deliberately discards the reason, because a
     * `security` failure message is exactly the kind of string that ends up in a log with the
     * secret still in it.
     */
    const readOsCredential = (): string | null => {
        const spec = currentPlatform().osCredentialCommand(os.userInfo().username);
        if (spec === null) return null;
        try {
            const out = execFileSync(spec.file, [...spec.args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            const trimmed = out.trim();
            return trimmed === '' ? null : trimmed;
        } catch {
            // Not present, locked, or denied. All three mean the same thing here, and the
            // seed already warns that the session will not be authenticated.
            return null;
        }
    };

    // The key Claude matches a cwd to: real case, forward slashes. Shared by the seed
    // so the trust key it writes matches the cwd Claude resolves.
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

    // The permission gate: every tool call a colleague makes is resolved against the
    // project's rules and the colleague's overrides at can_use_tool, allow or deny in
    // phase 1 (an ask resolves as deny for now). The protected path is Stafford's own
    // user-data directory, which holds the permission store, the database, and the managed
    // credential, so a colleague can never read or write its own permission config.
    permissionGate = makePermissionGate({
        getPolicy: (projectId) => repositories?.projects.get(projectId)?.policy ?? null,
        getStoredRules: (projectId) => repositories?.permissionRules.forProject(projectId) ?? [],
        protectedPaths: [app.getPath('userData')],
        // This platform's case rule for path comparison. Without it the deny rules above
        // are case sensitive while macOS and Windows filesystems are not, so a colleague
        // reaches the protected directory by varying the case of its path.
        normalisePath: (value) => currentPlatform().normalisePath(value),
        // An ask pauses the turn on a pending approval until the person answers; without a
        // registry (should not happen once the store is open) it falls back to deny.
        onAsk: (request) => approvalRegistry
            ? approvalRegistry.ask(request)
            : Promise.resolve({ approve: false, note: null })
    });

    // The headless delivery path. It routes a colleague's messages through the
    // stream-json ClaudeRunner: no pty, no typing, no readiness wait, no retry. It
    // seeds the managed config and passes CLAUDE_CONFIG_DIR for #61 isolation, resolves
    // the cwd and resume id, persists the session id in the hires.sessions slot, and
    // records Claude's replies into the #62 conversation so both sides are visible.
    runnerManager = new ClaudeRunnerManager({
        claudePath,
        claudeConfigDir: managedConfigDir,
        parentEnv: process.env,
        // The permission policy, bound per turn to the hire, cwd, and project.
        makeCanUseTool: permissionGate,
        // Each turn's child gets its own process group on POSIX, so the tree reap below
        // reaps that child's subtree and not Stafford's. False on Windows, where taskkill /T
        // needs no group and detaching would give the child a console window.
        detached: currentPlatform().managedChildSpawnOptions().detached,
        // The same resolution the pty path used: cwd, project, and the resume id.
        resolveTarget: (hireId) => {
            const hire = repositories?.hires.get(hireId);
            if (!hire || !hire.activeProjectId) return null;
            const project = repositories?.projects.get(hire.activeProjectId);
            const cwd = project?.repos[0]?.path;
            if (!cwd) return null;
            return {
                cwd, projectId: hire.activeProjectId,
                resumeSessionId: hire.sessions[hire.activeProjectId] ?? null
            };
        },
        // #61 isolation, unchanged: seed the managed dir before every turn. Settings are
        // hook-free now: the runner derives state from the stream, so no Stafford hooks
        // are registered into the managed config any more (the hook stack was removed).
        seedManagedConfig: (cwd) => {
            const result = seedManagedConfig(
                { fs: managedFs, managedDir: managedConfigDir, realHome: home, resolveKey: resolveTrustKey,
                    settings: {},
                    readOsCredential: readOsCredential,
                    warn: (m) => process.stderr.write('[managed-config] ' + m + '\n') },
                cwd
            );
            smoke('managed config seeded (runner), credential carried: ' + result.credentialCopied +
                ', from OS store: ' + result.credentialFromOsStore);
        },
        // Reap a finished turn's whole process tree from its own child pid down, so a
        // tool grandchild in its own group is not orphaned. killTree walks only that pid;
        // it never kills by image name, so the host's own Claude session is untouched.
        reapChild: (pid) => { void killTree(currentPlatform(), pid); },
        // The session id persists in the same place the pty path stored it.
        bindSession: (hireId, projectId, sessionId) => store.bindSession(hireId, projectId, sessionId),
        setState: (hireId, state) => store.setState(hireId, state),
        onStateChanged: () => notifyRosterChanged(),
        // Claude's reply, recorded into the colleague's own conversation thread: a
        // message whose sender is the hire and whose target is null, the shape the
        // Conversation renders as the colleague rather than as "You".
        recordReply: (hireId, projectId, text) => {
            if (!repositories) return;
            repositories.channel.append({
                id: randomUUID(), projectId, senderId: hireId, targetHireId: null,
                kind: 'message', body: text, reference: null, at: new Date().toISOString()
            });
            notifyChannelChanged();
        },
        // Each tool the colleague used this turn, into the append-only activity store.
        // The Transcript view and the Activity feed both read it back per hire. This
        // re-feeds the activity feed the removed hooks used to, now from the runner.
        recordToolUse: (hireId, sessionId, tool, target, status) => {
            if (!repositories) return;
            repositories.activity.append({
                id: randomUUID(), hireId, sessionId, tool, target, status, at: new Date().toISOString()
            });
            // The open detail refreshes on this signal and its Transcript re-reads.
            notifyChannelChanged();
        },
        // The same bounded git checkpoint executor the registry drain uses, so a
        // colleague's tracked work is committed on quit through the runner path too.
        checkpointRunner: (cwd, hireId) =>
            checkpointRepo(realCheckpointDeps(currentPlatform()), {
                cwd, hireId, stamp: new Date().toISOString()
            }).then((o): CheckpointResult => ({
                committed: o.committed, branch: o.branch, commitId: o.commitId,
                reason: o.committed ? null : (o.reason === 'error' && o.detail ? 'error: ' + o.detail : o.reason)
            })),
        // The raw wire, env-gated, since the migration keeps no debug view: with
        // STAFFORD_DELIVERY_LOG set, every stream-json line in both directions is
        // appended to a temp log. Hire ids and event lines only; it never adds message
        // text beyond what the wire already carries, which is inspection, not a leak.
        ...(process.env.STAFFORD_DELIVERY_LOG
            ? { traceWire: (hireId: string, line: string, direction: string) => {
                try {
                    fs.appendFileSync(path.join(os.tmpdir(), 'stafford-delivery.log'),
                        new Date().toISOString() + ' ' + hireId + ' ' + (direction === 'out' ? '>>' : '<<') + ' ' + line + '\n');
                } catch { /* logging must never break delivery */ }
            } }
            : {})
    });
    smoke('runner manager ready (headless delivery path)');
}

let quitting = false;
async function quit(): Promise<void> {
    quitting = true;

    // Resolve any turn paused on a permission ask as deny, so a turn never resumes an
    // action I did not approve and nothing is left awaiting a promise that would block the
    // quit or the drain below.
    approvalRegistry?.denyAll('Stafford is closing, so this action was not approved.');

    // Drain the colleagues the runner served: checkpoint, bounded wait, force-kill what
    // remains, one durable report row per agent. Bounded by its own total cap, so a stuck
    // agent cannot hold the quit. A drain failure must not block the quit either, so it is
    // caught and the quit proceeds.
    if (repositories) {
        try {
            await runDrain({
                agents: activeDrainables(),
                platform: currentPlatform(),
                sink: repositories.drainReports,
                drainId: 'drain-' + new Date().toISOString(),
                now: () => new Date().toISOString(),
                // Force-kill reaps a timed-out turn: the runner manager disposes its
                // in-flight child through a tree reap by exact pid, never by image name.
                ...(runnerManager ? {
                    forceKill: (agent) => { runnerManager?.dispose(agent.agentId); return Promise.resolve(); }
                } : {})
            });
        } catch (error) {
            process.stderr.write('[warn] drain did not complete cleanly: ' +
                (error instanceof Error ? error.message : String(error)) + '\n');
        }
    }

    // Force the exit as a backstop. Everything that matters is already checkpointed
    // and its process tree reaped by the time the drain returns, so a 3s timer turning
    // quit into a hard app.exit(0) only drops handles the OS reclaims anyway. The timer
    // is unref'd so it never itself keeps the app alive.
    const forced = setTimeout(() => { app.exit(0); }, 3000);
    forced.unref();
    app.quit();
}

/**
 * Drives the phase-3 delivery proof inside the running app against real Claude. Gated
 * by STAFFORD_DELIVERY_SMOKE=1; the project cwd comes from STAFFORD_DELIVERY_SMOKE_CWD
 * (a git repo). It calls the real runnerManager.submit path, the same one the IPC uses,
 * and reports each colleague's conversation and state so the rc.1 bugs can be seen gone.
 */
async function runDeliverySmoke(): Promise<void> {
    const out = (line: string): void => { process.stderr.write('[delivery-smoke] ' + line + '\n'); };
    const cwd = process.env.STAFFORD_DELIVERY_SMOKE_CWD;
    if (!repositories || !runnerManager || !cwd) { out('missing repositories, runner, or cwd'); return; }
    const started = new Date().toISOString();
    const projectId = 'dsmoke-' + started;
    repositories.projects.insert({
        id: projectId, name: 'delivery-smoke', repos: [{ path: cwd, label: 'repo' }],
        policy: {
            push: 'none' as const, allowedRoles: [], toolCeiling: null, writePaths: null,
            requirePipeline: false, allowWebFetch: false, permissionMode: 'default', maxConcurrentAgents: 2
        }
    });
    const A = 'dsmoke-A-' + started;
    const B = 'dsmoke-B-' + started;
    for (const [id, name] of [[A, 'Ada'], [B, 'Boris']] as const) {
        repositories.hires.insert({
            id, name, type: 'lead-developer', title: 'Lead developer', seniority: 2, ownerId: 'owner',
            sessions: {}, activeProjectId: projectId, state: 'idle', hiredAt: started, firedAt: null
        });
    }

    const say = async (hireId: string, text: string): Promise<void> => {
        repositories!.channel.append({
            id: randomUUID(), projectId, senderId: CHANNEL_SELF_SENDER, targetHireId: hireId,
            kind: 'message', body: text, reference: null, at: new Date().toISOString()
        });
        await runnerManager!.submit(hireId, text);
    };
    const dump = (label: string, hireId: string): void => {
        const rows = repositories!.channel.conversationFor(hireId, 50).filter((r) => r.kind === 'message');
        out(label + ' [' + hireId.slice(-6) + '] state=' + (repositories!.hires.get(hireId)?.state ?? '?') +
            ', rows=' + rows.length);
        for (const r of rows) {
            const who = r.targetHireId ? 'You      ' : 'Colleague';
            out('    ' + who + ': ' + r.body.replace(/\s+/g, ' ').slice(0, 80));
        }
    };

    out('=== Scenario 1: first message to a fresh colleague, no resend ===');
    await say(A, 'Reply with exactly this token and nothing else: FIRST-OK');
    dump('after ONE message', A);

    out('=== Scenario 2: five fast messages to one colleague ===');
    await Promise.all([1, 2, 3, 4, 5].map((n) =>
        say(A, 'Reply with exactly this token and nothing else: FAST-' + n)));
    dump('after FIVE fast', A);

    out('=== Scenario 3: two colleagues concurrent ===');
    await Promise.all([
        say(A, 'Reply with exactly this token and nothing else: A-ONLY'),
        say(B, 'Reply with exactly this token and nothing else: B-ONLY')
    ]);
    dump('colleague A', A);
    dump('colleague B', B);

    out('=== Scenario 4: a tool use and a file write (transcript + drain source) ===');
    await say(A, 'Use your Write tool to create a file named note.txt containing the single word hello, ' +
        'then reply with exactly: WROTE');
    const tools = repositories.activity.byHire(A, 50);
    out('activity rows recorded for A: ' + tools.length);
    for (const t of tools) out('    tool ' + t.tool + (t.target ? ' ' + t.target.slice(0, 60) : '') + ' [' + t.status + ']');

    out('A resume session id: ' + (repositories.hires.get(A)?.sessions[projectId] ?? 'none'));
    out('B resume session id: ' + (repositories.hires.get(B)?.sessions[projectId] ?? 'none'));
    out('=== delivery smoke done ===');
}

app.whenReady().then(async () => {
    applySessionSecurity(session.defaultSession);

    // Replace Electron's default File/Edit/View/Window menu with a minimal one, so the
    // app does not read as a generic Electron shell. The menu is still set (not cleared),
    // so its accelerators survive; the bar itself is hidden per window on Windows and
    // Linux. DevTools is included only in a dev build (app.isPackaged is false there).
    // isMac keyed on the capability, not the platform name: app.dock exists only where
    // there is a Dock, which is macOS, so this needs no platform branch and the
    // platform-leak guard stays satisfied, the same way app.dock.hide is keyed below.
    applyAppMenu(Boolean(app.dock), !app.isPackaged);

    // The custom title bar's window controls (minimize, maximize/restore, close). Close
    // routes through the window's own close(), which the close handler below hides to the
    // tray, so the frameless title bar keeps the tray-resident behaviour and the drain.
    registerWindowControls(ipcMain, () => window);

    // The store first, before the tray or any handler. If it cannot open, the
    // app has already quit inside openStore and there is nothing more to do.
    if (!openStore()) return;

    // Build the headless delivery path. State, session id, replies, the tool feed, and
    // the drain all flow through the runner now; there is no hook transport, socket, or
    // registry any more. The activity feed is re-fed from the runner's own tool_use
    // events, which is also what the Transcript tab reads.
    if (repositories) {
        const store = hireStoreOver(repositories);
        // The approval registry: a paused ask sets the colleague to waiting_for_you (the
        // roster's existing waiting state) and pushes an approvals:changed signal so the
        // approvals surface re-reads. Answering clears it back to working.
        approvalRegistry = new ApprovalRegistry({
            now: () => new Date().toISOString(),
            uuid: () => randomUUID(),
            onChange: () => { if (window && !window.isDestroyed()) window.webContents.send('approvals:changed'); },
            onPending: (hireId, pending) => {
                store.setState(hireId, pending ? 'waiting_for_you' : 'working');
                notifyRosterChanged();
            }
        });
        buildDelivery(store);
    }

    // Never register the login item during a smoke run. A smoke run launches
    // the packaged app for verification, where app.isPackaged is true and the
    // login item would otherwise register, which is a change to a live system
    // and is not verification's to make.
    if (!SMOKE) configureLoginItem(app);

    registerHandlers(ipcMain, {
        startedAt: STARTED_AT,
        platformId: currentPlatform().id,
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
        permissionRules: (projectId) => permissionRulesFor(projectId),
        effectivePolicy: (projectId, hireId) => effectivePolicyFor(projectId, hireId),
        addPermissionRule: (payload) => addPermissionRule(payload),
        updatePermissionRule: (payload) => updatePermissionRule(payload),
        removePermissionRule: (id) => removePermissionRule(id),
        // The timeline reads: the newest page, older rows for scroll-back, and the
        // tail after a cursor for the append on channel:changed.
        channelPage: (before, limit) => (repositories
            ? (before ? repositories.channel.before(before, limit) : repositories.channel.newest(limit))
            : []),
        channelSince: (after, limit) => (repositories ? repositories.channel.after(after, limit) : []),
        // One colleague's own conversation, keyed by hire id, so the Conversation tab
        // reads only its thread rather than the whole timeline filtered client-side.
        channelConversation: (hireId, limit) => (repositories
            ? repositories.channel.conversationFor(hireId, limit)
            : []),
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
        // A reply records the person's message in the timeline, then delivers it to the
        // colleague through the runner, the same submitMessage path the detail input uses.
        channelReply: async (hireId, text) => {
            if (repositories) {
                const hire = repositories.hires.get(hireId);
                repositories.channel.append({
                    id: randomUUID(), projectId: hire?.activeProjectId ?? '', senderId: CHANNEL_SELF_SENDER,
                    // The person's reply is addressed to this colleague, so its
                    // Conversation is keyed by hire and does not leak into another's.
                    targetHireId: hireId,
                    kind: 'message', body: text, reference: null, at: new Date().toISOString()
                });
                notifyChannelChanged();
            }
            await (runnerManager ? runnerManager.submit(hireId, text) : Promise.resolve());
        },
        // The pending permission approvals, and the person's answer, which resolves the
        // paused seam for exactly that ask so the right turn continues or stops.
        pendingApprovals: () => ({ pending: approvalRegistry ? approvalRegistry.list() : [] }),
        answerApproval: (id, approve, note) => { approvalRegistry?.answer(id, approve, note); }
    });

    smoke('boot ok: tray-resident, no window at launch, platform ' + currentPlatform().id +
        ', windows open now ' + BrowserWindow.getAllWindows().length);

    // The phase-3 delivery proof, driven inside the real running app. STAFFORD_DELIVERY_SMOKE=1
    // with STAFFORD_DELIVERY_SMOKE_CWD pointing at a git repo drives the real headless
    // delivery path (runnerManager.submit -> ClaudeRunner -> real Claude -> conversation
    // store) through the exact scenarios rc.1 got wrong: one first message with no resend,
    // five fast, and two colleagues concurrent. It dumps each colleague's conversation and
    // state to stderr, then quits. No renderer clicks; this exercises the main-process path
    // that the "green tests, broken in the real app" regression always lived in.
    if (process.env.STAFFORD_DELIVERY_SMOKE === '1' && repositories && runnerManager) {
        await runDeliverySmoke();
        void quit();
        return;
    }

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

    // Out of the Dock at boot, because there is no window yet: Stafford starts as a tray
    // icon. openWindow flips this back to an ordinary app while a window is up, so the
    // window takes part in normal activation and yields z-order when I click another app.
    presentAsOrdinaryApp(false);

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
