/**
 * The Activity feed's DOM: a colleague's state transitions and tool actions as one
 * ordered stream of clean rows, each a small line icon, a plain phrase, and a
 * de-emphasized time. The pure decisions (which icon, which phrase, the status tag,
 * the class, the order) live in activity-view.ts; this file turns a FeedRow into an
 * element.
 *
 * It appends rather than rebuilds: setInitial paints the merged history once, and
 * apply adds only the rows it has not shown yet, so a live action grows the feed by a
 * row instead of redrawing it. The caller merges and coalesces before calling either.
 */

import { eventLabel, type Lang } from './channel-view.ts';
import {
    activityTime, feedIcon, feedRowClass, toolPhrase, toolStatusLabel, unseenFeed,
    type FeedIcon, type FeedRow
} from './activity-view.ts';

const SVG = 'http://www.w3.org/2000/svg';

/** The line-icon path(s) per type, Lucide-plain: a single stroke weight, no fill. */
const ICON_PATHS: Record<FeedIcon, readonly string[]> = {
    // State icons.
    waiting: ['M6 8a4 4 0 0 1 8 0c0 4 1.5 5 1.5 5h-11S6 12 6 8', 'M8.5 15.5a1.5 1.5 0 0 0 3 0'],
    crashed: ['M10 3 2.5 16h15L10 3Z', 'M10 8v3.5', 'M10 14h.01'],
    needs_trust: ['M5.5 9h9v7h-9z', 'M7.5 9V6.5a2.5 2.5 0 0 1 5 0V9'],
    rate_limited: ['M10 5.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z', 'M10 7.5v3l2 1.5'],
    event: ['M10 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z', 'M10 9.5v.01'],
    // Tool icons.
    // A pencil: a file was edited.
    edit: ['M4 16l1-3 8-8 2 2-8 8-3 1Z', 'M12 5l2 2'],
    // A page with a plus: a file was written.
    wrote: ['M6 3h6l3 3v11H6z', 'M12 3v3h3', 'M10 10v4', 'M8 12h4'],
    // A chevron in a box: a command was run.
    command: ['M4 5h12v10H4z', 'M6.5 8.5 9 11l-2.5 2.5', 'M11 13h3'],
    // A page: a file was read.
    read: ['M6 3h6l3 3v11H6z', 'M12 3v3h3', 'M8 10h5', 'M8 13h5'],
    // A magnifier: a search.
    search: ['M9 4a5 5 0 1 0 0 10A5 5 0 0 0 9 4Z', 'M13 13l3 3'],
    // A branch: a subagent was dispatched.
    task: ['M6 4v8', 'M6 12a2 2 0 1 0 0 .01Z', 'M14 8a2 2 0 1 0 0 .01Z', 'M6 8h4a4 4 0 0 1 4 0'],
    // A dot in a ring: a generic tool.
    tool: ['M10 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z', 'M10 9.5v.01']
};

function icon(kind: FeedIcon): SVGElement {
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
            ? "Rien pour l'instant. Ce que fait ce collègue apparaîtra ici."
            : 'Nothing yet. What this colleague does will show up here.';
        host.replaceChildren(this.#list, this.#empty);
    }

    /** Paints the merged history once, replacing whatever was there. */
    setInitial(rows: readonly FeedRow[]): void {
        this.#seen.clear();
        this.#list.replaceChildren();
        for (const row of rows) this.#add(row, false);
        this.#reflectEmpty();
    }

    /** Appends only rows not shown yet. animate marks new arrivals for the entrance. */
    apply(rows: readonly FeedRow[]): void {
        const fresh = unseenFeed(this.#seen, rows);
        if (fresh.length === 0) return;
        for (const row of fresh) this.#add(row, true);
        this.#reflectEmpty();
    }

    #add(row: FeedRow, animate: boolean): void {
        this.#seen.add(row.id);
        this.#list.appendChild(this.#rowElement(row, animate));
        this.#list.scrollTop = this.#list.scrollHeight;
    }

    #rowElement(row: FeedRow, animate: boolean): HTMLElement {
        const el = document.createElement('div');
        el.className = feedRowClass(row) + (animate ? ' enter' : '');

        const mark = document.createElement('span');
        mark.className = 'act-icon';
        mark.appendChild(icon(feedIcon(row)));

        const line = document.createElement('span');
        line.className = 'act-line';
        line.textContent = row.kind === 'state'
            ? eventLabel(row.state, this.#deps.nameOf(row.senderId), this.#deps.lang)
            : toolPhrase(row.tool, row.target, this.#deps.lang);

        el.append(mark, line);

        // A tool row shows a small status tag only for a failure or an interruption;
        // an ok action stays quiet, and the tag is grayscale, never the amber accent.
        if (row.kind === 'tool') {
            const tag = toolStatusLabel(row.status, this.#deps.lang);
            if (tag) {
                const badge = document.createElement('span');
                badge.className = 'act-status';
                badge.textContent = tag;
                el.appendChild(badge);
            }
        }

        const time = document.createElement('time');
        time.className = 'act-time';
        time.dateTime = row.at;
        time.textContent = activityTime(row.at, this.#deps.now(), this.#deps.lang);
        el.appendChild(time);

        return el;
    }

    #reflectEmpty(): void {
        this.#empty.hidden = this.#seen.size > 0;
        this.#list.hidden = this.#seen.size === 0;
    }
}
