/**
 * The alert logic behind the roster, kept pure so it is tested without a DOM or
 * a sound. It answers two questions the view then acts on: should a sound play
 * this update, and which cards carry an unseen waiting badge.
 *
 * The rules are Benzoo's: sound once on a transition into waiting_for_you, and a
 * badge that persists until the person looks, then clears. Both are about not
 * training the person to ignore the signal. A sound that repeats and a badge that
 * clears on a timer both erode the one alert the roster exists to deliver, so the
 * sound fires only on the transition and the badge clears only on a deliberate
 * look, never on its own.
 *
 * `looks` is defined by the caller as the roster window gaining focus. Focusing
 * the window marks every currently-waiting card as seen. A card that enters
 * waiting after that look gets a fresh badge, because it is a new nudge.
 */

const WAITING = 'waiting_for_you';

export interface AlertCard {
    readonly id: string;
    readonly state: string;
}

export interface AlertUpdate {
    /** True when at least one card newly entered waiting this update. Play once. */
    readonly sound: boolean;
}

export class RosterAlerts {
    /** Hire ids currently in waiting_for_you. */
    #waiting = new Set<string>();
    /** Waiting hire ids the person has not looked at yet: the badged set. */
    #unseen = new Set<string>();

    /**
     * Reconciles the latest cards against what was waiting before. Returns whether
     * to sound. A card newly in waiting is added to the badged set; a card that
     * left waiting drops out of it.
     */
    update(cards: readonly AlertCard[]): AlertUpdate {
        const next = new Set<string>();
        for (const card of cards) {
            if (card.state === WAITING) next.add(card.id);
        }

        let entered = false;
        for (const id of next) {
            if (!this.#waiting.has(id)) {
                entered = true;
                this.#unseen.add(id);
            }
        }

        // A card no longer waiting is no longer a pending nudge.
        for (const id of [...this.#unseen]) {
            if (!next.has(id)) this.#unseen.delete(id);
        }

        this.#waiting = next;
        return { sound: entered };
    }

    /** The person looked: every currently-waiting card is now seen. */
    markSeen(): void {
        this.#unseen.clear();
    }

    /** Whether a card should show the unseen waiting badge. */
    isBadged(id: string): boolean {
        return this.#unseen.has(id);
    }

    /** How many waiting cards are still unseen, for a header count. */
    get unseenCount(): number {
        return this.#unseen.size;
    }
}
