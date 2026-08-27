'use strict';

/*
 * Renders a built renderer page in Electron and writes a PNG, so the UI can be seen
 * without a human at the window. Dev tool only, never shipped or wired into the app.
 *
 * Usage: electron scripts/ui-screenshot.cjs <page> <out.png> [view]
 *   page    a file under out/renderer, e.g. preview.html or index.html
 *   out.png where to write the screenshot
 *   view    optional: a rail data-view to click after load (e.g. home), for index.html.
 *   steps   optional: further CSS selectors to click in order, for a surface behind a
 *           selection or a tab. A step that matches nothing fails the run.
 *           When set, a stub window.stafford bridge is injected so the real app renders
 *           with sample data and no main process, reproducing the live view exactly.
 *
 * It serves out/renderer over a local http server so the page's absolute asset paths and
 * ES module scripts load the same way the real app loads them, then captures the page.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// Lets a screenshot capture the reduced-motion variant of a surface, so an animation's static
// fallback can be seen. Chromium honours this switch as the OS reduced-motion preference.
if (process.env.SHOT_REDUCED) app.commandLine.appendSwitch('force-prefers-reduced-motion');

const PAGE = process.argv[2] || 'preview.html';
const OUT = process.argv[3] || 'ui-shot.png';
const VIEW = process.argv[4] || '';
// Extra CSS selectors to click after the view, in order, so a screenshot can reach a surface
// that lives behind a selection and a tab rather than only behind a rail item. Each waits for
// React to settle before the next.
const STEPS = process.argv.slice(5).filter(Boolean);
const ROOT = path.resolve(__dirname, '..', 'out', 'renderer');

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'
};

function serve() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const url = decodeURIComponent((req.url || '/').split('?')[0]);
            const rel = url === '/' ? '/index.html' : url;
            const file = path.join(ROOT, rel);
            if (!file.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
            fs.readFile(file, (err, data) => {
                if (err) { res.statusCode = 404; res.end('not found: ' + rel); return; }
                res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
                res.end(data);
            });
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function main() {
    const server = await serve();
    const port = server.address().port;
    await app.whenReady();
    const web = VIEW
        ? { offscreen: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'ui-stub-preload.cjs') }
        : { offscreen: true };
    // Per-view capture heights for the README screenshots. The projects and tasks views fill only the
    // top of a full-height window, so a default-height capture leaves half a pane of empty dark space
    // below the content. These heights end the window shortly after the content with normal padding,
    // so the images read as a shorter window rather than a mostly-empty one. SHOT_H overrides them, and
    // any other view falls back to the full 900. The captured pixel size is this height times the
    // display scaling.
    const VIEW_CAPTURE_HEIGHTS = { projects: 420, board: 483 };
    const captureHeight = Number(process.env.SHOT_H || VIEW_CAPTURE_HEIGHTS[VIEW] || 900);
    const win = new BrowserWindow({ width: Number(process.env.SHOT_W||1280), height: captureHeight, show: false, webPreferences: web });
    await win.loadURL('http://127.0.0.1:' + port + '/' + PAGE);
    await new Promise((r) => setTimeout(r, 1200));
    if (VIEW) {
        // The nav lives in the shared React AppShell now; its sidebar items carry the
        // data-view the old vanilla rail did, so the harness drives navigation the same way.
        await win.webContents.executeJavaScript(
            "document.querySelector('[data-view=\"" + VIEW + "\"]').click()"
        );
        // The island is dynamically imported and React mounts, so give it longer.
        await new Promise((r) => setTimeout(r, 2500));
    }
    for (const selector of STEPS) {
        const clicked = await win.webContents.executeJavaScript(
            "(() => { const el = document.querySelector(" + JSON.stringify(selector) + "); " +
            "if (!el) return false; " +
            // Two kinds of target need two different things, and doing only one of them
            // silently screenshots the wrong surface. A Radix trigger acts on pointer events
            // and ignores a bare click(), so the pointer sequence has to be dispatched. A
            // plain React onClick, such as a roster row, did not fire from a synthetic click
            // event and does fire from the native click(). So: dispatch the pointer sequence,
            // then call click() once. Exactly one click reaches either kind of target.
            "for (const type of ['pointerdown','mousedown','pointerup','mouseup']) { " +
            "el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } " +
            "el.click(); " +
            "return true; })()"
        );
        // A step that matched nothing is a broken screenshot, not a smaller one. Failing here
        // beats writing a PNG of the wrong surface and calling it evidence.
        if (!clicked) throw new Error('screenshot step matched nothing: ' + selector);
        await new Promise((r) => setTimeout(r, 900));
    }
    // A read of the page after the steps, for working out why a screenshot shows the wrong
    // surface. Printing what the DOM actually contains beats guessing at a selector.
    if (process.env.SHOT_EVAL) {
        const value = await win.webContents.executeJavaScript(process.env.SHOT_EVAL, true);
        process.stdout.write('eval: ' + JSON.stringify(value) + '\n');
    }
    const image = await win.webContents.capturePage();
    fs.writeFileSync(OUT, image.toPNG());
    process.stdout.write('wrote ' + OUT + ' (' + image.getSize().width + 'x' + image.getSize().height + ')\n');
    server.close();
    win.destroy();
    app.quit();
}

main().catch((err) => { process.stderr.write(String(err && err.stack || err) + '\n'); app.exit(1); });
