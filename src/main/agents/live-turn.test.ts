import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveTurnBuilder, toolTarget } from './live-turn.ts';
import type { ClaudeStreamEvent } from './claude-runner.ts';

/** A stream_event wrapping one Anthropic streaming event. */
const se = (event: unknown): ClaudeStreamEvent => ({ type: 'stream_event', raw: { event } });
/** A top-level event of any type, as the runner hands it to onEvent. */
const ev = (type: string, raw: Record<string, unknown>): ClaudeStreamEvent => ({ type, raw: { type, ...raw } });

// --- TodoWrite checklists (phase 6) -----------------------------------------

interface Todo { text: string; status: string }
/** Drives a full TodoWrite tool call (start, input as one json fragment, stop) and returns its todos. */
function todoCall(b: LiveTurnBuilder, input: unknown, id = 't1', index = 0): readonly Todo[] | undefined {
    b.apply(se({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'TodoWrite', input: {} } }));
    b.apply(se({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }));
    b.apply(se({ type: 'content_block_stop', index }));
    const blk = b.snapshot().find((x) => x.kind === 'tool' && (x as { name: string }).name === 'TodoWrite' && (x as { id: string }).id === id);
    return (blk as { todos?: readonly Todo[] } | undefined)?.todos;
}

test('a TodoWrite parses its todos: content and mapped status per row', () => {
    const b = new LiveTurnBuilder();
    const todos = todoCall(b, { todos: [
        { content: 'Write the parser', status: 'completed', activeForm: 'Writing the parser' },
        { content: 'Cover it with tests', status: 'in_progress', activeForm: 'Covering it with tests' },
        { content: 'Wire it up', status: 'pending', activeForm: 'Wiring it up' }
    ] });
    assert.ok(todos);
    assert.deepEqual(todos!.map((t) => t.status), ['done', 'in-progress', 'pending'], 'the real status values map to the tab enum');
    assert.equal(todos![0]!.text, 'Write the parser', 'a done row uses its content');
    assert.equal(todos![1]!.text, 'Covering it with tests', 'an in-progress row reads as its active form');
    assert.equal(todos![2]!.text, 'Wire it up', 'a pending row uses its content');
});

test('an unknown status becomes the safe "other", never a throw', () => {
    const b = new LiveTurnBuilder();
    const todos = todoCall(b, { todos: [{ content: 'x', status: 'blocked' }] });
    assert.equal(todos![0]!.status, 'other');
});

test('an empty todos array is a valid empty checklist, not a failure', () => {
    const b = new LiveTurnBuilder();
    const todos = todoCall(b, { todos: [] });
    assert.deepEqual(todos, [], 'empty, but present, so the island shows and does not fall back');
});

test('a malformed TodoWrite input carries no todos, so it degrades to the generic one-liner', () => {
    const b = new LiveTurnBuilder();
    assert.equal(todoCall(b, { nope: true }), undefined, 'no todos array, no checklist');
    const b2 = new LiveTurnBuilder();
    b2.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'TodoWrite', input: {} } }));
    b2.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{not valid json' } }));
    assert.doesNotThrow(() => b2.apply(se({ type: 'content_block_stop', index: 0 })));
    assert.equal((b2.snapshot()[0] as { todos?: unknown }).todos, undefined);
});

test('a huge todo list is capped so a runaway plan cannot bloat the payload', () => {
    const b = new LiveTurnBuilder();
    const many = Array.from({ length: 500 }, (_v, i) => ({ content: 'step ' + i, status: 'pending' }));
    const todos = todoCall(b, { todos: many });
    assert.ok(todos && todos.length <= 100, 'the list is bounded');
});

test('a non-TodoWrite tool never carries todos', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} } }));
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.ts"}' } }));
    b.apply(se({ type: 'content_block_stop', index: 0 }));
    assert.equal((b.snapshot()[0] as { todos?: unknown }).todos, undefined);
});

// --- AskUserQuestion (part of the interleaving work) ------------------------

const askQuestion = (b: LiveTurnBuilder): string | undefined =>
    (b.snapshot()[0] as { question?: string }).question;

test('an AskUserQuestion parses its question, so the ask renders as a visible step', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: {} } }));
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ questions: [{ question: 'Plan first, or just build it?', header: 'Approach', options: [] }] }) } }));
    b.apply(se({ type: 'content_block_stop', index: 0 }));
    assert.equal(askQuestion(b), 'Plan first, or just build it?');
});

test('AskUserQuestion joins several questions and degrades to no question on a bad input', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: {} } }));
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ questions: [{ question: 'A?' }, { question: 'B?' }] }) } }));
    b.apply(se({ type: 'content_block_stop', index: 0 }));
    assert.equal(askQuestion(b), 'A?\nB?');

    const bad = new LiveTurnBuilder();
    bad.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: {} } }));
    bad.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{not json' } }));
    assert.doesNotThrow(() => bad.apply(se({ type: 'content_block_stop', index: 0 })));
    assert.equal(askQuestion(bad), undefined, 'a malformed ask degrades to the tool one-liner');
});

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

// --- shell output and reads (phase 3) ---------------------------------------

const toolOut = (b: LiveTurnBuilder): string | undefined =>
    (b.snapshot()[0] as { output?: string }).output;

test('a shell tool captures its result output, rendered even on success', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } } }));
    b.apply(ev('user', { message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'file-a\nfile-b\n' }] } }));
    assert.equal(toolOut(b), 'file-a\nfile-b\n', 'the shell output is captured on the tool block');
});

test('a failed shell tool still captures its output, where stderr is the useful part', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'PowerShell', input: { command: 'nope' } } }));
    b.apply(ev('user', { message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'command not found: nope' }] } }));
    assert.equal((b.snapshot()[0] as { status: string }).status, 'error');
    assert.equal(toolOut(b), 'command not found: nope', 'a failed shell command keeps its stderr');
});

test('a file read never carries output: a read is an access, not output to show', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } } }));
    b.apply(ev('user', { message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'the whole file contents here' }] } }));
    assert.equal(toolOut(b), undefined, 'a read shows only its path, never the file body');
});

test('an edit carries no command output, only its diff', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.ts' } } }));
    b.apply(ev('user', { message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'edited' }] } }));
    assert.equal(toolOut(b), undefined);
});

test('a shell result whose content is a block array joins its text parts', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi' } } }));
    b.apply(ev('user', { message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'hi\n' }, { type: 'text', text: 'there' }] }] } }));
    assert.equal(toolOut(b), 'hi\nthere');
});

test('an empty shell result records an empty string, so the island can say it ran with no output', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'true' } } }));
    b.apply(ev('user', { message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '' }] } }));
    assert.equal(toolOut(b), '', 'empty is distinct from absent');
});

test('a pathological output is capped, so a runaway command cannot blow up the payload', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'yes' } } }));
    const huge = 'x'.repeat(500000);
    b.apply(ev('user', { message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: huge }] } }));
    const out = toolOut(b) ?? '';
    assert.ok(out.length < 21000, 'the output is bounded well under the raw size');
    assert.match(out, /output truncated \(\d+ more characters\)/, 'the truncation is marked honestly');
});

// --- file edits as diffs (phase 4) ------------------------------------------

interface EditFile { path: string; added: number; removed: number; binary: boolean; hunks: { header: string; lines: { kind: string; text: string }[] }[] }
const toolEdit = (b: LiveTurnBuilder): EditFile | undefined =>
    (b.snapshot()[0] as { edit?: EditFile }).edit;

test('an Edit with a structuredPatch becomes a diff: hunk header, +/- lines, and counts', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/x.ts' } } }));
    b.apply(ev('user', {
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok' }] },
        tool_use_result: {
            filePath: 'src/x.ts',
            structuredPatch: [{
                oldStart: 1, oldLines: 2, newStart: 1, newLines: 3,
                lines: [' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;']
            }]
        }
    }));
    const edit = toolEdit(b);
    assert.ok(edit, 'the edit carries a diff');
    assert.equal(edit!.path, 'src/x.ts');
    assert.equal(edit!.binary, false);
    assert.equal(edit!.added, 2, 'two + lines');
    assert.equal(edit!.removed, 1, 'one - line');
    assert.equal(edit!.hunks[0]!.header, '@@ -1,2 +1,3 @@', 'header built from the patch offsets');
    assert.deepEqual(edit!.hunks[0]!.lines.map((l) => l.kind), ['context', 'del', 'add', 'add']);
    assert.equal(edit!.hunks[0]!.lines[1]!.text, 'const b = 2;', 'the marker is stripped from the text');
});

test('a Write that creates a file becomes an all-additions diff synthesised from its content', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'new.ts' } } }));
    b.apply(ev('user', {
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'created' }] },
        tool_use_result: { type: 'create', filePath: 'new.ts', structuredPatch: [], content: 'line one\nline two\n' }
    }));
    const edit = toolEdit(b);
    assert.ok(edit);
    assert.equal(edit!.added, 2, 'both new lines are additions');
    assert.equal(edit!.removed, 0);
    assert.deepEqual(edit!.hunks[0]!.lines.map((l) => l.kind), ['add', 'add']);
    assert.equal(edit!.hunks[0]!.header, '@@ -0,0 +1,2 @@', 'a create starts from nothing');
});

test('a failed edit carries no diff, so it degrades to the one-line island', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'x.ts' } } }));
    b.apply(ev('user', {
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'no match' }] },
        tool_use_result: { filePath: 'x.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+x'] }] }
    }));
    assert.equal(toolEdit(b), undefined, 'a failed edit shows no diff');
    assert.equal((b.snapshot()[0] as { status: string }).status, 'error');
});

test('a malformed or missing patch degrades to no diff, never throws', () => {
    for (const tur of [undefined, {}, { filePath: 'x.ts' }, { filePath: 'x.ts', structuredPatch: 'nope' }, { structuredPatch: [{ lines: 'bad' }] }]) {
        const b = new LiveTurnBuilder();
        b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'x.ts' } } }));
        assert.doesNotThrow(() => b.apply(ev('user', { message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] }, tool_use_result: tur })));
        // A structuredPatch that is a non-empty array of malformed hunks still yields a (possibly
        // empty) file; the point is it must not throw. The clearly-missing cases carry no edit.
        if (tur === undefined || Object.keys(tur).length === 0) assert.equal(toolEdit(b), undefined);
    }
});

test('a binary edit (no structuredPatch) carries no diff, a safe non-diff row', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'logo.png' } } }));
    b.apply(ev('user', {
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok' }] },
        tool_use_result: { filePath: 'logo.png' }
    }));
    assert.equal(toolEdit(b), undefined);
});

test('a huge created file is capped, so it cannot blow up the diff', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'big.txt' } } }));
    const huge = Array.from({ length: 100000 }, (_v, i) => 'row ' + i).join('\n');
    b.apply(ev('user', {
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'created' }] },
        tool_use_result: { type: 'create', filePath: 'big.txt', structuredPatch: [], content: huge }
    }));
    const edit = toolEdit(b);
    assert.ok(edit);
    const lastLine = edit!.hunks[0]!.lines.at(-1)!;
    assert.equal(lastLine.text, '... new file truncated', 'the create diff is bounded with a marker');
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

// --- thinking blocks (phase 5) ----------------------------------------------

interface ThinkBlk { kind: string; text: string; seconds: number | null }
const thinkBlk = (b: LiveTurnBuilder): ThinkBlk | undefined =>
    b.snapshot().find((x) => x.kind === 'thinking') as ThinkBlk | undefined;

test('a thinking block accumulates its reasoning, and the signature is never in the text', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'first ' } }));
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'second' } }));
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SECRET-SIG' } }));
    const t = thinkBlk(b);
    assert.ok(t, 'a thinking block exists');
    assert.equal(t!.text, 'first second', 'the reasoning accumulated from thinking_delta');
    assert.equal(t!.text.includes('SECRET-SIG'), false, 'the signature never leaks into the text');
    assert.equal(t!.seconds, null, 'still streaming, so no duration yet');
});

test('a thinking block gets a duration in seconds at content_block_stop, from an injected clock', () => {
    let t = 1000;
    const b = new LiveTurnBuilder(() => t);
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'mulling' } }));
    t = 4200; // 3.2s later
    b.apply(se({ type: 'content_block_stop', index: 0 }));
    assert.equal(thinkBlk(b)!.seconds, 3, 'rounded start-to-stop seconds');
});

test('redacted reasoning: empty text but a real duration, which the tab still shows as "Thought for Ns"', () => {
    // Real captured behaviour: thinking_deltas arrive with an empty `thinking` string (the reasoning
    // text is redacted in this mode), yet the block ran for real. The text stays empty and the
    // duration is set, so the renderer shows the duration rather than dropping a genuine think.
    let t = 2000;
    const b = new LiveTurnBuilder(() => t);
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }));
    t = 5000;
    b.apply(se({ type: 'content_block_stop', index: 0 }));
    assert.equal(thinkBlk(b)!.text, '', 'the reasoning text is redacted');
    assert.equal(thinkBlk(b)!.seconds, 3, 'but the duration is real, so the island shows "Thought for 3s"');
});

test('thinking renders above the reply: it precedes the text block in order', () => {
    const b = new LiveTurnBuilder();
    b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
    b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }));
    b.apply(se({ type: 'content_block_stop', index: 0 }));
    b.apply(se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }));
    b.apply(se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'the answer' } }));
    assert.deepEqual(b.snapshot().map((x) => x.kind), ['thinking', 'text']);
});

test('a malformed thinking event does not throw', () => {
    const b = new LiveTurnBuilder();
    assert.doesNotThrow(() => {
        b.apply(se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }));
        b.apply(se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta' } }));
        b.apply(se({ type: 'content_block_stop', index: 0 }));
    });
    assert.equal(thinkBlk(b)!.text, '', 'a delta with no thinking string adds nothing');
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
