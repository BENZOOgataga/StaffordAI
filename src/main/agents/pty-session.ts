/**
 * One agent process inside a pseudo-terminal.
 *
 * Knows nothing about hires, projects or transports. It spawns a process,
 * streams its output, accepts input and resize, and keeps a capped tail of what
 * was printed so a client attaching late does not see a blank screen.
 *
 * **Read this before trusting the try and catch.** It protects against
 * JavaScript throws and nothing else. node-pty calls into native code, and a
 * call that lands while the ConPTY is tearing down can end the process without
 * raising a JavaScript error at all: no stack, no message, no exception to
 * catch. Wrapping such a call does not make it safe, it makes it look safe.
 *
 * So the guard is two things, and the order matters. A session is unusable the
 * moment a kill is requested, not when the exit event arrives, so write and
 * resize are refused during teardown rather than attempted and survived. The
 * try and catch is the second line, for ordinary throws such as resize on a pty
 * that has already exited.
 */

import { EventEmitter } from 'node:events';
import type { Platform } from '../platform/types.ts';
import { killTree, type KillTreeReport, type KillTreeDeps } from './kill-tree.ts';

/**
 * Sent before replayed output whenever anything was dropped. Eviction cuts the
 * stream at an arbitrary byte, which can land inside an escape sequence, so the
 * terminal is reset to a known state first.
 */
export const RESET = 'c';

export const DEFAULT_CAPACITY_BYTES = 256 * 1024;

/**
 * Delay between the text and the Enter in `submit`.
 *
 * Measured, not guessed. A single chunk ending in a carriage return is taken as
 * a paste, so the Enter lands inside the pasted text and nothing is submitted.
 * A 140 character prompt written that way was never accepted, across four
 * attempts in two runs. The same text written as two writes 400ms apart was
 * accepted every time. Raw output in docs/stack-migration-verification.md.
 */
export const SUBMIT_DELAY_MS = 400;

export interface PtyLike {
    readonly pid: number;
    onData(listener: (data: string) => void): void;
    onExit(listener: (info: { exitCode: number; signal?: number | undefined }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
}

export interface ExitInfo {
    readonly exitCode: number | null;
    readonly signal?: number | undefined;
    readonly reason?: string | undefined;
}

/**
 * Capped tail of terminal output, stored as whole chunks.
 *
 * A fullscreen repaint arrives as one large chunk and half a repaint replays as
 * garbage, so an oversized chunk is kept whole and everything older is dropped
 * instead. A hard ceiling stops one enormous chunk eating memory; past it the
 * tail is kept and the buffer records that it truncated.
 */
export class OutputBuffer {
    readonly capacityBytes: number;
    readonly maxChunkBytes: number;
    #chunks: string[] = [];
    #bytes = 0;
    #truncated = false;

    constructor(options: { capacityBytes?: number; maxChunkBytes?: number } = {}) {
        this.capacityBytes = options.capacityBytes ?? DEFAULT_CAPACITY_BYTES;
        this.maxChunkBytes = options.maxChunkBytes ?? this.capacityBytes * 4;
    }

    get bytes(): number { return this.#bytes; }
    get truncated(): boolean { return this.#truncated; }

    push(chunk: string): void {
        if (!chunk) return;

        let text = chunk;
        let size = Buffer.byteLength(text);

        if (size > this.maxChunkBytes) {
            text = text.slice(-this.maxChunkBytes);
            size = Buffer.byteLength(text);
            this.#truncated = true;
        }

        this.#chunks.push(text);
        this.#bytes += size;

        while (this.#bytes > this.capacityBytes && this.#chunks.length > 1) {
            const dropped = this.#chunks.shift() as string;
            this.#bytes -= Buffer.byteLength(dropped);
            this.#truncated = true;
        }
    }

    replay(): string {
        const body = this.#chunks.join('');
        return this.#truncated ? RESET + body : body;
    }
}

export interface PtySessionOptions {
    readonly agentId: string;
    readonly platform: Platform;
    readonly file: string;
    readonly args?: readonly string[];
    readonly cwd: string;
    readonly env: Record<string, string | undefined>;
    readonly cols?: number;
    readonly rows?: number;
    readonly capacityBytes?: number;
    readonly maxChunkBytes?: number;
    readonly spawn: (file: string, args: readonly string[], options: {
        name: string; cols: number; rows: number; cwd: string;
        env: Record<string, string | undefined>; useConpty: boolean;
    }) => PtyLike;
    readonly submitDelayMs?: number;
}

export class PtySession extends EventEmitter {
    readonly agentId: string;
    readonly platform: Platform;
    pid: number | null = null;
    exitInfo: ExitInfo | null = null;
    readonly buffer: OutputBuffer;

    #cols: number;
    #rows: number;
    #term: PtyLike | null = null;
    #exited = false;
    #killRequested = false;
    readonly #options: PtySessionOptions;

    constructor(options: PtySessionOptions) {
        super();
        if (!options.agentId) throw new Error('PtySession requires an agentId');
        if (!options.file) throw new Error('PtySession requires a file to run');

        this.agentId = options.agentId;
        this.platform = options.platform;
        this.#cols = options.cols ?? 120;
        this.#rows = options.rows ?? 34;
        this.buffer = new OutputBuffer(options);
        this.#options = options;
    }

    get alive(): boolean {
        return this.#term !== null && !this.#exited && !this.#killRequested;
    }

    get size(): { cols: number; rows: number } {
        return { cols: this.#cols, rows: this.#rows };
    }

    start(): this {
        if (this.#term) throw new Error('PtySession already started');

        const term = this.#options.spawn(this.#options.file, this.#options.args ?? [], {
            name: 'xterm-256color',
            cols: this.#cols,
            rows: this.#rows,
            cwd: this.#options.cwd,
            env: this.#options.env,
            useConpty: true
        });

        this.#term = term;
        this.pid = term.pid;

        term.onData((data) => {
            this.buffer.push(data);
            this.emit('data', data);
        });
        term.onExit((info) => this.#settle(info));

        this.emit('start', { pid: this.pid });
        return this;
    }

    /**
     * Sends a prompt and submits it, as two writes.
     *
     * This is the API callers use. `write` stays for control sequences and
     * single keystrokes, and it is deliberately not what a caller reaches for
     * when they have a prompt, because text plus a carriage return in one chunk
     * is taken as a paste and silently never submits.
     */
    async submit(text: string): Promise<boolean> {
        if (!this.write(text)) return false;
        await new Promise((resolve) => setTimeout(resolve, this.#options.submitDelayMs ?? SUBMIT_DELAY_MS));
        return this.write('\r');
    }

    /** Raw. For control sequences and keystrokes, not for prompts. */
    write(data: string): boolean {
        return this.#guard('write', () => (this.#term as PtyLike).write(data));
    }

    resize(cols: number, rows: number): boolean {
        const ok = this.#guard('resize', () => (this.#term as PtyLike).resize(cols, rows));
        if (ok) {
            this.#cols = cols;
            this.#rows = rows;
        }
        return ok;
    }

    /**
     * The plan for tearing this process tree down. Data, from the platform.
     *
     * A plan rather than a command since 2026-08-08. One command could not
     * express the POSIX procedure, which has to measure the tree before killing
     * anything, and the caller cannot be expected to already know the answer.
     * `kill-tree.ts` executes it.
     */
    killTreePlan() {
        return this.platform.killTreePlan(this.pid ?? 0);
    }

    kill(): boolean {
        // Not routed through the guard: it refuses a session whose kill has
        // been requested, which is what this is about to become. The check and
        // the flag have to happen in this order or the kill refuses itself.
        if (this.#term === null || this.#exited || this.#killRequested) return false;
        this.#killRequested = true;

        try {
            this.#term.kill();
            return true;
        } catch (error) {
            this.emit('warn', 'kill failed on agent ' + this.agentId + ': ' + (error as Error).message);
            this.#settle({ exitCode: null, reason: 'kill-failed' });
            return false;
        }
    }

    /**
     * Tears the session down by reaping its whole process tree, then node-pty.
     *
     * **This is the teardown that reaps orphans, and `kill()` is not.** node-pty
     * kills the session shell, but on Windows its console-list cleanup can leave
     * grandchildren orphaned when the shell has already exited
     * (`microsoft/node-pty#886`), and on POSIX the tool child leads its own
     * process group that a shell kill does not reach. `killTreePlan` exists for
     * exactly that, and this is where it finally runs on a real teardown rather
     * than only in the harness.
     *
     * **The order is load-bearing.** The tree is reaped first, while it is still
     * alive, because `taskkill /T` walks the live tree and the POSIX group
     * snapshot has to be taken before the root dies and reparents its children.
     * Then node-pty's own `kill()` runs, for its socket disposal: node-pty's
     * exit path destroys the output socket but disposes the conout worker only
     * inside `kill()`, so skipping it would leak a worker thread per session on
     * Windows.
     *
     * That second `kill()` forks node-pty's console-list agent for an
     * already-dead shell, which is the 886 crash. It is contained by node-pty's
     * own five-second timeout and never reaches this process, so at runtime it
     * costs a short-lived helper and nothing else. The crash only fails a test
     * runner that monitors child exits, which is why the tree-reaping proof is a
     * pty-free test and this method is unit-tested for order rather than through
     * a real pty on Windows.
     *
     * `deps` is injected so the executor can be driven without touching real
     * processes in a test.
     */
    async killWithTree(deps?: KillTreeDeps): Promise<KillTreeReport | null> {
        if (this.#term === null || this.#exited || this.#killRequested) return null;

        // Reap the whole tree while it is still alive. Not routed through the
        // guard or the kill flag: the flag would make node-pty's own kill below
        // a no-op, and node-pty's socket disposal still has to run.
        const report = await killTree(this.platform, this.pid ?? 0, deps);

        // node-pty's own teardown, for socket disposal. If reaping the tree
        // already took the shell down and node-pty has settled, this is a
        // no-op; otherwise it disposes the sockets and emits the exit.
        this.kill();
        return report;
    }

    replay(): string {
        return this.buffer.replay();
    }

    /**
     * The one way to attach to a session's output, and the reason it exists is
     * that the two-step version has a hole nobody remembers to close.
     *
     * `data` carries future chunks only and `replay()` returns what already
     * arrived, so a caller has to do both, in the right order, with nothing
     * arriving in between. A caller that only subscribes sees nothing until the
     * next byte, which on an idle agent is minutes and presents as a broken
     * terminal rather than a missed subscription. The product's normal shape is
     * a late subscriber: a session running a while, a card opened afterwards.
     *
     * So this removes the choice rather than documenting it, the way `submit()`
     * removed the bracketed-paste mistake. It replays first and then streams,
     * both in one synchronous frame. A pty `data` event is delivered from an I/O
     * callback, never synchronously with this call, so no chunk can land between
     * the replay and the listener being attached: the replay cannot miss one and
     * the stream cannot double one.
     *
     * Returns an unsubscribe. The replayed prefix is delivered as a single chunk,
     * carrying the RESET sentinel when the buffer had to drop output.
     */
    subscribe(listener: (data: string) => void): () => void {
        const buffered = this.buffer.replay();
        if (buffered.length > 0) listener(buffered);
        this.on('data', listener);
        return () => { this.off('data', listener); };
    }

    #guard(name: string, action: () => void): boolean {
        if (!this.alive) return false;
        try {
            action();
            return true;
        } catch (error) {
            this.emit('warn', name + ' failed on agent ' + this.agentId + ': ' + (error as Error).message);
            this.#settle({ exitCode: null, reason: name + '-failed' });
            return false;
        }
    }

    #settle(info: ExitInfo): void {
        if (this.#exited) return;
        this.#exited = true;
        this.exitInfo = info;

        // node-pty releases its conout socket worker only inside kill(). A pty
        // that ended by itself never takes that path, so the worker outlives
        // the process. Measured: three natural exits left three MessagePort
        // handles that never cleared, where three killed sessions left none.
        if (!this.#killRequested && this.#term) {
            this.#killRequested = true;
            try {
                this.#term.kill();
            } catch {
                // Already released, or never acquired.
            }
        }

        this.#releaseInputSocket();
        this.emit('exit', info);
    }

    /**
     * Releases the input socket node-pty leaves open.
     *
     * Its ConPTY kill path marks both sockets unreadable and disposes the
     * conout worker without destroying the conin socket, while the DLL path a
     * few lines away does destroy it. Cost of not doing this: one handle per
     * session, linear, on a runner meant to stay up for days.
     *
     * The error listener is attached before the destroy and never removed. An
     * 'error' event with no listener is an uncaught exception, and this socket
     * can emit one afterwards from a tick no try and catch of ours covers.
     *
     * Whether this applies at all, and where the socket is, come from the
     * platform layer rather than being written here. On POSIX node-pty exposes
     * no input socket, so the chain is empty and this returns immediately
     * instead of reaching for a ConPTY agent that does not exist and silently
     * finding nothing. The guard test reads the same data, so the two cannot
     * drift into disagreeing about which platforms need this.
     */
    #releaseInputSocket(): void {
        try {
            const disposal = this.platform.inputSocketDisposal();
            if (!disposal.required) return;

            let current: unknown = this.#term;
            for (const key of disposal.path) {
                if (current === null || current === undefined) return;
                current = (current as Record<string, unknown>)[key];
            }

            const socket = current as {
                destroy?: () => void; destroyed?: boolean; on?: (e: string, f: () => void) => void;
            } | null | undefined;

            if (!socket || typeof socket.destroy !== 'function') return;
            if (typeof socket.on === 'function') socket.on('error', () => {});
            if (!socket.destroyed) socket.destroy();
        } catch {
            // Best effort. A failure here costs a handle, never a session.
        }
    }
}
