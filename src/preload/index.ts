/**
 * Preload. Exposes exactly one frozen object through `contextBridge`.
 *
 * `ipcRenderer` never reaches the renderer. The renderer gets named methods
 * that wrap `ipcRenderer.invoke` and `on`, and the channel names come from the
 * shared allowlist rather than from the caller, so a renderer cannot reach a
 * channel main did not intend. Any name off the allowlist is refused here, in
 * the trusted context, before it can reach `ipcRenderer` at all.
 *
 * Section 6 of `docs/plans/stack-migration.technical.md` is the specification.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
    isInvokeChannel, isEventChannel, type InvokeChannel, type EventChannel, type HealthReport
} from '../shared/ipc.ts';

function invoke(channel: InvokeChannel, payload?: unknown): Promise<unknown> {
    // Belt and braces: the type says InvokeChannel, but the renderer is
    // untrusted and TypeScript is gone at runtime, so the name is checked
    // against the allowlist here rather than assumed.
    if (!isInvokeChannel(channel)) {
        return Promise.reject(new Error('refused: ' + String(channel) + ' is not an allowed channel'));
    }
    return ipcRenderer.invoke(channel, payload);
}

function on(channel: EventChannel, listener: (payload: unknown) => void): () => void {
    if (!isEventChannel(channel)) {
        throw new Error('refused: ' + String(channel) + ' is not an allowed event channel');
    }
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => { ipcRenderer.removeListener(channel, wrapped); };
}

/**
 * The one object the renderer sees. Frozen, so the renderer cannot rewrite a
 * method to reach a channel it should not. Method names, not raw channels, so
 * the surface is exactly what is written here.
 */
const api = Object.freeze({
    health: (): Promise<HealthReport> => invoke('health') as Promise<HealthReport>,

    // The proof window's surface, thrown away with that window when real UI
    // lands. Ids and sizes only, never a path.
    proof: Object.freeze({
        spawn: (size: { cols: number; rows: number }): Promise<{ ok: boolean }> =>
            invoke('proof:spawn', size) as Promise<{ ok: boolean }>,
        write: (data: string): Promise<void> => invoke('proof:write', { data }) as Promise<void>,
        kill: (): Promise<void> => invoke('proof:kill') as Promise<void>,
        onData: (listener: (data: string) => void): (() => void) =>
            on('proof:data', (payload) => listener(String(payload))),
        onExit: (listener: (info: unknown) => void): (() => void) =>
            on('proof:exit', listener)
    })
});

contextBridge.exposeInMainWorld('stafford', api);

export type StaffordApi = typeof api;
