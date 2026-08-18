/**
 * The Activity feed's DOM: a colleague's stored events as clean rows, one small
 * line icon per type, a de-emphasized time, and one amber row for a waiting event.
 * The pure decisions (which rows, which are new, the icon, the time) live in
 * activity-view.ts; this file is the thin shell that turns them into elements.
 *
 * It appends rather than rebuilds: setInitial paints the loaded window once, and
 * apply adds only the rows it has not shown yet, so a live change grows the feed by
 * a row instead of redrawing it. The caller coalesces bursts before calling apply.
 */

import type { ChannelMessageRow } from '../shared/ipc.ts';
import { eventLabel, type Lang } from './channel-view.ts';
import { activityIcon, activityRowClass, activityTime, unseenRows, type ActivityIcon } from './activity-view.ts';

const SVG = 'http://www.w3.org/2000/svg';

/** The line-icon path(s) per type, Lucide-plain: a single stroke weight, no fill. */
const ICON_PATHS: Record<ActivityIcon, readonly string[]> = {
    // A bell: the person is being called.
    waiting: ['M6 8a4 4 0 0 1 8 0c0 4 1.5 5 1.5 5h-11S6 12 6 8', 'M8.5 15.5a1.5 1.5 0 0 0 3 0'],
    // A triangle with a bar: the session stopped abnormally.
    crashed: ['M10 3 2.5 16h15L10 3Z', 'M10 8v3.5', 'M10 14h.01'],
    // A padlock: the folder needs approval.
    needs_trust: ['M5.5 9h9v7h-9z', 'M7.5 9V6.5a2.5 2.5 0 0 1 5 0V9'],
    // A clock: the colleague is throttled.
    rate_limited: ['M10 5.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z', 'M10 7.5v3l2 1.5'],
    // A dot in a ring: a generic state, for anything the map does not name.
    event: ['M10 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z', 'M10 9.5v.01']
};

function icon(kind: ActivityIcon): SVGElement {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICON_PATHS[kind]) {
        const path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    }
    return svg;
}

export interface ActivityDeps {
    readonly nameOf: (senderId: string) => string;
    readonly now: () => number;
    readonly lang: Lang;
}

/** The feed bound to one host element. One instance per open colleague. */
export class ActivityFeed {
    readonly #list: HTMLElement;
    readonly #empty: HTMLElement;
    readonly #deps: ActivityDeps;
    readonly #seen = new Set<string>();

    constructor(host: HTMLElement, deps: ActivityDeps) {
        this.#deps = deps;
        this.#list = document.createElement('div');
        this.#list.className = 'activity-list';
        this.#list.setAttribute('aria-live', 'polite');
        this.#empty = document.createElement('div');
        this.#empty.className = 'activity-empty';
        this.#empty.textContent = deps.lang === 'fr'
            ? "Rien pour l'instant. Les moments qui comptent apparaîtront ici."
            : 'Nothing yet. The moments that matter will show up here.';
        host.replaceChildren(this.#list, this.#empty);
    }

    /** Paints the loaded window once, replacing whatever was there. */
    setInitial(rows: readonly ChannelMessageRow[]): void {
        this.#seen.clear();
        this.#list.replaceChildren();
        for (const row of rows) this.#add(row, false);
        this.#reflectEmpty();
    }

    /** Appends only rows not shown yet. animate marks new arrivals for the entrance. */
    apply(rows: readonly ChannelMessageRow[]): void {
        const fresh = unseenRows(this.#seen, rows);
        if (fresh.length === 0) return;
        for (const row of fresh) this.#add(row, true);
        this.#reflectEmpty();
    }

    #add(row: ChannelMessageRow, animate: boolean): void {
        this.#seen.add(row.id);
        this.#list.appendChild(this.#rowElement(row, animate));
        this.#list.scrollTop = this.#list.scrollHeight;
    }

    #rowElement(row: ChannelMessageRow, animate: boolean): HTMLElement {
        const el = document.createElement('div');
        el.className = activityRowClass(row.body) + (animate ? ' enter' : '');

        const mark = document.createElement('span');
        mark.className = 'act-icon';
        mark.appendChild(icon(activityIcon(row.body)));

        const line = document.createElement('span');
        line.className = 'act-line';
        line.textContent = eventLabel(row.body, this.#deps.nameOf(row.senderId), this.#deps.lang);

        const time = document.createElement('time');
        time.className = 'act-time';
        time.dateTime = row.at;
        time.textContent = activityTime(row.at, this.#deps.now(), this.#deps.lang);

        el.append(mark, line, time);
        return el;
    }

    #reflectEmpty(): void {
        this.#empty.hidden = this.#seen.size > 0;
        this.#list.hidden = this.#seen.size === 0;
    }
}
