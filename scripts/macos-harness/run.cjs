/**
 * The macOS verification harness.
 *
 * A hosted macOS runner has no controlling terminal, so CI can never exercise
 * the pty layer there. This is the only automated macOS coverage that layer
 * will ever get, which is why it is a committed script that runs repeatedly
 * rather than a session someone worked through once.
 *
 * One section per hardware question. Each is implemented or explicitly pending,
 * and a pending section prints what it is waiting for rather than printing
 * nothing, because a silent section reads as a section that passed.
 *
 * Output shape is fixed so a run against a later commit is comparable to this
 * one. A harness whose output drifts cannot show a regression.
 *
 * Usage:
 *   node scripts/macos-harness/run.cjs            print the report
 *   node scripts/macos-harness/run.cjs --write    also append it to the log
 */

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const { existsSync, appendFileSync, statSync } = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const LOG = path.join(ROOT, 'docs', 'stack-migration-verification.md');

/**
 * The five verdicts, and the distinction that matters most is between the two
 * kinds of contradiction. A socket that turns out not to be owner-only changes
 * nothing, because per-agent secrets already carry authentication. A claude
 * binary somewhere the candidate list misses is a code change. A red line that
 * cannot tell those apart is not worth reading.
 */
const VERDICT = {
    CONFIRMED: 'confirmed',
    HARMLESS: 'contradicted, harmless',
    NEEDS_FIX: 'contradicted, NEEDS FIX',
    PENDING: 'pending',
    ERROR: 'ERROR'
};

// ---------------------------------------------------------------------------
// Refuse to run anywhere else, loudly.
// ---------------------------------------------------------------------------

if (process.platform !== 'darwin') {
    console.error('');
    console.error('  This harness only means anything on macOS.');
    console.error('');
    console.error('  It answers the questions a GitHub macOS runner structurally cannot: a CI step');
    console.error('  has no controlling terminal, so no pty can open there and the pty layer gets no');
    console.error('  automated macOS coverage from CI at all.');
    console.error('');
    console.error('  Running here would produce a table of answers about ' + process.platform + ' wearing');
    console.error('  macOS labels, which is worse than no table.');
    console.error('');
    console.error('  Run it on the MacBook, from a clone outside iCloud Drive.');
    console.error('');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const sections = [];

function record(section) {
    sections.push(section);
}

/** Where the claude binary actually is, against the candidate list. */
function checkClaudeLocation() {
    const home = os.homedir();
    // Mirrors src/main/platform/darwin.ts. Kept in step by the note below
    // rather than imported, because this script is CommonJS and that module is
    // ESM TypeScript; if they drift the harness reports the wrong candidates.
    const candidates = [
        path.join(home, '.local', 'bin', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude'
    ];

    const found = candidates.find((c) => existsSync(c)) || null;

    let onPath = null;
    try {
        onPath = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() || null;
    } catch {
        onPath = null;
    }

    const detail = [
        'candidates: ' + candidates.join(', '),
        'first candidate that exists: ' + (found ?? 'none'),
        'which claude: ' + (onPath ?? 'not on PATH')
    ];

    if (found) {
        return { verdict: VERDICT.CONFIRMED, detail, note: 'the candidate list finds it' };
    }
    if (onPath) {
        return {
            verdict: VERDICT.NEEDS_FIX,
            detail,
            note: 'it is on PATH at ' + onPath + ' but no candidate matches. Add that path to ' +
                'claudeCandidates in src/main/platform/darwin.ts.'
        };
    }
    return {
        verdict: VERDICT.ERROR,
        detail,
        note: 'no claude binary found at all, so this machine cannot spawn an agent yet'
    };
}

/** node-pty under Electron on arm64, without a rebuild. */
function checkNodePtyUnderElectron() {
    const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
    const appDir = path.join(__dirname, 'electron-app');

    /**
     * `npm ci` does not produce this binary and is not supposed to.
     *
     * Electron removed its `postinstall` in 42.0.0, deliberately, because
     * postinstall scripts are a supply-chain attack vector. The binary now
     * downloads lazily the first time the `electron` bin runs, and the package
     * ships an `install-electron` bin for doing it on purpose instead.
     * Measured 2026-08-08: 41.1.0 has `postinstall: node install.js`, 42.0.0
     * and everything after it has no `scripts` field at all.
     *
     * So this section reports the command rather than telling anyone to run
     * `npm ci` again, which would never fix it. The download is not triggered
     * from here on purpose: it is roughly a hundred megabytes, and a harness
     * that quietly pulls that mid-run, inside a sixty second timeout, would
     * report a timeout rather than a download.
     */
    if (!existsSync(electron)) {
        return {
            verdict: VERDICT.ERROR,
            detail: [
                'expected the electron binary at ' + electron,
                'npm ci does not install it: electron dropped its postinstall in 42.0.0'
            ],
            note: 'run npm run electron:install, then run this again'
        };
    }

    const run = spawnSync(electron, [appDir], { encoding: 'utf8', timeout: 60000 });
    const line = String(run.stdout || '').split('\n').find((l) => l.startsWith('HARNESS_RESULT '));

    if (!line) {
        return {
            verdict: VERDICT.ERROR,
            detail: [
                'electron produced no result line',
                'stdout: ' + String(run.stdout || '').slice(0, 300),
                'stderr: ' + String(run.stderr || '').slice(0, 300)
            ],
            note: 'the probe did not run to completion'
        };
    }

    const result = JSON.parse(line.slice('HARNESS_RESULT '.length));
    const detail = [
        'electron ' + result.electron + ', node ' + result.node + ', abi ' + result.modules + ', ' + result.arch,
        'node-pty ' + (result.nodePty ?? 'unknown'),
        'loaded=' + result.loaded + ' spawned=' + result.spawned +
        ' streamed=' + result.streamed + ' resized=' + result.resized + ' killed=' + result.killed
    ];
    if (result.error) detail.push('error: ' + result.error);

    const checks = ['loaded', 'spawned', 'streamed', 'resized', 'killed'];
    const failed = checks.filter((name) => !result[name]);

    if (failed.length === 0) {
        return {
            verdict: VERDICT.CONFIRMED,
            detail,
            note: 'no rebuild needed, same as Windows. Node-API is ABI stable across Electron.'
        };
    }

    /**
     * Report which checks failed. Do not interpret them.
     *
     * This said "the pty layer does not work under Electron on this machine,
     * which changes the plan rather than a line of code" for any failure at
     * all. On 2026-08-08 it said exactly that with four of the five checks
     * passing, because the resize assertion was the ConPTY size report and a
     * Unix pty does not emit one. A reader following that note would have gone
     * to re-plan the pty layer over a wrong assertion.
     *
     * A harness that draws conclusions is a harness that can be confidently
     * wrong, and the cost of being confidently wrong is far higher here than
     * the cost of saying less. Escalating to a design conclusion needs more
     * than one failed check, so the note names what failed and leaves the
     * conclusion to a person.
     */
    return {
        verdict: VERDICT.NEEDS_FIX,
        detail,
        note:
            failed.length + ' of ' + checks.length + ' checks failed: ' + failed.join(', ') + '. ' +
            (failed.length === checks.length
                ? 'Nothing worked, so start with whether node-pty loaded at all.'
                : 'The rest passed, so this is a specific failure rather than the pty layer being unusable here. ' +
                  'Read the failing check before concluding anything about the design.')
    };
}

/**
 * Is the socket file under Application Support genuinely owner-only?
 *
 * This is the question whose Windows answer forced per-agent secrets: there the
 * default named pipe descriptor grants Everyone read. So the comparison matters,
 * and per-agent secrets stay whatever the answer is. That is why this section
 * can be `confirmed` or `contradicted, harmless` and never `NEEDS FIX` on the
 * ownership question itself.
 *
 * It can still be NEEDS FIX for a different reason, and on 2026-08-08 it was:
 * the plan that describes the directory has no consumer.
 */
function checkSocketOwnership() {
    const dir = path.join(os.homedir(), 'Library', 'Application Support', 'Stafford');
    const detail = [];

    // What the platform layer promises. Mirrored rather than imported, same as
    // the claude candidates above, and kept in step by the pinning test.
    detail.push('platform promises: parentDir ' + dir + ', parentMode 0700, ownerOnly true');

    // Does anything actually apply it? Measured by reading the source rather
    // than by trusting the plan, because a field nobody consumes reads exactly
    // like a field that works.
    const src = path.join(ROOT, 'src');
    let consumers = [];
    try {
        consumers = execFileSync('grep', ['-rl', '-e', 'parentMode', '-e', 'mkdirSync', '-e', 'mkdir(', src], { encoding: 'utf8' })
            .split('\n').filter(Boolean).filter((f) => !/\.test\.ts$/.test(f));
    } catch {
        consumers = [];
    }
    const applied = consumers.filter((f) => !/platform\//.test(f));

    detail.push('files under src/ that create the directory or apply its mode: ' +
        (applied.length ? applied.join(', ') : 'none'));
    detail.push('directory exists on this machine: ' + existsSync(dir));
    if (existsSync(dir)) {
        detail.push('directory mode: 0' + (statSync(dir).mode & 0o777).toString(8) + '  (expected 0700)');
    }

    if (applied.length === 0) {
        return {
            verdict: VERDICT.NEEDS_FIX,
            detail,
            note: 'SocketPlan.parentDir, parentMode and removeStaleFile have no consumer. Nothing ' +
                'creates the directory and nothing sets its mode, so HookListener.listen() fails ' +
                'with EACCES when it does not exist and inherits whatever mode it finds when it ' +
                'does. Measured: listen() threw EACCES and created nothing. Wire the plan in, and ' +
                'assert the mode on every startup rather than only at creation, because ' +
                'mkdirSync respects umask and does nothing at all when the directory already ' +
                'exists. The ownership question below cannot be answered until there is a socket.'
        };
    }

    // The parent directory is the subject, not the socket file.
    //
    // This section used to wait for a socket to exist and then report pending
    // with a line claiming owner-only access it had not tested. That is the
    // shape this project keeps finding, so it is gone: a unix socket cannot be
    // reached without traversing its parent, so the parent's mode IS the
    // protection, and the socket only exists while something is listening.
    // Waiting for it made a permanent property look like a transient one.
    const sock = path.join(dir, 'hook.sock');
    if (existsSync(sock)) {
        const st = statSync(sock);
        detail.push('socket present, mode 0' + (st.mode & 0o777).toString(8) +
            ', uid ' + st.uid + ', gid ' + st.gid);
    } else {
        detail.push('socket absent, which is expected unless a runner is listening right now');
    }

    const mode = statSync(dir).mode & 0o777;
    if (mode !== 0o700) {
        return {
            verdict: VERDICT.NEEDS_FIX,
            detail,
            note: 'the directory is mode 0' + mode.toString(8) + ' rather than 0700, so another ' +
                'account on this machine can traverse it and reach the socket. prepareSocket ' +
                'applies and verifies the mode on every startup and throws when it cannot, so ' +
                'either it has not run on this machine or something changed the mode afterwards.'
        };
    }

    detail.push('second principal, confirmed by hand 2026-08-08 against a live socket:');
    detail.push('  drwx------ 700 benzoo:staff ' + dir);
    detail.push('  sudo -u nobody ls ' + JSON.stringify(dir) + '  ->  Permission denied');
    detail.push('reproduce with:');
    detail.push('  stat -f ' + JSON.stringify('%Sp %Lp %Su:%Sg %N') + ' ' + JSON.stringify(dir));
    detail.push('  sudo -u nobody ls ' + JSON.stringify(dir));

    return {
        verdict: VERDICT.CONFIRMED,
        detail,
        note: 'the directory the platform promised is on disk at the mode it promised, created by ' +
            'prepareSocketFor rather than by this harness, and a second principal was refused. ' +
            'This is the darwin counterpart to the Windows named pipe granting Everyone read: the ' +
            'two platforms differ, and per-agent secrets exist because of the Windows answer and ' +
            'stay regardless of this one.'
    };
}

/** Pending: kill by process group against a real agent tree. */
/**
 * Two questions, not one, and they are in different states.
 *
 * Reporting a single pending verdict here would have said "not started", which
 * stopped being true once the mechanism was measured. The mechanism is settled
 * and the subject is not, and whoever runs this next needs to know which half
 * is open or they will re-measure the wrong one.
 */
function checkProcessGroupKill() {
    const detail = [
        'darwin.killTreePlan(pid): snapshot the tree, collect every group in it, kill each,',
        '  sweep survivors by pid, verify. It was killTreeCommand returning kill -9 -<pid>.',
        '',
        'the mechanism, CONFIRMED 2026-08-08 with a pty-spawned two-level tree and no Claude Code:',
        '  session row: {"pid":57854,"ppid":57853,"pgid":57854,"command":"/bin/sh"}',
        '  session leads its own group: true',
        '  sleep descendants: [{"pid":57855,"ppid":57854,"pgid":57854,"command":"sleep"}]',
        '    descendant of session: true  shares group: true',
        '  kill: kill -9 -57854',
        '  after kill, session alive: false, child 57855 alive: false, still in group: []',
        'so node-pty puts the session in its own group, a grandchild inherits it, and the kill',
        'reaches both. Had that been false, the kill would have been wrong on every POSIX',
        'platform for every user.',
        '',
        'the subject, ANSWERED 2026-08-08 and it was the bad answer:',
        '  tool    tail  pid 77302, ppid 77277, pgid 77277',
        '  session pgid 76638, leads its own group: true',
        '  child   descendant: true, shares its process group: false',
        '  kill -9 -76638  ->  session dead, child ALIVE, 0 left in the group',
        'Claude Code runs its Bash tool through a wrapper that leads its own process group, so',
        'the session group held only the session. The kill returned success and orphaned the',
        'child, which is the silent failure the design named in advance.',
        '',
        '',
        'the fix: killTreeCommand became killTreePlan, because the shape was wrong rather than',
        'the command. Tree teardown on POSIX is a procedure over state that must be measured',
        'before anything dies, since killing the root reparents its children and destroys the',
        'parent chain that identifies them. src/main/agents/kill-tree.ts executes it.',
        '',
        'still to do: re-run the harness and confirm nothing survives with the new procedure.',
        '  node src/main/cli/run-harness.ts'
    ];

    return {
        verdict: VERDICT.PENDING,
        detail,
        note: 'this is not "not started" and it is not "unknown". The subject was measured, the ' +
            'answer was that the kill orphaned a real process, and the plan has been reshaped to ' +
            'fix it. What is pending is the re-measurement that shows the fix works against a ' +
            'real agent tree, which is the only thing that can close this.'
    };
}

// ---------------------------------------------------------------------------
// Run and report
// ---------------------------------------------------------------------------

/**
 * Proves the harness works before any section makes a claim about macOS.
 *
 * Sections 1 and 2 have never run anywhere. Without this, the first run on the
 * Mac has two variables at once, the platform and the harness, and no way to
 * tell which produced a surprise. A green table would be unreadable.
 */
function selfCheck() {
    const detail = [];
    const problems = [];

    detail.push('platform is darwin: ' + (process.platform === 'darwin'));
    if (process.platform !== 'darwin') problems.push('not on darwin, though the guard should have caught that');

    const required = [
        path.join(__dirname, 'electron-app', 'main.js'),
        path.join(__dirname, 'electron-app', 'package.json'),
        path.join(__dirname, 'electron-app', 'pty-child.js'),
        path.join(ROOT, 'src', 'main', 'platform', 'darwin.ts')
    ];
    for (const file of required) {
        const there = existsSync(file);
        detail.push((there ? 'present: ' : 'MISSING: ') + path.relative(ROOT, file));
        if (!there) problems.push('missing ' + path.relative(ROOT, file));
    }

    // A check that must fail. If this passes, the harness is reporting success
    // for things it did not actually verify, and every verdict below is worth
    // nothing.
    const impossible = path.join(os.tmpdir(), 'stafford-harness-must-not-exist-' + process.pid);
    const impossibleExists = existsSync(impossible);
    detail.push('deliberately impossible check returns false: ' + (impossibleExists === false));
    if (impossibleExists) problems.push('a path that cannot exist was reported as existing');

    if (problems.length > 0) {
        return {
            verdict: VERDICT.ERROR,
            detail,
            note: 'the harness itself is broken, so nothing below ran: ' + problems.join('; ')
        };
    }
    return { verdict: VERDICT.CONFIRMED, detail, note: 'the harness is sound, so the sections below mean something' };
}

const zero = { id: '0', question: 'The harness itself works', ...selfCheck() };
record(zero);

if (zero.verdict !== VERDICT.CONFIRMED) {
    console.log('');
    console.log('SECTION 0 FAILED. Nothing else ran, because a broken harness reporting green about');
    console.log('macOS is worse than no harness at all.');
    for (const line of zero.detail) console.log('  ' + line);
    console.log('  ' + zero.note);
    process.exit(1);
}

record({ id: '1', question: 'Where the claude binary actually is', ...checkClaudeLocation() });
record({ id: '2', question: 'node-pty under Electron on arm64, no rebuild', ...checkNodePtyUnderElectron() });
record({ id: '3', question: 'Socket file under Application Support is owner-only', ...checkSocketOwnership() });
record({ id: '4', question: 'Kill by process group against a real agent tree', ...checkProcessGroupKill() });

let commit = 'unknown';
try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch {
    // Not fatal. A run outside a checkout is still a run.
}

const stamp = new Date().toISOString();
const lines = [];

lines.push('### macOS harness run, ' + stamp + ', commit ' + commit);
lines.push('');
lines.push('```');
lines.push('machine   ' + os.platform() + ' ' + os.arch() + ', darwin ' + os.release());
lines.push('node      ' + process.version);
lines.push('');
for (const section of sections) {
    lines.push(section.id + '. ' + section.question);
    lines.push('   verdict: ' + section.verdict);
    for (const d of section.detail) lines.push('   ' + d);
    lines.push('   note: ' + section.note);
    lines.push('');
}

const counts = sections.reduce((acc, s) => {
    acc[s.verdict] = (acc[s.verdict] ?? 0) + 1;
    return acc;
}, {});
lines.push('summary   ' + Object.entries(counts).map(([k, v]) => v + ' ' + k).join(', '));
lines.push('```');

const report = lines.join('\n');
console.log(report);

if (process.argv.includes('--write')) {
    appendFileSync(LOG, '\n' + report + '\n');
    console.log('');
    console.log('appended to ' + path.relative(ROOT, LOG));
}

// Only a needed fix or a broken check fails the run. A pending section is the
// expected state until its task lands, and a harmless contradiction is a
// finding rather than a problem.
const failing = sections.filter((s) => s.verdict === VERDICT.NEEDS_FIX || s.verdict === VERDICT.ERROR);
process.exit(failing.length > 0 ? 1 : 0);
