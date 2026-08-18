/**
 * Hook forwarder. Reads the payload from stdin, sends a minimal summary to
 * Stafford's local socket, exits 0.
 *
 * Registered per managed project in that project's .claude/settings.local.json,
 * for six events, never globally and never for the per-tool events. Each hook
 * costs a process spawn, measured at 32ms on this machine before this script
 * does any work at all.
 *
 * Design constraints, all learned the hard way:
 *  - Never depends on bash. A ConPTY-spawned Claude Code does not inherit Git
 *    Bash on PATH, and a bash-dependent hook fails at SessionStart.
 *  - Never blocks and never fails loudly. If the runner is down this exits 0 in
 *    silence. A hook that errors or hangs degrades every Claude Code session on
 *    the machine, which is far worse than a stale card.
 *  - Never forwards tool inputs. Those contain file contents, prompts and
 *    sometimes secrets.
 *
 * Authentication is the per-agent secret from this session's own environment.
 * There is no shared token: the file at ~/.agent-dashboard/token is deleted and
 * nothing here can recreate it. An agent can read its own secret and no other,
 * so the worst it can do is forge events about itself, which it could already
 * do by behaving that way.
 *
 * TEMPORARY. A compiled Go binary replaces this, per section 4.3 of
 * docs/plans/stack-migration.technical.md. Until then this is the only
 * implementation, so there is exactly one transport client rather than two that
 * can quietly differ.
 */

'use strict';

const net = require('net');
const fs = require('fs');

const TIMEOUT_MS = 700;

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

/**
 * Keep only fields that describe state. Everything else is either useless to
 * Stafford or unsafe to move around.
 */
function summarise(payload) {
    const out = {
        event: payload.hook_event_name || null,
        sessionId: payload.session_id || null,
        cwd: payload.cwd || null,
        at: new Date().toISOString(),
        agentId: process.env.STAFFORD_AGENT_ID || null,
        secret: process.env.STAFFORD_AGENT_SECRET || null
    };

    if (payload.tool_name) out.toolName = payload.tool_name;
    if (payload.message) out.message = String(payload.message).slice(0, 500);
    if (payload.subagent_type) out.subagentType = payload.subagent_type;
    // The path to this session's transcript, on every payload. The state machine
    // ignores it; the activity feed tails it for the rich rows. A local file path,
    // not the transcript's contents, so it is safe to pass.
    if (payload.transcript_path) out.transcriptPath = String(payload.transcript_path);

    return out;
}

function main() {
    const socketPath = process.env.STAFFORD_SOCKET;
    if (!socketPath) process.exit(0);

    let payload = {};
    try {
        payload = JSON.parse(readStdin() || '{}');
    } catch {
        // A malformed payload is not worth failing a session over.
        process.exit(0);
    }

    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        process.exit(0);
    };

    // Hard ceiling regardless of what the socket does.
    const guard = setTimeout(finish, TIMEOUT_MS);
    guard.unref();

    try {
        const socket = net.connect(socketPath, () => {
            socket.write(JSON.stringify(summarise(payload)) + '\n');
        });
        socket.setTimeout(TIMEOUT_MS, finish);
        socket.on('data', finish);
        socket.on('error', finish);
        socket.on('close', finish);
    } catch {
        finish();
    }
}

main();
