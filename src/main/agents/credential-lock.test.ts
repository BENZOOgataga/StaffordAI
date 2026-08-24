import test from 'node:test';
import assert from 'node:assert/strict';
import { copyCredentialOwnerLocked, CredentialLockError, type CredentialLockIo } from './credential-lock.ts';

/** A recording io whose lock result the test controls. */
function makeIo(lockResult: boolean): { io: CredentialLockIo; log: string[]; exists: () => boolean } {
    const log: string[] = [];
    let present = false;
    const io: CredentialLockIo = {
        copy: (from, to) => { present = true; log.push('copy ' + from + ' -> ' + to); },
        chmod: (to, mode) => { log.push('chmod ' + to + ' ' + mode.toString(8)); },
        lock: (to) => { log.push('lock ' + to); return lockResult; },
        remove: (to) => { present = false; log.push('remove ' + to); }
    };
    return { io, log, exists: () => present };
}

test('lock succeeds: file stays, no remove, no throw', () => {
    const { io, log, exists } = makeIo(true);
    copyCredentialOwnerLocked(io, '/src/.credentials.json', '/managed/.credentials.json', 0o600);
    assert.equal(exists(), true, 'the credential is left in place when the lock succeeds');
    assert.deepEqual(log, [
        'copy /src/.credentials.json -> /managed/.credentials.json',
        'chmod /managed/.credentials.json 600',
        'lock /managed/.credentials.json'
    ]);
    assert.ok(!log.some((l) => l.startsWith('remove')), 'nothing is removed on success');
});

test('lock fails: file is deleted and the copy throws (fail closed)', () => {
    const { io, log, exists } = makeIo(false);
    assert.throws(
        () => copyCredentialOwnerLocked(io, '/src/.credentials.json', '/managed/.credentials.json', 0o600),
        CredentialLockError,
        'a failed lock aborts the copy'
    );
    assert.equal(exists(), false, 'no unprotected credential is left on disk when the lock fails');
    assert.deepEqual(log, [
        'copy /src/.credentials.json -> /managed/.credentials.json',
        'chmod /managed/.credentials.json 600',
        'lock /managed/.credentials.json',
        'remove /managed/.credentials.json'
    ]);
});

test('a chmod that throws does not stop the lock from being enforced', () => {
    const log: string[] = [];
    let present = false;
    const io: CredentialLockIo = {
        copy: (_f, _t) => { present = true; log.push('copy'); },
        chmod: () => { throw new Error('windows ignores mode'); },
        lock: () => { log.push('lock'); return false; },
        remove: () => { present = false; log.push('remove'); }
    };
    assert.throws(() => copyCredentialOwnerLocked(io, '/a', '/b', 0o600), CredentialLockError);
    assert.equal(present, false, 'the file is still removed even though chmod threw');
    assert.deepEqual(log, ['copy', 'lock', 'remove']);
});
