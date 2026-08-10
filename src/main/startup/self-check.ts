/**
 * Runs the platform's self checks at startup.
 *
 * Every platform returns a list of assumptions to prove, with what to say when
 * each one fails. Nothing executed them until now, which matters more than an
 * ordinary unbuilt piece: **when macOS hardware was deferred, the stated reason
 * it was safe was that this would fail loudly on an unverified platform and
 * name what it could not confirm.** That guard was specified and never wired,
 * so for several tasks the safety of deferring rested on code that did not run.
 * Nothing came of it because the hardware questions were answered by hand
 * instead, and the interface audit is what surfaced it rather than any failure.
 *
 * Returns results rather than throwing on a failed check, because the caller
 * decides what a failure means: the tray can show a degraded state where a
 * command-line entry point should refuse. `assertStartable` is the refusing
 * form, for callers that have no way to show anything.
 *
 * An unsupported platform refuses before any check runs. Linux is written and
 * `supported: false`, and half-working is worse than refusing.
 */

import nodeFs from 'node:fs';
import type { Platform, SelfCheckSpec } from '../platform/types.ts';

export interface SelfCheckFs {
    existsSync(path: string): boolean;
    accessSync(path: string, mode: number): void;
    mkdirSync(path: string, options: { recursive: true }): string | undefined;
}

export interface SelfCheckResult {
    readonly name: string;
    readonly kind: SelfCheckSpec['kind'];
    readonly ok: boolean;
    /** Which target satisfied it, or null when none did. */
    readonly satisfiedBy: string | null;
    /** The spec's own words, said back only when it failed. */
    readonly detail: string;
    /** What was actually checked, so a failure is diagnosable. */
    readonly checked: readonly string[];
}

export interface SelfCheckReport {
    readonly platform: string;
    readonly supported: boolean;
    readonly results: readonly SelfCheckResult[];
    readonly ok: boolean;
    /** Only the failures, in order, for a caller that wants to say them. */
    readonly failures: readonly SelfCheckResult[];
}

export class UnsupportedPlatformError extends Error {
    constructor(id: string) {
        super(
            'Refusing to start: ' + id + ' is written but has never been exercised on real hardware. ' +
            'Running here would be an untested best effort, and half-working is worse than refusing.'
        );
        this.name = 'UnsupportedPlatformError';
    }
}

export class SelfCheckFailed extends Error {
    readonly failures: readonly SelfCheckResult[];

    constructor(failures: readonly SelfCheckResult[]) {
        super(
            'Refusing to start: ' + failures.length + ' startup check' +
            (failures.length === 1 ? '' : 's') + ' failed.\n' +
            failures.map((f) => '  ' + f.name + '\n    ' + f.detail +
                '\n    checked: ' + (f.checked.length ? f.checked.join(', ') : 'nothing')).join('\n')
        );
        this.name = 'SelfCheckFailed';
        this.failures = failures;
    }
}

/**
 * `spawn-and-kill` proves the pty layer and the kill path work here, so it
 * needs something that can actually spawn. Injected rather than imported, so a
 * caller with no pty layer yet can pass one that reports honestly instead of
 * this module pretending the check passed.
 */
export interface SelfCheckDeps {
    readonly fs?: SelfCheckFs;
    readonly canSpawnAndKill?: () => boolean;
}

function runOne(spec: SelfCheckSpec, deps: Required<Pick<SelfCheckDeps, 'fs'>> & SelfCheckDeps): SelfCheckResult {
    const base = { name: spec.name, kind: spec.kind, detail: spec.detail, checked: spec.targets };

    if (spec.kind === 'any-file-exists') {
        const found = spec.targets.find((t) => deps.fs.existsSync(t)) ?? null;
        return { ...base, ok: found !== null, satisfiedBy: found };
    }

    if (spec.kind === 'dir-writable') {
        for (const target of spec.targets) {
            try {
                if (!deps.fs.existsSync(target)) deps.fs.mkdirSync(target, { recursive: true });
                // W_OK. Existing and writable are different questions and this
                // asks the second, which is the one that matters at startup.
                deps.fs.accessSync(target, 2);
                return { ...base, ok: true, satisfiedBy: target };
            } catch {
                // Try the next target rather than failing on the first.
            }
        }
        return { ...base, ok: false, satisfiedBy: null };
    }

    // spawn-and-kill. With no prober supplied the honest answer is that it was
    // not proved, never that it passed.
    if (!deps.canSpawnAndKill) {
        return {
            ...base,
            ok: false,
            satisfiedBy: null,
            detail: spec.detail + ' No prober was supplied, so this was not checked rather than passed.'
        };
    }
    let ok = false;
    try { ok = deps.canSpawnAndKill(); } catch { ok = false; }
    return { ...base, ok, satisfiedBy: ok ? 'spawned and killed a process' : null };
}

export function runSelfChecks(
    platform: Platform,
    input: { home: string; appId: string; claudePath: string | null },
    deps: SelfCheckDeps = {}
): SelfCheckReport {
    const fs = deps.fs ?? (nodeFs as unknown as SelfCheckFs);
    const results = platform.selfChecks(input).map((spec) => runOne(spec, { ...deps, fs }));
    const failures = results.filter((r) => !r.ok);
    return {
        platform: platform.id,
        supported: platform.supported,
        results,
        failures,
        ok: platform.supported && failures.length === 0
    };
}

/** The refusing form. Throws rather than returning a report. */
export function assertStartable(
    platform: Platform,
    input: { home: string; appId: string; claudePath: string | null },
    deps: SelfCheckDeps = {}
): SelfCheckReport {
    if (!platform.supported) throw new UnsupportedPlatformError(platform.id);
    const report = runSelfChecks(platform, input, deps);
    if (report.failures.length > 0) throw new SelfCheckFailed(report.failures);
    return report;
}
