import * as React from 'react';
import { LayoutDashboard, Users, ClipboardList, MessageSquare, ShieldCheck } from 'lucide-react';
import { Sidebar, SidebarSection, SidebarItem } from '@/components/ui/sidebar';

/**
 * The single app shell: the inset island frame and the navigation rail, shared by every
 * screen (home, roster, board, detail, channel). Each screen renders its content into it as
 * children, so the rail and the frame have one definition. A nav change happens here,
 * once, not per screen. The data-view attribute mirrors the old vanilla rail so the
 * screenshot harness can drive navigation.
 */

const NAV: ReadonlyArray<{ view: string; label: string; Icon: React.ComponentType<{ className?: string }> }> = [
    { view: 'home', label: 'Home', Icon: LayoutDashboard },
    { view: 'roster', label: 'Roster', Icon: Users },
    // Tasks across every colleague. At the app level rather than inside one colleague,
    // because the question it answers is "is anything waiting on me", and that answer is
    // spread across as many tabs as there are colleagues.
    { view: 'board', label: 'Tasks', Icon: ClipboardList },
    { view: 'channel', label: 'Channel', Icon: MessageSquare },
    // Project baselines. A colleague's own exceptions live on that colleague, in its detail
    // pane, so each rule sits where the thing it governs sits.
    { view: 'permissions', label: 'Permissions', Icon: ShieldCheck }
];

export function AppShell({ current, onNavigate, children }: {
    current: string;
    onNavigate: (view: string) => void;
    children: React.ReactNode;
}): React.JSX.Element {
    return (
        <div className="dashboard-scope flex h-full min-h-0 w-full gap-2 p-2">
            <Sidebar>
                <SidebarSection>Stafford</SidebarSection>
                {NAV.map(({ view, label, Icon }) => (
                    <SidebarItem key={view} data-view={view} active={current === view} onClick={() => onNavigate(view)}>
                        <Icon /> {label}
                    </SidebarItem>
                ))}
            </Sidebar>
            {children}
        </div>
    );
}
