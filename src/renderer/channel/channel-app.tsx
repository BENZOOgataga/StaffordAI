import * as React from 'react';
import { ChannelScreen } from './channel-screen.tsx';
import { useChannel } from './use-channel.ts';
import { useRoster } from '../roster/use-roster.ts';
import type { Lang } from '../channel-view.ts';

/**
 * The Channel, wired: the timeline from useChannel, the colleague names from the live
 * roster store (so a message resolves to its sender's name), handed to the screen.
 * onNavigate is the seam back to the shell.
 */
export function ChannelApp({ lang, onNavigate }: {
    lang: Lang;
    onNavigate: (view: string) => void;
}): React.JSX.Element {
    const roster = useRoster();
    const { rows, loadOlder } = useChannel();
    return (
        <ChannelScreen
            rows={rows}
            cards={roster.cards}
            lang={lang}
            current="channel"
            onNavigate={onNavigate}
            onLoadOlder={loadOlder}
        />
    );
}
