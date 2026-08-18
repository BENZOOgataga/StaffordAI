/**
 * openDatabase end to end against a real file in a temp directory: it creates
 * the directory, opens in WAL, runs migration 0001, and the append-only tables
 * refuse edits. A temp directory rather than the real appDataDir so the test
 * touches nothing a running app would.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase, DATA_DIR_NAME, DATABASE_FILENAME } from './database.ts';

function withDb(fn: (open: ReturnType<typeof openDatabase>) => void): void {
    const appDataDir = mkdtempSync(path.join(tmpdir(), 'stafford-db-'));
    const open = openDatabase({ appDataDir });
    try {
        fn(open);
    } finally {
        open.db.close();
        rmSync(appDataDir, { recursive: true, force: true });
    }
}

test('creates the Stafford directory and the database file under the app data dir', () => {
    const appDataDir = mkdtempSync(path.join(tmpdir(), 'stafford-db-'));
    const open = openDatabase({ appDataDir });
    try {
        assert.equal(open.path, path.join(appDataDir, DATA_DIR_NAME, DATABASE_FILENAME));
        assert.ok(existsSync(open.path), 'the database file exists on disk');
    } finally {
        open.db.close();
        rmSync(appDataDir, { recursive: true, force: true });
    }
});

test('an overridden dirName puts the store in its own folder, beside the default not in it', () => {
    // A verification run under a distinct app id passes its id as dirName, so its
    // store sits next to the real Stafford folder rather than sharing it. The default
    // is unchanged: with no dirName, the folder is still DATA_DIR_NAME.
    const appDataDir = mkdtempSync(path.join(tmpdir(), 'stafford-db-'));
    const isolated = openDatabase({ appDataDir, dirName: 'StaffordVerify' });
    try {
        assert.equal(isolated.path, path.join(appDataDir, 'StaffordVerify', DATABASE_FILENAME));
        assert.notEqual(isolated.path, path.join(appDataDir, DATA_DIR_NAME, DATABASE_FILENAME),
            'the isolated store is not the default store');
        assert.ok(existsSync(isolated.path));
    } finally {
        isolated.db.close();
        rmSync(appDataDir, { recursive: true, force: true });
    }
});

test('WAL is active after open, confirmed rather than assumed', () => {
    withDb(({ db }) => {
        const mode = db.pragma('journal_mode', { simple: true });
        assert.equal(mode, 'wal');
    });
});

test('the migrations run and bring the database to the current version with every table', () => {
    withDb(({ db, migration }) => {
        assert.deepEqual(migration, { from: 0, to: 3, applied: [1, 2, 3] });
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
            .map((r) => r.name);
        for (const t of ['activity_events', 'channel_messages', 'drain_report', 'hires', 'policy_log', 'projects', 'tasks']) {
            assert.ok(tables.includes(t), 'missing table: ' + t);
        }
    });
});

test('opening an already-migrated database applies nothing', () => {
    const appDataDir = mkdtempSync(path.join(tmpdir(), 'stafford-db-'));
    try {
        const first = openDatabase({ appDataDir });
        first.db.close();
        const second = openDatabase({ appDataDir });
        assert.deepEqual(second.migration, { from: 3, to: 3, applied: [] });
        second.db.close();
    } finally {
        rmSync(appDataDir, { recursive: true, force: true });
    }
});

// Unrolled rather than looped: the reconciliation counter counts test
// declarations at column zero, so a `test(` generated inside a loop runs without
// being declared and the run goes red. One assertion helper, three flat tests.
function assertAppendOnly(table: string, insert: string): void {
    withDb(({ db }) => {
        db.exec(insert);
        assert.throws(() => db.exec('UPDATE ' + table + " SET at='changed'"), /append-only/);
        assert.throws(() => db.exec('DELETE FROM ' + table), /append-only/);
        const count = (db.prepare('SELECT count(*) AS n FROM ' + table).get() as { n: number }).n;
        assert.equal(count, 1, 'the row survives the refused edits');
    });
}

test('policy_log is append-only: update and delete both raise', () => {
    assertAppendOnly('policy_log', "INSERT INTO policy_log (at, actor, project_id, before, after) VALUES ('t','Benzoo','p','{}','{}')");
});

test('channel_messages is append-only: update and delete both raise', () => {
    assertAppendOnly('channel_messages', "INSERT INTO channel_messages (id, project_id, sender_id, kind, body, at) VALUES ('m','p','s','message','hi','t')");
});

test('drain_report is append-only: update and delete both raise', () => {
    assertAppendOnly('drain_report', "INSERT INTO drain_report (drain_id, agent_id, outcome, committed, at) VALUES ('d','a','committed',1,'t')");
});

test('activity_events is append-only: update and delete both raise', () => {
    assertAppendOnly('activity_events', "INSERT INTO activity_events (id, hire_id, tool, status, at) VALUES ('a','h','Edit','ok','t')");
});

test('the activity_events status CHECK rejects a value outside the ActivityStatus set', () => {
    withDb(({ db }) => {
        assert.throws(
            () => db.exec("INSERT INTO activity_events (id, hire_id, tool, status, at) VALUES ('a','h','Edit','maybe','t')"),
            /CHECK/
        );
    });
});

test('a mutable table (projects) still accepts update and delete', () => {
    withDb(({ db }) => {
        db.exec("INSERT INTO projects (id, name, repos, policy) VALUES ('p','name','[]','{}')");
        assert.doesNotThrow(() => db.exec("UPDATE projects SET name='renamed'"));
        assert.doesNotThrow(() => db.exec('DELETE FROM projects'));
    });
});

test('the drain_report outcome CHECK rejects a value outside the DrainOutcome set', () => {
    withDb(({ db }) => {
        assert.throws(
            () => db.exec("INSERT INTO drain_report (drain_id, agent_id, outcome, committed, at) VALUES ('d','a','exploded',1,'t')"),
            /CHECK/
        );
    });
});
