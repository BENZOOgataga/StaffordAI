import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * A colleague-state indicator. Stafford's own primitive, not a shadcn stock one, but
 * built the same way: cva variants over the status theme tokens, so the color is a
 * token edit rather than a hardcoded value. `pulse` adds a soft ping for a working
 * colleague. Presentational only; the caller maps an AgentState to a status.
 */
const statusDotVariants = cva('inline-block rounded-full shrink-0', {
    variants: {
        status: {
            working: 'bg-status-working',
            idle: 'bg-status-idle',
            waiting: 'bg-status-waiting',
            error: 'bg-status-error',
            offline: 'bg-muted-foreground/40'
        },
        size: {
            sm: 'size-2',
            default: 'size-2.5',
            lg: 'size-3'
        }
    },
    defaultVariants: { status: 'idle', size: 'default' }
});

function StatusDot({
    className,
    status,
    size,
    pulse = false,
    ...props
}: React.ComponentProps<'span'> & VariantProps<typeof statusDotVariants> & { pulse?: boolean }): React.JSX.Element {
    return (
        <span data-slot="status-dot" role="status" className={cn('relative inline-flex', className)} {...props}>
            {pulse ? (
                <span aria-hidden="true" className={cn(statusDotVariants({ status, size }), 'absolute inline-flex animate-ping opacity-75')} />
            ) : null}
            <span className={cn(statusDotVariants({ status, size }), 'relative')} />
        </span>
    );
}

export { StatusDot, statusDotVariants };
