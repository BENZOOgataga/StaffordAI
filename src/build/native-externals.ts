/**
 * Native modules that must not be bundled into the asar.
 *
 * A native module loads a `.node` binary, which cannot be read from inside an
 * asar archive, so it stays external in the vite config and gets an
 * `asarUnpack` entry when packaging arrives in 7b. Bundling one produces a
 * build that works in development and fails only once packaged.
 *
 * Its own module, rather than living in `electron.vite.config.ts`, for one
 * reason: the vite config uses `__dirname`, which throws when imported under
 * `node --test`. The guard needs to read this list without executing the
 * config, so the list lives here where nothing else runs.
 *
 * Two entries. `better-sqlite3` joined in Task 8 with the storage dependency,
 * added here the same commit it was installed, because
 * `native-externals.test.ts` fails if this list and the installed dependencies
 * diverge in either direction. It is Node-API and ships a flat-file prebuild per
 * arch, so it needs no compiler and no rebuild; like node-pty it carries a
 * `.node` binary that cannot be read from inside an asar, so it stays external
 * and gets its own `asarUnpack` entry.
 */

export const NATIVE_EXTERNALS = ['node-pty', 'better-sqlite3'] as const;
