/**
 * Linux. Written, not shipped.
 *
 * The interface was designed for three platforms, and an interface designed for
 * three and implemented for two is a claim rather than a fact. Writing this one
 * is how the claim gets tested: if the shape only fitted Windows and macOS,
 * this file would not have been writable without changing it.
 *
 * `supported` is false, so the app refuses to start here rather than making an
 * untested best effort. That is the honest position: nothing below has ever run
 * on Linux, and half-working is worse than refusing.
 */

import nodePath from 'node:path';
import type { CommandSpec, KillTreePlan, PathInputs, Platform, RegistryLookup, ResizeObservation, SelfCheckSpec } from './types.ts';
import { posixKillTreePlan } from './posix-kill.ts';

// POSIX semantics regardless of the machine running this. Plain path.join on
// Windows produces backslashes, which would make every test here assert on a
// macOS that does not exist.
const path = nodePath.posix;

const INHERITED = Object.freeze([
    'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'PATH', 'XDG_RUNTIME_DIR'
]);

export const linux: Platform = {
    id: 'linux',
    supported: false,

    inheritedEnvKeys: () => INHERITED,

    pathDirectories({ home, nodeDir }: PathInputs): readonly string[] {
        const dirs = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
        if (nodeDir) dirs.push(nodeDir);
        if (home) dirs.push(path.join(home, '.local', 'bin'));
        return dirs;
    },

    posixShellCandidates: (): readonly string[] => ['/bin/bash', '/bin/sh'],

    shellRegistryLookups: (): readonly RegistryLookup[] => [],

    shellPathDirectories: (): readonly string[] => [],

    executableName: (base: string) => base,

    pathSeparator: ':',

    directorySeparator: '/',

    claudeCandidates(home: string): readonly string[] {
        const candidates = ['/usr/local/bin/claude'];
        if (home) candidates.unshift(path.join(home, '.local', 'bin', 'claude'));
        return candidates;
    },

    killTreePlan(pid: number): KillTreePlan {
        // Shared with darwin on purpose. The defect found on macOS is POSIX-wide:
        // a tool child landing in its own process group is the spawned
        // program's choice, not the platform's, and Claude Code makes the same
        // choice on both.
        return posixKillTreePlan(pid);
    },

    managedChildSpawnOptions(): { readonly detached: boolean } {
        // Same answer as darwin, and for the same reason rather than by
        // imitation: this platform shares posixKillTreePlan, so it shares the
        // requirement that the snapshot root leads its own group.
        return { detached: true };
    },

    osCredentialCommand(_account: string): CommandSpec | null {
        // Null. The credential is a file at ~/.claude/.credentials.json, which the
        // seed already copies, so there is no store to read.
        return null;
    },

    processTreeCommand(): CommandSpec {
        return { file: 'ps', args: ['-Ao', 'pid=,ppid=,pgid=,comm='] };
    },

    ownerOnlyAclPlan(_target: string, _opts: { tree: boolean; account: string }): CommandSpec | null {
        // POSIX mode bits are real: the seed's chmod to 0600/0700 is the whole
        // guarantee, so there is no command to run.
        return null;
    },

    resizeObservation(cols: number, rows: number): ResizeObservation {
        // Same mechanism as darwin, for the same reason: a real pty, a real
        // SIGWINCH. Unexercised here only because linux refuses to run at all.
        return {
            mechanism: 'child-reads-winsize',
            expect: 'WINCH ' + String(cols) + 'x' + String(rows),
            detail:
                'a real pty echoes nothing on the master when it is resized. The kernel delivers ' +
                'SIGWINCH and the child reads its own winsize, so the child is the only thing ' +
                'that can report it.'
        };
    },

    normalisePath(value: string): string {
        // The one place Linux genuinely differs from the other two: case
        // matters. Lowercasing here would make two distinct repos compare equal.
        return String(value).replace(/\/+$/, '');
    },

    isAbsolutePath(value: string): boolean {
        return value.startsWith('/');
    },

    appDataDir(home: string, appId: string): string {
        return path.join(home, '.local', 'share', appId);
    },

    selfChecks({ home, appId, claudePath }): readonly SelfCheckSpec[] {
        return [
            {
                name: 'app data directory is writable',
                kind: 'dir-writable',
                targets: [this.appDataDir(home, appId)],
                detail: 'Stafford stores its database, its socket and its logs here.'
            },
            {
                name: 'claude binary is present',
                kind: 'any-file-exists',
                targets: claudePath ? [claudePath] : [...this.claudeCandidates(home)],
                detail: 'Without it no agent can be spawned.'
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
