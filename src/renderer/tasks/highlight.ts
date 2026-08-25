/**
 * A small, dependency-free syntax highlighter for the diff viewer. It tokenizes a single line into
 * spans (keyword, string, number, comment, or plain) so the review can colour code without pulling
 * in a highlighting library. Deliberately minimal per the project's minimal-dependency rule: it
 * covers the JavaScript and TypeScript family and JSON, which is what a colleague's changes are
 * almost always in; anything else renders as plain text, which is correct rather than wrong.
 *
 * Line-scoped: it does not track block-comment state across lines, so a `/* *\/` that spans lines is
 * only partly coloured. That is a fair trade for zero dependencies in a review aid.
 */

export type TokenClass = '' | 'keyword' | 'string' | 'number' | 'comment';
export interface Token { readonly text: string; readonly cls: TokenClass; }

/** The language for a path, or null for one that gets no highlighting. */
export function langForPath(path: string): 'ts' | 'json' | null {
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path)) return 'ts';
    if (/\.jsonc?$/i.test(path)) return 'json';
    return null;
}

const KEYWORDS = new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
    'break', 'continue', 'new', 'delete', 'class', 'extends', 'implements', 'interface', 'type', 'enum',
    'import', 'export', 'from', 'as', 'default', 'async', 'await', 'yield', 'try', 'catch', 'finally',
    'throw', 'typeof', 'instanceof', 'in', 'of', 'void', 'null', 'undefined', 'true', 'false', 'this',
    'super', 'public', 'private', 'protected', 'readonly', 'static', 'get', 'set', 'abstract',
    'namespace', 'declare', 'satisfies', 'keyof', 'infer'
]);

/** Tokenizes one line into coloured spans. Plain text (or an unsupported language) is one span. */
export function highlightLine(text: string, lang: 'ts' | 'json' | null): Token[] {
    if (lang === null) return text === '' ? [] : [{ text, cls: '' }];
    const out: Token[] = [];
    const push = (t: string, cls: TokenClass): void => { if (t) out.push({ text: t, cls }); };
    let i = 0;

    while (i < text.length) {
        const rest = text.slice(i);
        let m: RegExpExecArray | null;

        if ((m = /^\/\/.*/.exec(rest))) { push(m[0], 'comment'); i += m[0].length; continue; }
        if (rest[0] === '/' && rest[1] === '*' && (m = /^\/\*.*?(?:\*\/|$)/.exec(rest))) { push(m[0], 'comment'); i += m[0].length; continue; }
        if (rest[0] === '"' && (m = /^"(?:\\.|[^"\\])*"?/.exec(rest))) { push(m[0], 'string'); i += m[0].length; continue; }
        if (rest[0] === "'" && (m = /^'(?:\\.|[^'\\])*'?/.exec(rest))) { push(m[0], 'string'); i += m[0].length; continue; }
        if (rest[0] === '`' && (m = /^`(?:\\.|[^`\\])*`?/.exec(rest))) { push(m[0], 'string'); i += m[0].length; continue; }
        if ((m = /^\d[\d_.a-fA-FxXbBoOeE+-]*/.exec(rest))) { push(m[0], 'number'); i += m[0].length; continue; }
        if ((m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest))) {
            push(m[0], KEYWORDS.has(m[0]) ? 'keyword' : '');
            i += m[0].length;
            continue;
        }
        // A run of punctuation and whitespace, batched so one operator is not many spans.
        if ((m = /^[^A-Za-z0-9_$"'`/]+/.exec(rest))) { push(m[0], ''); i += m[0].length; continue; }
        push(rest.charAt(0), '');
        i += 1;
    }
    return out;
}
