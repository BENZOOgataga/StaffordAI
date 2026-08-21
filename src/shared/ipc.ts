/**
 * The IPC contract, shared by main and preload so both read one list.
 *
 * Channels are an explicit allowlist, not a prefix pattern. The preload refuses
 * any name not here, and main registers a handler for exactly these. A name in
 * one place and not the other is a mismatch a test catches, which is the point
 * of the list being data both sides import rather than two strings that can
 * drift.
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
    'channel:page',
    'channel:since',
    'channel:conversation',
    'channel:reply',
    'activity:by-hire',
    'checkpoints:saved',
    'checkpoints:ack',
    // The pending permission approvals (phase 2 ASK), and the person's answer.
    'approvals:pending',
    'approval:answer',
    // Permission configuration (phase 3). Read the rules for a project, read a colleague's
    // effective policy with its attribution, and write rules.
    //
    // These are renderer-to-main only, like every channel in this list, and that is the whole
    // security story for the write path. A colleague never reaches them: it speaks
    // stream-json to Claude Code over its own stdin and stdout, it has no preload, no
    // contextBridge and no ipcRenderer, and the only other way in would be a tool call
    // against the database file, which the gate denies because userData is a protected path.
    // So "only I set permissions" holds by construction rather than by convention.
    'permissions:rules',
    'permissions:effective',
    'permissions:add',
    'permissions:update',
    'permissions:remove'
] as const;

/** Main pushes to the renderer. One-way, no reply. */
export const EVENT_CHANNELS = [
    'roster:changed',
    'channel:changed',
    'activity:appended',
    // A pending approval was added or resolved, so the renderer re-reads the list.
    'approvals:changed',
    // A permission rule was added, edited or removed, so any open config view re-reads.
    'permissions:changed'
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
export type EventChannel = (typeof EVENT_CHANNELS)[number];

export function isInvokeChannel(name: unknown): name is InvokeChannel {
    return typeof name === 'string' && (INVOKE_CHANNELS as readonly string[]).includes(name);
}

export function isEventChannel(name: unknown): name is EventChannel {
    return typeof name === 'string' && (EVENT_CHANNELS as readonly string[]).includes(name);
}

/**
 * The window-control channels, a separate allowlist from the data IPC above. These act on
 * the BrowserWindow chrome (minimize, maximize/restore, close, and the maximized-state
 * query and change signal) for the custom frameless title bar, not on the store, so they
 * are kept out of the data handler map and its coverage. close routes through the window's
 * existing close handler, which hides to the tray rather than quitting, so the frameless
 * title bar preserves the tray-resident behaviour.
 */
export const WINDOW_INVOKE_CHANNELS = [
    'window:minimize',
    'window:toggle-maximize',
    'window:close',
    'window:is-maximized'
] as const;

export const WINDOW_EVENT_CHANNELS = ['window:maximized-changed'] as const;

export type WindowInvokeChannel = (typeof WINDOW_INVOKE_CHANNELS)[number];
export type WindowEventChannel = (typeof WINDOW_EVENT_CHANNELS)[number];

export function isWindowInvokeChannel(name: unknown): name is WindowInvokeChannel {
    return typeof name === 'string' && (WINDOW_INVOKE_CHANNELS as readonly string[]).includes(name);
}

export function isWindowEventChannel(name: unknown): name is WindowEventChannel {
    return typeof name === 'string' && (WINDOW_EVENT_CHANNELS as readonly string[]).includes(name);
}

export interface HealthReport {
    readonly ok: boolean;
    readonly platform: string;
    readonly startedAt: string;
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
    /**
     * The active project's id, for a view that has to act rather than only display, such as
     * the permissions tab naming the project whose rules it is reading. Still an id, never a
     * path, so the rule that a renderer cannot name a directory is unchanged.
     */
    readonly projectId: string | null;
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

/** A read of one colleague's own conversation, keyed by hire and capped. */
export interface ChannelConversationRequest {
    readonly hireId: string;
    readonly limit: number;
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

/** A coalesced action's outcome, as the renderer sees it. */
export type ActivityToolStatus = 'ok' | 'error' | 'incomplete';

/**
 * One tool action as the renderer sees it: the tool, its target (a path or command,
 * never file contents), a status, and when. `live` marks a row pushed while the
 * colleague is open that is not in the persisted history, a read or search that the
 * store deliberately drops; it is present in the moment and gone on reopen.
 */
export interface ActivityRow {
    readonly id: string;
    readonly hireId: string;
    readonly tool: string;
    readonly target: string | null;
    readonly status: ActivityToolStatus | null;
    readonly at: string;
    readonly live: boolean;
}

export interface ActivityByHireRequest {
    readonly hireId: string;
    readonly limit: number;
}

/** The reply to activity:by-hire: the persisted accomplishment rows, oldest-first. */
export interface ActivityByHireReply {
    readonly rows: readonly ActivityRow[];
}

/** One colleague's saved work from a drain: the name and the checkpoint branch it is on. */
export interface SavedWork {
    readonly name: string;
    readonly branch: string;
}

/**
 * The saved work from the most recent drain that committed anything, for the launch
 * notice. `drainId` identifies the drain so the person's dismissal marks that one
 * seen and it does not reappear. Null (not this type) when there is nothing to show.
 */
export interface SavedCheckpoints {
    readonly drainId: string;
    readonly saves: readonly SavedWork[];
}

/** Marks a drain's saved-work notice seen, so it does not show again. */
export interface CheckpointAck {
    readonly drainId: string;
}

/**
 * One permission ask waiting on the person (phase 2). A colleague's turn is paused at this
 * tool call until the person approves or denies it. action is the category; path or command
 * is what the tool wants to touch. Kept to what the prompt shows, no file contents.
 */
export interface PendingApproval {
    readonly id: string;
    readonly hireId: string;
    readonly action: string;
    readonly path: string | null;
    readonly command: string | null;
    readonly at: string;
}

/** The current pending approvals, for the approvals surface. */
export interface PendingApprovals {
    readonly pending: readonly PendingApproval[];
}

/** The person's answer to one pending approval. The note becomes the deny reason. */
export interface ApprovalAnswer {
    readonly id: string;
    readonly approve: boolean;
    readonly note: string | null;
}


// --- permission configuration (phase 3) ------------------------------------

/** One rule as the config view shows it. The id is what an edit or a removal names. */
export interface PermissionRuleView {
    readonly id: string;
    /** null for a project baseline rule, a hire id for a colleague override. */
    readonly hireId: string | null;
    readonly action: PermissionActionName;
    readonly pathScope: string | null;
    readonly commandPattern: string | null;
    readonly effect: PermissionEffectName;
    readonly createdAt: string;
}

/** The action categories, as strings, so the renderer needs no domain import. */
export type PermissionActionName = 'read' | 'write' | 'shell' | 'fetch' | 'delegate' | 'other';
export type PermissionEffectName = 'allow' | 'deny' | 'ask';

/** Which rules a config view is asking for. */
export interface PermissionRulesRequest {
    readonly projectId: string;
}

/**
 * One group of the generated protection, as a summary row.
 *
 * A count and an effect rather than the rules themselves, because the point of grouping is
 * that twenty-four secret denies are one idea. `rules` carries the detail for when I expand it.
 */
export interface ProfileGroupView {
    readonly id: 'project-files' | 'protected-locations' | 'secret-files' | 'destructive-commands';
    /** How many locations, patterns or commands the group covers. */
    readonly covers: number;
    /** The single effect the group applies, or null when it is not uniform. */
    readonly effect: PermissionEffectName | null;
    /** The scopes or patterns, for the expanded view. Bounded by the profile itself. */
    readonly detail: readonly string[];
}

/** The stored rules for a project, split the way the screens are, plus what is always on. */
export interface PermissionRulesReply {
    /**
     * The generated protection that applies whether or not I have written any rules. Sent so a
     * project with no stored rules shows what governs it instead of an empty list, which read
     * as broken when it was in fact fully protected.
     */
    readonly builtIn: readonly ProfileGroupView[];
    readonly baseline: readonly PermissionRuleView[];
    readonly overrides: readonly PermissionRuleView[];
}

/** A colleague's effective policy on a project. */
export interface PermissionEffectiveRequest {
    readonly projectId: string;
    readonly hireId: string;
}

/** One row of a colleague's effective policy, with where it came from. */
export interface EffectiveRuleView {
    readonly action: PermissionActionName;
    readonly pathScope: string | null;
    readonly commandPattern: string | null;
    readonly effect: PermissionEffectName;
    readonly source: 'baseline' | 'override' | 'default-profile';
    readonly overridesBaseline: boolean;
    readonly replacedEffect: PermissionEffectName | null;
}

export interface PermissionEffectiveReply {
    /** The same grouped protection the project screen shows, so the two agree. */
    readonly builtIn: readonly ProfileGroupView[];
    /**
     * The rules worth reading one by one: what I wrote for the project and what I wrote for
     * this colleague, with their attribution. The generated rules are in `builtIn` instead, so
     * my own handful is not buried under forty-seven rows that all say the same thing.
     */
    readonly rules: readonly EffectiveRuleView[];
}

/**
 * Adding a rule. `hireId` null makes it a project baseline, a hire id makes it that
 * colleague's override. `commandPattern` is not settable here: the destructive shell patterns
 * come from the default profile and are shown read-only, so this phase cannot author a regex
 * that would silently stop matching when malformed.
 */
export interface PermissionAdd {
    readonly projectId: string;
    readonly hireId: string | null;
    readonly action: PermissionActionName;
    readonly pathScope: string | null;
    readonly effect: PermissionEffectName;
}

/** Editing a rule in place. Its project and colleague are fixed; only the scope moves. */
export interface PermissionUpdate {
    readonly id: string;
    readonly action: PermissionActionName;
    readonly pathScope: string | null;
    readonly effect: PermissionEffectName;
}

export interface PermissionRemove {
    readonly id: string;
}

/** What a write returns: whether it landed, and any warning worth showing after the fact. */
export interface PermissionWriteReply {
    readonly ok: boolean;
    /** Set when the rule weakens protection of the user-only config. Advisory, never a block. */
    readonly warning: string | null;
}
