import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
import { NATIVE_EXTERNALS } from './src/build/native-externals.ts';

/**
 * Build layout only. The entry points it names are placeholders until Task 7,
 * which is where the app first runs.
 *
 * Two things here are decisions rather than defaults and should not be quietly
 * changed:
 *
 * `externalizeDepsPlugin` is deliberately not used for the native modules. A
 * native module loads a `.node` binary, which cannot be read from inside an
 * asar archive, so it stays external and gets an `asarUnpack` entry when
 * packaging arrives in 7b. Bundling one produces a build that works in
 * development and fails only once packaged.
 *
 * The list is `NATIVE_EXTERNALS`, in `src/build/native-externals.ts` so a test
 * can read it without executing this config, and guarded by
 * `native-externals.test.ts` so every entry is a declared, installed
 * dependency. It carries `node-pty` only. `better-sqlite3` is NOT here: it
 * arrives with storage in Task 8, and naming a module that is not installed is
 * the drift this project keeps paying for.
 *
 * The renderer gets no Node integration and no filesystem access. Everything
 * privileged happens in main behind validated IPC handlers, per section 6 of
 * `docs/plans/stack-migration.technical.md`.
 */
export default defineConfig({
    main: {
        build: {
            outDir: 'out/main',
            lib: { entry: resolve(__dirname, 'src/main/index.ts') },
            rollupOptions: {
                external: ['electron', ...NATIVE_EXTERNALS]
            }
        }
    },
    preload: {
        build: {
            outDir: 'out/preload',
            // A sandboxed preload (webPreferences.sandbox true, per section 6)
            // runs as CommonJS: the sandbox loader has no ESM import. The root
            // is `type: module`, so a plain `.js` would be ESM and fail with
            // "Cannot use import statement outside a module". Emit `.cjs`.
            lib: { entry: resolve(__dirname, 'src/preload/index.ts'), formats: ['cjs'] },
            rollupOptions: {
                external: ['electron'],
                output: { entryFileNames: 'index.cjs' }
            }
        }
    },
    renderer: {
        root: resolve(__dirname, 'src/renderer'),
        build: {
            outDir: 'out/renderer',
            rollupOptions: {
                input: resolve(__dirname, 'src/renderer/index.html')
            }
        }
    }
});
