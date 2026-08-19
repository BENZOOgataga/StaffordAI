/**
 * The real filesystem and process I/O the checkpoint executor runs on: git as a
 * bounded child, and the temp index copy. Kept apart from `checkpoint-executor.ts`
 * so that module stays pure and injectable, and this is the one place that spawns a
 * process or touches disk.
 *
 * A git child is bounded by a timer; on overrun it is reaped through the existing
 * `killTree`, the only kill path, and the run resolves as timed out. The timer is
 * unref'd so it never itself holds the app open at quit.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { killTree } from './kill-tree.ts';
import type { Platform } from '../platform/types.ts';
import type { CheckpointDeps, GitRun, RunGitOptions, TempIndex } from './checkpoint-executor.ts';

function runGitReal(platform: Platform, args: readonly string[], options: RunGitOptions): Promise<GitRun> {
    return new Promise<GitRun>((resolve) => {
        // Neutralise line-ending conversion per invocation, so the checkpoint does
        // not depend on the user's git config. With `core.autocrlf` on (and the
        // stricter `core.safecrlf`), `add -u` on an LF working tree aborts with
        // "LF would be replaced by CRLF", so whether a checkpoint succeeds would
        // otherwise vary by machine. The `-c` form is per command only: nothing is
        // written to any git config, and the working tree is read as-is, which is
        // what keeps the checkpoint byte-for-byte faithful.
        const child = spawn('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], {
            cwd: options.cwd,
            env: { ...process.env, ...(options.env ?? {}) }
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let done = false;

        const finish = (code: number | null): void => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, code, timedOut });
        };

        child.stdout?.on('data', (d) => { stdout += String(d); });
        child.stderr?.on('data', (d) => { stderr += String(d); });
        child.on('error', (e) => { stderr += (e instanceof Error ? e.message : String(e)); finish(null); });
        child.on('close', (code) => finish(code));

        const timer = setTimeout(() => {
            timedOut = true;
            // Reap the child and its tree through the one kill path, then resolve.
            if (typeof child.pid === 'number') void killTree(platform, child.pid).catch(() => { /* best effort */ });
            finish(null);
        }, options.timeoutMs);
        timer.unref();
    });
}

async function prepareTempIndexReal(realIndexPath: string): Promise<TempIndex> {
    const p = path.join(os.tmpdir(), 'stafford-idx-' + randomUUID());
    try {
        await fs.copyFile(realIndexPath, p);
        return { path: p, seeded: true };
    } catch {
        // No index to copy (a repo with no index file yet). The executor seeds the
        // temp index from HEAD instead, so add -u still has the tracked set.
        return { path: p, seeded: false };
    }
}

async function cleanupTempIndexReal(p: string): Promise<void> {
    try {
        await fs.rm(p, { force: true });
    } catch {
        // Best effort: a leftover temp index in the OS temp dir is harmless.
    }
}

/** The real deps for `checkpointRepo`, bound to a platform for the kill path. */
export function realCheckpointDeps(platform: Platform): CheckpointDeps {
    return {
        runGit: (args, options) => runGitReal(platform, args, options),
        prepareTempIndex: prepareTempIndexReal,
        cleanupTempIndex: cleanupTempIndexReal
    };
}
