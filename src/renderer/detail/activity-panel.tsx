import * as React from 'react';
import { cn } from '@/lib/utils';
import { ChevronRight, ChevronDown, Brain, ListChecks } from 'lucide-react';
import { FeedIconGlyph } from './feed-icon.tsx';
import { feedIcon, toolPhrase, toolStatusLabel, activityTime, type FeedRow } from '../activity-view.ts';
import { CollapsibleLines } from './collapsible-lines.tsx';
import { PREVIEW_LINES } from './collapse.ts';
import { DiffViewer } from '../tasks/diff-viewer.tsx';
import { TodoList } from './turn-blocks.tsx';
import { type Lang } from '../channel-view.ts';
import type { ActivityAction, ActivityBlock } from './feed-model.ts';

/**
 * The Activity tab: the colleague's actions across all its turns, one quiet flat row each in time
 * order, read-only. Same scannable shape as before, a line icon, a localized phrase, a status word
 * only on a failure, and a de-emphasized time. What is new is that an action with a body (a shell
 * command's output, an edit's diff, a thinking block's reasoning, a todo checklist) expands in place
 * to reveal it, using the same renderers the Conversation uses. A read, or any action with no body,
 * stays a one-liner. It is actions only: the colleague's prose replies and the person's prompts are
 * never here.
 */

/** The icon, phrase, and optional status word for one action's one-liner. */
function summarise(block: ActivityBlock, lang: Lang): { icon: React.JSX.Element; phrase: string; status: string | null } {
    if (block.kind === 'thinking') {
        const phrase = block.seconds === null
            ? (lang === 'fr' ? 'Réflexion' : 'Thinking')
            : (lang === 'fr' ? 'Réfléchi pendant ' + block.seconds + ' s' : 'Thought for ' + block.seconds + 's');
        return { icon: <Brain className="size-4 shrink-0 translate-y-0.5" aria-hidden="true" />, phrase, status: null };
    }
    if (block.todos !== undefined) {
        const done = block.todos.filter((t) => t.status === 'done').length;
        const phrase = (lang === 'fr' ? 'a mis à jour le plan' : 'updated the plan') +
            (block.todos.length > 0 ? ' (' + done + '/' + block.todos.length + ')' : '');
        return { icon: <ListChecks className="size-4 shrink-0 translate-y-0.5" aria-hidden="true" />, phrase, status: null };
    }
    const row: FeedRow = {
        kind: 'tool', id: block.id, at: '', tool: block.name, target: block.target,
        status: block.status === 'error' ? 'error' : 'ok', live: false
    };
    return {
        icon: <FeedIconGlyph icon={feedIcon(row)} className="size-4 shrink-0 translate-y-0.5" />,
        phrase: toolPhrase(block.name || 'a tool', block.target, lang, block.status),
        status: block.status === 'error' ? toolStatusLabel('error', lang) : null
    };
}

/** The expandable body for an action, or null when it has none (a read, a bare tool). */
function actionBody(block: ActivityBlock, lang: Lang): React.JSX.Element | null {
    if (block.kind === 'thinking') {
        return (
            <div className="text-muted-foreground text-xs leading-relaxed whitespace-pre-wrap">
                {block.text !== ''
                    ? block.text
                    : <span className="italic">{lang === 'fr' ? '(raisonnement non affiché)' : '(reasoning not shown)'}</span>}
            </div>
        );
    }
    if (block.todos !== undefined) return <TodoList todos={block.todos} lang={lang} />;
    if (block.edit) return <DiffViewer files={[block.edit]} preview={PREVIEW_LINES} />;
    if (block.output !== undefined && block.output.trim() !== '') return <CollapsibleLines text={block.output} />;
    return null;
}

/** One flat action row: a one-liner, expandable to its body when it has one. */
function ActivityActionRow({ action, now, lang }: { action: ActivityAction; now: number; lang: Lang }): React.JSX.Element {
    const [open, setOpen] = React.useState(false);
    const { icon, phrase, status } = summarise(action.block, lang);
    const isError = action.block.kind === 'tool' && action.block.status === 'error';
    const body = actionBody(action.block, lang);
    const line = (
        <>
            <span className={cn('shrink-0 translate-y-0.5', isError ? 'text-status-error' : 'text-muted-foreground')}>{icon}</span>
            <span className={cn('min-w-0 flex-1 text-sm break-words', isError && 'text-status-error')}>
                {phrase}
                {status ? <span className="text-status-error ml-2 text-xs">{status}</span> : null}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{activityTime(action.at, now, lang)}</span>
        </>
    );
    if (!body) {
        return <div className="flex items-baseline gap-3 px-1 py-1.5">{line}</div>;
    }
    return (
        <div className="flex flex-col">
            <button type="button" data-activity-expand aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="hover:bg-accent/30 flex items-baseline gap-3 rounded-md px-1 py-1.5 text-left">
                {open
                    ? <ChevronDown className="text-muted-foreground size-3.5 shrink-0 translate-y-0.5" aria-hidden="true" />
                    : <ChevronRight className="text-muted-foreground size-3.5 shrink-0 translate-y-0.5" aria-hidden="true" />}
                {line}
            </button>
            {open ? <div className="px-2 pb-2 pl-6">{body}</div> : null}
        </div>
    );
}

export function ActivityPanel({ actions, lang }: {
    actions: readonly ActivityAction[];
    lang: Lang;
}): React.JSX.Element {
    const now = Date.now();
    if (actions.length === 0) {
        return <p className="text-muted-foreground py-8 text-center text-sm">No activity yet.</p>;
    }
    return (
        <div className="flex flex-col">
            {actions.map((action) => <ActivityActionRow key={action.key} action={action} now={now} lang={lang} />)}
        </div>
    );
}
