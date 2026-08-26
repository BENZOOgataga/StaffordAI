import { createRoot, type Root } from 'react-dom/client';
import '../styles/dashboard.css';
import { ProjectsScreen } from './projects-screen.tsx';
import type { Lang } from '../channel-view.ts';

let root: Root | null = null;

/**
 * Mounts the Projects management island into the host the shell hands over, keeping the root so a
 * second call re-renders rather than remounting. Same shape as the other islands, so the shell does
 * not have to know which island it is talking to.
 */
export function mountProjects(host: HTMLElement, lang: Lang, onNavigate: (view: string) => void): void {
    if (!root) root = createRoot(host);
    root.render(<ProjectsScreen lang={lang} onNavigate={onNavigate} />);
}
