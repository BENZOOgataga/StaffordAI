import * as React from 'react';
import { splitCollapsed, PREVIEW_LINES } from './collapse.ts';

/**
 * A block of monospace output, collapsed to a few visible lines with a "show N more lines" affordance
 * for the rest, the same idiom the diff viewer uses for a long unchanged stretch. This phase settles
 * that truncation pattern so later phases reuse one mechanism rather than inventing a second.
 *
 * The output itself is already bounded upstream (a shell command's captured output is capped before
 * it crosses the bridge), so this only decides how much of that bounded text shows before the person
 * expands it. The collapse maths lives in `collapse.ts`, pure and DOM-free, so it is tested directly.
 */

const DEFAULT_VISIBLE = PREVIEW_LINES;

export function CollapsibleLines({ text, visible = DEFAULT_VISIBLE }: { text: string; visible?: number }): React.JSX.Element {
    const [open, setOpen] = React.useState(false);
    const { lines, hidden } = splitCollapsed(text, visible);
    const shown = open || hidden === 0 ? lines : lines.slice(0, visible);
    return (
        <div className="bg-muted/40 border-border overflow-x-auto rounded-md border font-mono text-xs leading-relaxed">
            <pre className="px-2 py-1.5 whitespace-pre">{shown.join('\n')}</pre>
            {hidden > 0 && !open ? (
                <button
                    type="button"
                    data-shell-more
                    onClick={() => setOpen(true)}
                    className="text-muted-foreground hover:text-foreground bg-muted/20 w-full border-t px-2 py-0.5 text-left"
                >
                    {'⋯'} show {hidden} more {hidden === 1 ? 'line' : 'lines'}
                </button>
            ) : null}
        </div>
    );
}
