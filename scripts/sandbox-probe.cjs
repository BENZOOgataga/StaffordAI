/**
 * What the Claude Code Bash sandbox actually restricts.
 *
 * Run it twice, once through a sandboxed tool call and once outside one, and
 * diff the two columns. A row is only evidence about the sandbox if the control
 * run says OK, because a probe that fails in both columns is measuring the
 * machine.
 *
 * Every probe reports OK or DENIED and none of them abort the run. A probe that
 * throws tells you about one restriction and hides every one after it.
 *
 * **Anything that mutates state runs outside this repository**, per
 * docs/CONVENTIONS.md. That rule exists because an earlier version of this file
 * ran `git init` in the project directory, the write into `.git/hooks` was
 * denied, `git init` failed partway leaving no `.git`, and the `git add` and
 * `git commit` after it walked up and committed to the working branch. Twice.
 * Reads are fine anywhere; writes go to a scratch directory.
 *
 * CommonJS and `.cjs` because everything in scripts/ is, and because the
 * tracked-paths guard allows exactly `.cjs`, `.js` and `.json` here. It was a
 * shell script and CI refused it, which is the guard working.
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const SCRATCH = path.join(os.tmpdir(), 'stafford-sandbox-probe');
const results = [];

function probe(name, fn) {
    try {
        fn();
        results.push('OK      ' + name);
    } catch (error) {
        const code = error && error.code ? error.code : String(error).slice(0, 60);
        results.push('DENIED  ' + name + '  (' + code + ')');
    }
}

function sh(command, cwd) {
    execFileSync('/bin/sh', ['-c', command], { cwd: cwd || PROJECT, stdio: 'ignore' });
}

function fresh(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
}

// --- filesystem ------------------------------------------------------------

probe('write inside the project directory', () => {
    const p = path.join(PROJECT, '.sandbox-probe');
    fs.writeFileSync(p, 'x');
    fs.unlinkSync(p);
});

probe('write to the home directory, outside any project', () => {
    const p = path.join(os.homedir(), '.stafford-sandbox-probe');
    fs.writeFileSync(p, 'x');
    fs.unlinkSync(p);
});

probe('read the home directory listing', () => { fs.readdirSync(os.homedir()); });

probe('read ~/.gitconfig', () => { fs.readFileSync(path.join(os.homedir(), '.gitconfig')); });

// --- network ---------------------------------------------------------------

probe('outbound https to a public host', () => sh('curl -sS -m 8 -o /dev/null https://example.com'));

probe('outbound https to github, which a fetch would need', () =>
    sh('curl -sS -m 8 -o /dev/null https://github.com'));

probe('dns resolution', () => sh('nslookup github.com || host github.com'));

// --- git, in a scratch directory outside any repository --------------------

probe('git init in a scratch directory outside any repository', () => {
    fresh(SCRATCH);
    sh('git init -q .', SCRATCH);
});

probe('git add and commit in that repository', () => {
    sh('echo hello > file.txt && git add file.txt && ' +
        'git -c user.email=probe@example.invalid -c user.name=probe commit -q -m probe', SCRATCH);
});

fs.rmSync(SCRATCH, { recursive: true, force: true });

probe('git status in the real repository', () => sh('git status --short'));

probe('git fetch from the real remote', () => sh('git fetch --dry-run origin'));

// The two git paths that carry executable code or credentials. These are what
// make `git init` fail inside a project while succeeding outside one.

probe('write a plain file inside .git', () => {
    const p = path.join(PROJECT, '.git', 'probe');
    fs.writeFileSync(p, 'x');
    fs.unlinkSync(p);
});

probe('write into .git/hooks', () => {
    const p = path.join(PROJECT, '.git', 'hooks', 'probe');
    fs.writeFileSync(p, 'x');
    fs.unlinkSync(p);
});

probe('git config --local, which writes .git/config', () =>
    sh('git config --local probe.value 1 && git config --local --unset probe.value'));

// Both files registration writes. If either is denied, per-project registration
// fails on every sandboxed project and the launch repair sweep goes with it.

probe('append to .git/info/exclude, which registration writes', () => {
    const p = path.join(PROJECT, '.git', 'info', 'exclude');
    const before = fs.readFileSync(p, 'utf8');
    try {
        fs.appendFileSync(p, '# stafford probe\n');
    } finally {
        fs.writeFileSync(p, before);
    }
});

probe('write .claude/settings.local.json, the other file registration writes', () => {
    const p = path.join(PROJECT, '.claude', 'settings.local.probe.json');
    fs.writeFileSync(p, '{}');
    fs.unlinkSync(p);
});

// --- the multi-repo project model ------------------------------------------
//
// A project holds several repositories and a hire works across them, so a
// session started in one has to write in another.

const SIBLING = path.join(path.dirname(PROJECT), 'stafford-sandbox-sibling');

probe('write into a sibling repository in the same parent directory', () => {
    fresh(SIBLING);
    fs.writeFileSync(path.join(SIBLING, 'file.txt'), 'x');
});

probe('git init in that sibling', () => sh('git init -q .', SIBLING));

fs.rmSync(SIBLING, { recursive: true, force: true });

// --- sockets and processes -------------------------------------------------

probe('bind a unix socket under the project directory', () => {
    sh('node -e ' + JSON.stringify(
        'const n=require("net"),f=require("fs");const p=process.argv[1];' +
        'try{f.unlinkSync(p)}catch{};const s=n.createServer();' +
        's.on("error",()=>process.exit(1));s.listen(p,()=>{s.close();try{f.unlinkSync(p)}catch{};process.exit(0)})'
    ) + ' ' + JSON.stringify(path.join(PROJECT, '.sandbox-probe.sock')));
});

probe('bind a unix socket under Application Support', () => {
    sh('node -e ' + JSON.stringify(
        'const n=require("net"),f=require("fs");const p=process.argv[1];' +
        'try{f.unlinkSync(p)}catch{};const s=n.createServer();' +
        's.on("error",()=>process.exit(1));s.listen(p,()=>{s.close();try{f.unlinkSync(p)}catch{};process.exit(0)})'
    ) + ' ' + JSON.stringify(
        path.join(os.homedir(), 'Library', 'Application Support', 'Stafford', 'sandbox-probe.sock')
    ));
});

probe('spawn a child process', () => sh('true'));

probe('read the process table', () => sh('ps -Ao pid=,ppid=,pgid=,comm='));

process.stdout.write(results.join('\n') + '\n');
