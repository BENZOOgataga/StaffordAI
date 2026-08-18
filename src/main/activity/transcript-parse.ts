/**
 * Parses a line of Claude Code's session transcript into typed activity events, and
 * never throws while doing it.
 *
 * The transcript is an undocumented, version-dependent JSONL file Claude writes as
 * it works, one message per line. This reads the two blocks the rich feed cares
 * about, `tool_use` (the agent called a tool) and `tool_result` (the tool
 * answered), and turns each into a small typed event. Everything else, thinking,
 * text, the file-history and mode lines, an unknown block, a malformed line, a
 * partial line at the tail, resolves to no event rather than an error.
 *
 * That last property is the whole point of the module. This file feeds only the
 * future rich rows; a Claude update that reshapes the transcript must degrade to
 * fewer rows, never crash the tailer, never reach the authoritative hook-based
 * state feed. So parsing is total: a line either yields events or it yields none,
 * and no input shape makes it throw.
 *
 * The target of a tool is read from a small set of known input fields and truncated,
 * and a tool_result carries only its ok/error status. The tool's argument bodies (an
 * edit's old and new text, a result's content) are never copied out, so nothing
 * sensitive from the code or the output travels past this boundary.
 */

/** Which half of a tool call an event is: the call, or its result. */
export type ActivityPhase = 'use' | 'result';

/**
 * One typed activity event parsed from the transcript. A `use` carries the tool and
 * its target; a `result` carries the status. Both carry `toolUseId`, which links a
 * result back to its use for a later piece to pair them. The agent and session are
 * tagged on by the tailer, not read from the transcript, so they are not here.
 */
export interface ActivityEvent {
    readonly phase: ActivityPhase;
    /** The tool name for a use (Read, Edit, Bash, ...), null for a result. */
    readonly tool: string | null;
    /** The file path, command, pattern, or skill a use acted on, when it has one. */
    readonly target: string | null;
    /** Links a result to its use. Present on both when the transcript carries it. */
    readonly toolUseId: string | null;
    /** A result's outcome, 'error' when the transcript marks it so, else 'ok'. Null on a use. */
    readonly status: 'ok' | 'error' | null;
}

/** The input fields a tool's target is read from, in priority order. */
const TARGET_KEYS = ['file_path', 'command', 'pattern', 'skill', 'url', 'query', 'description'] as const;

const MAX_TARGET = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** Reads a tool's target from its input, collapsed to a single line and truncated. */
function targetOf(input: unknown): string | null {
    if (!isRecord(input)) return null;
    for (const key of TARGET_KEYS) {
        const value = input[key];
        if (typeof value === 'string' && value.length > 0) {
            const oneLine = value.replace(/\s+/g, ' ').trim();
            return oneLine.length > MAX_TARGET ? oneLine.slice(0, MAX_TARGET) + '...' : oneLine;
        }
    }
    return null;
}

/** Turns one content block into an event, or null when it is not a tool block. */
function eventForBlock(block: unknown): ActivityEvent | null {
    if (!isRecord(block)) return null;
    if (block.type === 'tool_use') {
        return {
            phase: 'use',
            tool: typeof block.name === 'string' ? block.name : null,
            target: targetOf(block.input),
            toolUseId: typeof block.id === 'string' ? block.id : null,
            status: null
        };
    }
    if (block.type === 'tool_result') {
        return {
            phase: 'result',
            tool: null,
            target: null,
            toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
            status: block.is_error === true ? 'error' : 'ok'
        };
    }
    return null;
}

/**
 * Parses one transcript line into zero or more events. Total: a blank line, a line
 * that is not JSON, a line that is not a message, a message with no content array,
 * and a content array of blocks this does not know all resolve to an empty array.
 * It never throws, whatever the line is.
 */
export function parseTranscriptLine(line: string): ActivityEvent[] {
    const trimmed = line.trim();
    if (trimmed.length === 0) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        // A partial line at the tail, or a line a format change made unreadable.
        // Neither is an error worth crashing a tail over.
        return [];
    }

    if (!isRecord(parsed)) return [];
    const message = parsed.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return [];

    const events: ActivityEvent[] = [];
    for (const block of message.content) {
        const event = eventForBlock(block);
        if (event) events.push(event);
    }
    return events;
}
