import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makePermissionGate } from './permission-gate.ts';
import type { AskRequest, AskOutcome } from './approval-registry.ts';
import type { ProjectPolicy } from '../../domain/models.ts';
import type { PermissionDecision } from './claude-runner.ts';

const CWD = path.resolve('/proj');
const USERDATA = path.resolve('/userdata');

function policy(over: Partial<ProjectPolicy> = {}): ProjectPolicy {
    return {
        push: 'none', allowedRoles: [], toolCeiling: null, writePaths: null,
        requirePipeline: false, allowWebFetch: true, permissionMode: 'default', maxConcurrentAgents: 1, ...over
    };
}

function gateFor(p: ProjectPolicy, onAsk?: (r: AskRequest) => Promise<AskOutcome>) {
    const g = makePermissionGate({
        getPolicy: () => p,
        getStoredRules: () => [],
        protectedPaths: [USERDATA],
        ...(onAsk ? { onAsk } : {})
    });
    return g({ hireId: 'h1', cwd: CWD, projectId: 'proj' });
}

const behavior = async (decision: PermissionDecision | Promise<PermissionDecision>): Promise<string> =>
    (await decision).behavior;

test('an in-scope read and write are allowed; ordinary shell is allowed', async () => {
    const tool = gateFor(policy());
    assert.equal(await behavior(tool('Read', { file_path: 'src/main.ts' })), 'allow');
    assert.equal(await behavior(tool('Write', { file_path: 'src/main.ts' })), 'allow');
    assert.equal(await behavior(tool('Bash', { command: 'npm test' })), 'allow');
    assert.equal(await behavior(tool('Task', { description: 'do a thing' })), 'allow');
});

test('a write outside the repo is denied', async () => {
    const tool = gateFor(policy());
    assert.equal(await behavior(tool('Write', { file_path: path.resolve('/somewhere/else.txt') })), 'deny');
});

test('path traversal does not widen scope: src/../.. resolves outside and denies', async () => {
    const tool = gateFor(policy({ writePaths: ['src'] }));
    assert.equal(await behavior(tool('Write', { file_path: 'src/x.ts' })), 'allow');
    assert.equal(await behavior(tool('Write', { file_path: 'src/../../outside.txt' })), 'deny');
});

test('the security invariant: reading or writing the config store is denied', async () => {
    const tool = gateFor(policy());
    const configDb = path.resolve('/userdata/Stafford/stafford.db');
    assert.equal(await behavior(tool('Read', { file_path: configDb })), 'deny');
    assert.equal(await behavior(tool('Write', { file_path: configDb })), 'deny');
    assert.equal(await behavior(tool('Edit', { file_path: path.resolve('/userdata/claude-config/.claude.json') })), 'deny');
});

test('without an ask handler, an ask resolves as deny (the phase-1 fallback)', async () => {
    const tool = gateFor(policy());
    const decision = await Promise.resolve(tool('Bash', { command: 'git push --force origin main' }));
    assert.equal(decision.behavior, 'deny');
    assert.equal(await behavior(tool('SomeMcpTool', {})), 'deny');
});

test('with an ask handler, an approved ask allows and a denied ask denies with the note', async () => {
    const approve = gateFor(policy(), async () => ({ approve: true, note: null }));
    assert.equal(await behavior(approve('Bash', { command: 'git push --force origin main' })), 'allow');

    const deny = gateFor(policy(), async () => ({ approve: false, note: 'not on main' }));
    const decision = await Promise.resolve(deny('Bash', { command: 'git push --force origin main' }));
    assert.equal(decision.behavior, 'deny');
    assert.equal((decision as { message: string }).message, 'not on main');

    // an ordinary command does not reach the ask handler at all
    let asked = false;
    const gate = gateFor(policy(), async () => { asked = true; return { approve: true, note: null }; });
    assert.equal(await behavior(gate('Bash', { command: 'npm test' })), 'allow');
    assert.equal(asked, false, 'an allowed action never asks');
});

test('fetch follows allowWebFetch: allowed when set, denied (ask fallback) when not', async () => {
    assert.equal(await behavior(gateFor(policy({ allowWebFetch: true }))('WebFetch', { url: 'https://example.com' })), 'allow');
    assert.equal(await behavior(gateFor(policy({ allowWebFetch: false }))('WebFetch', { url: 'https://example.com' })), 'deny');
});
