import * as React from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The custom frameless title bar for Windows and Linux: a thin, quiet bar in the app
 * tokens, the wordmark on the left, a draggable region across it, and the window controls
 * on the right. The whole bar is a drag region (WebkitAppRegion via the app-drag class);
 * the buttons opt out (app-no-drag) so they click rather than drag. Close routes through
 * the window's own close, which the app hides to the tray, so it never quits or skips the
 * drain. macOS keeps its native frame and never mounts this.
 */

function ControlButton({ label, onClick, danger = false, children }: {
    label: string;
    onClick: () => void;
    danger?: boolean;
    children: React.ReactNode;
}): React.JSX.Element {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            onClick={onClick}
            className={cn(
                'app-no-drag flex h-full w-12 items-center justify-center transition-colors [&_svg]:size-4',
                'text-muted-foreground hover:text-foreground',
                danger ? 'hover:bg-destructive hover:text-white' : 'hover:bg-accent'
            )}
        >
            {children}
        </button>
    );
}

export function TitleBar(): React.JSX.Element {
    const [maximized, setMaximized] = React.useState(false);

    React.useEffect(() => {
        void window.stafford.win.isMaximized().then(setMaximized);
        return window.stafford.win.onMaximizeChange(setMaximized);
    }, []);

    const toggle = (): void => { void window.stafford.win.toggleMaximize().then(setMaximized); };

    return (
        <div className="dashboard-scope app-drag bg-card border-border text-foreground flex h-8 w-full items-center justify-between border-b select-none">
            <div className="flex items-center gap-2 px-3">
                <span className="text-xs font-semibold tracking-tight">Stafford</span>
            </div>
            <div className="flex h-full items-stretch">
                <ControlButton label="Minimize" onClick={() => { void window.stafford.win.minimize(); }}>
                    <Minus />
                </ControlButton>
                <ControlButton label={maximized ? 'Restore' : 'Maximize'} onClick={toggle}>
                    {maximized ? <Copy /> : <Square />}
                </ControlButton>
                <ControlButton label="Close" danger onClick={() => { void window.stafford.win.close(); }}>
                    <X />
                </ControlButton>
            </div>
        </div>
    );
}
