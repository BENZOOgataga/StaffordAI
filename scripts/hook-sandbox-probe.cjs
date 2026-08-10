/**
 * Does a hook command run inside the Bash sandbox?
 *
 * The transport depends on the answer. A sandboxed tool call cannot bind or
 * connect to a unix socket under Application Support, measured twice, and a
 * hook command delivered `SessionStart` to exactly such a socket. That implies
 * hooks are outside the sandbox, and an implication is not a measurement, so
 * this runs the restricted operations from inside a real hook and writes down
 * what happened.
 *
 * Registered by the 6c harness in the scratch project alongside the forwarder,
 * never globally and never in a real project.
 *
 * Exits 0 whatever happens. A hook that fails degrades every session on the
 * machine, and this one is a probe rather than something anyone depends on.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function attempt(name, fn) {
    try {
        fn();
        return { name, allowed: true, error: null };
    } catch (error) {
        return { name, allowed: false, error: String(error && error.code ? error.code : error).slice(0, 80) };
    }
}

function main() {
    const out = process.env.STAFFORD_HOOK_PROBE_OUT;
    if (!out) process.exit(0);

    const results = [];

    // Denied for a sandboxed tool call. If this is allowed here, the hook is
    // not sandboxed, which is the whole question.
    const homeFile = path.join(os.homedir(), '.stafford-hook-sandbox-probe');
    results.push(attempt('write to the home directory', () => {
        fs.writeFileSync(homeFile, 'probe\n');
        fs.unlinkSync(homeFile);
    }));

    // The operation the transport actually needs, and the one measured as
    // denied under the sandbox.
    const dir = path.join(os.homedir(), 'Library', 'Application Support', 'Stafford');
    results.push(attempt('bind a unix socket under Application Support', () => {
        const net = require('net');
        const p = path.join(dir, 'hook-probe.sock');
        try { fs.unlinkSync(p); } catch { /* not there */ }
        const server = net.createServer();
        // Synchronous enough for a probe: listen throws EPERM immediately when
        // the sandbox refuses, which is the case being distinguished.
        server.listen(p);
        server.close();
        try { fs.unlinkSync(p); } catch { /* already gone */ }
    }));

    results.push(attempt('read the process table', () => {
        require('child_process').execFileSync('ps', ['-Ao', 'pid='], { stdio: 'ignore' });
    }));

    try {
        fs.appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }) + '\n');
    } catch {
        // Nothing to do. The absence of a line is itself reported by the harness.
    }
    process.exit(0);
}

main();
