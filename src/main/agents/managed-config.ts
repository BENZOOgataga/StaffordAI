/**
 * Seeds Stafford's own Claude Code config directory, so a colleague session runs
 * against a Stafford-controlled environment instead of the user's real `~/.claude`.
 *
 * Why this exists: the user's global `~/.claude/settings.json` carries their
 * personal `enabledPlugins`, `extraKnownMarketplaces`, and `hooks`. Spawned against
 * the real config, every colleague loads those plugins and foreign hooks, which was
 * observed to break the session (foreign hook errors, manual mode, a message that
 * never submits). Pointing `CLAUDE_CONFIG_DIR` at a managed directory relocates the
 * whole config away from `~/.claude`, so the user's plugins are off the read path by
 * construction. This was proven: with `CLAUDE_CONFIG_DIR` set, Claude wrote all of
 * its state (`projects/`, `sessions/`) into the managed dir and none into the real
 * one, and the session came up clean with the user's plugins live.
 *
 * `--safe-mode` / `--bare` were rejected: they disable ALL hooks, including
 * Stafford's own state-reporting SessionStart hook, which the roster depends on.
 *
 * The seed keeps three things true:
 *  - Auth survives. The real credential file is copied in if present, so the
 *    isolated session is logged in with no prompt. Claude then refreshes inside the
 *    managed dir on its own.
 *
 *    **macOS needs a second source, and the original assumption here was wrong.** This
 *    said the credential lived in Keychain "global, not config-dir-scoped", so there was
 *    nothing to copy and the absent file was fine. Measured 2026-08-21: with
 *    CLAUDE_CONFIG_DIR set, Claude Code does not consult the login Keychain at all.
 *    `claude auth status` reports logged in with no variable set, and
 *    `authMethod: "none"` against both a fresh directory and Stafford's managed one. So
 *    every colleague turn on a Mac came back "Not logged in", and the conditional copy
 *    correctly found no file while the session had no credential either way.
 *
 *    A `.credentials.json` inside the config dir is read, confirmed with a dummy token,
 *    so on macOS the seed reads the Keychain item itself and writes that file. The token
 *    therefore lands on disk at 0600 inside a 0700 directory, which is the same exposure
 *    Windows and Linux already have and is a deliberate reduction from Keychain
 *    protection on macOS. It is the price of an isolated session that is also
 *    authenticated. Claude Code namespaces Keychain items per config dir
 *    (`Claude Code-credentials-<8 hex>`), so writing that item instead would keep the
 *    token in Keychain and is the better shape if the derivation is ever documented.
 *  - Pre-trust survives. The project's trust key is written into the managed
 *    `.claude.json`, the same file the isolated session reads, so no trust prompt.
 *  - Plugins do not load. `settings.json` is written minimal, with no plugins, no
 *    marketplaces, and no hooks, and no permission bypass.
 *
 * Two security conditions are enforced here, not by review:
 *  - The managed dir is created 0700 and the copied credential 0600 (POSIX), so the
 *    token is never group- or world-readable. Windows has no POSIX mode; the file
 *    inherits the user-profile ACL under userData and is not broadened.
 *  - Nothing here logs a credential's contents or a full directory listing. The
 *    result object reports booleans and the mode, never the token.
 *
 * The filesystem is injected, so the logic is tested without a real config and the
 * POSIX permission assertions run on any platform the test forces.
 */

/**
 * The claudeMdExcludes globs that blank a colleague's user-scope memory: Benzoo's personal
 * `~/.claude/CLAUDE.md` and everything under `~/.claude/rules/`.
 *
 * Forward slashes only, even on Windows: claudeMdExcludes matches with glob syntax, where a
 * backslash is an escape, so a native Windows path silently matches nothing. The rules pattern
 * is `.../rules/**` so it excludes the files inside the directory, not just the directory entry.
 * Derived from the real home at seed time, so the absolute paths are correct on this machine.
 *
 * Project memory is deliberately not touched: only the user home paths are excluded, so the
 * repo's own CLAUDE.md still loads.
 */
export function userMemoryExcludes(realHome: string): string[] {
    const home = realHome.replace(/\\/g, '/').replace(/\/+$/, '');
    return [home + '/.claude/CLAUDE.md', home + '/.claude/rules/**'];
}

/** Merges the user-memory excludes into the settings written to the managed dir, keeping any existing ones. */
export function withUserMemoryExcludes(
    settings: Record<string, unknown>, realHome: string
): Record<string, unknown> {
    const existing = Array.isArray(settings.claudeMdExcludes) ? (settings.claudeMdExcludes as unknown[]) : [];
    return { ...settings, claudeMdExcludes: [...existing, ...userMemoryExcludes(realHome)] };
}

/** The one directory mode: owner-only (rwx------). */
export const MANAGED_DIR_MODE = 0o700;
/** The one file mode for anything carrying a secret: owner read/write only. */
export const MANAGED_FILE_MODE = 0o600;

/** The injected filesystem seam. The real one is node `fs`; a test supplies its own. */
export interface ManagedFs {
    exists(path: string): boolean;
    /** Reads UTF-8 text; throws if the file is absent. */
    readText(path: string): string;
    writeText(path: string, data: string, mode: number): void;
    mkdirp(path: string, mode: number): void;
    /** Copies bytes from `from` to `to`, then sets `to` to `mode`. Never reads into a log. */
    copyFile(from: string, to: string, mode: number): void;
    chmod(path: string, mode: number): void;
    /** Last-modified time in ms, or null if the path is absent. For the credential freshness check. */
    mtimeMs(path: string): number | null;
    join(...parts: string[]): string;
}

export interface SeedManagedConfigDeps {
    readonly fs: ManagedFs;
    /** Absolute path to the managed config dir, i.e. the value of CLAUDE_CONFIG_DIR. */
    readonly managedDir: string;
    /** The user's real home, from which `~/.claude` and `~/.claude.json` are read. */
    readonly realHome: string;
    /** Turns a cwd into the key Claude matches it to. Shared with pre-trust so the keys agree. */
    readonly resolveKey: (dir: string) => string;
    /**
     * The settings.json to write into the managed dir. Carries Stafford's own hooks,
     * scoped here so a colleague session running against this CLAUDE_CONFIG_DIR gets
     * them while the user's own session, on the real ~/.claude, does not. Never
     * carries plugins or marketplaces. Defaults to an empty object.
     */
    readonly settings?: Record<string, unknown>;
    readonly warn?: (message: string) => void;
    /**
     * Reads the OS credential store, for a platform whose credential is not a file. Returns
     * the credential text, or null when there is nothing there.
     *
     * Only macOS supplies one. It is injected rather than called directly so this module
     * still spawns nothing and stays testable with no Keychain, which is also what keeps a
     * real token out of every test run.
     *
     * The returned string is a live OAuth token. It is written straight to a 0600 file and
     * is never logged, never included in a thrown error, and never part of `SeedResult`.
     */
    readonly readOsCredential?: () => string | null;
}

/** What the seed did, for a one-line log that never carries the token itself. */
export interface SeedResult {
    /** True when a real credential file existed and was copied in (POSIX/Windows). */
    readonly credentialCopied: boolean;
    /**
     * True when the credential came from the OS store instead of a file, which is the macOS
     * path. A boolean, like everything else here, so a log line can say what happened without
     * saying what the credential is.
     */
    readonly credentialFromOsStore: boolean;
    /** The mode the credential file was set to, for the log and the test. */
    readonly credentialMode: number;
    /** The mode the managed dir was set to. */
    readonly dirMode: number;
}

/** The fields lifted from the real `~/.claude.json` so the isolated session is logged in. */
const CARRIED_ACCOUNT_FIELDS = ['oauthAccount', 'userID', 'lastOnboardingVersion'] as const;

/**
 * Seeds the managed dir for one colleague spawn. Idempotent: safe to call before
 * every spawn. Existing project trust in the managed `.claude.json` is preserved, so
 * a second project's spawn does not drop the first's trust.
 */
export function seedManagedConfig(deps: SeedManagedConfigDeps, cwd: string): SeedResult {
    const { fs, managedDir, realHome } = deps;

    // 1. The managed dir, owner-only. mkdirp honours the mode on create; the explicit
    //    chmod covers the already-exists case and any umask narrowing on create.
    fs.mkdirp(managedDir, MANAGED_DIR_MODE);
    fs.chmod(managedDir, MANAGED_DIR_MODE);

    // 2. Auth. Two sources, because the credential is a file on Windows and Linux and lives
    //    in the Keychain on macOS, and an isolated session reads neither unless it is put
    //    where CLAUDE_CONFIG_DIR points.
    const realCredential = fs.join(realHome, '.claude', '.credentials.json');
    const managedCredential = fs.join(managedDir, '.credentials.json');
    let credentialCopied = false;
    let credentialFromOsStore = false;
    if (fs.exists(realCredential)) {
        // Copy only when the managed credential is missing or older than the source. After the
        // first seed in a session the managed copy is present and fresh, so neither the copy nor
        // its owner-only lock (which fails closed on Windows) runs again. That repeat work, and
        // its repeat failure risk on turns after the first, is what this avoids. A first seed, or
        // a source credential that has since refreshed, still copies and locks exactly as before.
        const managedTime = fs.mtimeMs(managedCredential);
        const sourceTime = fs.mtimeMs(realCredential);
        const fresh = managedTime !== null && (sourceTime === null || managedTime >= sourceTime);
        if (!fresh) {
            fs.copyFile(realCredential, managedCredential, MANAGED_FILE_MODE);
            // Belt and braces: force the mode even if copyFile preserved the source's.
            fs.chmod(managedCredential, MANAGED_FILE_MODE);
        }
        credentialCopied = true;
    } else if (deps.readOsCredential) {
        // macOS. Nothing here inspects, parses or logs the value; it is read and written.
        // A failure is deliberately quiet about its cause for the same reason: the message
        // would be the only place a credential could leak from.
        let secret: string | null = null;
        try {
            secret = deps.readOsCredential();
        } catch {
            secret = null;
        }
        if (secret !== null && secret.trim() !== '') {
            fs.writeText(managedCredential, secret, MANAGED_FILE_MODE);
            fs.chmod(managedCredential, MANAGED_FILE_MODE);
            credentialFromOsStore = true;
        } else {
            deps.warn?.(
                'no credential found in the OS store, so this colleague session will not be ' +
                'authenticated and its turns will report "Not logged in"'
            );
        }
    }

    // 3. The managed `.claude.json`: account identity + onboarding done + project
    //    trust, preserving any existing projects. Carries oauthAccount, so 0600.
    const managedConfigPath = fs.join(managedDir, '.claude.json');
    const config = readJsonOr(fs, managedConfigPath, {});

    const real = readJsonOr(fs, fs.join(realHome, '.claude.json'), null);
    if (real) {
        for (const field of CARRIED_ACCOUNT_FIELDS) {
            if (field in real) config[field] = real[field];
        }
    }
    // Onboarding is marked done so a fresh managed dir does not stop at the welcome
    // flow. A bypass permission mode is never written; the plan default (auto) stands.
    config.hasCompletedOnboarding = true;
    // Suppress the first-run official-marketplace fetch, so a colleague spawn does no
    // surprise network install into the managed dir. No plugins are enabled regardless.
    config.officialMarketplaceAutoInstallAttempted = true;

    const projects = isObject(config.projects) ? (config.projects as Record<string, Record<string, unknown>>) : {};
    const key = deps.resolveKey(cwd);
    projects[key] = { ...(isObject(projects[key]) ? projects[key] : {}), hasTrustDialogAccepted: true };
    config.projects = projects;

    fs.writeText(managedConfigPath, JSON.stringify(config), MANAGED_FILE_MODE);

    // 4. Settings: no plugins, no marketplaces, no bypass, and Stafford's own hooks
    //    scoped to this managed dir so only a colleague session reads them. The user's
    //    plugin settings never reach here. Defaults to an empty object.
    //
    //    Plus claudeMdExcludes, which blanks the user-scope memory. Claude Code loads the
    //    user CLAUDE.md from the real home regardless of CLAUDE_CONFIG_DIR, so a colleague
    //    would otherwise inherit Benzoo's personal `~/.claude/CLAUDE.md` (and rules), which
    //    tell it to load a skill it cannot reach. Excluding the whole user memory here means
    //    a colleague starts with a blank user slate; project memory (the repo's own CLAUDE.md)
    //    is untouched and still loads.
    const settings = withUserMemoryExcludes(deps.settings ?? {}, realHome);
    fs.writeText(fs.join(managedDir, 'settings.json'), JSON.stringify(settings), MANAGED_FILE_MODE);

    return {
        credentialCopied,
        credentialFromOsStore,
        credentialMode: MANAGED_FILE_MODE,
        dirMode: MANAGED_DIR_MODE
    };
}

function readJsonOr(fs: ManagedFs, path: string, fallback: null): Record<string, unknown> | null;
function readJsonOr(fs: ManagedFs, path: string, fallback: Record<string, unknown>): Record<string, unknown>;
function readJsonOr(
    fs: ManagedFs, path: string, fallback: Record<string, unknown> | null
): Record<string, unknown> | null {
    if (!fs.exists(path)) return fallback;
    try {
        const parsed = JSON.parse(fs.readText(path)) as unknown;
        return isObject(parsed) ? parsed : fallback;
    } catch {
        // A managed file we cannot parse is treated as absent and rewritten from the
        // known-good base, since it is Stafford's own file, not the user's.
        return fallback;
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
