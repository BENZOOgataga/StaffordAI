import test from 'node:test';
import assert from 'node:assert/strict';
import { updateProject, deleteProject, rebindHire, ProjectBusyError, type ManageDeps } from './project-manage.ts';
import { AGENT_STATES } from '../../domain/agent-state.ts';
import type { HiredAgent, Project } from '../../domain/models.ts';

function project(id: string, path = '/repo/' + id): Project {
    return { id, name: 'P-' + id, repos: [{ path, label: id }], policy: {} as never };
}

function hire(id: string, over: Partial<HiredAgent> = {}): HiredAgent {
    return {
        id, name: 'Hire-' + id, type: 'lead-developer', title: 'Lead', seniority: 2, ownerId: 'owner',
        sessions: {}, activeProjectId: 'p1', state: AGENT_STATES.IDLE, hiredAt: '2026-01-01T00:00:00Z',
        activeSince: '2026-01-01T00:00:00Z', firedAt: null, ...over
    };
}

function makeDeps(projects: Project[], hires: HiredAgent[], over: Partial<ManageDeps> = {}): {
    deps: ManageDeps; projects: Map<string, Project>; hires: Map<string, HiredAgent>; deleted: string[];
} {
    const pMap = new Map(projects.map((p) => [p.id, p]));
    const hMap = new Map(hires.map((h) => [h.id, h]));
    const deleted: string[] = [];
    const deps: ManageDeps = {
        dirExists: () => true,
        isSelfPath: () => false,
        getProject: (id) => pMap.get(id) ?? null,
        updateProject: (p) => { pMap.set(p.id, p); },
        deleteProject: (id) => { pMap.delete(id); deleted.push(id); },
        allHires: () => [...hMap.values()],
        getHire: (id) => hMap.get(id) ?? null,
        updateHire: (h) => { hMap.set(h.id, h); },
        labelFor: (p) => p.split('/').pop() ?? p,
        now: () => '2026-06-01T00:00:00Z',
        ...over
    };
    return { deps, projects: pMap, hires: hMap, deleted };
}

test('updateProject edits the name and folder, keeping the policy, and validates the path as a create does', () => {
    const { deps, projects } = makeDeps([project('p1', '/old')], []);
    updateProject(deps, { id: 'p1', name: 'Renamed', repoPaths: ['/new/folder'] });
    const p = projects.get('p1')!;
    assert.equal(p.name, 'Renamed');
    assert.deepEqual(p.repos, [{ path: '/new/folder', label: 'folder' }]);
});

test('updateProject refuses a folder that does not exist, and one that is Stafford\'s own tree', () => {
    const { deps: missing } = makeDeps([project('p1')], [], { dirExists: () => false });
    assert.throws(() => updateProject(missing, { id: 'p1', name: 'x', repoPaths: ['/gone'] }), /not an existing directory/);
    const { deps: selfish } = makeDeps([project('p1')], [], { isSelfPath: () => true });
    assert.throws(() => updateProject(selfish, { id: 'p1', name: 'x', repoPaths: ['/stafford'] }), /Stafford's own directory/);
});

test('deleteProject parks its colleagues (unbinds, drops the gone session), and deletes the project', () => {
    const bound = hire('h1', { activeProjectId: 'p1', sessions: { p1: 's1', p2: 's2' } });
    const other = hire('h2', { activeProjectId: 'p2' });
    const { deps, projects, hires, deleted } = makeDeps([project('p1'), project('p2')], [bound, other]);
    deleteProject(deps, 'p1');
    assert.equal(projects.has('p1'), false, 'the project row is gone');
    assert.deepEqual(deleted, ['p1']);
    const parked = hires.get('h1')!;
    assert.equal(parked.activeProjectId, null, 'the bound colleague is parked, not deleted');
    assert.deepEqual(parked.sessions, { p2: 's2' }, 'the deleted project\'s session slot is dropped, no dangling reference');
    assert.equal(hires.get('h2')!.activeProjectId, 'p2', 'a colleague on another project is untouched');
});

test('deleteProject refuses while a bound colleague is still working, so a delete never strands a turn', () => {
    const busy = hire('h1', { activeProjectId: 'p1', state: AGENT_STATES.WORKING });
    const { deps, projects } = makeDeps([project('p1')], [busy]);
    assert.throws(() => deleteProject(deps, 'p1'), ProjectBusyError);
    assert.equal(projects.has('p1'), true, 'nothing is deleted when a colleague is busy');
});

test('rebindHire is a fresh start: new project, cleared session slot, and the binding epoch moved to now', () => {
    const parked = hire('h1', { activeProjectId: null, sessions: { p1: 's-old', p2: 's-prior' }, activeSince: '2026-01-01T00:00:00Z' });
    const { deps, hires } = makeDeps([project('p1'), project('p2')], [parked]);
    rebindHire(deps, { hireId: 'h1', projectId: 'p2' });
    const h = hires.get('h1')!;
    assert.equal(h.activeProjectId, 'p2', 'bound to the new project');
    assert.equal(h.sessions.p2, undefined, 'the new project\'s session slot is cleared, so the next turn starts fresh');
    assert.equal(h.sessions.p1, 's-old', 'an unrelated project\'s session is untouched');
    assert.equal(h.activeSince, '2026-06-01T00:00:00Z', 'the history view is bounded to the rebind, so the old project\'s context is not carried');
});

test('rebindHire refuses a colleague that is still working, and an unknown project', () => {
    const working = hire('h1', { state: AGENT_STATES.WORKING });
    const { deps } = makeDeps([project('p1')], [working]);
    assert.throws(() => rebindHire(deps, { hireId: 'h1', projectId: 'p1' }), /still working/);
    const { deps: d2 } = makeDeps([project('p1')], [hire('h1')]);
    assert.throws(() => rebindHire(d2, { hireId: 'h1', projectId: 'nope' }), /no such project/);
});

test('deleteProject excludes a fired colleague: it does not block the delete or get re-parked', () => {
    // A fired colleague is archived. Even in a working-looking state and bound to the project, it must
    // not throw ProjectBusyError, and it must not be re-parked. This is the colleagues-bound listing
    // filtering on firedAt; a read of one hire by id would not filter.
    const fired = hire('h1', { activeProjectId: 'p1', state: AGENT_STATES.WORKING, firedAt: '2026-08-20T00:00:00Z' });
    const live = hire('h2', { activeProjectId: 'p1', sessions: { p1: 's1' } });
    const { deps, hires, deleted } = makeDeps([project('p1')], [fired, live]);

    deleteProject(deps, 'p1');

    assert.deepEqual(deleted, ['p1'], 'the fired colleague did not block the delete');
    assert.equal(hires.get('h2')?.activeProjectId, null, 'the live colleague is parked');
    assert.equal(hires.get('h1')?.firedAt, '2026-08-20T00:00:00Z', 'the fired colleague is untouched');
    assert.equal(hires.get('h1')?.activeProjectId, 'p1', 'the fired colleague was not re-parked');
});
