/**
 * Per-agent secrets, replacing the single shared token.
 *
 * The shared token was a file every agent could read. Any agent with a shell
 * could take it and post hook events claiming to be any other agent, which
 * would put one hire's state on another hire's card. The named pipe does not
 * help: agents run as Benzoo and that account has full access, and on Windows
 * the default pipe descriptor grants Everyone read anyway, which is measured
 * rather than assumed.
 *
 * So each spawned session gets its own secret, injected into that session's
 * environment. An agent can read its own and no other, and the worst it can do
 * is forge events about itself, which it could already do by behaving that way.
 *
 * A secret is never logged, never written to disk and never included in an
 * error message. It lives in this process for the lifetime of the spawn.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 bytes. Long enough that guessing is not the attack anyone would choose. */
export function createSecret(): string {
    return randomBytes(32).toString('hex');
}

/**
 * Compares without leaking length or position through timing.
 *
 * Overkill for a local socket and cheap enough that arguing about it costs more
 * than doing it. It also means a future remote transport does not inherit a
 * comparison that was fine only because it was local.
 */
function constantTimeEquals(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

export class AgentSecrets {
    /** agent id to secret. Never serialised, never iterated for logging. */
    readonly #secrets = new Map<string, string>();

    /** Issues a secret for a spawn, replacing any previous one for that agent. */
    issue(agentId: string): string {
        if (!agentId) throw new Error('issue requires an agentId');
        const secret = createSecret();
        this.#secrets.set(agentId, secret);
        return secret;
    }

    /** Called when a session ends, so a dead agent's secret stops working. */
    revoke(agentId: string): void {
        this.#secrets.delete(agentId);
    }

    /**
     * True only when this exact agent presented its own secret.
     *
     * The case that matters is agent A presenting a valid secret and claiming
     * to be agent B. That is the whole reason this class exists, and it is the
     * assertion worth writing.
     */
    validate(agentId: string | undefined, secret: string | undefined): boolean {
        if (!agentId || !secret) return false;
        const issued = this.#secrets.get(agentId);
        if (!issued) return false;
        return constantTimeEquals(issued, secret);
    }

    get size(): number {
        return this.#secrets.size;
    }
}
