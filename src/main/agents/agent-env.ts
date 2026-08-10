/**
 * Builds the environment for a spawned agent process.
 *
 * `process.env` is never passed through. A Claude Code started inside a ConPTY
 * does not inherit an interactive shell's environment, so anything the session
 * needs has to be put there deliberately.
 *
 * Two hard rules, enforced here rather than by review:
 *  - Only allowlisted variables are copied from the parent. Whatever else is in
 *    the user's shell stays out of an agent process.
 *  - The hook endpoint secret is never placed in an agent's environment by this
 *    function's callers passing it as `extra`. Per-agent secrets are injected by
 *    the runtime under their own name; anything that looks like a shared token
 *    is refused.
 *
 * Pure. It takes a platform and a located shell and returns an environment. It
 * reads no files and runs no processes, which is what lets the macOS answers be
 * asserted from a Windows machine.
 */

import type { Platform } from '../platform/types.ts';

/** Never allowed into an agent environment, whatever the caller passes. */
export const FORBIDDEN_KEYS: readonly string[] = Object.freeze(['AGENT_DASHBOARD_TOKEN']);

export interface BuildAgentEnvInput {
    readonly agentId: string;
    readonly platform: Platform;
    readonly parentEnv: Readonly<Record<string, string | undefined>>;
    readonly nodeDir: string;
    /** The shell executable already located by the shared resolver, or null. */
    readonly shellExecutable?: string | null;
    readonly hookPort?: number | null;
    /**
     * Path-shaped values only. Every entry is required to be absolute on this
     * platform, so a non-path value such as a secret or a flag does not belong
     * here and will be refused. Named because it was not obvious: the 6c
     * harness passed a hex secret through it and got an absolute path error.
     */
    readonly extra?: Readonly<Record<string, string>>;
    readonly onWarn?: (message: string) => void;
}

/**
 * `PATH` and `STAFFORD_AGENT_ID` are named rather than left to the index
 * signature because this function always sets both. Under
 * `noUncheckedIndexedAccess` a bare record would make every caller check for
 * undefined on values that cannot be undefined, and checks nobody believes are
 * the ones that get deleted later.
 */
export interface AgentEnv {
    readonly env: Record<string, string | undefined> & { PATH: string; STAFFORD_AGENT_ID: string };
    readonly shellExecutable: string | null;
}

/**
 * A hook runs with Claude Code's working directory, not the runner's, so a
 * relative path handed over through the environment resolves somewhere
 * unintended. Found the hard way during Task 0.
 *
 * The question is asked of the platform rather than answered here. This was a
 * regex, and the regex was a Windows rule applied to every platform: it refused
 * a leading separator because on Windows that is drive-relative, which made
 * every absolute POSIX path an error. It survived because its only test used
 * `win32` and Windows paths, so both sides of the check agreed and both were
 * describing Windows. Found by the 6c harness on the first real macOS call,
 * 2026-08-08.
 */
function isRelativePath(platform: Platform, value: string): boolean {
    return !platform.isAbsolutePath(value);
}

export function buildAgentEnv(input: BuildAgentEnvInput): AgentEnv {
    const {
        agentId,
        platform,
        parentEnv,
        nodeDir,
        shellExecutable = null,
        hookPort = null,
        extra = {},
        onWarn = () => {}
    } = input;

    if (!agentId) throw new Error('buildAgentEnv requires an agentId');

    for (const [key, value] of Object.entries(extra)) {
        if (FORBIDDEN_KEYS.includes(key)) {
            throw new Error('Refusing to place ' + key + ' in an agent environment');
        }
        if (isRelativePath(platform, value)) {
            throw new Error('Value for ' + key + ' must be an absolute path: ' + value);
        }
    }

    const env: Record<string, string | undefined> = {};
    for (const key of platform.inheritedEnvKeys()) {
        const value = parentEnv[key];
        if (value !== undefined) env[key] = value;
    }

    const home = env.USERPROFILE ?? env.HOME ?? '';
    const parentPath = parentEnv.PATH ?? '';

    const directories = [...platform.pathDirectories({ home, nodeDir, parentPath })];

    if (shellExecutable) {
        directories.push(...platform.shellPathDirectories(shellExecutable));
    } else {
        // Windows-only in practice: on POSIX a shell is always present, so this
        // branch does not fire there. Without it the status line and at least
        // one plugin hook fail inside every agent session, silently.
        onWarn(
            'No POSIX shell was found. Agent sessions will start, but a bash-based status line ' +
            'or plugin hook will fail inside them.'
        );
    }

    env.PATH = directories.join(platform.pathSeparator);
    env.STAFFORD_AGENT_ID = agentId;
    if (hookPort) env.AGENT_DASHBOARD_PORT = String(hookPort);

    Object.assign(env, extra);

    // Belt and braces: nothing forbidden survives, whatever route it took.
    for (const key of FORBIDDEN_KEYS) delete env[key];

    // Both are set unconditionally above, which is what the return type says.
    return { env: env as AgentEnv['env'], shellExecutable };
}
