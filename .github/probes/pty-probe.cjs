/**
 * Diagnostic, not a test. Answers one question on a CI runner: can a
 * pseudo-terminal be opened here at all.
 *
 * The pty suite fails on both hosted runners, differently on each. Windows dies
 * partway through the file with no diagnostic, macOS fails every spawn with
 * posix_spawnp. Before anything is fixed it is worth knowing whether the answer
 * is a bug in our code or an environment with no usable pty, because those call
 * for opposite responses.
 *
 * Always exits 0. The log is the result, not the exit status, so a runner that
 * cannot open a pty still produces a readable answer rather than a red job with
 * a truncated child.
 */

'use strict';

const os = require('os');

function line(label, value) {
    console.log(label.padEnd(34) + value);
}

console.log('=== environment ===');
line('platform', process.platform + ' ' + process.arch);
line('node', process.version);
line('release', os.release());
line('stdout.isTTY', String(Boolean(process.stdout.isTTY)));
line('stdin.isTTY', String(Boolean(process.stdin.isTTY)));
line('TERM', process.env.TERM || '(unset)');

// A controlling terminal is what a pty needs on POSIX, and a CI step usually
// has none. Opening /dev/tty is the direct way to ask.
if (process.platform !== 'win32') {
    try {
        const fs = require('fs');
        const fd = fs.openSync('/dev/tty', 'r');
        fs.closeSync(fd);
        line('/dev/tty', 'openable, a controlling terminal exists');
    } catch (err) {
        line('/dev/tty', 'NOT openable: ' + err.code + ', no controlling terminal');
    }
}

console.log('');
console.log('=== node-pty ===');

let pty;
try {
    pty = require('node-pty');
    line('loads', 'yes, version ' + require('node-pty/package.json').version);
} catch (err) {
    line('loads', 'NO: ' + err.message);
    console.log('');
    console.log('VERDICT: node-pty does not load on this runner.');
    process.exit(0);
}

let term;
try {
    term = pty.spawn(process.execPath, ['-e', 'process.stdout.write("PTY-OK\\n")'], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '' },
        useConpty: true
    });
    line('spawn', 'succeeded, pid ' + term.pid);
} catch (err) {
    line('spawn', 'THREW: ' + err.message);
    console.log('');
    console.log('VERDICT: a pty cannot be opened on this runner. The pty tests can never pass here.');
    process.exit(0);
}

let seen = '';
term.onData((d) => { seen += d; });

let exited = null;
term.onExit((info) => { exited = info; });

setTimeout(() => {
    line('data received', seen.includes('PTY-OK') ? 'yes, the child wrote through the pty' : 'NO, nothing arrived');
    line('bytes seen', String(seen.length));
    line('child exit', exited ? JSON.stringify(exited) : 'still running');

    let killError = null;
    try {
        term.kill();
    } catch (err) {
        killError = err.message;
    }
    line('kill', killError ? 'THREW: ' + killError : 'no throw');

    console.log('');
    if (seen.includes('PTY-OK')) {
        console.log('VERDICT: a pty works on this runner. The suite failure is our bug, not the environment.');
    } else {
        console.log('VERDICT: a pty opens but carries no data on this runner. The pty tests cannot pass here.');
    }

    // Deliberately not process.exit(0) immediately: give the kill a moment so
    // that whether the process hangs afterwards is itself visible in the log.
    setTimeout(() => process.exit(0), 2000);
}, 5000);
