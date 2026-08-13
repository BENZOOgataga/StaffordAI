/**
 * The create forms' pure decisions: the path hint is advisory only, hiring is
 * gated until a project exists, a lone project is preselected, and the copy is
 * localized. Main stays the authority on whether a path is real, which the
 * create-flow tests prove; here the hint is shown to never gate or replace it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    pathHint, projectSubmittable, canHire, preselectedProjectId, roleOptions,
    titleForType, formCopy, hintText
} from './create-forms-view.ts';

test('the path hint reads the string shape and is advisory, never an existence check', () => {
    assert.equal(pathHint(''), 'empty');
    assert.equal(pathHint('   '), 'empty');
    assert.equal(pathHint('C:/Users/me/repo'), 'looks-absolute');
    assert.equal(pathHint('C:\\Users\\me\\repo'), 'looks-absolute');
    assert.equal(pathHint('/Users/me/repo'), 'looks-absolute');
    assert.equal(pathHint('repo'), 'looks-relative', 'a relative-looking path is only hinted, not blocked');
    // The hint says a path looks fine even for a directory that does not exist:
    // it cannot know, which is exactly why main is the authority.
    assert.equal(pathHint('/definitely/not/here/at/all'), 'looks-absolute');
});

test('a project form submits only with a name and a path, and the hint never gates it', () => {
    assert.equal(projectSubmittable({ name: 'Stafford', repoPath: '/x' }), true);
    assert.equal(projectSubmittable({ name: '  ', repoPath: '/x' }), false);
    assert.equal(projectSubmittable({ name: 'Stafford', repoPath: '   ' }), false);
    // A relative-looking path is still submittable: the client does not block it,
    // main validates and rejects it.
    assert.equal(projectSubmittable({ name: 'Stafford', repoPath: 'relative' }), true);
});

test('hiring is gated until a project exists', () => {
    assert.equal(canHire(0), false, 'no project means no dead-end hire');
    assert.equal(canHire(1), true);
});

test('a lone project is preselected, several are not', () => {
    assert.equal(preselectedProjectId([{ id: 'p1' }]), 'p1');
    assert.equal(preselectedProjectId([{ id: 'p1' }, { id: 'p2' }]), null);
    assert.equal(preselectedProjectId([]), null);
});

test('the role picker offers the six definitions and the title follows the role', () => {
    const roles = roleOptions();
    assert.equal(roles.length, 6);
    assert.equal(titleForType('lead-developer'), 'Lead developer');
    assert.equal(titleForType('writer'), 'Writer');
});

test('the copy is localized, and the French labels are the longer text the layout flexes for', () => {
    const en = formCopy('en');
    const fr = formCopy('fr');
    assert.notEqual(en.addProject, fr.addProject, 'the same label differs by language');
    assert.ok(fr.emptyLead.length > 0 && fr.hire.length > 0);
    // French is longer here, which is the case the labels have to flex for.
    assert.ok(fr.hire.length >= en.hire.length, 'the French hire label is at least as long as the English');
    assert.equal(hintText(en, pathHint('')), en.hintEmpty);
    assert.equal(hintText(en, pathHint('/x')), en.hintAbsolute);
});
