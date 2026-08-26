/**
 * Groups a turn's flat block list into the layout the Conversation renders: a collapsed reasoning
 * block that wraps the thinking and the actions the colleague took while reasoning, then the final
 * reply after it, with any top-level blocks kept at the top level.
 *
 * The reasoning boundary is inferred from order, since the stream marks it no other way (confirmed on
 * real turns: a turn is thinking, then the actions it took, then a final text answer, and there is no
 * field that says "this action was part of reasoning"). The rule: the reasoning span runs from the
 * first thinking block to the final reply text; the thinking and actions in between nest; the final
 * text is the answer and sits at the top level; blocks before the first thinking, or after the last
 * text, stay at the top level too. A turn with no thinking has no reasoning block, everything is top
 * level, exactly as before.
 *
 * Pure and computed from the block order alone, so a persisted turn reconstructs the same nesting on
 * reopen, and it is tested without a DOM. When the rule cannot form a meaningful span (an empty,
 * redacted thinking with no actions), it leaves the blocks flat rather than wrap an empty container.
 */

import type { LiveBlock } from '../../shared/ipc.ts';

/** A top-level block, or the reasoning container that wraps a span of thinking-plus-actions. */
export type TurnItem =
    | { readonly kind: 'block'; readonly block: LiveBlock }
    | { readonly kind: 'reasoning'; readonly blocks: readonly LiveBlock[]; readonly seconds: number | null };

/**
 * True when a reasoning span is worth wrapping: it has an action, or real reasoning text, or interim
 * text. A span of only redacted thinking (empty text, even with a duration) is not, so a turn that
 * merely thought without doing anything visible does not become an empty "Worked for Ns" island.
 */
function worthWrapping(blocks: readonly LiveBlock[]): boolean {
    return blocks.some((b) => b.kind === 'tool' || b.text !== '');
}

/** An AskUserQuestion with a parsed question is a visible step, never hidden inside collapsed reasoning. */
function isAsk(block: LiveBlock): boolean {
    return block.kind === 'tool' && block.name === 'AskUserQuestion' && block.question !== undefined;
}

/** The reasoning duration for a run of blocks: the sum of thinking times, or null while any streams. */
function durationOf(blocks: readonly LiveBlock[]): number | null {
    let seconds: number | null = null;
    let streaming = false;
    for (const b of blocks) {
        if (b.kind !== 'thinking') continue;
        if (b.seconds === null) streaming = true;
        else seconds = (seconds ?? 0) + b.seconds;
    }
    return streaming ? null : seconds;
}

export function groupTurn(blocks: readonly LiveBlock[]): TurnItem[] {
    const firstThinking = blocks.findIndex((b) => b.kind === 'thinking');
    if (firstThinking === -1) return blocks.map((block) => ({ kind: 'block', block }));

    // The answer is the last non-empty text block. If there is none after the reasoning starts, the
    // span runs to the end (a turn that thought and acted but gave no final text).
    let lastText = -1;
    blocks.forEach((b, i) => { if (b.kind === 'text' && b.text !== '') lastText = i; });
    const spanEnd = lastText > firstThinking ? lastText : blocks.length;

    const items: TurnItem[] = [];
    let reasoning: LiveBlock[] = [];
    const flush = (): void => {
        if (worthWrapping(reasoning)) items.push({ kind: 'reasoning', blocks: reasoning, seconds: durationOf(reasoning) });
        reasoning = [];
    };
    blocks.forEach((block, i) => {
        // A block is nested only if it sits inside the reasoning region and is not an ask. Pre-reasoning
        // blocks, the answer and anything after, and every ask stay at the top level.
        if (i >= firstThinking && i < spanEnd && !isAsk(block)) { reasoning.push(block); return; }
        flush();
        items.push({ kind: 'block', block });
    });
    flush();
    return items;
}
