import { useEffect, useState } from 'react';
import type { PendingApproval } from '../../shared/ipc.ts';

/**
 * The permission approvals waiting on the person (phase 2). It reads the pending set and
 * re-reads on the approvals:changed signal, so a new ask or an answered one updates the
 * surface live. Read only over window.stafford; answering goes through approvals.answer.
 */
export function useApprovals(): readonly PendingApproval[] {
    const [pending, setPending] = useState<readonly PendingApproval[]>([]);

    useEffect(() => {
        let active = true;
        const load = (): void => {
            void window.stafford.approvals.pending().then((reply) => { if (active) setPending(reply.pending); });
        };
        load();
        const off = window.stafford.approvals.onChanged(load);
        return () => { active = false; off(); };
    }, []);

    return pending;
}
