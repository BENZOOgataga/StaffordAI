/**
 * The saved-work notice copy, localized. No hardcoded English in the view, and the
 * text flexes for the longer French.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { savedWorkHeader, savedWorkLinePrefix, dismissLabel } from './checkpoints-view.ts';

test('the header is localized and plural-aware', () => {
    assert.equal(savedWorkHeader(1, 'en'), 'Saved work');
    assert.equal(savedWorkHeader(2, 'en'), 'Saved work');
    assert.equal(savedWorkHeader(1, 'fr'), 'Travail sauvegardé');
    assert.equal(savedWorkHeader(2, 'fr'), 'Travaux sauvegardés');
});

test('the line prefix names the colleague and is localized', () => {
    assert.equal(savedWorkLinePrefix('Marion', 'en'), "Saved Marion's work to");
    assert.equal(savedWorkLinePrefix('Marion', 'fr'), 'Travail de Marion sauvegardé sur');
    assert.notEqual(savedWorkLinePrefix('Marion', 'fr'), savedWorkLinePrefix('Marion', 'en'));
});

test('the dismiss label is localized', () => {
    assert.equal(dismissLabel('en'), 'Dismiss');
    assert.equal(dismissLabel('fr'), 'Ignorer');
});
