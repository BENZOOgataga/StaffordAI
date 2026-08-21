import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makePermissionGate } from './permission-gate.ts';
import type { ProjectPolicy } from '../../domain/models.ts';

const CWD = path.resolve('/proj');
const USERDATA = path.resolve('/userdata');

function policy(over: Partial<ProjectPolicy> = {}): ProjectPolicy {
    return {
        push: 'none', allowedRoles: [], toolCeiling: null, writePaths: null,
        requirePipeline: false, allowWebFetch: true, permissionMode: 'default', maxConcurrentAgents: 1, ...over
    };
}

function gateFor(p: ProjectPolicy) {
    const g = makePermissionGate({
        getPolicy: () => p,
        getStoredRules: () => [],
        protectedPaths: [USERDATA]
    });
    return g({ hireId: 'h1', cwd: CWD, projectId: 'proj' });
}

test('an in-scope read and write are allowed; ordinary shell is allowed', () => {
    const tool = gateFor(policy());
    assert.equal(tool('Read', { file_path: 'src/main.ts' }).behavior, 'allow');
    assert.equal(tool('Write', { file_path: 'src/main.ts' }).behavior, 'allow');
    assert.equal(tool('Bash', { command: 'npm test' }).behavior, 'allow');
    assert.equal(tool('Task', { description: 'do a thing' }).behavior, 'allow');
});

test('a write outside the repo is denied', () => {
    const tool = gateFor(policy());
    const decision = tool('Write', { file_path: path.resolve('/somewhere/else.txt') });
    assert.equal(decision.behavior, 'deny');
});

test('path traversal does not widen scope: src/../.. resolves outside and denies', () => {
    const tool = gateFor(policy({ writePaths: ['src'] }));
    // src/x is in scope
    assert.equal(tool('Write', { file_path: 'src/x.ts' }).behavior, 'allow');
    // src/../../outside resolves above the repo, out of scope -> deny
    assert.equal(tool('Write', { file_path: 'src/../../outside.txt' }).behavior, 'deny');
});

test('the security invariant: reading or writing the config store is denied', () => {
    const tool = gateFor(policy());
    const configDb = path.resolve('/userdata/Stafford/stafford.db');
    assert.equal(tool('Read', { file_path: configDb }).behavior, 'deny');
    assert.equal(tool('Write', { file_path: configDb }).behavior, 'deny');
    // even a shell command cannot be allowed to write there via an ordinary path (write category)
    assert.equal(tool('Edit', { file_path: path.resolve('/userdata/claude-config/.claude.json') }).behavior, 'deny');
});

test('phase 1: an ask resolves as deny with an approval-not-available message', () => {
    const tool = gateFor(policy());
    const destructive = tool('Bash', { command: 'git push --force origin main' });
    assert.equal(destructive.behavior, 'deny');
    assert.match((destructive as { message: string }).message, /approval/i);
    // an unknown tool is other -> ask -> deny in phase 1
    assert.equal(tool('SomeMcpTool', {}).behavior, 'deny');
});

test('a deny carries a clean message the model can read, not a crash', () => {
    const tool = gateFor(policy());
    const decision = tool('Write', { file_path: path.resolve('/somewhere/else.txt') });
    assert.equal(decision.behavior, 'deny');
    assert.equal(typeof (decision as { message: string }).message, 'string');
    assert.ok((decision as { message: string }).message.length > 0);
});

test('fetch follows allowWebFetch: allowed when set, denied (ask) when not', () => {
    assert.equal(gateFor(policy({ allowWebFetch: true }))('WebFetch', { url: 'https://example.com' }).behavior, 'allow');
    assert.equal(gateFor(policy({ allowWebFetch: false }))('WebFetch', { url: 'https://example.com' }).behavior, 'deny');
});
