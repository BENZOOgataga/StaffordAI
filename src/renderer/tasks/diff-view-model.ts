/**
 * Turns a hunk's flat line list into display rows, collapsing long runs of unchanged context into a
 * gap the viewer can expand, while keeping a few context lines next to each change. A changed line
 * (add or removal) is never collapsed or hidden; only unchanged context between or around changes is.
 *
 * Pure, so the collapse behaviour is tested without a DOM.
 */

import type { TaskDiffHunk, TaskDiffLine } from '../../shared/ipc.ts';

export type DiffRow =
    | { readonly kind: 'line'; readonly line: TaskDiffLine }
    | { readonly kind: 'gap'; readonly count: number; readonly lines: readonly TaskDiffLine[] };

/**
 * `edge` is how many context lines to keep next to a change; `minCollapse` is the smallest hidden
 * run worth collapsing, so a gap is never offered for a stretch barely longer than the edges.
 */
export function hunkRows(hunk: TaskDiffHunk, edge = 3, minCollapse = 4): DiffRow[] {
    const rows: DiffRow[] = [];
    const lines = hunk.lines;
    let i = 0;

    while (i < lines.length) {
        const cur = lines[i]!;
        if (cur.kind !== 'context') {
            rows.push({ kind: 'line', line: cur });
            i++;
            continue;
        }
        // A maximal run of context lines. Because it is maximal, anything before it (when i > 0) is a
        // change, and anything after it (when it does not reach the hunk end) is a change too.
        let j = i;
        while (j < lines.length && lines[j]!.kind === 'context') j++;
        const run = lines.slice(i, j);
        const keepStart = i > 0 ? edge : 0;
        const keepEnd = j < lines.length ? edge : 0;

        if (run.length - keepStart - keepEnd >= minCollapse) {
            for (let k = 0; k < keepStart; k++) rows.push({ kind: 'line', line: run[k]! });
            const middle = run.slice(keepStart, run.length - keepEnd);
            rows.push({ kind: 'gap', count: middle.length, lines: middle });
            for (let k = run.length - keepEnd; k < run.length; k++) rows.push({ kind: 'line', line: run[k]! });
        } else {
            for (const line of run) rows.push({ kind: 'line', line });
        }
        i = j;
    }

    return rows;
}
