/**
 * Tails one session transcript file and hands its new lines to the parser.
 *
 * It follows the file by polling its size and reading only the bytes that appeared
 * since last time, so it works the same on Windows and macOS, where a filesystem
 * watch does not. A poll costs a stat and a short read of the delta, and the timer
 * is unref'd so it never keeps the app alive.
 *
 * Three things about a live transcript shape the design. The file may not exist when
 * a session starts, so a stat that throws is a not-yet, not a failure, and the next
 * poll tries again. Claude is writing the last line as this reads, so the tail can
 * end mid-line: bytes are decoded through a StringDecoder that holds an incomplete
 * multibyte character, split on newlines, and the final partial line is buffered
 * until its newline arrives rather than parsed and discarded. And the parser is
 * total, so a line that does not parse yields no event and the tail keeps going.
 *
 * Nothing here reaches the state machine, the registry, or the drain. It reads a
 * file and calls back with events. A failure to read, or a transcript whose format
 * changed so nothing parses, produces no events and no throw, which is the feed
 * degrading to what it already shows rather than breaking.
 */

import { StringDecoder } from 'node:string_decoder';
import { parseTranscriptLine, type ActivityEvent } from './transcript-parse.ts';

/** The filesystem operations the tailer needs, injected so tests use an in-memory file. */
export interface TailerFs {
    /** The file's current size in bytes. Throws when the file does not exist yet. */
    size(path: string): number;
    /** Reads bytes [start, end) from the file. */
    read(path: string, start: number, end: number): Buffer;
}

export interface TailerDeps {
    readonly fs: TailerFs;
    /** Called with the events parsed from each poll that produced any. */
    readonly onEvents: (events: readonly ActivityEvent[]) => void;
    /** Optional debug sink for a skipped read or a format that stopped parsing. Never the transcript body. */
    readonly onDebug?: (message: string) => void;
    readonly intervalMs?: number;
    readonly setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
    readonly clearInterval?: (handle: unknown) => void;
}

export class TranscriptTailer {
    readonly #path: string;
    readonly #deps: TailerDeps;
    #offset = 0;
    #buffer = '';
    #decoder = new StringDecoder('utf8');
    #handle: unknown = null;
    #stopped = false;

    constructor(path: string, deps: TailerDeps) {
        this.#path = path;
        this.#deps = deps;
    }

    /** Reads once immediately, then follows the file on a timer. */
    start(): void {
        this.poll();
        const set = this.#deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
        const handle = set(() => this.poll(), this.#deps.intervalMs ?? 500);
        if (handle && typeof (handle as { unref?: () => void }).unref === 'function') {
            (handle as { unref: () => void }).unref();
        }
        this.#handle = handle;
    }

    /** Stops following. Idempotent. */
    stop(): void {
        this.#stopped = true;
        if (this.#handle !== null) {
            const clear = this.#deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
            clear(this.#handle);
            this.#handle = null;
        }
    }

    /**
     * One read cycle: read the bytes since the last offset, buffer a partial final
     * line, parse the complete ones, and emit any events. Public so a test can drive
     * it without a timer. Never throws: a missing file or a read error is swallowed
     * to a debug line and retried next time.
     */
    poll(): void {
        if (this.#stopped) return;

        let size: number;
        try {
            size = this.#deps.fs.size(this.#path);
        } catch {
            // Not written yet, or briefly unreadable. A not-yet, not a failure.
            return;
        }

        // The file shrank, so it was truncated or replaced. Start over from the top
        // rather than read a torn offset into the new content.
        if (size < this.#offset) {
            this.#offset = 0;
            this.#buffer = '';
            this.#decoder = new StringDecoder('utf8');
        }
        if (size <= this.#offset) return;

        let chunk: Buffer;
        try {
            chunk = this.#deps.fs.read(this.#path, this.#offset, size);
        } catch (error) {
            this.#deps.onDebug?.('transcript read skipped: ' + (error instanceof Error ? error.message : String(error)));
            return;
        }
        this.#offset = size;

        // Decode across the chunk boundary so a multibyte character split by the read
        // is held, not corrupted. Then split off the trailing partial line.
        this.#buffer += this.#decoder.write(chunk);
        const parts = this.#buffer.split('\n');
        this.#buffer = parts.pop() ?? '';

        const events: ActivityEvent[] = [];
        for (const line of parts) {
            // parseTranscriptLine is total: it never throws, so one odd line cannot
            // stop the tail. A line that yields nothing simply adds nothing.
            events.push(...parseTranscriptLine(line));
        }
        if (events.length > 0) this.#deps.onEvents(events);
    }
}
