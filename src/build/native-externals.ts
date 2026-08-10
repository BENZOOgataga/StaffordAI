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
 * One entry today. `better-sqlite3` is deliberately absent: it arrives with
 * storage in Task 8, and naming a module that is not installed is the drift
 * this project keeps paying for. `native-externals.test.ts` fails if this list
 * and the installed dependencies diverge in either direction, so Task 8 has to
 * add the dependency and this entry as a pair.
 */

export const NATIVE_EXTERNALS = ['node-pty'] as const;
