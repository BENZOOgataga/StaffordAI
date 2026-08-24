/**
 * The first-name pool and the draw.
 *
 * A hire's name is not chosen by the person; it is drawn from a fixed pool
 * (data/first-names.json) without replacement, and every name ever drawn is
 * recorded so none is recycled. The reasons live in data/README.md: task history
 * has to keep one owner per name, so a second Marion later would make an old
 * summary unreadable.
 *
 * The draw is pure and pool-independent: it takes the pool, the set of used names,
 * and an index picker, so the never-recycle logic is tested without a database and
 * the pool can be swapped for another list later without touching it.
 */

import pool from '../../../data/first-names.json' with { type: 'json' };

/** The names as loaded, source-of-truth in data/first-names.json. */
export const NAME_POOL: readonly string[] = pool.names;

/** Thrown when every pooled name has been used. A signal to extend the pool, never to recycle. */
export class NamePoolExhausted extends Error {
    constructor() {
        super('the first-name pool is exhausted; extend data/first-names.json rather than recycling a name');
        this.name = 'NamePoolExhausted';
    }
}

/**
 * Draws one name not in `used`. `pick` returns an index in [0, count) over the
 * still-available names, injected so the draw is deterministic in a test and random
 * in the app. Throws NamePoolExhausted when nothing is left.
 */
export function drawName(
    pool: readonly string[],
    used: ReadonlySet<string>,
    pick: (count: number) => number
): string {
    const available = pool.filter((name) => !used.has(name));
    if (available.length === 0) throw new NamePoolExhausted();
    // Clamp the picker: an out-of-range index falls back to the first available name rather
    // than returning undefined, so a bad picker never yields an empty name. available is
    // non-empty here, so index 0 is always a real name.
    const raw = pick(available.length);
    const index = Number.isInteger(raw) && raw >= 0 && raw < available.length ? raw : 0;
    return available[index] as string;
}
