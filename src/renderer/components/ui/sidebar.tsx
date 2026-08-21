import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';

/**
 * The left nav rail, Dokploy's key layout pattern, for Stafford's own sections. The
 * rail is a fixed-width container but the item labels flex, so a longer translation
 * grows the label rather than being sized to English. `asChild` lets an item become a
 * link; `active` marks the current section.
 */
function Sidebar({ className, ...props }: React.ComponentProps<'nav'>): React.JSX.Element {
    return (
        <nav
            data-slot="sidebar"
            className={cn('bg-card text-card-foreground flex h-full w-56 flex-col gap-1 rounded-xl border p-3', className)}
            {...props}
        />
    );
}

function SidebarSection({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
    return (
        <div
            data-slot="sidebar-section"
            className={cn('text-muted-foreground px-3 pt-3 pb-1 text-xs font-medium', className)}
            {...props}
        />
    );
}

function SidebarItem({
    className,
    active = false,
    asChild = false,
    ...props
}: React.ComponentProps<'button'> & { active?: boolean; asChild?: boolean }): React.JSX.Element {
    const Comp = asChild ? Slot : 'button';
    return (
        <Comp
            data-slot="sidebar-item"
            data-active={active}
            className={cn(
                'text-muted-foreground flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors outline-none',
                'hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                'data-[active=true]:bg-accent data-[active=true]:text-accent-foreground',
                '[&_svg]:size-4 [&_svg]:shrink-0',
                className
            )}
            {...props}
        />
    );
}

export { Sidebar, SidebarSection, SidebarItem };
