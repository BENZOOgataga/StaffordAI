import { createRoot, type Root } from 'react-dom/client';
import '../styles/dashboard.css';
import { ChannelApp } from './channel-app.tsx';
import type { Lang } from '../channel-view.ts';

let root: Root | null = null;

/**
 * Mounts the React Channel into the host the shell hands over, keeping the root so a
 * second call re-renders rather than remounting. onNavigate is the shell's view switcher.
 * Shares the dashboard's scoped styles, so the Channel reads in the same island register
 * as home, roster, and the detail pane.
 */
export function mountChannel(host: HTMLElement, lang: Lang, onNavigate: (view: string) => void): void {
    if (!root) root = createRoot(host);
    root.render(<ChannelApp lang={lang} onNavigate={onNavigate} />);
}
