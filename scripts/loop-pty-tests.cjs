/**
 * Runs the pty test file repeatedly and reports how many runs failed.
 *
 * The bug this was written to find reproduced about one run in four, so a
 * single green run does not clear the pty layer. Anything that touches it
 * should be re-checked here rather than by running the suite once and
 * believing it.
 *
 * It also enforces a duration ceiling. A run that hangs and then passes looks
 * like slowness and is the same category of problem as the force-exit flag
 * that hid a leak: the signal exists and nobody reads it. Setting
 * `_killRequested` in the wrong order once turned every kill into a no-op, and
 * the only symptom was a two minute run.
 *
 * The ceiling is enforced by killing the run, not by measuring it afterwards.
 * Measuring afterwards cannot catch a run that never returns, and on darwin the
 * fourth run does exactly that: the loop sat for ten minutes with three clean
 * runs printed and nothing after them. An instrument that hangs while looking
 * for a hang reports nothing at all.
 *
 * Usage: node scripts/loop-pty-tests.cjs [runs] [ceilingSeconds]
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const RUNS = Number(process.argv[2] || 6);
const CEILING_MS = Number(process.argv[3] || 45) * 1000;
// 6b commit 2 deleted runner/pty-session.test.js. This is the only file that
// spawns real ptys now, which is also what closed the two-pty-file window.
const FILE = path.join('src', 'main', 'agents', 'pty-session.real.test.ts');

const results = [];

for (let i = 1; i <= RUNS; i++) {
    const started = Date.now();
    const run = spawnSync(process.execPath, ['--test', FILE], { encoding: 'utf8', timeout: CEILING_MS, killSignal: 'SIGKILL' });
    const elapsed = Date.now() - started;
    const output = (run.stdout || '') + (run.stderr || '');

    const pass = Number((output.match(/^ℹ pass (\d+)/m) || [])[1] ?? -1);
    const fail = Number((output.match(/^ℹ fail (\d+)/m) || [])[1] ?? -1);
    const tooSlow = elapsed > CEILING_MS;

    results.push({ i, pass, fail, elapsed, tooSlow, output });

    console.log(
        'run ' + String(i).padStart(2) +
        '  pass ' + String(pass).padStart(3) +
        '  fail ' + String(fail).padStart(2) +
        '  ' + String(elapsed).padStart(6) + 'ms' +
        (fail > 0 ? '   FAILED' : '') +
        (tooSlow ? '   OVER THE ' + CEILING_MS / 1000 + 's CEILING' : '')
    );
}

const failed = results.filter((r) => r.fail !== 0 || r.tooSlow);

console.log('');
if (failed.length === 0) {
    console.log(RUNS + ' runs, all clean, none over ' + CEILING_MS / 1000 + 's.');
    process.exit(0);
}

console.log(failed.length + ' of ' + RUNS + ' runs were not clean.');
const first = failed[0];
if (first) {
    console.log('');
    console.log('--- output from run ' + first.i + ' ---');
    console.log(
        first.output
            .split('\n')
            .filter((l) => !/^\s+at |conpty_console_list_agent|^var consoleProcessList|^\s+\^$/.test(l))
            .slice(-25)
            .join('\n')
    );
}
process.exit(1);
