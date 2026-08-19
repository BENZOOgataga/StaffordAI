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
 *    managed dir on its own. On macOS the credential lives in Keychain (global, not
 *    config-dir-scoped), so there is nothing to copy and the file is simply absent;
 *    the copy is conditional on the file existing.
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
}

/** What the seed did, for a one-line log that never carries the token itself. */
export interface SeedResult {
    /** True when a real credential file existed and was copied in (POSIX/Windows). */
    readonly credentialCopied: boolean;
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

    // 2. Auth: copy the real credential in if present. Absent on macOS (Keychain),
    //    where there is nothing to copy and the session authenticates globally.
    const realCredential = fs.join(realHome, '.claude', '.credentials.json');
    const managedCredential = fs.join(managedDir, '.credentials.json');
    let credentialCopied = false;
    if (fs.exists(realCredential)) {
        fs.copyFile(realCredential, managedCredential, MANAGED_FILE_MODE);
        // Belt and braces: force the mode even if copyFile preserved the source's.
        fs.chmod(managedCredential, MANAGED_FILE_MODE);
        credentialCopied = true;
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
    fs.writeText(fs.join(managedDir, 'settings.json'), JSON.stringify(deps.settings ?? {}), MANAGED_FILE_MODE);

    return { credentialCopied, credentialMode: MANAGED_FILE_MODE, dirMode: MANAGED_DIR_MODE };
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
