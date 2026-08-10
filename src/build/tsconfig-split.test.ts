/**
 * The tsconfig split bites: main-process code cannot reference DOM globals.
 *
 * A `"DOM"` lib shared across main and renderer compiles fine and fails at
 * runtime, which is how it was missed in 7a. The split gives the node context
 * (main, domain, shared, build) and the sandboxed preload no DOM lib, and only
 * the renderer gets it. This proves that difference mechanically rather than
 * trusting the config: it compiles the same fixture under each lib and asserts
 * the node lib rejects `document` while the DOM lib accepts it.
 *
 * Existence-style where it can be: it does not reason about what would fail, it
 * runs the compiler and reads the result.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// The compiler's own JS entry, run through node. Not node_modules/.bin/tsc:
// that is a POSIX symlink and does not execute under execFileSync on Windows,
// which failed the whole check there while passing on macOS. Found by CI on the
// windows job, which is exactly the difference the read-both-jobs rule exists
// for. node + the .js entry is identical on every platform.
const tscEntry = root + 'node_modules/typescript/bin/tsc';
const fixture = root + 'src/build/dom-global.fixture.ts';

/** Compiles the fixture with an explicit lib and returns {code, output}. */
function compileWithLib(lib: string): { code: number; output: string } {
    try {
        execFileSync(
            process.execPath,
            [tscEntry, '--ignoreConfig', '--noEmit', '--strict', '--module', 'ESNext',
                '--moduleResolution', 'bundler', '--skipLibCheck', '--lib', lib, fixture],
            { encoding: 'utf8', cwd: root }
        );
        return { code: 0, output: '' };
    } catch (error) {
        const e = error as { status?: number; stdout?: string; stderr?: string };
        return { code: e.status ?? 1, output: (e.stdout ?? '') + (e.stderr ?? '') };
    }
}

test('a DOM global fails typecheck under the node lib, which is what main uses', () => {
    const result = compileWithLib('ES2023');
    assert.notEqual(result.code, 0, 'referencing document must fail without the DOM lib');
    assert.match(result.output, /Cannot find name 'document'/,
        'the failure must be the missing DOM global, not some unrelated error');
});

test('the same DOM global passes under the DOM lib, which only the renderer uses', () => {
    const result = compileWithLib('ES2023,DOM');
    assert.equal(result.code, 0, 'the DOM lib must accept document; the difference is the whole split');
});
