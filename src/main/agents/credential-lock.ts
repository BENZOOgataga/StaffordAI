/**
 * Copies a secret-bearing file (the Claude credential) into the managed config dir and
 * guarantees it is locked to the owner, or leaves nothing behind.
 *
 * Why this is its own function: on Windows the owner-only ACL is the whole protection for
 * the copied credential (node's chmod only toggles the read-only bit there, so the real
 * lock is an icacls grant). If that lock cannot be applied, the earlier behavior left the
 * token on disk behind only the inherited userData ACL and let the seed proceed as if it
 * had succeeded. That is a fail-open: a colleague could start against an unprotected
 * credential. This makes it fail closed instead. If the lock does not take, the just-copied
 * file is deleted and the copy throws, so the seed aborts and no unprotected credential is
 * ever left on disk.
 *
 * The io seam keeps it testable without a real filesystem or a real icacls: a test supplies
 * a lock that returns false and asserts the file was removed and the copy threw.
 */
export interface CredentialLockIo {
    /** Copies bytes from `from` to `to`. */
    copy(from: string, to: string): void;
    /** Sets `to` to the owner-only file mode. May be a no-op where the OS ignores it. */
    chmod(to: string, mode: number): void;
    /** Locks `to` to the owner. Returns true on success, false when the lock could not be applied. */
    lock(to: string): boolean;
    /** Deletes `to`. Must not throw if the file is already gone. */
    remove(to: string): void;
}

/** Thrown when the credential could not be locked to the owner. Carries no secret. */
export class CredentialLockError extends Error {
    constructor() {
        super(
            'could not lock the copied credential to the owner, so the seed was aborted and the ' +
            'file was deleted rather than left on disk unprotected'
        );
        this.name = 'CredentialLockError';
    }
}

export function copyCredentialOwnerLocked(io: CredentialLockIo, from: string, to: string, mode: number): void {
    io.copy(from, to);
    // Belt and braces on POSIX, where chmod to 0600 is the guarantee. On Windows this is a
    // no-op and the lock below is what matters.
    try { io.chmod(to, mode); } catch { /* mode is best-effort; the lock is the real check */ }
    if (!io.lock(to)) {
        io.remove(to);
        throw new CredentialLockError();
    }
}
