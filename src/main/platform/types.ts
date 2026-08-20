/**
 * The platform layer's interface. One shape, three implementations, and no
 * `process.platform` check anywhere else in the codebase.
 *
 * Two rules hold this together and both are load bearing.
 *
 * **Return data, never do work.** Every member here answers a question with a
 * value: which variable names to copy, which directories make up PATH, which
 * paths a binary might live at, which command kills a process tree. Nothing
 * reads a file, spawns a process or touches the registry. The shared code in
 * `index.ts` does all of that, once, for every platform.
 *
 * That is the property that let the first three modules survive a whole change
 * of stack, and it is what makes darwin testable from a Windows machine. A
 * command specification for killing a process tree can be asserted on without
 * a mac; a function that kills a process tree cannot.
 *
 * **The interface is total.** Every member exists on every platform. No
 * optional members, no capability flags. A caller writing
 * `if (platform.namedPipeAcl)` has put platform knowledge back into feature
 * code, which is the thing this module exists to prevent. Where a concept does
 * not apply, the platform returns its own equivalent rather than nothing: a
 * socket path is a socket path whether it is a pipe name or a file path, and a
 * list of places to look for a POSIX shell is a list on Windows too, it just
 * contains different entries.
 */

export type PlatformId = 'win32' | 'darwin' | 'linux';

/**
 * A command to run, never run here. Returning this rather than a result is what
 * makes every platform's process handling assertable from any machine.
 */
export interface CommandSpec {
    readonly file: string;
    readonly args: readonly string[];
}

/** Ask, then insist. `TERM` is catchable and `KILL` is not. */
export type KillSignal = 'TERM' | 'KILL';

/**
 * How to tear a process tree down on this platform.
 *
 * The ordering is the load-bearing part, which is why this is a plan and not a
 * command. On POSIX the tree must be snapshotted while it is still alive, the
 * distinct process groups collected from that snapshot, and every one of them
 * killed rather than only the session's. Killing groups rather than a list of
 * pids matters because a process that spawns during teardown is caught by its
 * parent's group, where a pid list collected a moment earlier would miss it.
 *
 * Windows needs none of that. `taskkill /T` walks parent to child itself, so
 * the whole procedure collapses to `wholeTree` and the rest is unused.
 */
export interface KillTreePlan {
    readonly rootPid: number;

    /**
     * Whether the tree has to be measured before anything is killed.
     *
     * True on POSIX, and the reason is not efficiency. After the root dies its
     * descendants are reparented to pid 1, so the parent chain that identifies
     * them no longer exists and there is nothing left to walk.
     */
    readonly snapshotBeforeKill: boolean;

    /**
     * Whether every distinct group in the snapshot is killed, rather than only
     * the root's group.
     */
    readonly killsEveryGroup: boolean;

    /** One command that does the whole job, where the platform has one. */
    readonly wholeTree: CommandSpec | null;

    /** Kill a whole process group. Unused where `wholeTree` is set. */
    group(pgid: number, signal: KillSignal): CommandSpec;

    /** Kill one process, for a survivor that changed group after the snapshot. */
    process(pid: number, signal: KillSignal): CommandSpec;

    /**
     * What this procedure cannot guarantee, stated rather than implied.
     *
     * The next person will otherwise trust it further than it deserves.
     */
    readonly gap: string;

    readonly detail: string;
}

/** A registry value to read. Empty on platforms without a registry. */
export interface RegistryLookup {
    readonly key: string;
    readonly value: string;
}

/**
 * How a resize becomes observable, as data rather than as a check.
 *
 * The two platforms prove a resize landed by genuinely different mechanisms and
 * neither one generalises, which is why this is here instead of being a
 * constant in a test.
 *
 * On Windows the ConPTY announces its new size on the master as
 * `CSI 8 ; rows ; cols t`, and the child cannot be asked because its console
 * width is cached at startup and does not follow a ConPTY resize. On a real
 * Unix pty nothing is echoed on the master at all; the kernel delivers SIGWINCH
 * and the child reads its own winsize, which it can.
 *
 * Measured on macOS 2026-08-08. Resizing a pty produced
 * `"READY\r\nWINCH 132x40\r\n"` with no size report present, so a test written
 * against the Windows mechanism fails on darwin while resize works perfectly.
 * That failure is what made the macOS harness report NEEDS FIX and conclude the
 * pty layer did not work under Electron, from one wrong assertion out of five.
 */
/**
 * Whether the runtime's pty leaves an input socket open, and where it is.
 *
 * A capability rather than a platform name. The question is whether the
 * internals exist and whether anything has to be released by hand, not whether
 * `process.platform` says `win32`, and code that asks the second when it means
 * the first is how a platform check ends up in feature code.
 *
 * On Windows node-pty's ConPTY kill path marks both sockets unreadable and
 * disposes the conout worker without destroying the conin socket, while the DLL
 * path a few lines away does destroy it. Cost of not doing it: one handle per
 * session, linear, on a runner meant to stay up for days. Measured on 1.1.0 and
 * again on 1.2.0-beta.15, which still leaks one per session, so this is not a
 * version-specific quirk.
 *
 * On POSIX there is no agent and no second socket, so `path` is empty and
 * `required` is false. **That does not mean nothing leaks on POSIX.** node-pty
 * 1.1.0 leaks the pty master itself on darwin, natively, and no JavaScript can
 * close it; see the known limitation in the migration plan. It is a different
 * defect from this one and is not something a disposal path can reach.
 *
 * `path` is the property chain from the terminal object to the socket, as data,
 * so the disposal and the test that guards it read one source instead of
 * agreeing with each other.
 */
export interface InputSocketDisposal {
    /** Whether anything has to be destroyed by hand after a kill. */
    readonly required: boolean;
    /** Property chain from the terminal to the socket. Empty when not required. */
    readonly path: readonly string[];
    /** Why, said back when a guard or an assertion refers to it. */
    readonly detail: string;
}

export interface ResizeObservation {
    /** Which of the two mechanisms this platform uses. */
    readonly mechanism: 'emitted-size-report' | 'child-reads-winsize';
    /** Text the pty output must contain once the resize has landed. */
    readonly expect: string;
    /** Why this platform uses this mechanism, said back when an assertion fails. */
    readonly detail: string;
}

/**
 * One assumption to prove at startup, as a specification rather than a check.
 *
 * With macOS hardware deferred, these are what stands between Benzoo and code
 * that has never run, so they are data that can be asserted on from here rather
 * than behaviour that can only be observed there.
 */
export interface SelfCheckSpec {
    readonly name: string;
    readonly kind: 'dir-writable' | 'any-file-exists' | 'spawn-and-kill';
    readonly targets: readonly string[];
    /** Said back to the user when the check fails, so a failure is actionable. */
    readonly detail: string;
}

export interface PathInputs {
    readonly home: string;
    readonly nodeDir: string;
    readonly parentPath: string;
}

export interface Platform {
    readonly id: PlatformId;

    /**
     * False for anything never exercised on real hardware. The app refuses to
     * start rather than making an untested best effort.
     */
    readonly supported: boolean;

    // --- agent environment --------------------------------------------------

    /** Copied from the parent environment. Nothing else is. */
    inheritedEnvKeys(): readonly string[];

    /** The directories that make up PATH, in order. Never the inherited PATH. */
    pathDirectories(input: PathInputs): readonly string[];

    /**
     * Absolute paths where a POSIX shell might live, in preference order. On
     * POSIX this finds `/bin/bash` immediately. On Windows it is the Git Bash
     * search, which is a real problem there and a non-problem elsewhere.
     */
    posixShellCandidates(input: PathInputs): readonly string[];

    /** Registry values that may name a shell install root. Empty off Windows. */
    shellRegistryLookups(): readonly RegistryLookup[];

    /**
     * Given a located shell executable, the directories to add to PATH. Windows
     * needs three from the Git install root; POSIX needs none, since the shell
     * is already on a directory PATH already carries.
     */
    shellPathDirectories(shellExecutable: string): readonly string[];

    // --- locating the binary ------------------------------------------------

    executableName(base: string): string;

    /** How this platform joins PATH entries. Data, so no caller branches on the id. */
    readonly pathSeparator: string;

    /** How this platform separates directories within a path. Same reason. */
    readonly directorySeparator: string;

    /** Where the Claude Code binary might be, in order. Config override wins first. */
    claudeCandidates(home: string): readonly string[];

    // --- processes ----------------------------------------------------------

    /**
     * How to tear down a process tree here, as a plan rather than a command.
     *
     * **This replaced `killTreeCommand(pid): CommandSpec` on 2026-08-08, and
     * the shape was the defect rather than the command inside it.** One command
     * cannot express tree teardown on POSIX, because the procedure has to
     * measure state before anything dies: once the session is killed its
     * children are reparented to launchd, and the parent chain that identified
     * them is gone. A single return value forced the caller to already know the
     * answer.
     *
     * Measured: `kill -9 -<session pid>` killed the session, reported success,
     * and left the tool child running, because Claude Code runs its Bash tool
     * through a wrapper that leads its own process group.
     *
     * The platform says what to do as data; `kill-tree.ts` does it.
     */
    killTreePlan(pid: number): KillTreePlan;

    /**
     * How to list every process with its parent and its process group, or null
     * where the platform has no process-group model to check.
     *
     * `killTreeCommand` on POSIX returns `kill -9 -<pid>`, which assumes the
     * tool child shares the session's process group. That is an assumption
     * about how the spawned program behaves, not about our own code, and
     * nothing could verify it without asking the operating system what the tree
     * actually looks like. Data rather than a `ps` call written inline, because
     * reaching for `ps` is itself a POSIX assumption and that is the exact class
     * of bug `isAbsolutePath` was.
     *
     * The columns are fixed by the command so every platform that answers
     * produces the same three numbers and a command name, in that order, one
     * process per line.
     */
    processTreeCommand(): CommandSpec | null;

    /**
     * The command that locks a filesystem path to a single owner, or null where
     * the POSIX mode already applied by `chmod` is the whole guarantee.
     *
     * Windows returns an `icacls` invocation: node's `chmod` cannot set an ACL
     * there, and a path under userData inherits the profile ACL, which on a managed
     * or sandboxed machine can carry a group with read access (a `CodexSandboxUsers`
     * ACE was observed inherited into `%APPDATA%`). So a copied credential has to be
     * locked to the current user explicitly. POSIX returns null because `0600`/`0700`
     * is a real, sufficient guarantee there. `tree` sets container inheritance so a
     * directory's future children are covered; `account` is the owner to grant.
     *
     * A plan, not an action, so the platform layer spawns nothing, the same reason
     * `killTreePlan` is data.
     */
    ownerOnlyAclPlan(target: string, opts: { tree: boolean; account: string }): CommandSpec | null;

    /**
     * How to tell that a resize of this size landed. Data, so the two
     * mechanisms stay named rather than becoming a branch in a test fixture.
     */
    resizeObservation(cols: number, rows: number): ResizeObservation;

    /**
     * Whether node-pty leaves an input socket open here, and the property chain
     * to it. Data, so the disposal and its guard test cannot drift apart.
     */
    inputSocketDisposal(): InputSocketDisposal;

    // --- paths --------------------------------------------------------------

    /**
     * The comparison rule, not the comparison. Two paths are equal when their
     * normalised forms match, and `pathsEqual` in `index.ts` is the only caller.
     */
    normalisePath(value: string): string;

    /**
     * Whether this path is absolute on this platform.
     *
     * A platform question that did not look like one. `agent-env` answered it
     * with a regex, and that regex was correct for Windows and wrong for
     * everything else: a leading separator is drive-relative on Windows and is
     * the definition of absolute on POSIX. So every absolute macOS path was
     * refused, and the only test covered it with `win32` and Windows paths, so
     * nothing disagreed until the harness passed a real socket path in.
     *
     * The sweep that keeps platform logic in one module looks for
     * `process.platform` and for comparisons against `platform.id`. A regex
     * carrying an operating system's path rule is invisible to it, which is why
     * this is a member rather than a fixed regex.
     */
    isAbsolutePath(value: string): boolean;

    appDataDir(home: string, appId: string): string;

    // --- honesty ------------------------------------------------------------

    selfChecks(input: { home: string; appId: string; claudePath: string | null }): readonly SelfCheckSpec[];
}
