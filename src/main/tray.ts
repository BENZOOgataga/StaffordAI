/**
 * The tray, which is where Stafford lives. No window at launch.
 *
 * A tray-resident app is the shape from the start, not a windowed app with a
 * tray bolted on: the process boots to an icon in the menu bar, and a window is
 * opened on demand from the tray menu. Closing the window returns to the tray
 * rather than quitting.
 *
 * The tray also carries the "something needs you" signal, so a colleague waiting on
 * a review or a permission approval is visible without the window open. The count is
 * computed by the caller; this file decides how it reads: the tooltip carries the same
 * summary the board header uses, the icon switches to an alert variant, and on macOS the
 * count also shows as the menu-bar title, which is that platform's native badge. Windows
 * has no numeric tray badge, so there the alert icon and the tooltip carry it.
 *
 * The electron surface is injected (the tray factory, the menu builder, the icons), so the
 * presentation logic stays testable without a real Tray.
 */

import type { Tray, Menu as MenuType, NativeImage } from 'electron';

/** The two icon states: the plain mark, and the mark with a badge dot. */
export interface TrayIcons {
    readonly base: NativeImage;
    readonly alert: NativeImage;
}

export interface TrayDeps {
    /** Builds a Tray with the app icon. */
    readonly createTray: () => Tray;
    /** Builds the context menu from a template. */
    readonly buildMenu: (template: TrayMenuItem[]) => MenuType;
    /** Opens the on-demand window, or focuses it if already open. The menu's action. */
    readonly openWindow: () => void;
    /** Begins the quit sequence. */
    readonly quit: () => void;
    /** The plain and alert icons, built by the caller (which owns the electron surface). */
    readonly icons: TrayIcons;
    /** True on macOS, where the count shows as the tray title (a native menu-bar badge). */
    readonly isMac: boolean;
    /**
     * The icon click. The caller decides where it goes: to the board when something needs
     * attention, or the normal open otherwise. Kept out of here because only the caller knows
     * the live count.
     */
    readonly onIconClick: () => void;
}

export interface TrayMenuItem {
    readonly label?: string;
    readonly click?: () => void;
    readonly type?: 'separator';
}

/** What the tray should show for a given count. Pure, so it is asserted without a Tray. */
export interface TrayPresentation {
    /** True when anything needs the person, so the alert icon and the count show. */
    readonly attention: boolean;
    readonly count: number;
    readonly tooltip: string;
}

/**
 * The waiting summary, worded exactly as the board header words it, so the tray and the board
 * never disagree. English only: the tray is a main-process surface with no renderer locale.
 */
export function waitingSummary(review: number, paused: number): string {
    const parts: string[] = [];
    if (review > 0) parts.push(review === 1 ? '1 waiting for review' : String(review) + ' waiting for review');
    if (paused > 0) parts.push(paused === 1 ? '1 paused for approval' : String(paused) + ' paused for approval');
    return parts.join(', ');
}

/**
 * Turns the two counts into what the tray shows. `review` is tasks waiting for a decision,
 * `paused` is turns stopped on a permission ask. Nothing waiting reverts to the idle tooltip.
 */
export function trayPresentation(review: number, paused: number): TrayPresentation {
    const count = Math.max(0, review) + Math.max(0, paused);
    if (count === 0) return { attention: false, count: 0, tooltip: 'Stafford' };
    return { attention: true, count, tooltip: waitingSummary(review, paused) };
}

/**
 * The menu template. Data, so a test can assert the labels and that the actions
 * point where they should without constructing a real Menu.
 */
export function trayMenuTemplate(deps: Pick<TrayDeps, 'openWindow' | 'quit'>): TrayMenuItem[] {
    return [
        { label: 'Open Stafford', click: deps.openWindow },
        { type: 'separator' },
        { label: 'Quit', click: deps.quit }
    ];
}

/** A live tray: the Tray itself, and an update that re-applies the count-driven presentation. */
export interface TrayHandle {
    readonly tray: Tray;
    /** Re-reads the presentation for the given counts and applies it to the tray. */
    update(review: number, paused: number): void;
}

/** Wires the tray up. Returns a handle whose update reflects the needs-you count. */
export function installTray(deps: TrayDeps): TrayHandle {
    const tray = deps.createTray();
    tray.setContextMenu(deps.buildMenu(trayMenuTemplate(deps)));
    // Clicking the icon opens the window; the caller routes it to the board when needed.
    tray.on('click', () => deps.onIconClick());

    const update = (review: number, paused: number): void => {
        const p = trayPresentation(review, paused);
        tray.setToolTip(p.tooltip);
        tray.setImage(p.attention ? deps.icons.alert : deps.icons.base);
        // macOS shows the number beside the menu-bar icon; that is the native badge there.
        // Windows has no numeric tray badge, so the alert icon and the tooltip carry it.
        if (deps.isMac) tray.setTitle(p.count > 0 ? String(p.count) : '');
    };
    update(0, 0);
    return { tray, update };
}
