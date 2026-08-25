/**
 * Parses a unified `git diff` into structured files and hunks, so the review surface can render the
 * actual changed lines rather than just a count. It keeps every line exactly as git emitted it,
 * minus the leading +, -, or space marker, so the rendered diff is byte-accurate to git's own output.
 *
 * Pure, so it is tested against captured git output without a repo.
 */

import type { TaskDiffFile, TaskDiffHunk, TaskDiffLine } from '../../shared/ipc.ts';

/** The path from a `diff --git a/X b/Y` header. Prefers the b-side (the after path). */
function pathFromHeader(header: string): string {
    const m = header.match(/^diff --git a\/(.*) b\/(.*)$/);
    return m && m[2] !== undefined ? m[2] : header.replace(/^diff --git\s+/, '');
}

function stripPrefix(p: string): string {
    return p.replace(/^[ab]\//, '');
}

/** Parses the full output of `git diff [options] A B` into per-file hunks. */
export function parseUnifiedDiff(patch: string): TaskDiffFile[] {
    const files: TaskDiffFile[] = [];
    const lines = patch.split('\n');
    let i = 0;

    while (i < lines.length) {
        const start = lines[i] ?? '';
        if (!start.startsWith('diff --git ')) { i++; continue; }

        let path = pathFromHeader(start);
        let binary = false;
        let added = 0;
        let removed = 0;
        const hunks: TaskDiffHunk[] = [];
        let current: { header: string; lines: TaskDiffLine[] } | null = null;
        i++;

        for (; i < lines.length && !(lines[i] ?? '').startsWith('diff --git '); i++) {
            const line = lines[i] ?? '';
            // File headers before the first hunk. The +++ b/path is the reliable after-path,
            // except for a delete where it is /dev/null and the a-path already stands.
            if (line.startsWith('+++ ')) {
                const p = line.slice(4).trim();
                if (p !== '/dev/null') path = stripPrefix(p);
                continue;
            }
            if (line.startsWith('--- ')) continue;
            if (line.startsWith('Binary files ')) { binary = true; continue; }
            if (line.startsWith('@@')) {
                const hunk = { header: line, lines: [] as TaskDiffLine[] };
                hunks.push(hunk);
                current = hunk;
                continue;
            }
            // Anything before the first hunk (index, mode, rename, similarity) is metadata.
            if (!current) continue;
            // "\ No newline at end of file" is a note about the previous line, not a diff line.
            if (line.startsWith('\\')) continue;
            if (line.startsWith('+')) { current.lines.push({ kind: 'add', text: line.slice(1) }); added++; }
            else if (line.startsWith('-')) { current.lines.push({ kind: 'del', text: line.slice(1) }); removed++; }
            else if (line.startsWith(' ')) { current.lines.push({ kind: 'context', text: line.slice(1) }); }
            // A bare empty string is only the split artifact at the patch end; git prefixes every
            // real context line with a space, so it is safe to ignore.
        }

        files.push({ path, added, removed, hunks, binary });
    }

    return files;
}
