/**
 * Reads the real process tree, so a kill can be checked rather than assumed.
 *
 * `killTreeCommand` on POSIX returns `kill -9 -<pid>`, which reaches every
 * process in the group whose id is that pid. Two things have to be true for
 * that to reach a tool child, and neither had ever been verified:
 *
 *  - the session has to be its own process group leader, or the negative pid
 *    names some other group entirely;
 *  - the tool child has to be in that same group rather than a group of its
 *    own, or the kill reaches the session and leaves the child orphaned.
 *
 * The failure mode is why this matters more than it sounds. If the child is
 * outside the group, the kill still returns success, the session still dies,
 * and the only symptom is a process that keeps running with nothing attached to
 * it. There is no error to notice.
 *
 * The command comes from the platform. Parsing lives here because the command
 * fixes the column order, so every platform that answers produces the same
 * shape.
 */

import { execFileSync } from 'node:child_process';
import type { Platform } from '../platform/types.ts';

export interface ProcessRow {
    readonly pid: number;
    readonly ppid: number;
    readonly pgid: number;
    readonly command: string;
}

export interface TreeReader {
    (file: string, args: readonly string[]): string;
}

const defaultReader: TreeReader = (file, args) =>
    execFileSync(file, [...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

/** Parses the fixed `pid ppid pgid command` shape. Unparseable lines are dropped. */
export function parseProcessTree(output: string): ProcessRow[] {
    const rows: ProcessRow[] = [];
    for (const line of output.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!match) continue;
        rows.push({
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            command: (match[4] ?? '').trim()
        });
    }
    return rows;
}

/** Null when the platform has no process-group model worth checking. */
export function readProcessTree(platform: Platform, reader: TreeReader = defaultReader): ProcessRow[] | null {
    const spec = platform.processTreeCommand();
    if (spec === null) return null;
    return parseProcessTree(reader(spec.file, spec.args));
}

/**
 * Walks parent pointers from `pid` up to `ancestor`.
 *
 * This is the sibling question. A process started by the session and a process
 * started next to it can look identical in a flat listing, and only the parent
 * chain tells them apart. Bounded, because a corrupted listing must not spin.
 */
export function isDescendantOf(rows: readonly ProcessRow[], pid: number, ancestor: number): boolean {
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    let current = byPid.get(pid);
    for (let hops = 0; hops < 64 && current; hops += 1) {
        if (current.ppid === ancestor) return true;
        if (current.ppid <= 1) return false;
        current = byPid.get(current.ppid);
    }
    return false;
}

export function find(rows: readonly ProcessRow[], pid: number): ProcessRow | null {
    return rows.find((row) => row.pid === pid) ?? null;
}

/** Everything sharing a process group, which is exactly what the kill reaches. */
export function inGroup(rows: readonly ProcessRow[], pgid: number): ProcessRow[] {
    return rows.filter((row) => row.pgid === pgid);
}

/**
 * Descendants of `pid` whose command matches, by walking the tree rather than
 * by name alone. Used to find the tool child without asking the agent what it
 * ran, since the design says not to trust an agent's account of itself.
 */
export function descendantsMatching(
    rows: readonly ProcessRow[],
    ancestor: number,
    pattern: RegExp
): ProcessRow[] {
    return rows.filter((row) => pattern.test(row.command) && isDescendantOf(rows, row.pid, ancestor));
}
