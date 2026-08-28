/**
 * The turn-error log line must distinguish causes. The whole point of the instrumentation is that the
 * next time the [turn] transient happens, the line names which cause it was, so these assert that a
 * busy error, an IO error, a write against a closed store, and a non-database error each produce a
 * line a reader can tell apart.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTurnErrorLine } from './turn-error-log.ts';

/** A stand-in for a better-sqlite3 SqliteError, which carries a code and the name SqliteError. */
function sqliteError(code: string, message: string): Error & { code: string } {
    const e = new Error(message) as Error & { code: string };
    e.name = 'SqliteError';
    e.code = code;
    return e;
}

test('a busy error names SQLITE_BUSY and the open store', () => {
    const line = formatTurnErrorLine('record-reply', 'placeholder-hire', sqliteError('SQLITE_BUSY', 'database is locked'), 'open');
    assert.match(line, /code=SQLITE_BUSY/);
    assert.match(line, /name=SqliteError/);
    assert.match(line, /db=open/);
    assert.match(line, /record-reply failed for placeholder-hire/);
});

test('an IO error is told apart from a busy error', () => {
    const busy = formatTurnErrorLine('record-reply', 'placeholder-hire', sqliteError('SQLITE_BUSY', 'database is locked'), 'open');
    const io = formatTurnErrorLine('record-reply', 'placeholder-hire', sqliteError('SQLITE_IOERR', 'disk I/O error'), 'open');
    assert.match(io, /code=SQLITE_IOERR/);
    assert.notEqual(busy, io, 'the two causes produce different lines, which is the whole point');
});

test('a write against a closed store shows db=closed, distinct from an open-store failure', () => {
    const closed = formatTurnErrorLine('record-reply', 'placeholder-hire', sqliteError('SQLITE_MISUSE', 'The database connection is not open'), 'closed');
    assert.match(closed, /db=closed/);
    assert.doesNotMatch(closed, /db=open/);
});

test('a non-database error carries code=none, which is what separates it from a SqliteError', () => {
    const line = formatTurnErrorLine('snapshot', 'placeholder-hire', new TypeError('cannot read property x of undefined'), 'open');
    assert.match(line, /code=none/, 'no sqlite code, so a reader knows it was not a database contention');
    assert.match(line, /name=TypeError/, 'the error type is still carried, it just is not a sqlite code');
});

test('a non-Error throw is stringified rather than crashing the logger', () => {
    const line = formatTurnErrorLine('record-reply', 'placeholder-hire', 'a bare string', 'no-store');
    assert.match(line, /code=none/);
    assert.match(line, /db=no-store/);
    assert.match(line, /a bare string/);
});
