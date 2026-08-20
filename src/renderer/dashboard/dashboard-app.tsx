import * as React from 'react';
import { DashboardView } from './dashboard-view.tsx';
import { useDashboardData } from './use-dashboard-data.ts';

/**
 * The dashboard, wired: it pulls the live overview from the hook and hands it to the
 * presentational view. onNavigate is the seam back to the vanilla shell, so a rail
 * click switches the shipped view.
 */
export function Dashboard({ onNavigate }: { onNavigate: (view: string) => void }): React.JSX.Element {
    const overview = useDashboardData();
    return <DashboardView overview={overview} current="home" onNavigate={onNavigate} />;
}
