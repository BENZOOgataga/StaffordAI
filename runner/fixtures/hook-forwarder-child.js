/**
 * Test fixture standing in for a real Claude Code session plus its hook forwarder.
 *
 * It reads the same environment a real spawn hands over (STAFFORD_SOCKET,
 * STAFFORD_AGENT_SECRET, STAFFORD_AGENT_ID), connects to the socket, and posts a
 * SessionStart then a UserPromptSubmit with its secret and agent id, exactly as
 * the forwarder does. Then it stays alive so a teardown has a real process tree to
 * reap. It never touches claude.exe, so the suite stays offline and costs no quota.
 */

import net from 'node:net';

const socketPath = process.env.STAFFORD_SOCKET;
const secret = process.env.STAFFORD_AGENT_SECRET;
const agentId = process.env.STAFFORD_AGENT_ID;
const sessionId = 'sess-' + process.pid;

function post(event, done) {
    const socket = net.connect(socketPath);
    socket.on('error', () => done());
    socket.on('data', () => {}); // flow, so the ack and FIN are consumed
    socket.on('close', () => done());
    socket.on('connect', () => {
        socket.write(JSON.stringify({ event, sessionId, agentId, secret }) + '\n');
    });
}

// SessionStart, then UserPromptSubmit so the hire is driven to working, then stay
// alive until the teardown kills this process tree.
post('SessionStart', () => {
    post('UserPromptSubmit', () => {
        process.stdout.write('READY\n');
        setInterval(() => {}, 1000);
    });
});
