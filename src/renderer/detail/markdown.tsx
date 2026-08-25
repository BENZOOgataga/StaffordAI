import * as React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { highlightLine, langForName, type TokenClass } from '../tasks/highlight.ts';

/**
 * Renders a conversation message's text as markdown, in Stafford's own look. It is used for the
 * colleague's replies, both the persisted bubble and the one streaming live, so the same text
 * formats the same way whether it is arriving or settled.
 *
 * Behaviourally it matches the Claude apps: full GFM (headings, bold, italic, strikethrough, inline
 * and fenced code, ordered and nested lists, links, blockquotes, tables, horizontal rules), and it
 * formats progressively as the text streams, because react-markdown re-parses the whole string each
 * render and an unclosed construct (a fence still typing, a half-written link) is simply tolerated
 * until the closing tokens arrive. There is no plain-then-reformat step: the last streamed frame and
 * the completed render are the same parse of the same text.
 *
 * Security: react-markdown builds a React element tree, never dangerouslySetInnerHTML, and rehype-raw
 * is deliberately NOT enabled, so any raw HTML or script in the model's text renders as inert literal
 * characters, not live markup. Links open only through the window's own security handler (external
 * https in the OS browser, everything else denied), reinforced by target/rel here.
 */

const TOKEN_CLASS: Record<TokenClass, string> = {
    '': '',
    keyword: 'text-violet-400',
    string: 'text-amber-400',
    number: 'text-sky-400',
    comment: 'text-muted-foreground italic'
};

/** A fenced code block, highlighted line by line through the same highlighter the diff viewer uses. */
function CodeBlock({ code, lang }: { code: string; lang: string }): React.JSX.Element {
    const language = langForName(lang);
    // Trim only the single trailing newline markdown leaves on a fence, so an intentional blank last
    // line is kept but the block does not render an empty final row.
    const body = code.replace(/\n$/, '');
    const lines = body.split('\n');
    return (
        <pre className="bg-muted/50 border-border my-2 overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed">
            <code className="whitespace-pre">
                {lines.map((line, i) => (
                    <React.Fragment key={i}>
                        {highlightLine(line, language).map((t, j) => (
                            <span key={j} className={TOKEN_CLASS[t.cls]}>{t.text}</span>
                        ))}
                        {i < lines.length - 1 ? '\n' : ''}
                    </React.Fragment>
                ))}
            </code>
        </pre>
    );
}

const COMPONENTS: Components = {
    // react-markdown wraps a fenced block in <pre><code>. The fence renders its own <pre> through
    // CodeBlock, so this drops the default wrapper to avoid a doubled <pre>.
    pre: ({ children }) => <>{children}</>,
    code({ className, children, ...rest }) {
        const match = /language-(\w+)/.exec(className ?? '');
        if (match) return <CodeBlock code={String(children)} lang={match[1] ?? ''} />;
        return (
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]" {...rest}>
                {children}
            </code>
        );
    },
    // Links go through target/_blank so a click reaches the window's setWindowOpenHandler, which
    // opens https externally and denies the rest; will-navigate blocks in-app navigation regardless.
    a: ({ children, href }) => (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow"
            className="text-primary underline underline-offset-2 hover:opacity-80">
            {children}
        </a>
    ),
    p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0 leading-relaxed">{children}</p>,
    h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-base font-semibold first:mt-0">{children}</h1>,
    h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h2>,
    h3: ({ children }) => <h3 className="mt-2.5 mb-1 text-sm font-semibold first:mt-0">{children}</h3>,
    h4: ({ children }) => <h4 className="mt-2 mb-1 text-sm font-medium first:mt-0">{children}</h4>,
    h5: ({ children }) => <h5 className="mt-2 mb-1 text-xs font-semibold first:mt-0">{children}</h5>,
    h6: ({ children }) => <h6 className="text-muted-foreground mt-2 mb-1 text-xs font-semibold first:mt-0">{children}</h6>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => <del className="line-through">{children}</del>,
    ul: ({ children }) => <ul className="my-1.5 list-disc pl-5 first:mt-0 last:mb-0">{children}</ul>,
    ol: ({ children }) => <ol className="my-1.5 list-decimal pl-5 first:mt-0 last:mb-0">{children}</ol>,
    li: ({ children }) => <li className="my-0.5">{children}</li>,
    blockquote: ({ children }) => (
        <blockquote className="border-border text-muted-foreground my-2 border-l-2 pl-3 italic">{children}</blockquote>
    ),
    hr: () => <hr className="border-border my-3" />,
    // A table can be wider than the bubble, so it scrolls inside its own box rather than pushing the
    // layout wide.
    table: ({ children }) => (
        <div className="my-2 overflow-x-auto">
            <table className="w-full border-collapse text-xs">{children}</table>
        </div>
    ),
    th: ({ children }) => <th className="border-border bg-muted/40 border px-2 py-1 text-left font-medium">{children}</th>,
    td: ({ children }) => <td className="border-border border px-2 py-1 align-top">{children}</td>
};

const REMARK_PLUGINS = [remarkGfm];

/** The colleague message text, rendered as Stafford-styled markdown. */
export function Markdown({ text }: { text: string }): React.JSX.Element {
    return (
        <div className="text-sm break-words">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
                {text}
            </ReactMarkdown>
        </div>
    );
}
