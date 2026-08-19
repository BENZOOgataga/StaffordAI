/**
 * Registers Stafford's hooks in a managed project's own settings.
 *
 * Per project, in `.claude/settings.local.json`, never global and never in the
 * committed `settings.json`. Global registration fires in every Claude Code
 * session on the machine, and the per-tool events alone cost roughly 180ms on
 * every tool call. A session outside a managed project now pays nothing.
 *
 * **The sweep owns the command string.** This is the decision about the stale
 * path problem, taken deliberately rather than by accident.
 *
 * The registered command points at the forwarder, which is a Node script today
 * and a Go binary later, so the path in every managed project changes when that
 * lands. The alternative was a stable indirection file that the real forwarder
 * sits behind, which only moves the problem: the indirection is one more thing
 * that can be stale, and it would have to be repaired by the same mechanism
 * anyway.
 *
 * So entries are identified by a marker rather than by their path, and the
 * launch sweep rewrites any entry whose marker matches but whose command
 * differs. A path change is then self-correcting at next launch, for the Go
 * migration and for every future one, with no migration step to remember.
 *
 * Accepted and named: a Claude Code session already running when the path
 * changes keeps the old command until it restarts. Its hooks fail silently, by
 * the forwarder's own design, so its card goes stale rather than erroring.
 *
 * Pure. Every function here takes text or objects and returns text or objects.
 * The caller does the reading and writing, which is what makes all of this
 * testable without a filesystem.
 */

/** Identifies our entries. Never matched on the path, which is the whole point. */
export const HOOK_MARKER = '--stafford-hook';

/**
 * Six events. `PreToolUse` and `PostToolUse` are deliberately absent and this
 * is the first registration since the global set was removed, which is exactly
 * when they could quietly return.
 */
export const REGISTERED_EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'Notification',
    'Stop',
    'SubagentStop',
    'SessionEnd'
] as const;

interface HookCommand {
    readonly type: 'command';
    readonly command: string;
    /**
     * The interpreter Claude Code runs this command through. Pinned because the
     * default is Git Bash when it is present, which cannot parse the PowerShell
     * command built for Windows and fails with a bash syntax error. Only set when a
     * shell is chosen; a diagnostic caller that leaves it off keeps the default.
     */
    readonly shell?: ClaudeShell;
}

/** The two values Claude Code's hook `shell` field accepts. */
export type ClaudeShell = 'bash' | 'powershell';

/** Maps Stafford's platform shell to the value Claude Code's hook `shell` field takes. */
export function claudeShellFor(shell: HookShell): ClaudeShell {
    return shell === 'powershell' ? 'powershell' : 'bash';
}

interface HookGroup {
    readonly hooks: HookCommand[];
}

export type HookSettings = Record<string, HookGroup[]>;

export interface Settings {
    hooks?: HookSettings;
    [key: string]: unknown;
}

export function isStaffordCommand(command: unknown): boolean {
    return typeof command === 'string' && command.includes(HOOK_MARKER);
}

/** Which shell Claude Code runs a command hook through, per platform. */
export type HookShell = 'powershell' | 'posix';

/** Claude Code runs hooks through PowerShell on Windows and a POSIX shell elsewhere. */
export function hookShellFor(platformId: string): HookShell {
    return platformId === 'win32' ? 'powershell' : 'posix';
}

/**
 * The hook command, quoted for the shell Claude Code runs it through and carrying
 * the runtime that needs no global Node.
 *
 * `ELECTRON_RUN_AS_NODE=1` lets the packaged Electron binary run the forwarder as
 * Node, so a user with no global `node` still gets working hooks (the forwarder is
 * pure Node and never needs bash). On Windows Claude Code runs the command through
 * PowerShell, where a quoted executable path must be invoked with the call
 * operator `&` and a bare `"exe" "arg"` is a parse error; on POSIX it runs through
 * a shell where the env-prefix form and a quoted path both work. Getting this
 * wrong is the failure a real Windows session showed: the hook ran under
 * PowerShell and could not launch.
 */
export function buildCommand(runtime: string, forwarder: string, shell: HookShell): string {
    const invocation = '"' + runtime + '" "' + forwarder + '" ' + HOOK_MARKER;
    return shell === 'powershell'
        ? '$env:ELECTRON_RUN_AS_NODE=1; & ' + invocation
        : 'ELECTRON_RUN_AS_NODE=1 ' + invocation;
}

export function desiredHooks(command: string, shell?: ClaudeShell): HookSettings {
    const entry: HookCommand = shell ? { type: 'command', command, shell } : { type: 'command', command };
    const hooks: HookSettings = {};
    for (const event of REGISTERED_EVENTS) {
        hooks[event] = [{ hooks: [entry] }];
    }
    return hooks;
}

/**
 * Merges our entries into whatever is already there.
 *
 * Only the `hooks` key is touched, other people's hooks survive, and the result
 * is idempotent: registering twice cannot produce two entries, because ours are
 * removed by marker before the new ones go in.
 */
export function merge(existing: Settings, command: string, shell?: ClaudeShell): Settings {
    const next: Settings = { ...existing };
    const hooks: HookSettings = {};

    for (const [event, groups] of Object.entries(existing.hooks ?? {})) {
        const kept = groups
            .map((group) => ({ hooks: (group.hooks ?? []).filter((h) => !isStaffordCommand(h.command)) }))
            .filter((group) => group.hooks.length > 0);
        if (kept.length > 0) hooks[event] = kept;
    }

    for (const [event, groups] of Object.entries(desiredHooks(command, shell))) {
        hooks[event] = [...(hooks[event] ?? []), ...groups];
    }

    next.hooks = hooks;
    return next;
}

/** Removes only our entries, leaving everything else including other hooks. */
export function unregister(existing: Settings): Settings {
    const next: Settings = { ...existing };
    const hooks: HookSettings = {};

    for (const [event, groups] of Object.entries(existing.hooks ?? {})) {
        const kept = groups
            .map((group) => ({ hooks: (group.hooks ?? []).filter((h) => !isStaffordCommand(h.command)) }))
            .filter((group) => group.hooks.length > 0);
        if (kept.length > 0) hooks[event] = kept;
    }

    if (Object.keys(hooks).length > 0) next.hooks = hooks;
    else delete next.hooks;
    return next;
}

export interface SweepFinding {
    readonly ok: boolean;
    readonly reason: 'correct' | 'missing' | 'stale-path' | 'wrong-events';
    readonly detail: string;
}

/**
 * What the launch sweep checks about a project's registration.
 *
 * Stale path is the case this exists for: the marker matches and the command
 * does not, which is what a forwarder move looks like from here.
 */
export function inspect(existing: Settings, command: string): SweepFinding {
    const hooks = existing.hooks ?? {};
    const ours: string[] = [];
    const events = new Set<string>();

    for (const [event, groups] of Object.entries(hooks)) {
        for (const group of groups) {
            for (const hook of group.hooks ?? []) {
                if (!isStaffordCommand(hook.command)) continue;
                ours.push(hook.command);
                events.add(event);
            }
        }
    }

    if (ours.length === 0) {
        return { ok: false, reason: 'missing', detail: 'no Stafford hooks registered' };
    }
    if (ours.some((c) => c !== command)) {
        return {
            ok: false,
            reason: 'stale-path',
            detail: 'registered command does not match the current forwarder, so every hook in this project is failing silently'
        };
    }
    const expected = new Set<string>(REGISTERED_EVENTS);
    if (events.size !== expected.size || [...expected].some((e) => !events.has(e))) {
        return {
            ok: false,
            reason: 'wrong-events',
            detail: 'registered for ' + [...events].sort().join(', ') + ' rather than the six'
        };
    }
    return { ok: true, reason: 'correct', detail: 'registered for all six events at the current path' };
}

/**
 * The exclude entry, in `.git/info/exclude` rather than `.gitignore`.
 *
 * `info/exclude` is local to the clone and is not a tracked file, so Stafford
 * never causes a diff or an untracked file in someone else's repository. The
 * gap that creates, and the reason the sweep checks it: `info/exclude` is not
 * versioned, so a fresh clone of a managed project has none, the settings file
 * shows up untracked, and an agent running `git status` before committing can
 * commit Stafford's configuration into a client repo.
 */
export const EXCLUDE_ENTRY = '.claude/settings.local.json';

export function hasExcludeEntry(content: string): boolean {
    return content.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_ENTRY);
}

export function addExcludeEntry(content: string): string {
    if (hasExcludeEntry(content)) return content;
    const padded = content.length === 0 || content.endsWith('\n') ? content : content + '\n';
    return padded + '# Stafford, local to this clone and never committed\n' + EXCLUDE_ENTRY + '\n';
}
