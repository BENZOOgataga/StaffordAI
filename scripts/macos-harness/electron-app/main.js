/**
 * Minimal Electron main process for the macOS harness.
 *
 * Headless on purpose: no BrowserWindow. The question is whether node-pty works
 * inside Electron's main process on arm64, not whether anything renders.
 *
 * Prints one JSON line and exits, so the harness parses a result rather than
 * scraping prose.
 */

'use strict';

const path = require('path');
const { app } = require('electron');

const CHILD = path.join(__dirname, 'pty-child.js');

app.whenReady().then(async () => {
    const result = {
        electron: process.versions.electron,
        node: process.versions.node,
        modules: process.versions.modules,
        arch: process.arch,
        loaded: false,
        spawned: false,
        streamed: false,
        resized: false,
        killed: false,
        error: null
    };

    let pty;
    try {
        pty = require('node-pty');
        result.loaded = true;
        result.nodePty = require('node-pty/package.json').version;
    } catch (err) {
        result.error = 'require: ' + err.message;
        return finish(result);
    }

    let term;
    try {
        term = pty.spawn(process.execPath, [CHILD], {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: __dirname,
            env: {
                PATH: process.env.PATH || '',
                HOME: process.env.HOME || '',
                ELECTRON_RUN_AS_NODE: '1'
            }
        });
        result.spawned = true;
    } catch (err) {
        result.error = 'spawn: ' + err.message;
        return finish(result);
    }

    let seen = '';
    term.onData((d) => { seen += d; });

    const waitFor = (re, ms) => new Promise((resolve) => {
        const started = Date.now();
        const timer = setInterval(() => {
            if (re.test(seen) || Date.now() - started > ms) {
                clearInterval(timer);
                resolve(re.test(seen));
            }
        }, 40);
    });

    result.streamed = await waitFor(/READY/, 8000);

    seen = '';
    try {
        term.resize(132, 40);
        // A real Unix pty echoes nothing on the master when it is resized. The
        // kernel delivers SIGWINCH and the child reads its own winsize, so the
        // child is the only thing that can report it.
        //
        // This asserted the ConPTY size report until 2026-08-08, which a Unix
        // pty never emits. Resize worked and this reported false, and one false
        // check out of five was enough to make the section conclude that the
        // pty layer did not work under Electron at all.
        //
        // The harness refuses to run off darwin, so there is one mechanism to
        // support here. The other half lives in the platform layer, where the
        // tests read it from, and runner/fixtures/pty-child.js explains both.
        result.resized = await waitFor(/WINCH 132x40/, 4000);
    } catch (err) {
        result.error = 'resize: ' + err.message;
    }

    try {
        term.kill();
        result.killed = true;
    } catch (err) {
        result.error = 'kill: ' + err.message;
    }

    finish(result);
});

function finish(result) {
    console.log('HARNESS_RESULT ' + JSON.stringify(result));
    app.exit(0);
}
