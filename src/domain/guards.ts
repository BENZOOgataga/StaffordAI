/**
 * Argument guards for IPC handlers.
 *
 * Every main handler validates its arguments before acting, and validation is
 * hand-written here rather than pulled from a library: the shapes are small,
 * the dependency count stays down, and the guards are tested. A renderer is not
 * trusted, so an argument that does not match its shape is refused rather than
 * coerced.
 *
 * These take `unknown` and narrow, so a handler cannot skip the check: it has
 * nothing usable until the guard has run.
 */

import type { ProofSpawn, ProofWrite } from '../shared/ipc.ts';

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** A terminal size the proof window may ask for, bounded so a renderer cannot ask for nonsense. */
export function isProofSpawn(value: unknown): value is ProofSpawn {
    if (!isObject(value)) return false;
    const { cols, rows } = value;
    return isBoundedInt(cols, 1, 1000) && isBoundedInt(rows, 1, 1000);
}

export function isProofWrite(value: unknown): value is ProofWrite {
    if (!isObject(value)) return false;
    // A cap, because a renderer handing over an unbounded string is a memory
    // question rather than a feature. The proof window types a line at a time.
    return typeof value.data === 'string' && value.data.length <= 64 * 1024;
}

function isBoundedInt(value: unknown, min: number, max: number): boolean {
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
