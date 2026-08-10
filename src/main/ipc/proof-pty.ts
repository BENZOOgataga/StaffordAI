/**
 * The proof window's pty, wrapping PtySession for the one throwaway window.
 *
 * It exists to prove IPC and node-pty work together end to end: the renderer
 * asks main to spawn a shell, main streams its output back, the renderer types
 * into it. It uses `PtySession.subscribe`, so it inherits the replay-then-stream
 * fix and cannot lose the shell's first prompt to a late renderer.
 *
 * Thrown away with the proof window. Real terminals attach to real agent
 * sessions through the runner, not through this.
 */

import { createRequire } from 'node:module';
import os from 'node:os';
import { PtySession, type PtyLike } from '../agents/pty-session.ts';
import { currentPlatform, findPosixShell } from '../platform/index.ts';
import type { Platform } from '../platform/types.ts';

const require = createRequire(import.meta.url);

export interface ProofCallbacks {
    onData: (data: string) => void;
    onExit: (info: unknown) => void;
}

type SpawnFn = (file: string, args: readonly string[], options: Record<string, unknown>) => PtyLike;

export class ProofPty {
    #session: PtySession | null = null;
    #unsubscribe: (() => void) | null = null;
    readonly #platform: Platform;
    readonly #spawn: SpawnFn;

    /** spawn injected so a test can drive it without a real node-pty. */
    constructor(spawn?: SpawnFn) {
        this.#platform = currentPlatform();
        this.#spawn = spawn ?? (require('node-pty') as { spawn: SpawnFn }).spawn;
    }

    isOpen(): boolean {
        return this.#session !== null && this.#session.alive;
    }

    spawn(size: { cols: number; rows: number }, cb: ProofCallbacks): void {
        if (this.#session) this.kill();

        const home = os.homedir();
        const shell = findPosixShell(
            this.#platform,
            { home, nodeDir: '', parentPath: process.env.PATH ?? '' },
            () => true,
            () => null
        ) ?? '/bin/sh';

        const session = new PtySession({
            agentId: 'proof',
            platform: this.#platform,
            file: shell,
            args: ['-i'],
            cwd: home,
            env: { PATH: process.env.PATH ?? '', HOME: home, TERM: 'xterm-256color' },
            cols: size.cols,
            rows: size.rows,
            spawn: this.#spawn
        });

        // subscribe, not on('data'): replays first then streams, so the shell's
        // prompt is not lost to a renderer that attached late.
        this.#unsubscribe = session.subscribe(cb.onData);
        session.once('exit', (info: unknown) => cb.onExit(info));
        session.start();
        this.#session = session;
    }

    write(data: string): void {
        this.#session?.write(data);
    }

    kill(): void {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        // killWithTree, not kill: a shell the proof window drove may have left a
        // child of its own, and this is the teardown that reaps the whole tree
        // rather than only the shell. Fire and forget with a catch, because the
        // IPC teardown is synchronous and the proof window is throwaway; a real
        // caller such as the drain awaits the report.
        const session = this.#session;
        this.#session = null;
        void session?.killWithTree().catch(() => { /* teardown is best effort here */ });
    }
}
