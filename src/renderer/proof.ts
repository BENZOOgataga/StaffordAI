/**
 * The proof window's renderer script.
 *
 * It talks only to `window.stafford`, the frozen bridge from the preload. It
 * has no Node integration, no `ipcRenderer`, and makes no network request. It
 * calls health, spawns a shell through main, streams its output, and types into
 * it. That is the whole end-to-end proof: IPC in both directions plus a real
 * pty behind main.
 *
 * Thrown away with this window. Not a pattern for real UI.
 */

import type { StaffordApi } from '../preload/index.ts';

declare global {
    interface Window {
        readonly stafford: StaffordApi;
    }
}

const status = document.getElementById('status') as HTMLDivElement;
const out = document.getElementById('out') as HTMLDivElement;
const input = document.getElementById('in') as HTMLInputElement;

function append(text: string): void {
    out.textContent += text;
    out.scrollTop = out.scrollHeight;
}

async function main(): Promise<void> {
    const health = await window.stafford.health();
    status.textContent = 'health: ok=' + health.ok + ' platform=' + health.platform +
        ' ptyOpen=' + health.ptyOpen;

    // Exercise the store's read path over IPC on load, without a click. Ids and
    // names only; the renderer never sees a repo path.
    const projects = await window.stafford.projects.list();
    status.textContent += ' | projects=' + projects.projects.length;

    window.stafford.proof.onData((data) => append(data));
    window.stafford.proof.onExit((info) => append('\n[exit ' + JSON.stringify(info) + ']\n'));

    await window.stafford.proof.spawn({ cols: 80, rows: 24 });

    input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        void window.stafford.proof.write(input.value + '\r');
        input.value = '';
    });
}

void main();
