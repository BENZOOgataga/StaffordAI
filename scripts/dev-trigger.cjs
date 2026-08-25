'use strict';

/*
 * Dev-only: trigger a fake UI state in a running dev build of Stafford, without clicking the
 * hidden panel. Writes the requested state to a temp file the dev app polls; the app installs a
 * presentation-only overlay and re-renders. Nothing is persisted, and this only reaches a dev
 * build: a packaged build registers no dev triggers and does not poll the file.
 *
 * Usage:
 *   npm run dev:trigger -- <state> [n]
 *   node scripts/dev-trigger.cjs <state> [n]
 *
 * States: needs-you (n sizes it), approval, not-reporting, board-empty, board-no-tasks,
 *         board-populated, clear.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATES = ['needs-you', 'approval', 'not-reporting', 'board-empty', 'board-no-tasks', 'board-populated', 'clear'];
const TRIGGER_FILE = path.join(os.tmpdir(), 'stafford-dev-trigger.json');

const state = process.argv[2];
const n = process.argv[3] === undefined ? 1 : Number(process.argv[3]);

if (!state || !STATES.includes(state)) {
    process.stderr.write('usage: npm run dev:trigger -- <state> [n]\nstates: ' + STATES.join(', ') + '\n');
    process.exit(1);
}

fs.writeFileSync(TRIGGER_FILE, JSON.stringify({ state, n }));
process.stdout.write(
    'wrote ' + TRIGGER_FILE + '\n' +
    'state: ' + state + (state === 'needs-you' ? ' (n=' + n + ')' : '') + '\n' +
    'the running dev app picks this up within about half a second. Nothing is persisted.\n'
);
