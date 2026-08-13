/**
 * Neutralises a person's typed message before it reaches a live agent's stdin.
 *
 * The v1 input is a message box: a person typing text to a colleague. Text is what
 * it carries, so a stray Ctrl-C, a bare escape, or any other control byte must not
 * reach the session and interrupt it or drive it. This keeps printable content and
 * the intended newline, and strips every C0 control except that newline, plus DEL.
 *
 * The seam for a raw keystroke passthrough is deliberate: a later opt-in mode where
 * the person enters a raw terminal and keystrokes go straight through would bypass
 * this function on that path only. Until then every message goes through here.
 */

/**
 * Keeps printable text and `\n`, strips the rest of C0 and DEL. Line endings
 * normalise to `\n` first, so a pasted CRLF becomes content rather than a carriage
 * return that could submit the message early.
 */
export function sanitiseMessage(text: string): string {
    const normalised = text.replace(/\r\n?/g, '\n');
    let out = '';
    for (const ch of normalised) {
        const code = ch.codePointAt(0) as number;
        if (code === 0x0a) { out += ch; continue; }       // the intended newline
        if (code <= 0x1f || code === 0x7f) continue;       // other C0 controls and DEL
        out += ch;
    }
    return out;
}
