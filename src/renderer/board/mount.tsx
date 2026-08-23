import { createRoot, type Root } from 'react-dom/client';
import '../styles/dashboard.css';
import { BoardScreen } from './board-screen.tsx';
import { rosterStore } from '../roster/roster-store.ts';
import type { Lang } from '../channel-view.ts';

let root: Root | null = null;

/**
 * Mounts the board island into the host the vanilla shell hands over, keeping the root so a
 * second call re-renders rather than remounting. Same shape as the other islands.
 *
 * Opening a card selects that colleague and asks the detail pane for its Tasks tab, then
 * switches to the roster view. The board itself changes nothing: it navigates to the review
 * surface that already exists, so approve, send back and fail keep going through the one
 * reviewed control path.
 */
export function mountBoard(host: HTMLElement, lang: Lang, onNavigate: (view: string) => void): void {
    if (!root) root = createRoot(host);
    root.render(
        <BoardScreen
            lang={lang}
            current="board"
            onNavigate={onNavigate}
            onOpenTask={(hireId) => {
                rosterStore.selectFor(hireId, 'tasks');
                onNavigate('roster');
            }}
        />
    );
}
