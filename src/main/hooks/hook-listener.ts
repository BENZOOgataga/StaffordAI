/**
 * The hook transport. A local socket, and nothing else.
 *
 * Named pipe on Windows, socket file under Application Support on macOS, both
 * through the same `net.createServer`. No TCP listener anywhere, so there is
 * nothing to port scan and nothing reachable from off the machine.
 *
 * Three rules, and each exists because of something measured rather than
 * imagined.
 *
 * **The reply is a constant.** On Windows the default pipe descriptor grants
 * Everyone read access, so any local account can read what this writes back.
 * The reply is therefore byte-identical whether the event was accepted,
 * rejected, or unparseable. A shorter response on rejection is an oracle: it
 * tells an attacker which agent ids and secrets are real, one connection at a
 * time.
 *
 * **Connections are capped.** Everyone can also open connections. Without a cap
 * that is a runner outage; with one it is a logged rejection.
 *
 * **A secret is required and is checked against the agent id claimed.** The
 * shared token is gone. See agent-secrets.ts.
 *
 * State derivation lives in session-state.ts and this file does not import it.
 * The two are separate so that a transport decision can never again force the
 * state rules to change.
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import type { AgentSecrets } from './agent-secrets.ts';

/** Identical for every outcome. Deliberately. */
export const ACKNOWLEDGEMENT = '{"ok":true}\n';

/** A hook holds a Claude Code session open, so nothing here is allowed to be slow. */
const CONNECTION_TIMEOUT_MS = 2000;
const MAX_LINE_BYTES = 64 * 1024;
const DEFAULT_MAX_CONNECTIONS = 32;

export interface HookListenerOptions {
    readonly socketPath: string;
    readonly secrets: AgentSecrets;
    readonly maxConnections?: number;
    readonly createServer?: typeof net.createServer;
}

export interface RejectionInfo {
    /** Never includes the secret, or any part of it. */
    readonly reason:
        | 'too-many-connections'
        | 'oversized'
        | 'malformed'
        | 'no-session-id'
        | 'bad-secret';
    readonly agentId?: string | undefined;
}

/**
 * Emits `event` for anything accepted and `rejected` for anything not. The
 * caller feeds accepted events into state derivation; this file has no opinion
 * about what they mean.
 */
export class HookListener extends EventEmitter {
    readonly #socketPath: string;
    readonly #secrets: AgentSecrets;
    readonly #maxConnections: number;
    readonly #server: net.Server;
    #open = 0;
    readonly #sockets = new Set<net.Socket>();

    constructor(options: HookListenerOptions) {
        super();
        this.#socketPath = options.socketPath;
        this.#secrets = options.secrets;
        this.#maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;

        const create = options.createServer ?? net.createServer;
        this.#server = create((socket) => this.#handle(socket));
    }

    listen(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.#server.once('error', reject);
            this.#server.listen(this.#socketPath, () => resolve());
        });
    }

    /**
     * Shuts down without waiting for hook connections.
     *
     * A bare server.close() waits for every open connection to end, which
     * means a single held connection stops the runner from exiting. That is a
     * shutdown defect rather than a test problem: another local account can
     * open the pipe and Everyone has read access, so "wait politely for the
     * other side" is not a shutdown strategy.
     */
    close(): Promise<void> {
        return new Promise((resolve) => {
            for (const socket of this.#sockets) socket.destroy();
            this.#sockets.clear();
            this.#server.close(() => resolve());
        });
    }

    get openConnections(): number {
        return this.#open;
    }

    #handle(socket: net.Socket): void {
        // Tracked and handled before anything can refuse it. A rejected socket
        // is still a socket: leaving one untracked meant close() waited on it
        // forever, which is the shutdown defect this file already had once.
        this.#open += 1;
        this.#sockets.add(socket);
        socket.setTimeout(CONNECTION_TIMEOUT_MS, () => socket.destroy());
        socket.once('close', () => { this.#open -= 1; this.#sockets.delete(socket); });
        socket.on('error', () => { /* a hung-up forwarder is not an error here */ });

        // Strictly greater, because this connection is already counted.
        if (this.#open > this.#maxConnections) {
            // Answer identically and hang up. A refusal that looks different
            // from an acceptance is the oracle this is avoiding.
            this.#reject(socket, { reason: 'too-many-connections' });
            return;
        }

        let buffer = '';
        let done = false;

        socket.on('data', (chunk) => {
            if (done) return;
            buffer += chunk.toString('utf8');

            if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
                done = true;
                this.#reject(socket, { reason: 'oversized' });
                return;
            }

            const newline = buffer.indexOf('\n');
            if (newline === -1) return;

            done = true;
            this.#consume(socket, buffer.slice(0, newline));
        });
    }

    #consume(socket: net.Socket, line: string): void {
        let payload: Record<string, unknown>;
        try {
            payload = JSON.parse(line) as Record<string, unknown>;
        } catch {
            this.#reject(socket, { reason: 'malformed' });
            return;
        }

        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : undefined;
        const secret = typeof payload.secret === 'string' ? payload.secret : undefined;

        // Returned as a listener test, per docs/RETIRED-WITH-PROMISE.md. It was
        // retired from state derivation in Task 4 because that is not where the
        // check belongs: an event with no session id is not a state question,
        // it is a malformed message.
        if (!sessionId) {
            this.#reject(socket, { reason: 'no-session-id', agentId });
            return;
        }

        if (!this.#secrets.validate(agentId, secret)) {
            this.#reject(socket, { reason: 'bad-secret', agentId });
            return;
        }

        // The secret never travels further than this function.
        const { secret: _secret, ...rest } = payload;
        void _secret;

        this.#answer(socket);
        this.emit('event', rest);
    }

    #reject(socket: net.Socket, info: RejectionInfo): void {
        this.emit('rejected', info);
        this.#answer(socket);
    }

    #answer(socket: net.Socket): void {
        // One string, one place, every path. If this ever branches, the reply
        // becomes an oracle.
        socket.end(ACKNOWLEDGEMENT);
    }
}
