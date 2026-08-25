import test from 'node:test';
import assert from 'node:assert/strict';
import { highlightLine, langForPath, langForName } from './highlight.ts';

test('langForPath maps code and json extensions, and null for the rest', () => {
    assert.equal(langForPath('src/parse.ts'), 'ts');
    assert.equal(langForPath('a/b/Widget.tsx'), 'ts');
    assert.equal(langForPath('script.js'), 'ts');
    assert.equal(langForPath('config.json'), 'json');
    assert.equal(langForPath('README.md'), null);
    assert.equal(langForPath('logo.png'), null);
});

test('langForName maps a code fence info string to a highlighter language, null for the uncovered', () => {
    for (const n of ['ts', 'tsx', 'typescript', 'js', 'jsx', 'javascript', 'TS', ' ts ']) {
        assert.equal(langForName(n), 'ts', n + ' highlights as the ts family');
    }
    assert.equal(langForName('json'), 'json');
    assert.equal(langForName('jsonc'), 'json');
    // A language this highlighter does not cover renders as plain monospace, not wrongly coloured.
    assert.equal(langForName('python'), null);
    assert.equal(langForName('bash'), null);
    assert.equal(langForName(''), null);
});

test('a plain language renders the whole line as one span', () => {
    assert.deepEqual(highlightLine('# a heading', null), [{ text: '# a heading', cls: '' }]);
});

test('a ts line splits into keyword, identifier, string and number spans', () => {
    const tokens = highlightLine('const n = 3;', 'ts');
    const byText = Object.fromEntries(tokens.map((t) => [t.text, t.cls]));
    assert.equal(byText['const'], 'keyword');
    assert.equal(byText['3'], 'number');
    // The string case, with the reassembled text preserved exactly.
    const s = highlightLine('const x = "hi";', 'ts');
    assert.ok(s.some((t) => t.text === '"hi"' && t.cls === 'string'), 'the quoted string is one string span');
    assert.equal(s.map((t) => t.text).join(''), 'const x = "hi";', 'the spans reassemble the exact line');
});

test('a line comment is one comment span', () => {
    const tokens = highlightLine('  return a; // done', 'ts');
    assert.ok(tokens.some((t) => t.text === '// done' && t.cls === 'comment'));
});

test('the spans always reassemble to the original text, byte for byte', () => {
    for (const line of ['export const AT = `2026`;', 'if (a && b) { doThing(); }', '', '   ', '}']) {
        assert.equal(highlightLine(line, 'ts').map((t) => t.text).join(''), line);
    }
});
