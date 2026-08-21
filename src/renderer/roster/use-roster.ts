import { useSyncExternalStore } from 'react';
import { rosterStore, type RosterState } from './roster-store.ts';

/**
 * Subscribes the React roster to the live store. useSyncExternalStore is the React 19
 * way to read an external, always-running source: the store owns the alert rules and
 * the subscription, and the hook just reflects its snapshot into a render.
 */
export function useRoster(): RosterState {
    return useSyncExternalStore(rosterStore.subscribe, rosterStore.getSnapshot);
}
