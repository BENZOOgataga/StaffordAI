/**
 * The tab order and the default: Conversation first and default, then Tasks, then Activity,
 * then Permissions. The Transcript tab was retired once the Conversation tab rendered a
 * colleague's full turn, so it is gone from the set and a remembered "transcript" falls back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TAB_ORDER, DEFAULT_TAB, isTabId, tabLabels, tabLabel } from './detail-tabs.ts';

test('the tabs are Conversation, Tasks, Activity, Permissions, in that order, with Transcript gone', () => {
    assert.deepEqual([...TAB_ORDER], ['conversation', 'tasks', 'activity', 'permissions']);
    assert.equal((TAB_ORDER as readonly string[]).includes('transcript'), false, 'the transcript tab is retired');
});

test('Tasks sits second, since assigning work is something I act on rather than consult', () => {
    assert.equal(TAB_ORDER[1], 'tasks');
    assert.ok(TAB_ORDER.indexOf('tasks') < TAB_ORDER.indexOf('activity'),
        'Activity is what I consult to see how; Tasks is what I act on, so it comes first');
});

test('Conversation is the default tab', () => {
    assert.equal(DEFAULT_TAB, 'conversation');
    assert.equal(TAB_ORDER[0], DEFAULT_TAB, 'the default is the first tab');
    assert.equal(TAB_ORDER[TAB_ORDER.length - 1], 'permissions',
        'permissions is opened deliberately, so it sits last rather than beside the conversation');
});

test('only a known id activates a panel, and a retired transcript is not known so it falls back', () => {
    assert.equal(isTabId('conversation'), true);
    assert.equal(isTabId('activity'), true);
    assert.equal(isTabId('permissions'), true);
    assert.equal(isTabId('transcript'), false, 'a remembered transcript tab no longer activates a panel');
    assert.equal(isTabId('nonsense'), false);
});

test('tab labels are localized, and Activity differs by language', () => {
    const en = tabLabels('en');
    const fr = tabLabels('fr');
    assert.equal(tabLabel(en, 'conversation'), 'Conversation');
    assert.equal(tabLabel(en, 'permissions'), 'Permissions');
    assert.notEqual(tabLabel(fr, 'activity'), tabLabel(en, 'activity'), 'Activity is translated');
    assert.equal(tabLabel(fr, 'permissions'), 'Permissions');
});
