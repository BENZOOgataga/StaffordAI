/**
 * Windows. The reference implementation, because it is the machine Stafford
 * runs on daily and everything here has been measured on it.
 */

import nodePath from 'node:path';
import type { CommandSpec, InputSocketDisposal, KillSignal, KillTreePlan, PathInputs, Platform, RegistryLookup, ResizeObservation, SelfCheckSpec, SocketPlan } from './types.ts';

// win32 semantics regardless of the machine running this. On a macOS CI runner
// plain path.join would produce forward slashes and the platform layer would
// describe a Windows that does not exist.
const path = nodePath.win32;

/**
 * A Windows process without these misbehaves in ways that are tedious to
 * diagnose. Nothing on this list identifies a secret, and nothing off it
 * reaches an agent.
 */
const INHERITED = Object.freeze([
    'SystemRoot', 'windir', 'COMSPEC', 'PATHEXT', 'OS',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramFiles', 'ProgramFiles(x86)',
    'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'
]);

const GIT_ROOTS = Object.freeze([
    'C:\\Program Files\\Git',
    'C:\\Program Files (x86)\\Git'
]);

export const win32: Platform = {
    id: 'win32',
    supported: true,

    hookSocket(appId: string): SocketPlan {
        return {
            path: '\\\\.\\pipe\\' + appId,
            // The pipe namespace is not the filesystem. Nothing to create and
            // nothing left behind.
            parentDir: null,
            parentMode: null,
            removeStaleFile: false,
            // Measured 2026-08-06, not assumed. The default descriptor on a
            // pipe created through net.createServer grants FILE_GENERIC_READ to
            // Everyone and to ANONYMOUS LOGON. Read only, so another account
            // cannot forge events, but it is not owner-only and that is why
            // per-agent secrets exist. Raw output in the verification log.
            ownerOnly: false,
            accessDetail:
                'named pipe, default descriptor: Everyone and ANONYMOUS LOGON have read. ' +
                'Not owner-only, so per-agent secrets carry authentication.'
        };
    },

    inheritedEnvKeys: () => INHERITED,

    pathDirectories({ home, nodeDir }: PathInputs): readonly string[] {
        // Rebuilt rather than inherited. A ConPTY-spawned Claude Code does not
        // get the interactive shell's environment, so this is the only PATH the
        // agent will have.
        const root = 'C:\\Windows';
        const dirs = [
            path.join(root, 'system32'),
            root,
            path.join(root, 'System32', 'Wbem'),
            path.join(root, 'System32', 'WindowsPowerShell', 'v1.0')
        ];
        if (nodeDir) dirs.push(nodeDir);
        if (home) dirs.push(path.join(home, '.local', 'bin'));
        return dirs;
    },

    posixShellCandidates({ home, parentPath }: PathInputs): readonly string[] {
        // Git Bash is a genuine Windows-only problem: without it the claude-hud
        // status line and at least one plugin hook fail inside every agent
        // session, silently. Found on this machine at a per-user install under
        // AppData, which is why the well-known list is not just Program Files.
        const roots = [...GIT_ROOTS];
        if (home) roots.push(path.join(home, 'AppData', 'Local', 'Programs', 'Git'));

        const candidates = roots.map((root) => path.join(root, 'bin', 'bash.exe'));

        // Last resort: git.exe on the inherited PATH sits in <root>\cmd or
        // <root>\bin, so the root is one level up.
        for (const dir of String(parentPath || '').split(';')) {
            const trimmed = dir.trim();
            if (!trimmed) continue;
            candidates.push(path.join(path.dirname(trimmed), 'bin', 'bash.exe'));
        }

        return candidates;
    },

    shellRegistryLookups: (): readonly RegistryLookup[] => [
        { key: 'HKLM\\SOFTWARE\\GitForWindows', value: 'InstallPath' },
        { key: 'HKCU\\SOFTWARE\\GitForWindows', value: 'InstallPath' }
    ],

    shellPathDirectories(shellExecutable: string): readonly string[] {
        // <root>\bin\bash.exe, so the root is two levels up.
        const root = path.dirname(path.dirname(shellExecutable));
        return [path.join(root, 'cmd'), path.join(root, 'bin'), path.join(root, 'usr', 'bin')];
    },

    executableName: (base: string) => base + '.exe',

    pathSeparator: ';',

    directorySeparator: '\\',

    claudeCandidates(home: string): readonly string[] {
        // Native installer location on this machine, confirmed. PATH is searched
        // by the shared resolver after these.
        return home ? [path.join(home, '.local', 'bin', 'claude.exe')] : [];
    },

    killTreePlan(pid: number): KillTreePlan {
        // Windows is genuinely unaffected by the POSIX finding, and this is a
        // real platform difference rather than a gap. taskkill /T walks parent
        // to child itself, so there is no shared-process-group assumption here
        // to be wrong about, and none of the snapshot procedure applies.
        const whole: CommandSpec = { file: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] };
        return {
            rootPid: pid,
            snapshotBeforeKill: false,
            killsEveryGroup: false,
            wholeTree: whole,
            group: (_pgid: number, _signal: KillSignal): CommandSpec => whole,
            process: (pid2: number, _signal: KillSignal): CommandSpec =>
                ({ file: 'taskkill', args: ['/PID', String(pid2), '/F'] }),
            gap:
                'taskkill /T resolves the tree at the moment it runs, so a process spawned during ' +
                'teardown by something it has already killed is not reached. Narrower than the ' +
                'POSIX window and the same class of problem.',
            detail: 'one command walks parent to child and terminates the whole tree.'
        };
    },

    processTreeCommand(): CommandSpec | null {
        // Null rather than a PowerShell equivalent, because there is nothing
        // here for the answer to check. Windows kills a tree with taskkill /T,
        // which walks parent to child directly and does not depend on a shared
        // process group, so the assumption the POSIX check exists to test does
        // not exist on this platform. Returning a command that produces numbers
        // nobody compares would be worse than saying so.
        return null;
    },

    inputSocketDisposal(): InputSocketDisposal {
        // Measured on 1.1.0, and again on 1.2.0-beta.15 on a Windows runner,
        // where six sessions with no disposal of ours left PipeWrap +6. One per
        // session on both, so the release is required regardless of which of
        // the two versions is pinned.
        return {
            required: true,
            path: ['_agent', 'inSocket'],
            detail:
                'the ConPTY kill path marks both sockets unreadable and disposes the conout worker ' +
                'without destroying the conin socket, while the DLL path a few lines away does destroy it. ' +
                'One handle per session, linear, on a runner meant to stay up for days.'
        };
    },

    ownerOnlyAclPlan(target: string, opts: { tree: boolean; account: string }): CommandSpec {
        // icacls: reset inheritance, then grant only the owner. On a directory the
        // (OI)(CI) flags make future children inherit the owner-only grant, and /T
        // reapplies it to any existing children. /C keeps going past a transient
        // error, /Q stays quiet. node chmod cannot do this on Windows.
        const grant = opts.account + ':' + (opts.tree ? '(OI)(CI)F' : 'F');
        const args = [target, '/inheritance:r', '/grant:r', grant, '/C', '/Q', ...(opts.tree ? ['/T'] : [])];
        return { file: 'icacls', args };
    },

    resizeObservation(cols: number, rows: number): ResizeObservation {
        return {
            mechanism: 'emitted-size-report',
            expect: '[8;' + String(rows) + ';' + String(cols) + 't',
            detail:
                'the ConPTY announces its new size on the master as CSI 8 ; rows ; cols t. ' +
                'The child cannot be asked here: its console width is cached at startup and does ' +
                'not follow a ConPTY resize, so asking it would test the child rather than the resize.'
        };
    },

    normalisePath(value: string): string {
        return String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    },

    isAbsolutePath(value: string): boolean {
        // Three forms, and the third is the one that made this a platform
        // question rather than a regex. A drive-qualified path is absolute. A
        // UNC path is absolute. A bare leading separator is NOT: it means the
        // root of whichever drive is current, so it resolves differently
        // depending on state this process does not control, and a hook running
        // in the agent's working directory is exactly where that bites.
        if (/^[A-Za-z]:[\\/]/.test(value)) return true;
        if (/^[\\/]{2}/.test(value)) return true;
        return false;
    },

    appDataDir(home: string, appId: string): string {
        return path.join(home, 'AppData', 'Local', appId);
    },

    selfChecks({ home, appId, claudePath }): readonly SelfCheckSpec[] {
        return [
            {
                name: 'app data directory is writable',
                kind: 'dir-writable',
                targets: [this.appDataDir(home, appId)],
                detail: 'Stafford stores its database and logs here.'
            },
            {
                name: 'claude binary is present',
                kind: 'any-file-exists',
                targets: claudePath ? [claudePath] : [...this.claudeCandidates(home)],
                detail: 'Without it no agent can be spawned. Set the claudePath option if it lives elsewhere.'
            },
            {
                name: 'a process can be spawned and killed',
                kind: 'spawn-and-kill',
                targets: [],
                detail: 'Proves the pty layer and the kill path work on this machine.'
            }
        ];
    }
};
