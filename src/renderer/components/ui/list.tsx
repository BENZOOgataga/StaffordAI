import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';

/**
 * A dense list and its rows, the Dokploy list-row pattern for Stafford's colleagues,
 * projects, and activity. The row flexes so a longer translated label grows rather than
 * being clipped, and `asChild` lets a caller make the whole row a link or button.
 */
function List({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
    return (
        <div
            data-slot="list"
            role="list"
            className={cn('divide-border divide-y overflow-hidden rounded-lg border', className)}
            {...props}
        />
    );
}

function ListRow({
    className,
    asChild = false,
    ...props
}: React.ComponentProps<'div'> & { asChild?: boolean }): React.JSX.Element {
    const Comp = asChild ? Slot : 'div';
    return (
        <Comp
            data-slot="list-row"
            role="listitem"
            className={cn(
                'flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-accent/50 data-[active=true]:bg-accent',
                className
            )}
            {...props}
        />
    );
}

export { List, ListRow };
