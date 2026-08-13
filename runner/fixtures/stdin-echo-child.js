/**
 * Test fixture: a session that reads stdin and answers, so the write half can be
 * proven end to end. It posts SessionStart to bind, then for each line it receives
 * on stdin it writes ECHO:<line> to stdout (which streams back to the terminal) and
 * posts UserPromptSubmit, the way a real session reacts to a message. It never
 * touches claude.exe.
 */

import net from 'node:net';

const socketPath = process.env.STAFFORD_SOCKET;
const secret = process.env.STAFFORD_AGENT_SECRET;
const agentId = process.env.STAFFORD_AGENT_ID;
const sessionId = 'sess-' + process.pid;

function post(event, done) {
    const socket = net.connect(socketPath);
    socket.on('error', () => done && done());
    socket.on('data', () => {});
    socket.on('close', () => done && done());
    socket.on('connect', () => { socket.write(JSON.stringify({ event, sessionId, agentId, secret }) + '\n'); });
}

post('SessionStart', () => {
    process.stdout.write('READY\n');
    let pending = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        pending += chunk;
        let index;
        while ((index = pending.search(/[\r\n]/)) !== -1) {
            const line = pending.slice(0, index).trim();
            pending = pending.slice(index + 1);
            if (!line) continue;
            process.stdout.write('ECHO:' + line + '\r\n');
            post('UserPromptSubmit');
        }
    });
    setInterval(() => {}, 1000);
});
