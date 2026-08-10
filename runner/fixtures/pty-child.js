/**
 * Test fixture for pty-session.test.js. Stands in for claude.exe so the suite
 * runs offline, in milliseconds, and costs no subscription quota.
 *
 * Protocol, one command per line:
 *   big <n>     prints n bytes on one line, for ring buffer tests
 *   bye         exits with code 7
 *   anything    prints ECHO:<anything>
 *
 * Reports its own size on SIGWINCH, and that is only half of how a resize gets
 * proven. The two platforms use genuinely different mechanisms and neither one
 * generalises, so both are named here rather than one being treated as the way
 * it works.
 *
 * On Windows the ConPTY announces its new size on the master as
 * `CSI 8 ; rows ; cols t`, and the child cannot be asked: its console width is
 * cached at startup and does not follow a ConPTY resize, so asking it would
 * test the child rather than the resize. The Windows test matches that report.
 *
 * On a real Unix pty nothing is echoed on the master at all. The kernel
 * delivers SIGWINCH and the child reads its own winsize, which it can, so the
 * child is the only thing that can report it. The darwin test matches the line
 * below. Measured 2026-08-08: resizing produced `"READY\r\nWINCH 132x40\r\n"`
 * with no size report anywhere in the stream.
 *
 * The handler is installed unconditionally, so there is no platform branch in
 * this file. Which string a test waits for comes from
 * `platform.resizeObservation(cols, rows)`, per the rule that platform
 * differences live in one module.
 */

'use strict';

process.stdout.write('READY\n');

process.on('SIGWINCH', () => {
    process.stdout.write('WINCH ' + process.stdout.columns + 'x' + process.stdout.rows + '\n');
});

process.stdin.setEncoding('utf8');

let pending = '';

process.stdin.on('data', (chunk) => {
    pending += chunk;

    let index;
    while ((index = pending.search(/[\r\n]/)) !== -1) {
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        if (!line) continue;

        if (line === 'bye') {
            process.exit(7);
        } else if (line.startsWith('big ')) {
            process.stdout.write('X'.repeat(Number(line.slice(4)) || 0) + '\n');
        } else {
            process.stdout.write('ECHO:' + line + '\n');
        }
    }
});
