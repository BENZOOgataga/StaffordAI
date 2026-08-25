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
import type { LiveBlock, LiveToolStatus } from '../../shared/ipc.ts';

interface TextBlockM { kind: 'text'; text: string }
interface ToolBlockM { kind: 'tool'; id: string; name: string; target: string | null; status: LiveToolStatus; partial: string }
type BlockM = TextBlockM | ToolBlockM;

export class LiveTurnBuilder {
    #blocks: BlockM[] = [];
    /** Per current message: content index to the block it opened, so deltas find their block. */
    #byIndex = new Map<number, BlockM | null>();

    /** The block list for the wire, tool blocks stripped of their internal partial-json buffer. */
    snapshot(): LiveBlock[] {
        return this.#blocks.map((b) =>
            b.kind === 'text'
                ? { kind: 'text', text: b.text }
                : { kind: 'tool', id: b.id, name: b.name, target: b.target, status: b.status }
        );
    }

    /** Folds one event in. Returns true when the snapshot changed, so a push is worth sending. */
    apply(event: ClaudeStreamEvent): boolean {
        if (event.type === 'stream_event') return this.#applyStream(event.raw.event);
        if (event.type === 'user') return this.#applyToolResults(event.raw.message);
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
            // A thinking or other block: remember the index maps to nothing, so its deltas are
            // ignored rather than mistaken for text.
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
            if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                if (block && block.kind === 'tool') block.partial += delta.partial_json;
                // The target updates at content_block_stop, not per fragment, so no visible change here.
                return false;
            }
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
            return false;
        }

        return false;
    }

    /** A `user` event carries tool_result blocks; each resolves its tool by id to ok or error. */
    #applyToolResults(message: unknown): boolean {
        if (!isRecord(message)) return false;
        const content = message.content;
        if (!Array.isArray(content)) return false;
        let changed = false;
        for (const part of content) {
            if (!isRecord(part) || part.type !== 'tool_result') continue;
            const id = typeof part.tool_use_id === 'string' ? part.tool_use_id : '';
            if (id === '') continue;
            const status: LiveToolStatus = part.is_error === true ? 'error' : 'ok';
            for (const block of this.#blocks) {
                if (block.kind === 'tool' && block.id === id && block.status !== status) {
                    block.status = status;
                    changed = true;
                }
            }
        }
        return changed;
    }
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
