/**
 * The collapse maths for a block of output, kept pure and free of JSX so it is tested under the
 * plain type-stripping runner. Shared by CollapsibleLines, the settled truncation idiom this phase
 * introduces for later phases to reuse.
 */

/**
 * The single preview height every action body collapses to by default: the first few lines show, the
 * rest hides behind a "show N more lines" affordance, matching Claude Code's short-preview default.
 * One number, shared by shell output and the diff preview, so no two body types disagree on how much
 * shows before the person expands. Four lines reads as a real preview (a command's first output, the
 * top of a change) while staying scannable; three cut a touch too tight in practice.
 */
export const PREVIEW_LINES = 4;

/** How the text splits for display: the lines, and how many are hidden behind the collapse. */
export function splitCollapsed(text: string, visible: number): { readonly lines: readonly string[]; readonly hidden: number } {
    // Drop a single trailing newline so a block does not render an empty last row, then split.
    const lines = text.replace(/\n$/, '').split('\n');
    const hidden = Math.max(0, lines.length - visible);
    return { lines, hidden };
}
