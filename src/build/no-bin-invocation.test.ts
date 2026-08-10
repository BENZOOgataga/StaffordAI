/**
 * No tracked source file invokes a dependency bin shim by path.
 *
 * The shim under the node modules bin directory is a POSIX symlink on macOS and
 * Linux and a shell wrapper on Windows, and execFileSync cannot run the Windows
 * form. A test that called it by path passed on macOS and failed the windows CI
 * job with no output. The rule is to call the package's JS entry through node
 * instead, and this guard stops the shim coming back.
 *
 * It scans source directories only, not docs, and matches the shim path only
 * when a quote or backtick sits immediately before it, so an invocation is
 * caught and this comment, which never writes the literal, is not. It reports
 * the file and line so a hit is actionable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

// A quote or backtick immediately before the shim path. An invocation is always
// a string literal; prose is not.
const INVOCATION = /['"`]node_modules\/\.bin\//;

function trackedSourceFiles(): string[] {
    const out = execFileSync('git', ['ls-files', 'src', 'scripts', 'runner', '.github'], {
        cwd: root, encoding: 'utf8'
    });
    return out.split('\n').map((l) => l.trim()).filter(Boolean).filter((f) => !f.endsWith('.md'));
}

test('no tracked source file invokes a node_modules/.bin path', () => {
    const hits: string[] = [];
    for (const file of trackedSourceFiles()) {
        const lines = readFileSync(root + file, 'utf8').split('\n');
        lines.forEach((line, i) => {
            if (INVOCATION.test(line)) hits.push(file + ':' + (i + 1));
        });
    }
    assert.deepEqual(
        hits, [],
        'these invoke a .bin shim, which fails on Windows. Call the JS entry through node:\n  ' +
        hits.join('\n  ')
    );
});
