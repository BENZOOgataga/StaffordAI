/**
 * The message sanitiser: a person's text is kept, control bytes are not, so a
 * stray Ctrl-C or escape sequence never reaches a live agent's stdin. Control
 * bytes come from String.fromCharCode so the source is unambiguous ascii.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitiseMessage } from './message-input.ts';

const ch = (code: number): string => String.fromCharCode(code);
const ESC = ch(0x1b);
const CTRL_C = ch(0x03);

test('plain text passes through unchanged', () => {
    assert.equal(sanitiseMessage('refactor the parser please'), 'refactor the parser please');
});

test('a Ctrl-C is stripped, so it cannot interrupt the session', () => {
    assert.equal(sanitiseMessage('hello' + CTRL_C + 'world'), 'helloworld');
    assert.equal(sanitiseMessage(CTRL_C), '', 'a lone Ctrl-C neutralises to nothing');
});

test('a bare escape and an escape sequence are stripped', () => {
    assert.equal(sanitiseMessage('a' + ESC + 'b'), 'ab', 'bare ESC gone');
    // A colour sequence: ESC [ 3 1 m red ESC [ 0 m. Only the printable tail
    // survives, so the sequence cannot execute in the agent's terminal.
    assert.equal(sanitiseMessage('x' + ESC + '[31mred' + ESC + '[0m'), 'x[31mred[0m');
});

test('other C0 controls and DEL are stripped, the intended newline is kept', () => {
    const noisy = 'a' + ch(0x00) + ch(0x07) + ch(0x08) + ch(0x09) + 'b' + ch(0x7f);
    assert.equal(sanitiseMessage(noisy), 'ab', 'NUL BEL BS TAB DEL gone');
    assert.equal(sanitiseMessage('line one\nline two'), 'line one\nline two', 'a newline is content');
});

test('CRLF and CR normalise to newline, so a paste is content not an early submit', () => {
    assert.equal(sanitiseMessage('one\r\ntwo\rthree'), 'one\ntwo\nthree');
});

test('a multi-line message keeps its lines', () => {
    assert.equal(sanitiseMessage('first\nsecond\nthird'), 'first\nsecond\nthird');
});

test('non-ascii text is kept', () => {
    assert.equal(sanitiseMessage('reecris la fonction'), 'reecris la fonction');
    assert.equal(sanitiseMessage('éèê ok'), 'éèê ok', 'accented letters survive');
});
