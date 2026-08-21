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
    ChannelCursor, ChannelPageRequest, ChannelSinceRequest, ChannelReply, ChannelConversationRequest, ActivityByHireRequest, CheckpointAck,
    ProjectCreate, HireCreate, ApprovalAnswer,
    PermissionRulesRequest, PermissionEffectiveRequest, PermissionAdd, PermissionUpdate, PermissionRemove
} from '../shared/ipc.ts';

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** A non-empty hire id, bounded, so a renderer cannot hand over nonsense. */
function isHireId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isBoundedString(value: unknown, max: number): boolean {
    return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** A timeline cursor: a bounded timestamp and id, never a path. */
function isChannelCursor(value: unknown): value is ChannelCursor {
    return isObject(value) && isBoundedString(value.at, 64) && isBoundedString(value.id, 256);
}

/** The person's answer to a pending approval: a bounded id, a boolean, and an optional note. */
export function isApprovalAnswer(value: unknown): value is ApprovalAnswer {
    if (!isObject(value)) return false;
    if (!isHireId(value.id)) return false;
    if (typeof value.approve !== 'boolean') return false;
    return value.note === null || (typeof value.note === 'string' && value.note.length <= 4096);
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

/** A read of one colleague's own conversation, capped. Same shape as activity:by-hire. */
export function isChannelConversation(value: unknown): value is ChannelConversationRequest {
    return isObject(value) && isHireId(value.hireId) && isBoundedInt(value.limit, 1, 1000);
}

/** Acknowledging a drain's saved-work notice: a bounded drain id, no path. */
export function isCheckpointAck(value: unknown): value is CheckpointAck {
    return isObject(value) && isBoundedString(value.drainId, 256);
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


function isBoundedInt(value: unknown, min: number, max: number): boolean {
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

// --- permission configuration (phase 3) ------------------------------------
//
// These validate what the config UI sends. The write path is user-only by construction (a
// colleague has no IPC at all), so these are not the security boundary; they are the same
// distrust of renderer input every other handler applies, and they keep a malformed edit from
// reaching the store.

const ACTIONS = ['read', 'write', 'shell', 'fetch', 'delegate', 'other'] as const;
const EFFECTS = ['allow', 'deny', 'ask'] as const;

function isAction(value: unknown): boolean {
    return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

function isEffect(value: unknown): boolean {
    return typeof value === 'string' && (EFFECTS as readonly string[]).includes(value);
}

/**
 * A path scope: absolute or repo-relative, bounded, or null for a category-wide rule.
 *
 * A scope is not a path the renderer gets to act on. It is stored, then resolved against the
 * project root and the real filesystem by the gate, so nothing here can name a directory to
 * read or spawn in. A null byte is refused because it truncates a path in a C API.
 */
function isPathScope(value: unknown): boolean {
    if (value === null) return true;
    return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0');
}

export function isPermissionRulesRequest(value: unknown): value is PermissionRulesRequest {
    return isObject(value) && isBoundedString(value.projectId, 256);
}

export function isPermissionEffectiveRequest(value: unknown): value is PermissionEffectiveRequest {
    return isObject(value) && isBoundedString(value.projectId, 256) && isHireId(value.hireId);
}

export function isPermissionAdd(value: unknown): value is PermissionAdd {
    if (!isObject(value)) return false;
    if (!isBoundedString(value.projectId, 256)) return false;
    // null is a project baseline rule; a string is a colleague override. Nothing else.
    if (!(value.hireId === null || isHireId(value.hireId))) return false;
    return isAction(value.action) && isPathScope(value.pathScope) && isEffect(value.effect);
}

export function isPermissionUpdate(value: unknown): value is PermissionUpdate {
    if (!isObject(value)) return false;
    if (!isBoundedString(value.id, 256)) return false;
    return isAction(value.action) && isPathScope(value.pathScope) && isEffect(value.effect);
}

export function isPermissionRemove(value: unknown): value is PermissionRemove {
    return isObject(value) && isBoundedString(value.id, 256);
}
