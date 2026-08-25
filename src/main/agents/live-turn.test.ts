import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveTurnBuilder, toolTarget } from './live-turn.ts';
import type { ClaudeStreamEvent } from './claude-runner.ts';

/** A stream_event wrapping one Anthropic streaming event. */
const se = (event: unknown): ClaudeStreamEvent => ({ type: 'stream_event', raw: { event } });
/** A top-level event of any type, as the runner hands it to onEvent. */
const ev = (type: string, raw: Record<string, unknown>): ClaudeStreamEvent => ({ type, raw: { type, ...raw } });

test('text deltas across a block accumulate into one text block in order', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }));
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }));
    assert.deepEqual(b.snapshot(), [{ kind: 'text', text: 'Hello' }]);
});

test('a tool_use becomes a running tool block, with its target from the streamed input', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Write', input: {} } }));
    assert.deepEqual(b.snapshot(), [{ kind: 'tool', id: 't1', name: 'Write', target: null, status: 'running' }]);
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } }));
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"src/x.ts"}' } }));
    const changed = b.apply(se({ type: 'content_block_stop', index: 0 }));
    assert.equal(changed, true, 'the target resolving is a visible change');
    assert.deepEqual(b.snapshot(), [{ kind: 'tool', id: 't1', name: 'Write', target: 'src/x.ts', status: 'running' }]);
});

test('a tool_result on a user event resolves the matching tool by id', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } } }));
    const okChanged = b.apply(ev('user', { message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } }));
    assert.equal(okChanged, true);
    assert.equal((b.snapshot()[0] as { status: string }).status, 'ok');
});

test('a failed tool_result marks the tool error', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'nope' } } }));
    b.apply(ev('user', { message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true }] } }));
    assert.equal((b.snapshot()[0] as { status: string }).status, 'error');
});

test('text and tool blocks keep the order they streamed in', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } }));
    b.apply(se({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } } }));
    // A second message resets content indices; its text is a new block after the tool.
    b.apply(se({ type: 'message_start' }));
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'second' } }));
    assert.deepEqual(b.snapshot().map((x) => x.kind), ['text', 'tool', 'text']);
    assert.equal((b.snapshot()[2] as { text: string }).text, 'second');
});

// --- graceful degradation ---------------------------------------------------

test('a thinking block and its deltas never become text', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reasoning' } }));
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }));
    assert.deepEqual(b.snapshot(), [], 'thinking is out of scope this phase and adds no block');
});

test('an unknown tool still renders: it keeps its name and a null-or-parsed target, no throw', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'SomeFutureTool', input: {} } }));
    const block = b.snapshot()[0];
    assert.ok(block && block.kind === 'tool' && block.name === 'SomeFutureTool' && block.status === 'running');
});

test('a tool_result for an unknown id changes nothing and does not throw', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Write', input: {} } }));
    const changed = b.apply(ev('user', { message: { content: [{ type: 'tool_result', tool_use_id: 'nope', is_error: false }] } }));
    assert.equal(changed, false, 'no matching tool, so no change');
    assert.equal((b.snapshot()[0] as { status: string }).status, 'running', 'the real tool is still unresolved');
});

test('malformed events are ignored, never fatal', () => {
    const b = new LiveTurnBuilder();
    for (const bad of [
        se(null), se({}), se({ type: 'content_block_start' }), se({ type: 'content_block_delta', index: 0, delta: null }),
        se({ type: 'content_block_stop' }), ev('user', {}), ev('user', { message: { content: 'nope' } }),
        ev('result', { is_error: false }), { type: 'garbage', raw: {} } as ClaudeStreamEvent
    ]) {
        assert.doesNotThrow(() => b.apply(bad));
    }
    assert.deepEqual(b.snapshot(), [], 'nothing valid arrived, so nothing rendered');
});

test('a malformed tool input leaves the target null rather than throwing', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Write', input: {} } }));
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{not valid json' } }));
    b.apply(se({ type: 'content_block_stop', index: 0 }));
    assert.equal((b.snapshot()[0] as { target: string | null }).target, null);
});

// --- toolTarget -------------------------------------------------------------

test('toolTarget pulls a one-line target from known input keys, bounded', () => {
    assert.equal(toolTarget({ file_path: 'src/x.ts' }), 'src/x.ts');
    assert.equal(toolTarget({ command: 'ls  -la\n' }), 'ls -la');
    assert.equal(toolTarget({ pattern: 'foo' }), 'foo');
    assert.equal(toolTarget({}), null);
    assert.equal(toolTarget(null), null);
    assert.equal(toolTarget('nope'), null);
    assert.equal(toolTarget({ command: 'x'.repeat(200) })!.length, 123, 'a huge target is clipped to 120 plus the ellipsis');
});
