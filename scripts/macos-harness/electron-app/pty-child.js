// Stands in for claude.exe inside the harness's pty. Offline, instant, and it
// costs no subscription quota.
//
// Reports its own size on SIGWINCH, because that is how a resize is proven on a
// real Unix pty: the kernel delivers the signal and the child reads its own
// winsize. Nothing is echoed on the master, so there is no size report to match
// here. The ConPTY mechanism is the other half of this and lives in
// runner/fixtures/pty-child.js, which explains both.
//
// The harness refuses to run off darwin, so this file has one mechanism to
// support and no platform branch to make.
'use strict';
process.stdout.write('READY\n');

process.on('SIGWINCH', () => {
    process.stdout.write('WINCH ' + process.stdout.columns + 'x' + process.stdout.rows + '\n');
});

process.stdin.resume();
