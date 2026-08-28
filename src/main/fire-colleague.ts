/**
 * The fire action, as an injectable service so the integration logic is tested without the main
 * process. Firing is archive: it sets firedAt and clears the resume map while the conversation, tasks,
 * and activity stay in the store. The order is load-bearing. The fireable guard and the actor gate run
 * first, then the process is torn down, and only then is the archive mark written. If the teardown
 * throws, the fire aborts and firedAt is never written, so a fired colleague can never be left carrying
 * a live process, the worst state this feature could produce.
 */

import type { HiredAgent } from '../domain/models.ts';
import type { FireReply } from '../shared/ipc.ts';
import { checkFireable } from '../domain/fireable.ts';

export type FireActor = 'owner' | 'colleague';

export interface FireDeps {
    readonly getHire: (id: string) => HiredAgent | null;
    readonly updateHire: (hire: HiredAgent) => void;
    /** The states of this colleague's non-terminal tasks. */
    readonly openTaskStates: (hireId: string) => readonly string[];
    /** Whether this colleague has a permission ask waiting. */
    readonly hasPendingAsk: (hireId: string) => boolean;
    /** Kills the in-flight process through the tree reaper. May throw; a throw aborts the fire. */
    readonly disposeRunner: (hireId: string) => void;
    /** Denies this colleague's pending ask and no one else's. */
    readonly denyAsk: (hireId: string, reason: string) => void;
    readonly now: () => string;
    /** Surfaces a teardown failure. */
    readonly log: (message: string) => void;
}

function refuse(reason: string, reasonFr: string): FireReply {
    return { ok: false, refused: reason, refusedFr: reasonFr };
}

const OK: FireReply = { ok: true, refused: null, refusedFr: null };

export function fireColleague(deps: FireDeps, actor: FireActor, hireId: string): FireReply {
    // Human only, the same actor check task review uses. The IPC is renderer-to-main and a colleague has
    // no channel to reach it, so in practice the actor is always the owner; the explicit gate makes a
    // colleague actor refused here as well.
    if (actor !== 'owner') {
        return refuse('Only you can remove a colleague.', 'Vous seul pouvez retirer un collègue.');
    }

    const hire = deps.getHire(hireId);
    if (!hire) {
        return refuse('No such colleague.', "Ce collègue n'existe pas.");
    }
    // Already archived: idempotent success, so a double click or a stale card cannot error.
    if (hire.firedAt !== null) return OK;

    // The one authoritative fireable check, over live state: the roster state, the colleague's own
    // non-terminal tasks, and whether it has a pending ask. The UI reads the same guard for its message,
    // but enforcement is here, on the only path that sets firedAt, so it cannot be bypassed.
    const check = checkFireable({
        state: hire.state,
        taskStates: deps.openTaskStates(hireId),
        hasPendingAsk: deps.hasPendingAsk(hireId)
    });
    if (!check.fireable) return refuse(check.reason, check.reasonFr);

    // Teardown before the mark. If dispose throws, the fire aborts: firedAt is not written, the
    // colleague stays exactly as it was, and the person retries. This is how a fired hire is never
    // left with a live process.
    try {
        deps.disposeRunner(hireId);
    } catch (error) {
        deps.log('[fire] dispose failed for ' + hireId + ': ' +
            (error instanceof Error ? error.message : String(error)));
        return refuse(
            "Could not stop the colleague's session. Nothing was changed; try again.",
            "Impossible d'arrêter la session du collègue. Rien n'a changé ; réessayez."
        );
    }

    // The process is down. Deny this colleague's pending ask, so a paused turn is not left awaiting a
    // promise; a lingering promise behind a dead process is benign, so this is best-effort. Then write
    // the archive mark and clear the resume map, so nothing can resume into it.
    deps.denyAsk(hireId, 'This colleague was removed.');
    deps.updateHire({ ...hire, firedAt: deps.now(), sessions: {} });
    return OK;
}
