/**
 * The rich feed must never be able to disturb the authoritative state feed. This is
 * that boundary as a test, not a note: the transcript path from the hook record to
 * the tagged event cannot import the registry, the state derivation, the drain, or
 * the roster. A broken transcript parse has nothing to break, because the code that
 * does the parsing cannot reach the code that decides a colleague's state.
 *
 * Transitive, like the state-derivation boundary test, because a direct check passes
 * while the one file it allows quietly pulls in the registry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';

test('the transcript feed imports nothing from the state path', () => {
    // The state machine, its registry, the drain, and the roster snapshot. If the
    // transcript code could import any of these, a parse fault could reach state.
    const FORBIDDEN = /(session-registry|session-state|agent-state|\/drain|roster|snapshot|channel-events|\/ipc\/|node:(net|http|https|http2))/;

    const visited = new Set<string>();
    const reached: string[] = [];

    function inspect(file: string, via: string[]): void {
        if (visited.has(file)) return;
        visited.add(file);
        reached.push(nodePath.basename(file));

        const source = readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');

        const specifiers = [
            ...[...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
            ...[...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
            ...[...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
        ].filter((s): s is string => typeof s === 'string');

        for (const specifier of specifiers) {
            const chain = [...via, nodePath.basename(file)];
            assert.doesNotMatch(
                specifier, FORBIDDEN,
                'the transcript feed reached the state path through ' + chain.join(' -> ') +
                ' -> ' + specifier + '. The rich feed must not be able to touch state.'
            );
            if (specifier.startsWith('.')) {
                inspect(nodePath.resolve(nodePath.dirname(file), specifier), chain);
            }
        }
    }

    // Both entry points: the manager wired into the shell, and the parser and tailer
    // it uses. Walking the manager reaches the other two transitively.
    const entry = fileURLToPath(new URL('./transcript-manager.ts', import.meta.url));
    inspect(entry, []);
    // A belt to the suspenders: the reached set includes the tailer and the parser,
    // proving the walk actually traversed the feed and did not stop at the entry.
    assert.ok(reached.includes('transcript-tailer.ts'), 'the walk reached the tailer');
    assert.ok(reached.includes('transcript-parse.ts'), 'the walk reached the parser');
});
