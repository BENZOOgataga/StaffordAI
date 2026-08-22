/**
 * Which declared new files may be committed.
 *
 * This is the file where "the colleague names its deliverable" either is or is not a way for
 * a colleague to get an arbitrary file onto a branch I push. So the refusals are tested
 * harder than the acceptances, and the traversal cases are enumerated rather than sampled.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    validateDeclaredOutputs, acceptedOutputs, refusedNote, looksLikeSecret
} from './declared-outputs.ts';
import { SECRET_FILE_GLOBS } from './permission-profile.ts';

function accepted(declared: string[], rules = {}): string[] {
    return acceptedOutputs(validateDeclaredOutputs(declared, rules));
}

test('an ordinary new file in the repository is accepted', () => {
    assert.deepEqual(accepted(['note.txt', 'src/thing.ts', 'docs/a/b/c.md']),
        ['note.txt', 'src/thing.ts', 'docs/a/b/c.md']);
});

test('NOTHING ESCAPES THE REPOSITORY, by any spelling', () => {
    const escapes = [
        '../outside.txt',
        '../../etc/passwd',
        'src/../../outside.txt',
        './../x',
        'a/b/../../../c',
        '/etc/passwd',
        '/Users/benzoo/.ssh/id_rsa',
        'C:/Windows/system32/x',
        'c:\\Windows\\x',
        '..\\outside.txt',
        'src\\..\\..\\outside'
    ];
    for (const value of escapes) {
        assert.deepEqual(accepted([value]), [],
            'a declared output escaped the repository as ' + JSON.stringify(value));
    }
});

test('every secret pattern the gate denies is also refused as a deliverable', () => {
    // The same list, so the two cannot drift into disagreeing about what a secret is.
    const samples: Record<string, string> = {
        '.env': '.env', '.env.*': '.env.production', '*.pem': 'server.pem', '*.key': 'private.key',
        '*.p12': 'cert.p12', '*.pfx': 'cert.pfx', 'id_rsa': 'id_rsa', 'id_ed25519': 'id_ed25519',
        '.npmrc': '.npmrc', '.netrc': '.netrc', 'credentials.json': 'credentials.json',
        '.credentials.json': '.credentials.json'
    };
    for (const glob of SECRET_FILE_GLOBS) {
        const sample = samples[glob];
        assert.ok(sample, 'no sample for the secret glob ' + glob + ', so it is untested');
        assert.deepEqual(accepted([sample]), [], sample + ' was accepted as a deliverable');
        assert.deepEqual(accepted(['deep/nested/' + sample]), [],
            sample + ' was accepted when buried in a subdirectory');
    }
});

test('a secret name is refused whatever its case, since the filesystem does not care', () => {
    for (const value of ['.ENV', 'Server.PEM', 'ID_RSA', '.NpmRc']) {
        assert.deepEqual(accepted([value]), [], value + ' was accepted');
    }
});

test('a file that merely mentions a secret word is not a secret', () => {
    assert.deepEqual(accepted(['env.ts', 'keyboard.md', 'src/keys.ts', 'environment.json']),
        ['env.ts', 'keyboard.md', 'src/keys.ts', 'environment.json']);
});

test('nothing inside .git is a deliverable', () => {
    for (const value of ['.git/config', '.git/hooks/pre-commit', '.git']) {
        assert.deepEqual(accepted([value]), [], value + ' was accepted');
    }
});

test('an ignored path is refused, since ignoring it is a standing statement it does not belong', () => {
    const rules = { isIgnored: (p: string) => p.startsWith('node_modules/') || p === 'build/out.js' };
    assert.deepEqual(accepted(['node_modules/x/index.js', 'build/out.js', 'src/ok.ts'], rules), ['src/ok.ts']);
});

test('a tracked file needs no declaring, because its changes are already committed', () => {
    const rules = { isTracked: (p: string) => p === 'README.md' };
    assert.deepEqual(accepted(['README.md', 'new.txt'], rules), ['new.txt']);
});

test('duplicates collapse, including ones that only differ in spelling', () => {
    assert.deepEqual(accepted(['a.txt', './a.txt', 'a.txt', 'b/../a.txt']), ['a.txt'],
        'b/../a.txt has a .. and is refused, and the other spellings are one path');
});

test('an empty or absurd path is refused rather than interpreted', () => {
    assert.deepEqual(accepted(['', '   ', '.', './', 'x'.repeat(513)]), []);
});

test('a refusal explains itself, so the review says what was left out and why', () => {
    const verdicts = validateDeclaredOutputs(['.env', '../out', 'good.txt']);
    const note = refusedNote(verdicts) ?? '';
    assert.match(note, /\.env \(the name matches a secret file pattern/);
    assert.match(note, /\.\.\/out \(the path leaves the repository/);
    assert.equal(note.includes('good.txt'), false, 'an accepted file is not in the refused note');
    assert.deepEqual(acceptedOutputs(verdicts), ['good.txt'],
        'one bad declaration must not throw away the good ones');
});

test('nothing refused means no note, so a clean task shows no warning', () => {
    assert.equal(refusedNote(validateDeclaredOutputs(['a.txt'])), null);
});

test('looksLikeSecret matches on the leaf, not on a directory that happens to be named so', () => {
    assert.equal(looksLikeSecret('.env'), true);
    assert.equal(looksLikeSecret('config/.env'), true);
    assert.equal(looksLikeSecret('.env/readme.md'), false, 'the leaf is readme.md, which is not a secret');
});
