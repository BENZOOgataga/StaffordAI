import test from 'node:test';
import assert from 'node:assert/strict';
import { hitsSelfPath } from './containment.ts';

// Identity normalise is the Linux case rule; lowercasing is the darwin/win32 rule. Identity realpath
// leaves paths alone; a substitution stands in for a symlink resolving to a different real path.
const idNorm = (v: string): string => v;
const lowerNorm = (v: string): string => v.toLowerCase();
const idReal = (v: string): string => v;

test('a candidate that IS a self-path is refused', () => {
    assert.equal(hitsSelfPath('/app/stafford', { selfPaths: ['/app/stafford'], normalise: idNorm, realpath: idReal }), true);
});

test('a candidate INSIDE a self-path is refused', () => {
    assert.equal(hitsSelfPath('/app/stafford/sub/dir', { selfPaths: ['/app/stafford'], normalise: idNorm, realpath: idReal }), true);
});

test('a candidate that CONTAINS a self-path is refused', () => {
    // The project folder is an ancestor of Stafford's own dir, so Stafford sits under the project.
    assert.equal(hitsSelfPath('/app', { selfPaths: ['/app/stafford'], normalise: idNorm, realpath: idReal }), true);
});

test('an unrelated folder is allowed', () => {
    assert.equal(hitsSelfPath('/home/me/project', { selfPaths: ['/app/stafford'], normalise: idNorm, realpath: idReal }), false);
});

test('a sibling that merely shares a name prefix is not a false positive', () => {
    // /app/stafford-notes is not inside /app/stafford; the slash boundary must prevent the match.
    assert.equal(hitsSelfPath('/app/stafford-notes', { selfPaths: ['/app/stafford'], normalise: idNorm, realpath: idReal }), false);
});

test('a case-variant path is caught under a case-folding platform', () => {
    // Windows and macOS fold case, so STAFFORD and stafford are one directory.
    assert.equal(
        hitsSelfPath('/App/STAFFORD/sub', { selfPaths: ['/app/stafford'], normalise: lowerNorm, realpath: idReal }),
        true,
        'the case fold makes the varied path match the self-path'
    );
    // With a case-sensitive rule the same two are genuinely different directories.
    assert.equal(
        hitsSelfPath('/App/STAFFORD/sub', { selfPaths: ['/app/stafford'], normalise: idNorm, realpath: idReal }),
        false
    );
});

test('a symlinked path is caught once its real target is resolved', () => {
    // The candidate is reached through a symlink whose real path is Stafford's own dir.
    const viaLink = (v: string): string => v.split('link').join('real');
    assert.equal(
        hitsSelfPath('/link/stafford', { selfPaths: ['/real/stafford'], normalise: idNorm, realpath: viaLink }),
        true,
        'resolving the symlink makes the candidate equal the self-path'
    );
});

test('multiple self-paths: a hit on any one refuses', () => {
    const deps = { selfPaths: ['/app/install', '/home/me/.stafford', '/proc/cwd'], normalise: idNorm, realpath: idReal };
    assert.equal(hitsSelfPath('/home/me/.stafford/db', deps), true);
    assert.equal(hitsSelfPath('/home/me/other', deps), false);
});

test('an empty self-path entry is skipped, not treated as matching everything', () => {
    assert.equal(hitsSelfPath('/home/me/project', { selfPaths: [''], normalise: idNorm, realpath: idReal }), false);
});
