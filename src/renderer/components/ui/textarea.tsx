import * as React from 'react';
import { cn } from '@/lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>): React.JSX.Element {
    return (
        <textarea
            data-slot="textarea"
            className={cn(
                // font-sans explicitly: a bare textarea inherits the browser's monospace
                // default rather than the page font, so the composer and the assign box were
                // rendering in a different typeface from everything around them.
                'border-input bg-transparent placeholder:text-muted-foreground flex field-sizing-content min-h-16 w-full rounded-md border px-3 py-2 font-sans text-base shadow-xs outline-none transition-[color,box-shadow] md:text-sm',
                'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
                'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
                'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
                className
            )}
            {...props}
        />
    );
}

export { Textarea };
