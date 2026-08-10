/**
 * The IPC handlers, registered against the shared allowlist.
 *
 * Every invoke channel gets exactly one handler and every handler validates its
 * arguments with a guard from `src/domain/guards.ts` before acting. The
 * registration is keyed off `INVOKE_CHANNELS`, so a channel added to the
 * allowlist without a handler here, or a handler here for a channel not on the
 * allowlist, is a mismatch a test catches.
 *
 * The renderer acts on ids and sizes, never on paths. Nothing here reads a
 * filename or a directory the renderer named.
 */

import type { IpcMain, WebContents } from 'electron';
import { INVOKE_CHANNELS, type InvokeChannel, type HealthReport, type ProjectsList } from '../../shared/ipc.ts';
import { isProofSpawn, isProofWrite } from '../../domain/guards.ts';
import type { ProofPty } from './proof-pty.ts';

export interface HandlerDeps {
    readonly startedAt: string;
    readonly platformId: string;
    readonly proof: ProofPty;
    /** Where proof:data and proof:exit are pushed. */
    readonly sender: () => WebContents | null;
    /**
     * A read-only, bounded list of projects as summaries, ids and names only.
     * A function rather than the repository itself, so the handler stays
     * injectable and testable and never reaches for the store directly.
     */
    readonly listProjects: () => ProjectsList;
}

/**
 * The handler for each invoke channel, as a map so a test can assert the keys
 * are exactly the allowlist without electron. Each returns a value or throws;
 * a throw becomes a rejected invoke on the renderer side.
 */
export function buildHandlers(deps: HandlerDeps): Record<InvokeChannel, (payload: unknown) => unknown> {
    return {
        health: (): HealthReport => ({
            ok: true,
            platform: deps.platformId,
            startedAt: deps.startedAt,
            ptyOpen: deps.proof.isOpen()
        }),

        // Read-only. No payload, like health, so no argument guard: it takes
        // nothing from the renderer to act on. It exists to exercise the store's
        // mapping and query path on every run rather than only under the smoke
        // flag.
        'projects:list': (): ProjectsList => deps.listProjects(),

        'proof:spawn': (payload: unknown): { ok: boolean } => {
            if (!isProofSpawn(payload)) throw new Error('proof:spawn requires {cols,rows}');
            deps.proof.spawn(payload, {
                onData: (data) => deps.sender()?.send('proof:data', data),
                onExit: (info) => deps.sender()?.send('proof:exit', info)
            });
            return { ok: true };
        },

        'proof:write': (payload: unknown): void => {
            if (!isProofWrite(payload)) throw new Error('proof:write requires {data}');
            deps.proof.write(payload.data);
        },

        'proof:kill': (): void => { deps.proof.kill(); }
    };
}

/** Wires the handler map into electron's ipcMain, one `handle` per channel. */
export function registerHandlers(ipcMain: IpcMain, deps: HandlerDeps): void {
    const handlers = buildHandlers(deps);
    for (const channel of INVOKE_CHANNELS) {
        ipcMain.handle(channel, (_event, payload: unknown) => handlers[channel](payload));
    }
}
