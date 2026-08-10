/**
 * The IPC contract, shared by main and preload so both read one list.
 *
 * Channels are an explicit allowlist, not a prefix pattern. The preload refuses
 * any name not here, and main registers a handler for exactly these. A name in
 * one place and not the other is a mismatch a test catches, which is the point
 * of the list being data both sides import rather than two strings that can
 * drift.
 *
 * Task 7a carries the smallest set that proves the shell works end to end:
 *  - health, a status call replacing the retired token endpoint;
 *  - the proof window's pty channels, deliberately minimal and thrown away with
 *    that window when real UI lands.
 *
 * The renderer acts on ids, never on filesystem paths. Nothing here lets a
 * renderer name a directory to spawn in or a file to read.
 */

/** Renderer invokes, main replies. Request/response. */
export const INVOKE_CHANNELS = [
    'health',
    'proof:spawn',
    'proof:write',
    'proof:kill'
] as const;

/** Main pushes to the renderer. One-way, no reply. */
export const EVENT_CHANNELS = [
    'proof:data',
    'proof:exit'
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
export type EventChannel = (typeof EVENT_CHANNELS)[number];

export function isInvokeChannel(name: unknown): name is InvokeChannel {
    return typeof name === 'string' && (INVOKE_CHANNELS as readonly string[]).includes(name);
}

export function isEventChannel(name: unknown): name is EventChannel {
    return typeof name === 'string' && (EVENT_CHANNELS as readonly string[]).includes(name);
}

export interface HealthReport {
    readonly ok: boolean;
    readonly platform: string;
    readonly startedAt: string;
    readonly ptyOpen: boolean;
}

/** What the proof window sends to open a pty. Ids only, no paths. */
export interface ProofSpawn {
    readonly cols: number;
    readonly rows: number;
}

export interface ProofWrite {
    readonly data: string;
}
