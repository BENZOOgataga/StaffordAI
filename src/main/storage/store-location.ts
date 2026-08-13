/**
 * Which base directory the store opens under.
 *
 * A normal launch opens the real per-user store, `<realBase>/Stafford/stafford.db`.
 * A smoke run must never write there. `STAFFORD_SMOKE=1` seeds a fixture hire and
 * project to prove the open-migrate-insert-read path, and if that seed lands in
 * the real store it survives into every later normal launch as a dead colleague,
 * which is what once made a working write path look broken. So a smoke run opens
 * a throwaway temp base instead: still on disk, because the on-disk round-trip is
 * the point of the proof, but nowhere near user data.
 *
 * Only the base changes. `openDatabase` appends the same `Stafford/stafford.db`
 * segments under whichever base it is handed, so the smoke run exercises the exact
 * open, migrate, insert, and read path it always did, minus the pollution.
 */

import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

export interface StoreBaseOptions {
    /** True under `STAFFORD_SMOKE=1`. */
    readonly smoke: boolean;
    /** The real per-user base, `path.dirname(platform.appDataDir(home, DATA_DIR_NAME))`. */
    readonly realBase: string;
    /** Makes the throwaway base for a smoke run. Injected so a test can observe it. */
    readonly makeThrowawayBase?: () => string;
}

/** The real base for a normal launch, a fresh throwaway base for a smoke run. */
export function resolveStoreBase(options: StoreBaseOptions): string {
    if (!options.smoke) return options.realBase;
    const make = options.makeThrowawayBase
        ?? (() => mkdtempSync(path.join(os.tmpdir(), 'stafford-smoke-')));
    return make();
}
