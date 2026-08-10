/**
 * The migration runner, tested against a real in-memory better-sqlite3 rather
 * than a mock, because the whole point is the transactional behaviour of the
 * database and a mock would be asserting against my own assumptions about it.
 *
 * The failing migration is a fixture defined here, not a file in the real
 * migrations directory, so a test of the failure path cannot corrupt the real
 * schema and the real directory stays a clean record of what actually ships.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runMigrations, loadMigrations, type Migration, type MigratableDb } from './migrations.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as new (filename: string) => MigratableDb & {
    prepare(sql: string): { get(...a: unknown[]): unknown };
    close(): void;
};

function freshDb(): MigratableDb & { prepare(sql: string): { get(...a: unknown[]): unknown }; close(): void } {
    return new Database(':memory:');
}

function version(db: MigratableDb): number {
    return db.pragma('user_version', { simple: true }) as number;
}

function tableExists(db: { prepare(sql: string): { get(...a: unknown[]): unknown } }, name: string): boolean {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    return row !== undefined;
}

const GOOD_1: Migration = { version: 1, name: 'one', sql: 'CREATE TABLE a (x INTEGER);' };
const GOOD_2: Migration = { version: 2, name: 'two', sql: 'CREATE TABLE b (y INTEGER);' };
const BAD_2: Migration = { version: 2, name: 'bad', sql: 'CREATE TABLE b (y INTEGER); THIS IS NOT SQL;' };

test('applies migrations in order on a fresh database and advances the version', () => {
    const db = freshDb();
    const result = runMigrations(db, [GOOD_1, GOOD_2]);
    assert.deepEqual(result, { from: 0, to: 2, applied: [1, 2] });
    assert.equal(version(db), 2);
    assert.ok(tableExists(db, 'a') && tableExists(db, 'b'));
    db.close();
});

test('re-running against an already-migrated database is a no-op', () => {
    const db = freshDb();
    runMigrations(db, [GOOD_1, GOOD_2]);
    const again = runMigrations(db, [GOOD_1, GOOD_2]);
    assert.deepEqual(again, { from: 2, to: 2, applied: [] });
    assert.equal(version(db), 2);
    db.close();
});

test('a migration that throws leaves the database at the prior version, nothing half-applied', () => {
    const db = freshDb();
    // 1 commits, 2 throws. The prior version for 2 is 1, so the database must
    // end at 1 with table a present and nothing from the failed migration.
    assert.throws(() => runMigrations(db, [GOOD_1, BAD_2]));
    assert.equal(version(db), 1);
    assert.ok(tableExists(db, 'a'), 'the migration that committed stays');
    assert.equal(tableExists(db, 'b'), false, 'the failed migration is fully rolled back');
    db.close();
});

test('a first migration that throws leaves an empty database at version 0', () => {
    const db = freshDb();
    const BAD_1: Migration = { version: 1, name: 'bad', sql: 'CREATE TABLE a (x); NOT SQL;' };
    assert.throws(() => runMigrations(db, [BAD_1]));
    assert.equal(version(db), 0);
    assert.equal(tableExists(db, 'a'), false);
    db.close();
});

test('refuses a database whose version is ahead of the code', () => {
    const db = freshDb();
    db.exec('PRAGMA user_version = 5');
    assert.throws(
        () => runMigrations(db, [GOOD_1]),
        /newer than this build knows/
    );
    // Refused without applying anything.
    assert.equal(version(db), 5);
    db.close();
});

test('loadMigrations rejects a gap in the numbering', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stafford-mig-'));
    try {
        writeFileSync(path.join(dir, '0001_one.sql'), 'CREATE TABLE a (x);');
        writeFileSync(path.join(dir, '0003_three.sql'), 'CREATE TABLE c (z);');
        assert.throws(() => loadMigrations(dir), /no gaps or duplicates/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('loadMigrations rejects a filename that is not <number>_<name>.sql', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stafford-mig-'));
    try {
        writeFileSync(path.join(dir, 'init.sql'), 'CREATE TABLE a (x);');
        assert.throws(() => loadMigrations(dir), /does not match/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
