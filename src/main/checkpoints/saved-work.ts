/**
 * Turns the committed rows of a drain into the saved-work lines the launch notice
 * shows. A read of what the drain wrote, one line per colleague whose work was saved,
 * the name and the branch it is on. Nothing here reads git or the executor: the rows
 * are the record.
 *
 * Only a committed row with a branch becomes a line, so the person is never told
 * work was saved when it was not. The name is resolved from the row's agent id, which
 * is the hire id (the spawn sets STAFFORD_AGENT_ID to the hire id), so a lookup by
 * that id gives the colleague, falling back to the id when a hire has since been
 * removed.
 */

import type { DrainReportEntry } from '../../domain/models.ts';
import type { SavedWork, SavedCheckpoints } from '../../shared/ipc.ts';

export function buildSavedWork(
    rows: readonly DrainReportEntry[], nameOf: (hireId: string) => string
): SavedWork[] {
    return rows
        .filter((r) => r.committed && r.branch)
        .map((r) => ({ name: nameOf(r.agentId), branch: r.branch as string }));
}

/**
 * The notice to show, or null. The committed rows are one drain's; the notice shows
 * unless that drain is the one the person already dismissed, so the same save does not
 * reappear every launch. Null when there is nothing committed to show.
 */
export function savedNoticeFor(
    rows: readonly DrainReportEntry[], seenDrainId: string | null, nameOf: (hireId: string) => string
): SavedCheckpoints | null {
    if (rows.length === 0) return null;
    const drainId = rows[0]!.drainId;
    if (seenDrainId === drainId) return null;
    const saves = buildSavedWork(rows, nameOf);
    return saves.length > 0 ? { drainId, saves } : null;
}
