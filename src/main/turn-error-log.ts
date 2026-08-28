/**
 * The one-line log for a turn completion-path failure, kept pure so it is tested without the main
 * process. The failures that reach here are almost always a SqliteError from a write, and what tells
 * one cause from another is the error's code (SQLITE_BUSY, SQLITE_IOERR, and the rest) and its name,
 * not the stack. The old line logged only the stack, so every cause collapsed into one opaque message
 * and the transient could never be pinned. This records the code, the name, and whether the store was
 * open at the failure, so the next occurrence names itself.
 */

/** Whether the database was open at the moment of the failure. */
export type DbState = 'open' | 'closed' | 'no-store';

/**
 * Builds the log line. `error` is whatever was thrown; a SqliteError carries `code` and `name`, a
 * plain Error carries a stack, and anything else is stringified. The line always leads with the code,
 * name, and db state so a reader can distinguish causes at a glance, then carries the detail.
 */
export function formatTurnErrorLine(stage: string, hireId: string, error: unknown, dbState: DbState): string {
    const e = error as { code?: unknown; name?: unknown };
    const code = typeof e.code === 'string' && e.code !== '' ? e.code : 'none';
    const name = typeof e.name === 'string' && e.name !== '' ? e.name : 'none';
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return '[turn] ' + stage + ' failed for ' + hireId +
        ' (code=' + code + ' name=' + name + ' db=' + dbState + '): ' + detail;
}
