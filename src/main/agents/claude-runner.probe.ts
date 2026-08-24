/**
 * Real-Claude probe for the headless ClaudeRunner (phase 2).
 *
 * This is not a unit test. It spawns REAL Claude Code and costs subscription quota, so
 * it is never run in CI and lives outside the test suite. It is the same kind of probe
 * that found the pty delivery bugs: drive the real thing and read the real wire.
 *
 * What it proves:
 *  1. One real turn: send a message, read the stream to `result`, capture the session
 *     id from init, return the assistant text.
 *  2. Sequential turns via --resume: several messages, each its own completed turn,
 *     ordered and distinct, no concatenation, no drop, no first-message swallow. This
 *     is the exact behaviour the rc.1 pty path gets wrong, correct here by construction.
 *  3. #61 isolation: the child runs against a managed CLAUDE_CONFIG_DIR and writes its
 *     session state there, not into the user's real ~/.claude.
 *
 * The raw wire (both directions) is written to a log file, since the migration keeps no
 * debug view and the log is the only window on the exchange.
 *
 * Run (Windows, local, logged in to Claude):
 *   node src/main/agents/claude-runner.probe.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClaudeRunner, type WireDirection } from './claude-runner.ts';
import { seedManagedConfig, type ManagedFs } from './managed-config.ts';

const realFs: ManagedFs = {
    exists: (p) => fs.existsSync(p),
    readText: (p) => fs.readFileSync(p, 'utf8'),
    writeText: (p, d, mode) => fs.writeFileSync(p, d, { mode }),
    mkdirp: (p, mode) => fs.mkdirSync(p, { recursive: true, mode }),
    copyFile: (from, to, mode) => { fs.copyFileSync(from, to); try { fs.chmodSync(to, mode); } catch { /* windows */ } },
    chmod: (p, mode) => { try { fs.chmodSync(p, mode); } catch { /* windows */ } },
    mtimeMs: (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } },
    join: (...parts) => path.join(...parts)
};

function findClaude(): string {
    const home = os.homedir();
    const candidates = [
        path.join(home, '.local', 'bin', 'claude.exe'),
        path.join(home, '.local', 'bin', 'claude'),
        path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        'claude'
    ];
    for (const c of candidates) if (c === 'claude' || fs.existsSync(c)) return c;
    throw new Error('claude binary not found; checked ' + candidates.join(', '));
}

function crop(text: string, n = 600): string {
    const clean = text.replace(/\r/g, '').trim();
    return clean.length > n ? clean.slice(0, n) + ' ...[cropped]' : clean;
}

async function main(): Promise<void> {
    const claudePath = findClaude();
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stafford-runner-probe-'));
    const managedDir = path.join(workRoot, 'managed-config');
    const projectDir = path.join(workRoot, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const logPath = path.join(workRoot, 'wire.log');
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    // #61 isolation: seed the managed dir exactly as the app does, then point
    // CLAUDE_CONFIG_DIR at it. The child must read this, not the user's ~/.claude.
    const seed = seedManagedConfig({
        fs: realFs,
        managedDir,
        realHome: os.homedir(),
        resolveKey: (dir) => path.resolve(dir),
        settings: {}
    }, projectDir);

    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: managedDir };

    const onRawLine = (line: string, dir: WireDirection): void => {
        logStream.write((dir === 'out' ? '>> ' : '<< ') + line + '\n');
    };

    console.log('=== ClaudeRunner real probe ===');
    console.log('claude:      ' + claudePath);
    console.log('managed dir: ' + managedDir);
    console.log('project dir: ' + projectDir);
    console.log('credential copied into managed dir: ' + seed.credentialCopied);
    console.log('wire log:    ' + logPath);
    console.log('');

    const runner = new ClaudeRunner({ claudePath, cwd: projectDir, env, onRawLine, timeoutMs: 120_000 });

    // --- Turn 1: fresh session ---------------------------------------------
    console.log('--- Turn 1 (fresh) ---');
    const t1 = await runner.runTurn({ text: 'Reply with exactly this token and nothing else: STAFFORD-OK-1' });
    console.log('status:      ' + t1.status);
    console.log('session id:  ' + t1.sessionId);
    console.log('assistant:   ' + crop(t1.assistantText));
    console.log('tool uses:   ' + t1.toolUses.length);
    console.log('');

    if (t1.status !== 'completed' || !t1.sessionId) {
        console.error('Turn 1 did not complete cleanly. See wire log: ' + logPath);
        logStream.end();
        process.exit(1);
    }

    // --- Turns 2 and 3: resume the same session ----------------------------
    const runner2 = new ClaudeRunner({ claudePath, cwd: projectDir, env, onRawLine, timeoutMs: 120_000 });
    console.log('--- Turn 2 (resume ' + t1.sessionId + ') ---');
    const t2 = await runner2.runTurn({
        text: 'Reply with exactly this token and nothing else: STAFFORD-OK-2',
        resumeSessionId: t1.sessionId
    });
    console.log('status:      ' + t2.status);
    console.log('session id:  ' + t2.sessionId);
    console.log('assistant:   ' + crop(t2.assistantText));
    console.log('');

    const runner3 = new ClaudeRunner({ claudePath, cwd: projectDir, env, onRawLine, timeoutMs: 120_000 });
    console.log('--- Turn 3 (resume) ---');
    const t3 = await runner3.runTurn({
        text: 'What were the two tokens I asked you to say so far? List them on one line, separated by a space.',
        resumeSessionId: t2.sessionId ?? t1.sessionId
    });
    console.log('status:      ' + t3.status);
    console.log('assistant:   ' + crop(t3.assistantText));
    console.log('');

    // --- Ordered + distinct, no concatenation ------------------------------
    console.log('--- Sequential-turns proof ---');
    const okOrdered =
        t1.assistantText.includes('STAFFORD-OK-1') &&
        t2.assistantText.includes('STAFFORD-OK-2') &&
        !t1.assistantText.includes('STAFFORD-OK-2') &&
        !t2.assistantText.includes('STAFFORD-OK-1');
    console.log('turn 1 carries only its own token:  ' + (t1.assistantText.includes('STAFFORD-OK-1') && !t1.assistantText.includes('STAFFORD-OK-2')));
    console.log('turn 2 carries only its own token:  ' + (t2.assistantText.includes('STAFFORD-OK-2') && !t2.assistantText.includes('STAFFORD-OK-1')));
    console.log('turn 3 recalls both (context kept):  ' + (t3.assistantText.includes('STAFFORD-OK-1') && t3.assistantText.includes('STAFFORD-OK-2')));
    console.log('ordered + distinct, no concatenation: ' + okOrdered);
    console.log('');

    // --- #61 isolation: state landed in the managed dir, not ~/.claude -----
    console.log('--- Isolation proof (#61) ---');
    const managedProjects = path.join(managedDir, 'projects');
    const managedHasState = fs.existsSync(managedProjects) && fs.readdirSync(managedProjects).length > 0;
    console.log('managed dir top-level entries: ' + fs.readdirSync(managedDir).join(', '));
    console.log('managed dir has projects/ state written by the child: ' + managedHasState);

    // The real ~/.claude must NOT have gained a project entry for this probe cwd.
    const realProjects = path.join(os.homedir(), '.claude', 'projects');
    const keyFragment = path.basename(projectDir);
    let leakedIntoReal = false;
    if (fs.existsSync(realProjects)) {
        leakedIntoReal = fs.readdirSync(realProjects).some((e) => e.includes(keyFragment));
    }
    console.log('leaked into real ~/.claude/projects: ' + leakedIntoReal);
    console.log('');

    logStream.end();

    const allGood = t1.status === 'completed' && t2.status === 'completed' && t3.status === 'completed'
        && okOrdered && managedHasState && !leakedIntoReal;
    console.log('=== RESULT: ' + (allGood ? 'PASS' : 'CHECK ABOVE') + ' ===');
    console.log('Full wire (both directions) in: ' + logPath);
    console.log('Work dir (delete when done): ' + workRoot);
    process.exit(allGood ? 0 : 1);
}

main().catch((err) => {
    console.error('probe failed: ' + (err instanceof Error ? err.stack : String(err)));
    process.exit(1);
});
