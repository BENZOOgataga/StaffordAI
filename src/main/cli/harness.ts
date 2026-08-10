/**
 * The 6c CLI harness. The first real caller of the Task 1 modules.
 *
 * It is not a feature and it is not a test. It is an instrument that starts the
 * product's own startup path, spawns one real Claude Code session in a real
 * pseudo-terminal, and reports what actually happened, so that three questions
 * this machine is the only place to answer can be answered.
 *
 * **It starts honestly.** `assertStartable` and `prepareSocketFor` run here, at
 * startup, on the real platform, with the real home directory. Not a copy of
 * what they do, not a directory the harness made first. Task 5's end-to-end test
 * passed with a real session and a real hook event while `parentDir` and
 * `parentMode` had no consumer at all, because the probe created the socket path
 * the product should have created. A test that arranges its own preconditions
 * verifies what runs after them and says nothing about the code that should have
 * set them up. So the socket that a hook connects to here exists because
 * `prepareSocketFor` made it exist, or the run fails.
 *
 * That is also what turns macOS harness section 3 from a pending line into a
 * measurement: once this has run, a socket is on disk in a directory the product
 * created, and the ownership check has a real subject.
 *
 * **The project is a scratch one.** A temp directory outside iCloud, default
 * permission mode so tool calls prompt, deleted after the run. Not Stafford,
 * whose policy is `acceptEdits` and will not prompt, and not a real project,
 * because editing a live policy to provoke a prompt is changing config to make a
 * test pass.
 *
 * **Trust is not answered on anyone's behalf.** A fresh directory has never been
 * seen by Claude Code, so it shows a trust prompt, and section 2.4 of the pty
 * runner plan says the runner never sends the keystroke that accepts it. So the
 * harness renders the session to this terminal and forwards what a human types
 * until `SessionStart` arrives, and writes nothing of its own before that point.
 * That is rule one and rule two of the plan, exercised rather than arranged
 * around.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { currentPlatform, findPosixShell } from '../platform/index.ts';
import { assertStartable } from '../startup/self-check.ts';
import { prepareSocketFor } from '../hooks/socket-setup.ts';
import { HookListener } from '../hooks/hook-listener.ts';
import { AgentSecrets } from '../hooks/agent-secrets.ts';
import { buildCommand, merge, type Settings } from '../hooks/registration.ts';
import { locateClaude } from '../agents/claude-locator.ts';
import { buildAgentEnv } from '../agents/agent-env.ts';
import { readTrust, TRUST } from '../agents/trust.ts';
import { PtySession, type PtyLike } from '../agents/pty-session.ts';
import {
    readProcessTree, isDescendantOf, find, descendantsMatching, type ProcessRow
} from '../agents/process-tree.ts';
import { killTree } from '../agents/kill-tree.ts';

const require = createRequire(import.meta.url);
const nodePty = require('node-pty') as {
    spawn: (file: string, args: readonly string[], options: Record<string, unknown>) => PtyLike;
};

export const APP_ID = 'Stafford';
export const AGENT_ID = 'harness-6c';

export interface HookEvent {
    readonly event?: string;
    readonly sessionId?: string;
    readonly cwd?: string;
    readonly at?: string;
    readonly toolName?: string;
    readonly message?: string;
    readonly [key: string]: unknown;
}

/**
 * Where the run is recorded, because the terminal cannot be trusted to keep it.
 *
 * Claude Code draws a fullscreen TUI into the same terminal this prints to, so
 * its repaints overwrite anything printed alongside them, and leaving the
 * alternate screen on exit erases what is left. The first real run produced a
 * complete results block that nobody could read for exactly that reason.
 *
 * So every line goes to a file as well. The file is the artifact; the terminal
 * is a convenience.
 */
export const LOG_PATH = path.join(os.tmpdir(), 'stafford-6c-harness.log');

/** What the session printed, kept apart from the harness's own lines. */
export const TRANSCRIPT_PATH = path.join(os.tmpdir(), 'stafford-6c-transcript.log');

/** Where the hook-sandbox probe writes what it was allowed to do. */
export const HOOK_PROBE_PATH = path.join(os.tmpdir(), 'stafford-6c-hook-sandbox.jsonl');

function say(line: string): void {
    process.stdout.write(line + '\n');
    try {
        fs.appendFileSync(LOG_PATH, line + '\n');
    } catch {
        // A run that cannot write its log is still a run worth finishing.
    }
}

/**
 * Records the session's own output with the escape sequences removed.
 *
 * A TUI's raw stream is mostly cursor movement, and reading it back as a
 * transcript means reading it through the noise. Stripping is for legibility
 * only. **Nothing here derives state from this file**: every result the harness
 * reports comes from a hook event or from the process table, which is the rule
 * that stops a terminal scrape becoming load-bearing.
 */
function appendTranscript(chunk: string): void {
    try {
        // eslint-disable-next-line no-control-regex
        const plain = chunk.replace(/\[[0-9;?]*[a-zA-Z]/g, '').replace(/[()][A-Z0-9]/g, '');
        fs.appendFileSync(TRANSCRIPT_PATH, plain);
    } catch {
        // Same as above. Losing the transcript is not losing the run.
    }
}

/**
 * Runs the product's startup path and returns what it produced.
 *
 * Nothing here is harness-specific. This is what Task 7's Electron shell will
 * do, called from a command line instead of from a tray.
 */
export function startUp(): { socketPath: string; claudePath: string; accessDetail: string } {
    const platform = currentPlatform();
    const home = os.homedir();

    const claude = locateClaude({
        platform,
        home,
        pathValue: process.env.PATH ?? '',
        exists: (candidate) => fs.existsSync(candidate)
    });

    // Refuses rather than half starting. The prober is real: this is the
    // machine the spawn-and-kill check is about.
    const report = assertStartable(platform, { home, appId: APP_ID, claudePath: claude.path }, {
        canSpawnAndKill: () => {
            const term = nodePty.spawn(process.execPath, ['-e', '0'], {
                name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(),
                env: { PATH: process.env.PATH ?? '' }
            });
            try { term.kill(); } catch { /* opening it is the question */ }
            return true;
        }
    });

    for (const result of report.results) {
        say('  check   ' + result.name + ': ' + (result.ok ? 'ok' : 'FAILED') +
            (result.satisfiedBy ? ' (' + result.satisfiedBy + ')' : ''));
    }

    const { plan, report: socket } = prepareSocketFor(platform, { appId: APP_ID, home });

    say('  socket  ' + plan.path);
    say('  parent  ' + String(plan.parentDir) +
        ', created ' + String(socket.created) +
        ', mode before ' + (socket.modeBefore === null ? 'none' : '0' + socket.modeBefore.toString(8)) +
        ', mode after ' + (socket.modeAfter === null ? 'none' : '0' + socket.modeAfter.toString(8)) +
        ', stale removed ' + String(socket.staleRemoved));
    say('  access  ' + plan.accessDetail);

    return { socketPath: plan.path, claudePath: claude.path, accessDetail: plan.accessDetail };
}

/**
 * Creates the scratch project, including its hook registration.
 *
 * `os.tmpdir()` on macOS is under /var/folders, which is outside iCloud and
 * outside any managed project, so an agent given a tool call here cannot reach
 * anything that matters.
 */
export function createScratchProject(socketPath: string): { dir: string; command: string } {
    // A fixed name rather than a random one, and the reason is trust.
    //
    // A directory Claude Code has never seen shows a trust prompt, and the plan
    // says the runner never answers one. A random name is a directory it has
    // never seen every single time, so every run would need Benzoo at a
    // keyboard and nothing here could ever be measured twice. A fixed path is
    // granted once, by hand, and the record survives the directory being
    // deleted afterwards, because the record is keyed on the path.
    //
    // That keeps both rules intact. Trust is still a human decision taken once,
    // and it is still never auto-accepted. What changes is only how often the
    // human is asked.
    const base = path.join(os.tmpdir(), 'stafford-6c-scratch');
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(base, { recursive: true });

    // Resolved, because macOS hands out a symlink here and Claude Code does
    // not. `os.tmpdir()` is /var/folders/..., /var is a symlink to /private/var,
    // and the trust prompt reported the directory as /private/var/folders/...
    // So a trust record written by Claude Code is keyed on the resolved path,
    // and a lookup with the unresolved one never matches however the comparison
    // normalises. Observed 2026-08-08 in this harness's first run.
    const dir = fs.realpathSync(base);
    const forwarder = path.resolve(process.cwd(), 'hooks', 'claude-hook.cjs');
    const command = buildCommand(process.execPath, forwarder);

    const settings: Settings = merge({}, command);

    // A second hook, alongside the forwarder, answering whether hook commands
    // run inside the Bash sandbox. A sandboxed tool call cannot bind a socket
    // under Application Support and a hook delivered SessionStart to one, so
    // hooks look unsandboxed, and that is an implication rather than a
    // measurement. The transport depends on it, so it gets measured.
    const probe = path.resolve(process.cwd(), 'scripts', 'hook-sandbox-probe.cjs');
    const probeCommand = '"' + process.execPath + '" "' + probe + '"';
    const hooks = settings.hooks as Record<string, { hooks: { type: 'command'; command: string }[] }[]>;
    hooks.SessionStart = [
        ...(hooks.SessionStart ?? []),
        { hooks: [{ type: 'command', command: probeCommand }] }
    ];

    // Opt-in: force a permission prompt on Bash, to provoke the prompt variant
    // of Notification rather than the idle one. The design assumed default mode
    // prompts on tool calls, and it did not, because a sandboxed Bash call is
    // contained instead of prompted. This asks explicitly, so the run also
    // measures whether an explicit ask overrides the sandbox or the sandbox
    // still suppresses the prompt. Off by default, so the ordinary run stays a
    // clean transport measurement.
    if (process.env.STAFFORD_FORCE_ASK === '1') {
        (settings as Record<string, unknown>).permissions = {
            defaultMode: 'default',
            ask: ['Bash(*)']
        };
        say('  permits forcing ask on Bash, to provoke the permission-prompt Notification');
    }

    // The other half of the same question. If ask alone does not prompt, is
    // that the sandbox suppressing it or the ask being ignored? Turning the
    // sandbox off for this project separates the two: ask plus no sandbox
    // should prompt, and if it still does not the ask is the problem.
    if (process.env.STAFFORD_NO_SANDBOX === '1') {
        (settings as Record<string, unknown>).sandbox = { enabled: false };
        say('  disabling the sandbox for this project, to test whether it is what suppresses the prompt');
    }

    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, '.claude', 'settings.local.json'),
        JSON.stringify(settings, null, 2) + '\n'
    );

    // A file for the agent to look at, so the scratch project is not empty.
    fs.writeFileSync(path.join(dir, 'README.md'), 'Scratch project for the Stafford 6c harness.\n');

    say('  project ' + dir);
    say('  hooks   ' + command);
    say('  socket  ' + socketPath + ' (through STAFFORD_SOCKET)');

    return { dir, command };
}


/**
 * The fixed instruction. One command, named, and nothing else.
 *
 * The agent does not choose. If it chose and `Notification` did not fire, hook
 * failure and no-tool-call would look identical from here and the run would not
 * reproduce on the next machine.
 *
 * One command has to satisfy two requirements that are easy to conflate.
 * `Notification` fires on the permission prompt, which any tool call produces
 * regardless of what the command does. Section 4 needs a real process tree,
 * which means a child still alive when the group is killed. An `echo` satisfies
 * the first and not the second.
 *
 * **It was `sleep 300` and it cannot be.** Current Claude Code refuses a
 * foreground `sleep` in the Bash tool and answers with
 * `Blocked: standalone sleep 300.`, after reporting that it ran the command.
 * Observed 2026-08-08 on this machine. That is a property of the agent being
 * measured rather than of this project's configuration, so no setting fixes it
 * and the command has to be one the tool will actually run.
 *
 * `tail -f /dev/null` replaces it. It blocks forever without a timer, is POSIX,
 * exists on both targets, leaves exactly one killable child, and reads as a
 * long-running command rather than as a paused one.
 *
 * The lesson is worth more than the substitution. The fixed command is a
 * dependency on the agent's own policy about what it will run, and that policy
 * changes without notice. If this stops producing a child, check whether the
 * command was refused before assuming the hook or the tree is at fault, which
 * is what the failure message below says out loud.
 */
export const FIXED_COMMAND = 'tail -f /dev/null';

/** The process the fixed command leaves behind, matched on the executable name. */
export const CHILD_PATTERN = /(^|\/)tail\b/;
export const FIXED_PROMPT =
    'Run exactly this one shell command and nothing else, using the Bash tool: ' + FIXED_COMMAND +
    '. Do not read any files, do not write anything, do not run any other command.';

/** Long enough for a first launch, short enough that a wedged run is not a hang. */
const SESSION_START_TIMEOUT_MS = 120_000;
const CHILD_TIMEOUT_MS = 60_000;
const SESSION_END_TIMEOUT_MS = 60_000;

/** After the permission prompt is answered, before the child is expected. */
const CHILD_POLL_MS = 500;

export interface Spawned {
    readonly session: PtySession;
    readonly env: Record<string, string | undefined>;
    readonly trustAtSpawn: string;
    readonly stopEcho: () => void;
}

export interface RunResult {
    readonly sessionStart: HookEvent | null;
    readonly notification: HookEvent | null;
    readonly sessionEnd: HookEvent | null;
    readonly toolWasFixed: boolean;
    readonly childIsDescendant: boolean | null;
    readonly sessionLeadsItsGroup: boolean | null;
    readonly nothingSurvived: boolean | null;
    readonly events: readonly HookEvent[];
    readonly rejections: readonly unknown[];
    readonly ok: boolean;
}

function waitFor(
    listener: HookListener,
    name: string,
    timeoutMs: number,
    session?: PtySession
): Promise<HookEvent | null> {
    // Said out loud, because a harness that prints nothing for ninety seconds
    // is indistinguishable from one that has hung, and the first run was read
    // as hung when it was waiting exactly as designed.
    say('  wait    ' + name + ', up to ' + Math.round(timeoutMs / 1000) + 's');
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            say('  wait    ' + name + ' did not arrive within ' + Math.round(timeoutMs / 1000) + 's');
            listener.off('event', check);
            resolve(null);
        }, timeoutMs);
        timer.unref();
        function check(event: HookEvent): void {
            if (event.event !== name) return;
            clearTimeout(timer);
            listener.off('event', check);
            resolve(event);
        }
        listener.on('event', check);
        // A session that dies is an answer too, and a faster one than the
        // timeout. Not registered for SessionEnd, where the exit is the point.
        if (session && name !== 'SessionEnd') {
            session.once('exit', () => { clearTimeout(timer); listener.off('event', check); resolve(null); });
        }
    });
}

function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref(); });
}

/** Builds the environment and starts one session in the scratch project. */
function spawnSession(input: {
    socketPath: string;
    claudePath: string;
    dir: string;
    secret: string;
    echo: boolean;
}): Spawned {
    const platform = currentPlatform();
    const home = os.homedir();

    const trustAtSpawn = readTrust({
        platform,
        dir: input.dir,
        configPath: path.join(home, '.claude.json'),
        readFile: (p) => fs.readFileSync(p, 'utf8')
    });

    const nodeDir = path.dirname(process.execPath);
    const shell = findPosixShell(
        platform,
        { home, nodeDir, parentPath: process.env.PATH ?? '' },
        (p) => fs.existsSync(p),
        () => null
    );

    const built = buildAgentEnv({
        agentId: AGENT_ID,
        platform,
        parentEnv: process.env,
        nodeDir,
        shellExecutable: shell,
        // Paths only. Every value here is required to be absolute, because a
        // relative one resolves against the agent's working directory.
        extra: { STAFFORD_SOCKET: input.socketPath },
        onWarn: (message) => say('  warn    ' + message)
    });

    // Injected under its own name rather than through `extra`, which is what
    // agent-env's contract says: a 32 byte hex secret is not a path.
    const env = {
        ...built.env,
        STAFFORD_AGENT_SECRET: input.secret,
        // Read by the probe hook. Absolute, since a hook runs in the agent's
        // working directory rather than the runner's.
        STAFFORD_HOOK_PROBE_OUT: HOOK_PROBE_PATH
    };

    const session = new PtySession({
        agentId: AGENT_ID,
        platform,
        file: input.claudePath,
        cwd: input.dir,
        env,
        spawn: nodePty.spawn
    });

    // Two different destinations, and conflating them cost a run.
    //
    // The terminal is needed for exactly one thing: showing a human the trust
    // prompt so they can answer it. After that the TUI is noise that paints
    // over the harness's own output, so the echo stops.
    //
    // The transcript is a different question. When no child appears there are
    // three possible causes and only the transcript separates them, so it is
    // always captured, to the log rather than to the screen. Silencing both at
    // once produced a run that reported Stop with no Notification and no way to
    // tell whether the agent refused, ran something else, or was never asked.
    let echoing = input.echo;
    session.on('data', (chunk: string) => {
        if (echoing) process.stdout.write(chunk);
        appendTranscript(chunk);
    });
    session.on('warn', (message: string) => say('  warn    ' + message));
    session.start();

    return { session, env, trustAtSpawn, stopEcho: () => { echoing = false; } };
}

/**
 * Waits for `SessionStart`, forwarding a human's keystrokes until it arrives.
 *
 * Rule one of section 2.4 of the pty runner plan: nothing the harness generates
 * is written before this returns. A trust prompt is answered by whoever is
 * sitting there, or not at all.
 */
async function awaitStart(
    listener: HookListener,
    session: PtySession,
    trust: string,
    stopEcho: () => void
): Promise<HookEvent | null> {
    const stdin = process.stdin;
    const tty = stdin.isTTY === true;
    const forward = (chunk: Buffer) => session.write(chunk.toString('utf8'));

    if (trust !== TRUST.TRUSTED) {
        say('  trust   ' + trust + ', so a trust prompt is expected and only a human may answer it');
        if (!tty) {
            say('  note    stdin is not a tty, so nobody can answer it. Run this from a terminal once.');
        }
    }
    if (tty) {
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on('data', forward);
    }

    const started = await waitFor(listener, 'SessionStart', SESSION_START_TIMEOUT_MS, session);

    if (tty) {
        stdin.off('data', forward);
        stdin.setRawMode(false);
        stdin.pause();
    }

    // From here the session runs unattended, so the TUI stops being shown. It
    // repaints over everything printed next, including the results.
    stopEcho();
    if (started) say('  echo    session output silenced from here, so the results survive the TUI');

    return started;
}

/**
 * Session one. The fixed tool, the permission prompt, and the process tree.
 *
 * `Notification` and the tree come from the same session on purpose: they are
 * two observations of one tool call, and separating them would let a run report
 * a permission prompt with no child, or a child with no prompt, as a pass.
 */
async function runToolSession(input: {
    listener: HookListener;
    socketPath: string;
    claudePath: string;
    dir: string;
    secret: string;
    /** Every event so far, so Notification can be read rather than waited on. */
    seen: readonly HookEvent[];
}): Promise<{
    sessionStart: HookEvent | null;
    notification: HookEvent | null;
    toolWasFixed: boolean;
    childIsDescendant: boolean | null;
    sessionLeadsItsGroup: boolean | null;
    nothingSurvived: boolean | null;
}> {
    const platform = currentPlatform();
    const seen = input.seen;
    const { session, trustAtSpawn, stopEcho } = spawnSession({ ...input, echo: true });
    const pid = session.pid ?? 0;
    say('  pid     ' + String(pid));

    const sessionStart = await awaitStart(input.listener, session, trustAtSpawn, stopEcho);
    if (!sessionStart) {
        session.kill();
        return {
            sessionStart: null, notification: null, toolWasFixed: false,
            childIsDescendant: null, sessionLeadsItsGroup: null, nothingSurvived: null
        };
    }

    say('');
    say('  prompt  ' + FIXED_PROMPT);
    await session.submit(FIXED_PROMPT);

    // **The child is the signal, not the hook event.**
    //
    // This used to wait for `Notification` before looking for the tool child,
    // and that is backwards. The child exists in the process table within
    // seconds of the tool starting. `Notification` here is the idle variant and
    // arrives only when the turn ends, which for a blocking command waits on
    // the tool's own timeout. The first run beat that race and the second lost
    // it, reporting no tool call for a tool call that had happened.
    //
    // So the tree work is gated on the process table, which is where the answer
    // actually is, and `Notification` is collected if it arrives rather than
    // waited on.
    let rows = readProcessTree(platform);
    let child: ProcessRow | null = null;
    const deadline = Date.now() + CHILD_TIMEOUT_MS;
    let nudged = false;

    say('  wait    a child matching ' + String(CHILD_PATTERN) +
        ', up to ' + Math.round(CHILD_TIMEOUT_MS / 1000) + 's');

    while (rows !== null && Date.now() < deadline) {
        const matches = descendantsMatching(rows, pid, CHILD_PATTERN);
        if (matches.length > 0) { child = matches[0] ?? null; break; }

        // If a permission prompt is up, a human would answer it. That a prompt
        // is up is known from the hook event rather than from reading the
        // terminal, which is the rule that matters. On a sandboxed machine no
        // prompt appears and this never fires.
        if (!nudged && seen.some((e) => e.event === 'Notification')) {
            nudged = true;
            say('  prompt  a Notification arrived and no child yet, so answering the prompt');
            session.write('\r');
        }

        await sleepMs(CHILD_POLL_MS);
        rows = readProcessTree(platform);
    }

    const notification = seen.find((e) => e.event === 'Notification') ?? null;
    say('  notify  ' + (notification
        ? 'observed: ' + String(notification.message)
        : 'none arrived while the tool ran'));

    if (rows === null) {
        say('  tree    this platform has no process-group model to check, so section 4 does not apply');
        session.kill();
        return {
            sessionStart, notification, toolWasFixed: false,
            childIsDescendant: null, sessionLeadsItsGroup: null, nothingSurvived: null
        };
    }

    if (!child) {
        // Three causes, named, because they are indistinguishable from here and
        // the third one actually happened. Claude Code refused `sleep 300` with
        // "Blocked: standalone sleep 300." after reporting it had run it, which
        // reads exactly like a permission prompt nobody answered.
        say('  tree    no child matching ' + String(CHILD_PATTERN) + ' appeared. One of three things:');
        say('          the permission prompt was not accepted, or the agent ran a different command,');
        say('          or the agent refused this command outright. Read the transcript above to tell them apart.');
        session.kill();
        return {
            sessionStart, notification, toolWasFixed: false,
            childIsDescendant: false, sessionLeadsItsGroup: null, nothingSurvived: null
        };
    }

    // Which tool ran, asserted against the process that exists rather than
    // against what the agent says it did.
    const toolWasFixed = CHILD_PATTERN.test(child.command);
    say('  tool    ' + child.command + '  pid ' + child.pid + ', ppid ' + child.ppid + ', pgid ' + child.pgid);

    const self = find(rows, pid);
    const childIsDescendant = isDescendantOf(rows, child.pid, pid);

    // The assumption kill -9 -<pid> rests on, stated as two separate questions
    // because they fail differently. If the session does not lead its own
    // group, the negative pid names some other group entirely. If the child is
    // in a different group, the kill reaches the session and orphans the child,
    // and the symptom is a stray process rather than an error.
    const sessionLeadsItsGroup = self !== null && self.pgid === pid;
    const childShares = child.pgid === pid;

    say('  session pgid ' + String(self?.pgid) + ', leads its own group: ' + String(sessionLeadsItsGroup));
    say('  child   descendant of the session: ' + String(childIsDescendant) +
        ', shares its process group: ' + String(childShares));

    // The procedure, not a command. It snapshots the tree while it is alive,
    // collects every group in it rather than assuming the root's, kills each
    // one, sweeps survivors by pid, and verifies. Verification belongs to the
    // procedure rather than to this caller remembering to look.
    const plan = platform.killTreePlan(pid);
    say('  plan    ' + plan.detail);
    const report = await killTree(platform, pid);

    say('  groups  killed ' + report.groups.join(', ') +
        '  (the session leads ' + String(self?.pgid) + ')');
    say('  after   survivors: ' + String(report.survivors.length) +
        ', swept by pid before that: ' + String(report.survivorsBeforeSweep.length));
    for (const row of report.survivors) {
        say('          SURVIVOR ' + row.pid + ' pgid ' + row.pgid + ' ' + row.command);
    }
    if (!report.ok) say('  gap     ' + plan.gap);

    const nothingSurvived = report.ok;

    session.kill();
    return { sessionStart, notification, toolWasFixed, childIsDescendant, sessionLeadsItsGroup, nothingSurvived };
}

/**
 * Session two. A clean exit, which is the only way to see `SessionEnd`.
 *
 * It needs its own session because the two outcomes are mutually exclusive: a
 * session killed by process group cannot also exit cleanly, and a session that
 * exits cleanly leaves no tree to kill. One session cannot answer both, so
 * pretending otherwise would mean dropping one of them.
 *
 * `/exit` is submitted rather than written. It was once recorded as being
 * consumed as text, and the cause was not that it is a command: it was written
 * as one chunk ending in a carriage return, which is a bracketed paste. Under
 * `submit` it exits with code 0 and signal 0.
 */
async function runExitSession(input: {
    listener: HookListener;
    socketPath: string;
    claudePath: string;
    dir: string;
    secret: string;
}): Promise<{ sessionEnd: HookEvent | null; exitInfo: unknown }> {
    const { session, trustAtSpawn, stopEcho } = spawnSession({ ...input, echo: false });
    say('  pid     ' + String(session.pid));

    const sessionStart = await awaitStart(input.listener, session, trustAtSpawn, stopEcho);
    if (!sessionStart) {
        session.kill();
        return { sessionEnd: null, exitInfo: null };
    }

    const exited = new Promise<unknown>((resolve) => session.once('exit', resolve));
    say('  submit  /exit');
    await session.submit('/exit');

    const sessionEnd = await waitFor(input.listener, 'SessionEnd', SESSION_END_TIMEOUT_MS);
    const exitInfo = await Promise.race([exited, sleepMs(10_000).then(() => null)]);
    say('  exit    ' + JSON.stringify(exitInfo));

    if (session.alive) session.kill();
    return { sessionEnd, exitInfo };
}

/**
 * The whole run. Startup, then two sessions, then the verdict.
 *
 * Everything it reports is either a hook event that arrived or a process the
 * operating system listed. Nothing is derived from terminal output and nothing
 * is taken from the agent's account of itself.
 */
export async function runHarness(): Promise<RunResult> {
    // Truncated per run rather than appended to, so the file is this run and
    // not a pile of them with no boundary between.
    try { fs.writeFileSync(LOG_PATH, ''); } catch { /* the run matters more */ }
    try { fs.writeFileSync(HOOK_PROBE_PATH, ''); } catch { /* same */ }
    say('log     ' + LOG_PATH);
    say('startup');
    const { socketPath, claudePath } = startUp();

    const secrets = new AgentSecrets();
    const secret = secrets.issue(AGENT_ID);

    const listener = new HookListener({ socketPath, secrets });
    const events: HookEvent[] = [];
    const rejections: unknown[] = [];
    listener.on('event', (event: HookEvent) => {
        events.push(event);
        say('  hook    ' + String(event.event) +
            (event.toolName ? '  tool ' + String(event.toolName) : '') +
            (event.message ? '  ' + String(event.message).slice(0, 120) : ''));
    });
    listener.on('rejected', (info: unknown) => {
        rejections.push(info);
        say('  hook    REJECTED ' + JSON.stringify(info));
    });
    await listener.listen();
    say('  listen  ok, ' + socketPath);

    say('');
    say('scratch project');
    const { dir } = createScratchProject(socketPath);

    let tool: Awaited<ReturnType<typeof runToolSession>>;
    let exitRun: Awaited<ReturnType<typeof runExitSession>>;
    try {
        say('');
        say('session 1, the fixed tool and the process tree');
        tool = await runToolSession({ listener, socketPath, claudePath, dir, secret, seen: events });

        say('');
        say('session 2, the clean exit');
        exitRun = await runExitSession({ listener, socketPath, claudePath, dir, secret });
    } finally {
        await listener.close();
        secrets.revoke(AGENT_ID);
        fs.rmSync(dir, { recursive: true, force: true });
    }

    const result: RunResult = {
        sessionStart: tool.sessionStart,
        notification: tool.notification,
        sessionEnd: exitRun.sessionEnd,
        toolWasFixed: tool.toolWasFixed,
        childIsDescendant: tool.childIsDescendant,
        sessionLeadsItsGroup: tool.sessionLeadsItsGroup,
        nothingSurvived: tool.nothingSurvived,
        events,
        rejections,
        ok:
            tool.sessionStart !== null &&
            tool.notification !== null &&
            exitRun.sessionEnd !== null &&
            tool.toolWasFixed &&
            tool.childIsDescendant === true &&
            tool.sessionLeadsItsGroup === true &&
            tool.nothingSurvived === true
    };

    say('');
    say('results');
    say('  SessionStart observed          ' + String(result.sessionStart !== null));
    say('  Notification observed          ' + String(result.notification !== null));
    say('  SessionEnd observed            ' + String(result.sessionEnd !== null));
    say('  the tool that ran was the fixed one  ' + String(result.toolWasFixed));
    say('  session leads its own group    ' + String(result.sessionLeadsItsGroup));
    say('  child is a descendant          ' + String(result.childIsDescendant));
    say('  nothing survived the kill      ' + String(result.nothingSurvived));
    say('  hook events rejected           ' + String(result.rejections.length));

    // The asymmetry the transport rests on, measured from inside a real hook
    // rather than inferred from the fact that one connected.
    let probeLines: string[] = [];
    try { probeLines = fs.readFileSync(HOOK_PROBE_PATH, 'utf8').split('\n').filter(Boolean); } catch { probeLines = []; }
    if (probeLines.length === 0) {
        say('  hook sandbox probe             no line written, so the probe hook did not run');
    } else {
        const parsed = JSON.parse(probeLines[0] as string) as {
            results: { name: string; allowed: boolean; error: string | null }[];
        };
        say('  hook sandbox probe, from inside a real hook:');
        for (const r of parsed.results) {
            say('    ' + (r.allowed ? 'ALLOWED' : 'DENIED ') + '  ' + r.name +
                (r.error ? '  (' + r.error + ')' : ''));
        }
    }
    say('  cleaned up ' + dir);
    say('');
    say('  the whole run is in ' + LOG_PATH);
    say('  paste it with: cat ' + LOG_PATH);

    if (result.notification) {
        say('');
        say('Notification, verbatim:');
        say(JSON.stringify(result.notification, null, 2));
    }
    if (result.sessionEnd) {
        say('');
        say('SessionEnd, verbatim:');
        say(JSON.stringify(result.sessionEnd, null, 2));
    }

    return result;
}
