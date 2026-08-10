/**
 * Runs the suite and reconciles what it declared against what it ran.
 *
 * This exists because a printed pair of numbers is not a check. The inventory
 * reported "89 declared, 87 run, 0 skipped" and those three cannot all be true;
 * the mismatch sat in a report until someone read it carefully. Either the
 * count over-counts, which is a bug in the counter, or tests are declared and
 * never execute, which is worse. Printing both invites the reader to reconcile
 * them, so this does it and fails.
 *
 * It also carries the marker inventory, so there is one place that reads the
 * suite rather than two that can disagree.
 */

'use strict';

const { spawn } = require('child_process');
const { readdirSync, readFileSync } = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Only declarations at column zero count. An indented `test(` is inside a
 * helper, and the two in `ptyTest` are exactly what made the count disagree
 * with reality.
 */
const DECLARED = /^(?:pty)?[tT]est\(/gm;
const MARKED = /\/\/[ \t]*@(real-machine|costs-quota)[ \t]*[\r\n]+[ \t]*(?:pty)?[tT]est\([ \t]*['"]([^'"]+)/g;

function testFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'out') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...testFiles(full));
        else if (/\.test\.(ts|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

const files = testFiles(ROOT);
let declared = 0;
const realMachine = [];
const costsQuota = [];

for (const file of files) {
    const source = readFileSync(file, 'utf8');
    declared += (source.match(DECLARED) || []).length;
    for (const match of source.matchAll(MARKED)) {
        (match[1] === 'real-machine' ? realMachine : costsQuota).push(match[2]);
    }
}

const child = spawn(
    process.execPath,
    ['--test', 'runner/*.test.js', 'src/**/*.test.ts'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] }
);

let captured = '';
child.stdout.on('data', (chunk) => {
    captured += chunk;
    process.stdout.write(chunk);
});

/**
 * Reconcile only once the child has exited AND its stdout has drained.
 *
 * `exit` fires when the process ends, not when the pipe is empty. On a Windows
 * runner that gap was enough to lose the summary lines entirely, so the count
 * read as unknown and the run failed with everything actually passing. Locally
 * the timing hid it, which is why it took a CI round trip to see.
 */
let exitCode = null;
let stdoutEnded = false;

function reconcile() {
    if (exitCode === null || !stdoutEnded) return;
    finish(exitCode);
}

child.stdout.on('end', () => { stdoutEnded = true; reconcile(); });
child.on('exit', (code) => { exitCode = code === null ? 1 : code; reconcile(); });

/**
 * Strips terminal control sequences and carriage returns before matching.
 *
 * The summary lines are anchored at column zero, and when this runs from a
 * terminal they do not start at column zero. npm exports FORCE_COLOR to its
 * lifecycle scripts when its own stdout is a tty, so the child emits colour
 * into the pipe even though the pipe is not a terminal, and the line arrives as
 * `\x1b[34mℹ tests 135\x1b[39m\r\n`. The caret then has an escape byte to its
 * right and never matches, so every count reads as unknown and a green run
 * reports RECONCILIATION FAILED.
 *
 * Measured 2026-08-08 on macOS by running the suite under a real pty. That is
 * the configuration a person uses and the one CI does not, which is why it
 * survived this long. Raw bytes in docs/stack-migration-verification.md.
 *
 * Carriage returns are dropped in the same pass. They are not what broke the
 * match, but a pty turns every newline into \r\n and leaving them in means the
 * next person anchoring on the end of a line inherits this bug rather than
 * finding it fixed.
 */
function plain(text) {
    // CSI sequences, then OSC strings, then bare carriage returns.
    return text
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\r/g, '');
}

function finish(code) {
    const readable = plain(captured);
    const read = (label) => {
        const match = readable.match(new RegExp('^ℹ ' + label + ' (\\d+)', 'm'));
        return match ? Number(match[1]) : null;
    };

    const ran = read('tests');
    const failed = read('fail');
    const skipped = read('skipped');

    console.log('');
    console.log('inventory');
    console.log('  files          ' + files.length);
    console.log('  declared       ' + declared);
    console.log('  ran            ' + (ran === null ? 'unknown' : ran));
    console.log('  skipped        ' + (skipped === null ? 'unknown' : skipped));
    console.log('  real-machine   ' + realMachine.length + (realMachine.length ? '  ' + realMachine.join(' | ') : ''));
    console.log('  costs-quota    ' + costsQuota.length + (costsQuota.length ? '  ' + costsQuota.join(' | ') : ''));

    const problems = [];

    if (ran === null) {
        problems.push('could not read the test count from the run, so nothing was reconciled');
    } else if (ran !== declared) {
        problems.push(
            'declared ' + declared + ' tests and ran ' + ran + '. ' +
            (declared > ran
                ? 'Either the counter over-counts, or tests are declared and never execute.'
                : 'More ran than were declared, so the counter is missing declarations.')
        );
    }

    if (costsQuota.length > 0) {
        problems.push('a test that costs subscription quota was added without a decision: ' + costsQuota.join(', '));
    }

    // A duplicate marked name is either a transition, like a module existing in
    // both trees mid-port, or a copy-paste nobody meant. Only one of those is
    // acceptable, so it is surfaced rather than counted.
    const duplicates = realMachine.filter((n, i) => realMachine.indexOf(n) !== i);
    if (duplicates.length > 0) {
        console.log('  note           duplicate real-machine names: ' + [...new Set(duplicates)].join(', '));
    }

    if (realMachine.length < 1) {
        problems.push('no real-machine tests found, which almost certainly means a marker was lost');
    }

    if (problems.length > 0) {
        console.log('');
        for (const problem of problems) console.log('  RECONCILIATION FAILED: ' + problem);
        process.exit(1);
    }

    process.exit(code);
}
