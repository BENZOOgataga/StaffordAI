/**
 * The collapse maths for a block of output, kept pure and free of JSX so it is tested under the
 * plain type-stripping runner. Shared by CollapsibleLines, the settled truncation idiom this phase
 * introduces for later phases to reuse.
 */

/** How the text splits for display: the lines, and how many are hidden behind the collapse. */
export function splitCollapsed(text: string, visible: number): { readonly lines: readonly string[]; readonly hidden: number } {
    // Drop a single trailing newline so a block does not render an empty last row, then split.
    const lines = text.replace(/\n$/, '').split('\n');
    const hidden = Math.max(0, lines.length - visible);
    return { lines, hidden };
}
