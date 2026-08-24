/**
 * The tray icon assets, embedded as base64 PNGs so they need no separate asset file, no
 * asarUnpack, and no copy step: a nativeImage is built straight from these at startup.
 *
 * A rounded-square card frame, Stafford's inset-island motif at tray size. Two variants:
 * a plain one, and an alert one with a badge dot in the corner for when something needs
 * attention. Two colors, because a tray icon is not themed the same way on each platform:
 * black is used as a macOS template image (the OS inverts it for the light or dark menu
 * bar), and white suits the Windows tray, whose taskbar is dark by default.
 *
 * Generated once by scratchpad/gen-icons.cjs (dependency-free, via zlib). 32x32.
 */

export const TRAY_ICON_PNG = {
    baseBlack: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAVklEQVR42u2XwQ0AMAgC3X9pukLTomILCU/jPYxihCUuENza/BgCCW5tvg2BAl8DZNbTBokOwBzkeQDsXWIAAxjAi2jmLZC4hk+EkhmZUCIVS/wF1h9aGmiGiB3wINYAAAAASUVORK5CYII=',
    alertBlack: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAa0lEQVR42u2XQQ4AIQgD+/9P4wM8aKQFNtsmPSpzAIuANVxBcGvxZ4gQuLX4NUQUOA2gPE9rJDoAs5G/B8B+SwxggH8B1MzuZABqGjIjXZdmFQCnS9N7QTsAJgBgAgASu57sryAfQzWItWkBpnGNgUt80rgAAAAASUVORK5CYII=',
    baseWhite: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAVUlEQVR42u2XwREAIAjD2H/puoKnBYo2f488BEqEUQYEWosfSyCB1uLbEijgWiDzfbA+El2A2UXzBNiDzAIWsIAH0cxdILENnwglMzKhRCqWuAvMNyxglxo70VToCgAAAABJRU5ErkJggg==',
    alertWhite: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbElEQVR42u3XURIAEAhF0fa/6WzADOpWjN4/zgclkc7NUSClh5sRGpDSw7cRmhA3IHK9UBcJB5Cv6D0AXcga0IC/ADlv92YA2g3J/0RcN8sArDZ1/wvKAVYECrAgcMApArmEWQNNWWHrWXOWAbqvNh9KLJZ2AAAAAElFTkSuQmCC'
} as const;
