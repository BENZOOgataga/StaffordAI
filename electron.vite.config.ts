import { defineConfig } from 'electron-vite';
import { resolve, join } from 'node:path';
import { mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { NATIVE_EXTERNALS } from './src/build/native-externals.ts';

/**
 * Copies the migration `.sql` files next to the built main bundle.
 *
 * `openDatabase` reads `./migrations/*.sql` relative to its own module. After
 * bundling that module is folded into `out/main/index.js`, so at runtime
 * `import.meta.url` is that bundle and `./migrations/` resolves to
 * `out/main/migrations/`. The SQL is not JavaScript, so rollup does not carry it
 * there on its own. This lands it at exactly that path, in dev and packaged
 * both, so the path the guard checks and the path the app reads are the same
 * one. `packaged-bundle` asserts it survived into the asar.
 */
function copyMigrations() {
    return {
        name: 'stafford-copy-migrations',
        writeBundle(): void {
            const from = resolve(__dirname, 'src/main/storage/migrations');
            const to = resolve(__dirname, 'out/main/migrations');
            mkdirSync(to, { recursive: true });
            for (const entry of readdirSync(from)) {
                if (entry.endsWith('.sql')) copyFileSync(join(from, entry), join(to, entry));
            }
        }
    };
}

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
 * dependency. It carries `better-sqlite3`, the storage module: naming a module
 * that is not installed is the drift this project keeps paying for.
 *
 * The renderer gets no Node integration and no filesystem access. Everything
 * privileged happens in main behind validated IPC handlers, per section 6 of
 * `docs/plans/stack-migration.technical.md`.
 */
export default defineConfig({
    main: {
        plugins: [copyMigrations()],
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
        // React and Tailwind serve the new design-system foundation, which lives only
        // in the dev-only preview entry. The shipped index.html is vanilla and imports
        // none of it, so the react plugin transforms only the preview's .tsx and the
        // tailwind plugin only processes the CSS the preview imports. index.html's
        // output is unchanged.
        plugins: [react(), tailwindcss()],
        resolve: {
            // The shadcn convention: `@/` points at the renderer root.
            alias: { '@': resolve(__dirname, 'src/renderer') }
        },
        build: {
            outDir: 'out/renderer',
            rollupOptions: {
                // Two entries. index.html is the shipped vanilla app. preview.html is a
                // dev-only page that renders the shadcn primitives; nothing in the normal
                // app flow navigates to it.
                input: {
                    index: resolve(__dirname, 'src/renderer/index.html'),
                    preview: resolve(__dirname, 'src/renderer/preview.html')
                }
            }
        }
    }
});
