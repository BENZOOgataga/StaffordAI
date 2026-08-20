/**
 * The tab order and the default: Conversation first and default, Activity second,
 * Transcript last. This is the inversion from the terminal-first app.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TAB_ORDER, DEFAULT_TAB, isTabId, tabLabels, tabLabel } from './detail-tabs.ts';

test('the tabs are Conversation, Activity, Transcript, in that order', () => {
    assert.deepEqual([...TAB_ORDER], ['conversation', 'activity', 'transcript']);
});

test('Conversation is the default tab, not Transcript', () => {
    assert.equal(DEFAULT_TAB, 'conversation');
    assert.equal(TAB_ORDER[0], DEFAULT_TAB, 'the default is the first tab');
    assert.notEqual(DEFAULT_TAB, 'transcript', 'the transcript is not the front door');
    assert.equal(TAB_ORDER[TAB_ORDER.length - 1], 'transcript', 'the transcript is the last, advanced tab');
});

test('only the three known ids activate a panel', () => {
    assert.equal(isTabId('conversation'), true);
    assert.equal(isTabId('transcript'), true);
    assert.equal(isTabId('nonsense'), false);
});

test('tab labels are localized, and Activity differs by language', () => {
    const en = tabLabels('en');
    const fr = tabLabels('fr');
    assert.equal(tabLabel(en, 'conversation'), 'Conversation');
    assert.equal(tabLabel(en, 'transcript'), 'Transcript');
    assert.notEqual(tabLabel(fr, 'activity'), tabLabel(en, 'activity'), 'Activity is translated');
});
