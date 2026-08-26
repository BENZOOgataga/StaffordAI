import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAskQuestions, parseAskAnswers, summariseAsk } from './ask-parse.ts';

test('parseAskQuestions reads the questions, options, header and multiSelect', () => {
    const parsed = parseAskQuestions({
        questions: [{
            question: 'Which color?', header: 'Color', multiSelect: true,
            options: [{ label: 'Red', description: 'The red one.' }, { label: 'Blue', description: '' }]
        }]
    });
    assert.ok(parsed);
    assert.equal(parsed!.length, 1);
    assert.equal(parsed![0]!.question, 'Which color?');
    assert.equal(parsed![0]!.header, 'Color');
    assert.equal(parsed![0]!.multiSelect, true);
    assert.deepEqual(parsed![0]!.options.map((o) => o.label), ['Red', 'Blue']);
});

test('parseAskQuestions falls back to the question text for a missing header, and defaults multiSelect to false', () => {
    const parsed = parseAskQuestions({ questions: [{ question: 'Go ahead?', options: [{ label: 'Yes', description: '' }] }] });
    assert.ok(parsed);
    assert.equal(parsed![0]!.header, 'Go ahead?', 'no header falls back to the question');
    assert.equal(parsed![0]!.multiSelect, false, 'multiSelect defaults to single-select');
});

test('parseAskQuestions drops malformed options and questions rather than throwing', () => {
    const parsed = parseAskQuestions({
        questions: [
            { question: 'Pick one', options: [{ label: 'Ok', description: '' }, { description: 'no label' }, 'nope'] },
            { header: 'no question' },
            42
        ]
    });
    assert.ok(parsed);
    assert.equal(parsed!.length, 1, 'only the well-formed question survives');
    assert.deepEqual(parsed![0]!.options.map((o) => o.label), ['Ok'], 'the label-less and non-object options are dropped');
});

test('parseAskQuestions returns null for a non-ask input, so the caller degrades', () => {
    assert.equal(parseAskQuestions({ notQuestions: [] }), null);
    assert.equal(parseAskQuestions('nope'), null);
    assert.equal(parseAskQuestions({ questions: [] }), null);
    assert.equal(parseAskQuestions({ questions: [{ question: '' }] }), null);
});

test('summariseAsk joins several questions into one label', () => {
    assert.equal(summariseAsk([
        { question: 'A?', header: 'a', multiSelect: false, options: [] },
        { question: 'B?', header: 'b', multiSelect: false, options: [] }
    ]), 'A?\nB?');
});

test('parseAskAnswers reads the selected labels keyed by question', () => {
    assert.deepEqual(parseAskAnswers({ answers: { 'Which color?': ['Red'] } }), { 'Which color?': ['Red'] });
    assert.deepEqual(parseAskAnswers({ answers: { 'Pick many': ['Red', 'Blue'] } }), { 'Pick many': ['Red', 'Blue'] });
});

test('parseAskAnswers coerces a bare string answer to a one-element array', () => {
    assert.deepEqual(parseAskAnswers({ answers: { 'Which color?': 'Red' } }), { 'Which color?': ['Red'] });
});

test('parseAskAnswers returns null when nothing was answered, so an unanswered ask has no answer', () => {
    assert.equal(parseAskAnswers({ answers: {} }), null);
    assert.equal(parseAskAnswers({ answers: { q: [] } }), null);
    assert.equal(parseAskAnswers({ questions: [] }), null, 'no answers key at all');
    assert.equal(parseAskAnswers('nope'), null);
});
