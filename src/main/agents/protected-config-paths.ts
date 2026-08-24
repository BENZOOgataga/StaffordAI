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
 */
export function protectedConfigPaths(homedir: string, userData: string): string[] {
    return [
        // Stafford's own store: the permission rules, the database, and the managed credential.
        // This is the invariant that a colleague never reaches its own policy.
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
