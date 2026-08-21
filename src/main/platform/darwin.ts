/**
 * macOS.
 *
 * Written and not yet exercised on real hardware. Hardware is deferred, not
 * cancelled, and macOS stays a first-class target. Every claim here that has
 * not been measured carries an `UNVERIFIED(darwin)` marker, and
 * `grep -rn "UNVERIFIED("` is the work list for the first session on the Mac.
 *
 * Answers land in docs/stack-migration-verification.md, macOS section.
 *
 * A marker is removed by a measurement on that machine. A green macOS CI run
 * does not remove one: a GitHub runner has no Claude Code install, no real
 * trust records and nothing equivalent to ConPTY.
 */

import nodePath from 'node:path';
import type { CommandSpec, KillTreePlan, PathInputs, Platform, RegistryLookup, ResizeObservation, SelfCheckSpec } from './types.ts';
import { posixKillTreePlan } from './posix-kill.ts';

// POSIX semantics regardless of the machine running this. Plain path.join on
// Windows produces backslashes, which would make every test here assert on a
// macOS that does not exist.
const path = nodePath.posix;

/**
 * The Windows allowlist is entirely Windows. This is the POSIX equivalent, and
 * the inversion is worth noticing: locating a shell is a Windows-only problem
 * and disappears here, where a POSIX shell is always present.
 */
const INHERITED = Object.freeze([
    'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'PATH'
]);

export const darwin: Platform = {
    id: 'darwin',
    supported: true,

    inheritedEnvKeys: () => INHERITED,

    pathDirectories({ home, nodeDir }: PathInputs): readonly string[] {
        // Rebuilt rather than inherited, same rule as Windows and for the same
        // reason. Homebrew first on both prefixes, since a developer's tools
        // usually live there and the arm64 prefix differs from the Intel one.
        const dirs = [
            '/opt/homebrew/bin',
            '/usr/local/bin',
            '/usr/bin',
            '/bin',
            '/usr/sbin',
            '/sbin'
        ];
        if (nodeDir) dirs.push(nodeDir);
        if (home) dirs.push(path.join(home, '.local', 'bin'));
        return dirs;
    },

    posixShellCandidates: (): readonly string[] => ['/bin/bash', '/bin/zsh', '/bin/sh'],

    // No registry. The empty list is the platform's answer, not a missing member.
    shellRegistryLookups: (): readonly RegistryLookup[] => [],

    // The shell is already on a directory PATH carries, so nothing to add.
    shellPathDirectories: (): readonly string[] => [],

    executableName: (base: string) => base,

    pathSeparator: ':',

    directorySeparator: '/',

    claudeCandidates(home: string): readonly string[] {
        // Confirmed 2026-08-08 on the MacBook. The binary is at
        // ~/.local/bin/claude, the first candidate, and `which claude` agrees.
        // Both Homebrew prefixes stay because arm64 and Intel differ and a Mac
        // can carry either; neither was needed here.
        // Harness section 1, verdict confirmed.
        const candidates = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
        if (home) candidates.unshift(path.join(home, '.local', 'bin', 'claude'));
        return candidates;
    },

    killTreePlan(pid: number): KillTreePlan {
        // Confirmed against a real agent tree 2026-08-08, and the old
        // single-command form was wrong here:
        //
        //   tool    tail  pid 77302, ppid 77277, pgid 77277
        //   session pgid 76638, leads its own group: true
        //   child   descendant: true, shares its process group: false
        //   kill -9 -76638  ->  session dead, child alive, 0 left in the group
        //
        // Claude Code runs its Bash tool through a wrapper that leads its own
        // process group, so the session's group contains only the session. The
        // kill succeeded, reported success, and orphaned the child.
        return posixKillTreePlan(pid);
    },

    managedChildSpawnOptions(): { readonly detached: boolean } {
        // True, and the reason is the bug this shipped with. Without it the child
        // inherits Stafford's process group, so the group kill above targets
        // Stafford. Measured 2026-08-21: the group killTree selected contained
        // /bin/zsh, the Electron process and the child, and one message killed
        // all three.
        return { detached: true };
    },

    osCredentialCommand(account: string): CommandSpec | null {
        // The login Keychain, which is where Claude Code keeps the credential on a
        // Mac. `-w` prints only the secret, so nothing else has to be parsed out of
        // the output and no attribute dump goes anywhere near a log.
        //
        // The service name is the unsuffixed one on purpose. Claude Code also
        // creates per-config-dir items named `Claude Code-credentials-<8 hex>`, and
        // two exist on the reference Mac, but the suffix is undocumented and did
        // not match a sha256, sha1 or md5 prefix of any candidate path. Writing the
        // namespaced item would keep the token in Keychain and is the better shape,
        // so it is worth revisiting if the derivation is ever published. It is not
        // worth guessing: a wrong guess fails silently as "not logged in".
        return {
            file: 'security',
            args: ['find-generic-password', '-w', '-s', 'Claude Code-credentials', '-a', account]
        };
    },

    processTreeCommand(): CommandSpec {
        // Trailing `=` on each column suppresses the header, so the output is
        // data with no line to skip.
        return { file: 'ps', args: ['-Ao', 'pid=,ppid=,pgid=,comm='] };
    },

    ownerOnlyAclPlan(_target: string, _opts: { tree: boolean; account: string }): CommandSpec | null {
        // POSIX mode bits are real: the seed's chmod to 0600/0700 is the whole
        // guarantee, so there is no command to run.
        return null;
    },

    resizeObservation(cols: number, rows: number): ResizeObservation {
        // Measured 2026-08-08 on macOS 26.5.2 arm64, so this one is not
        // UNVERIFIED. Resizing a real pty produced "READY\r\nWINCH 132x40\r\n"
        // with no size report anywhere in the stream.
        return {
            mechanism: 'child-reads-winsize',
            expect: 'WINCH ' + String(cols) + 'x' + String(rows),
            detail:
                'a real pty echoes nothing on the master when it is resized. The kernel delivers ' +
                'SIGWINCH and the child reads its own winsize, which it can, so the child is the ' +
                'only thing that can report it. There is no size report to match here.'
        };
    },

    normalisePath(value: string): string {
        // Measured 2026-08-08 rather than assumed, on the MacBook and on its
        // repository volume: a file written as CaseProbe.txt resolves as
        // caseprobe.txt, so APFS is case insensitive here and this matches
        // Windows rather than Linux.
        //
        // Not marked UNVERIFIED, because it is confirmed, and not treated as
        // universal either. A case-sensitive APFS volume is a real
        // configuration a developer can choose at format time, and there this
        // would compare two distinct paths as equal, which presents as a
        // project matching the wrong repository. Developer machines are where
        // that exception happens, so if path comparison ever misbehaves on a
        // Mac, probe the volume before suspecting anything else.
        return String(value).replace(/\/+$/, '').toLowerCase();
    },

    isAbsolutePath(value: string): boolean {
        // A leading slash and nothing else. There are no drives and no UNC
        // paths, so the Windows subtlety this member exists for does not arise.
        return value.startsWith('/');
    },

    appDataDir(home: string, appId: string): string {
        return path.join(home, 'Library', 'Application Support', appId);
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
