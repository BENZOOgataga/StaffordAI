import * as React from 'react';
import { computeOverview, type Overview } from './dashboard-data.ts';
import type { StaffordApi } from '../../preload/index.ts';

declare global {
    interface Window {
        readonly stafford: StaffordApi;
    }
}

/**
 * The dashboard's data, read through the existing typed bridge. It fetches the real
 * roster snapshot and the real project count, reduces them with computeOverview, and
 * re-reads on the same roster:changed signal the vanilla roster already uses, so the
 * dashboard stays live without a new data path. Null while the first read is in flight.
 */
export function useDashboardData(): Overview | null {
    const [overview, setOverview] = React.useState<Overview | null>(null);

    React.useEffect(() => {
        let alive = true;
        const load = async (): Promise<void> => {
            const [snapshot, projects] = await Promise.all([
                window.stafford.roster.snapshot(),
                window.stafford.projects.list()
            ]);
            if (alive) setOverview(computeOverview(snapshot.cards, projects.projects.length));
        };
        void load();
        const off = window.stafford.roster.onChanged(() => { void load(); });
        return () => {
            alive = false;
            off();
        };
    }, []);

    return overview;
}
