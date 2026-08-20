/**
 * ClaudeRunner: drives one Claude Code turn headless over the stream-json control
 * protocol, with no pseudo-terminal.
 *
 * This is phase 2 of docs/plans/HEADLESS-STREAM-JSON.md. It is standalone: nothing
 * in the app wires it yet. It exists to prove that one full turn runs end to end
 * against real Claude through a plain piped child process, which is the model that
 * removes the whole class of TUI-typing bugs (swallowed first message, "hitest"
 * concatenation, the text-then-Enter race, the accept-receipt timing, the readiness
 * marker, the submit retry). A program driving a terminal made for a person is the
 * root cause; speaking the protocol a program is meant to speak removes it.
 *
 * The shape, fixed by the doc:
 *  - Spawn `claude -p --output-format stream-json --input-format stream-json
 *    --verbose --include-partial-messages --replay-user-messages` with piped stdio,
 *    no pty.
 *  - Write an `initialize` control request, then the user message as one JSON line.
 *  - Read JSON lines: `system`/init carries the session id, `assistant` carries text
 *    and tool_use blocks, `stream_event` carries token deltas, `result` is the
 *    explicit turn boundary that replaces every timing heuristic the pty path used.
 *  - Answer `can_use_tool` control requests through the named permission seam.
 *  - One process per turn. Turns 2+ resume with `--resume <session_id>` harvested
 *    from turn 1's init. There is no long-lived process and no warm-session lifecycle.
 *
 * Defensive by construction, since the protocol is version-coupled (the doc's stated
 * risk): a malformed line is ignored, not fatal, and an unknown event type is ignored,
 * not fatal. A protocol change costs parsed richness, never a crash.
 *
 * Bounded by construction: every turn has an overall timeout, and a process that dies
 * without a `result` returns a typed error. The runner never hangs.
 *
 * Tested against Claude Code 2.1.237.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** The fixed headless invocation, minus the binary and any per-turn resume. */
export const HEADLESS_ARGS = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages'
] as const;

/** Overall per-turn cap. No turn waits longer than this for its `result`. */
export const DEFAULT_TURN_TIMEOUT_MS = 120_000;

/**
 * A permission decision for a tool the model wants to run. `allow` may rewrite the
 * input the tool runs with; `deny` carries a reason back to the model.
 */
export type PermissionDecision =
    | { behavior: 'allow'; updatedInput?: unknown }
    | { behavior: 'deny'; message: string };

/**
 * The permission seam. The runner calls this for every `can_use_tool` request with
 * the full tool name and input, so a future policy has what it needs to decide. It is
 * a single named function on purpose: today it returns allow, tomorrow it consults a
 * ProjectPolicy, an allowlist, or a person-facing prompt, without touching the runner.
 */
export type CanUseTool = (toolName: string, input: unknown) => PermissionDecision | Promise<PermissionDecision>;

/**
 * The v1 permission seam: auto-approve. The same default vibe-kanban ships. It is NOT
 * a blanket bypass baked into the spawn; it is a decision made per request at the
 * protocol seam, which is exactly where a real policy will replace it. It echoes the
 * input back unchanged so the tool runs with what the model asked for.
 */
export const autoApproveTool: CanUseTool = (_toolName, input) => ({ behavior: 'allow', updatedInput: input });

/** A tool the model asked to run during the turn. */
export interface ToolUse {
    readonly name: string;
    readonly input: unknown;
    readonly id?: string;
}

/** How a turn ended. `completed` and `interrupted` are the two clean-done outcomes. */
export type TurnStatus = 'completed' | 'interrupted' | 'timeout' | 'exited' | 'spawn-error';

/** The typed result of one turn. Always returned; the runner never throws for a turn. */
export interface TurnResult {
    readonly status: TurnStatus;
    /** The session id from init, to resume the next turn. Null if init never arrived. */
    readonly sessionId: string | null;
    /** The assistant's text for the turn, accumulated from the stream. */
    readonly assistantText: string;
    /** Any tool_use blocks the model emitted, in order. */
    readonly toolUses: readonly ToolUse[];
    /** True for any non-clean outcome, or when the `result` event itself was an error. */
    readonly isError: boolean;
    /** A human-readable note for a non-completed outcome. Never carries message text. */
    readonly detail?: string;
}

/** One user turn's input. `resumeSessionId` is set for turns 2+. */
export interface TurnInput {
    readonly text: string;
    readonly resumeSessionId?: string | null;
}

/** The minimal child-process shape the runner needs, so a test can inject a fake. */
export interface RunnerChild {
    readonly pid?: number;
    readonly stdin: { write(chunk: string): void; end?(): void } | null;
    readonly stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
    readonly stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
    on(event: 'exit', cb: (code: number | null, signal: string | null) => void): unknown;
    on(event: 'error', cb: (err: Error) => void): unknown;
    kill(signal?: NodeJS.Signals | number): boolean;
}

/** The spawn seam. Defaults to node's child_process spawn; a test injects its own. */
export type SpawnFn = (
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stdio: readonly ['pipe', 'pipe', 'pipe'] }
) => RunnerChild;

/** Direction of a raw wire line, for the delivery log. */
export type WireDirection = 'in' | 'out';

/** A parsed stream event, handed to `onEvent` for live rendering. */
export interface ClaudeStreamEvent {
    readonly type: string;
    readonly raw: Record<string, unknown>;
}

export interface ClaudeRunnerDeps {
    /** Absolute path to the claude binary. */
    readonly claudePath: string;
    /** The project working directory the turn runs against. */
    readonly cwd: string;
    /**
     * The child's environment. MUST carry CLAUDE_CONFIG_DIR (and the seeded managed
     * config) for #61 isolation: the headless child reads that config exactly as the
     * pty child did, so the user's plugins and foreign hooks stay off the read path.
     */
    readonly env: NodeJS.ProcessEnv;
    /** The permission seam. Defaults to auto-approve. */
    readonly canUseTool?: CanUseTool;
    /**
     * The raw wire tap. Called for every line in both directions, exactly as sent or
     * received. This is the delivery-log requirement from the doc: no debug view is
     * kept, so the log is the only window on the wire and must carry it verbatim.
     */
    readonly onRawLine?: (line: string, direction: WireDirection) => void;
    /** Parsed events, for a live transcript. Optional. */
    readonly onEvent?: (event: ClaudeStreamEvent) => void;
    /** Overall per-turn timeout. Defaults to DEFAULT_TURN_TIMEOUT_MS. */
    readonly timeoutMs?: number;
    /** The spawn seam. Defaults to node's spawn. */
    readonly spawn?: SpawnFn;
    /** Escape hatch for extra CLI args (for example a model pin). Rarely needed. */
    readonly extraArgs?: readonly string[];
}

/**
 * Drives one turn per instance. Reuse across turns is fine: each `runTurn` spawns a
 * fresh process, and turns 2+ pass `resumeSessionId`. There is no persistent process
 * to keep alive between turns.
 */
export class ClaudeRunner {
    readonly #deps: ClaudeRunnerDeps;
    readonly #spawn: SpawnFn;
    readonly #canUseTool: CanUseTool;
    #child: RunnerChild | null = null;
    #interrupted = false;

    constructor(deps: ClaudeRunnerDeps) {
        this.#deps = deps;
        this.#spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
        this.#canUseTool = deps.canUseTool ?? autoApproveTool;
    }

    /** The spawned child's pid, or null before spawn / after teardown. */
    get pid(): number | null {
        return this.#child?.pid ?? null;
    }

    /**
     * Runs one full turn: spawn, initialize, send the message, read the stream to
     * `result`. Returns a typed result. Never throws and never hangs: a dead process
     * or a stalled stream returns a typed error/timeout instead.
     */
    runTurn(input: TurnInput): Promise<TurnResult> {
        const timeoutMs = this.#deps.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
        this.#interrupted = false;

        const args: string[] = [...HEADLESS_ARGS, ...(this.#deps.extraArgs ?? [])];
        if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);

        let child: RunnerChild;
        try {
            child = this.#spawn(this.#deps.claudePath, args, {
                cwd: this.#deps.cwd,
                env: this.#deps.env,
                stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch (err) {
            return Promise.resolve(this.#errorResult('spawn-error', 'the claude process could not be spawned'));
        }
        this.#child = child;

        return new Promise<TurnResult>((resolve) => {
            // Accumulated turn state.
            let sessionId: string | null = null;
            let assistantText = '';
            let resultFallbackText = '';
            const toolUses: ToolUse[] = [];
            let settled = false;
            let stdoutBuffer = '';

            const finish = (result: TurnResult): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.dispose();
                resolve(result);
            };

            const timer = setTimeout(() => {
                finish(this.#errorResult('timeout', `no result within ${timeoutMs}ms`, sessionId, assistantText, toolUses));
            }, timeoutMs);
            // A turn timeout must never itself keep the event loop alive.
            (timer as unknown as { unref?: () => void }).unref?.();

            const completeTurn = (isError: boolean): void => {
                finish({
                    status: this.#interrupted ? 'interrupted' : 'completed',
                    sessionId,
                    assistantText: assistantText || resultFallbackText,
                    toolUses,
                    isError: isError || this.#interrupted,
                    ...(this.#interrupted ? { detail: 'turn ended after an interrupt' } : {})
                });
            };

            const handleLine = (line: string): void => {
                const trimmed = line.trim();
                if (trimmed === '') return;
                this.#deps.onRawLine?.(trimmed, 'in');

                let obj: Record<string, unknown>;
                try {
                    const parsed = JSON.parse(trimmed) as unknown;
                    if (parsed === null || typeof parsed !== 'object') return; // defensive: not an event
                    obj = parsed as Record<string, unknown>;
                } catch {
                    return; // defensive: a malformed line is ignored, not fatal
                }

                const type = typeof obj.type === 'string' ? (obj.type as string) : '';
                this.#deps.onEvent?.({ type, raw: obj });

                switch (type) {
                    case 'system': {
                        if (obj.subtype === 'init' && typeof obj.session_id === 'string') {
                            sessionId = obj.session_id as string;
                        }
                        return;
                    }
                    case 'assistant': {
                        const extracted = extractAssistant(obj.message);
                        assistantText += extracted.text;
                        toolUses.push(...extracted.tools);
                        if (sessionId === null && typeof obj.session_id === 'string') {
                            sessionId = obj.session_id as string;
                        }
                        return;
                    }
                    case 'result': {
                        if (typeof obj.result === 'string') resultFallbackText = obj.result as string;
                        if (sessionId === null && typeof obj.session_id === 'string') {
                            sessionId = obj.session_id as string;
                        }
                        completeTurn(obj.is_error === true);
                        return;
                    }
                    case 'control_request': {
                        void this.#answerControlRequest(obj);
                        return;
                    }
                    // 'stream_event', 'user' (replayed), 'control_response' (init ack),
                    // and any unknown type: nothing to accumulate. Ignored, not fatal.
                    default:
                        return;
                }
            };

            child.stdout?.on('data', (chunk) => {
                stdoutBuffer += chunk.toString();
                let newlineIndex = stdoutBuffer.indexOf('\n');
                while (newlineIndex !== -1) {
                    const line = stdoutBuffer.slice(0, newlineIndex);
                    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
                    handleLine(line);
                    newlineIndex = stdoutBuffer.indexOf('\n');
                }
            });

            // stderr is drained so the pipe never fills and blocks the child, and fed
            // to the raw tap so a diagnostic on stderr is inspectable from the log too.
            child.stderr?.on('data', (chunk) => {
                const text = chunk.toString();
                if (text.trim() !== '') this.#deps.onRawLine?.(text.replace(/\n$/, ''), 'in');
            });

            child.on('error', () => {
                finish(this.#errorResult('spawn-error', 'the claude process errored', sessionId, assistantText, toolUses));
            });

            child.on('exit', () => {
                // An exit before `result` is a dead process, a typed error, not a hang.
                finish(this.#errorResult('exited', 'the process exited before a result', sessionId, assistantText, toolUses));
            });

            // Initialize first (carrying no hooks in phase 2), then the user message,
            // both as single JSON lines on stdin. stdin is ordered, so the CLI reads
            // the handshake before the message.
            this.#writeLine({
                type: 'control_request',
                request_id: randomUUID(),
                request: { subtype: 'initialize', hooks: {} }
            });
            this.#writeLine({
                type: 'user',
                message: { role: 'user', content: input.text }
            });
        });
    }

    /**
     * Interrupts the current turn: writes an `interrupt` control request. The runner
     * keeps reading until the `result` arrives, so the turn still ends cleanly, with
     * status `interrupted`. Safe to call when no turn is running (a no-op).
     */
    interrupt(): void {
        if (!this.#child) return;
        this.#interrupted = true;
        this.#writeLine({
            type: 'control_request',
            request_id: randomUUID(),
            request: { subtype: 'interrupt' }
        });
    }

    /**
     * Tears the child down by its exact pid only. The runner owns the pid it spawned
     * and kills only that. It never kills by image name, so a stray claude/electron/node
     * elsewhere on the machine is never touched. Idempotent.
     */
    dispose(): void {
        const child = this.#child;
        if (!child) return;
        this.#child = null;
        try {
            child.kill();
        } catch {
            // Already gone. Killing a dead pid is not an error worth surfacing.
        }
    }

    /** Answers a control request from the CLI. Only `can_use_tool` needs a decision. */
    async #answerControlRequest(obj: Record<string, unknown>): Promise<void> {
        const request = isObject(obj.request) ? obj.request : {};
        const requestId = typeof obj.request_id === 'string' ? obj.request_id : null;
        if (requestId === null) return;

        if (request.subtype === 'can_use_tool') {
            const toolName = typeof request.tool_name === 'string' ? (request.tool_name as string) : '';
            const input = 'input' in request ? (request as Record<string, unknown>).input : undefined;
            let decision: PermissionDecision;
            try {
                decision = await this.#canUseTool(toolName, input);
            } catch {
                // A seam that throws is treated as a deny, never as a hang.
                decision = { behavior: 'deny', message: 'permission check failed' };
            }
            this.#writeLine({
                type: 'control_response',
                response: { subtype: 'success', request_id: requestId, response: decision }
            });
            return;
        }
        // Any other control request subtype: acknowledge success with no payload, so
        // the CLI is never left waiting on a request this phase does not model.
        this.#writeLine({
            type: 'control_response',
            response: { subtype: 'success', request_id: requestId, response: {} }
        });
    }

    /** Writes one JSON object as a single newline-terminated line on stdin. */
    #writeLine(obj: unknown): void {
        const child = this.#child;
        if (!child?.stdin) return;
        const line = JSON.stringify(obj);
        this.#deps.onRawLine?.(line, 'out');
        try {
            child.stdin.write(line + '\n');
        } catch {
            // A closed stdin means the child is gone; the exit handler settles the turn.
        }
    }

    #errorResult(
        status: TurnStatus,
        detail: string,
        sessionId: string | null = null,
        assistantText = '',
        toolUses: readonly ToolUse[] = []
    ): TurnResult {
        return { status, sessionId, assistantText, toolUses, isError: true, detail };
    }
}

/** Pulls text and tool_use blocks out of an assistant message, both content shapes. */
function extractAssistant(message: unknown): { text: string; tools: ToolUse[] } {
    const out = { text: '', tools: [] as ToolUse[] };
    if (!isObject(message)) return out;
    const content = message.content;
    if (typeof content === 'string') {
        out.text += content;
        return out;
    }
    if (!Array.isArray(content)) return out;
    for (const block of content) {
        if (!isObject(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
            out.text += block.text;
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            out.tools.push({
                name: block.name as string,
                input: 'input' in block ? (block as Record<string, unknown>).input : undefined,
                ...(typeof block.id === 'string' ? { id: block.id as string } : {})
            });
        }
    }
    return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
