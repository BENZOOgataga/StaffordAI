import { createRoot, type Root } from 'react-dom/client';
import '../styles/dashboard.css';
import { PermissionsApp } from './permissions-app.tsx';
import type { UiLang } from './rule-labels.ts';

let root: Root | null = null;

/**
 * Mounts the permissions island into the host element the vanilla shell hands over, keeping
 * the root so a second call re-renders rather than remounting. Same shape as the other
 * islands, deliberately: the shell should not have to know which island it is talking to.
 */
export function mountPermissions(host: HTMLElement, lang: UiLang, onNavigate: (view: string) => void): void {
    if (!root) root = createRoot(host);
    root.render(<PermissionsApp lang={lang} onNavigate={onNavigate} />);
}
