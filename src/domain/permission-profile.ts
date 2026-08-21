/**
 * The action-category mapping and the default permission profile, pure and tested
 * (docs/plans/PERMISSION-SYSTEM.md, phase 1). This grounds the policy in the real Claude
 * Code tool names and produces the baseline rules a project starts with before any are
 * stored. No Electron, no filesystem: the caller passes already-resolved absolute paths.
 */

import type { PermissionRule, PermissionAction, CategoryDefaults } from './permissions.ts';

/**
 * Maps a real Claude Code tool name to a category. The path-bearing tools are read and
 * write; Bash and the shell are shell; the network tools are fetch; Task is delegate; and
 * everything else, including TodoWrite and the mcp__ tools, is other, which defaults
 * conservatively so a new capability surfaces rather than passing silently.
 */
export function toolCategory(toolName: string): PermissionAction {
    switch (toolName) {
        case 'Read':
        case 'LS':
        case 'Glob':
        case 'Grep':
        case 'NotebookRead':
            return 'read';
        case 'Write':
        case 'Edit':
        case 'MultiEdit':
        case 'NotebookEdit':
            return 'write';
        case 'Bash':
        case 'PowerShell':
            return 'shell';
        case 'WebFetch':
        case 'WebSearch':
            return 'fetch';
        case 'Task':
            return 'delegate';
        default:
            return 'other';
    }
}

/**
 * Regular-expression sources, matched case-insensitively, for the genuinely destructive
 * shell commands the default profile pauses on: a force push, a branch deletion, a hard
 * reset, a history rewrite, and a recursive force delete. This is best-effort by design;
 * the command string is not a clean path, so this catches the common shapes and the strong
 * path guarantees live in the read and write categories, not here.
 */
export const DESTRUCTIVE_PATTERNS: readonly string[] = [
    'git\\s+push\\b[^\\n]*\\s(--force\\b|--force-with-lease\\b|-f\\b)',
    'git\\s+branch\\b[^\\n]*\\s(-D\\b|--delete\\b)',
    'git\\s+reset\\b[^\\n]*--hard\\b',
    'git\\s+(rebase|filter-branch|filter-repo)\\b',
    '\\brm\\b[^\\n]*\\s-[a-zA-Z]*r[a-zA-Z]*f\\b',
    '\\brm\\b[^\\n]*\\s-[a-zA-Z]*f[a-zA-Z]*r\\b'
];

/**
 * Filenames inside a project that carry secrets, denied for read and write by default.
 *
 * These exist because the read category defaults to allow. That default is right, a colleague
 * that cannot read the repository cannot work, but it means every file in the project is
 * readable unless something says otherwise, and a `.env` sitting next to the source is exactly
 * the file I least want copied into a model's context.
 *
 * The list is deliberately short and boring. Every entry is a file whose whole purpose is to
 * hold a credential, so denying it costs nothing a colleague needed and nobody has to reason
 * about whether to keep it. Anything arguable was left out: this is the set I expect to still
 * be there in a year, not a security opinion I would have to defend on every project.
 *
 * `.env.*` catches `.env.example` too, which holds no secret. That is the trade I want. Denying
 * a template is a small annoyance I can override in one click; allowing a real `.env.production`
 * because the pattern was too clever is not recoverable, since by then it is in a transcript.
 *
 * Matched against the resolved absolute path, so `**` spans directories and a secret nested in
 * a subproject is covered too.
 */
export const SECRET_FILE_GLOBS: readonly string[] = [
    '.env',
    '.env.*',
    '*.pem',
    '*.key',
    '*.p12',
    '*.pfx',
    'id_rsa',
    'id_ed25519',
    '.npmrc',
    '.netrc',
    'credentials.json',
    '.credentials.json'
];

/**
 * The fallback effect per category when no rule matches, in phase 1. read is allowed
 * broadly, write denies outside its allowed scope, shell allows ordinary commands, fetch
 * follows the project's allowWebFetch, delegate allows, and an unrecognized tool asks
 * (which resolves as deny in phase 1). Never a silent allow.
 */
export function defaultCategoryDefaults(allowWebFetch: boolean): CategoryDefaults {
    return {
        read: 'allow',
        write: 'deny',
        shell: 'allow',
        fetch: allowWebFetch ? 'allow' : 'ask',
        delegate: 'allow',
        other: 'ask'
    };
}

export interface DefaultProfileInputs {
    /** The project repo root, absolute and normalized, the write scope when writePaths is null. */
    readonly repoRoot: string;
    /** The allowed write scopes, absolute and normalized, or null for the whole repo. */
    readonly writePaths: readonly string[] | null;
    /**
     * The paths a colleague must never read or write: Stafford's own user-data directory,
     * which holds the permission store, the database, and the managed credential. Denying
     * these is how the security invariant is enforced, not merely documented.
     */
    readonly protectedPaths: readonly string[];
}

/**
 * The generated rules, grouped by what they are for.
 *
 * Grouping exists because the flat list stopped being readable. The profile generates 47 rules
 * for a normal project, and every one of them is correct and none of them is interesting on
 * its own: twelve secret globs times read and write is twenty-four rows that all say the same
 * thing. Listed as peers of the handful of rules I actually wrote, they buried them.
 *
 * So the group is the unit a person reads, and the rules inside it are the detail. It also
 * gives the screens something honest to show for a project with no stored rules, which
 * otherwise looked empty while being fully governed.
 *
 * `defaultBaselineRules` is the flattening of this, so there is one source and the resolver
 * cannot drift from what the screen claims.
 */
export type ProfileGroupId = 'project-files' | 'protected-locations' | 'secret-files' | 'destructive-commands';

export interface ProfileGroup {
    readonly id: ProfileGroupId;
    /** How many distinct things the group covers, which is what a summary row counts. */
    readonly covers: number;
    readonly rules: readonly PermissionRule[];
}

export function defaultProfileGroups(input: DefaultProfileInputs): ProfileGroup[] {
    const writeScopes = input.writePaths ?? [input.repoRoot];

    const projectFiles: PermissionRule[] = writeScopes.map((scope) => (
        { action: 'write', pathScope: scope, commandPattern: null, effect: 'allow' }
    ));

    const protectedLocations: PermissionRule[] = [];
    for (const protectedPath of input.protectedPaths) {
        protectedLocations.push({ action: 'read', pathScope: protectedPath, commandPattern: null, effect: 'deny' });
        protectedLocations.push({ action: 'write', pathScope: protectedPath, commandPattern: null, effect: 'deny' });
    }

    const secretFiles: PermissionRule[] = [];
    for (const glob of SECRET_FILE_GLOBS) {
        const scope = input.repoRoot + '/**/' + glob;
        secretFiles.push({ action: 'read', pathScope: scope, commandPattern: null, effect: 'deny' });
        secretFiles.push({ action: 'write', pathScope: scope, commandPattern: null, effect: 'deny' });
    }

    const destructive: PermissionRule[] = DESTRUCTIVE_PATTERNS.map((pattern) => (
        { action: 'shell', pathScope: null, commandPattern: pattern, effect: 'ask' }
    ));

    return [
        { id: 'project-files', covers: writeScopes.length, rules: projectFiles },
        { id: 'protected-locations', covers: input.protectedPaths.length, rules: protectedLocations },
        { id: 'secret-files', covers: SECRET_FILE_GLOBS.length, rules: secretFiles },
        { id: 'destructive-commands', covers: DESTRUCTIVE_PATTERNS.length, rules: destructive }
    ];
}

/**
 * The baseline rules for a project with no stored rules, the phase-1 default profile.
 * Write is allowed within its scope and denied outside by the category default. Read and
 * write are denied on the protected paths, which beats the broad read allow because a
 * protected path is a more specific match. Destructive shell commands ask, which is deny
 * in phase 1. Ordinary read, in-scope write, ordinary shell, allowed fetch, and delegate
 * all resolve to allow, so normal work is unaffected.
 */
export function defaultBaselineRules(input: DefaultProfileInputs): PermissionRule[] {
    return defaultProfileGroups(input).flatMap((group) => [...group.rules]);
}
