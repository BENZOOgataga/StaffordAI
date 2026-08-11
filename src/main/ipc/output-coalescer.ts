/**
 * Batches a burst of pty output into one IPC message per frame.
 *
 * A fullscreen TUI emits many small writes, and one `webContents.send` per write
 * floods the channel and wastes serialisation. This accumulates chunks and flushes
 * the joined string on a schedule, so a burst becomes one send. `webContents.send`
 * does not block on the renderer, so the main thread never stalls on a slow one;
 * the cost this avoids is building and serialising thousands of tiny messages.
 *
 * The schedule is injected so a test drives it by hand. The default is a short
 * unref'd timer, which coalesces a same-turn burst and never itself holds the app
 * open at quit.
 */

export interface CoalescerDeps {
    /** Where the joined output goes. In the shell, `webContents.send('session:data', data)`. */
    readonly sink: (data: string) => void;
    /** Schedules a flush. Default is a short unref'd timer. */
    readonly schedule?: (flush: () => void) => void;
}

const defaultSchedule = (flush: () => void): void => {
    const timer = setTimeout(flush, 8);
    timer.unref?.();
};

export class OutputCoalescer {
    readonly #sink: (data: string) => void;
    readonly #schedule: (flush: () => void) => void;
    #pending: string[] = [];
    #scheduled = false;
    #disposed = false;

    constructor(deps: CoalescerDeps) {
        this.#sink = deps.sink;
        this.#schedule = deps.schedule ?? defaultSchedule;
    }

    /** Queues a chunk and arms a flush if one is not already pending. */
    push(chunk: string): void {
        if (this.#disposed || chunk.length === 0) return;
        this.#pending.push(chunk);
        if (!this.#scheduled) {
            this.#scheduled = true;
            this.#schedule(() => this.flush());
        }
    }

    /** Sends everything queued as one message. A no-op when nothing is queued. */
    flush(): void {
        this.#scheduled = false;
        if (this.#disposed || this.#pending.length === 0) return;
        const data = this.#pending.join('');
        this.#pending = [];
        this.#sink(data);
    }

    /** Stops streaming: drops what is queued and refuses further pushes and flushes. */
    dispose(): void {
        this.#disposed = true;
        this.#pending = [];
    }
}
