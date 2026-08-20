import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isChannelPage, isChannelSince, isProjectCreate, isHireCreate
} from './guards.ts';

test('project:create needs a bounded name and a non-empty list of bounded paths', () => {
    assert.equal(isProjectCreate({ name: 'Stafford', repoPaths: ['C:/repo'] }), true);
    assert.equal(isProjectCreate({ name: 'p', repoPaths: ['/a', '/b'] }), true);

    assert.equal(isProjectCreate({ name: '', repoPaths: ['/a'] }), false, 'empty name');
    assert.equal(isProjectCreate({ name: 'p', repoPaths: [] }), false, 'no path');
    assert.equal(isProjectCreate({ name: 'p', repoPaths: [42] }), false, 'a path is not a string');
    assert.equal(isProjectCreate({ name: 'p', repoPaths: ['x'.repeat(4097)] }), false, 'path over the cap');
    assert.equal(isProjectCreate({ name: 'p' }), false, 'no repoPaths');
    assert.equal(isProjectCreate(null), false);
});

test('hire:create needs bounded name, type, title, and project id', () => {
    assert.equal(isHireCreate({ name: 'Marion', type: 'lead-developer', title: 'Lead developer', projectId: 'p1' }), true);

    assert.equal(isHireCreate({ name: '', type: 'lead-developer', title: 't', projectId: 'p1' }), false, 'empty name');
    assert.equal(isHireCreate({ name: 'M', type: '', title: 't', projectId: 'p1' }), false, 'empty type');
    assert.equal(isHireCreate({ name: 'M', type: 'lead-developer', title: 't' }), false, 'no project id');
    assert.equal(isHireCreate({ name: 'M', type: 'lead-developer', title: 't', projectId: 42 }), false, 'project id not a string');
    assert.equal(isHireCreate(null), false);
});

test('a channel page read takes a null-or-cursor before and a bounded limit', () => {
    assert.equal(isChannelPage({ before: null, limit: 50 }), true, 'null before is the newest page');
    assert.equal(isChannelPage({ before: { at: 't', id: 'a' }, limit: 20 }), true, 'a cursor is scroll-back');
    assert.equal(isChannelPage({ limit: 50 }), false, 'before is required, even if null');
    assert.equal(isChannelPage({ before: { at: 't' }, limit: 50 }), false, 'a cursor needs an id');
    assert.equal(isChannelPage({ before: null, limit: 0 }), false, 'limit out of bounds');
    assert.equal(isChannelPage({ before: null, limit: 5000 }), false, 'over the cap');
    assert.equal(isChannelPage(null), false);
});

test('a channel since read takes a cursor and a bounded limit', () => {
    assert.equal(isChannelSince({ after: { at: 't', id: 'a' }, limit: 50 }), true);
    assert.equal(isChannelSince({ after: null, limit: 50 }), false, 'after is required');
    assert.equal(isChannelSince({ after: { id: 'a' }, limit: 50 }), false, 'the cursor needs a timestamp');
    assert.equal(isChannelSince({ after: { at: 't', id: 'a' }, limit: 0 }), false);
});
