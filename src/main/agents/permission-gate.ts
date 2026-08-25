/**
 * The permission gate: the main-process bridge between a real tool call and the pure
 * resolver (docs/plans/PERMISSION-SYSTEM.md, phase 1). It maps a Claude Code tool name and
 * input to an action, a resolved absolute path, and a command, resolves the effect against
 * a project's rules and a colleague's overrides, and returns the runner's decision.
 *
 * Path resolution happens here, against the turn's cwd, so a traversal like src/../outside
 * becomes its true absolute path before the resolver sees it and cannot widen scope. Allow
 * and deny map straight through. In phase 1 ask resolves as deny, with a message that says
 * approval is not available yet; phase 2 makes ask interactive. A thrown error is left to
 * the runner, which already treats a throwing seam as deny, so the gate fails closed.
 */

import path from 'node:path';
import { realpathSync } from 'node:fs';
import {
    resolvePermission, effectiveRules,
    type PermissionRule, type PermissionRequest, type CategoryDefaults
} from '../../domain/permissions.ts';
import { toolCategory, defaultCategoryDefaults, defaultBaselineRules } from '../../domain/permission-profile.ts';
import type { ProjectPolicy, PermissionRuleRecord } from '../../domain/models.ts';
import type { PermissionDecision, CanUseTool } from './claude-runner.ts';
import type { AskRequest, AskOutcome } from './approval-registry.ts';

export interface TurnContext {
    readonly hireId: string;
    readonly cwd: string;
    readonly projectId: string;
}

export interface PermissionGateDeps {
    /** The project's policy, for the default profile (writePaths, allowWebFetch). */
    readonly getPolicy: (projectId: string) => ProjectPolicy | null;
    /** The project's stored rules: baseline (hireId null) and colleague overrides. */
    readonly getStoredRules: (projectId: string) => readonly PermissionRuleRecord[];
    /**
     * Absolute paths a colleague must never read or write: Stafford's user-data directory,
     * which holds the permission store, the database, and the managed credential. This is
     * how the security invariant is enforced, not merely documented.
     */
    readonly protectedPaths: readonly string[];
    /**
     * This platform's path comparison rule, from `platform.normalisePath`. Lowercases on
     * darwin and win32, preserves case on linux.
     *
     * Required rather than optional, and with no default. A default would have to pick
     * between two wrong answers: identity reopens the case bypass on macOS and Windows,
     * and lowercase breaks Linux and case-sensitive volumes. A caller that has not thought
     * about it should fail to compile, not silently get one of them.
     */
    readonly normalisePath: (value: string) => string;
    /**
     * Resolves a path's symlinks, i.e. `fs.realpathSync`. Injected so the gate is testable
     * with a constructed filesystem, and defaulted because unlike the case rule there is one
     * right answer here: resolve them.
     *
     * It exists because Claude Code reports a file's real path while Stafford held the path
     * the person configured. On macOS `/tmp` and `/var` are symlinks into `/private`, so a
     * project reached through one was refused its own files once the gate started deciding.
     */
    readonly realPath?: (value: string) => string;
    /**
     * Handles an ask by pausing the turn on a pending approval until the person answers
     * (phase 2). When absent, an ask resolves as deny (the phase-1 behaviour), so the gate
     * degrades safely.
     */
    readonly onAsk?: (request: AskRequest) => Promise<AskOutcome>;
}

interface Resolved {
    readonly rules: readonly PermissionRule[];
    readonly defaults: CategoryDefaults;
    /**
     * The repo root, symlink resolved but not case folded. Cached because every request path
     * must be resolved against exactly the base the rule scopes were, and because resolving
     * it per tool call would hit the filesystem on the hot path.
     */
    readonly rawRoot: string;
}

/**
 * The real `realpath`. Native, so the answer matches what the operating system tells Claude
 * Code, which is the whole point of comparing against it.
 */
const defaultRealPath = (value: string): string => realpathSync.native(value);

/** Forward slashes, no trailing slash, so path comparison is stable across platforms. */
function norm(p: string): string {
    const forward = p.replace(/\\/g, '/');
    return forward.length > 1 && forward.endsWith('/') ? forward.slice(0, -1) : forward;
}

/**
 * The shape normalisation above, then this platform's case rule.
 *
 * **This is the security boundary, and its absence was a live bypass on two platforms.**
 * The resolver compares path scopes as strings. macOS on APFS and Windows on NTFS are
 * case insensitive, so `~/Library/Application Support/...` and `~/library/application support/...`
 * name one file and compare as two. A colleague that varied the case of a protected path
 * therefore missed the deny rule and fell through to the category default. Measured
 * 2026-08-21 against the real gate with Stafford's userData as the protected path: exact
 * case denied, lowercased allowed, case varied allowed, all three the same file. That is
 * the permission store, the database and the managed credential, so it broke the invariant
 * that a colleague can never reach its own permission config.
 *
 * The fold has to come from the platform and cannot be a `toLowerCase()`. Linux is case
 * sensitive, and so is a case-sensitive APFS volume, which is a real choice a developer
 * makes at format time. Folding there would make two genuinely different files compare
 * equal, which turns a read bypass into a write to the wrong path. `platform.normalisePath`
 * already encodes exactly this: lowercase on darwin and win32, preserved on linux.
 *
 * Both sides go through here, the rule scopes and the request path, because a fold applied
 * to one side only stops every rule from matching rather than fixing anything.
 */
function fold(normalise: (value: string) => string, p: string): string {
    return normalise(norm(p));
}

/**
 * The real path of `absolute`, resolving symlinks, for a path whose leaf may not exist yet.
 *
 * **A Write creates a file, so the thing being checked usually is not there.** `realpath`
 * fails on a missing leaf, and treating that failure as "leave the path alone" is what made
 * the symlink defect survive: the answer would be right for an existing file and wrong for a
 * new one, which is the case a Write always takes.
 *
 * So this walks up to the deepest ancestor that does exist, resolves that, and re-appends the
 * segments it peeled off. Creating `note.txt` in a symlinked project resolves the project
 * directory and keeps the leaf, with no requirement that the file exist.
 *
 * Bounded, because a filesystem that answers strangely must not spin. If nothing at all
 * resolves, the original path is returned and comparison falls back to the textual answer,
 * which is the behaviour before this function existed.
 */
export function realPathWithMissingLeaf(
    realpath: (value: string) => string, absolute: string
): string {
    let current = absolute;
    const peeled: string[] = [];
    for (let hops = 0; hops < 256; hops += 1) {
        try {
            const resolved = realpath(current);
            if (peeled.length === 0) return resolved;
            return path.join(resolved, ...peeled.reverse());
        } catch {
            const parent = path.dirname(current);
            // At the root nothing above exists either, so there is nothing left to try.
            if (parent === current) return absolute;
            peeled.push(path.basename(current));
            current = parent;
        }
    }
    return absolute;
}

/**
 * The one pipeline every path goes through before the resolver compares it: make it absolute,
 * resolve symlinks, then apply the platform's case rule.
 *
 * **The order is load bearing and both steps are.** `path.resolve` first, so a traversal like
 * `src/../outside` collapses to its true target before anything else looks at it. Then the
 * symlink resolution, because Claude Code reports the real path of a file while Stafford held
 * the path the person configured, and on macOS `/tmp` and `/var` are symlinks into `/private`,
 * so a project reached through one was refused its own files. Then the case fold last, since
 * folding before resolving would hand a lowercased path to a case-sensitive filesystem.
 *
 * Both the rule scopes and the request path go through this same function. Two paths compared
 * after different pipelines is the defect this whole file keeps re-learning.
 */
export function resolveForCompare(
    normalise: (value: string) => string,
    realpath: (value: string) => string,
    base: string,
    value: string
): string {
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value);
    return fold(normalise, realPathWithMissingLeaf(realpath, absolute));
}

function recordToRule(
    record: PermissionRuleRecord,
    rawRoot: string,
    normalise: (value: string) => string,
    realpath: (value: string) => string
): PermissionRule {
    return {
        action: record.action,
        pathScope: record.pathScope === null
            ? null
            : resolveForCompare(normalise, realpath, rawRoot, record.pathScope),
        commandPattern: record.commandPattern,
        effect: record.effect
    };
}

/** Pulls the file path a path-bearing tool names, through the same pipeline the scopes took. */
function requestPath(
    toolName: string,
    input: unknown,
    rawRoot: string,
    normalise: (value: string) => string,
    realpath: (value: string) => string
): string | null {
    if (typeof input !== 'object' || input === null) return null;
    const i = input as Record<string, unknown>;
    const keys = toolName === 'NotebookEdit' || toolName === 'NotebookRead' ? ['notebook_path'] : ['file_path', 'path'];
    for (const key of keys) {
        const value = i[key];
        if (typeof value === 'string' && value.length > 0) {
            return resolveForCompare(normalise, realpath, rawRoot, value);
        }
    }
    return null;
}

/** Pulls the command string a shell tool runs. */
function requestCommand(input: unknown): string | null {
    if (typeof input !== 'object' || input === null) return null;
    const command = (input as Record<string, unknown>).command;
    return typeof command === 'string' && command.length > 0 ? command : null;
}

function describe(request: PermissionRequest): string {
    if (request.path !== null) return request.action + ' on ' + request.path;
    if (request.command !== null) {
        const c = request.command.replace(/\s+/g, ' ').trim();
        return request.action + ' command "' + (c.length > 100 ? c.slice(0, 100) : c) + '"';
    }
    return 'a ' + request.action + ' action';
}

function decisionFor(effect: 'allow' | 'deny' | 'ask', request: PermissionRequest, input: unknown): PermissionDecision {
    if (effect === 'allow') return { behavior: 'allow', updatedInput: input };
    if (effect === 'deny') {
        return {
            behavior: 'deny',
            message: 'The project permission policy does not allow this session to ' + describe(request) +
                '. If you need it, ask the user to grant it in Stafford.'
        };
    }
    // ask, phase 1: no interactive approval yet, so block rather than proceed unapproved.
    return {
        behavior: 'deny',
        message: 'This action (' + describe(request) + ') needs the user\'s approval, which is not available yet, ' +
            'so it is blocked for now. The user can allow it in Stafford.'
    };
}

/**
 * Builds the per-turn permission function. It caches a project and colleague's resolved
 * rules for the session, since phase-1 rules are static (the default profile plus any
 * stored rules, which do not change mid-session); phase 3 refreshes on a config change.
 * There is no database read on the hot path once a project is loaded.
 */
/**
 * The gate, plus the one lever the config UI needs.
 *
 * `invalidate` exists because the rules are cached per project and colleague for the session,
 * which phase 1 chose deliberately so resolution never touches the database on the hot path.
 * That cache is also what would make an edit invisible: without this, changing a rule in the
 * UI would do nothing until Stafford restarted, and the screen would look broken while being
 * correct. Calling it drops the cache so the next turn reloads.
 *
 * It affects the NEXT turn, not one already running. A turn in flight has already resolved
 * its rules, and re-resolving mid-turn would mean a colleague's permissions changed between
 * two tool calls of the same job, which is harder to reason about than waiting for the turn
 * to end. Turns are short and serial per colleague, so the wait is brief.
 */
export type PermissionGate = ((ctx: TurnContext) => CanUseTool) & { invalidate: () => void };

export function makePermissionGate(deps: PermissionGateDeps): PermissionGate {
    const cache = new Map<string, Resolved>();

    const load = (ctx: TurnContext): Resolved => {
        const key = ctx.projectId + ' ' + ctx.hireId;
        const cached = cache.get(key);
        if (cached) return cached;

        const normalise = deps.normalisePath;
        const realpath = deps.realPath ?? defaultRealPath;

        // Two forms of the repo root, and the difference matters. `rawRoot` is symlink
        // resolved but NOT case folded, because it is the base every relative path is
        // resolved against and because it is handed back to realpath: feeding a lowercased
        // path to a case-sensitive filesystem would simply fail to resolve. `repoRoot` is
        // the folded form, which is what the rules compare against.
        const rawRoot = realPathWithMissingLeaf(realpath, path.resolve(ctx.cwd));
        const repoRoot = fold(normalise, rawRoot);

        const policy = deps.getPolicy(ctx.projectId);
        const writePaths = policy?.writePaths
            ? policy.writePaths.map((p) => resolveForCompare(normalise, realpath, rawRoot, p))
            : null;
        const profile = defaultBaselineRules({
            repoRoot,
            writePaths,
            // Through the same pipeline as everything else. These are the paths a colleague
            // must never reach, so resolving them differently is the one place a mismatch
            // becomes a bypass rather than a false deny. A protected directory reached via a
            // symlink still resolves to the real one and still protects it.
            protectedPaths: deps.protectedPaths.map((p) => resolveForCompare(normalise, realpath, rawRoot, p))
        });
        const stored = deps.getStoredRules(ctx.projectId);
        const storedBaseline = stored.filter((r) => r.hireId === null)
            .map((r) => recordToRule(r, rawRoot, normalise, realpath));
        const overrides = stored.filter((r) => r.hireId === ctx.hireId)
            .map((r) => recordToRule(r, rawRoot, normalise, realpath));

        const rules = effectiveRules([...profile, ...storedBaseline], overrides);
        const defaults = defaultCategoryDefaults(policy?.allowWebFetch ?? false);
        const resolved: Resolved = { rules, defaults, rawRoot };
        cache.set(key, resolved);
        return resolved;
    };

    const gate = ((ctx: TurnContext): CanUseTool => (toolName, input) => {
        const { rules, defaults, rawRoot } = load(ctx);
        const request: PermissionRequest = {
            action: toolCategory(toolName),
            // The same pipeline the scopes took, against the same resolved root. Both sides
            // or neither, which is the rule this file exists to keep.
            path: requestPath(toolName, input, rawRoot, deps.normalisePath, deps.realPath ?? defaultRealPath),
            command: requestCommand(input)
        };
        const effect = resolvePermission(rules, request, defaults);

        // An ask pauses the turn on a pending approval when a handler is wired; the seam
        // awaits it and resolves to allow on approve or deny on deny. Without a handler it
        // falls to the phase-1 deny below, so the gate never hangs waiting on nothing.
        if (effect === 'ask' && deps.onAsk) {
            return deps.onAsk({ hireId: ctx.hireId, action: request.action, path: request.path, command: request.command })
                .then((outcome): PermissionDecision => outcome.approve
                    ? { behavior: 'allow', updatedInput: input }
                    : {
                        behavior: 'deny',
                        message: outcome.note && outcome.note.trim().length > 0
                            ? outcome.note.trim()
                            : 'The user denied this action.'
                    });
        }
        return decisionFor(effect, request, input);
    }) as PermissionGate;

    // Drops every project's cached rules. Cheap, and correct even though it is broader than
    // the edited project: the next turn for any colleague simply reloads, which is the same
    // work a first turn already does.
    gate.invalidate = (): void => { cache.clear(); };

    return gate;
}
