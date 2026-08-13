/**
 * The terminal sizing decision, kept out of the DOM so the zero-size first-mount
 * trap and the fit-on-open behaviour are tested without a browser.
 *
 * A terminal fits its container by measuring it, then tells the pty the column
 * and row count so the program inside lays out for the right width. On first mount
 * the container often has no real layout for a frame, and fitting to a zero-sized
 * container measures nothing and hands the pty a bogus size, which garbles the
 * paint rather than fixing it. That is why a real window resize snaps it clean: it
 * is a real layout event with real dimensions.
 *
 * So the fit is gated on the container having a real size, and only then is the
 * resulting size propagated to the pty. A ResizeObserver drives this on the first
 * real layout and on every later resize through one path.
 */

export interface PaneSize {
    readonly clientWidth: number;
    readonly clientHeight: number;
}

/** The terminal surface this needs: fit to the container, then read the result. */
export interface Fitter {
    fit(): void;
    readonly cols: number;
    readonly rows: number;
}

/** True iff the container has a real, non-zero size to measure. */
export function hasRealSize(pane: PaneSize): boolean {
    return pane.clientWidth > 0 && pane.clientHeight > 0;
}

/**
 * Fits the terminal to its container and propagates the size to the pty, but only
 * once the container has a real size. Returns whether it fit and propagated, so a
 * zero-sized first mount is a no-op the next real-layout call completes, and the
 * pty never receives a garbage dimension.
 */
export function fitToContainer(
    pane: PaneSize,
    fitter: Fitter,
    propagate: (cols: number, rows: number) => void
): boolean {
    if (!hasRealSize(pane)) return false;
    fitter.fit();
    if (fitter.cols <= 0 || fitter.rows <= 0) return false;
    propagate(fitter.cols, fitter.rows);
    return true;
}
