/**
 * The transcript parser, against the real line shapes captured from a Claude session
 * and against the shapes a format change or a mid-write tail throws at it. The one
 * invariant under test everywhere: it never throws, whatever the line is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscriptLine, type ActivityEvent } from './transcript-parse.ts';

// The exact shapes from a real transcript (probe, 2026-08): a tool_use is an
// assistant message block with name + id + input; a tool_result is a user message
// block with tool_use_id + content.
function useLine(name: string, input: Record<string, unknown>, id = 'toolu_1'): string {
    return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input }] } });
}
function resultLine(toolUseId: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', ...extra }] } });
}

test('a Read tool_use parses to a use event with the file path as target', () => {
    const events = parseTranscriptLine(useLine('Read', { file_path: 'C:\\proj\\hello.txt' }, 'toolu_a'));
    assert.deepEqual(events, [{ phase: 'use', tool: 'Read', target: 'C:\\proj\\hello.txt', toolUseId: 'toolu_a', status: null } as ActivityEvent]);
});

test('command, pattern, and skill are read as the target for their tools', () => {
    assert.equal(parseTranscriptLine(useLine('Bash', { command: 'git status' }))[0]?.target, 'git status');
    assert.equal(parseTranscriptLine(useLine('Glob', { pattern: '**/*.ts' }))[0]?.target, '**/*.ts');
    assert.equal(parseTranscriptLine(useLine('Skill', { skill: 'working-with-benzoo' }))[0]?.target, 'working-with-benzoo');
});

test('a tool_result parses to a result event linked by tool_use_id, ok by default', () => {
    assert.deepEqual(parseTranscriptLine(resultLine('toolu_a')),
        [{ phase: 'result', tool: null, target: null, toolUseId: 'toolu_a', status: 'ok' } as ActivityEvent]);
});

test('a tool_result marked is_error parses as an error status', () => {
    assert.equal(parseTranscriptLine(resultLine('toolu_a', { is_error: true }))[0]?.status, 'error');
});

test('the target is collapsed to one line and truncated, and edit bodies never leak', () => {
    // An Edit carries old_string/new_string, which are noise and can be sensitive.
    // Only file_path is read, and a long one is truncated.
    const long = 'C:\\' + 'a'.repeat(300) + '\\f.ts';
    const events = parseTranscriptLine(useLine('Edit', { file_path: long, old_string: 'SECRET_TOKEN=xyz', new_string: 'SECRET_TOKEN=abc' }));
    const [edit] = events;
    assert.ok(edit, 'one event');
    assert.equal(edit.tool, 'Edit');
    assert.ok(edit.target && edit.target.length <= 203, 'target is truncated');
    assert.ok(!JSON.stringify(events).includes('SECRET_TOKEN'), 'no edit body leaks into the event');
});

test('multiple blocks on one line each yield an event, non-tool blocks are skipped', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'let me look' },
        { type: 'tool_use', name: 'Read', id: 't1', input: { file_path: 'a.ts' } },
        { type: 'tool_use', name: 'Bash', id: 't2', input: { command: 'ls' } }
    ] } });
    const events = parseTranscriptLine(line);
    assert.deepEqual(events.map((e) => e.tool), ['Read', 'Bash']);
});

test('a tool_use with no known target field still yields an event with a null target', () => {
    const events = parseTranscriptLine(useLine('MysteryTool', { unknown_field: 'x' }));
    assert.deepEqual(events, [{ phase: 'use', tool: 'MysteryTool', target: null, toolUseId: 'toolu_1', status: null } as ActivityEvent]);
});

test('fail safe: blank, non-JSON, non-message, and unknown shapes yield no events and do not throw', () => {
    for (const line of [
        '', '   ', '\n',
        '{ not json',                                     // a mid-write partial line
        '{"type":"assistant"}',                            // no message
        '{"type":"user","message":{"content":"a string"}}', // content not an array
        '{"type":"file-history-snapshot","foo":1}',        // a non-message line kind
        '{"message":{"content":[{"type":"image","x":1}]}}', // an unknown block type
        '[]', 'null', '"just a string"', '42'
    ]) {
        assert.doesNotThrow(() => parseTranscriptLine(line));
        assert.deepEqual(parseTranscriptLine(line), [], JSON.stringify(line) + ' yields no events');
    }
});

test('a partial tool_use line yields nothing, then the same line completed parses', () => {
    // What the tail sees: first the line without its closing brace, then whole.
    const whole = useLine('Read', { file_path: 'x.ts' }, 'toolu_p');
    const partial = whole.slice(0, whole.length - 10);
    assert.deepEqual(parseTranscriptLine(partial), [], 'the partial line parses to nothing, no throw');
    assert.equal(parseTranscriptLine(whole)[0]?.toolUseId, 'toolu_p', 'the completed line parses');
});
