import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from './diff-parse.ts';

// A captured multi-file git diff: a modified file with two hunks, an added file, and a binary file.
const PATCH = [
    'diff --git a/src/parser.ts b/src/parser.ts',
    'index 1111111..2222222 100644',
    '--- a/src/parser.ts',
    '+++ b/src/parser.ts',
    '@@ -1,4 +1,5 @@ export function parse',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' return a;',
    '@@ -20,3 +21,3 @@ function tail',
    ' const x = 9;',
    '-doThing();',
    '+doOtherThing();',
    ' const y = 10;',
    'diff --git a/src/new.ts b/src/new.ts',
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1,2 @@',
    '+export const NEW = true;',
    '+export const OTHER = false;',
    'diff --git a/logo.png b/logo.png',
    'index 4444444..5555555 100644',
    'Binary files a/logo.png and b/logo.png differ',
    ''
].join('\n');

test('parses each file with its path, counts, and hunks', () => {
    const files = parseUnifiedDiff(PATCH);
    assert.equal(files.length, 3);
    assert.deepEqual(files.map((f) => f.path), ['src/parser.ts', 'src/new.ts', 'logo.png']);
});

test('a modified file keeps both hunks and counts adds and removals', () => {
    const parser = parseUnifiedDiff(PATCH)[0]!;
    assert.equal(parser.hunks.length, 2);
    assert.equal(parser.added, 3, 'two adds in hunk one, one in hunk two');
    assert.equal(parser.removed, 2, 'one removal per hunk');
    assert.equal(parser.binary, false);
    // The hunk header is kept verbatim, and the line markers are stripped from the text.
    assert.equal(parser.hunks[0]!.header, '@@ -1,4 +1,5 @@ export function parse');
    assert.deepEqual(parser.hunks[0]!.lines, [
        { kind: 'context', text: 'const a = 1;' },
        { kind: 'del', text: 'const b = 2;' },
        { kind: 'add', text: 'const b = 3;' },
        { kind: 'add', text: 'const c = 4;' },
        { kind: 'context', text: 'return a;' }
    ]);
});

test('an added file uses its b-side path and holds only additions', () => {
    const added = parseUnifiedDiff(PATCH)[1]!;
    assert.equal(added.path, 'src/new.ts');
    assert.equal(added.added, 2);
    assert.equal(added.removed, 0);
    assert.ok(added.hunks[0]!.lines.every((l) => l.kind === 'add'));
});

test('a binary file is flagged and carries no hunks', () => {
    const bin = parseUnifiedDiff(PATCH)[2]!;
    assert.equal(bin.binary, true);
    assert.equal(bin.hunks.length, 0);
});

test('the diff --git, ---, +++, index and mode headers never become diff lines', () => {
    const parser = parseUnifiedDiff(PATCH)[0]!;
    const texts = parser.hunks.flatMap((h) => h.lines.map((l) => l.text));
    assert.ok(!texts.some((t) => t.startsWith('++ ') || t.startsWith('-- ') || t.includes('/dev/null')));
});

test('an empty patch yields no files', () => {
    assert.deepEqual(parseUnifiedDiff(''), []);
});
