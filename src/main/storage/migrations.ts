/**
 * Forward-only numbered migrations, applied on startup.
 *
 * The version is tracked in SQLite's `user_version` pragma rather than a
 * `migrations` table. `user_version` lives in the database header and its write
 * participates in the enclosing transaction, so advancing the version and
 * applying the schema commit or roll back together with nothing to bootstrap.
 * A `migrations` table would only earn its place if a per-migration applied-at
 * history were needed, and nothing here needs one: this is a single-writer local
 * store and the version alone answers "which migrations have run".
 *
 * Two failure modes are made impossible rather than merely unlikely:
 *
 *   - **A half-applied migration.** Each migration runs inside one transaction
 *     that also advances the version. better-sqlite3 rolls the transaction back
 *     if the SQL throws, so a failed migration leaves the database exactly at the
 *     prior version with none of its statements applied, and the error is
 *     re-thrown rather than swallowed.
 *   - **Running against a newer schema.** If the database's version is ahead of
 *     the highest migration the code carries, the runner refuses to open. A
 *     build opening a database a later build wrote would otherwise run queries
 *     against columns it does not know about, silently.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface Migration {
    /** The number parsed from the filename, e.g. 1 from `0001_init.sql`. */
    readonly version: number;
    readonly name: string;
    readonly sql: string;
}

/**
 * The minimum of better-sqlite3 this runner uses, declared as an interface so
 * tests can drive it with a real in-memory database and nothing is mocked.
 */
export interface MigratableDb {
    pragma(source: string, options?: { simple?: boolean }): unknown;
    exec(sql: string): unknown;
    transaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void;
}

const FILENAME = /^(\d+)_([A-Za-z0-9-]+)\.sql$/;

/**
 * Loads migrations from a directory, ordered by version, and rejects a
 * malformed set rather than silently skipping a file.
 *
 * A gap or a duplicate version is an error: numbering is how the order is known,
 * so `0001` then `0003` with no `0002` is a missing file rather than an intent to
 * skip, and two files claiming the same number is ambiguous.
 */
export function loadMigrations(dir: string): Migration[] {
    const migrations: Migration[] = [];
    for (const entry of readdirSync(dir)) {
        if (!entry.endsWith('.sql')) continue;
        const match = FILENAME.exec(entry);
        if (!match) {
            throw new Error('migration filename does not match <number>_<name>.sql: ' + entry);
        }
        migrations.push({
            version: Number(match[1]),
            name: match[2] as string,
            sql: readFileSync(path.join(dir, entry), 'utf8')
        });
    }

    migrations.sort((a, b) => a.version - b.version);

    for (let i = 0; i < migrations.length; i += 1) {
        const expected = i + 1;
        if ((migrations[i] as Migration).version !== expected) {
            throw new Error(
                'migrations must be numbered 1, 2, 3 with no gaps or duplicates; expected ' +
                expected + ' but found ' + (migrations[i] as Migration).version
            );
        }
    }

    return migrations;
}

function currentVersion(db: MigratableDb): number {
    return db.pragma('user_version', { simple: true }) as number;
}

export interface MigrationResult {
    readonly from: number;
    readonly to: number;
    readonly applied: readonly number[];
}

/**
 * Applies every migration newer than the database's current version, in order,
 * each in its own transaction. Returns what moved so a caller can log it.
 *
 * The migrations are validated as a contiguous set before anything runs, so a
 * malformed set fails before touching the database.
 */
export function runMigrations(db: MigratableDb, migrations: readonly Migration[]): MigrationResult {
    const ordered = [...migrations].sort((a, b) => a.version - b.version);
    const highest = ordered.length === 0 ? 0 : (ordered[ordered.length - 1] as Migration).version;
    const from = currentVersion(db);

    // The downgrade guard. A database ahead of the code is refused, not run
    // against.
    if (from > highest) {
        throw new Error(
            'database schema version ' + from + ' is newer than this build knows (' + highest +
            '). A later version wrote this database; refusing to open rather than run against a ' +
            'schema this code does not understand.'
        );
    }

    const applied: number[] = [];
    for (const migration of ordered) {
        if (migration.version <= from) continue;

        // One transaction per migration: the schema change and the version bump
        // commit together or not at all. A throw inside rolls both back and
        // propagates, leaving the database at the prior version.
        const apply = db.transaction(() => {
            db.exec(migration.sql);
            // user_version takes an integer literal, not a bound parameter, and
            // the value is our own parsed filename number, never external input.
            db.exec('PRAGMA user_version = ' + migration.version);
        });
        apply();
        applied.push(migration.version);
    }

    return { from, to: currentVersion(db), applied };
}
