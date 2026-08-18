/**
 * The tailer over an in-memory file, driven by hand so the tests are deterministic.
 * It proves the three things a live transcript demands: a partial final line is
 * buffered until its newline, a multibyte character split across a read is not
 * corrupted, and a missing file, a read error, or an unparseable line never crashes
 * the tail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptTailer, type TailerFs } from './transcript-tailer.ts';
import type { ActivityEvent } from './transcript-parse.ts';

/** An in-memory file the test grows, truncates, or makes absent. Bytes, so offsets match the real fs. */
class FakeFile {
    #bytes: Buffer = Buffer.alloc(0);
    present = true;
    append(text: string): void { this.#bytes = Buffer.concat([this.#bytes, Buffer.from(text, 'utf8')]); }
    appendBytes(buf: Buffer): void { this.#bytes = Buffer.concat([this.#bytes, buf]); }
    truncateTo(text: string): void { this.#bytes = Buffer.from(text, 'utf8'); }
    fs(readError = false): TailerFs {
        return {
            size: (): number => { if (!this.present) throw new Error('ENOENT'); return this.#bytes.length; },
            read: (_p, start, end): Buffer => { if (readError) throw new Error('EIO'); return this.#bytes.subarray(start, end); }
        };
    }
}

function useLine(name: string, input: Record<string, unknown>, id: string): string {
    return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input }] } });
}

test('an absent file is tolerated: poll yields nothing and does not throw', () => {
    const file = new FakeFile(); file.present = false;
    const got: ActivityEvent[] = [];
    const t = new TranscriptTailer('x.jsonl', { fs: file.fs(), onEvents: (e) => got.push(...e) });
    assert.doesNotThrow(() => t.poll());
    assert.equal(got.length, 0);
});

test('appended complete lines are parsed and emitted on the next poll', () => {
    const file = new FakeFile();
    const got: ActivityEvent[] = [];
    const t = new TranscriptTailer('x.jsonl', { fs: file.fs(), onEvents: (e) => got.push(...e) });
    file.append(useLine('Read', { file_path: 'a.ts' }, 't1') + '\n');
    file.append(useLine('Bash', { command: 'ls' }, 't2') + '\n');
    t.poll();
    assert.deepEqual(got.map((e) => e.tool), ['Read', 'Bash']);
});

test('a partial final line is buffered, not parsed, then emitted once its newline arrives', () => {
    const file = new FakeFile();
    const got: ActivityEvent[] = [];
    const t = new TranscriptTailer('x.jsonl', { fs: file.fs(), onEvents: (e) => got.push(...e) });
    const line = useLine('Edit', { file_path: 'f.ts' }, 'tp');
    // Claude has written the line but not its newline yet.
    file.append(line);
    t.poll();
    assert.equal(got.length, 0, 'the partial line is held, nothing emitted, nothing thrown');
    // The newline (and the next line) arrive.
    file.append('\n');
    t.poll();
    assert.equal(got.length, 1);
    assert.equal(got[0]?.toolUseId, 'tp');
});

test('a multibyte character split across two reads is not corrupted', () => {
    const file = new FakeFile();
    const got: ActivityEvent[] = [];
    const t = new TranscriptTailer('x.jsonl', { fs: file.fs(), onEvents: (e) => got.push(...e) });
    // A path with a non-ASCII character, whose UTF-8 bytes we split mid-character.
    const line = useLine('Read', { file_path: 'café/é.ts' }, 'tm') + '\n';
    const bytes = Buffer.from(line, 'utf8');
    const cut = bytes.indexOf(Buffer.from('é', 'utf8')) + 1; // one byte into the multibyte 'é'
    file.appendBytes(bytes.subarray(0, cut));
    t.poll();
    file.appendBytes(bytes.subarray(cut));
    t.poll();
    assert.equal(got.length, 1);
    assert.ok(got[0]?.target?.includes('café'), 'the character survived the split read');
});

test('an unparseable line in the middle does not stop later lines', () => {
    const file = new FakeFile();
    const got: ActivityEvent[] = [];
    const t = new TranscriptTailer('x.jsonl', { fs: file.fs(), onEvents: (e) => got.push(...e) });
    file.append('{ this is not json at all\n');
    file.append(useLine('Read', { file_path: 'a.ts' }, 't9') + '\n');
    assert.doesNotThrow(() => t.poll());
    assert.deepEqual(got.map((e) => e.toolUseId), ['t9'], 'the good line still came through');
});

test('a read error is swallowed to debug and the tail keeps going', () => {
    const file = new FakeFile();
    file.append(useLine('Read', { file_path: 'a.ts' }, 't1') + '\n');
    const debug: string[] = [];
    const got: ActivityEvent[] = [];
    const t = new TranscriptTailer('x.jsonl', { fs: file.fs(true), onEvents: (e) => got.push(...e), onDebug: (m) => debug.push(m) });
    assert.doesNotThrow(() => t.poll());
    assert.equal(got.length, 0);
    assert.ok(debug.some((d) => d.includes('read skipped')), 'the read error was noted, not thrown');
});

test('a truncated file resets the offset and re-reads from the top', () => {
    const file = new FakeFile();
    const got: ActivityEvent[] = [];
    const t = new TranscriptTailer('x.jsonl', { fs: file.fs(), onEvents: (e) => got.push(...e) });
    file.append(useLine('Read', { file_path: 'a.ts' }, 't1') + '\n');
    t.poll();
    assert.equal(got.length, 1);
    // The file is replaced (rotation): emptied, then rewritten. Emptying makes the
    // size drop below the offset, which is how the tailer detects it must start over
    // rather than read a torn offset into the new content.
    file.truncateTo('');
    t.poll();
    file.append(useLine('Bash', { command: 'echo hi' }, 't2') + '\n');
    t.poll();
    assert.deepEqual(got.map((e) => e.toolUseId), ['t1', 't2']);
});

test('stop halts polling: no events after stop even as the file grows', () => {
    const file = new FakeFile();
    const got: ActivityEvent[] = [];
    const noTimer = { setInterval: () => ({ unref() {} }), clearInterval: () => {} };
    const t = new TranscriptTailer('x.jsonl', { fs: file.fs(), onEvents: (e) => got.push(...e), ...noTimer });
    t.start();
    t.stop();
    file.append(useLine('Read', { file_path: 'a.ts' }, 't1') + '\n');
    t.poll();
    assert.equal(got.length, 0, 'a poll after stop does nothing');
});
