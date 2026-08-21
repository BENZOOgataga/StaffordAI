import * as React from 'react';
import { Card } from '@/components/ui/card';
import { useSavedWork } from './use-saved-work.ts';
import { savedWorkHeader, savedWorkLinePrefix, dismissLabel, type Lang } from '../checkpoints-view.ts';

/**
 * The saved-work notice, in React. On launch, when the last drain saved a colleague's
 * work, this quiet banner tells the person which colleague and the branch it is on, the
 * branch as selectable monospace to copy and go merge or discard it. Dismiss acknowledges
 * the drain so it does not return. It renders nothing when there is no saved work. This
 * replaces the old vanilla notice, whose host was removed with the dead launch chrome; the
 * drain itself is unchanged, only where its result surfaces.
 */
export function SavedWorkBanner({ lang }: { lang: Lang }): React.JSX.Element | null {
    const { data, dismiss } = useSavedWork();
    if (!data) return null;
    return (
        <Card className="gap-2 p-4">
            <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{savedWorkHeader(data.saves.length, lang)}</span>
                <button type="button" onClick={dismiss}
                    className="text-muted-foreground hover:text-foreground text-xs transition-colors">
                    {dismissLabel(lang)}
                </button>
            </div>
            <div className="flex flex-col gap-1">
                {data.saves.map((save) => (
                    <div key={save.branch} className="text-muted-foreground flex flex-wrap items-baseline gap-2 text-sm">
                        <span>{savedWorkLinePrefix(save.name, lang)}</span>
                        <code className="text-foreground bg-secondary rounded px-1.5 py-0.5 font-mono text-xs select-text">
                            {save.branch}
                        </code>
                    </div>
                ))}
            </div>
        </Card>
    );
}
