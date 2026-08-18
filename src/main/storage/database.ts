/**
 * Opens the Stafford database, one per machine, and brings it to the current
 * schema before handing it back.
 *
 * The file lives under `<appDataDir>/Stafford/stafford.db`. **The `Stafford`
 * segment is the runtime `APP_ID`, deliberately not the reverse-DNS packaging
 * appId `net.benzoogataga.stafford`.** The two are meant to differ: the
 * reverse-DNS form is the OS bundle identity electron-builder needs, and the
 * data directory is a human-readable path a person can find and inspect. Do not
 * "align" them; changing this segment orphans an existing database at the old
 * path.
 *
 * Storage is the first consumer of `platform.appDataDir`, so this is what
 * creates the directory. Nothing did before.
 *
 * WAL mode, and it is verified rather than assumed. `PRAGMA journal_mode = WAL`
 * can silently stay in the old mode (for example on a filesystem that does not
 * support it), so the returned value is checked and a failure to switch is an
 * error, not a warning: without WAL the concurrent-reader story the design rests
 * on is not there.
 *
 * better-sqlite3 is synchronous and this runs in the Electron main process, so
 * every query blocks the event loop. That is the accepted trade for a local,
 * single-writer store doing small writes: a state transition or a per-hook row
 * is microseconds. The rule that keeps it acceptable is that no unbounded query
 * runs here. Channel history can grow without limit and is a piece-2 concern; it
 * is not read in this module.
 *
 * better-sqlite3 is loaded through `createRequire` rather than an ESM import,
 * the same pattern the pty layer uses for node-pty: it is a native CommonJS
 * module, and `verbatimModuleSyntax` plus no `esModuleInterop` makes a default
 * import of it awkward, while `require` is exact and needs no `@types` package.
 */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMigrations, runMigrations, type MigratableDb, type MigrationResult } from './migrations.ts';

const require = createRequire(import.meta.url);

/** A prepared statement, the subset the storage layer uses. */
export interface Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
}

/** The better-sqlite3 surface storage depends on, typed locally. */
export interface StorageDatabase extends MigratableDb {
    prepare(sql: string): Statement;
    close(): void;
}

interface DatabaseConstructor {
    new (filename: string): StorageDatabase;
}

const Database = require('better-sqlite3') as DatabaseConstructor;

/** The data-directory segment. See the note above: intentionally not the appId. */
export const DATA_DIR_NAME = 'Stafford';
export const DATABASE_FILENAME = 'stafford.db';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export interface OpenResult {
    readonly db: StorageDatabase;
    readonly path: string;
    readonly migration: MigrationResult;
}

export interface OpenOptions {
    /**
     * The directory the `Stafford` folder is created under, from
     * `platform.appDataDir(home, appId)`. Injected rather than computed here so
     * the platform layer stays the one place that knows per-OS paths.
     */
    readonly appDataDir: string;
    /**
     * The folder created under `appDataDir`, defaulting to the `Stafford` runtime
     * id. An isolated run (a verification build under a distinct app id) passes its
     * own id here so its store sits beside the real one rather than in it.
     */
    readonly dirName?: string;
    /** Overrides the migrations directory, for tests. */
    readonly migrationsDir?: string;
}

/**
 * Opens (creating if absent) the database, enables and verifies WAL, and runs
 * every pending migration before returning the connection.
 */
export function openDatabase(options: OpenOptions): OpenResult {
    const dir = path.join(options.appDataDir, options.dirName ?? DATA_DIR_NAME);
    mkdirSync(dir, { recursive: true });

    const file = path.join(dir, DATABASE_FILENAME);
    const db = new Database(file);

    const mode = db.pragma('journal_mode = WAL', { simple: true });
    if (mode !== 'wal') {
        db.close();
        throw new Error(
            'could not enable WAL on ' + file + '; PRAGMA journal_mode returned ' +
            JSON.stringify(mode) + '. The concurrent-reader guarantee is not available, so this ' +
            'refuses to run rather than proceed in a mode the design did not choose.'
        );
    }
    db.pragma('foreign_keys = ON');

    const migration = runMigrations(db, loadMigrations(options.migrationsDir ?? MIGRATIONS_DIR));

    return { db, path: file, migration };
}
