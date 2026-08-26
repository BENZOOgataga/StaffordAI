/**
 * Parses an AskUserQuestion tool input into the structured questions the conversation renders and the
 * answer routes against. Claude Code's schema is
 *   { questions: [ { question, header, multiSelect, options: [ { label, description } ] } ] }.
 *
 * Shared by the permission gate (which parses the object the CLI sends with the can_use_tool request)
 * and the live-turn builder (which parses the JSON the stream accumulated), so both derive the exact
 * same choices from the exact same schema. Defensive, since this code does not own the schema: a
 * missing or malformed field is dropped, everything is bounded, and an input that is not this shape
 * returns null so the caller degrades to the plain question text rather than crashing.
 */

import type { AskAnswer, AskOption, AskQuestion } from '../../shared/ipc.ts';

/** The tool a colleague uses to ask the person a multiple-choice question. */
export const ASK_TOOL = 'AskUserQuestion';

const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 12;

export function parseAskQuestions(input: unknown): AskQuestion[] | null {
    if (!isRecord(input) || !Array.isArray(input.questions)) return null;
    const out: AskQuestion[] = [];
    for (const raw of input.questions.slice(0, MAX_QUESTIONS)) {
        if (!isRecord(raw)) continue;
        const question = typeof raw.question === 'string' ? raw.question.trim() : '';
        if (question === '') continue;
        const header = typeof raw.header === 'string' && raw.header.trim() !== '' ? raw.header.trim() : question;
        const multiSelect = raw.multiSelect === true;
        const options: AskOption[] = [];
        if (Array.isArray(raw.options)) {
            for (const o of raw.options.slice(0, MAX_OPTIONS)) {
                if (!isRecord(o)) continue;
                const label = typeof o.label === 'string' ? o.label.trim() : '';
                if (label === '') continue;
                const description = typeof o.description === 'string' ? o.description.trim() : '';
                options.push({ label: cap(label, 200), description: cap(description, 300) });
            }
        }
        out.push({ question: cap(question, 500), header: cap(header, 60), multiSelect, options });
    }
    return out.length > 0 ? out : null;
}

/** The one-line question summary, joining a multi-question ask, for the collapsed step label. */
export function summariseAsk(questions: readonly AskQuestion[]): string {
    const joined = questions.map((q) => q.question).join('\n');
    return joined.length > 500 ? joined.slice(0, 500) + '...' : joined;
}

/**
 * The person's selected answer from an AskUserQuestion tool_use_result, keyed by question text with an
 * array of chosen labels. Returns null when nothing was answered (an empty `answers`, the "did not
 * answer" case) so an unanswered ask leaves the block without an answer. Values are coerced to a
 * string array and bounded, since this code does not own the shape.
 */
export function parseAskAnswers(toolUseResult: unknown): AskAnswer | null {
    if (!isRecord(toolUseResult) || !isRecord(toolUseResult.answers)) return null;
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(toolUseResult.answers)) {
        if (Array.isArray(value)) {
            const labels = value.filter((v): v is string => typeof v === 'string' && v !== '').map((v) => cap(v, 500));
            if (labels.length > 0) out[key] = labels;
        } else if (typeof value === 'string' && value !== '') {
            out[key] = [cap(value, 500)];
        }
    }
    return Object.keys(out).length > 0 ? out : null;
}

function cap(value: string, n: number): string {
    return value.length > n ? value.slice(0, n) + '...' : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
