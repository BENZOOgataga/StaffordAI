/**
 * The saved-work notice's DOM: a quiet, dismissible banner shown on launch when the
 * most recent drain saved a colleague's work. One line per colleague, the name and
 * the branch it is on, the branch as selectable monospace so the person can copy it
 * and go merge or discard the work in their own git. Grayscale-quiet, no accent, no
 * action buttons beyond dismiss: this makes the saved work findable, it does not act
 * on it.
 *
 * Dismiss removes the banner and calls back so the shell marks that drain seen, so
 * the same notice does not return on the next launch.
 */

import type { SavedCheckpoints } from '../shared/ipc.ts';
import { savedWorkHeader, savedWorkLinePrefix, dismissLabel, type Lang } from './checkpoints-view.ts';

export function renderSavedWork(host: HTMLElement, data: SavedCheckpoints, lang: Lang, onDismiss: () => void): void {
    const panel = document.createElement('div');
    panel.className = 'saved-panel';

    const head = document.createElement('div');
    head.className = 'saved-head';
    const title = document.createElement('span');
    title.className = 'saved-title';
    title.textContent = savedWorkHeader(data.saves.length, lang);
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'saved-dismiss';
    dismiss.textContent = dismissLabel(lang);
    dismiss.addEventListener('click', () => {
        host.replaceChildren();
        host.hidden = true;
        onDismiss();
    });
    head.append(title, dismiss);
    panel.appendChild(head);

    for (const save of data.saves) {
        const row = document.createElement('div');
        row.className = 'saved-row';
        const text = document.createElement('span');
        text.className = 'saved-text';
        text.textContent = savedWorkLinePrefix(save.name, lang);
        // The branch as selectable monospace, the actionable part: read and copy it.
        const branch = document.createElement('code');
        branch.className = 'saved-branch';
        branch.textContent = save.branch;
        row.append(text, branch);
        panel.appendChild(row);
    }

    host.replaceChildren(panel);
    host.hidden = false;
}
