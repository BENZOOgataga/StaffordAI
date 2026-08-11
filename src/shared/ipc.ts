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
    'projects:list',
    'roster:snapshot',
    'proof:spawn',
    'proof:write',
    'proof:kill'
] as const;

/** Main pushes to the renderer. One-way, no reply. */
export const EVENT_CHANNELS = [
    'roster:changed',
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

/**
 * A project as the renderer sees it in a list: an id and a name, never the repo
 * paths. The renderer acts on ids, and a project's `repos` are filesystem paths
 * that have no business crossing to a renderer that must not name a directory.
 */
export interface ProjectSummary {
    readonly id: string;
    readonly name: string;
}

/** The reply to `projects:list`. Bounded: projects are capped by user creation. */
export interface ProjectsList {
    readonly projects: readonly ProjectSummary[];
}

/**
 * One hire as a card on the roster. Ids and names and human text only, never a
 * repo path: the renderer acts on the id and shows the name.
 *
 * `state` and `task` are the primary fields, foregrounded on the card, because
 * the screen is people-centric: it reads as what a colleague is doing, not as a
 * telemetry row. `apprentices` and `queued` are secondary counts, shown quietly
 * and only when non-zero. `since` is when the current state began, so the
 * renderer can show elapsed time without the main process holding a clock.
 */
export interface RosterCard {
    readonly id: string;
    readonly name: string;
    readonly role: string;
    readonly state: string;
    /** Active project name, not a path. Null when the hire is on no project. */
    readonly project: string | null;
    /** The current task in one line, or null. Null until task dispatch exists. */
    readonly task: string | null;
    readonly apprentices: number;
    readonly queued: number;
    /** ISO time the current state began, for elapsed. Null with no live session. */
    readonly since: string | null;
}

/** The reply to `roster:snapshot`. Bounded: one card per hire, hires are capped. */
export interface RosterSnapshot {
    readonly cards: readonly RosterCard[];
}

/** What the proof window sends to open a pty. Ids only, no paths. */
export interface ProofSpawn {
    readonly cols: number;
    readonly rows: number;
}

export interface ProofWrite {
    readonly data: string;
}
