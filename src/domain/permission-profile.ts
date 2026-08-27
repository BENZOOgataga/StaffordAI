/**
 * The action-category mapping and the default permission profile, pure and tested
 * (docs/plans/PERMISSION-SYSTEM.md, phase 1). This grounds the policy in the real Claude
 * Code tool names and produces the baseline rules a project starts with before any are
 * stored. No Electron, no filesystem: the caller passes already-resolved absolute paths.
 */

import type { PermissionRule, PermissionAction, PermissionEffect, CategoryDefaults } from './permissions.ts';

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
 * The secret-file scopes anchored to a project root, the form the gate compares against. Both the
 * gate's read and write deny rules (through `defaultBaselineRules`) and the effective-policy display
 * come from this one function, so the read floor and the write floor cannot name different files.
 */
export function secretFileScopes(repoRoot: string): string[] {
    return SECRET_FILE_GLOBS.map((glob) => repoRoot + '/**/' + glob);
}

/**
 * The Claude Code `permissions.deny` entries that make the secret files a hard read floor.
 *
 * This is the fix for the defect that read-only tools inside the working directory never reached the
 * gate: Claude Code auto-allows Read, Grep, Glob, and the rest inside the cwd and never emits a
 * can_use_tool request, so the gate's read rules were correct code on a path that never ran for an
 * in-cwd read. A native deny is enforced by the CLI itself before the tool runs, needs no
 * can_use_tool, and also removes the files from Grep and Glob discovery.
 *
 * A bare filename follows gitignore semantics and matches at any depth under the working directory,
 * so one entry per glob covers a secret at the project root and nested in a subdirectory both. The
 * entries come straight from SECRET_FILE_GLOBS, the same constant the gate's deny rules iterate, so
 * the two floors are one list by construction.
 *
 * Scope is deliberately the working directory only. An out-of-cwd read (a credential directory, or a
 * symlink inside the project aimed at one) already reaches the gate, because the CLI asks about reads
 * outside the cwd, so the gate still denies those. This floor does not restate them. It does not cover
 * a shell read either (cat, Get-Content): shell is a separate category and stays best-effort, exactly
 * as the README documents. This closes the in-cwd file-tool read hole, nothing wider.
 */
export function nativeReadFloorDeny(): string[] {
    return SECRET_FILE_GLOBS.map((glob) => 'Read(' + glob + ')');
}

/**
 * Whether a stored rule would loosen the secret-file read floor. The native deny hard-refuses an
 * in-cwd secret read before the tool runs, so a stored read rule that set one of these to ask or allow
 * would be shown by the config screen while the binary denied it anyway. The write path refuses such a
 * rule so the screen never states an effect the floor does not honor. Matched on the anchored scope
 * suffix, so it holds whatever project root the rule carries.
 */
export function loosensSecretRead(
    rule: { action: PermissionAction; pathScope: string | null; effect: PermissionEffect }
): boolean {
    if (rule.action !== 'read' || rule.effect === 'deny' || rule.pathScope === null) return false;
    const scope = rule.pathScope;
    return SECRET_FILE_GLOBS.some((glob) => scope.endsWith('/**/' + glob));
}

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
 * The baseline rules for a project with no stored rules, the phase-1 default profile.
 * Write is allowed within its scope and denied outside by the category default. Read and
 * write are denied on the protected paths, which beats the broad read allow because a
 * protected path is a more specific match. Destructive shell commands ask, which is deny
 * in phase 1. Ordinary read, in-scope write, ordinary shell, allowed fetch, and delegate
 * all resolve to allow, so normal work is unaffected.
 */
export function defaultBaselineRules(input: DefaultProfileInputs): PermissionRule[] {
    const rules: PermissionRule[] = [];

    const writeScopes = input.writePaths ?? [input.repoRoot];
    for (const scope of writeScopes) {
        rules.push({ action: 'write', pathScope: scope, commandPattern: null, effect: 'allow' });
    }

    for (const protectedPath of input.protectedPaths) {
        rules.push({ action: 'read', pathScope: protectedPath, commandPattern: null, effect: 'deny' });
        rules.push({ action: 'write', pathScope: protectedPath, commandPattern: null, effect: 'deny' });
    }

    // Secret-bearing files inside the project. Anchored to the repo rather than left as a bare
    // pattern, so a rule that says .env means this project's .env and not every .env on the
    // machine. A glob beats the broad read allow on specificity, and it loses to anything more
    // specific I write later, so overriding one is a normal edit rather than a fight.
    //
    // These are the write floor and the gate's copy of the read floor. The read floor is also
    // enforced natively (nativeReadFloorDeny), because an in-cwd read never reaches the gate. Both
    // come from secretFileScopes, i.e. from SECRET_FILE_GLOBS, so the two cannot name different files.
    for (const scope of secretFileScopes(input.repoRoot)) {
        rules.push({ action: 'read', pathScope: scope, commandPattern: null, effect: 'deny' });
        rules.push({ action: 'write', pathScope: scope, commandPattern: null, effect: 'deny' });
    }

    for (const pattern of DESTRUCTIVE_PATTERNS) {
        rules.push({ action: 'shell', pathScope: null, commandPattern: pattern, effect: 'ask' });
    }

    return rules;
}
