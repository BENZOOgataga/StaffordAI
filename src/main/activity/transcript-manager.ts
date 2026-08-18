/**
 * Runs one transcript tailer per live colleague and tags its events with who they
 * came from.
 *
 * This is the seam between the hook stream and the rich feed, and it is deliberately
 * a dead end for the state machine. It reads three fields off a hook record, the
 * event name, the agent id, and the transcript path Claude puts on every payload,
 * and it starts tailing that path the first time it sees it for an agent. It never
 * calls the registry, never derives state, never touches the drain. A test asserts
 * the module cannot even import those, so a broken transcript parse has nothing to
 * break: the worst case is no rich events, and the feed shows the hook-based state
 * rows it already shows.
 *
 * Binding is by agent id, the same id the spawn sets and the forwarder echoes on
 * every event, so the rich events attribute to the same colleague the state feed
 * attributes to, without sharing the registry's binding logic. A SessionEnd stops
 * that agent's tailer; quit stops them all.
 */

import { statSync, openSync, readSync, closeSync } from 'node:fs';
import { TranscriptTailer } from './transcript-tailer.ts';
import type { ActivityEvent } from './transcript-parse.ts';

/** The slice of a hook record the manager reads. Everything else is the state feed's. */
export interface TranscriptObservation {
    readonly event: string;
    readonly agentId: string | null;
    readonly sessionId: string | null;
    readonly transcriptPath: string | null;
}

/** An activity event with the colleague and session it belongs to, and when it was tailed. */
export interface TaggedActivityEvent extends ActivityEvent {
    readonly agentId: string;
    readonly sessionId: string | null;
    readonly at: string;
}

/** A started tailer. TranscriptTailer satisfies this; a test passes a fake. */
export interface Tailer {
    start(): void;
    stop(): void;
}

export interface ManagerDeps {
    /** Builds a tailer for a path, delivering parsed events to the sink. Defaults to a real TranscriptTailer. */
    readonly makeTailer?: (path: string, onEvents: (events: readonly ActivityEvent[]) => void) => Tailer;
    /** Receives tagged events. In piece 1 this is a proof log; piece 2 persists. */
    readonly onEvents: (events: readonly TaggedActivityEvent[]) => void;
    /** Called when an agent's session ends, so a consumer can flush in-flight actions. */
    readonly onSessionEnd?: (agentId: string) => void;
    readonly now: () => string;
    readonly onDebug?: (message: string) => void;
}

/** Reads the manager's slice off a raw hook record, tolerating missing fields. */
export function coerceObservation(raw: Record<string, unknown>): TranscriptObservation {
    const s = (key: string): string | null => (typeof raw[key] === 'string' ? (raw[key] as string) : null);
    return {
        event: s('event') ?? '',
        agentId: s('agentId'),
        sessionId: s('sessionId'),
        transcriptPath: s('transcriptPath')
    };
}

export class TranscriptManager {
    readonly #deps: ManagerDeps;
    readonly #tailers = new Map<string, Tailer>();

    constructor(deps: ManagerDeps) {
        this.#deps = deps;
    }

    /** How many tailers are running. For proofs and diagnostics. */
    get activeCount(): number {
        return this.#tailers.size;
    }

    /**
     * Reacts to one hook observation. A SessionEnd stops the agent's tailer; any
     * event carrying a transcript path starts one for that agent if none runs yet.
     * Everything else is ignored. Bound by agent id, so a resume's later events do
     * not start a second tailer for the same colleague.
     */
    observe(o: TranscriptObservation): void {
        if (o.event === 'SessionEnd') {
            if (o.agentId) {
                this.#stop(o.agentId);
                this.#deps.onSessionEnd?.(o.agentId);
            }
            return;
        }
        if (!o.agentId || !o.transcriptPath) return;
        if (this.#tailers.has(o.agentId)) return;

        const agentId = o.agentId;
        const sessionId = o.sessionId;
        const make = this.#deps.makeTailer ?? ((path, onEvents) => this.#realTailer(path, onEvents));
        const tailer = make(o.transcriptPath, (events) => {
            const at = this.#deps.now();
            this.#deps.onEvents(events.map((e) => ({ ...e, agentId, sessionId, at })));
        });
        this.#tailers.set(agentId, tailer);
        tailer.start();
        this.#deps.onDebug?.('tailing transcript for ' + agentId);
    }

    /** Stops every tailer. Called at quit. */
    stopAll(): void {
        for (const tailer of this.#tailers.values()) tailer.stop();
        this.#tailers.clear();
    }

    #stop(agentId: string): void {
        const tailer = this.#tailers.get(agentId);
        if (!tailer) return;
        tailer.stop();
        this.#tailers.delete(agentId);
    }

    #realTailer(path: string, onEvents: (events: readonly ActivityEvent[]) => void): Tailer {
        return new TranscriptTailer(path, {
            fs: {
                size: (p) => statSync(p).size,
                read: (p, start, end) => {
                    const fd = openSync(p, 'r');
                    try {
                        const length = end - start;
                        const buffer = Buffer.alloc(length);
                        readSync(fd, buffer, 0, length, start);
                        return buffer;
                    } finally {
                        closeSync(fd);
                    }
                }
            },
            onEvents,
            ...(this.#deps.onDebug ? { onDebug: this.#deps.onDebug } : {})
        });
    }
}
