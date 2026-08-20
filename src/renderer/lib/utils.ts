import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * The shadcn class merger: clsx resolves conditional class lists, then tailwind-merge
 * de-duplicates conflicting Tailwind utilities so the last one wins. Every primitive
 * routes its className through this so a caller can override any default class.
 */
export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}
