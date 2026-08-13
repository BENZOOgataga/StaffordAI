/**
 * Pre-trusts one project directory in Claude Code's config, so a cold spawn there
 * does not stop at the startup trust prompt the sanitised message box cannot
 * answer.
 *
 * The mechanism is the exact record a user accepting the prompt would set:
 * `projects["<dir>"].hasTrustDialogAccepted = true` in `~/.claude.json`. It was
 * confirmed against Claude Code 2.1.224: a fresh directory with only that flag
 * set reaches a usable session with no prompt, and the key Claude matches its cwd
 * to is the path with backslashes turned to forward slashes and the case left
 * as-is (the drive letter stays uppercase on Windows).
 *
 * This is directory-trust, scoped to the one directory the user chose at create
 * time, and nothing wider. It is deliberately NOT a permission blanket: it never
 * writes `dangerouslySkipPermissions`, a `permissionMode`, or any skip-all field,
 * because what a colleague may then do is `ProjectPolicy`'s to govern, not this.
 * The user vouched for this directory by pointing Stafford at it, so encoding that
 * one decision here is honest, not a bypass.
 *
 * The filesystem is injected, so the logic is tested without touching a real
 * config, and a malformed config is left untouched rather than overwritten.
 */

export interface PreTrustDeps {
    readonly configPath: string;
    /** Reads the config file; throws if it is absent. */
    readonly readFile: (path: string) => string;
    readonly writeFile: (path: string, data: string) => void;
    /** Turns a cwd into the key Claude matches it to. Injected for tests. */
    readonly resolveKey: (dir: string) => string;
    readonly warn?: (message: string) => void;
}

/** The one field this writes, ever. Named so a test can assert nothing else is set. */
export const TRUST_FIELD = 'hasTrustDialogAccepted';

export function preTrustDirectory(deps: PreTrustDeps, dir: string): void {
    const key = deps.resolveKey(dir);

    let raw: string | null;
    try {
        raw = deps.readFile(deps.configPath);
    } catch {
        // Absent config: start a minimal one rather than fail the spawn.
        raw = null;
    }

    let config: Record<string, unknown>;
    if (raw === null) {
        config = {};
    } else {
        try {
            config = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            // A config we cannot parse is left exactly as it is. Overwriting it
            // would destroy the user's real settings, and the only cost of leaving
            // it is one trust prompt the user answers once. Never clobber.
            deps.warn?.('pre-trust: ' + deps.configPath + ' is not valid JSON, leaving it untouched');
            return;
        }
    }

    const projects: Record<string, Record<string, unknown>> =
        (config.projects && typeof config.projects === 'object')
            ? (config.projects as Record<string, Record<string, unknown>>)
            : {};

    const existing = (projects[key] && typeof projects[key] === 'object') ? projects[key] : {};
    if (existing[TRUST_FIELD] === true) return; // already trusted; no rewrite.

    // Set the one field on the one directory, preserving every other project and
    // every other field on this one.
    projects[key] = { ...existing, [TRUST_FIELD]: true };
    config.projects = projects;
    deps.writeFile(deps.configPath, JSON.stringify(config));
}
