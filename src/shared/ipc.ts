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
    'project:create',
    'hire:create',
    'roster:snapshot',
    'session:open',
    'session:close',
    'session:resize',
    'session:write',
    'channel:page',
    'channel:since',
    'channel:reply',
    'proof:spawn',
    'proof:write',
    'proof:kill'
] as const;

/** Main pushes to the renderer. One-way, no reply. */
export const EVENT_CHANNELS = [
    'roster:changed',
    'channel:changed',
    'session:data',
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
 * Creating a project. A name and one or more repo paths the renderer names for
 * validation. The paths cross main-ward only to be checked and stored; what comes
 * back is an id and a name, never a path or an internal handle.
 */
export interface ProjectCreate {
    readonly name: string;
    readonly repoPaths: readonly string[];
}

/** The reply to `project:create`: the created project's id and name. */
export interface ProjectCreated {
    readonly id: string;
    readonly name: string;
}

/**
 * Creating a hire. A name, a definition type, a display title, and the owning
 * project's id. The hire binds to that project so its cold-spawn cwd resolves.
 */
export interface HireCreate {
    readonly name: string;
    readonly type: string;
    readonly title: string;
    readonly projectId: string;
}

/** The reply to `hire:create`: the created hire's id and safe fields, no path. */
export interface HireCreated {
    readonly id: string;
    readonly name: string;
    readonly title: string;
    readonly projectId: string;
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
    /**
     * True when this session started fresh after a failed resume, so the card
     * carries a quiet note that the context was lost. A note, not an alarm.
     */
    readonly contextLost: boolean;
}

/** The reply to `roster:snapshot`. Bounded: one card per hire, hires are capped. */
export interface RosterSnapshot {
    readonly cards: readonly RosterCard[];
}

/** Opening a card's live terminal. Ids only, never a path or a session id. */
export interface SessionOpen {
    readonly hireId: string;
}

/** The reply to session:open: whether a live session is streaming. */
export interface SessionOpened {
    readonly live: boolean;
}

/** A pane resize propagated to the pty. Ids and bounded sizes only. */
export interface SessionResize {
    readonly hireId: string;
    readonly cols: number;
    readonly rows: number;
}

/** A typed message to the open card's session. A hire id and bounded text, no path. */
export interface SessionWrite {
    readonly hireId: string;
    readonly text: string;
}

/**
 * A point in the timeline, for cursor pagination: a row's ordering key. Ids and a
 * timestamp, never a path. The renderer passes back cursors it received, so it
 * never invents a position.
 */
export interface ChannelCursor {
    readonly at: string;
    readonly id: string;
}

/** Read a page of the timeline. `before` null loads the newest page; else scroll-back. */
export interface ChannelPageRequest {
    readonly before: ChannelCursor | null;
    readonly limit: number;
}

/** Read rows newer than a cursor, for appending the tail without a full re-read. */
export interface ChannelSinceRequest {
    readonly after: ChannelCursor;
    readonly limit: number;
}

/** The reply to channel:page and channel:since: rows in ascending time order. */
export interface ChannelPageReply {
    readonly rows: readonly ChannelMessageRow[];
}

/**
 * The sender id the person's own messages carry, so a row from them renders as
 * "You" and is not a reply target. A sentinel, not a hire id.
 */
export const CHANNEL_SELF_SENDER = 'benzoo';

/** An inline reply from the timeline: to the hire a row is about, sanitised. */
export interface ChannelReply {
    readonly hireId: string;
    readonly text: string;
}

/**
 * One timeline row as the renderer sees it. The channel's ChannelMessage, ids and
 * text and a typed reference, never a filesystem handle the renderer could act on.
 */
export interface ChannelMessageRow {
    readonly id: string;
    readonly projectId: string;
    readonly senderId: string;
    readonly kind: string;
    readonly body: string;
    readonly reference: { readonly kind: string; readonly value: string } | null;
    readonly at: string;
}

/** What the proof window sends to open a pty. Ids only, no paths. */
export interface ProofSpawn {
    readonly cols: number;
    readonly rows: number;
}

export interface ProofWrite {
    readonly data: string;
}
