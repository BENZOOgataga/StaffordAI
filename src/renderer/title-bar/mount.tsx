import { createRoot } from 'react-dom/client';
import '../styles/dashboard.css';
import { TitleBar } from './title-bar.tsx';

/**
 * Mounts the custom title bar into the host the shell reserves for it. Called only for a
 * frameless window (Windows and Linux); a native-framed window (macOS) never mounts it.
 * Shares the dashboard's scoped styles, so the bar reads in the same token register as
 * the rest of the app.
 */
export function mountTitleBar(host: HTMLElement): void {
    createRoot(host).render(<TitleBar />);
}
