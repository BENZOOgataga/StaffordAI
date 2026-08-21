import { useEffect, useState } from 'react';
import type { SavedCheckpoints } from '../../shared/ipc.ts';

/**
 * Reads the saved-work notice the last drain produced, once on mount. When there is
 * work to report it returns the data; dismissing acknowledges the drain so the same
 * notice does not return next launch. Read only over window.stafford; the drain and the
 * checkpoint logic are untouched, this only surfaces their result.
 */
export function useSavedWork(): { data: SavedCheckpoints | null; dismiss: () => void } {
    const [data, setData] = useState<SavedCheckpoints | null>(null);

    useEffect(() => {
        let active = true;
        void window.stafford.checkpoints.saved().then((saved) => {
            if (active && saved && saved.saves.length > 0) setData(saved);
        });
        return () => { active = false; };
    }, []);

    const dismiss = (): void => {
        setData((prev) => {
            if (prev) void window.stafford.checkpoints.ack(prev.drainId);
            return null;
        });
    };

    return { data, dismiss };
}
