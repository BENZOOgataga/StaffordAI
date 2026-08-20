import { createRoot, type Root } from 'react-dom/client';
import '../styles/dashboard.css';
import { Dashboard } from './dashboard-app.tsx';

let root: Root | null = null;

/**
 * Mounts the React dashboard into the host element the vanilla shell hands over, and
 * keeps the root so a second call re-renders rather than remounting. onNavigate is the
 * shell's view switcher, so a rail click in React returns to a vanilla screen. This is
 * the one place React meets the vanilla renderer: everything else stays as it was.
 */
export function mountDashboard(host: HTMLElement, onNavigate: (view: string) => void): void {
    if (!root) root = createRoot(host);
    root.render(<Dashboard onNavigate={onNavigate} />);
}
