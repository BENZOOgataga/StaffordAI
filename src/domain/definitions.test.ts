/**
 * The runtime definition registry: the six known roles, their seniority read from
 * the docs/agents frontmatter, and a lookup that refuses an unknown type so a hire
 * cannot bind to a role that does not exist.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_DEFINITIONS, definitionFor } from './definitions.ts';

test('the six roles are present with their frontmatter seniority', () => {
    const byType = new Map(AGENT_DEFINITIONS.map((d) => [d.type, d]));
    assert.equal(AGENT_DEFINITIONS.length, 6);
    assert.equal(byType.get('pm-assistant')?.seniority, 0);
    assert.equal(byType.get('lead-developer')?.seniority, 1);
    assert.equal(byType.get('developer')?.seniority, 2);
    assert.equal(byType.get('code-reviewer')?.seniority, 2);
    assert.equal(byType.get('qa-tester')?.seniority, 2);
    assert.equal(byType.get('writer')?.seniority, 2);
});

test('definitionFor resolves a real type and refuses an unknown one', () => {
    assert.equal(definitionFor('lead-developer')?.title, 'Lead developer');
    assert.equal(definitionFor('not-a-role'), null);
    assert.equal(definitionFor(''), null);
});
