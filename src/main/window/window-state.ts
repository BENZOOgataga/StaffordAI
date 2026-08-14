/**
 * Where the window opens, and remembering where the user put it.
 *
 * First launch has no saved state, so the window is sized to a fraction of the
 * current display's work area, clamped to a sensible min and max, and centered. A
 * tray app should not fill a 2K or larger display, and it should never open under
 * the taskbar, so the work area (screen minus taskbar and dock) is what it sizes
 * against, never the raw screen.
 *
 * After that the user's size and position are remembered. On restore the saved
 * bounds are not trusted: they are clamped to the current work area, so a window
 * saved on a bigger or a second monitor that is now gone cannot open off-screen or
 * larger than the current screen, and a position off every display re-centers.
 *
 * The geometry is a pure function, tested without electron. The read and write
 * take an injected filesystem, so the persistence is tested without touching a
 * real file.
 */

export interface Rect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface Size {
    readonly width: number;
    readonly height: number;
}

export interface BoundsOptions {
    /** Fraction of the work area to fill on first launch. */
    readonly fraction: number;
    /** The floor, so the window is never unusably small. */
    readonly min: Size;
    /** The cap, so it never becomes enormous on a very large or ultrawide display. */
    readonly max: Size;
}

/** First launch fills 75% of the work area, floored at 720x520, capped at 1600x1100. */
export const WINDOW_DEFAULTS: BoundsOptions = {
    fraction: 0.75,
    min: { width: 720, height: 520 },
    max: { width: 1600, height: 1100 }
};

function clampValue(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(high, value));
}

/**
 * Clamps a dimension to [min, max], capping last. When the display is smaller than
 * the minimum, the max (already reduced to the work area) wins over the floor, so
 * the window is never wider than the screen, only as small as the screen forces.
 */
function clampSize(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function centered(workArea: Rect, width: number, height: number): Rect {
    return {
        x: Math.round(workArea.x + (workArea.width - width) / 2),
        y: Math.round(workArea.y + (workArea.height - height) / 2),
        width,
        height
    };
}

/**
 * The bounds to open at, given the target display's work area and the saved bounds
 * (or null for a first launch). The result is always fully inside the work area.
 */
export function resolveWindowBounds(workArea: Rect, saved: Rect | null, opts: BoundsOptions): Rect {
    // Never wider or taller than the work area, whatever the max says.
    const maxWidth = Math.min(opts.max.width, workArea.width);
    const maxHeight = Math.min(opts.max.height, workArea.height);

    if (!saved) {
        const width = clampSize(Math.round(workArea.width * opts.fraction), opts.min.width, maxWidth);
        const height = clampSize(Math.round(workArea.height * opts.fraction), opts.min.height, maxHeight);
        return centered(workArea, width, height);
    }

    const width = clampSize(saved.width, opts.min.width, maxWidth);
    const height = clampSize(saved.height, opts.min.height, maxHeight);

    // If the saved window's centre is off this work area, re-centre rather than
    // drag it to a corner: the display it lived on is gone.
    const centreX = saved.x + saved.width / 2;
    const centreY = saved.y + saved.height / 2;
    const onWorkArea =
        centreX >= workArea.x && centreX <= workArea.x + workArea.width &&
        centreY >= workArea.y && centreY <= workArea.y + workArea.height;
    if (!onWorkArea) return centered(workArea, width, height);

    // Otherwise keep the position, nudged so the whole window stays visible. The
    // upper bound is guarded with max() so a window wider than the work area aligns
    // to the corner rather than inverting the range.
    const x = clampValue(saved.x, workArea.x, Math.max(workArea.x, workArea.x + workArea.width - width));
    const y = clampValue(saved.y, workArea.y, Math.max(workArea.y, workArea.y + workArea.height - height));
    return { x, y, width, height };
}

/** True iff the value is a finite number, so a corrupt saved field is rejected. */
function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** Reads the saved bounds, or null if absent or malformed. Never throws. */
export function readWindowState(read: (path: string) => string, path: string): Rect | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(read(path));
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { x, y, width, height } = parsed as Record<string, unknown>;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null;
    if (width <= 0 || height <= 0) return null;
    return { x, y, width, height };
}

/** Writes the bounds. The caller injects the write so a test touches no real file. */
export function saveWindowState(write: (path: string, data: string) => void, path: string, rect: Rect): void {
    write(path, JSON.stringify({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }));
}
