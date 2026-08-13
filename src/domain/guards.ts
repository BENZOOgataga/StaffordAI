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

import type { ProofSpawn, ProofWrite, SessionOpen, SessionResize, SessionWrite } from '../shared/ipc.ts';

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** A non-empty hire id, bounded, so a renderer cannot hand over nonsense. */
function isHireId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

/** Opening a card's terminal. A hire id, never a path or a session id. */
export function isSessionOpen(value: unknown): value is SessionOpen {
    return isObject(value) && isHireId(value.hireId);
}

/** A pane resize. A hire id and a bounded terminal size. */
export function isSessionResize(value: unknown): value is SessionResize {
    if (!isObject(value)) return false;
    return isHireId(value.hireId) && isBoundedInt(value.cols, 1, 1000) && isBoundedInt(value.rows, 1, 1000);
}

/** A typed message. A hire id and a bounded string; a renderer cannot hand over an unbounded one. */
export function isSessionWrite(value: unknown): value is SessionWrite {
    if (!isObject(value)) return false;
    return isHireId(value.hireId) && typeof value.text === 'string' && value.text.length <= 64 * 1024;
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
