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
    // Opens a native folder picker and returns the chosen directory, or null if cancelled. The
    // create form uses it so a project's folder is picked, not typed; main still validates the pick.
    'dialog:pick-folder',
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
    'permissions:remove',
    // Tasks (docs/plans/TASKS.md, phase 1). Read a colleague's tasks, assign one, start it,
    // and record my decision at review.
    //
    // The same structural argument as the permission writes above applies to `tasks:review`,
    // and it is the whole reason the done-transition is safe. Approving is renderer-to-main
    // only: it arrives on a channel a colleague has no way to speak on, since a colleague
    // has no preload, no contextBridge and no ipcRenderer, and the only other route in would
    // be a tool call against the database file, which the gate denies as a protected path.
    // The lifecycle refuses a colleague reaching done as well, so the invariant holds twice
    // over: once because a colleague cannot reach the channel, and once because the rule
    // would refuse it even if it could.
    'tasks:by-hire',
    'tasks:assign',
    'tasks:start',
    'tasks:review',
    // The changed files on a task's result branch, for the review. A read, and the only task
    // channel that touches git rather than the store.
    'tasks:diff',
    // Every task across every colleague, for the board. A read, and the board writes nothing:
    // acting on a card navigates to the review surface, which uses the channels above.
    'tasks:board'
] as const;

/** How a live tool call is doing: still running, finished ok, or failed. */
export type LiveToolStatus = 'running' | 'ok' | 'error';

/**
 * One block of a colleague's turn as it streams: a run of reply text, or a tool call paired with
 * its result. The blocks are in message order, so text and tool calls interleave the way they
 * happened. A tool block carries only its name, a short target, and status, never a result body:
 * the collapsed one-liner the Conversation renders. Deliberately small, so nothing structured or
 * unbounded crosses the bridge.
 */
export type LiveBlock =
    | { readonly kind: 'text'; readonly text: string }
    | {
        readonly kind: 'tool';
        readonly id: string;
        readonly name: string;
        readonly target: string | null;
        readonly status: LiveToolStatus;
    };

/**
 * A snapshot of a colleague's turn as it streams, pushed while a chat turn is in flight. `blocks`
 * is the whole turn so far in order, not just the newest fragment, so a dropped or reordered push
 * cannot garble the view: the renderer shows the latest snapshot and reconciles against the
 * persisted message when the turn ends. Text and tool calls only; thinking and every other block
 * are excluded upstream, so this never carries them.
 */
export interface ConversationStreamDelta {
    readonly hireId: string;
    readonly blocks: readonly LiveBlock[];
}

/** Main pushes to the renderer. One-way, no reply. */
export const EVENT_CHANNELS = [
    'roster:changed',
    'channel:changed',
    // A colleague's reply text, streaming live during a chat turn. Payload: ConversationStreamDelta.
    'conversation:delta',
    'activity:appended',
    // A pending approval was added or resolved, so the renderer re-reads the list.
    'approvals:changed',
    // A permission rule was added, edited or removed, so any open config view re-reads.
    'permissions:changed',
    // A task was assigned, moved, or reviewed, so any open task view re-reads.
    'tasks:changed',
    // Main asks the shell to switch to a view, e.g. a tray click routing to the board. The
    // payload is the view name. One-way: main tells the shell where to go, nothing comes back.
    'shell:navigate'
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

/** The stored rules for a project, split the way the screens are. */
export interface PermissionRulesReply {
    readonly baseline: readonly PermissionRuleView[];
    readonly overrides: readonly PermissionRuleView[];
}

/**
 * An effective policy on a project. A hire id resolves one colleague's policy (baseline plus that
 * colleague's overrides); null resolves the project level itself (the default profile plus the
 * baseline, with no colleague overrides), which the project Permissions screen reads to show and
 * edit the default profile.
 */
export interface PermissionEffectiveRequest {
    readonly projectId: string;
    readonly hireId: string | null;
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

// --- tasks (docs/plans/TASKS.md, phase 1) -----------------------------------

/**
 * One task as the renderer sees it.
 *
 * A branch name and a commit id cross, because those are what I act on at review and both
 * are refs rather than filesystem paths. The working directory does not cross, which keeps
 * the rule that a renderer never learns where anything lives on disk.
 */
export interface TaskRow {
    readonly id: string;
    readonly hireId: string;
    readonly projectId: string;
    /** The instruction I gave, verbatim. */
    readonly text: string;
    readonly state: string;
    readonly createdAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly updatedAt: string | null;
    /** The colleague's own closing account, the first thing I read at review. Sentinel stripped. */
    readonly resultSummary: string | null;
    readonly resultBranch: string | null;
    readonly resultCommit: string | null;
    readonly failedReason: string | null;
    /** New files the colleague named as its deliverable. */
    readonly declaredOutputs: readonly string[];
    /** Named files that were not committed, with the reason, so a refusal is never silent. */
    readonly refusedOutputs: string | null;
    /** Every send-back I wrote on this task, oldest first. */
    readonly sendBacks: readonly { readonly at: string; readonly note: string }[];
    /** How many times the colleague has run this task. */
    readonly attempts: number;
    /** The Claude session, so the review can filter the transcript to this task. */
    readonly sessionId: string | null;
}

export interface TasksByHireRequest {
    readonly hireId: string;
    readonly limit: number;
}

export interface TasksReply {
    readonly rows: readonly TaskRow[];
}

/** Assigning a task: a colleague and an instruction. The project comes from the colleague. */
export interface TaskAssign {
    readonly hireId: string;
    readonly text: string;
}

export interface TaskStart {
    readonly id: string;
}

/**
 * My decision on a task waiting for me. `approve` is the only route to done, and it exists
 * on this renderer-only channel alone.
 */
export interface TaskReview {
    readonly id: string;
    readonly decision: 'approve' | 'fail' | 'send-back';
    /**
     * My reason when failing it, and my required feedback when sending it back. On a
     * send-back this becomes the next turn's instruction, which is why it cannot be empty:
     * a colleague put back to work with nothing to go on either wastes an attempt or returns
     * the same result.
     */
    readonly note: string | null;
}

/**
 * One changed file on a task's result branch.
 *
 * A repo-relative path and two counts, which is what a review needs to see the shape of a
 * change. Not the content: a diff body would put the colleague's work, and anything it read
 * into a file, through the IPC boundary and into the renderer, and the branch is right there
 * in git for the moment I want to read it properly.
 */
/** One line of a unified diff: an addition, a removal, or unchanged context. */
export type TaskDiffLineKind = 'add' | 'del' | 'context';
export interface TaskDiffLine {
    readonly kind: TaskDiffLineKind;
    /** The line's text, exactly as git emitted it, without the leading +, -, or space marker. */
    readonly text: string;
}
/** One hunk of a file's diff: the @@ header git wrote, and its lines in order. */
export interface TaskDiffHunk {
    readonly header: string;
    readonly lines: readonly TaskDiffLine[];
}
export interface TaskDiffFile {
    readonly path: string;
    readonly added: number;
    readonly removed: number;
    /** The unified-diff hunks for this file, parsed from git's own output. Empty for a binary file. */
    readonly hunks: readonly TaskDiffHunk[];
    /** True when git reported a binary change, which has counts but no line-level hunks. */
    readonly binary: boolean;
}

export interface TaskBoardRequest {
    /** How many finished tasks to include. Unfinished ones are never capped. */
    readonly closedLimit: number;
}

export interface TaskBoardReply {
    /**
     * Every unfinished task plus the most recent finished ones, most recently moved first.
     *
     * The unfinished ones are complete rather than a page, because the board exists so a task
     * waiting on me is never hidden and a limit is exactly how one would be hidden.
     */
    readonly rows: readonly TaskRow[];
    /** True when older finished tasks were left out, so the column can say so. */
    readonly closedTruncated: boolean;
}

export interface TaskDiffRequest {
    readonly id: string;
}

export interface TaskDiffReply {
    readonly files: readonly TaskDiffFile[];
    /** Why the diff could not be read, for a review that says so rather than showing nothing. */
    readonly error: string | null;
}

/** What a task write returns: the task as it now stands, or why it was refused. */
export interface TaskWriteReply {
    readonly ok: boolean;
    readonly task: TaskRow | null;
    /** The lifecycle's own refusal, when a transition was not allowed. Null on success. */
    readonly refused: string | null;
}
