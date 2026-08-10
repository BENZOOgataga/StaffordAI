/**
 * The native-externals list names only modules that actually exist.
 *
 * Before this guard the vite config marked `better-sqlite3` external, and it is
 * not a dependency and not installed, so the config referenced a module that
 * was not there. That is the drift this project keeps paying for, and a comment
 * does not hold it.
 *
 * Existence, not behaviour, on purpose: it fails loudly and cannot pass against
 * the wrong subject. Every name must be a declared dependency present in
 * `node_modules`, and it fails if the list and the installed set diverge in
 * either direction. When Task 8 adds `better-sqlite3` it adds the dependency and
 * the list entry together, or this goes red. When 7b adds `asarUnpack`, its
 * entries join the same check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NATIVE_EXTERNALS } from './native-externals.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

function declaredDeps(): Record<string, string> {
    const p = JSON.parse(readFileSync(root + 'package.json', 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
    };
    return { ...p.dependencies, ...p.devDependencies };
}

test('every native external is a declared dependency', () => {
    const declared = declaredDeps();
    for (const name of NATIVE_EXTERNALS) {
        assert.ok(
            name in declared,
            name + ' is a native external but is not in package.json. Add the dependency or ' +
            'remove the entry; the two move together.'
        );
    }
});

test('every native external is installed in node_modules', () => {
    for (const name of NATIVE_EXTERNALS) {
        assert.ok(
            existsSync(root + 'node_modules/' + name),
            name + ' is a native external but is not installed. It names a real binary that must ' +
            'exist to be kept out of the asar.'
        );
    }
});

test('better-sqlite3 is a native external exactly when it is installed', () => {
    // The specific regression. It arrives in Task 8, and naming it before then
    // is what this guard exists to catch.
    const installed = existsSync(root + 'node_modules/better-sqlite3');
    const listed = (NATIVE_EXTERNALS as readonly string[]).includes('better-sqlite3');
    assert.equal(
        listed, installed,
        'better-sqlite3 must be a native external only once it is installed, and not before'
    );
});
