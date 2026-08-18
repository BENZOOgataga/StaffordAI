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

import type {
    ProofSpawn, ProofWrite, SessionOpen, SessionResize, SessionWrite,
    ChannelCursor, ChannelPageRequest, ChannelSinceRequest, ChannelReply, ActivityByHireRequest,
    ProjectCreate, HireCreate
} from '../shared/ipc.ts';

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

function isBoundedString(value: unknown, max: number): boolean {
    return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** A timeline cursor: a bounded timestamp and id, never a path. */
function isChannelCursor(value: unknown): value is ChannelCursor {
    return isObject(value) && isBoundedString(value.at, 64) && isBoundedString(value.id, 256);
}

/** A page read. `before` is null for the newest page, or a cursor for scroll-back. */
export function isChannelPage(value: unknown): value is ChannelPageRequest {
    if (!isObject(value)) return false;
    const okBefore = value.before === null || isChannelCursor(value.before);
    return okBefore && isBoundedInt(value.limit, 1, 500);
}

/** A read of one colleague's persisted activity, capped. */
export function isActivityByHire(value: unknown): value is ActivityByHireRequest {
    return isObject(value) && isHireId(value.hireId) && isBoundedInt(value.limit, 1, 1000);
}

/** A tail read: rows after a cursor, capped. */
export function isChannelSince(value: unknown): value is ChannelSinceRequest {
    return isObject(value) && isChannelCursor(value.after) && isBoundedInt(value.limit, 1, 500);
}

/** An inline reply: a hire id and a bounded string, the same shape a session write takes. */
export function isChannelReply(value: unknown): value is ChannelReply {
    if (!isObject(value)) return false;
    return isHireId(value.hireId) && typeof value.text === 'string' && value.text.length <= 64 * 1024;
}

/**
 * Creating a project: a bounded name and a bounded, non-empty list of bounded repo
 * paths. The path is validated as a real directory in the create logic, not here;
 * this only refuses a malformed shape or an unbounded string a renderer hands over.
 */
export function isProjectCreate(value: unknown): value is ProjectCreate {
    if (!isObject(value)) return false;
    if (!isBoundedString(value.name, 256)) return false;
    if (!Array.isArray(value.repoPaths) || value.repoPaths.length === 0 || value.repoPaths.length > 64) {
        return false;
    }
    return value.repoPaths.every((path) => isBoundedString(path, 4096));
}

/** Creating a hire: bounded name, type, title, and an owning project id. */
export function isHireCreate(value: unknown): value is HireCreate {
    if (!isObject(value)) return false;
    return isBoundedString(value.name, 256)
        && isBoundedString(value.type, 256)
        && isBoundedString(value.title, 256)
        && isBoundedString(value.projectId, 256);
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
