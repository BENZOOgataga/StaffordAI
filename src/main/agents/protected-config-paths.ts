/**
 * The paths a colleague must never reach: Stafford's own store, and Benzoo's real credential
 * directories on the host.
 *
 * This is one function so the gate, the config display, and the edit warnings all read from the
 * same list. When they drifted apart, the display and the warnings named the full set while the
 * gate enforced only userData, so a colleague could read ~/.ssh/id_rsa and
 * ~/.claude/.credentials.json while the UI claimed those were protected. Enforcement and display
 * disagreeing on what is protected is worse than either being wrong alone, because it hides the
 * gap. Keeping a single source is the fix, and it is pure and injectable so the gate test can
 * assert every entry actually denies.
 */

import path from 'node:path';

/**
 * @param homedir  the host home directory, i.e. `os.homedir()`.
 * @param userData Stafford's own user-data directory, i.e. `app.getPath('userData')`.
 * @param storeDir the directory the database actually lives in, i.e. `path.dirname(store.path)`.
 *                 On Windows this is under the local app-data directory, a different root from
 *                 userData, so it must be listed in its own right. Without it the database and the
 *                 permission-rules table inside it are readable by a colleague. Must be a non-empty
 *                 absolute path: an empty entry would match nothing and silently reopen that hole.
 */
export function protectedConfigPaths(homedir: string, userData: string, storeDir: string): string[] {
    if (!storeDir || !path.isAbsolute(storeDir)) {
        throw new Error('protectedConfigPaths: storeDir must be a non-empty absolute path, got ' + JSON.stringify(storeDir));
    }
    return [
        // Stafford's own database directory: the database file, its WAL and shm sidecars (which can hold
        // rows not yet checkpointed into the main file), and the permission-rules table inside the
        // database. This is the invariant that a colleague never reaches its own store or its own policy.
        // Listed by directory, not by filename, so the sidecars are covered too.
        storeDir,

        // Stafford's own user-data directory: the managed credential (claude-config) and the small
        // window-state files live here. On Windows this is the roaming app-data directory, a different
        // root from the database above, so both are needed. Keeping it protects the managed credential
        // regardless of where the database lives.
        userData,

        // Benzoo's real credential directories. Read defaults to allow, so without these a
        // colleague could read the actual Claude credential at ~/.claude/.credentials.json, the
        // very token the managed config goes to such lengths to isolate. The rest are here for the
        // same reason: each is a directory whose entire contents are credentials, so denying it
        // costs a colleague nothing it needed for the work.
        path.join(homedir, '.claude'),
        path.join(homedir, '.ssh'),
        path.join(homedir, '.aws'),
        path.join(homedir, '.gnupg'),
        path.join(homedir, '.docker'),
        path.join(homedir, '.kube'),
        path.join(homedir, '.config', 'gh'),

        // Git credentials in the clear. .git-credentials is the store helper's plaintext file,
        // and .gitconfig can carry tokens in a credential helper or an insteadOf URL. Denying
        // these blocks only a colleague's explicit Read or Write of the files; git run through
        // Bash reads its own config itself and is unaffected.
        path.join(homedir, '.gitconfig'),
        path.join(homedir, '.git-credentials'),

        // Cloud provider credential stores. Azure keeps tokens under .azure on every platform.
        // gcloud's real location differs: ~/.config/gcloud on Linux and macOS, %APPDATA%\gcloud
        // (i.e. ~/AppData/Roaming/gcloud) on Windows, plus a legacy bare ~/.gcloud. All are listed
        // so the deny holds on whichever machine this runs on; the ones that do not exist on a
        // given platform simply never match.
        path.join(homedir, '.azure'),
        path.join(homedir, '.config', 'gcloud'),
        path.join(homedir, 'AppData', 'Roaming', 'gcloud'),
        path.join(homedir, '.gcloud')
    ];
}
