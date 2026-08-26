/**
 * The create flow closes the /x failure. A project is created only against a real
 * directory, and a hire created into it binds so its cold-spawn cwd resolves to
 * that real directory rather than the bogus path the smoke fixture had. The bad
 * path is refused at create time with no row written.
 *
 * The directory check runs against a real temp dir the test makes, so the
 * load-bearing validation is exercised for real, not stubbed away.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProject, createHire, defaultPolicy, type CreateDeps } from './create-flow.ts';
import type { Project, HiredAgent } from '../../domain/models.ts';

function harness(over: { isSelfPath?: (p: string) => boolean } = {}) {
    const projects = new Map<string, Project>();
    const hires: HiredAgent[] = [];
    // Every name the flow drew, so a test can prove the name comes from the draw and that a
    // rejected hire never drew one.
    const drawn: string[] = [];
    let n = 0;
    let nameN = 0;
    const deps: CreateDeps = {
        // The real filesystem check, so the directory validation is genuine.
        dirExists: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
        isSelfPath: over.isSelfPath ?? (() => false),
        insertProject: (project) => { projects.set(project.id, project); },
        getProject: (id) => projects.get(id) ?? null,
        insertHire: (hire) => { hires.push(hire); },
        assignName: () => { const nm = 'Drawn-' + (++nameN); drawn.push(nm); return nm; },
        uuid: () => 'id-' + (++n),
        now: () => '2026-08-13T00:00:00.000Z',
        ownerId: 'owner',
        labelFor: (p) => path.basename(p) || p
    };
    return { deps, projects, hires, drawn };
}

/**
 * resolveTarget as index.ts builds it: a hire's active project's first repo path
 * is the cold-spawn cwd. Reproduced here so the test proves the created hire
 * resolves to a real cwd, which is the thing that was broken.
 */
function resolveCwd(projects: Map<string, Project>, hire: HiredAgent): string | null {
    if (!hire.activeProjectId) return null;
    const project = projects.get(hire.activeProjectId);
    return project?.repos[0]?.path ?? null;
}

test('a hire created into a project at a real path resolves its cold-spawn cwd to that real path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stafford-create-'));
    try {
        const { deps, projects, hires } = harness();
        const project = createProject(deps, { name: 'Stafford', repoPaths: [dir] });
        const hire = createHire(deps, {
            type: 'lead-developer', title: 'Lead developer', projectId: project.id
        });

        const stored = hires.find((h) => h.id === hire.id);
        assert.ok(stored, 'the hire was written');
        assert.equal(stored?.name, 'Drawn-1', 'the name comes from the draw, not from the renderer');
        assert.equal(stored?.activeProjectId, project.id, 'the hire is bound to the project');
        const cwd = resolveCwd(projects, stored!);
        assert.equal(cwd, dir, 'the cold-spawn cwd resolves to the real directory, not /x and not undefined');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a created hire has activeSince exactly equal to hiredAt, even when the clock advances between reads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stafford-create-'));
    try {
        const { deps, hires } = harness();
        // An advancing clock: each read returns a later time. The hire time and the binding epoch must
        // still be equal, because they come from one read, not two.
        let tick = 0;
        const advancing: CreateDeps = { ...deps, now: () => '2026-08-13T00:00:0' + (tick++) + '.000Z' };
        const project = createProject(advancing, { name: 'Stafford', repoPaths: [dir] });
        const hire = createHire(advancing, { type: 'lead-developer', title: 'Lead developer', projectId: project.id });
        const stored = hires.find((h) => h.id === hire.id)!;
        assert.equal(stored.activeSince, stored.hiredAt, 'the binding epoch equals the hire time at creation');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('project:create with a nonexistent path is rejected and no project row is written', () => {
    const { deps, projects } = harness();
    const bogus = path.join(os.tmpdir(), 'stafford-does-not-exist-' + Math.floor(1)) + '-x';
    assert.throws(
        () => createProject(deps, { name: 'Stafford', repoPaths: [bogus] }),
        /not an existing directory/
    );
    assert.equal(projects.size, 0, 'nothing was written for a bad path');
});

test("project:create with a folder that is Stafford's own directory is rejected, no row written", () => {
    // A real, existing directory, so the dirExists check passes and the self-path guard is what
    // refuses it, not the not-a-directory check.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stafford-self-'));
    try {
        const { deps, projects } = harness({ isSelfPath: (p) => p === dir });
        assert.throws(
            () => createProject(deps, { name: 'Stafford', repoPaths: [dir] }),
            /Stafford's own directory/
        );
        assert.equal(projects.size, 0, 'nothing was written for a self-path');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('project:create with a real, non-self folder still succeeds', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stafford-ok-'));
    try {
        const { deps, projects } = harness({ isSelfPath: () => false });
        const project = createProject(deps, { name: 'Stafford', repoPaths: [dir] });
        assert.ok(project.id, 'a legitimate folder creates a project');
        assert.equal(projects.size, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('project:create with a path that is a file, not a directory, is rejected', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stafford-file-')), 'a.txt');
    fs.writeFileSync(file, 'x');
    try {
        const { deps, projects } = harness();
        assert.throws(() => createProject(deps, { name: 'p', repoPaths: [file] }), /not an existing directory/);
        assert.equal(projects.size, 0);
    } finally {
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
});

test('project:create with an empty name or no repo path is rejected, no row written', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stafford-create-'));
    try {
        const { deps, projects } = harness();
        assert.throws(() => createProject(deps, { name: '   ', repoPaths: [dir] }), /needs a name/);
        assert.throws(() => createProject(deps, { name: 'p', repoPaths: [] }), /at least one repo path/);
        assert.equal(projects.size, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a created project carries a fresh id, the conservative default policy, and no sandbox field', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stafford-create-'));
    try {
        const { deps, projects } = harness();
        const view = createProject(deps, { name: 'Stafford', repoPaths: [dir] });
        assert.equal(view.id.startsWith('smoke-'), false, 'no smoke- prefix');
        const stored = projects.get(view.id);
        assert.deepEqual(stored?.policy, defaultPolicy(), 'the conservative default policy');
        assert.equal('sandbox' in (stored?.policy ?? {}), false, 'no sandbox field was added');
        assert.equal(stored?.policy.push, 'none');
        assert.equal(stored?.policy.maxConcurrentAgents, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('hire:create into a nonexistent project, or with an unknown type, is rejected with no row written', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stafford-create-'));
    try {
        const { deps, hires, drawn } = harness();
        const project = createProject(deps, { name: 'Stafford', repoPaths: [dir] });
        assert.throws(
            () => createHire(deps, { type: 'lead-developer', title: 'Lead developer', projectId: 'nope' }),
            /no such project/
        );
        assert.throws(
            () => createHire(deps, { type: 'not-a-role', title: 'X', projectId: project.id }),
            /unknown definition type/
        );
        assert.equal(hires.length, 0, 'no hire was written for a bad input');
        assert.equal(drawn.length, 0, 'a rejected hire never drew a name, so none is burned');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a created hire takes the definition seniority and starts idle with no session', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stafford-create-'));
    try {
        const { deps, hires } = harness();
        const project = createProject(deps, { name: 'Stafford', repoPaths: [dir] });
        createHire(deps, { type: 'lead-developer', title: 'Lead developer', projectId: project.id });
        const stored = hires[0];
        assert.equal(stored?.name, 'Drawn-1', 'the name is drawn, not passed in');
        assert.equal(stored?.seniority, 1, 'seniority comes from the definition, not the renderer');
        assert.equal(stored?.state, 'idle', 'a fresh hire is idle');
        assert.deepEqual(stored?.sessions, {}, 'no session yet');
        assert.equal(stored?.id.startsWith('smoke-'), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
