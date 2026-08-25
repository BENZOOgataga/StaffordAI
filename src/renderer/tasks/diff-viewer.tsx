import * as React from 'react';
import { ChevronRight, ChevronDown, FileDiff } from 'lucide-react';
import { hunkRows } from './diff-view-model.ts';
import { highlightLine, langForPath, type TokenClass } from './highlight.ts';
import type { TaskDiffFile, TaskDiffHunk, TaskDiffLine } from '../../shared/ipc.ts';

/**
 * The inline diff viewer for the review card, in the shape of Claude Code's own diff preview: a list
 * of changed files, each collapsed to its path and count until clicked, expanding to a unified diff
 * with red removals and green additions, a few lines of context, long unchanged stretches collapsed
 * behind a "show N more lines" affordance, and syntax highlighting. Files are independent, so several
 * can be open at once. The content is exactly git's, rendered, never re-derived.
 */

type Lang = ReturnType<typeof langForPath>;

const TOKEN_CLASS: Record<TokenClass, string> = {
    '': '',
    keyword: 'text-violet-400',
    string: 'text-amber-400',
    number: 'text-sky-400',
    comment: 'text-muted-foreground italic'
};

function Line({ line, lang }: { line: TaskDiffLine; lang: Lang }): React.JSX.Element {
    const bg = line.kind === 'add' ? 'bg-emerald-500/10' : line.kind === 'del' ? 'bg-rose-500/10' : '';
    const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
    const markerColor = line.kind === 'add' ? 'text-emerald-500' : line.kind === 'del' ? 'text-rose-500' : 'text-muted-foreground/40';
    const tokens = highlightLine(line.text, lang);
    return (
        <div className={'flex ' + bg}>
            <span className={'w-5 shrink-0 select-none px-1 text-center ' + markerColor} aria-hidden="true">{marker}</span>
            <code className="whitespace-pre pr-3">
                {tokens.map((t, i) => <span key={i} className={TOKEN_CLASS[t.cls]}>{t.text}</span>)}
                {line.text === '' ? ' ' : ''}
            </code>
        </div>
    );
}

/** One hunk, with its own local state for which collapsed gaps the person has expanded. */
function Hunk({ hunk, lang }: { hunk: TaskDiffHunk; lang: Lang }): React.JSX.Element {
    const [expanded, setExpanded] = React.useState<ReadonlySet<number>>(new Set());
    const rows = hunkRows(hunk);
    return (
        <div>
            <div className="text-muted-foreground bg-muted/30 whitespace-pre px-2 py-0.5">{hunk.header}</div>
            {rows.map((row, idx) => {
                if (row.kind === 'line') return <Line key={idx} line={row.line} lang={lang} />;
                if (expanded.has(idx)) {
                    return <React.Fragment key={idx}>{row.lines.map((l, k) => <Line key={k} line={l} lang={lang} />)}</React.Fragment>;
                }
                return (
                    <button
                        key={idx}
                        type="button"
                        data-diff-gap
                        onClick={() => setExpanded((s) => new Set(s).add(idx))}
                        className="text-muted-foreground hover:text-foreground bg-muted/20 w-full px-2 py-0.5 text-left"
                    >
                        {'⋯'} show {row.count} more {row.count === 1 ? 'line' : 'lines'}
                    </button>
                );
            })}
        </div>
    );
}

/** One file: a clickable header row, and the diff below when open. */
function FileRow({ file, defaultOpen = false }: { file: TaskDiffFile; defaultOpen?: boolean }): React.JSX.Element {
    const [open, setOpen] = React.useState(defaultOpen);
    const lang = langForPath(file.path);
    return (
        <li className="border-border overflow-hidden rounded-md border">
            <button
                type="button"
                aria-expanded={open}
                data-diff-file={file.path}
                onClick={() => setOpen((v) => !v)}
                className="hover:bg-accent/40 flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-sm"
            >
                {open
                    ? <ChevronDown className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                    : <ChevronRight className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />}
                <FileDiff className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                <code className="min-w-0 flex-1 truncate">{file.path}</code>
                <span className="shrink-0 text-xs tabular-nums">
                    <span className="text-emerald-500">+{file.added}</span>{' '}
                    <span className="text-rose-500">-{file.removed}</span>
                </span>
            </button>
            {open ? (
                <div className="border-border overflow-x-auto border-t font-mono text-xs leading-relaxed">
                    {file.binary
                        ? <p className="text-muted-foreground px-2 py-2">Binary file, no line diff.</p>
                        : file.hunks.length === 0
                            ? <p className="text-muted-foreground px-2 py-2">No textual changes.</p>
                            : file.hunks.map((h, i) => <Hunk key={i} hunk={h} lang={lang} />)}
                </div>
            ) : null}
        </li>
    );
}

/** The changed files, expandable in place. `defaultOpen` starts each expanded, for an inline edit in
 * the conversation where the single file's change should show without a click; the task review leaves
 * it off so a long list of files stays collapsed. */
export function DiffViewer({ files, defaultOpen = false }: {
    files: readonly TaskDiffFile[];
    defaultOpen?: boolean;
}): React.JSX.Element {
    return (
        <ul className="flex list-none flex-col gap-2 p-0">
            {files.map((file) => <FileRow key={file.path} file={file} defaultOpen={defaultOpen} />)}
        </ul>
    );
}
