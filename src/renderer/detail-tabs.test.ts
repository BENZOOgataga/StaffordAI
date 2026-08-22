/**
 * The tab order and the default: Conversation first and default, then Activity, then
 * Transcript, then Permissions. The first three are the inversion from the terminal-first
 * app, where the terminal used to lead.
 *
 * Permissions went after Transcript rather than beside Conversation because it is the tab I
 * open deliberately, not the one I want on opening a colleague. That keeps the front door
 * the message exchange.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TAB_ORDER, DEFAULT_TAB, isTabId, tabLabels, tabLabel } from './detail-tabs.ts';

test('the tabs are Conversation, Tasks, Activity, Transcript, Permissions, in that order', () => {
    assert.deepEqual([...TAB_ORDER], ['conversation', 'tasks', 'activity', 'transcript', 'permissions']);
});

test('Tasks sits second, since assigning work is something I act on rather than consult', () => {
    assert.equal(TAB_ORDER[1], 'tasks');
    assert.ok(TAB_ORDER.indexOf('tasks') < TAB_ORDER.indexOf('activity'),
        'Activity is what I consult to see how; Tasks is what I act on, so it comes first');
});

test('Conversation is the default tab, not Transcript', () => {
    assert.equal(DEFAULT_TAB, 'conversation');
    assert.equal(TAB_ORDER[0], DEFAULT_TAB, 'the default is the first tab');
    assert.notEqual(DEFAULT_TAB, 'transcript', 'the transcript is not the front door');
    assert.ok(TAB_ORDER.indexOf('transcript') > TAB_ORDER.indexOf('activity'),
        'the transcript stays an advanced tab, after activity');
    assert.equal(TAB_ORDER[TAB_ORDER.length - 1], 'permissions',
        'permissions is opened deliberately, so it sits last rather than beside the conversation');
});

test('only a known id activates a panel', () => {
    assert.equal(isTabId('conversation'), true);
    assert.equal(isTabId('transcript'), true);
    assert.equal(isTabId('permissions'), true);
    assert.equal(isTabId('nonsense'), false);
});

test('tab labels are localized, and Activity differs by language', () => {
    const en = tabLabels('en');
    const fr = tabLabels('fr');
    assert.equal(tabLabel(en, 'conversation'), 'Conversation');
    assert.equal(tabLabel(en, 'transcript'), 'Transcript');
    assert.equal(tabLabel(en, 'permissions'), 'Permissions');
    assert.notEqual(tabLabel(fr, 'activity'), tabLabel(en, 'activity'), 'Activity is translated');
    // Permissions is the same word in both, which is fine and worth pinning so a future
    // translation pass does not read the match as an oversight.
    assert.equal(tabLabel(fr, 'permissions'), 'Permissions');
});
