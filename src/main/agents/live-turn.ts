/**
 * Folds a colleague's stream events into the ordered blocks the Conversation tab renders live:
 * runs of reply text, and tool calls paired with their results. It is the phase-2 extension of the
 * phase-1 live text pipe, from a single accumulated string to a block list, so text and tool calls
 * interleave in the order they happened.
 *
 * Pure and incremental: `apply` takes one parsed stream event and mutates the builder, returning
 * whether anything visible changed, so the manager pushes a fresh snapshot only when there is
 * something new to show. `snapshot` produces the readonly block list for the wire.
 *
 * Defensive by construction, matching the runner's posture: an unknown event, a tool_use with no
 * matching result, a malformed shape, or a block type this phase does not render (thinking) loses
 * richness and is skipped, never throws. Scope is text and tool calls only; a result body is never
 * carried, only the tool name, a short target, and status.
 */

import type { ClaudeStreamEvent } from './claude-runner.ts';
import type { LiveBlock, LiveToolStatus, TaskDiffFile, TaskDiffLine } from '../../shared/ipc.ts';

interface TextBlockM { kind: 'text'; text: string }
interface ThinkingBlockM { kind: 'thinking'; text: string; seconds: number | null; startMs: number }
interface ToolBlockM {
    kind: 'tool'; id: string; name: string; target: string | null; status: LiveToolStatus;
    partial: string; output?: string; edit?: TaskDiffFile;
}
type BlockM = TextBlockM | ThinkingBlockM | ToolBlockM;

/** The command-running tools whose output the Conversation renders. Matched by name, the identity the
 * stream gives, never guessed from the output shape. (PowerShell is not a shell in the bash sense, so
 * "command tools" names the set more honestly than "shell tools" did.) */
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell', 'Shell']);

/** The file-editing tools whose result carries a diff to render. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/**
 * The cap on a single tool's captured output, in characters. A pathological multi-megabyte stdout,
 * or a huge created file's content, is truncated to this before it crosses the bridge, so neither the
 * IPC payload nor the renderer is blown up. 20000 characters is a few hundred lines, well past what a
 * person reads inline, and the tail is dropped with a marker so the truncation is honest.
 */
const MAX_TOOL_OUTPUT_CHARS = 20000;

export class LiveTurnBuilder {
    #blocks: BlockM[] = [];
    /** Per current message: content index to the block it opened, so deltas find their block. */
    #byIndex = new Map<number, BlockM | null>();
    /** The wall clock, injected so the "Thought for Ns" duration is deterministic under test. */
    readonly #now: () => number;

    constructor(now: () => number = Date.now) {
        this.#now = now;
    }

    /** The block list for the wire, tool blocks stripped of their internal partial-json buffer. */
    snapshot(): LiveBlock[] {
        return this.#blocks.map((b) => {
            if (b.kind === 'text') return { kind: 'text', text: b.text };
            if (b.kind === 'thinking') return { kind: 'thinking', text: b.text, seconds: b.seconds };
            return {
                kind: 'tool', id: b.id, name: b.name, target: b.target, status: b.status,
                ...(b.output !== undefined ? { output: b.output } : {}),
                ...(b.edit !== undefined ? { edit: b.edit } : {})
            };
        });
    }

    /** Folds one event in. Returns true when the snapshot changed, so a push is worth sending. */
    apply(event: ClaudeStreamEvent): boolean {
        if (event.type === 'stream_event') return this.#applyStream(event.raw.event);
        // A user event carries the tool_result under message.content and, as a sibling of message,
        // the structured tool_use_result that holds an edit's patch. Both are handed to the handler.
        if (event.type === 'user') return this.#applyToolResults(event.raw.message, event.raw.tool_use_result);
        // assistant/result/system and anything else: the deltas already built the structure.
        return false;
    }

    #applyStream(inner: unknown): boolean {
        if (!isRecord(inner)) return false;
        const type = inner.type;

        if (type === 'message_start') {
            // A new message reuses content indices from zero, so the index map resets. The blocks
            // built so far stay: a turn accumulates across its messages.
            this.#byIndex.clear();
            return false;
        }

        if (type === 'content_block_start') {
            const idx = numberOf(inner.index);
            const cb = inner.content_block;
            if (idx === null || !isRecord(cb)) return false;
            if (cb.type === 'text') {
                const block: TextBlockM = { kind: 'text', text: typeof cb.text === 'string' ? cb.text : '' };
                this.#blocks.push(block);
                this.#byIndex.set(idx, block);
                return block.text !== '';
            }
            if (cb.type === 'tool_use') {
                const block: ToolBlockM = {
                    kind: 'tool',
                    id: typeof cb.id === 'string' ? cb.id : '',
                    name: typeof cb.name === 'string' ? cb.name : '',
                    target: toolTarget(cb.input),
                    status: 'running',
                    partial: ''
                };
                this.#blocks.push(block);
                this.#byIndex.set(idx, block);
                return true;
            }
            if (cb.type === 'thinking') {
                // The reasoning block. Its text accumulates from thinking_delta; the signature never
                // does. An empty one (no deltas, or omitted mode) is simply not rendered downstream.
                const block: ThinkingBlockM = {
                    kind: 'thinking',
                    text: typeof cb.thinking === 'string' ? cb.thinking : '',
                    seconds: null,
                    startMs: this.#now()
                };
                this.#blocks.push(block);
                this.#byIndex.set(idx, block);
                return block.text !== '';
            }
            // Any other block type: remember the index maps to nothing, so its deltas are ignored
            // rather than mistaken for text.
            this.#byIndex.set(idx, null);
            return false;
        }

        if (type === 'content_block_delta') {
            const idx = numberOf(inner.index);
            const delta = inner.delta;
            if (idx === null || !isRecord(delta)) return false;
            const block = this.#byIndex.get(idx);
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                if (block && block.kind === 'text') { block.text += delta.text; return delta.text !== ''; }
                // No start seen for this index (defensive): open a text block so the reply is never
                // lost. A null mapping means a non-text block (thinking) owns the index, so ignore it.
                if (block === undefined) {
                    const created: TextBlockM = { kind: 'text', text: delta.text };
                    this.#blocks.push(created);
                    this.#byIndex.set(idx, created);
                    return delta.text !== '';
                }
                return false;
            }
            if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                // The reasoning text. The signature_delta is a different delta type and falls through
                // to ignored below, so the signature is never appended to what is rendered.
                if (block && block.kind === 'thinking') { block.text += delta.thinking; return delta.thinking !== ''; }
                return false;
            }
            if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                if (block && block.kind === 'tool') block.partial += delta.partial_json;
                // The target updates at content_block_stop, not per fragment, so no visible change here.
                return false;
            }
            // Any other delta, signature_delta included, is not content and is dropped.
            return false;
        }

        if (type === 'content_block_stop') {
            const idx = numberOf(inner.index);
            if (idx === null) return false;
            const block = this.#byIndex.get(idx);
            if (block && block.kind === 'tool' && block.partial !== '') {
                const target = parseTarget(block.partial);
                if (target !== null && target !== block.target) { block.target = target; return true; }
            }
            if (block && block.kind === 'thinking' && block.seconds === null) {
                // The thinking finished: stamp how long it took, so the island reads "Thought for Ns"
                // instead of "Thinking...". Derived from the block's own start-to-stop wall time.
                block.seconds = Math.max(0, Math.round((this.#now() - block.startMs) / 1000));
                return block.text !== '';
            }
            return false;
        }

        return false;
    }

    /**
     * A `user` event carries tool_result blocks (under message.content) that resolve each tool by id
     * to ok or error, and, as a sibling, the structured tool_use_result that holds an edit's patch.
     */
    #applyToolResults(message: unknown, toolUseResult: unknown): boolean {
        if (!isRecord(message)) return false;
        const content = message.content;
        if (!Array.isArray(content)) return false;
        let changed = false;
        for (const part of content) {
            if (!isRecord(part) || part.type !== 'tool_result') continue;
            const id = typeof part.tool_use_id === 'string' ? part.tool_use_id : '';
            if (id === '') continue;
            const status: LiveToolStatus = part.is_error === true ? 'error' : 'ok';
            // A command result's output is rendered even on failure, where stderr is the useful part.
            const output = capOutput(resultText(part.content));
            for (const block of this.#blocks) {
                if (block.kind !== 'tool' || block.id !== id) continue;
                if (block.status !== status) { block.status = status; changed = true; }
                // Only a command tool carries its output; a read or an edit never does. Even an empty
                // string is set, so the island can say the command ran and produced nothing.
                if (COMMAND_TOOLS.has(block.name) && block.output === undefined && output !== null) {
                    block.output = output;
                    changed = true;
                }
                // A successful edit carries its diff, converted from the structured result. A failed
                // edit, a binary one, or a missing/malformed patch leaves it absent, which the tab
                // degrades to the one-line "edited path".
                if (EDIT_TOOLS.has(block.name) && block.edit === undefined && status !== 'error') {
                    const edit = editDiff(toolUseResult, block.target);
                    if (edit !== null) { block.edit = edit; changed = true; }
                }
            }
        }
        return changed;
    }
}

/**
 * The diff for an edit, from the stream's structured tool_use_result, or null when there is none to
 * show (not an object, no path, a binary edit, or a malformed patch). Two shapes: a real edit carries
 * a `structuredPatch` (hunks), which maps straight to the viewer's file; a created file carries an
 * empty patch and the whole new `content`, which becomes an all-additions diff, capped.
 */
function editDiff(toolUseResult: unknown, fallbackPath: string | null): TaskDiffFile | null {
    if (!isRecord(toolUseResult)) return null;
    const path = typeof toolUseResult.filePath === 'string' ? toolUseResult.filePath : (fallbackPath ?? '');
    if (path === '') return null;

    const patch = toolUseResult.structuredPatch;
    if (Array.isArray(patch) && patch.length > 0) return fileFromStructuredPatch(path, patch);

    // An empty patch with content is a created file: render it as an all-additions diff, capped.
    if (Array.isArray(patch) && patch.length === 0 && typeof toolUseResult.content === 'string') {
        return fileFromCreatedContent(path, toolUseResult.content);
    }
    // No usable patch (binary, or a shape we do not model): degrade to the one-liner.
    return null;
}

/** Maps a jsdiff-style structuredPatch straight into the review viewer's file shape. */
function fileFromStructuredPatch(path: string, patch: readonly unknown[]): TaskDiffFile {
    const hunks: { header: string; lines: TaskDiffLine[] }[] = [];
    let added = 0;
    let removed = 0;
    for (const raw of patch) {
        if (!isRecord(raw)) continue;
        const oldStart = numberOf(raw.oldStart) ?? 0;
        const oldLines = numberOf(raw.oldLines) ?? 0;
        const newStart = numberOf(raw.newStart) ?? 0;
        const newLines = numberOf(raw.newLines) ?? 0;
        const header = '@@ -' + oldStart + ',' + oldLines + ' +' + newStart + ',' + newLines + ' @@';
        const lines: TaskDiffLine[] = [];
        const rawLines = Array.isArray(raw.lines) ? raw.lines : [];
        for (const l of rawLines) {
            if (typeof l !== 'string') continue;
            const marker = l.charAt(0);
            const text = l.slice(1);
            if (marker === '+') { lines.push({ kind: 'add', text }); added++; }
            else if (marker === '-') { lines.push({ kind: 'del', text }); removed++; }
            else lines.push({ kind: 'context', text });
        }
        hunks.push({ header, lines });
    }
    return { path, added, removed, hunks, binary: false };
}

/**
 * A created file as an all-additions diff synthesised from its content, capped. Chosen over a plain
 * "created path, N lines" row because it shows the actual code that was written, reads exactly like
 * `git diff` of a new file, and reuses the same viewer as every other edit, so a create and a modify
 * look consistent. Bounded by the same cap as command output, so a huge new file cannot blow up the
 * bridge or the viewer.
 */
function fileFromCreatedContent(path: string, content: string): TaskDiffFile {
    const capped = content.length > MAX_TOOL_OUTPUT_CHARS;
    const body = capped ? content.slice(0, MAX_TOOL_OUTPUT_CHARS) : content;
    const rawLines = body.replace(/\n$/, '').split('\n');
    const lines: TaskDiffLine[] = rawLines.map((text) => ({ kind: 'add' as const, text }));
    if (capped) lines.push({ kind: 'context', text: '... new file truncated' });
    const added = rawLines.length;
    const header = '@@ -0,0 +1,' + added + ' @@';
    return { path, added, removed: 0, hunks: [{ header, lines }], binary: false };
}

/** The text of a tool_result's content: the string as-is, or the text parts of a block array. */
function resultText(content: unknown): string | null {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const p of content) {
        if (isRecord(p) && p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
    }
    return parts.length > 0 ? parts.join('') : '';
}

/** Bounds output to the cap, appending an honest marker when the tail is dropped. Null stays null. */
function capOutput(text: string | null): string | null {
    if (text === null) return null;
    if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
    return text.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n... output truncated (' +
        String(text.length - MAX_TOOL_OUTPUT_CHARS) + ' more characters)';
}

/** Parses a tool's accumulated input JSON and derives its one-line target, or null on any failure. */
function parseTarget(partialJson: string): string | null {
    try {
        return toolTarget(JSON.parse(partialJson));
    } catch {
        return null;
    }
}

/**
 * A short, human-readable target for a tool use, from its input: the file path for a file tool,
 * the command for a shell tool, the pattern for a search, else null. Bounded so a huge input never
 * becomes a huge string. Never returns raw structured input. Shared by the live builder and the
 * activity recorder, which both need the same one-line target from the same inputs.
 */
export function toolTarget(input: unknown): string | null {
    if (typeof input !== 'object' || input === null) return null;
    const i = input as Record<string, unknown>;
    const first = (...keys: string[]): string | null => {
        for (const k of keys) if (typeof i[k] === 'string' && (i[k] as string).length > 0) return i[k] as string;
        return null;
    };
    const value = first('file_path', 'path', 'notebook_path', 'command', 'pattern', 'query', 'url', 'prompt', 'description');
    if (value === null) return null;
    const oneLine = value.replace(/\s+/g, ' ').trim();
    return oneLine.length > 120 ? oneLine.slice(0, 120) + '...' : oneLine;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function numberOf(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
