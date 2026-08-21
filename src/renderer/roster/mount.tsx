import { createRoot, type Root } from 'react-dom/client';
import '../styles/dashboard.css';
import { RosterApp } from './roster-app.tsx';
import type { Lang } from '../create-forms-view.ts';

let root: Root | null = null;

/**
 * Mounts the React roster into the host the vanilla shell hands over, keeping the root
 * so a second call re-renders rather than remounting. onNavigate is the shell's view
 * switcher. The roster and its detail pane are both React now, rendered side by side.
 * This shares the dashboard's scoped styles, so the roster reads in the same island
 * register as the home dashboard.
 */
export function mountRoster(host: HTMLElement, lang: Lang, onNavigate: (view: string) => void): void {
    if (!root) root = createRoot(host);
    root.render(<RosterApp lang={lang} onNavigate={onNavigate} />);
}
